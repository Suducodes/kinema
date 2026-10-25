/** One exported simulation run (see sim/export_web.py for the binary layout). */
export interface Header {
  name: string; run: string; fps: number; frames: number; stride: number;
  meshes: { name: string; file: string; scale: number[] }[];
  muscles: { name: string; fmax: number }[];
  nPath: number; mass: number; speed: number;
  events: { heel_strike_r: number[]; toe_off_r: number[] };
  loop: { seconds: number; strides: number; timeScale: number; strideS: number };
  meta: Record<string, unknown>;
}

export class Clip {
  readonly M: number; readonly K: number; readonly P: number;
  // offsets within one frame
  readonly oMesh = 0; readonly oPath: number; readonly oAct: number; readonly oForce: number;
  readonly oGrf: number; readonly oRead: number;

  constructor(readonly h: Header, readonly data: Float32Array) {
    this.M = h.meshes.length; this.K = h.muscles.length; this.P = h.nPath;
    this.oPath = this.M * 7;
    this.oAct = this.oPath + this.K * this.P * 3;
    this.oForce = this.oAct + this.K;
    this.oGrf = this.oForce + this.K;
    this.oRead = this.oGrf + 6;
    if (this.oRead + 3 !== h.stride) throw new Error(`layout mismatch: ${this.oRead + 3} vs ${h.stride}`);
  }

  get duration() { return this.h.frames / this.h.fps; }

  /** Value at continuous time t (s, wraps) for float index `k` within a frame, linearly blended. */
  sample(t: number, k: number) {
    const { f0, f1, w } = this.at(t);
    const s = this.h.stride;
    return this.data[f0 * s + k] * (1 - w) + this.data[f1 * s + k] * w;
  }

  at(t: number) {
    const n = this.h.frames;
    const x = (((t * this.h.fps) % n) + n) % n;
    const f0 = Math.floor(x), f1 = (f0 + 1) % n;
    return { f0, f1, w: x - f0 };
  }

  muscleIndex(name: string) { return this.h.muscles.findIndex((m) => m.name === name); }
}

export async function loadClip(name: string) {
  const base = `${import.meta.env.BASE_URL}data/${name}`;
  const [h, buf] = await Promise.all([
    fetch(`${base}.json`).then((r) => r.json() as Promise<Header>),
    fetch(`${base}.bin`).then((r) => r.arrayBuffer()),
  ]);
  return new Clip(h, new Float32Array(buf));
}
