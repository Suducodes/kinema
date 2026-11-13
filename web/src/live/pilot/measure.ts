import { flexionFromInterior, interiorDeg, type Pt } from './angle';

/**
 * Reference angle tool: three points on the clean photo (hip, knee, ankle sticker), placed in that
 * order, then dragged or nudged with the arrow keys. Zoom with the wheel, pinch or the buttons; drag
 * the background to pan. Points are stored in the photo's own pixel coordinates.
 */
const NAMES = ['Hip', 'Knee', 'Ankle'];

export class AngleTool {
  readonly el: HTMLDivElement;
  private readonly cv: HTMLCanvasElement;
  private img: ImageBitmap | null = null;
  pts: Pt[] = [];
  sel = -1;
  private k = 1; private tx = 0; private ty = 0;
  private drag: { mode: 'point' | 'pan'; id: number; sx: number; sy: number; ox: number; oy: number } | null = null;
  private touches = new Map<number, [number, number]>();
  private pinch: { d: number; k: number } | null = null;
  private cursor: [number, number] | null = null;
  onChange: () => void = () => {};

  constructor() {
    this.el = document.createElement('div'); this.el.className = 'p-tool';
    this.cv = document.createElement('canvas'); this.cv.tabIndex = 0;
    this.el.appendChild(this.cv);
    new ResizeObserver(() => this.draw()).observe(this.el);
    this.cv.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = this.loc(e); this.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y); }, { passive: false });
    this.cv.addEventListener('pointerdown', (e) => this.down(e));
    this.cv.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) this.cv.addEventListener(ev, (e) => this.up(e as PointerEvent));
    this.cv.addEventListener('keydown', (e) => this.key(e));
  }

  load(img: ImageBitmap | null, pts: Pt[] = []) {
    this.img = img; this.pts = pts.map((p) => [p[0], p[1]] as Pt); this.sel = this.pts.length ? this.pts.length - 1 : -1;
    this.fit(); this.onChange();
  }

  clear() { this.pts = []; this.sel = -1; this.draw(); this.onChange(); }

  /** Interior angle at the knee and knee flexion (straight = 0), once all three points exist. */
  get angles() {
    if (this.pts.length < 3) return null;
    const interior = interiorDeg(this.pts[0], this.pts[1], this.pts[2]);
    return { interior, flexion: flexionFromInterior(interior) };
  }

  fit() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!this.img || !w || !h) { this.draw(); return; }
    this.k = Math.min(w / this.img.width, h / this.img.height);
    this.tx = (w - this.img.width * this.k) / 2; this.ty = (h - this.img.height * this.k) / 2;
    this.draw();
  }

  zoomAt(f: number, sx = this.el.clientWidth / 2, sy = this.el.clientHeight / 2) {
    const nk = Math.min(Math.max(this.k * f, 0.05), 40);
    this.tx = sx - ((sx - this.tx) * nk) / this.k; this.ty = sy - ((sy - this.ty) * nk) / this.k; this.k = nk;
    this.draw();
  }

  /** Pointer position in canvas CSS pixels (from the canvas's own rectangle, not offsetX). */
  private loc(e: MouseEvent): [number, number] { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  private toImg(sx: number, sy: number): Pt { return [(sx - this.tx) / this.k, (sy - this.ty) / this.k]; }
  private toScr(p: Pt): [number, number] { return [p[0] * this.k + this.tx, p[1] * this.k + this.ty]; }

  private hit(sx: number, sy: number) {
    let best = -1, bd = 14;
    this.pts.forEach((p, i) => { const [x, y] = this.toScr(p), d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  private down(e: PointerEvent) {
    this.cv.focus();
    try { this.cv.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
    const [ex, ey] = this.loc(e);
    this.touches.set(e.pointerId, [ex, ey]);
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: this.k }; this.drag = null; return;
    }
    if (!this.img) return;
    const i = this.hit(ex, ey);
    if (i >= 0) { this.sel = i; this.drag = { mode: 'point', id: i, sx: ex, sy: ey, ox: this.pts[i][0], oy: this.pts[i][1] }; }
    else if (this.pts.length < 3 && e.button === 0 && !e.shiftKey) {
      this.pts.push(this.toImg(ex, ey)); this.sel = this.pts.length - 1;
      this.drag = { mode: 'point', id: this.sel, sx: ex, sy: ey, ox: this.pts[this.sel][0], oy: this.pts[this.sel][1] };
      this.onChange();
    } else this.drag = { mode: 'pan', id: -1, sx: ex, sy: ey, ox: this.tx, oy: this.ty };
    this.draw();
  }

  private move(e: PointerEvent) {
    const [ex, ey] = this.loc(e);
    this.cursor = [ex, ey];
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, [ex, ey]);
    if (this.pinch && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      this.zoomAt((this.pinch.k * d) / this.pinch.d / this.k, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); return;
    }
    if (!this.drag) { this.draw(); return; }
    const dx = ex - this.drag.sx, dy = ey - this.drag.sy;
    if (this.drag.mode === 'pan') { this.tx = this.drag.ox + dx; this.ty = this.drag.oy + dy; }
    else { this.pts[this.drag.id] = [this.drag.ox + dx / this.k, this.drag.oy + dy / this.k]; this.onChange(); }
    this.draw();
  }

  private up(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    if (e.type === 'pointerleave') this.cursor = null;
    this.drag = null; this.draw();
  }

  private key(e: KeyboardEvent) {
    if (this.sel < 0 || !this.pts[this.sel]) return;
    const step = e.shiftKey ? 2 : 0.25, d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key]) { e.preventDefault(); this.pts[this.sel][0] += d[e.key][0]; this.pts[this.sel][1] += d[e.key][1]; this.onChange(); this.draw(); }
    if (e.key === 'Tab' && this.pts.length) { e.preventDefault(); this.sel = (this.sel + 1) % this.pts.length; this.draw(); }
  }

  draw() {
    const w = this.el.clientWidth, h = this.el.clientHeight, dpr = Math.min(devicePixelRatio, 2);
    if (!w || !h) return;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    const g = this.cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#06090b'; g.fillRect(0, 0, w, h);
    if (!this.img) { g.fillStyle = '#6d7a81'; g.font = '14px system-ui'; g.fillText('Pick a photo to measure', 20, 30); return; }
    g.imageSmoothingEnabled = this.k < 3;
    g.drawImage(this.img, this.tx, this.ty, this.img.width * this.k, this.img.height * this.k);
    const S = this.pts.map((p) => this.toScr(p));
    g.lineWidth = 2; g.lineCap = 'round';
    if (S.length >= 2) { g.strokeStyle = '#8fe3ff'; g.beginPath(); g.moveTo(...S[0]); g.lineTo(...S[1]); g.stroke(); }
    if (S.length >= 3) {
      g.strokeStyle = '#ffb46b'; g.beginPath(); g.moveTo(...S[1]); g.lineTo(...S[2]); g.stroke();
      const a0 = Math.atan2(S[0][1] - S[1][1], S[0][0] - S[1][0]), a1 = Math.atan2(S[2][1] - S[1][1], S[2][0] - S[1][0]);
      let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      g.strokeStyle = 'rgba(233,228,216,.7)'; g.beginPath(); g.arc(S[1][0], S[1][1], 28, a0, a0 + da, da < 0); g.stroke();
    }
    S.forEach(([x, y], i) => {
      g.fillStyle = i === this.sel ? '#ffffff' : i === 0 ? '#8fe3ff' : i === 1 ? '#e9e4d8' : '#ffb46b';
      g.strokeStyle = '#06090b'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, i === this.sel ? 7 : 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(x - 12, y); g.lineTo(x - 8, y); g.moveTo(x + 8, y); g.lineTo(x + 12, y); g.moveTo(x, y - 12); g.lineTo(x, y - 8); g.moveTo(x, y + 8); g.lineTo(x, y + 12);
      g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1; g.stroke();
      g.font = '600 12px system-ui'; g.fillStyle = 'rgba(6,9,11,.75)'; g.fillRect(x + 10, y - 22, g.measureText(NAMES[i]).width + 10, 18);
      g.fillStyle = '#e9e4d8'; g.fillText(NAMES[i], x + 15, y - 9);
    });
    // loupe: 4x around the cursor while placing or dragging, for sticker-centre precision
    if (this.cursor && (this.drag?.mode === 'point' || this.pts.length < 3)) {
      const [cx, cy] = this.cursor, R = 56, zoom = 4, [ix, iy] = this.toImg(cx, cy), src = R / (this.k * zoom);
      const lx = cx + R + 24 > w ? cx - R - 24 : cx + R + 24, ly = Math.min(Math.max(cy, R + 4), h - R - 4);
      g.save(); g.beginPath(); g.arc(lx, ly, R, 0, Math.PI * 2); g.clip();
      g.imageSmoothingEnabled = false;
      g.drawImage(this.img, ix - src, iy - src, src * 2, src * 2, lx - R, ly - R, R * 2, R * 2);
      g.restore();
      g.strokeStyle = 'rgba(233,228,216,.8)'; g.lineWidth = 1.5; g.beginPath(); g.arc(lx, ly, R, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(lx - 8, ly); g.lineTo(lx + 8, ly); g.moveTo(lx, ly - 8); g.lineTo(lx, ly + 8); g.stroke();
    }
    g.fillStyle = 'rgba(6,9,11,.7)'; g.fillRect(8, h - 26, 230, 20);
    g.fillStyle = '#a2adb3'; g.font = '11px system-ui';
    g.fillText(this.pts.length < 3 ? `Click the ${NAMES[this.pts.length].toLowerCase()} sticker centre` : 'Drag a point, or select it and use arrow keys', 14, h - 12);
  }
}
