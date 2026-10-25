import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type FrameHook = (dt: number, t: number) => void;

/**
 * Full-screen stage, adapted from MRISafe Twin v2. three.js and OpenSim share axes here:
 * metres, y up, x = walking direction, z = the walkers' right side. Renders straight to the
 * canvas with 4x MSAA and filmic tone mapping in each material; resolution adapts so
 * integrated GPUs hold their frame rate.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.02, 120);
  readonly controls: OrbitControls;
  private readonly hooks = new Set<FrameHook>();
  private readonly maxRatio = Math.min(devicePixelRatio, 2);
  private ratio = Math.min(devicePixelRatio, 2);
  private frameMs = 16;
  private sinceAdjust = 0;
  private holdUntil = 0;
  private readonly clock = new THREE.Clock();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 2 ** 0.4;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0x0d1113);

    this.camera.position.set(0, 1.15, 6.4);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.85, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 14;
    this.controls.maxPolarAngle = Math.PI * 0.53;   // never below the floor

    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => {
      const raw = this.clock.getDelta();
      const dt = Math.min(raw, 0.1);
      for (const h of this.hooks) h(dt, this.clock.elapsedTime);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.adaptResolution(raw);
    });
  }

  onFrame(hook: FrameHook) { this.hooks.add(hook); return () => this.hooks.delete(hook); }

  /** Test harness: step every hook at 60 Hz for `seconds`, then render once (hidden panes). */
  advance(seconds: number) {
    for (let t = 0; t < seconds; t += 1 / 60) {
      for (const h of this.hooks) h(1 / 60, this.clock.elapsedTime + t);
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
  }

  settle(ms = 3000) { this.holdUntil = performance.now() + ms; this.frameMs = 16; this.sinceAdjust = 0; }
  get quality() { return { ratio: this.ratio, frameMs: this.frameMs }; }

  /** Trade resolution for frame rate without hunting (never below 0.75x the display). */
  private adaptResolution(dt: number) {
    if (document.hidden || dt <= 0 || dt > 0.2 || performance.now() < this.holdUntil) return;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.06;
    this.sinceAdjust += dt;
    const floor = Math.max(0.75, this.maxRatio * 0.6);
    let next = this.ratio;
    if (this.frameMs > 24 && this.sinceAdjust > 1.5) next = Math.max(floor, this.ratio - 0.125);
    else if (this.frameMs < 17.5 && this.sinceAdjust > 5 && this.ratio < this.maxRatio) next = Math.min(this.maxRatio, this.ratio + 0.125);
    if (next === this.ratio) return;
    this.ratio = next;
    this.renderer.setPixelRatio(next);
    this.sinceAdjust = 0;
  }

  private resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep horizontal coverage on narrow screens (phones see both walkers)
    this.camera.fov = w / h >= 16 / 9 ? 30 : Math.min(70, 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(15)) * (16 / 9) / (w / h))));
    this.camera.updateProjectionMatrix();
  }
}
