import type { TwinMeta } from '../assets';
import type { Body } from '../body';
import type { Physics } from '../physics';
import { HoldDetector, type HoldStatus } from './hold';
import { PhysicsLog } from './physics';
import { POSITIONS, SEQUENCE, type Hold, type Participant, type PilotStore, type Position } from './store';

/**
 * One volunteer's protocol: six holds (A, B, C twice), each auto-captured when the right knee stays
 * still, with a clean photo and an overlay screenshot from the same camera frame and the physics of
 * the hold window. Independent of the page, so the self-test can drive it with the synthetic performer.
 */
export type Img = { x: number; y: number; v: number }[];
export interface FrameSource { grab(): Promise<ImageBitmap | null>; mirrored: boolean }
export interface PilotFrame { t: number; image: Img; body: Body; phys: Physics }
export interface RunStatus extends HoldStatus { idx: number; knee: number; armed: boolean; framing: Framing; hint: string; done: boolean; capturing: boolean }
export interface Framing { hip: boolean; knee: boolean; ankle: boolean; feet: boolean; head: boolean; sideOn: boolean; rightFacing: boolean; ok: boolean }

/** Overlay palette: the self-test checks that clean photos contain none of these colours. */
export const OVERLAY_COLOURS: [number, number, number][] = [[143, 227, 255], [255, 180, 107]];
const R = { hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 };

export function framing(img: Img): Framing {
  const vis = (i: number, th = 0.7) => img[i].v >= th && img[i].x > 0.02 && img[i].x < 0.98 && img[i].y > 0.02 && img[i].y < 0.98;
  const sh = Math.abs(img[11].x - img[12].x), torso = Math.abs((img[11].y + img[12].y) / 2 - (img[23].y + img[24].y) / 2) || 1;
  const visR = (img[24].v + img[26].v + img[28].v) / 3, visL = (img[23].v + img[25].v + img[27].v) / 3;
  const f = { hip: vis(R.hip), knee: vis(R.knee), ankle: vis(R.ankle), feet: vis(R.heel, 0.5) && vis(R.toe, 0.5), head: vis(0, 0.5),
    sideOn: sh / torso < 0.35, rightFacing: visR >= visL - 0.05, ok: false };
  f.ok = f.hip && f.knee && f.ankle && f.feet && f.head;
  return f;
}

/** The leg is usable for a hold frame: hip, knee and ankle all seen with confidence. */
const legOk = (img: Img) => img[R.hip].v >= 0.6 && img[R.knee].v >= 0.6 && img[R.ankle].v >= 0.6;
const legConf = (img: Img) => (img[R.hip].v + img[R.knee].v + img[R.ankle].v) / 3;

export interface RunOptions {
  store: PilotStore; participant: Participant; meta: TwinMeta; hashes: { json: string; glb: string };
  band: number; duration: number; blur: boolean; source: FrameSource;
  /** Draw the 3D twin (for the overlay screenshot), or null. */
  inset: () => CanvasImageSource | null;
}

export class PilotRun {
  readonly detector: HoldDetector;
  readonly log: PhysicsLog;
  holds: (Hold | null)[] = SEQUENCE.map(() => null);
  thumbs: (string | null)[] = SEQUENCE.map(() => null);
  idx = 0;
  private armed = true;
  private ring: { t: number; bmp: ImageBitmap; image: Img }[] = [];
  private lastGrab = -1;
  private grabbing = false;
  private capturing: Promise<Hold> | null = null;
  private lastImage: Img | null = null;
  private lastT = 0;

  constructor(readonly o: RunOptions) {
    this.detector = new HoldDetector(o.band, o.duration);
    this.log = new PhysicsLog(o.meta);
  }

  /** Restore holds already saved for this volunteer (after a refresh). */
  async restore() {
    const all = await this.o.store.all<Hold>('holds');
    SEQUENCE.forEach((s, i) => { this.holds[i] = all.find((h) => h.id === holdId(this.o.participant.code, s.pos, s.round)) ?? null; });
    for (let i = 0; i < SEQUENCE.length; i++) if (this.holds[i]) {
      const b = await this.o.store.get<Blob>('photos', `${this.holds[i]!.id}_clean`);
      if (b) this.thumbs[i] = URL.createObjectURL(b);
    }
    this.idx = this.holds.findIndex((h) => !h);
    if (this.idx < 0) this.idx = SEQUENCE.length;
  }

