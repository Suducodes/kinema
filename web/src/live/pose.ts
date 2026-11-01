import * as THREE from 'three';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { LANDMARK_FILTER, OneEuro } from './filters';
import type { Frame } from './body';

/**
 * Camera -> landmarks with MediaPipe Pose Landmarker (runs on this device; no video leaves it).
 * World landmarks come out in metres around the hips with x right, y down, z away from the camera;
 * a 180 degree turn about x gives our frame (x right, y up, z toward the camera), a proper rotation,
 * so left stays left. Each coordinate gets a One Euro filter; points the model cannot see are held.
 */
export interface Tracked { frame: Frame; image: { x: number; y: number; v: number }[]; quality: number }

export class Tracker {
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private filters = Array.from({ length: 99 }, () => new OneEuro(LANDMARK_FILTER.minCutoff, LANDMARK_FILTER.beta));
  private last = Array.from({ length: 33 }, () => new THREE.Vector3());
  private lastVideoTime = -1;
  /** Image calibration for jumps: hip height in the image while standing, and image body height. */
  private hipY0: number | null = null;
  private bodyImg = 0;
  userHeight = 1.72;

  async init(base: string, onStatus: (s: string) => void) {
    onStatus('Loading the pose model');
    const files = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
    const make = (delegate: 'GPU' | 'CPU') => PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${base}models/pose_landmarker_full.task`, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await make('GPU'); } catch { this.landmarker = await make('CPU'); }
  }

  async start(video: HTMLVideoElement) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false,
    });
    video.srcObject = this.stream;
    video.muted = true; video.playsInline = true;
    await video.play();
  }

  stop() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }

  get running() { return !!this.stream; }

  /** Remember the standing posture in the image (for measuring jump height). */
  calibrateImage(image: { x: number; y: number }[]) {
    const hip = (image[23].y + image[24].y) / 2;
    const heel = (image[29].y + image[30].y) / 2;
    this.hipY0 = hip;
    this.bodyImg = Math.max(heel - image[0].y, 0.05);
  }

  /** Track the newest video frame (null when the frame was already seen or nobody is in view). */
  detect(video: HTMLVideoElement, tMs: number): Tracked | null {
    if (!this.landmarker || video.readyState < 2 || video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    const res = this.landmarker.detectForVideo(video, tMs);
    const wl = res.worldLandmarks?.[0], il = res.landmarks?.[0];
    if (!wl || !il) return null;
    const t = tMs / 1000;
    const world: THREE.Vector3[] = [], vis: number[] = [];
    for (let i = 0; i < 33; i++) {
      const v = il[i].visibility ?? 1;
      vis.push(v);
      if (v < 0.25 && this.last[i].lengthSq() > 0) { world.push(this.last[i].clone()); continue; }
      const p = new THREE.Vector3(
        this.filters[i * 3].filter(wl[i].x, t),
        this.filters[i * 3 + 1].filter(-wl[i].y, t),
        this.filters[i * 3 + 2].filter(-wl[i].z, t));
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
    const quality = key.reduce((a, i) => a + Math.min(vis[i], 1), 0) / key.length;
    return { frame: { world, visibility: vis, lift, t }, image, quality };
  }
}
