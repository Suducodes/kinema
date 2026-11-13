import './pilot.css';
import type { Twin } from '../assets';
import type { Stage } from '../../stage';
import type { Body } from '../body';
import type { Physics } from '../physics';
import type { Coach, Mode } from '../coach';
import type { Tracked, Tracker } from '../pose';
import { AngleTool } from './measure';
import { PilotRun, framing, type FrameSource, type RunStatus } from './run';
import { CONVENTION, buildRows, download, exportJson, loadAll, photosZip, physicsZip, resultsCsv, summarise, valgusCsv, type Row } from './results';
import { POSITIONS, PilotStore, SEQUENCE, type Hold, type Measure, type Participant, type ValgusRep } from './store';
import { PhysicsLog } from './physics';
import type { Agreement } from './stats';

/**
 * Pilot measurement mode: a guided flow for knee-angle validation data. Opt-in and separate: nothing
 * here runs until the page opens it, and closing it leaves the main app as it was. Data and photos
 * stay on this device (IndexedDB); no network requests are made.
 */
export interface PilotHost {
  twin: Twin; stage: Stage; body: Body; phys: Physics; coach: Coach; tracker: Tracker; video: HTMLVideoElement;
  isCamera(): boolean; startCamera(): Promise<void>;
  setProfile(heightCm: number, weightKg: number): void;
  setHook(fn: ((tr: Tracked) => void) | null): void;
  setMode(m: Mode): void;
  toast(text: string): void;
}

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));
const STAGES = ['setup', 'capture', 'measure', 'results'] as const;
type Pane = (typeof STAGES)[number];

let pilot: Pilot | null = null;

/** Open pilot mode (built on first use). */
export function openPilot(host: PilotHost) {
  pilot ??= new Pilot(host);
  pilot.show();
  return pilot;
}

class Pilot {
  // ?pilotdb=selftest opens the self-test's database instead (for checking the screens with synthetic data)
  readonly store = new PilotStore(new URLSearchParams(location.search).get('pilotdb') === 'selftest' ? 'kinema-pilot-selftest' : 'kinema-pilot');
  readonly root: HTMLElement;
  private run: PilotRun | null = null;
  private participant: Participant | null = null;
  private pane: Pane = 'setup';
  private tool = new AngleTool();
  private selected: string | null = null;     // hold id in the measure tab
  private revealed = false;
  private sel = -1;                          // selected thumbnail in the capture tab
  private valgus: { on: boolean; count: number; base: number; vR: number[]; vL: number[]; t: number[] } = { on: false, count: 0, base: 0, vR: [], vL: [], t: [] };
  private vlog: PhysicsLog;

  constructor(private readonly host: PilotHost) {
    this.root = document.createElement('section');
    this.root.className = 'pilot'; this.root.id = 'pilot'; this.root.hidden = true;
    this.root.innerHTML = TEMPLATE;
    document.body.appendChild(this.root);
    this.vlog = new PhysicsLog(host.twin.meta);
    this.wire();
  }

  show() {
    this.root.hidden = false;
    document.body.classList.add('pilot-open');
    this.host.setHook((tr) => this.onTracked(tr));
    this.attachPreview();
    void this.restore();
  }

  hide() {
    this.root.hidden = true;
    document.body.classList.remove('pilot-open');
    this.host.setHook(null);
  }

  // ------------------------------------------------------------------ wiring
  private q<T extends HTMLElement>(sel: string) { return $<T>(this.root, sel); }