  get done() { return this.idx >= SEQUENCE.length; }
  /** The capture in progress (photos being encoded and saved), if any. */
  get pending() { return this.capturing; }
  get current() { return SEQUENCE[Math.min(this.idx, SEQUENCE.length - 1)]; }

  /** Feed one tracked frame (after the app's body and physics have run on it). */
  onFrame(f: PilotFrame): RunStatus {
    this.lastImage = f.image; this.lastT = f.t;
    this.log.push(f.t, f.body, f.phys, this.o.participant.heightCm / 100);
    const knee = f.body.angles.R.knee_flex, ok = legOk(f.image);
    // keep full-resolution camera frames every 200 ms for the last few seconds (the photo comes from the window's middle)
    if (ok && !this.grabbing && f.t - this.lastGrab >= 0.2) {
      this.grabbing = true; this.lastGrab = f.t;
      const image = f.image.map((p) => ({ ...p })), t = f.t;
      this.o.source.grab().then((bmp) => {
        if (bmp) this.ring.push({ t, bmp, image });
        while (this.ring.length && t - this.ring[0].t > this.o.duration + 1.5) this.ring.shift()!.bmp.close();
      }).catch(() => { /* a dropped grab only thins the candidate frames */ }).finally(() => { this.grabbing = false; });
    }
    const st = this.detector.push({ t: f.t, knee, conf: legConf(f.image), ok });
    if (ok) this.track(f.t, knee, legConf(f.image));
    this.lastSt = st;
    let hint = st.reason;
    const prev = this.prevHold();
    // after a capture the next hold waits until the knee has moved on (no double capture of one position)
    if (!this.armed && prev && Math.abs(knee - prev.kinemaMean) >= 10) this.armed = true;
    const fit = this.positionFits(st.mean);
    if (!this.done && !hint) {
      if (!this.armed) hint = `Captured. Move to ${this.current.pos}: ${POSITIONS[this.current.pos]}.`;
      else if (!fit) hint = this.current.pos === 'A' ? 'Stand up straight' : this.current.pos === 'B' ? 'Bend to a half squat and hold' : 'Go deeper and hold';
      else if (!st.ready) hint = `Hold still ${Math.max(0, this.o.duration - st.stableS).toFixed(1)} s`;
    }
    if (!this.done && this.armed && fit && st.ready && !this.capturing) void this.capture(false);
    return { ...st, idx: this.idx, knee, armed: this.armed, framing: framing(f.image), hint, done: this.done, capturing: !!this.capturing };
  }

  private prevHold() { for (let i = this.idx - 1; i >= 0; i--) if (this.holds[i]) return this.holds[i]; return null; }

  /** Rough angle gates so a still standing person is not captured as a squat. */
  private positionFits(mean: number) {
    if (!Number.isFinite(mean)) return false;
    const pos = this.current.pos, prev = this.prevHold();
    if (pos === 'A') return mean < 30;
    if (pos === 'B') return mean >= 20 && mean <= 100;
    const b = this.holds[this.idx - 1];
    return mean >= 45 && (!b || b.pos !== 'B' || mean >= b.kinemaMean + 10) && (!prev || Math.abs(mean - prev.kinemaMean) >= 10);
  }

  /** Capture the current hold now (manual) or when auto-detected. */
  capture(manual: boolean): Promise<Hold> {
    if (this.capturing) return this.capturing;
    this.capturing = this.doCapture(manual).finally(() => { this.capturing = null; });
    return this.capturing;
  }

