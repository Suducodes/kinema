import * as THREE from 'three';
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { landmarkFilter } from './filters';
import type { Frame, Side } from './body';

/**
 * Camera -> landmarks with MediaPipe Pose Landmarker (runs on this device; no video leaves it).
 * World landmarks come out in metres around the hips with x right, y down, z away from the camera;
 * a 180 degree turn about x gives our frame (x right, y up, z toward the camera), a proper rotation,
 * so left stays left. Each coordinate gets a One Euro filter, smoothed harder the less the model can
 * see the point. Legs out of view settle into a relaxed standing pose instead of following the
 * model's guesses, so a camera that only sees the upper body gives a calm twin.
 */
export interface Tracked {
  frame: Frame; image: { x: number; y: number; v: number }[]; quality: number;
  /** How well the feet are seen (0-1): below ~0.5 the person should step back. */
  feet: number;
  /** Tracked hands in the image (for the overlay). */
  handImage: Partial<Record<Side, { x: number; y: number }[]>>;
}
/** Google's published hand model, fetched once by the browser (only the model comes from the network). */
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
export type Facing = 'user' | 'environment';

const UP = new THREE.Vector3(0, 1, 0);
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };

export class Tracker {
  private landmarker: PoseLandmarker | null = null;
  private files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private hand: HandLandmarker | null = null;
  private handLoading: Promise<void> | null = null;
  private handF: Record<Side, ReturnType<typeof landmarkFilter>[]> = {
    R: Array.from({ length: 63 }, () => landmarkFilter(20, 0)), L: Array.from({ length: 63 }, () => landmarkFilter(20, 0)) };
  private handSeen: Record<Side, { pts: THREE.Vector3[]; img: { x: number; y: number }[]; t: number } | null> = { R: null, L: null };
  /** Track the hands too (fingers, forearm rotation, wrist): a second model, so it costs some frame rate. */
  handsOn = false;
  private stream: MediaStream | null = null;
  private filters = Array.from({ length: 99 }, (_, k) => landmarkFilter(Math.floor(k / 3), k % 3));
  private last = Array.from({ length: 33 }, () => new THREE.Vector3());
  private readonly raw = Array.from({ length: 33 }, () => new THREE.Vector3());
  private lastVideoTime = -1;
  /** Image calibration for jumps: hip height in the image while standing, and image body height. */
  private hipY0: number | null = null;
  private bodyImg = 0;
  userHeight = 1.72;
  facing: Facing = 'user';

