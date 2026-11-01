import '../app.css';
import './live.css';
import * as THREE from 'three';
import { Stage } from '../stage';
import { loadTwin, COORDS } from './assets';
import { Body, SIDES, type Frame, type Side } from './body';
import { Physics } from './physics';
import { LiveScene, type Look } from './scene';
import { Coach, type Mode } from './coach';
import { Demo, type DemoMove } from './demo';
import { Tracker } from './pose';
import { Strip } from './strip';
import { LandmarkSmoother } from './filters';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], [15, 19], [16, 20], [0, 7], [0, 8]];

async function main() {
  const base = import.meta.env.BASE_URL;
  const twin = await loadTwin(base);
  const meta = twin.meta;
  const stage = new Stage($('stage'));
  stage.camera.near = 0.05; stage.camera.updateProjectionMatrix();
  stage.controls.minDistance = 0.8; stage.controls.maxDistance = 9; stage.controls.maxPolarAngle = Math.PI * 0.55;
  const scene = new LiveScene(stage, twin);
  const body = new Body(meta), phys = new Physics(meta), coach = new Coach(), demo = new Demo(meta), tracker = new Tracker();
  const smoother = new LandmarkSmoother();   // the demo goes through the same filtering as camera tracking
  // test hook: freeze the demo at a time (s) for inspection
  (window as unknown as { __live: unknown }).__live = { stage, body, phys, coach, demo, scene,
    seek: (t: number) => { playing = false; const sm = new LandmarkSmoother(); phys.reset();
      for (let x = Math.max(0, t - 1); x <= t; x += 1 / 30) { const f = sm.apply(demo.frame(x).frame); body.update(f); phys.update(body, x); }
      scene.update(body, phys, true); } };

  // ---------- settings ----------
  const num = (id: string, fallback: number) => { const v = Number($<HTMLInputElement>(id).value); return Number.isFinite(v) && v > 0 ? v : fallback; };
  const applySettings = () => { phys.setMass(num('in-mass', 70)); tracker.userHeight = num('in-height', 172) / 100; };
  try {
    const saved = JSON.parse(localStorage.getItem('kinema-live') ?? '{}');
    if (saved.mass) $<HTMLInputElement>('in-mass').value = saved.mass;
    if (saved.height) $<HTMLInputElement>('in-height').value = saved.height;
  } catch { /* storage blocked */ }
  applySettings();
  for (const id of ['in-mass', 'in-height']) $(id).addEventListener('change', () => {
    applySettings();
    try { localStorage.setItem('kinema-live', JSON.stringify({ mass: $<HTMLInputElement>('in-mass').value, height: $<HTMLInputElement>('in-height').value })); } catch { /* ignore */ }
  });

  // ---------- source: demo or camera ----------
  let source: 'demo' | 'camera' = 'demo';
  let demoT = 0, playing = true;
  const video = $<HTMLVideoElement>('video');
  const setStatus = (text: string, live = false) => { $('status-src').textContent = text; $('status-src').classList.toggle('live', live); };
  const calibrateDemo = () => {
    body.calibrated = false;
    for (let t = 0; t < 0.3; t += 1 / 30) body.addCalibrationSample(demo.frame(t).frame);
    body.finishCalibration(1.75);
    phys.reset();
  };
  const startDemo = (move: DemoMove) => {
    if (tracker.running) tracker.stop();
    source = 'demo'; demo.move = move; demoT = 0; playing = true;
    smoother.reset();
    calibrateDemo();
    document.body.classList.remove('camera-on');
    setStatus(`Demo · ${move === 'jump' ? 'jump landing' : move}`);
    const mode: Mode = move === 'jump' ? 'jump' : move === 'lunge' ? 'lunge' : 'squat';
    pickMode(mode);
    strips.forEach((s) => s.clear());
  };

  const startCamera = async () => {
    applySettings();
    try {
      setStatus('Starting camera');
      await tracker.init(base, (s) => setStatus(s));
      await tracker.start(video);
      source = 'camera'; playing = true;
      document.body.classList.add('camera-on');
      setStatus('Camera · live', true);
      body.calibrated = false; phys.reset();
      strips.forEach((s) => s.clear());
      runCalibration();
    } catch (e) {
      console.error(e);
      setStatus('Camera unavailable');
      toast(`Camera could not start: ${(e as Error).message ?? e}. Showing the demo instead.`);
      startDemo('squat');
    }
  };

  // ---------- calibration (camera) ----------
  let calibUntil = 0, calibFrom = 0;
  const runCalibration = () => {
    const now = performance.now() / 1000;
    calibFrom = now + 1.5; calibUntil = now + 3;
    $('calib').hidden = false;
  };

  // ---------- processing one frame ----------
  let lastImage: { x: number; y: number; v: number }[] | null = null, quality = 1;
  const fpsTimes: number[] = [];
  const process = (f: Frame) => {
    const now = performance.now() / 1000;
    if (source === 'camera' && calibUntil) {
      const left = calibUntil - now;
      $('calib-n').textContent = String(Math.max(1, Math.ceil(left)));
      if (now > calibFrom) body.addCalibrationSample(f);
      if (left <= 0) {
        body.finishCalibration(num('in-height', 172) / 100);
        if (lastImage) tracker.calibrateImage(lastImage);
        calibUntil = 0; $('calib').hidden = true; phys.reset();
        toast('Calibrated to your height. Move freely, or pick an exercise.');
      }
    }
    body.update(f);
    phys.update(body, f.t);
    coach.update(body, phys, f.t);
    record(f.t);
    fpsTimes.push(now); while (fpsTimes.length && now - fpsTimes[0] > 1) fpsTimes.shift();
    const A = body.angles, kg = phys.mass;
    strips[0].push(f.t, [A.R.knee_flex, A.L.knee_flex, A.R.hip_flex, A.L.hip_flex]);
    strips[1].push(f.t, [-phys.res.R.tau.knee_flex / kg, -phys.res.L.tau.knee_flex / kg, -phys.res.R.tau.hip_flex / kg, -phys.res.L.tau.hip_flex / kg]);
    strips[2].push(f.t, ['Quadriceps', 'Gluteals', 'Hamstrings', 'Calf'].map((g) => (groupEffort(g, 'R') + groupEffort(g, 'L')) / 2 * 100));
  };

  // ---------- recording ----------
  let recording: number[][] | null = null, recStart = 0;
  const header = ['t_s', ...SIDES.flatMap((s) => [...COORDS.map((c) => `${c}_${s}_deg`), `valgus_${s}_deg`]),
    ...SIDES.flatMap((s) => COORDS.map((c) => `moment_${c}_${s}_Nm`)), ...SIDES.map((s) => `grf_vertical_${s}_N`),
    'com_x_m', 'com_y_m', 'com_z_m', 'trunk_lean_deg', ...SIDES.flatMap((s) => meta.muscles.names.map((n) => `act_${n}_${s}`))];
  const record = (t: number) => {
    if (!recording) return;
    if (!recording.length) recStart = t;
    recording.push([t - recStart, ...SIDES.flatMap((s) => [...COORDS.map((c) => body.angles[s][c]), body.angles[s].valgus]),
      ...SIDES.flatMap((s) => COORDS.map((c) => phys.res[s].tau[c])), ...SIDES.map((s) => phys.res[s].grf.y),
      body.pts.com.x, body.pts.com.y, body.pts.com.z, body.trunkLean, ...SIDES.flatMap((s) => Array.from(phys.res[s].act))]);
    if (recording.length > 30 * 300) stopRec();
  };
  const stopRec = () => {
    $('btn-rec').classList.remove('on'); $('btn-rec').textContent = '● Record';
    $('btn-export').toggleAttribute('disabled', !(recording && recording.length));
  };
  $('btn-rec').onclick = () => {
    if ($('btn-rec').classList.contains('on')) { stopRec(); return; }
    recording = []; $('btn-rec').classList.add('on'); $('btn-rec').textContent = '■ Stop';
    $('btn-export').setAttribute('disabled', '');
  };
  $('btn-export').onclick = () => {
    if (!recording?.length) return;
    const csv = [header.join(','), ...recording.map((r) => r.map((x) => (Number.isInteger(x) ? x : x.toFixed(4))).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `kinema-live-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ---------- controls ----------
  const pickMode = (m: Mode) => {
    coach.setMode(m);
    $('mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('coach-title').textContent = { free: 'Free movement', squat: 'Squat', lunge: 'Lunge', single: 'Single-leg squat', jump: 'Jump landing' }[m];
  };
  segment('mode', (b) => pickMode(b.dataset.mode as Mode));
  segment('look', (b) => scene.setLook(b.dataset.look as Look));
  let showForces = true;
  $('btn-forces').onclick = () => { showForces = !showForces; $('btn-forces').setAttribute('aria-pressed', String(showForces)); };
  // the dock covers the bottom quarter of the screen: aim below the body's middle so the twin sits higher
  const VIEWS: Record<string, [number, number, number]> = { front: [0, 1.05, 4.2], side: [4.2, 1.0, 0.02], three: [2.75, 1.25, 3.0], orbit: [2.75, 1.25, 3.0] };
  const target = new THREE.Vector3(0, 0.68, 0);
  if (matchMedia('(max-width: 900px)').matches) {
    // phones: the coach card and dock cover the lower half, so frame closer and aim lower (twin sits higher)
    target.set(0, 0.42, 0);
    Object.assign(VIEWS, { front: [0, 0.9, 3.9], side: [3.9, 0.85, 0.02], three: [2.4, 1.0, 3.0], orbit: [2.4, 1.0, 3.0] });
  }
  const cam = { from: new THREE.Vector3(), to: new THREE.Vector3(), tf: new THREE.Vector3(), k: 1 };
  const goView = (v: string) => {
    stage.controls.autoRotate = v === 'orbit'; stage.controls.autoRotateSpeed = 0.8;
    cam.from.copy(stage.camera.position); cam.tf.copy(stage.controls.target); cam.to.set(...VIEWS[v]); cam.k = 0;
  };
  segment('view', (b) => goView(b.dataset.view!));
  stage.controls.addEventListener('start', () => { cam.k = 1; });
  $('btn-camera').onclick = () => { $<HTMLDialogElement>('onboard').close(); void startCamera(); };
  $('btn-demo').onclick = () => startDemo(demo.move);
  segment('demo-move', (b) => startDemo(b.dataset.move as DemoMove));
  $('btn-calib').onclick = () => { if (source === 'camera') runCalibration(); else calibrateDemo(); };
  $('ob-camera').onclick = () => { $<HTMLDialogElement>('onboard').close(); applySettings(); void startCamera(); };
  $('ob-demo').onclick = () => { $<HTMLDialogElement>('onboard').close(); applySettings(); };
  $('open-method').onclick = () => ($('method') as HTMLDialogElement).showModal();
  $('btn-mirror').onclick = () => { const on = !document.body.classList.contains('mirror'); document.body.classList.toggle('mirror', on); $('btn-mirror').setAttribute('aria-pressed', String(on)); };
  addEventListener('keydown', (e) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); playing = !playing; } });

  // ---------- readouts ----------
  const rows: { label: string; unit?: string; get: (s: Side) => number; fmt?: (v: number) => string }[] = [
    { label: 'Hip flexion', get: (s) => body.angles[s].hip_flex },
    { label: 'Knee flexion', get: (s) => body.angles[s].knee_flex },
    { label: 'Ankle dorsiflexion', get: (s) => body.angles[s].ankle_flex },
    { label: 'Knee valgus', unit: '+ inward', get: (s) => body.angles[s].valgus },
  ];
  const moments: typeof rows = [
    { label: 'Hip extension', get: (s) => -phys.res[s].tau.hip_flex / phys.mass, fmt: (v) => v.toFixed(2) },
    { label: 'Knee extension', get: (s) => -phys.res[s].tau.knee_flex / phys.mass, fmt: (v) => v.toFixed(2) },
    { label: 'Ankle plantarflexion', get: (s) => -phys.res[s].tau.ankle_flex / phys.mass, fmt: (v) => v.toFixed(2) },
    { label: 'Ground force', unit: 'body weights', get: (s) => phys.res[s].grf.y / phys.bodyWeight, fmt: (v) => v.toFixed(2) },
  ];
  const cells: [HTMLElement, HTMLElement, (typeof rows)[number]][] = [];
  const addRows = (title: string, list: typeof rows) => {
    $('rows').insertAdjacentHTML('beforeend', `<div class="group">${title}</div>`);
    for (const r of list) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<span>${r.label}${r.unit ? `<small>${r.unit}</small>` : ''}</span><b></b><b></b>`;
      $('rows').appendChild(row);
      cells.push([row.children[1] as HTMLElement, row.children[2] as HTMLElement, r]);
    }
  };
  addRows('Joint angles · degrees', rows);
  addRows('Joint moments · N·m/kg', moments);

  // muscle groups
  const idx = new Map(meta.muscles.names.map((n, i) => [n, i]));
  const groupEffort = (g: string, s: Side) => {
    let num = 0, den = 0;
    for (const n of meta.muscles.groups[g]) { const i = idx.get(n)!, f = meta.muscles.params[n].fmax; num += phys.res[s].act[i] * f; den += f; }
    return num / den;
  };
  const groups = Object.keys(meta.muscles.groups);
  $('groups').innerHTML = groups.map((g) => `<div class="grow"><span>${g}</span><i class="bar r"><b id="gR-${slug(g)}"></b></i><i class="bar l"><b id="gL-${slug(g)}"></b></i></div>`).join('');

  // ---------- charts ----------
  const css = getComputedStyle(document.documentElement);
  const H = css.getPropertyValue('--healthy').trim(), W = css.getPropertyValue('--weak').trim();
  const strips = [
    new Strip('Knee and hip flexion', 'degrees', [{ label: 'Knee R', color: W }, { label: 'Knee L', color: H }, { label: 'Hip R', color: W, dash: [4, 3] }, { label: 'Hip L', color: H, dash: [4, 3] }], [0, 100]),
    new Strip('Extension moments', 'N·m/kg', [{ label: 'Knee R', color: W }, { label: 'Knee L', color: H }, { label: 'Hip R', color: W, dash: [4, 3] }, { label: 'Hip L', color: H, dash: [4, 3] }], [-0.2, 1.5]),
    new Strip('Muscle effort', '% of capacity', [{ label: 'Quadriceps', color: '#e07a5f' }, { label: 'Gluteals', color: '#e9c46a' }, { label: 'Hamstrings', color: '#9fc3d4' }, { label: 'Calf', color: '#b5a8f0' }], [0, 30]),
  ];
  strips.forEach((s) => $('charts').appendChild(s.el));

  // ---------- hover a muscle ----------
  const tip = $('tip'), ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let hoverAt: PointerEvent | null = null;
  stage.renderer.domElement.addEventListener('pointermove', (e) => { hoverAt = e; });
  stage.renderer.domElement.addEventListener('pointerleave', () => { hoverAt = null; tip.hidden = true; });
  const hover = () => {
    if (!hoverAt || hoverAt.buttons || scene.look === 'bones') { tip.hidden = true; return; }
    const r = stage.renderer.domElement.getBoundingClientRect(), mirror = document.body.classList.contains('mirror');
    let x = ((hoverAt.clientX - r.left) / r.width) * 2 - 1;
    if (mirror) x = -x;
    ndc.set(x, -((hoverAt.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);
    const hit = ray.intersectObjects(scene.muscles.map((m) => m.mesh), false)[0];
    if (!hit) { tip.hidden = true; return; }
    const [name, s] = [hit.object.name.slice(0, -2), hit.object.name.slice(-1) as Side];
    const i = idx.get(name)!, p = meta.muscles.params[name];
    tip.innerHTML = `<b>${p.pretty} · ${s === 'R' ? 'right' : 'left'}</b><span>effort ${(phys.res[s].act[i] * 100).toFixed(0)}% · force ${phys.res[s].force[i].toFixed(0)} N<br>max ${(p.fmax * Math.pow(phys.mass / meta.model_mass, 2 / 3)).toFixed(0)} N</span>`;
    tip.style.left = `${hoverAt.clientX}px`; tip.style.top = `${hoverAt.clientY}px`; tip.hidden = false;
  };

  // ---------- frame loop ----------
  let uiTick = 0;
  const overlay = $<HTMLCanvasElement>('overlay');
  stage.onFrame((dt) => {
    if (playing) {
      if (source === 'demo') { demoT += dt; process(smoother.apply(demo.frame(demoT).frame)); }
      else {
        const tr = tracker.detect(video, performance.now());
        if (tr) { lastImage = tr.image; quality = tr.quality; process(tr.frame); drawOverlay(overlay, video, tr.image); }
      }
    }
    scene.update(body, phys, showForces);
    if (cam.k < 1) {
      cam.k = Math.min(1, cam.k + dt / 1.1);
      const e = cam.k < 0.5 ? 4 * cam.k ** 3 : 1 - (-2 * cam.k + 2) ** 3 / 2;
      stage.camera.position.lerpVectors(cam.from, cam.to, e); stage.controls.target.lerpVectors(cam.tf, target, e);
    }
    if ((uiTick = (uiTick + 1) % 4) === 0) ui();
  });

  const ui = () => {
    for (const [r, l, row] of cells) {
      const f = row.fmt ?? ((v: number) => `${v.toFixed(0)}°`);
      r.textContent = f(row.get('R')); l.textContent = f(row.get('L'));
    }
    $('trunk').textContent = `${body.trunkLean.toFixed(0)}°`;
    for (const g of groups) for (const s of SIDES) {
      const v = groupEffort(g, s);
      ($(`g${s}-${slug(g)}`)).style.width = `${Math.min(v / 0.5, 1) * 100}%`;
    }
    const top: { n: string; s: Side; a: number }[] = [];
    for (const s of SIDES) phys.res[s].act.forEach((a, i) => top.push({ n: meta.muscles.names[i], s, a }));
    top.sort((a, b) => b.a - a.a);
    $('top').innerHTML = top.slice(0, 5).map((m) => `<li><span>${meta.muscles.params[m.n].pretty}<small>${m.s === 'R' ? 'right' : 'left'}</small></span><i><b style="width:${Math.min(m.a / 0.6, 1) * 100}%"></b></i><em>${(m.a * 100).toFixed(0)}%</em></li>`).join('');
    // coach
    $('reps').textContent = String(coach.reps.length);
    $('phase').textContent = coach.phase;
    const last = coach.reps[coach.reps.length - 1];
    $('last').innerHTML = last ? `<span>depth <b>${last.depth.toFixed(0)}°</b></span><span>valgus <b>${Math.max(last.valgus, 0).toFixed(0)}°</b></span><span>${coach.mode === 'jump' ? 'asym' : 'uneven'} <b>${last.asym.toFixed(0)}%</b></span>` : '<span>No reps yet</span>';
    $('cues').innerHTML = coach.cues.map((c) => `<li class="${c.level}">${c.text}</li>`).join('') || `<li class="idle">${coach.mode === 'free' ? 'Move freely. Pick an exercise for rep scoring.' : 'Do a rep: it is scored when you return to standing.'}</li>`;
    // status
    const fps = fpsTimes.length;
    $('status-q').textContent = source === 'camera' ? `tracking ${(quality * 100).toFixed(0)}%` : 'synthetic motion';
    $('status-q').classList.toggle('warn', source === 'camera' && quality < 0.6);
    $('status-fps').textContent = `${fps} fps`;
    $('clock').textContent = recording && $('btn-rec').classList.contains('on') ? `● ${(recording.length / Math.max(fps, 1)).toFixed(0)} s` : recording?.length ? `${recording.length} frames ready` : '';
    for (const s of strips) s.draw();
    hover();
  };

  // ---------- self-check: the demo performer through the whole pipeline, against known truth ----------
  const selfTest = () => {
    const b = new Body(meta), ph = new Physics(meta), d = new Demo(meta, 'squat'), sm = new LandmarkSmoother();
    ph.setMass(70);
    for (let t = 0; t < 0.3; t += 1 / 30) b.addCalibrationSample(d.frame(t).frame);
    b.finishCalibration(1.75);
    // pass 1, geometry: unsmoothed landmarks, angle error against the prescribed angles
    const err = { knee: [] as number[], hip: [] as number[], ankle: [] as number[] };
    for (let t = 0.4; t < 6.8; t += 1 / 30) {
      const { frame, truth } = d.frame(t);
      b.update(frame);
      SIDES.forEach((s, i) => {
        err.knee.push(Math.abs(b.angles[s].knee_flex - truth.knee[i]));
        err.hip.push(Math.abs(b.angles[s].hip_flex - truth.hip[i]));
        err.ankle.push(Math.abs(b.angles[s].ankle_flex - truth.ankle[i]));
      });
    }
    // pass 2, real time: smoothed landmarks as in use; filter delay, ground force and moments
    const knee: number[] = [], truthKnee: number[] = [], stand: number[] = [], bottom: number[] = [];
    for (let t = 0; t < 6.8; t += 1 / 30) {
      const { frame, truth } = d.frame(t);
      b.update(sm.apply(frame)); ph.update(b, t);
      knee.push(b.angles.R.knee_flex); truthKnee.push(truth.knee[0]);
      if (t < 0.4) continue;
      const u = (t % 3.4) / 3.4;
      if (u < 0.1 || u > 0.93) stand.push((ph.res.R.grf.y + ph.res.L.grf.y) / ph.bodyWeight);
      if (u > 0.48 && u < 0.54) bottom.push(-(ph.res.R.tau.knee_flex + ph.res.L.tau.knee_flex) / 2 / ph.mass);
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    let lag = 0, best = Infinity;
    for (let k = 0; k <= 6; k++) {
      let e = 0;
      for (let i = 12 + k; i < knee.length; i++) e += Math.abs(knee[i] - truthKnee[i - k]);
      if (e < best) { best = e; lag = k; }
    }
    $('selftest').innerHTML = `<table><tr><th>Check (synthetic squat, known truth)</th><th>Result</th></tr>
      <tr><td>Knee flexion error, mean</td><td>${mean(err.knee).toFixed(1)}°</td></tr>
      <tr><td>Hip flexion error, mean</td><td>${mean(err.hip).toFixed(1)}°</td></tr>
      <tr><td>Ankle dorsiflexion error, mean</td><td>${mean(err.ankle).toFixed(1)}°</td></tr>
      <tr><td>Delay added by jitter smoothing</td><td>about ${Math.round((lag / 30) * 1000)} ms</td></tr>
      <tr><td>Ground force while standing (should be 1.00)</td><td>${mean(stand).toFixed(2)} body weights</td></tr>
      <tr><td>Knee extensor moment at the bottom</td><td>${mean(bottom).toFixed(2)} N·m/kg</td></tr></table>
      <p>Run in your browser when this page loaded, on a synthetic performer whose angles are known. The hip error is mostly the
      split of trunk lean between pelvis and spine, which one camera cannot see. Real tracking adds the camera's own error.</p>`;
  };

  // ---------- start ----------
  scene.warm(stage);
  try { selfTest(); } catch (e) { console.error(e); }
  scene.setLook('muscles');
  goView('three'); cam.k = 1; stage.camera.position.set(...VIEWS.three); stage.controls.target.copy(target);
  startDemo('squat');
  stage.settle();
  const veil = $('loading'); veil.classList.add('gone'); setTimeout(() => veil.remove(), 900);
  let seen = false;
  try { seen = sessionStorage.getItem('kinema-live-ob') === '1'; sessionStorage.setItem('kinema-live-ob', '1'); } catch { /* ignore */ }
  if (!seen) $<HTMLDialogElement>('onboard').showModal();
}

function drawOverlay(cv: HTMLCanvasElement, video: HTMLVideoElement, pts: { x: number; y: number; v: number }[]) {
  const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(devicePixelRatio, 2);
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  // the video is drawn with object-fit: cover; map normalised coordinates the same way
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9, s = Math.max(w / vw, h / vh), ox = (w - vw * s) / 2, oy = (h - vh * s) / 2;
  const P = (p: { x: number; y: number }) => [ox + p.x * vw * s, oy + p.y * vh * s];
  g.lineWidth = 2; g.strokeStyle = 'rgba(143,227,255,.85)';
  for (const [a, b] of BONES) {
    if (pts[a].v < 0.4 || pts[b].v < 0.4) continue;
    const [x1, y1] = P(pts[a]), [x2, y2] = P(pts[b]);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  g.fillStyle = '#ffe6a8';
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { if (pts[i].v < 0.4) continue; const [x, y] = P(pts[i]); g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
}

function toast(text: string) {
  const el = document.getElementById('toast')!;
  el.textContent = text; el.classList.add('on');
  clearTimeout((el as unknown as { _t: number })._t);
  (el as unknown as { _t: number })._t = window.setTimeout(() => el.classList.remove('on'), 4200);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '-');

function segment(id: string, onPick: (b: HTMLButtonElement) => void) {
  const root = document.getElementById(id)!;
  root.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    onPick(b);
  }));
}

main().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) l.innerHTML = `<span>Could not load: ${String(e.message ?? e)}</span>`;
});
