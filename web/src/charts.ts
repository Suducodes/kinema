import type { Clip } from './data';

/** One gait cycle (0-100 % from right heel strike) of a signal, averaged over the clip's strides. */
export function cycleCurve(clip: Clip, pick: (frame: number) => number) {
  const hs = clip.h.events.heel_strike_r;
  const out = new Float32Array(101);
  let n = 0;
  for (let s = 0; s < hs.length; s++) {
    const a = hs[s], b = s + 1 < hs.length ? hs[s + 1] : hs[0] + clip.h.frames;
    for (let p = 0; p <= 100; p++) {
      const x = a + (b - a) * (p / 100);
      const f0 = Math.floor(x), w = x - f0;
      out[p] += pick(f0 % clip.h.frames) * (1 - w) + pick((f0 + 1) % clip.h.frames) * w;
    }
    n++;
  }
  return out.map((v) => v / n);
}

/** Gait phase (0-100) of continuous time t, from the clip's right heel strikes. */
export function phaseAt(clip: Clip, t: number) {
  const hs = clip.h.events.heel_strike_r, n = clip.h.frames;
  const x = (((t * clip.h.fps) % n) + n) % n;
  let a = hs[hs.length - 1] - n, b = hs[0];
  for (let i = 0; i < hs.length; i++) {
    if (hs[i] <= x) { a = hs[i]; b = i + 1 < hs.length ? hs[i + 1] : hs[0] + n; }
  }
  return ((x - a) / (b - a)) * 100;
}

/** Time (s) in the clip at gait phase p of the stride containing time t. */
export function timeAtPhase(clip: Clip, t: number, p: number) {
  const hs = clip.h.events.heel_strike_r, n = clip.h.frames;
  const x = (((t * clip.h.fps) % n) + n) % n;
  let a = hs[hs.length - 1] - n, b = hs[0];
  for (let i = 0; i < hs.length; i++) if (hs[i] <= x) { a = hs[i]; b = i + 1 < hs.length ? hs[i + 1] : hs[0] + n; }
  return ((a + (b - a) * (p / 100) + n) % n) / clip.h.fps;
}

export interface Series { label: string; color: string; data: Float32Array; dash?: number[] }
export interface Band { mean: number[]; sd: number[]; label: string }

/** A quiet instrument chart: cycle on x, units on y, live cursors, click/drag to seek phase. */
export class Chart {
  readonly el: HTMLDivElement;
  private readonly cv: HTMLCanvasElement;
  private cursors: { p: number; color: string }[] = [];
  onSeek?: (phase: number) => void;

  constructor(readonly title: string, readonly unit: string, private series: Series[], private band?: Band,
              private range?: [number, number]) {
    this.el = document.createElement('div');
    this.el.className = 'chart';
    this.el.innerHTML = `<header><span>${title}</span><em>${unit}</em></header>`;
    this.cv = document.createElement('canvas');
    this.el.appendChild(this.cv);
    const legend = document.createElement('footer');
    legend.innerHTML = series.map((s) => `<i style="--c:${s.color}" class="${s.dash ? 'dash' : ''}"></i>${s.label}`).join('')
      + (band ? `<i class="band"></i>${band.label}` : '');
    this.el.appendChild(legend);
    const seek = (e: PointerEvent) => {
      const r = this.cv.getBoundingClientRect();
      const p = ((e.clientX - r.left - this.pad.l) / (r.width - this.pad.l - this.pad.r)) * 100;
      if (p >= 0 && p <= 100) this.onSeek?.(p);
    };
    this.cv.addEventListener('pointerdown', (e) => { this.cv.setPointerCapture(e.pointerId); seek(e); });
    this.cv.addEventListener('pointermove', (e) => { if (e.buttons) seek(e); });
    new ResizeObserver(() => this.draw()).observe(this.cv);
  }

  private readonly pad = { l: 34, r: 8, t: 6, b: 16 };

  setCursors(c: { p: number; color: string }[]) { this.cursors = c; this.draw(); }

  private yRange(): [number, number] {
    if (this.range) return this.range;
    let lo = Infinity, hi = -Infinity;
    for (const s of this.series) for (const v of s.data) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (this.band) this.band.mean.forEach((m, i) => { lo = Math.min(lo, m - this.band!.sd[i]); hi = Math.max(hi, m + this.band!.sd[i]); });
    const pad = (hi - lo) * 0.08 || 1;
    return [lo - pad, hi + pad];
  }

  draw() {
    const dpr = Math.min(devicePixelRatio, 2), w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (!w || !h) return;
    if (this.cv.width !== Math.round(w * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    const g = this.cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { l, r, t, b } = this.pad, [y0, y1] = this.yRange();
    const X = (p: number) => l + (p / 100) * (w - l - r), Y = (v: number) => t + (1 - (v - y0) / (y1 - y0)) * (h - t - b);
    g.font = '10px "JetBrains Mono", monospace';
    g.fillStyle = 'rgba(214,222,226,.42)'; g.strokeStyle = 'rgba(214,222,226,.08)'; g.lineWidth = 1;
    // grid + axis labels
    const ticks = niceTicks(y0, y1, 3);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of ticks) { g.beginPath(); g.moveTo(l, Y(v)); g.lineTo(w - r, Y(v)); g.stroke(); g.fillText(fmt(v), l - 5, Y(v)); }
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    for (const p of [0, 50, 100]) g.fillText(`${p}%`, X(p), h - 3);
    // reference band (real humans)
    if (this.band) {
      g.beginPath();
      this.band.mean.forEach((m, i) => (i ? g.lineTo : g.moveTo).call(g, X(i), Y(m + this.band!.sd[i])));
      for (let i = 100; i >= 0; i--) g.lineTo(X(i), Y(this.band.mean[i] - this.band.sd[i]));
      g.fillStyle = 'rgba(160,190,205,.13)'; g.fill();
      g.beginPath(); this.band.mean.forEach((m, i) => (i ? g.lineTo : g.moveTo).call(g, X(i), Y(m)));
      g.strokeStyle = 'rgba(160,190,205,.35)'; g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]);
    }
    for (const s of this.series) {
      g.beginPath(); s.data.forEach((v, i) => (i ? g.lineTo : g.moveTo).call(g, X(i), Y(v)));
      g.strokeStyle = s.color; g.lineWidth = 1.6; g.setLineDash(s.dash ?? []); g.stroke(); g.setLineDash([]);
    }
    for (const c of this.cursors) {
      g.beginPath(); g.moveTo(X(c.p), t); g.lineTo(X(c.p), h - b);
      g.strokeStyle = c.color; g.globalAlpha = 0.7; g.lineWidth = 1; g.stroke(); g.globalAlpha = 1;
    }
  }
}

function niceTicks(a: number, b: number, n: number) {
  const step = 10 ** Math.floor(Math.log10((b - a) / n)), s = [1, 2, 5, 10].map((k) => k * step).find((k) => (b - a) / k <= n + 1)!;
  const out: number[] = [];
  for (let v = Math.ceil(a / s) * s; v <= b; v += s) out.push(Math.abs(v) < s / 1e6 ? 0 : v);
  return out;
}
const fmt = (v: number) => (Math.abs(v) >= 10 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1));
