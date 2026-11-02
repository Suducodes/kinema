import * as THREE from 'three';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { landmarkFilter } from './filters';
import type { Frame } from './body';

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
}
export type Facing = 'user' | 'environment';

const UP = new THREE.Vector3(0, 1, 0);
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };

export class Tracker {
  private landmarker: PoseLandmarker | null = null;
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
    const files = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
    const make = (delegate: 'GPU' | 'CPU') => PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}models/pose_landmarker_full.task`, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await make('GPU'); } catch { this.landmarker = await make('CPU'); }
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
    let lift: number | null = null;
    if (this.hipY0 !== null) {
      const hip = (il[23].y + il[24].y) / 2;
      lift = ((this.hipY0 - hip) / this.bodyImg) * this.userHeight * 0.93;
    }
    const key = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
    const quality = key.reduce((a, i) => a + vis[i], 0) / key.length;
    const feet = [27, 28, 29, 30].reduce((a, i) => a + vis[i], 0) / 4;
    return { frame: { world, visibility: vis, lift, t }, image, quality, feet };
  }
}