  async init(base: string, onStatus: (s: string) => void) {
    if (this.landmarker) return;
    onStatus('Loading the pose model');
    const files = this.files = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
    const make = (delegate: 'GPU' | 'CPU') => PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}models/pose_landmarker_full.task`, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await make('GPU'); } catch { this.landmarker = await make('CPU'); }
  }

  /** Load the hand model on first use (resolves when ready; failure turns hand tracking off). */
  loadHands(): Promise<void> {
    if (this.hand || !this.files) return Promise.resolve();
    this.handLoading ??= (async () => {
      const make = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(this.files!, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { this.hand = await make('GPU'); } catch { this.hand = await make('CPU'); }
    })().catch((e) => { this.handsOn = false; this.handLoading = null; throw e; });
    return this.handLoading;
  }

  /** Open a camera. 640x480 is plenty (the model resizes its input) and keeps webcams at 30 fps. */
  async start(video: HTMLVideoElement, facing: Facing = this.facing) {
    this.stop();
    this.facing = facing;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false,
    });
    video.srcObject = this.stream;
    video.muted = true; video.playsInline = true;
    await video.play();
    this.reset();
  }

  stop() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }

  get running() { return !!this.stream; }

  /** Number of cameras (known after permission is granted). */
  async cameraCount() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length; } catch { return 1; }
  }

  reset() { this.filters.forEach((f) => f.reset()); this.last.forEach((p) => p.set(0, 0, 0)); this.lastVideoTime = -1; this.hipY0 = null; }

  /** Remember the standing posture in the image (for measuring jump height). */
  calibrateImage(image: { x: number; y: number }[]) {
    const hip = (image[23].y + image[24].y) / 2;
    const heel = (image[29].y + image[30].y) / 2;
    this.hipY0 = hip;
    this.bodyImg = Math.max(heel - image[0].y, 0.05);
  }

  /** Track the newest video frame (null when the frame was already seen or nobody is in view). */
  detect(video: HTMLVideoElement, tMs: number): Tracked | null | undefined {
    if (!this.landmarker || video.readyState < 2 || video.currentTime === this.lastVideoTime) return undefined;
    this.lastVideoTime = video.currentTime;
    const res = this.landmarker.detectForVideo(video, tMs);
    const wl = res.worldLandmarks?.[0], il = res.landmarks?.[0];
    if (!wl || !il) return null;
    const t = tMs / 1000, raw = this.raw;
    const vis = il.map((p) => Math.min(p.visibility ?? 1, 1));
    for (let i = 0; i < 33; i++) raw[i].set(wl[i].x, -wl[i].y, -wl[i].z);

    // legs the model cannot see blend toward relaxed standing, built down from what is seen above them
    const hipL = raw[23], hipR = raw[24], lat = hipR.clone().sub(hipL).setY(0).normalize();
    const fwd = new THREE.Vector3().crossVectors(UP, lat), H = this.userHeight;
    const settle = (i: number, from: THREE.Vector3, offset: THREE.Vector3) => raw[i].lerp(from.clone().add(offset), 1 - smooth(0.3, 0.65, vis[i]));
    const down = (d: number) => new THREE.Vector3(0, -d, 0);
    for (const [hip, knee, ank, heel, toe] of [[23, 25, 27, 29, 31], [24, 26, 28, 30, 32]]) {
      settle(knee, raw[hip], down(0.245 * H));
      settle(ank, raw[knee], down(0.246 * H));
      settle(heel, raw[ank], fwd.clone().multiplyScalar(-0.05).add(down(0.045)));
      settle(toe, raw[ank], fwd.clone().multiplyScalar(0.15).add(down(0.06)));
    }

    const world: THREE.Vector3[] = [];
    for (let i = 0; i < 33; i++) {
      const v = vis[i], leg = i >= 25;
      if (!leg && v < 0.25 && this.last[i].lengthSq() > 0) { world.push(this.last[i].clone()); continue; }
      const cut = 0.35 + 0.65 * v;   // a poorly seen point is smoothed harder
      const p = new THREE.Vector3(
        this.filters[i * 3].filter(raw[i].x, t, cut),
        this.filters[i * 3 + 1].filter(raw[i].y, t, cut),
        this.filters[i * 3 + 2].filter(raw[i].z, t, cut));
      this.last[i].copy(p);
      world.push(p);
    }
    const image = il.map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 }));
    const hands = this.trackHands(video, tMs, t, image);
    let lift: number | null = null;
    if (this.hipY0 !== null) {
      const hip = (il[23].y + il[24].y) / 2;
      lift = ((this.hipY0 - hip) / this.bodyImg) * this.userHeight * 0.93;
    }
    const key = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
    const quality = key.reduce((a, i) => a + vis[i], 0) / key.length;
    const feet = [27, 28, 29, 30].reduce((a, i) => a + vis[i], 0) / 4;
    const handImage: Tracked['handImage'] = {};
    for (const s of ['R', 'L'] as Side[]) if (hands[s]) handImage[s] = this.handSeen[s]!.img;
    return { frame: { world, visibility: vis, lift, t, hands }, image, quality, feet, handImage };
  }

  /** Hands: each detected hand goes to the body side whose pose wrist is nearest in the image. */
  private trackHands(video: HTMLVideoElement, tMs: number, t: number, pose: { x: number; y: number; v: number }[]) {
    const out: Partial<Record<Side, THREE.Vector3[]>> = {};
    if (!this.handsOn || !this.hand) return out;
    const res = this.hand.detectForVideo(video, tMs);
    const taken = new Set<Side>();
    res.landmarks.forEach((img, k) => {
      const d = (i: number) => Math.hypot(img[0].x - pose[i].x, img[0].y - pose[i].y);
      let side: Side = d(16) < d(15) ? 'R' : 'L';
      if (taken.has(side)) side = side === 'R' ? 'L' : 'R';
      if (Math.min(d(15), d(16)) > 0.2 || taken.has(side)) return;
      taken.add(side);
      const wl = res.worldLandmarks[k], f = this.handF[side];
      const prev = this.handSeen[side];
      if (!prev || t - prev.t > 0.5) f.forEach((x) => x.reset());
      const pts = wl.map((p, i) => new THREE.Vector3(f[i * 3].filter(p.x, t), f[i * 3 + 1].filter(-p.y, t), f[i * 3 + 2].filter(-p.z, t)));
      this.handSeen[side] = { pts, img: img.map((p) => ({ x: p.x, y: p.y })), t };
    });
    // a hand missed for a moment keeps its last shape; after 0.4 s the fingers return to rest
    for (const s of ['R', 'L'] as Side[]) { const h = this.handSeen[s]; if (h && t - h.t < 0.4) out[s] = h.pts; }
    return out;
  }
}
