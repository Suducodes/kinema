/**
 * Auto-hold detection: a hold is captured once the right-knee flexion has stayed within +/- band of
 * its mean for the hold duration, with the right leg seen well throughout. Frames where the leg is
 * not visible restart the clock, so bad data is never captured silently.
 */
export interface HoldSample { t: number; knee: number; conf: number; ok: boolean }
export interface HoldStatus { stableS: number; progress: number; ready: boolean; mean: number; sd: number; n: number; conf: number; t0: number; t1: number; reason: string }

export class HoldDetector {
  private buf: HoldSample[] = [];
  constructor(public band = 2, public duration = 3) {}
  reset() { this.buf = []; }

  push(s: HoldSample): HoldStatus {
    if (!s.ok) { this.buf = []; return this.status('right leg not visible'); }
    this.buf.push(s);
    while (this.buf.length && s.t - this.buf[0].t > this.duration + 1.5) this.buf.shift();
    // longest recent stretch that stays inside the band around its own mean
    let i = this.buf.length - 1, lo = s.knee, hi = s.knee;
    while (i > 0) {
      const v = this.buf[i - 1].knee, nlo = Math.min(lo, v), nhi = Math.max(hi, v);
      if (nhi - nlo > 2 * this.band) break;
      lo = nlo; hi = nhi; i--;
    }
    this.buf = this.buf.slice(i);
    return this.status('');
  }

  /** Statistics over the last `duration` seconds of the stable stretch. */
  private status(reason: string): HoldStatus {
    const b = this.buf, last = b[b.length - 1];
    if (!last) return { stableS: 0, progress: 0, ready: false, mean: NaN, sd: NaN, n: 0, conf: 0, t0: 0, t1: 0, reason };
    const stableS = last.t - b[0].t;
    const win = b.filter((x) => last.t - x.t <= this.duration + 1e-6);
    const m = win.reduce((a, x) => a + x.knee, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, x) => a + (x.knee - m) ** 2, 0) / Math.max(win.length - 1, 1));
    const conf = win.reduce((a, x) => a + x.conf, 0) / win.length;
    const inside = win.every((x) => Math.abs(x.knee - m) <= this.band);
    const ready = stableS >= this.duration - 1e-6 && inside && win.length >= 10;
    return { stableS, progress: Math.min(stableS / this.duration, 1), ready, mean: m, sd, n: win.length, conf, t0: win[0].t, t1: last.t, reason };
  }
}
