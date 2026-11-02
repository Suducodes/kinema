/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012): little smoothing when a point moves fast
 * (low lag), heavy smoothing when it is still (low jitter). One instance per landmark coordinate.
 */
export class OneEuro {
  private x = NaN; private dx = 0; private t = NaN;
  constructor(private minCutoff = 1.2, private beta = 0.5, private dCutoff = 1.0) {}
  private static alpha(cutoff: number, dt: number) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  reset() { this.x = NaN; this.t = NaN; this.dx = 0; }
  /** `cut` scales the minimum cutoff for this sample (below 1 = smoother, e.g. for a poorly seen point). */
  filter(value: number, t: number, cut = 1) {
    if (Number.isNaN(this.x)) { this.x = value; this.t = t; return value; }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const dx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff * cut + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Landmark smoothing used for both camera and demo: jitter-free when still, quick when moving. */
export const LANDMARK_FILTER = { minCutoff: 1.4, beta: 3.0 };

/**
 * The filter for one coordinate of one landmark. The face points (0-10) and depth (z, along the camera's
 * line of sight) are the noisiest outputs of single-camera pose, so they are smoothed harder.
 */
export function landmarkFilter(i: number, axis: number) {
  const head = i <= 10;
  return new OneEuro((head ? 0.55 : LANDMARK_FILTER.minCutoff) * (axis === 2 ? 0.7 : 1), head ? 1.0 : LANDMARK_FILTER.beta);
}

/** One Euro filtering of all 33 landmarks of a frame (the demo goes through it like the camera does). */
export class LandmarkSmoother {
  private readonly f = Array.from({ length: 99 }, (_, k) => landmarkFilter(Math.floor(k / 3), k % 3));
  apply<T extends { world: { x: number; y: number; z: number }[]; t: number }>(frame: T): T {
    frame.world.forEach((p, i) => {
      p.x = this.f[i * 3].filter(p.x, frame.t); p.y = this.f[i * 3 + 1].filter(p.y, frame.t); p.z = this.f[i * 3 + 2].filter(p.z, frame.t);
    });
    return frame;
  }
  reset() { this.f.forEach((x) => x.reset()); }
}

/**
 * Causal derivative estimator: least-squares quadratic through the last samples within a window,
 * evaluated at the newest one. Gives velocity and acceleration with a little smoothing and lag.
 */
export class QuadFit {
  private ts: number[] = [];
  private vs: Float64Array[] = [];
  constructor(private readonly dim: number, private readonly window = 0.2, private readonly maxN = 12) {}
  reset() { this.ts = []; this.vs = []; }
  push(t: number, v: ArrayLike<number>) {
    this.ts.push(t); this.vs.push(Float64Array.from(v));
    while (this.ts.length > this.maxN || (this.ts.length > 3 && t - this.ts[0] > this.window)) { this.ts.shift(); this.vs.shift(); }
  }
  /** [velocity, acceleration] per dimension at the newest sample (zeros until 3 samples). */
  derivatives(vel: Float64Array, acc: Float64Array) {
    vel.fill(0); acc.fill(0);
    const n = this.ts.length;
    if (n < 3) return;
    const t0 = this.ts[n - 1];
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (const t of this.ts) { const u = t - t0; s0 += 1; s1 += u; s2 += u * u; s3 += u * u * u; s4 += u * u * u * u; }
    // normal equations of [1 u u^2]: inverse of the symmetric 3x3 matrix
    const M = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
    const inv = inv3(M);
    if (!inv) return;
    for (let d = 0; d < this.dim; d++) {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let k = 0; k < n; k++) { const u = this.ts[k] - t0, y = this.vs[k][d]; b0 += y; b1 += u * y; b2 += u * u * y; }
      const c1 = inv[1][0] * b0 + inv[1][1] * b1 + inv[1][2] * b2;
      const c2 = inv[2][0] * b0 + inv[2][1] * b1 + inv[2][2] * b2;
      vel[d] = c1; acc[d] = 2 * c2;
    }
  }
}

function inv3(m: number[][]) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
