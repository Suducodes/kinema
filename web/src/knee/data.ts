/** Knee simulation runs (see knee/export_knee_web.py for the binary layout). */
export interface TestInfo { label: string; checks: string; load: 'force' | 'torque' | 'none'; dir: number; what: string }
export interface KneeMeta {
  K: number; fps: number; bundles: string[]; torn: string[]; groups: string[]; read: string[];
  tests: Record<string, TestInfo>;
  meshes: Record<string, 'femur' | 'tibia' | 'patella'>;
  runs: Record<string, { frames: number; stride: number }>;
  stretched: { bundles: string[]; slack_pct: number; stiffness_factor: number };
}

export class KneeClip {
  readonly B: number; readonly K: number; readonly frames: number; readonly stride: number;
  readonly oTib = 0; readonly oPat = 7; readonly oPath = 14;
  readonly oStrain: number; readonly oForce: number; readonly oRead: number; readonly oLoad: number;

  constructor(readonly meta: KneeMeta, readonly name: string, readonly data: Float32Array) {
    this.B = meta.bundles.length; this.K = meta.K;
    this.stride = meta.runs[name].stride; this.frames = meta.runs[name].frames;
    this.oStrain = this.oPath + this.B * this.K * 3;
    this.oForce = this.oStrain + this.B;
    this.oRead = this.oForce + this.B;
    this.oLoad = this.oRead + 6;
    if (this.oLoad + 1 !== this.stride) throw new Error(`knee layout mismatch: ${this.oLoad + 1} vs ${this.stride}`);
  }

  get duration() { return (this.frames - 1) / this.meta.fps; }

  /** Frame index pair + weight at time t (s, clamped to the run). */
  at(t: number) {
    const x = Math.min(Math.max(t * this.meta.fps, 0), this.frames - 1);
    const f0 = Math.min(Math.floor(x), this.frames - 2);
    return { f0, f1: f0 + 1, w: x - f0 };
  }

  sample(t: number, k: number) {
    const { f0, f1, w } = this.at(t), s = this.stride;
    return this.data[f0 * s + k] * (1 - w) + this.data[f1 * s + k] * w;
  }
}

export async function loadKneeClip(meta: KneeMeta, name: string) {
  const buf = await fetch(`${import.meta.env.BASE_URL}knee/${name}.bin`).then((r) => r.arrayBuffer());
  return new KneeClip(meta, name, new Float32Array(buf));
}