  private async doCapture(manual: boolean): Promise<Hold> {
    if (this.done) throw new Error('protocol complete');
    const inset = snapshot(this.o.inset());   // before any await: a WebGL canvas is cleared after the frame
    // auto: the detector's stable window; manual: whatever the last hold-length of frames shows
    const st = !manual && this.lastSt?.ready ? this.lastSt : this.windowStats(this.o.duration);
    const seq = SEQUENCE[this.idx], code = this.o.participant.code, id = holdId(code, seq.pos, seq.round);
    // the saved frame: the one nearest the window's middle (or the newest, for a manual capture without a stable window)
    const mid = (st.t0 + st.t1) / 2;
    let pick = this.ring.reduce<(typeof this.ring)[number] | null>((b, r) => (!b || Math.abs(r.t - mid) < Math.abs(b.t - mid) ? r : b), null);
    if (!pick) {
      const bmp = await this.o.source.grab();
      if (!bmp || !this.lastImage) throw new Error('no camera frame to save');
      pick = { t: this.lastT, bmp, image: this.lastImage };
    }
    const hold: Hold = {
      id, code, round: seq.round, pos: seq.pos, kinemaMean: st.mean, kinemaSd: st.sd, nFrames: st.n, meanConf: st.conf,
      windowS: st.t1 - st.t0, band: this.o.band, manual, captured: new Date().toISOString(), photoFrameT: pick.t,
      photoW: pick.bmp.width, photoH: pick.bmp.height, previewMirrored: this.o.source.mirrored, blurred: this.o.blur,
      external: this.holds[this.idx]?.external ?? null, notes: this.holds[this.idx]?.notes ?? '', retake: false,
    };
    const { clean, overlay } = await makePhotos(pick.bmp, pick.image, hold, this.o.blur, inset);
    const phys = this.log.window(st.t0, st.t1);
    const store = this.o.store;
    await store.put('holds', id, hold);
    await store.put('photos', `${id}_clean`, clean);
    await store.put('photos', `${id}_overlay`, overlay);
    await store.put('physics', id, { id, csv: phys.csv, meta: this.log.metadata({
      hold: id, participant: code, position: `${seq.pos} (${POSITIONS[seq.pos]})`, round: seq.round, window_s: [st.t0, st.t1], frames: phys.n,
      height_m: this.o.participant.heightCm / 100, mass_kg: this.o.participant.weightKg, scale_factor_note: 'one factor for every segment: height / model standing height',
    }, this.o.hashes) });
    if (this.thumbs[this.idx]) URL.revokeObjectURL(this.thumbs[this.idx]!);
    this.thumbs[this.idx] = URL.createObjectURL(clean);
    this.holds[this.idx] = hold;
    this.idx = this.holds.findIndex((h) => !h);
    if (this.idx < 0) this.idx = SEQUENCE.length;
    this.armed = false;
    this.detector.reset();
    return hold;
  }

  /** Mean, SD, frame count and confidence of the right knee over the last `dur` seconds of logged frames. */
  private windowStats(dur: number) {
    const k = this.kneeLog.filter((x) => this.lastT - x.t <= dur + 1e-6);
    const n = k.length, m = k.reduce((a, x) => a + x.knee, 0) / Math.max(n, 1);
    const sd = Math.sqrt(k.reduce((a, x) => a + (x.knee - m) ** 2, 0) / Math.max(n - 1, 1));
    return { mean: m, sd, n, conf: k.reduce((a, x) => a + x.conf, 0) / Math.max(n, 1), t0: k[0]?.t ?? this.lastT, t1: this.lastT };
  }
  private kneeLog: { t: number; knee: number; conf: number }[] = [];

  private lastSt: HoldStatus | null = null;

  private track(t: number, knee: number, conf: number) {
    this.kneeLog.push({ t, knee, conf });
    while (this.kneeLog.length && t - this.kneeLog[0].t > 8) this.kneeLog.shift();
  }

  /** Clear one hold so it is captured again next. */
  async redo(i: number) {
    const h = this.holds[i];
    if (h) { await this.o.store.del('holds', h.id); await this.o.store.del('photos', `${h.id}_clean`); await this.o.store.del('photos', `${h.id}_overlay`); await this.o.store.del('physics', h.id); }
    if (this.thumbs[i]) URL.revokeObjectURL(this.thumbs[i]!);
    this.holds[i] = null; this.thumbs[i] = null; this.idx = i; this.armed = true; this.detector.reset();
  }

  dispose() { this.ring.forEach((r) => r.bmp.close()); this.ring = []; this.thumbs.forEach((u) => u && URL.revokeObjectURL(u)); }
}

