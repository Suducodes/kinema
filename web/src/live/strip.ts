/** A quiet rolling chart: the last `span` seconds of a few series, newest at the right. */
export interface StripSeries { label: string; color: string; dash?: number[] }

export class Strip {
  readonly el: HTMLDivElement;
  private readonly cv: HTMLCanvasElement;
  private t: number[] = [];
  private v: number[][];
  private readonly pad = { l: 34, r: 8, t: 6, b: 6 };

  constructor(title: string, unit: string, private readonly series: StripSeries[], private range: [number, number], private readonly span = 10) {
    this.el = document.createElement('div');
    this.el.className = 'chart strip';
    this.el.innerHTML = `<header><span>${title}</span><em>${unit}</em></header>`;
    this.cv = document.createElement('canvas');
    this.el.appendChild(this.cv);
    const legend = document.createElement('footer');
    legend.innerHTML = series.map((s) => `<i style="--c:${s.color}" class="${s.dash ? 'dash' : ''}"></i>${s.label}`).join('');
    this.el.appendChild(legend);
    this.v = series.map(() => []);
  }

  push(t: number, values: number[]) {
    this.t.push(t);
    values.forEach((x, i) => this.v[i].push(x));
    while (this.t.length && t - this.t[0] > this.span) { this.t.shift(); this.v.forEach((a) => a.shift()); }
  }

  clear() { this.t = []; this.v = this.series.map(() => []); }

  draw() {
    const dpr = Math.min(devicePixelRatio, 2), w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (!w || !h) return;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    const g = this.cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const { l, r, t, b } = this.pad;
    let [lo, hi] = this.range;
    for (const a of this.v) for (const x of a) { if (x > hi) hi = x; if (x < lo) lo = x; }
    const now = this.t[this.t.length - 1] ?? 0;
    const X = (tt: number) => l + (1 - (now - tt) / this.span) * (w - l - r), Y = (x: number) => t + (1 - (x - lo) / (hi - lo || 1)) * (h - t - b);
    g.font = '10px "JetBrains Mono", monospace'; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.strokeStyle = 'rgba(214,222,226,.08)'; g.fillStyle = 'rgba(214,222,226,.42)'; g.lineWidth = 1;
    const step = nice(hi - lo);
    for (let x = Math.ceil(lo / step) * step; x <= hi; x += step) { g.beginPath(); g.moveTo(l, Y(x)); g.lineTo(w - r, Y(x)); g.stroke(); g.fillText(fmt(x), l - 5, Y(x)); }
    this.series.forEach((s, i) => {
      const a = this.v[i];
      if (a.length < 2) return;
      g.beginPath();
      a.forEach((x, k) => (k ? g.lineTo : g.moveTo).call(g, X(this.t[k]), Y(x)));
      g.strokeStyle = s.color; g.lineWidth = 1.6; g.setLineDash(s.dash ?? []); g.stroke(); g.setLineDash([]);
    });
  }
}

function nice(range: number) { const s = 10 ** Math.floor(Math.log10(range / 3)); return [1, 2, 5, 10].map((k) => k * s).find((k) => range / k <= 4) ?? range; }
const fmt = (x: number) => (Math.abs(x) >= 10 || Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1));