  private wire() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-pane]').forEach((b) => (b.onclick = () => this.go(b.dataset.pane as Pane)));
    this.q('#pl-exit').onclick = () => this.hide();
    this.q('#pl-start').onclick = () => void this.startVolunteer();
    this.q('#pl-cam').onclick = () => void this.host.startCamera().then(() => this.attachPreview());
    this.q('#pl-mirror').onchange = () => this.attachPreview();
    this.q('#pl-now').onclick = () => void this.captureNow();
    this.q('#pl-redo').onclick = () => void this.redo();
    this.q('#pl-to-measure').onclick = () => { this.go('measure'); void this.nextUnmeasured(); };
    this.q('#pl-next-vol').onclick = () => { this.endVolunteer(); this.go('setup'); };
    this.q('#pl-valgus-go').onclick = () => this.startValgus();
    // measure
    this.q('.pm-canvas').appendChild(this.tool.el);
    this.tool.onChange = () => this.showAngles();
    const rater = this.q<HTMLInputElement>('#pm-rater');
    try { rater.value = localStorage.getItem('kinema-pilot-rater') || 'R1'; } catch { rater.value = 'R1'; }
    rater.onchange = () => { rater.value = rater.value.trim().toUpperCase() || 'R1'; try { localStorage.setItem('kinema-pilot-rater', rater.value); } catch { /* ignore */ } void this.refreshList(); if (this.selected) void this.select(this.selected); };
    this.q('#pm-blind').onchange = () => this.showAngles();
    this.q('#pm-save').onclick = () => void this.saveMeasure();
    this.q('#pm-clear').onclick = () => this.tool.clear();
    this.q('#pm-next').onclick = () => void this.nextUnmeasured();
    this.q('#pm-retake').onclick = () => void this.flagRetake();
    this.q('#pm-zin').onclick = () => this.tool.zoomAt(1.4);
    this.q('#pm-zout').onclick = () => this.tool.zoomAt(1 / 1.4);
    this.q('#pm-fit').onclick = () => this.tool.fit();
    this.q<HTMLInputElement>('#pm-ext').onchange = () => void this.saveHoldField();
    this.q<HTMLTextAreaElement>('#pm-notes').onchange = () => void this.saveHoldField();
    // results
    this.q('#pr-csv').onclick = () => void this.exportCsv();
    this.q('#pr-json').onclick = () => void exportJson(this.store, this.host.twin.hashes).then((j) => download(new Blob([j], { type: 'application/json' }), `kinema-pilot-${stamp()}.json`));
    this.q('#pr-photos').onclick = () => void this.busy('#pr-photos', photosZip(this.store, this.host.twin.hashes).then((z) => download(z, `kinema-pilot-photos-${stamp()}.zip`)));
    this.q('#pr-physics').onclick = () => void this.busy('#pr-physics', physicsZip(this.store, this.host.twin.hashes).then((z) => download(z, `kinema-pilot-physics-${stamp()}.zip`)));
    this.q('#pr-valgus').onclick = () => void loadAll(this.store).then((d) => download(new Blob([valgusCsv(d.valgus, d.participants)], { type: 'text/csv' }), `kinema-pilot-valgus-${stamp()}.csv`));
    this.q('#pr-delete').onclick = () => void this.deleteAll();
    this.q<HTMLSelectElement>('#pr-ref').onchange = () => void this.renderResults();
    this.q('#pl-convention').textContent = CONVENTION;
  }

  private async busy(sel: string, p: Promise<unknown>) {
    const b = this.q<HTMLButtonElement>(sel), t = b.textContent;
    b.disabled = true; b.textContent = 'Preparing…';
    try { await p; } catch (e) { this.host.toast(`Export failed: ${(e as Error).message}`); } finally { b.disabled = false; b.textContent = t; }
  }

  private go(p: Pane) {
    this.pane = p;
    this.root.querySelectorAll<HTMLElement>('.pl-pane').forEach((el) => (el.hidden = el.dataset.id !== p));
    this.root.querySelectorAll<HTMLButtonElement>('.pl-tabs [data-pane]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === p)));
    if (p === 'setup' || p === 'capture') this.attachPreview();
    if (p === 'measure') { void this.refreshList(); requestAnimationFrame(() => this.tool.fit()); }
    if (p === 'results') void this.renderResults();
  }

  // ------------------------------------------------------------------ persistence
  private async restore() {
    const participants = await this.store.all<Participant>('participants');
    const codes = new Set(participants.map((p) => p.code));
    let n = 1; while (codes.has(`P${String(n).padStart(2, '0')}`)) n++;
    const code = this.q<HTMLInputElement>('#pl-code');
    code.placeholder = `P${String(n).padStart(2, '0')}`;
    if (!code.value) code.value = code.placeholder;
    if (this.run) return;
    const session = await this.store.get<{ code: string }>('kv', 'session');
    const p = session && participants.find((x) => x.code === session.code);
    if (p) {
      await this.beginRun(p);
      this.host.toast(`Restored ${p.code}: ${this.run!.holds.filter(Boolean).length} of 6 holds saved.`);
      this.go(this.run!.done ? 'measure' : 'capture');
    } else this.go('setup');
  }

  // ------------------------------------------------------------------ setup
  private readForm(): Participant | null {
    const v = (id: string) => this.q<HTMLInputElement>(id).value.trim();
    const code = v('#pl-code').toUpperCase(), h = Number(v('#pl-height')), w = Number(v('#pl-weight')), age = v('#pl-age') ? Number(v('#pl-age')) : null;
    const err = (m: string) => { this.q('#pl-form-err').textContent = m; return null; };
    if (!/^[A-Z]{1,3}\d{1,4}$/.test(code)) return err('Use a code like P01 (no names).');
    if (!(h >= 120 && h <= 220)) return err('Height in cm (120 to 220).');
    if (!(w >= 25 && w <= 200)) return err('Weight in kg (25 to 200).');
    if (age !== null && !(age >= 18 && age <= 100)) return err('Age 18 to 100 (adult volunteers only).');
    this.q('#pl-form-err').textContent = '';
    return { code, age, sex: this.q<HTMLSelectElement>('#pl-sex').value as Participant['sex'], heightCm: h, weightKg: w, created: new Date().toISOString() };
  }

  private async startVolunteer() {
    const p = this.readForm();
    if (!p) return;
    const existing = await this.store.get<Participant>('participants', p.code);
    if (existing && !confirm(`${p.code} already exists. Continue that volunteer's session (saved holds are kept)?`)) return;
    await this.store.put('participants', p.code, existing ? { ...existing, ...p, created: existing.created } : p);
    await this.store.put('kv', 'session', { code: p.code });
    if (!this.host.isCamera()) await this.host.startCamera();
    if (!this.host.isCamera()) {
      this.q('#pl-form-err').textContent = 'Camera not available: allow camera access in the browser and press Start protocol again.';
      return;
    }
    await this.beginRun(p);
    this.go('capture');
  }

  private async beginRun(p: Participant) {
    this.run?.dispose();
    this.participant = p;
    this.host.setProfile(p.heightCm, p.weightKg);
    const video = this.host.video;
    const source: FrameSource = {
      mirrored: this.q<HTMLInputElement>('#pl-mirror').checked,
      grab: () => (video.readyState >= 2 && video.videoWidth ? createImageBitmap(video) : Promise.resolve(null)),
    };
    const s = this.settings();
    this.run = new PilotRun({ store: this.store, participant: p, meta: this.host.twin.meta, hashes: this.host.twin.hashes, band: s.band, duration: s.duration,
      blur: s.blur, source, inset: () => { const st = this.host.stage; st.renderer.render(st.scene, st.override ?? st.camera); return st.renderer.domElement; } });
    await this.run.restore();
    this.q('#pl-who').textContent = `${p.code} · ${p.heightCm} cm · ${p.weightKg} kg`;
    this.lastHoldCount = this.run.holds.filter(Boolean).length;
    this.renderThumbs();
    this.renderStep();
  }

  private endVolunteer() {
    this.run?.dispose(); this.run = null; this.participant = null; this.valgus.on = false;
    void this.store.del('kv', 'session');
    this.q('#pl-who').textContent = 'No volunteer';
    for (const id of ['#pl-code', '#pl-age', '#pl-height', '#pl-weight']) this.q<HTMLInputElement>(id).value = '';
    void this.restore();
  }

  private settings() {
    const n = (id: string, d: number) => { const v = Number(this.q<HTMLInputElement>(id).value); return Number.isFinite(v) && v > 0 ? v : d; };
    return { band: n('#pl-band', 2), duration: n('#pl-dur', 3), blur: this.q<HTMLInputElement>('#pl-blur').checked };
  }

  // ------------------------------------------------------------------ live preview
  private attachPreview() {
    const v = this.q<HTMLVideoElement>('#pl-video'), stream = this.host.video.srcObject;
    if (v.srcObject !== stream) { v.srcObject = stream; if (stream) void v.play().catch(() => {}); }
    const mirrored = this.q<HTMLInputElement>('#pl-mirror').checked;
    this.root.classList.toggle('pl-mirrored', mirrored);
    const box = this.q('#pl-preview'), target = this.pane === 'capture' ? this.q('#pl-preview-capture') : this.q('#pl-preview-setup');
    if (box.parentElement !== target) target.appendChild(box);
    this.q('#pl-nocam').hidden = !!stream;
  }

  private onTracked(tr: Tracked) {
    if (this.root.hidden) return;
    const img = tr.image;
    this.drawPreview(img);
    const f = framing(img);
    const set = (id: string, ok: boolean) => this.q(`#pl-f-${id}`).classList.toggle('ok', ok);
    set('hip', f.hip); set('knee', f.knee); set('ankle', f.ankle); set('feet', f.feet); set('head', f.head); set('side', f.sideOn && f.rightFacing);
    this.q('#pl-framing').classList.toggle('ok', f.ok);
    this.q('#pl-framing-text').textContent = f.ok ? (f.sideOn && f.rightFacing ? 'Framing OK' : 'Framing OK · turn so the RIGHT leg faces the camera') : 'Adjust framing';
    if (this.valgus.on) this.trackValgus(tr);
    else if (this.run && this.pane === 'capture') this.renderCapture(this.run.onFrame({ t: tr.frame.t, image: img, body: this.host.body, phys: this.host.phys }));
  }

  private drawPreview(img: Tracked['image']) {
    const cv = this.q<HTMLCanvasElement>('#pl-overlay'), v = this.q<HTMLVideoElement>('#pl-video');
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(devicePixelRatio, 2);
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const vw = v.videoWidth || 4, vh = v.videoHeight || 3, s = Math.min(w / vw, h / vh), ox = (w - vw * s) / 2, oy = (h - vh * s) / 2;   // object-fit: contain
    const P = (i: number): [number, number] => [ox + img[i].x * vw * s, oy + img[i].y * vh * s];
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(143,227,255,.35)'; g.lineWidth = 2;
    for (const [a, b] of [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [11, 13], [13, 15], [12, 14], [14, 16]]) {
      if (img[a].v < 0.4 || img[b].v < 0.4) continue;
      g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke();
    }
    g.strokeStyle = '#8fe3ff'; g.lineWidth = 3.5;
    g.beginPath(); g.moveTo(...P(24)); g.lineTo(...P(26)); g.lineTo(...P(28)); g.stroke();
    for (const i of [24, 26, 28]) {
      g.fillStyle = img[i].v >= 0.7 ? '#ffb46b' : '#e07a5f';
      g.beginPath(); g.arc(...P(i), 5, 0, Math.PI * 2); g.fill();
    }
  }

  // ------------------------------------------------------------------ capture
  private renderCapture(st: RunStatus) {
    const run = this.run!;
    const cur = SEQUENCE[Math.min(st.idx, 5)];
    this.q('#pl-step').textContent = st.done ? 'Protocol complete' : `Round ${cur.round} of 2: ${cur.pos} ${POSITIONS[cur.pos]}`;
    this.q('#pl-angle').textContent = Number.isFinite(st.knee) ? st.knee.toFixed(1) : '–';
    this.q('#pl-hint').textContent = st.capturing ? 'Saving photos…' : st.done ? 'All six holds saved. Measure the photos, or start the next volunteer.' : st.hint;
    this.q('#pl-hint').classList.toggle('warn', !!st.reason);
    const ring = this.q<HTMLElement>('#pl-ring');
    ring.style.setProperty('--p', String(st.done || !st.armed ? 0 : st.progress));
    this.q('#pl-sd').textContent = Number.isFinite(st.sd) && st.n ? `±${st.sd.toFixed(1)}° over ${st.stableS.toFixed(1)} s` : '';
    this.q('#pl-done').hidden = !st.done;
    this.q('#pl-valgus').hidden = !(st.done && this.q<HTMLInputElement>('#pl-bonus').checked);
    this.q<HTMLButtonElement>('#pl-now').disabled = st.done || st.capturing;
    run.holds.forEach((_, i) => this.q(`#pl-seg-${i}`).className = i < 6 && run.holds[i] ? 'done' : i === st.idx ? 'cur' : '');
    if (this.lastHoldCount !== run.holds.filter(Boolean).length) { this.lastHoldCount = run.holds.filter(Boolean).length; this.renderThumbs(); if (this.lastHoldCount) this.beep(); }
  }
  private lastHoldCount = -1;

  /** Step label and progress before any camera frame arrives. */
  private renderStep() {
    const run = this.run;
    if (!run) return;
    const cur = run.current;
    this.q('#pl-step').textContent = run.done ? 'Protocol complete' : `Round ${cur.round} of 2: ${cur.pos} ${POSITIONS[cur.pos]}`;
    run.holds.forEach((h, i) => (this.q(`#pl-seg-${i}`).className = h ? 'done' : i === run.idx ? 'cur' : ''));
    this.q('#pl-done').hidden = !run.done;
  }

  private beep() {
    try {
      const ac = new AudioContext(), o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
      o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.3); o.onended = () => void ac.close();
    } catch { /* no audio */ }
  }

  private renderThumbs() {
    const run = this.run, strip = this.q('#pl-thumbs');
    strip.innerHTML = SEQUENCE.map((s, i) => {
      const h = run?.holds[i], url = run?.thumbs[i];
      return `<button class="pl-thumb${i === this.sel ? ' sel' : ''}${h?.retake ? ' flag' : ''}" data-i="${i}">
        ${url ? `<img src="${url}" alt="">` : '<i></i>'}<b>${s.pos}${s.round}</b><span>${h ? `${h.kinemaMean.toFixed(1)}°` : POSITIONS[s.pos]}</span></button>`;
    }).join('');
    strip.querySelectorAll<HTMLButtonElement>('.pl-thumb').forEach((b) => (b.onclick = () => { this.sel = Number(b.dataset.i); this.renderThumbs(); }));
  }

  private async captureNow() {
    if (!this.run || this.run.done) return;
    try { await this.run.capture(true); this.host.toast('Captured (manual).'); } catch (e) { this.host.toast(`Not captured: ${(e as Error).message}`); }
  }

  private async redo() {
    if (!this.run) return;
    const i = this.sel >= 0 ? this.sel : this.lastCaptured();
    if (i < 0) return;
    await this.run.redo(i);
    this.sel = -1; this.lastHoldCount = this.run.holds.filter(Boolean).length; this.renderThumbs(); this.renderStep();
    this.host.toast(`${SEQUENCE[i].pos}${SEQUENCE[i].round} cleared: hold that position again.`);
  }

  private lastCaptured() { const r = this.run!; for (let i = 5; i >= 0; i--) if (r.holds[i]) return i; return -1; }

  // ------------------------------------------------------------------ bonus: frontal squats (coach valgus)
  private startValgus() {
    this.valgus = { on: true, count: 0, base: this.host.coach.reps.length, vR: [], vL: [], t: [] };
    this.host.setMode('squat');
    this.valgus.base = this.host.coach.reps.length;
    this.vlog.clear();
    this.q('#pl-valgus-status').textContent = 'Face the camera. Do 5 slow squats: 0 of 5.';
  }

  private trackValgus(tr: Tracked) {
    const b = this.host.body, c = this.host.coach, v = this.valgus;
    v.t.push(tr.frame.t); v.vR.push(b.angles.R.valgus); v.vL.push(b.angles.L.valgus);
    while (v.t.length && tr.frame.t - v.t[0] > 10) { v.t.shift(); v.vR.shift(); v.vL.shift(); }
    this.vlog.push(tr.frame.t, b, this.host.phys, (this.participant?.heightCm ?? 172) / 100);
    if (c.reps.length - v.base > v.count && this.participant) {
      const rep = c.reps[c.reps.length - 1], span = (rep.down || 1.5) + (rep.up || 1.5) + 0.3, t1 = tr.frame.t, t0 = t1 - span;
      const inWin = (arr: number[]) => Math.max(...arr.filter((_, i) => v.t[i] >= t0));
      v.count++;
      const id = `${this.participant.code}_V${v.count}`;
      const rec: ValgusRep = { id, code: this.participant.code, rep: v.count, coachPeakValgus: rep.valgus, peakValgusR: inWin(v.vR), peakValgusL: inWin(v.vL),
        depth: rep.depth, downS: rep.down, upS: rep.up, ts: new Date().toISOString() };
      void this.store.put('valgus', id, rec);
      const w = this.vlog.window(t0, t1);
      void this.store.put('physics', id, { id, csv: w.csv, meta: this.vlog.metadata({ rep: id, participant: this.participant.code, window_s: [t0, t1], frames: w.n,
        valgus: 'coach_peak_valgus = the coach\'s per-rep peak (the worse knee); right/left = peaks of the same per-frame valgus measure over the rep',
        height_m: this.participant.heightCm / 100, mass_kg: this.participant.weightKg }, this.host.twin.hashes) });
      this.beep();
      this.q('#pl-valgus-status').textContent = v.count >= 5 ? 'Done: 5 squats recorded.' : `Face the camera. Do 5 slow squats: ${v.count} of 5.`;
      if (v.count >= 5) v.on = false;
    }
  }

  // ------------------------------------------------------------------ measure
  private async refreshList() {
    const d = await loadAll(this.store), rater = this.rater();
    const list = this.q('#pm-list');
    if (!d.holds.length) { list.innerHTML = '<p class="pl-empty">No photos yet. Capture a volunteer first.</p>'; return; }
    const byCode = new Map<string, Hold[]>();
    d.holds.forEach((h) => byCode.set(h.code, [...(byCode.get(h.code) ?? []), h]));
    list.innerHTML = [...byCode.entries()].map(([code, hs]) => `<div class="pm-group"><b>${code}</b>${hs.map((h) => {
      const mine = d.measures.some((m) => m.holdId === h.id && m.rater === rater), raters = d.measures.filter((m) => m.holdId === h.id).map((m) => m.rater);
      return `<button data-id="${h.id}" class="${h.id === this.selected ? 'sel' : ''} ${mine ? 'done' : ''} ${h.retake ? 'flag' : ''}"><span>${h.pos}${h.round}</span><em>${h.retake ? 'retake' : mine ? '✓' : ''}</em><small>${raters.join(' ')}</small></button>`;
    }).join('')}</div>`).join('');
    list.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) => (b.onclick = () => void this.select(b.dataset.id!)));
    const left = d.holds.filter((h) => !h.retake && !d.measures.some((m) => m.holdId === h.id && m.rater === rater)).length;
    this.q('#pm-left').textContent = `${left} unmeasured for ${rater}`;
  }

  private rater() { return this.q<HTMLInputElement>('#pm-rater').value.trim().toUpperCase() || 'R1'; }

  private async select(id: string) {
    this.selected = id;
    const blob = await this.store.get<Blob>('photos', `${id}_clean`), hold = await this.store.get<Hold>('holds', id);
    const m = await this.store.get<Measure>('measures', `${id}|${this.rater()}`);
    this.tool.load(blob ? await createImageBitmap(blob) : null, m?.pts ?? []);
    this.revealed = !!m;
    this.q('#pm-title').textContent = hold ? `${hold.code} · ${hold.pos}${hold.round} · ${POSITIONS[hold.pos]}` : id;
    this.q<HTMLInputElement>('#pm-ext').value = hold?.external !== null && hold?.external !== undefined ? String(hold.external) : '';
    this.q<HTMLTextAreaElement>('#pm-notes').value = hold?.notes ?? '';
    this.currentHold = hold ?? null;
    this.showAngles();
    void this.refreshList();
  }
  private currentHold: Hold | null = null;

  private showAngles() {
    const a = this.tool.angles, h = this.currentHold, blind = this.q<HTMLInputElement>('#pm-blind').checked;
    this.q('#pm-interior').textContent = a ? `${a.interior.toFixed(1)}°` : '–';
    this.q('#pm-flexion').textContent = a ? `${a.flexion.toFixed(1)}°` : '–';
    const show = !blind || this.revealed;
    this.q('#pm-kinema').textContent = !h ? '–' : show ? `${h.kinemaMean.toFixed(1)}° (SD ${h.kinemaSd.toFixed(1)})` : 'hidden until saved (blind mode)';
    this.q('#pm-diff').textContent = h && a && show ? `${(h.kinemaMean - a.flexion).toFixed(1)}°` : '–';
    this.q<HTMLButtonElement>('#pm-save').disabled = !a || !h;
  }

  private async saveMeasure() {
    const a = this.tool.angles, h = this.currentHold;
    if (!a || !h) return;
    const rater = this.rater();
    const m: Measure = { id: `${h.id}|${rater}`, holdId: h.id, rater, pts: this.tool.pts.map((p) => [Number(p[0].toFixed(2)), Number(p[1].toFixed(2))]), interior: a.interior, flexion: a.flexion, ts: new Date().toISOString() };
    await this.store.put('measures', m.id, m);
    this.revealed = true; this.showAngles();
    this.host.toast(`Saved ${h.id} for ${rater}: ${a.flexion.toFixed(1)}° flexion.`);
    void this.refreshList();
  }

  private async nextUnmeasured() {
    const d = await loadAll(this.store), rater = this.rater();
    const next = d.holds.find((h) => !h.retake && h.id !== this.selected && !d.measures.some((m) => m.holdId === h.id && m.rater === rater))
      ?? d.holds.find((h) => !h.retake && !d.measures.some((m) => m.holdId === h.id && m.rater === rater));
    if (next) await this.select(next.id); else this.host.toast(`Every photo is measured for ${rater}.`);
  }

  private async flagRetake() {
    const h = this.currentHold;
    if (!h) return;
    h.retake = !h.retake;
    await this.store.put('holds', h.id, h);
    this.host.toast(h.retake ? `${h.id} marked: stickers not visible, retake this hold (Capture tab, select it, Redo).` : `${h.id} unmarked.`);
    void this.refreshList();
  }

  private async saveHoldField() {
    const h = this.currentHold;
    if (!h) return;
    const ext = this.q<HTMLInputElement>('#pm-ext').value.trim();
    h.external = ext === '' ? null : Number(ext);
    h.notes = this.q<HTMLTextAreaElement>('#pm-notes').value;
    await this.store.put('holds', h.id, h);
  }

  // ------------------------------------------------------------------ results
  private async renderResults() {
    const d = await loadAll(this.store);
    const raters = [...new Set(d.measures.map((m) => m.rater))].sort();
    const refSel = this.q<HTMLSelectElement>('#pr-ref'), ref = refSel.value || 'R1';
    refSel.innerHTML = (raters.length ? raters : ['R1']).map((r) => `<option ${r === ref ? 'selected' : ''}>${r}</option>`).join('');
    const second = raters.find((r) => r !== ref) ?? 'R2';
    const rows = buildRows(d, refSel.value || 'R1', second), s = summarise(rows);
    const card = (k: string, v: string, sub = '') => `<div><b>${v}</b><span>${k}</span>${sub ? `<em>${sub}</em>` : ''}</div>`;
    const A = s.overall;
    this.q('#pr-summary').innerHTML = A ? [card('pairs', String(A.n)), card('mean bias', `${fmt(A.bias)}°`, 'KINEMA − reference'), card('SD of differences', `${fmt(A.sdDiff)}°`),
      card('95% limits of agreement', `${fmt(A.loaLow)} to ${fmt(A.loaHigh)}°`), card('RMSE', `${fmt(A.rmse)}°`), card('MAE', `${fmt(A.mae)}°`),
      card('Pearson r', fmt(A.r, 3)), card('ICC(2,1)', fmt(A.icc, 3), 'absolute agreement')].join('')
      : `<p class="pl-empty">${s.pairs} of 10 measured pairs so far. The summary appears at 10.</p>`;
    const pos = (['A', 'B', 'C'] as const).map((p) => { const a = s.byPos[p] as Agreement | null;
      return `<tr><td>${p} · ${POSITIONS[p]}</td><td>${a?.n ?? rows.filter((r) => r.ref !== null && r.hold.pos === p).length}</td><td>${fmt(a?.bias)}</td><td>${fmt(a?.sdDiff)}</td><td>${a ? `${fmt(a.loaLow)} to ${fmt(a.loaHigh)}` : '–'}</td><td>${fmt(a?.rmse)}</td><td>${fmt(a?.mae)}</td><td>${fmt(a?.r, 3)}</td></tr>`; }).join('');
    this.q('#pr-bypos').innerHTML = `<tr><th>Position</th><th>n</th><th>Bias</th><th>SD diff</th><th>95% LoA</th><th>RMSE</th><th>MAE</th><th>r</th></tr>${pos}`;
    this.q('#pr-inter').innerHTML = s.inter ? `Inter-rater (${ref} vs ${second}, n = ${s.inter.n}): ICC(2,1) <b>${fmt(s.inter.icc, 3)}</b>, mean absolute difference <b>${fmt(s.inter.mad)}°</b>`
      : `Inter-rater statistics appear once a second rater (${second}) has measured at least 10 photos.`;
    this.q('#pr-table').innerHTML = `<tr><th>Code</th><th>Round</th><th>Pos</th><th>Ref (${ref})</th><th>KINEMA mean</th><th>SD</th><th>Diff</th><th>Notes</th></tr>` +
      rows.map((r) => `<tr class="${r.hold.retake ? 'flag' : ''}"><td>${r.hold.code}</td><td>${r.hold.round}</td><td>${r.hold.pos}</td><td>${fmt(r.ref)}</td><td>${fmt(r.hold.kinemaMean)}</td><td>${fmt(r.hold.kinemaSd)}</td><td>${fmt(r.diff)}</td><td>${esc(r.hold.retake ? `retake · ${r.hold.notes}` : r.hold.notes)}</td></tr>`).join('');
    this.drawBA(rows, A);
    this.q('#pr-count').textContent = `${d.participants.length} volunteers · ${d.holds.length} holds · ${d.measures.length} measurements · ${d.valgus.length} frontal reps`;
  }

  private drawBA(rows: Row[], A: Agreement | null) {
    const cv = this.q<HTMLCanvasElement>('#pr-ba'), w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(devicePixelRatio, 2);
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const pts = rows.filter((r) => r.ref !== null && !r.hold.retake).map((r) => ({ m: (r.ref! + r.hold.kinemaMean) / 2, d: r.diff!, pos: r.hold.pos }));
    const pad = { l: 44, r: 12, t: 14, b: 30 };
    const xs = pts.map((p) => p.m), ys = pts.map((p) => p.d).concat(A ? [A.loaLow, A.loaHigh] : []);
    const x0 = Math.min(0, ...xs) - 5, x1 = Math.max(120, ...xs) + 5, ylim = Math.max(10, ...ys.map(Math.abs)) * 1.15;
    const X = (v: number) => pad.l + ((v - x0) / (x1 - x0)) * (w - pad.l - pad.r), Y = (v: number) => pad.t + (1 - (v + ylim) / (2 * ylim)) * (h - pad.t - pad.b);
    g.font = '11px system-ui'; g.fillStyle = '#6d7a81'; g.strokeStyle = 'rgba(214,222,226,.1)';
    for (let v = Math.ceil(x0 / 20) * 20; v <= x1; v += 20) { g.beginPath(); g.moveTo(X(v), pad.t); g.lineTo(X(v), h - pad.b); g.stroke(); g.fillText(String(v), X(v) - 6, h - pad.b + 14); }
    const step = ylim > 20 ? 10 : 5;
    for (let v = -Math.floor(ylim / step) * step; v <= ylim; v += step) { g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(w - pad.r, Y(v)); g.stroke(); g.fillText(String(v), 8, Y(v) + 4); }
    g.fillStyle = '#a2adb3'; g.fillText('mean of KINEMA and reference (°)', w / 2 - 80, h - 4);
    g.save(); g.translate(12, h / 2 + 50); g.rotate(-Math.PI / 2); g.fillText('KINEMA − reference (°)', 0, 0); g.restore();
    const line = (v: number, c: string, dash: number[]) => { g.strokeStyle = c; g.setLineDash(dash); g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(w - pad.r, Y(v)); g.stroke(); g.setLineDash([]); };
    line(0, 'rgba(233,228,216,.35)', []);
    if (A) { line(A.bias, '#8fe3ff', []); line(A.loaLow, '#ffb46b', [5, 4]); line(A.loaHigh, '#ffb46b', [5, 4]); }
    const col = { A: '#9fc3d4', B: '#e9c46a', C: '#e07a5f' };
    for (const p of pts) { g.fillStyle = col[p.pos]; g.beginPath(); g.arc(X(p.m), Y(p.d), 4, 0, Math.PI * 2); g.fill(); }
  }

  private async exportCsv() {
    const d = await loadAll(this.store), raters = [...new Set(d.measures.map((m) => m.rater))].sort();
    const ref = this.q<HTMLSelectElement>('#pr-ref').value || 'R1';
    download(new Blob([resultsCsv(buildRows(d, ref, raters.find((r) => r !== ref) ?? 'R2'))], { type: 'text/csv' }), `kinema-pilot-${stamp()}.csv`);
  }

  private async deleteAll() {
    if (!confirm('Delete ALL pilot data on this device: volunteers, photos, measurements and physics files? This cannot be undone. Export first if you need it.')) return;
    this.run?.dispose(); this.run = null; this.participant = null;
    await this.store.clearAll();
    this.tool.load(null); this.selected = null; this.currentHold = null;
    this.q('#pl-who').textContent = 'No volunteer';
    this.host.toast('All pilot data deleted from this device.');
    this.go('setup'); void this.restore();
  }
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const TEMPLATE = /* html */ `
  <header class="pl-bar">
    <div class="pl-brand"><b>Pilot measurement</b><span>Knee-angle validation · research use</span></div>
    <nav class="pl-tabs" role="tablist">
      <button data-pane="setup" aria-selected="true"><i>1</i>Volunteer</button>
      <button data-pane="capture"><i>2</i>Capture</button>
      <button data-pane="measure"><i>3</i>Measure</button>
      <button data-pane="results"><i>4</i>Results</button>
    </nav>
    <span class="pl-who" id="pl-who">No volunteer</span>
    <button class="ghost" id="pl-exit">Exit pilot mode</button>
  </header>
  <p class="pl-notice">Model estimate for research use; not a diagnostic measurement. In pilot mode, photos and data are saved <b>only on this device</b>; nothing is uploaded.</p>
  <main class="pl-main">
    <section class="pl-pane" data-id="setup">
      <div class="pl-col">
        <div class="pl-card">
          <h3>Volunteer</h3>
          <div class="pl-form">
            <label>Participant code<input id="pl-code" autocomplete="off" maxlength="8" /></label>
            <label>Age<input id="pl-age" type="number" inputmode="numeric" min="18" max="100" /></label>
            <label>Sex<select id="pl-sex"><option>female</option><option>male</option><option selected>prefer not to say</option></select></label>
            <label>Height (cm)<input id="pl-height" type="number" inputmode="decimal" min="120" max="220" /></label>
            <label>Weight (kg)<input id="pl-weight" type="number" inputmode="decimal" min="25" max="200" /></label>
          </div>
          <p class="pl-err" id="pl-form-err"></p>
          <p class="pl-remind">Camera at hip height, 2.5 to 3 m away, side-on to the <b>RIGHT</b> leg, whole body in frame, stickers on hip, knee and ankle.</p>
          <div class="pl-actions"><button class="pill" id="pl-cam">Start camera</button><button class="pill accent" id="pl-start">Start protocol</button></div>
          <p class="pl-small">No names: use codes only. Adults who have given consent.</p>
        </div>
        <details class="pl-card pl-settings">
          <summary>Settings</summary>
          <div class="pl-form">
            <label>Hold band (±°)<input id="pl-band" type="number" step="0.5" min="0.5" max="10" value="2" /></label>
            <label>Hold time (s)<input id="pl-dur" type="number" step="0.5" min="1" max="10" value="3" /></label>
          </div>
          <label class="pl-check"><input type="checkbox" id="pl-blur" checked /> Blur above the shoulders in saved photos</label>
          <label class="pl-check"><input type="checkbox" id="pl-mirror" /> Mirror the preview (saved photos are never mirrored)</label>
          <label class="pl-check"><input type="checkbox" id="pl-bonus" /> Bonus: frontal squats, peak knee valgus per rep</label>
        </details>
        <details class="pl-card pl-settings"><summary>Angle convention</summary><p class="pl-small" id="pl-convention"></p>
          <p class="pl-small">KINEMA already reports knee flexion with straight = 0, so no conversion is applied to its values.</p></details>
      </div>
      <div class="pl-col pl-wide">
        <div id="pl-preview-setup" class="pl-preview-slot"></div>
        <div class="pl-framing" id="pl-framing"><b id="pl-framing-text">Waiting for the camera</b>
          <span id="pl-f-hip">Right hip</span><span id="pl-f-knee">Right knee</span><span id="pl-f-ankle">Right ankle</span>
          <span id="pl-f-feet">Right foot</span><span id="pl-f-head">Head in frame</span><span id="pl-f-side">Side-on, right leg to camera</span></div>
      </div>
    </section>

    <section class="pl-pane" data-id="capture" hidden>
      <div class="pl-col pl-wide">
        <div class="pl-steprow"><h2 id="pl-step">Start a volunteer first</h2></div>
        <div class="pl-progress">${SEQUENCE.map((s, i) => `<span id="pl-seg-${i}"><b>${s.pos}${s.round}</b></span>`).join('')}</div>
        <div id="pl-preview-capture" class="pl-preview-slot"></div>
      </div>
      <div class="pl-col pl-side">
        <div class="pl-card pl-live">
          <span class="pl-label">Right knee flexion</span>
          <div class="pl-ring" id="pl-ring"><b id="pl-angle">–</b><em>°</em></div>
          <span class="pl-sd" id="pl-sd"></span>
          <p class="pl-hint" id="pl-hint">Stand still in position.</p>
          <div class="pl-actions"><button class="pill" id="pl-now">Capture now</button><button class="pill" id="pl-redo">Redo this hold</button></div>
          <p class="pl-small">Auto-capture after the knee stays within the band for the hold time. Pick a thumbnail first to redo that hold.</p>
        </div>
        <div class="pl-card" id="pl-done" hidden>
          <h3>Protocol complete</h3>
          <p class="pl-small">Check each photo: if any sticker is hidden, select its thumbnail and press Redo.</p>
          <div class="pl-actions"><button class="pill accent" id="pl-to-measure">Measure photos</button><button class="pill" id="pl-next-vol">Next volunteer</button></div>
        </div>
        <div class="pl-card" id="pl-valgus" hidden>
          <h3>Bonus: frontal squats</h3>
          <p class="pl-small">Turn to face the camera. The coach's peak knee valgus is recorded for each of 5 slow squats.</p>
          <div class="pl-actions"><button class="pill" id="pl-valgus-go">Start</button></div>
          <p class="pl-small" id="pl-valgus-status"></p>
        </div>
      </div>
      <div class="pl-thumbs" id="pl-thumbs"></div>
    </section>

    <section class="pl-pane pm" data-id="measure" hidden>
      <aside class="pm-listcol"><div class="pm-rater"><label>Rater<input id="pm-rater" maxlength="4" /></label><span id="pm-left"></span></div><div id="pm-list"></div></aside>
      <div class="pm-center">
        <div class="pm-top"><b id="pm-title">Pick a photo</b><span><button class="ghost" id="pm-zout">−</button><button class="ghost" id="pm-fit">Fit</button><button class="ghost" id="pm-zin">+</button></span></div>
        <div class="pm-canvas"></div>
      </div>
      <aside class="pm-panel pl-card">
        <label class="pl-check"><input type="checkbox" id="pm-blind" checked /> Blind mode: hide KINEMA until saved</label>
        <ol class="pl-small"><li>Click the <b>hip</b> sticker centre</li><li>Click the <b>knee</b> sticker centre</li><li>Click the <b>ankle</b> sticker centre</li></ol>
        <dl class="pm-vals"><dt>Interior angle at knee</dt><dd id="pm-interior">–</dd><dt>Knee flexion</dt><dd id="pm-flexion" class="big">–</dd>
          <dt>KINEMA (mean of hold)</dt><dd id="pm-kinema">–</dd><dt>KINEMA − reference</dt><dd id="pm-diff">–</dd></dl>
        <p class="pm-formula">flexion = 180° − interior angle</p>
        <div class="pl-actions"><button class="pill accent" id="pm-save" disabled>Save measurement</button><button class="pill" id="pm-clear">Clear points</button></div>
        <button class="pill wide" id="pm-next">Measure next unmeasured photo</button>
        <button class="pill wide warn" id="pm-retake">Stickers not visible: mark for retake</button>
        <label>External angle (optional, e.g. Kinovea)<input id="pm-ext" type="number" step="0.1" /></label>
        <label>Notes<textarea id="pm-notes" rows="2"></textarea></label>
      </aside>
    </section>

    <section class="pl-pane pr" data-id="results" hidden>
      <div class="pr-head"><h3>Agreement with the photo reference</h3><label>Reference rater <select id="pr-ref"></select></label><span id="pr-count"></span></div>
      <div class="pr-summary" id="pr-summary"></div>
      <div class="pr-grid">
        <div class="pl-card"><h3>Bland-Altman</h3><canvas id="pr-ba"></canvas><p class="pl-small">Dots: A standing (blue), B half (gold), C deep (red). Lines: bias (cyan) and 95% limits (amber).</p></div>
        <div class="pl-card"><h3>By position</h3><table class="pr-t" id="pr-bypos"></table><p class="pl-small" id="pr-inter"></p></div>
      </div>
      <div class="pl-card"><h3>All holds</h3><div class="pr-scroll"><table class="pr-t" id="pr-table"></table></div></div>
      <div class="pl-card pr-export"><h3>Export</h3>
        <div class="pl-actions"><button class="pill accent" id="pr-csv">Export CSV</button><button class="pill" id="pr-photos">Export photos (zip)</button>
          <button class="pill" id="pr-json">Export JSON</button><button class="pill" id="pr-physics">Export physics (zip)</button><button class="pill" id="pr-valgus">Frontal squats CSV</button></div>
        <p class="pl-small">Files are made on this device. Each export carries the angle convention, the app commit and the model file hashes.</p>
        <button class="pill warn" id="pr-delete">Delete all pilot data</button>
      </div>
    </section>
  </main>
  <div class="pl-preview" id="pl-preview"><video id="pl-video" playsinline muted></video><canvas id="pl-overlay"></canvas>
    <p class="pl-nocam" id="pl-nocam">Camera off. Press Start camera.</p></div>`;
