/**
 * Muscle map: every right-leg muscle's activation across one gait cycle, as heat strips,
 * healthy on the left and the compared twin on the right. Click/drag to seek gait phase.
 */
const RAMP = [[21, 27, 31], [74, 36, 38], [168, 52, 44], [232, 112, 78], [250, 214, 180]];
const FULL = 0.45;   // activation drawn at the top of the ramp

function heat(v: number) {
  const s = Math.min(Math.max(v / FULL, 0), 1) * (RAMP.length - 1), i = Math.min(Math.floor(s), RAMP.length - 2), w = s - i;
  const c = RAMP[i].map((x, k) => Math.round(x + (RAMP[i + 1][k] - x) * w));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export class HeatMap {
  readonly el: HTMLDivElement;
  private readonly cv: HTMLCanvasElement;
  private h: Float32Array[] = [];
  private w: Float32Array[] = [];
  private cursors: [number, number] = [-1, -1];
  private weakLabel = 'Weak';
  private marked = new Set<number>();
  onSeek?: (phase: number) => void;
  private readonly pad = { l: 92, r: 8, t: 14, b: 12, gap: 14 };

  constructor(private readonly labels: string[]) {
    this.el = document.createElement('div');
    this.el.className = 'chart heat';
    this.el.innerHTML = `<header><span>Muscle map · right leg · activation over one gait cycle</span>
      <em><span class="ramp"></span>0 → ${FULL * 100}%+ of max <span class="sep">·</span> <i class="mark"></i>weakened</em></header>`;
    this.cv = document.createElement('canvas');
    this.el.appendChild(this.cv);
    const seek = (e: PointerEvent) => {
      const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left;
      const bw = (r.width - this.pad.l - this.pad.r - this.pad.gap) / 2;
      const x0 = x < this.pad.l + bw + this.pad.gap / 2 ? this.pad.l : this.pad.l + bw + this.pad.gap;
      const p = ((x - x0) / bw) * 100;
      if (p >= 0 && p <= 100) this.onSeek?.(p);
    };
    this.cv.addEventListener('pointerdown', (e) => { this.cv.setPointerCapture(e.pointerId); seek(e); });
    this.cv.addEventListener('pointermove', (e) => { if (e.buttons) seek(e); });
    new ResizeObserver(() => this.draw()).observe(this.cv);
  }

  setData(h: Float32Array[], w: Float32Array[], weakLabel: string, marked: number[]) {
    this.h = h; this.w = w; this.weakLabel = weakLabel; this.marked = new Set(marked); this.draw();
  }

  setCursors(ph: number, pw: number) { this.cursors = [ph, pw]; this.draw(); }

  draw() {
    const dpr = Math.min(devicePixelRatio, 2), W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (!W || !H || !this.h.length) return;
    if (this.cv.width !== Math.round(W * dpr) || this.cv.height !== Math.round(H * dpr)) {
      this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr);
    }
    const g = this.cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const { l, r, t, b, gap } = this.pad;
    const bw = (W - l - r - gap) / 2, n = this.labels.length, rh = (H - t - b) / n;
    g.font = `${Math.min(10, Math.max(8, rh * 0.95)).toFixed(1)}px "JetBrains Mono", monospace`;
    g.textBaseline = 'middle';
    const css = getComputedStyle(document.documentElement);
    const blocks: [string, Float32Array[], string, number][] = [
      ['Healthy', this.h, css.getPropertyValue('--healthy').trim(), this.cursors[0]],
      [this.weakLabel, this.w, css.getPropertyValue('--weak').trim(), this.cursors[1]],
    ];
    blocks.forEach(([title, data, color, cur], bi) => {
      const x0 = l + bi * (bw + gap);
      g.fillStyle = color; g.textAlign = 'left';
      g.fillText(title.toUpperCase(), x0, 7);
      for (let m = 0; m < n; m++) {
        const y = t + m * rh, row = data[m];
        for (let p = 0; p < 100; p++) {
          g.fillStyle = heat((row[p] + row[p + 1]) / 2);
          g.fillRect(x0 + (p / 100) * bw, y + 0.5, bw / 100 + 0.6, rh - 1);
        }
        if (bi === 1 && this.marked.has(m)) {
          g.strokeStyle = 'rgba(233,228,216,.55)'; g.setLineDash([3, 3]); g.lineWidth = 1;
          g.strokeRect(x0 + 0.5, y + 0.5, bw - 1, rh - 1); g.setLineDash([]);
        }
      }
      g.fillStyle = 'rgba(214,222,226,.42)'; g.textAlign = 'center';
      for (const p of [0, 50, 100]) g.fillText(`${p}%`, x0 + (p / 100) * bw, H - 6);
      if (cur >= 0) {
        g.beginPath(); g.moveTo(x0 + (cur / 100) * bw, t - 2); g.lineTo(x0 + (cur / 100) * bw, H - b + 1);
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.2; g.stroke();
      }
    });
    g.textAlign = 'right';
    for (let m = 0; m < n; m++) {
      g.fillStyle = this.marked.has(m) ? 'rgba(233,228,216,.95)' : 'rgba(214,222,226,.62)';
      g.fillText(this.labels[m], l - 8, t + (m + 0.5) * rh);
    }
  }
}