function snapshot(src: CanvasImageSource | null) {
  if (!src) return null;
  const w = (src as HTMLCanvasElement).width, h = (src as HTMLCanvasElement).height;
  if (!w || !h) return null;
  const c = new OffscreenCanvas(w, h); c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

export const holdId = (code: string, pos: Position, round: number) => `${code}_${pos}${round}`;

/** Clean photo (raw frame, optional face pixelation) and an overlay screenshot from the same frame. */
export async function makePhotos(bmp: ImageBitmap, img: Img, hold: Hold, blur: boolean, inset: OffscreenCanvas | null) {
  const w = bmp.width, h = bmp.height;
  const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  if (blur) pixelateAboveShoulders(g, w, h, img);
  const clean = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  // overlay: the same (blurred) frame plus KINEMA's tracked skeleton, the knee angle and the 3D twin
  const P = (i: number) => [img[i].x * w, img[i].y * h];
  const u = Math.max(w, h) / 900;
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(143,227,255,0.45)'; g.lineWidth = 2 * u;
  for (const [a, b] of [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [11, 13], [13, 15], [12, 14], [14, 16]]) {
    if (img[a].v < 0.4 || img[b].v < 0.4) continue;
    g.beginPath(); g.moveTo(...(P(a) as [number, number])); g.lineTo(...(P(b) as [number, number])); g.stroke();
  }
  g.strokeStyle = 'rgb(143,227,255)'; g.lineWidth = 4 * u;
  g.beginPath(); g.moveTo(...(P(24) as [number, number])); g.lineTo(...(P(26) as [number, number])); g.lineTo(...(P(28) as [number, number])); g.lineTo(...(P(30) as [number, number])); g.lineTo(...(P(32) as [number, number])); g.stroke();
  g.fillStyle = 'rgb(255,180,107)';
  for (const i of [24, 26, 28]) { const [x, y] = P(i); g.beginPath(); g.arc(x, y, 6 * u, 0, Math.PI * 2); g.fill(); }
  const [kx, ky] = P(26);
  g.font = `600 ${Math.round(22 * u)}px system-ui, sans-serif`;
  const label = `${hold.kinemaMean.toFixed(1)}°`;
  g.fillStyle = 'rgba(8,11,13,0.78)'; g.fillRect(kx + 14 * u, ky - 16 * u, g.measureText(label).width + 16 * u, 30 * u);
  g.fillStyle = 'rgb(255,180,107)'; g.fillText(label, kx + 22 * u, ky + 7 * u);
  // header strip
  const head = `${hold.id} · ${POSITIONS[hold.pos]} · KINEMA right knee flexion ${hold.kinemaMean.toFixed(1)} ± ${hold.kinemaSd.toFixed(1)}° (${hold.nFrames} frames, ${hold.windowS.toFixed(1)} s)${hold.manual ? ' · manual' : ''}`;
  g.fillStyle = 'rgba(8,11,13,0.8)'; g.fillRect(0, 0, w, 34 * u);
  g.font = `500 ${Math.round(15 * u)}px system-ui, sans-serif`; g.fillStyle = '#e9e4d8'; g.fillText(head, 12 * u, 22 * u);
  g.fillStyle = 'rgba(8,11,13,0.8)'; g.fillRect(0, h - 26 * u, w, 26 * u);
  g.font = `400 ${Math.round(12 * u)}px system-ui, sans-serif`; g.fillStyle = '#a2adb3';
  g.fillText('Model estimate for research use; not a diagnostic measurement. Flexion: straight leg = 0°.', 12 * u, h - 9 * u);
  if (inset) {
    const iw = w * 0.28, ih = Math.min(iw * (inset.height / inset.width), h * 0.6), x = w - iw - 12 * u, y = 44 * u;
    g.fillStyle = 'rgba(8,11,13,0.9)'; g.fillRect(x - 3 * u, y - 3 * u, iw + 6 * u, ih + 6 * u);
    g.drawImage(inset, x, y, iw, ih);
  }
  const overlay = await cv.convertToBlob({ type: 'image/png' });
  return { clean, overlay };
}

/** Simple pixelation of everything above the shoulders (the face), applied to saved photos. */
export function pixelateAboveShoulders(g: OffscreenCanvasRenderingContext2D, w: number, h: number, img: Img) {
  const shoulderY = Math.min(img[11].y, img[12].y) * h;
  const top = 0, bottom = Math.min(Math.max(shoulderY, 0), h);
  if (bottom <= top + 2) return;
  const block = Math.max(10, Math.round(w / 40)), sw = Math.max(1, Math.round(w / block)), sh = Math.max(1, Math.round((bottom - top) / block));
  const small = new OffscreenCanvas(sw, sh), s = small.getContext('2d')!;
  s.drawImage(g.canvas, 0, top, w, bottom - top, 0, 0, sw, sh);
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, sw, sh, 0, top, w, bottom - top);
  g.imageSmoothingEnabled = true;
}
