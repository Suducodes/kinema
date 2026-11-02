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
import { Tracker, type Facing } from './pose';
import { Strip } from './strip';
import { LandmarkSmoother } from './filters';
import { FX_DEFAULT, type FxFlags } from './fx';
import type { SegPose } from './body';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));
const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], [15, 19], [16, 20], [0, 7], [0, 8]];
const phone = matchMedia('(max-width: 760px)');

async function main() {
  const base = import.meta.env.BASE_URL;
  if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(`${base}sw.js`).catch(() => { /* offline use only */ });
  const twin = await loadTwin(base);
  const meta = twin.meta;
  const stage = new Stage($('stage'), $('stage-wrap'));
  stage.camera.near = 0.05; stage.camera.updateProjectionMatrix();
  stage.controls.minDistance = 0.8; stage.controls.maxDistance = 12; stage.controls.maxPolarAngle = Math.PI * 0.55;
  const scene = new LiveScene(stage, twin, $('arc-labels'));
  const body = new Body(meta), phys = new Physics(meta), coach = new Coach(), demo = new Demo(meta), tracker = new Tracker();
  const smoother = new LandmarkSmoother();   // the demo goes through the same filtering as camera tracking
  // test hook: freeze the demo at a time (s) for inspection
  (window as unknown as { __live: unknown }).__live = { stage, body, phys, coach, demo, scene, tracker,
    seek: (t: number) => { playing = false; const sm = new LandmarkSmoother(); phys.reset();
      for (let x = Math.max(0, t - 1); x <= t; x += 1 / 30) { const f = sm.apply(demo.frame(x).frame); body.update(f); phys.update(body, x); }
      scene.update(body, phys, true); } };

  // ---------- settings ----------
  const num = (id: string, fallback: number) => { const v = Number($<HTMLInputElement>(id).value); return Number.isFinite(v) && v > 0 ? v : fallback; };
  const applySettings = () => {
    phys.setMass(num('in-mass', 70));
    tracker.userHeight = num('in-height', 172) / 100;
    if (source === 'camera') body.setHeight(tracker.userHeight);
  };
  try {
    const saved = JSON.parse(localStorage.getItem('kinema-live') ?? '{}');
    if (saved.mass) $<HTMLInputElement>('in-mass').value = saved.mass;
    if (saved.height) $<HTMLInputElement>('in-height').value = saved.height;
  } catch { /* storage blocked */ }
  for (const id of ['in-mass', 'in-height']) $(id).addEventListener('change', () => {
    applySettings();
    try { localStorage.setItem('kinema-live', JSON.stringify({ mass: $<HTMLInputElement>('in-mass').value, height: $<HTMLInputElement>('in-height').value })); } catch { /* ignore */ }
  });

  // ---------- radio groups and actions (the same control can appear in the dock and the phone menu) ----------
  const mark = (attr: string, v: string) => $$(`button[data-${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(`data-${attr}`) === v)));
  const radios: Record<string, (v: string) => void> = {};
  const pressed = (act: string, on: boolean) => $$(`[data-act="${act}"]`).forEach((b) => b.setAttribute('aria-pressed', String(on)));
  const enable = (act: string, on: boolean) => $$(`[data-act="${act}"]`).forEach((b) => b.toggleAttribute('disabled', !on));
  const actions: Record<string, () => void> = {};
  document.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const a = el.closest<HTMLElement>('[data-act]');
    if (a && !a.hasAttribute('disabled')) {
      const inMenu = !!a.closest('#menu');
      actions[a.dataset.act!]?.();
      if (inMenu && ['profile', 'method', 'install', 'camera'].includes(a.dataset.act!)) $<HTMLDialogElement>('menu').close();
      return;
    }
    for (const attr of Object.keys(radios)) {
      const b = el.closest<HTMLButtonElement>(`button[data-${attr}]`);
      if (b) { const v = b.getAttribute(`data-${attr}`)!; mark(attr, v); radios[attr](v); return; }
    }
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
    phys.reset(); scene.snap();
  };
  const cameraButtons = (on: boolean) => $$('[data-act="camera"]').forEach((b) => {
    const label = b.querySelector('span') ?? b;
    if (b.closest('.cam-empty')) return;
    label.textContent = phone.matches ? (on ? 'Stop' : 'Camera') : on ? 'Stop camera' : 'Use my camera';
    b.classList.toggle('accent', !on);
  });
  const startDemo = (move: DemoMove) => {
    if (tracker.running) tracker.stop();
    source = 'demo'; demo.move = move; demoT = 0; playing = true;
    mark('move', move);
    smoother.reset();
    calibrateDemo();
    document.body.classList.remove('camera-on');
    cameraButtons(false);
    $$('[data-act="flip"]').forEach((b) => (b.hidden = true));
    hint('');
    endReplay(false);
    tracker.handsOn = false; setMirrorView(false);
    setStatus(`Demo · ${move === 'jump' ? 'jump landing' : move}`);
    pickMode(move === 'jump' ? 'jump' : move === 'lunge' ? 'lunge' : 'squat');
    strips.forEach((s) => s.clear());
  };

  const cameraReady = async () => {
    const front = tracker.facing === 'user';
    document.body.classList.toggle('front-cam', front);
    setMirror(front);   // the front camera is a mirror; the back camera shows the person as others see them
    $('cam-tag').textContent = front ? 'Front camera · stays on this device' : 'Back camera · stays on this device';
    const many = (await tracker.cameraCount()) > 1;
    $$('[data-act="flip"]').forEach((b) => (b.hidden = !many));
    scene.snap();
  };
  const startCamera = async (facing?: Facing) => {
    applySettings();
    try {
      setStatus('Starting camera');
      await tracker.init(base, (s) => setStatus(s));
      await tracker.start(video, facing);
      source = 'camera'; playing = true;
      body.setHeight(tracker.userHeight);
      document.body.classList.add('camera-on');
      cameraButtons(true);
      setStatus('Camera · live', true);
      await cameraReady();
      body.calibrated = false; phys.reset(); lastSeen = performance.now() / 1000;
      strips.forEach((s) => s.clear());
      runCalibration();
      applyFx();
    } catch (e) {
      console.error(e);
      setStatus('Camera unavailable');
      toast(`Camera could not start: ${(e as Error).message ?? e}. Showing the demo instead.`);
      startDemo('squat');
    }
  };
  actions.camera = () => {
    $<HTMLDialogElement>('onboard').close();
    if (source === 'camera') startDemo(demo.move); else void startCamera();
  };
  actions.flip = async () => {
    if (source !== 'camera') return;
    try {
      await tracker.start(video, tracker.facing === 'user' ? 'environment' : 'user');
      await cameraReady();
      phys.reset();
      toast(tracker.facing === 'user' ? 'Front camera' : 'Back camera: point it at the person, whole body in view');
    } catch (e) { toast(`Could not switch camera: ${(e as Error).message ?? e}`); }
  };

  // ---------- calibration (camera) ----------
  let calibUntil = 0, calibFrom = 0;
  const runCalibration = () => {
    const now = performance.now() / 1000;
    calibFrom = now + 1.5; calibUntil = now + 3;
    $('calib').hidden = false;
  };
  actions.calib = () => { if (source === 'camera') runCalibration(); else calibrateDemo(); };

  // ---------- processing one frame ----------
  let lastImage: { x: number; y: number; v: number }[] | null = null, quality = 1, feet = 1, lastSeen = 0;
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
        toast(feet < 0.5 ? 'Calibrated. Step back until your feet are in view for leg tracking.' : 'Calibrated to you. Move freely, or pick an exercise.');
      }
    }
    body.update(f);
    phys.update(body, f.t);
    coach.update(body, phys, f.t);
    record(f.t);
    snapshot(f.t);
    if (coach.reps.length !== repCount) {
      if (coach.reps.length > repCount && fx.bullet && !mirrorOn) startReplay();
      repCount = coach.reps.length;
    }
    fpsTimes.push(now); while (fpsTimes.length && now - fpsTimes[0] > 1) fpsTimes.shift();
    const A = body.angles, kg = phys.mass;
    strips[0].push(f.t, [A.R.knee_flex, A.L.knee_flex, A.R.hip_flex, A.L.hip_flex]);
    strips[1].push(f.t, [-phys.res.R.tau.knee_flex / kg, -phys.res.L.tau.knee_flex / kg, -phys.res.R.tau.hip_flex / kg, -phys.res.L.tau.hip_flex / kg]);
    strips[2].push(f.t, ['Quadriceps', 'Gluteals', 'Hamstrings', 'Calf'].map((g) => (groupEffort(g, 'R') + groupEffort(g, 'L')) / 2 * 100));
  };

  // ---------- framing hints ----------
  const hint = (text: string) => {
    for (const id of ['cam-hint', 'stage-hint']) { const el = $(id); el.hidden = !text; if (text) el.textContent = text; }
  };

  // ---------- recording ----------
  let recording: number[][] | null = null, recStart = 0, recOn = false;
  const header = ['t_s', ...SIDES.flatMap((s) => [...COORDS.map((c) => `${c}_${s}_deg`), `valgus_${s}_deg`]),
    ...SIDES.flatMap((s) => COORDS.map((c) => `moment_${c}_${s}_Nm`)), ...SIDES.map((s) => `grf_vertical_${s}_N`),
    'com_x_m', 'com_y_m', 'com_z_m', 'trunk_lean_deg', ...SIDES.flatMap((s) => meta.muscles.names.map((n) => `act_${n}_${s}`))];
  const record = (t: number) => {
    if (!recording || !recOn) return;
    if (!recording.length) recStart = t;
    recording.push([t - recStart, ...SIDES.flatMap((s) => [...COORDS.map((c) => body.angles[s][c]), body.angles[s].valgus]),
      ...SIDES.flatMap((s) => COORDS.map((c) => phys.res[s].tau[c])), ...SIDES.map((s) => phys.res[s].grf.y),
      body.pts.com.x, body.pts.com.y, body.pts.com.z, body.trunkLean, ...SIDES.flatMap((s) => Array.from(phys.res[s].act))]);
    if (recording.length > 30 * 300) stopRec();
  };
  const recButtons = () => $$('[data-act="rec"]').forEach((b) => {
    b.classList.toggle('on', recOn);
    const label = b.querySelector('span'); if (label) label.textContent = recOn ? 'Stop' : 'Record';
  });
  const stopRec = () => { recOn = false; recButtons(); enable('export', !!recording?.length); };
  actions.rec = () => {
    if (recOn) { stopRec(); return; }
    recording = []; recOn = true; recButtons(); enable('export', false);
  };
  actions.export = () => {
    if (!recording?.length) return;
    const csv = [header.join(','), ...recording.map((r) => r.map((x) => (Number.isInteger(x) ? x : x.toFixed(4))).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `motion-twin-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ---------- controls ----------
  const pickMode = (m: Mode) => {
    coach.setMode(m); mark('mode', m);
    $('coach-title').textContent = { free: 'Free movement', squat: 'Squat', lunge: 'Lunge', single: 'Single-leg squat', jump: 'Jump landing' }[m];
  };
  radios.mode = (v) => pickMode(v as Mode);
  radios.move = (v) => startDemo(v as DemoMove);
  radios.look = (v) => setLook(v as Look);
  const setLook = (l: Look) => {
    scene.setLook(l); mark('look', l);
    document.body.classList.remove('look-muscles', 'look-xray', 'look-bones'); document.body.classList.add(`look-${l}`);
  };
  let showForces = true;
  actions.forces = () => { showForces = !showForces; pressed('forces', showForces); };
  const setMirror = (on: boolean) => { document.body.classList.toggle('mirror', on); pressed('mirror', on); };
  actions.mirror = () => setMirror(!document.body.classList.contains('mirror'));
  actions.profile = () => $<HTMLDialogElement>('onboard').showModal();
  actions.method = () => $<HTMLDialogElement>('method').showModal();
  $('btn-menu').onclick = () => $<HTMLDialogElement>('menu').showModal();
  $('ob-camera').onclick = () => { $<HTMLDialogElement>('onboard').close(); applySettings(); if (source !== 'camera') void startCamera(); };
  $('ob-demo').onclick = () => { $<HTMLDialogElement>('onboard').close(); applySettings(); };

  // camera framing: the body's middle at the target, distance so a standing person fits the panel
  const DIRS: Record<string, [number, number, number]> = { front: [0, 0.1, 1], side: [1, 0.08, 0.004], three: [0.66, 0.22, 0.72], orbit: [0.66, 0.22, 0.72] };
  const target = new THREE.Vector3(0, 0.9, 0);
  let view = 'three', userMoved = false;
  const viewPos = (v: string) => {
    const tv = Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2));
    const d = Math.min(Math.max(1.15 / tv, 0.42 / (tv * stage.camera.aspect)), 11);
    return new THREE.Vector3(...DIRS[v]).normalize().multiplyScalar(d).add(target);
  };
  const cam = { from: new THREE.Vector3(), to: new THREE.Vector3(), tf: new THREE.Vector3(), k: 1 };
  const goView = (v: string, snap = false) => {
    view = v; userMoved = false; mark('view', v);
    stage.controls.autoRotate = v === 'orbit'; stage.controls.autoRotateSpeed = 0.8;
    cam.from.copy(stage.camera.position); cam.tf.copy(stage.controls.target); cam.to.copy(viewPos(v)); cam.k = 0;
    if (snap) { cam.k = 1; stage.camera.position.copy(cam.to); stage.controls.target.copy(target); }
  };
  radios.view = (v) => goView(v);
  stage.controls.addEventListener('start', () => { cam.k = 1; userMoved = true; });
  stage.onResize = () => { if (!userMoved) goView(view, true); };

  // skeleton only
  const setFocus = (on: boolean) => { document.body.classList.toggle('focus', on); $('data').classList.remove('open'); };
  $('btn-focus').onclick = () => setFocus(true);
  $('focus-exit').onclick = () => setFocus(false);
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') { e.preventDefault(); playing = !playing; }
    if (e.code === 'KeyF') setFocus(!document.body.classList.contains('focus'));
    if (e.code === 'Escape') setFocus(false);
  });

  // phone layouts and the bottom sheet
  const sheet = $('data');
  radios.pview = (v) => { document.body.dataset.pview = v; sheet.classList.remove('open'); };
  $('pip').addEventListener('click', (e) => {
    if (phone.matches && document.body.dataset.pview === 'twin' && !(e.target as HTMLElement).closest('button')) { mark('pview', 'camera'); radios.pview('camera'); }
  });
  $('stage-wrap').addEventListener('pointerup', () => {
    if (phone.matches && document.body.dataset.pview === 'camera') { mark('pview', 'twin'); radios.pview('twin'); }
  });
  const selectTab = (t: string) => {
    $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    $$('.pane').forEach((p) => p.classList.toggle('on', p.id === `tab-${t}`));
  };
  $('tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
    if (!b) return;
    const same = b.getAttribute('aria-selected') === 'true';
    selectTab(b.dataset.tab!);
    if (phone.matches) sheet.classList.toggle('open', !(same && sheet.classList.contains('open')));
  });
  for (const id of ['grab', 'peek']) $(id).addEventListener('click', () => sheet.classList.toggle('open'));
  $('work').addEventListener('pointerdown', (e) => { if (sheet.classList.contains('open') && !sheet.contains(e.target as Node)) sheet.classList.remove('open'); });
  const placeCoach = () => {
    // phones: the coach becomes the first tab of the sheet; desktops: it sits under the camera
    (phone.matches ? $('tab-coach') : $('cam-col')).appendChild($('coach'));
    if (phone.matches) selectTab('coach');
    else if ($('tab-coach').classList.contains('on')) selectTab('joints');
    sheet.classList.remove('open');
  };
  phone.addEventListener('change', placeCoach);
  placeCoach();

  // install as an app
  let deferred: (Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> }) | null = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone) $('menu-install').hidden = true;
  if (ios) $('install-how').textContent = 'In Safari: tap Share, then Add to Home Screen';
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as typeof deferred; $('btn-install').hidden = false; });
  addEventListener('appinstalled', () => { $('btn-install').hidden = true; $('menu-install').hidden = true; toast('Motion Twin is installed. Open it from your home screen or dock.'); });
  actions.install = async () => {
    if (deferred) { await deferred.prompt(); await deferred.userChoice; deferred = null; $('btn-install').hidden = true; return; }
    toast(ios ? 'In Safari: tap Share, then Add to Home Screen.' : 'Use the browser menu: Install app (or Add to Home screen).');
  };
  $('btn-install').onclick = () => actions.install();

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
  // shown values ease toward the live ones so digits do not flicker
  const cells: { el: [HTMLElement, HTMLElement]; row: (typeof rows)[number]; v: [number, number] }[] = [];
  const addRows = (title: string, list: typeof rows) => {
    $('rows').insertAdjacentHTML('beforeend', `<div class="group">${title}</div>`);
    for (const r of list) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<span>${r.label}${r.unit ? `<small>${r.unit}</small>` : ''}</span><b></b><b></b>`;
      $('rows').appendChild(row);
      cells.push({ el: [row.children[1] as HTMLElement, row.children[2] as HTMLElement], row: r, v: [NaN, NaN] });
    }
  };
  addRows('Joint angles · degrees', rows);
  addRows('Joint moments · N·m/kg', moments);
  addRows('Arm & hand · degrees', [
    { label: 'Elbow flexion', get: (s) => body.angles[s].elbow },
    { label: 'Forearm rotation', unit: '+ pronation, − supination', get: (s) => body.angles[s].pronation },
    { label: 'Wrist flexion', unit: '+ palmar', get: (s) => body.angles[s].wrist_flex },
    { label: 'Grip', unit: 'finger curl · hand tracking', get: (s) => body.angles[s].grip, fmt: (v) => (Number.isNaN(v) ? '–' : `${v.toFixed(0)}%`) },
  ]);
  const ease = (prev: number, next: number) => (Number.isNaN(prev) ? next : prev + (next - prev) * 0.45);

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
  stage.renderer.domElement.addEventListener('pointermove', (e) => { hoverAt = e.pointerType === 'mouse' ? e : null; });
  stage.renderer.domElement.addEventListener('pointerleave', () => { hoverAt = null; tip.hidden = true; });
  const hover = () => {
    if (!hoverAt || hoverAt.buttons || scene.look === 'bones') { tip.hidden = true; return; }
    const r = stage.renderer.domElement.getBoundingClientRect(), cl = document.body.classList;
    let x = ((hoverAt.clientX - r.left) / r.width) * 2 - 1;
    if (cl.contains('camera-on') && cl.contains('mirror')) x = -x;
    ndc.set(x, -((hoverAt.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);
    const hit = ray.intersectObjects(scene.muscles.map((m) => m.mesh), false)[0];
    if (!hit) { tip.hidden = true; return; }
    const [name, s] = [hit.object.name.slice(0, -2), hit.object.name.slice(-1) as Side];
    const i = idx.get(name)!, p = meta.muscles.params[name];
    tip.innerHTML = `<b>${p.pretty} · ${s === 'R' ? 'right' : 'left'}</b><span>effort ${(phys.res[s].act[i] * 100).toFixed(0)}% · force ${phys.res[s].force[i].toFixed(0)} N<br>max ${(p.fmax * Math.pow(phys.mass / meta.model_mass, 2 / 3)).toFixed(0)} N</span>`;
    tip.style.left = `${hoverAt.clientX}px`; tip.style.top = `${hoverAt.clientY}px`; tip.hidden = false;
  };

  // ---------- auto-framing: the camera panel follows the person inside the (cropped) video ----------
  const crop = { x: 0.5, y: 0.5 };
  const follow = (img: { x: number; y: number; v: number }[]) => {
    const seen = [0, 11, 12, 23, 24, 27, 28].filter((i) => img[i].v > 0.5);
    if (seen.length < 3) return;
    const xs = seen.map((i) => img[i].x), ys = seen.map((i) => img[i].y);
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    crop.x += (cx - crop.x) * 0.08; crop.y += (cy - crop.y) * 0.08;
  };
  const coverOffsets = (w: number, h: number) => {
    const vw = video.videoWidth || 4, vh = video.videoHeight || 3, s = Math.max(w / vw, h / vh);
    const fit = (box: number, size: number, c: number) => (box - size === 0 ? 0 : Math.min(Math.max(box / 2 - c * size, box - size), 0));
    return { s, vw, vh, ox: fit(w, vw * s, crop.x), oy: fit(h, vh * s, crop.y) };
  };
  const frameVideo = () => {
    const w = video.clientWidth, h = video.clientHeight;
    if (!w || !h) return;
    const { s, vw, vh, ox, oy } = coverOffsets(w, h);
    const px = w - vw * s ? (ox / (w - vw * s)) * 100 : 50, py = h - vh * s ? (oy / (h - vh * s)) * 100 : 50;
    video.style.objectPosition = `${px.toFixed(2)}% ${py.toFixed(2)}%`;
  };

  // ---------- visual layers (each its own switch in the Visuals panel; remembered on this device) ----------
  let fx: FxFlags = { ...FX_DEFAULT, hands: !phone.matches };
  try { fx = { ...fx, ...JSON.parse(localStorage.getItem('kinema-live-fx') ?? '{}') }; } catch { /* storage blocked */ }
  fx.mirror = false;   // the mirror needs the live camera, so every visit starts without it
  const fxInputs = $$<HTMLInputElement>('input[data-fx]');
  const applyFx = () => {
    fxInputs.forEach((i) => (i.checked = fx[i.dataset.fx as keyof FxFlags]));
    scene.setFlags(fx);
    tracker.handsOn = fx.hands && source === 'camera';
    if (tracker.handsOn) tracker.loadHands().catch((e) => { console.error(e); fx.hands = false; applyFx(); toast('The hand model could not load, so hand tracking is off.'); });
    setMirrorView(fx.mirror && source === 'camera');
    if (!fx.trails) scene.fx.clearTrails();
    try { localStorage.setItem('kinema-live-fx', JSON.stringify({ ...fx, mirror: false })); } catch { /* ignore */ }
  };
  fxInputs.forEach((i) => i.addEventListener('change', () => {
    const k = i.dataset.fx as keyof FxFlags;
    fx[k] = i.checked;
    if (i.checked && source !== 'camera' && k === 'mirror') toast('X-ray mirror lays the twin over your live video: start the camera to see it.');
    if (i.checked && source !== 'camera' && k === 'hands') toast('Fingers follow the camera; the demo performer keeps its hands at rest.');
    if (i.checked && k === 'bullet') toast('After each scored rep, it replays in slow motion. Pick an exercise in the coach.');
    applyFx();
  }));
  // phones: the panel is a sheet above the controls, so it lives at the top level (above both panes)
  const placeFx = () => (phone.matches ? document.body : $('stage-wrap')).appendChild($('fx-panel'));
  phone.addEventListener('change', placeFx); placeFx();
  const fxPanel = (open: boolean) => { $('fx-panel').hidden = !open; $('fx-btn').setAttribute('aria-expanded', String(open)); };
  $('fx-btn').onclick = () => fxPanel($('fx-panel').hidden);
  document.addEventListener('pointerdown', (e) => {
    if (!$('fx-panel').hidden && !(e.target as HTMLElement).closest('#fx-panel, #fx-btn')) fxPanel(false);
  });

  // angle labels follow their arcs on screen (flipped with the canvas when it is mirrored)
  const lp = new THREE.Vector3();
  const placeLabels = () => {
    const el = stage.renderer.domElement, w = el.clientWidth, h = el.clientHeight, cam3 = stage.override ?? stage.camera;
    const flipped = document.body.classList.contains('camera-on') && document.body.classList.contains('mirror');
    for (const a of scene.fx.labels) {
      lp.copy(a.at).project(cam3);
      const x = (lp.x * 0.5 + 0.5) * w, y = (-lp.y * 0.5 + 0.5) * h;
      a.label.style.transform = `translate(${(flipped ? w - x : x).toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      a.label.style.opacity = lp.z < 1 ? '1' : '0';
    }
  };

  // X-ray mirror: the twin drawn over the live video, fitted to the person every frame
  let mirrorOn = false, prevLook: Look = 'muscles';
  const fit = { k: 0, cx: 0, cy: 0 };
  const setMirrorView = (on: boolean) => {
    if (on === mirrorOn) return;
    mirrorOn = on;
    document.body.classList.toggle('mirror-on', on);
    scene.setMirror(on ? video : null);
    fit.k = 0;
    if (on) { prevLook = scene.look; setLook('xray'); } else { setLook(prevLook); goView(view, true); }
  };
  const MIRROR_PAIRS: [number, string][] = [[12, 'shoulder_R'], [11, 'shoulder_L'], [14, 'elbow_R'], [13, 'elbow_L'], [16, 'wrist_R'], [15, 'wrist_L'],
    [24, 'hip_R'], [23, 'hip_L'], [26, 'knee_R'], [25, 'knee_L'], [28, 'ankle_R'], [27, 'ankle_L']];
  /** Least squares for image pixel = (cx + k X, cy - k Y) over the joints seen well. */
  const fitMirror = (img: { x: number; y: number; v: number }[]) => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const P = MIRROR_PAIRS.filter(([i, k]) => img[i].v > 0.6 && body.pts[k]).map(([i, k]) => [img[i].x * vw, img[i].y * vh, body.pts[k].x, body.pts[k].y]);
    if (P.length < 4) return;
    const m = [0, 1, 2, 3].map((c) => P.reduce((a, r) => a + r[c], 0) / P.length);
    let num = 0, den = 0;
    for (const [px, py, X, Y] of P) { num += (px - m[0]) * (X - m[2]) - (py - m[1]) * (Y - m[3]); den += (X - m[2]) ** 2 + (Y - m[3]) ** 2; }
    const k = num / (den || 1);
    if (!(k > 0)) return;
    const a = fit.k ? 0.25 : 1;
    fit.k += (k - fit.k) * a; fit.cx += (m[0] - k * m[2] - fit.cx) * a; fit.cy += (m[1] + k * m[3] - fit.cy) * a;
  };

  // bullet-time: the last seconds are kept as snapshots; after a scored rep, they replay in slow motion
  // while the camera orbits (tracking keeps running underneath)
  type Snap = { t: number; seg: Float32Array; act: Record<Side, Float32Array>; force: Record<Side, Float32Array>; grf: Record<Side, THREE.Vector3>; cop: Record<Side, THREE.Vector3>; com: THREE.Vector3 };
  const segKeys = Object.keys(body.seg), snaps: Snap[] = [];
  let repCount = 0;
  const snapshot = (t: number) => {
    const seg = new Float32Array(segKeys.length * 8);
    segKeys.forEach((k, i) => { const p = body.seg[k]; seg.set([p.pos.x, p.pos.y, p.pos.z, p.quat.x, p.quat.y, p.quat.z, p.quat.w, p.scale], i * 8); });
    const per = <T>(f: (s: Side) => T) => ({ R: f('R'), L: f('L') });
    snaps.push({ t, seg, act: per((s) => phys.res[s].act.slice()), force: per((s) => phys.res[s].force.slice()),
      grf: per((s) => phys.res[s].grf.clone()), cop: per((s) => phys.res[s].cop.clone()), com: body.pts.com.clone() });
    while (snaps.length && t - snaps[0].t > 5) snaps.shift();
  };
  const ghost = { seg: {} as Record<string, SegPose>, pts: { com: new THREE.Vector3() } as Record<string, THREE.Vector3>, contact: { R: true, L: true } as Record<Side, boolean>, ref: body.ref };
  const ghostPhys = { res: { R: { act: new Float32Array(), force: new Float32Array(), grf: new THREE.Vector3(), cop: new THREE.Vector3() },
    L: { act: new Float32Array(), force: new Float32Array(), grf: new THREE.Vector3(), cop: new THREE.Vector3() } }, bodyWeight: phys.bodyWeight };
  let replay: { frames: Snap[]; t: number; span: number; az0: number; r: number; h: number } | null = null;
  const SLOW = 0.32;
  const startReplay = () => {
    const rep = coach.reps[coach.reps.length - 1];
    const span = THREE.MathUtils.clamp((rep.down || 0) + (rep.up || 0) + 0.7, 1.4, 4.2);
    const tEnd = snaps[snaps.length - 1]?.t ?? 0, frames = snaps.filter((x) => x.t >= tEnd - span);
    if (frames.length < 10) return;
    const off = stage.camera.position.clone().sub(stage.controls.target);
    replay = { frames, t: 0, span: frames[frames.length - 1].t - frames[0].t, az0: Math.atan2(off.x, off.z), r: Math.hypot(off.x, off.z), h: off.y };
    stage.controls.enabled = false; stage.controls.autoRotate = false;
    $('replay').hidden = false;
    $('replay-text').textContent = `Rep ${rep.n} · depth ${rep.depth.toFixed(0)}° · ${SLOW}× speed`;
  };
  const endReplay = (restore = true) => {
    if (!replay) return;
    replay = null; $('replay').hidden = true;
    stage.controls.enabled = !mirrorOn;
    if (restore) goView(view);
  };
  $('replay-skip').onclick = () => endReplay();
  const playReplay = (dt: number) => {
    const R = replay!;
    R.t += dt * SLOW;
    if (R.t >= R.span) { endReplay(); scene.update(body, phys, showForces, dt); return; }
    const t0 = R.frames[0].t + R.t;
    const f = R.frames.find((x) => x.t >= t0) ?? R.frames[R.frames.length - 1];
    segKeys.forEach((k, i) => {
      const d = (ghost.seg[k] ??= { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 }), a = f.seg;
      d.pos.set(a[i * 8], a[i * 8 + 1], a[i * 8 + 2]); d.quat.set(a[i * 8 + 3], a[i * 8 + 4], a[i * 8 + 5], a[i * 8 + 6]); d.scale = a[i * 8 + 7];
    });
    ghost.pts.com.copy(f.com);
    for (const s of SIDES) Object.assign(ghostPhys.res[s], { act: f.act[s], force: f.force[s], grf: f.grf[s], cop: f.cop[s] });
    ghostPhys.bodyWeight = phys.bodyWeight;
    scene.update(ghost, ghostPhys, showForces, dt);
    // orbit: ease out of the current angle, a little over a quarter turn
    const u = R.t / R.span, e = u * u * (3 - 2 * u), az = R.az0 + 1.9 * e;
    stage.camera.position.set(stage.controls.target.x + R.r * Math.sin(az), stage.controls.target.y + R.h, stage.controls.target.z + R.r * Math.cos(az));
    stage.camera.lookAt(stage.controls.target);
  };

  // ---------- frame loop ----------
  let uiTick = 0;
  const overlay = $<HTMLCanvasElement>('overlay');
  stage.onFrame((dt) => {
    if (playing) {
      if (source === 'demo') { demoT += dt; process(smoother.apply(demo.frame(demoT).frame)); }
      else {
        const now = performance.now();
        const tr = tracker.detect(video, now);
        if (tr) {
          lastImage = tr.image; quality = tr.quality; feet = tr.feet; lastSeen = now / 1000;
          process(tr.frame); follow(tr.image); frameVideo();
          if (mirrorOn) fitMirror(tr.image);
          drawOverlay(overlay, tr.image, coverOffsets(overlay.clientWidth, overlay.clientHeight), tr.handImage);
        } else if (tr === null) overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
      }
    }
    if (replay) playReplay(dt); else scene.update(body, phys, showForces, dt);
    if (mirrorOn && fit.k) {
      const el = stage.renderer.domElement;
      scene.fitMirror(fit, video.videoWidth, video.videoHeight, el.clientWidth / Math.max(el.clientHeight, 1), body.pts.com.x);
    }
    if (fx.arcs) placeLabels();
    if (cam.k < 1 && !replay) {
      cam.k = Math.min(1, cam.k + dt / 1.1);
      const e = cam.k < 0.5 ? 4 * cam.k ** 3 : 1 - (-2 * cam.k + 2) ** 3 / 2;
      stage.camera.position.lerpVectors(cam.from, cam.to, e); stage.controls.target.lerpVectors(cam.tf, target, e);
    }
    if ((uiTick = (uiTick + 1) % 4) === 0) ui();
  });

  const ui = () => {
    for (const c of cells) {
      const f = c.row.fmt ?? ((v: number) => `${v.toFixed(0)}°`);
      c.v[0] = ease(c.v[0], c.row.get('R')); c.v[1] = ease(c.v[1], c.row.get('L'));
      c.el[0].textContent = f(c.v[0]); c.el[1].textContent = f(c.v[1]);
    }
    $('trunk').textContent = `${body.trunkLean.toFixed(0)}°`;
    for (const g of groups) for (const s of SIDES) {
      const v = groupEffort(g, s);
      ($(`g${s}-${slug(g)}`)).style.width = `${Math.min(v / 0.5, 1) * 100}%`;
    }
    const top: { n: string; s: Side; a: number }[] = [];
    for (const s of SIDES) phys.res[s].act.forEach((a, i) => top.push({ n: meta.muscles.names[i], s, a }));
    top.sort((a, b) => b.a - a.a);
    $('top').innerHTML = top.slice(0, 6).map((m) => `<li><span>${meta.muscles.params[m.n].pretty}<small>${m.s === 'R' ? 'right' : 'left'}</small></span><i><b style="width:${Math.min(m.a / 0.6, 1) * 100}%"></b></i><em>${(m.a * 100).toFixed(0)}%</em></li>`).join('');
    // coach
    $('reps').textContent = String(coach.reps.length);
    $('phase').textContent = coach.phase;
    const last = coach.reps[coach.reps.length - 1];
    $('last').innerHTML = last ? `<span>depth <b>${last.depth.toFixed(0)}°</b></span><span>valgus <b>${Math.max(last.valgus, 0).toFixed(0)}°</b></span><span>${coach.mode === 'jump' ? 'asym' : 'uneven'} <b>${last.asym.toFixed(0)}%</b></span>` : '<span>No reps yet</span>';
    $('cues').innerHTML = coach.cues.map((c) => `<li class="${c.level}">${c.text}</li>`).join('') || `<li class="idle">${coach.mode === 'free' ? 'Move freely. Pick an exercise for rep scoring.' : 'Do a rep: it is scored when you return to standing.'}</li>`;
    // phone peek line
    const kn = cells[1].v;
    $('peek').innerHTML = `<span>${$('coach-title').textContent} <b>${coach.reps.length}</b> reps</span><span>Knee R <b>${kn[0].toFixed(0)}°</b> L <b>${kn[1].toFixed(0)}°</b></span><span>Load R <b>${(phys.res.R.grf.y / phys.bodyWeight).toFixed(2)}</b> L <b>${(phys.res.L.grf.y / phys.bodyWeight).toFixed(2)}</b></span>`;
    // status and framing hints
    const fps = fpsTimes.length, cameraLive = source === 'camera';
    $('status-q').textContent = cameraLive ? `tracking ${(quality * 100).toFixed(0)}%` : 'synthetic motion';
    $('status-q').classList.toggle('warn', cameraLive && quality < 0.6);
    $('status-fps').textContent = `${fps} fps`;
    if (cameraLive) {
      const gone = performance.now() / 1000 - lastSeen > 0.8;
      hint(gone ? 'Step into view: whole body, 2 to 3 m from the camera' : feet < 0.45 ? 'Step back until your feet are in view' : '');
    }
    $('clock').textContent = recOn ? `● ${(recording!.length / Math.max(fps, 1)).toFixed(0)} s` : recording?.length ? `${recording.length} frames` : '';
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
  setLook('muscles');
  applyFx();
  goView('three', true);
  startDemo('squat');
  applySettings();
  stage.settle();
  const veil = $('loading'); veil.classList.add('gone'); setTimeout(() => veil.remove(), 900);
  let seen = false;
  try { seen = sessionStorage.getItem('kinema-live-ob') === '1'; sessionStorage.setItem('kinema-live-ob', '1'); } catch { /* ignore */ }
  if (!seen && !standalone) $<HTMLDialogElement>('onboard').showModal();
}

const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

function drawOverlay(cv: HTMLCanvasElement, pts: { x: number; y: number; v: number }[], o: { s: number; vw: number; vh: number; ox: number; oy: number },
  hands: Partial<Record<Side, { x: number; y: number }[]>> = {}) {
  const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(devicePixelRatio, 2);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  // the video is drawn with object-fit: cover at the follow offset; map normalised coordinates the same way
  const P = (p: { x: number; y: number }) => [o.ox + p.x * o.vw * o.s, o.oy + p.y * o.vh * o.s];
  g.lineWidth = 2.2; g.lineCap = 'round'; g.strokeStyle = 'rgba(143,227,255,.85)';
  for (const [a, b] of BONES) {
    if (pts[a].v < 0.4 || pts[b].v < 0.4) continue;
    const [x1, y1] = P(pts[a]), [x2, y2] = P(pts[b]);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  g.fillStyle = '#ffe6a8';
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { if (pts[i].v < 0.4) continue; const [x, y] = P(pts[i]); g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill(); }
  g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,214,150,.9)';
  for (const h of Object.values(hands)) {
    if (!h) continue;
    for (const [a, b] of HAND_BONES) { const [x1, y1] = P(h[a]), [x2, y2] = P(h[b]); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
  }
}

function toast(text: string) {
  const el = document.getElementById('toast')!;
  el.textContent = text; el.classList.add('on');
  clearTimeout((el as unknown as { _t: number })._t);
  (el as unknown as { _t: number })._t = window.setTimeout(() => el.classList.remove('on'), 4200);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '-');

main().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) l.innerHTML = `<span>Could not load: ${String(e.message ?? e)}</span>`;
});
