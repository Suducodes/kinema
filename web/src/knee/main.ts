import '../app.css';
import './knee.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Stage } from '../stage';
import { softboxEnvironment, sky } from '../studio';
import { KneeRig, structureOf } from './rig';
import { loadKneeClip, type KneeClip, type KneeMeta } from './data';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GAP = 0.085;   // the two knees sit side by side along the femur's z axis (healthy left on screen)

const STRUCTS: { key: string; name: string; job: string; injured: 'torn' | 'stretched' | 'intact' }[] = [
  { key: 'ACL', name: 'ACL', job: 'stops the shin sliding forward', injured: 'torn' },
  { key: 'PCL', name: 'PCL', job: 'stops the shin sliding back', injured: 'torn' },
  { key: 'LCL', name: 'LCL', job: 'keeps the outer side closed', injured: 'torn' },
  { key: 'MCL', name: 'MCL', job: 'keeps the inner side closed', injured: 'stretched' },
  { key: 'POL', name: 'Posterior oblique', job: 'back-inner corner', injured: 'intact' },
  { key: 'CAP', name: 'Posterior capsule', job: "the joint's back wall", injured: 'intact' },
  { key: 'PFL', name: 'Popliteofibular', job: 'back-outer corner', injured: 'intact' },
  { key: 'ITB', name: 'Iliotibial band', job: 'outer thigh band', injured: 'intact' },
  { key: 'PT', name: 'Patellar tendon', job: 'kneecap to shin', injured: 'intact' },
];
const PHASES = [[0, 0.5, 'settle'], [0.5, 1.5, 'bend'], [1.5, 2, 'hold'], [2, 3, 'load']] as const;

async function main() {
  const base = import.meta.env.BASE_URL;
  const [meta, gltf] = await Promise.all([
    fetch(`${base}knee/knee.json`).then((r) => r.json() as Promise<KneeMeta>),
    new GLTFLoader().loadAsync(`${base}knee/knee.glb`),
  ]);
  const meshes = new Map<string, THREE.BufferGeometry>();
  // Blender's STL importer treated the y-up files as z-up, so the GLB is a quarter turn about x off the
  // OpenSim body frames (checked against the raw STL bounds); turn it back once here.
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.set(o.name, (o as THREE.Mesh).geometry.clone().rotateX(Math.PI / 2)); });

  const stage = new Stage($('stage'));
  stage.scene.environment = softboxEnvironment(stage.renderer);
  stage.scene.background = new THREE.Color(0.030, 0.035, 0.039);
  const dome = sky(); dome.scale.setScalar(0.02); stage.scene.add(dome);
  stage.camera.near = 0.005; stage.camera.far = 10; stage.camera.updateProjectionMatrix();
  stage.controls.minDistance = 0.12; stage.controls.maxDistance = 1.4;
  stage.controls.maxPolarAngle = Math.PI;

  const healthy = new KneeRig(meta, meshes, false), injured = new KneeRig(meta, meshes, true);
  healthy.group.position.z = GAP; injured.group.position.z = -GAP;
  stage.scene.add(healthy.group, injured.group);
  const rigs = [healthy, injured];

  // ---------- runs ----------
  const cache = new Map<string, Promise<KneeClip>>();
  const clip = (n: string) => { if (!cache.has(n)) cache.set(n, loadKneeClip(meta, n)); return cache.get(n)!; };
  let test = 'lachman', cH = await clip('lachman_healthy'), cI = await clip('lachman_injured');
  // References. Chart: everything against the healthy knee at rest (just before the load, or straight
  // for the bending run), so the injured knee's resting displacement shows. Readouts: each knee against
  // itself when the load starts, i.e. what the examiner's hand feels.
  interface Ref { pos: THREE.Vector3; add: number; rot: number }
  const LOAD_T = 2.0;
  let refChart: Ref, refH: Ref, refI: Ref;
  const refOf = (c: KneeClip, time: number): Ref => {
    const k = Math.round(time * meta.fps), f = c.data.subarray(k * c.stride, (k + 1) * c.stride);
    return { pos: new THREE.Vector3(f[c.oTib], f[c.oTib + 1], f[c.oTib + 2]), add: f[c.oRead + 3], rot: f[c.oRead + 4] };
  };

  // ---------- playback (3 s run + 1 s hold at full load, looped) ----------
  let t = 0, playing = true, speed = 1;
  const HOLD = 1;
  const playBtn = $('play');
  const setPlaying = (p: boolean) => { playing = p; playBtn.textContent = p ? '❚❚' : '▶'; };
  playBtn.onclick = () => setPlaying(!playing);
  segment('speed', (b) => { speed = Number(b.dataset.speed); });
  const tl = $('timeline');
  const scrub = (e: PointerEvent) => { const r = tl.getBoundingClientRect(); t = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * cH.duration; };
  tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); setPlaying(false); scrub(e); });
  tl.addEventListener('pointermove', (e) => { if (e.buttons) scrub(e); });

  // ---------- readouts (tibia measured along its own axes, against the healthy knee at rest) ----------
  const rows = [
    { key: 'slide', label: 'Shin slide', unit: 'mm', hint: '+ forward' },
    { key: 'side', label: 'Side shift', unit: 'mm', hint: '+ outward' },
    { key: 'open', label: 'Opening', unit: '°', hint: '+ outer side' },
    { key: 'twist', label: 'Twist', unit: '°', hint: '+ inward' },
    { key: 'bend', label: 'Knee bend', unit: '°', hint: '' },
  ] as const;
  $('rows').innerHTML = rows.map((r) => `<div class="row"><span>${r.label}<small>${r.hint}</small></span><b id="h-${r.key}"></b><b id="i-${r.key}"></b></div>`).join('');
  const tibPos = new THREE.Vector3(), q = new THREE.Quaternion(), ax = new THREE.Vector3(), d = new THREE.Vector3();
  /** Tibia displacement measured along the tibia's own axes (so "forward" means the same at any bend). */
  const measure = (c: KneeClip, f: Float32Array, ref: Ref) => {
    tibPos.set(f[c.oTib], f[c.oTib + 1], f[c.oTib + 2]);
    q.set(f[c.oTib + 3], f[c.oTib + 4], f[c.oTib + 5], f[c.oTib + 6]);
    d.copy(tibPos).sub(ref.pos);
    return {
      slide: d.dot(ax.set(1, 0, 0).applyQuaternion(q)) * 1000,
      side: d.dot(ax.set(0, 0, 1).applyQuaternion(q)) * 1000,
      open: f[c.oRead + 3] - ref.add,
      twist: f[c.oRead + 4] - ref.rot,
      bend: f[c.oRead + 5],
      load: f[c.oLoad],
    };
  };

  // ---------- legend: structures, status, live force ----------
  $('legend-rows').innerHTML = STRUCTS.map((s) => `<div class="lrow" data-key="${s.key}" title="${s.name}: ${s.job}">
      <span class="nm"><b>${s.name}</b></span>
      <i class="st ok">intact</i><i class="st ${s.injured}">${s.injured}</i>
      <span class="fh" id="fh-${s.key}">–</span><span class="fi" id="fi-${s.key}">–</span></div>`).join('');
  const bundlesOf = new Map<string, number[]>();
  meta.bundles.forEach((b, i) => { const k = structureOf(b); bundlesOf.set(k, [...(bundlesOf.get(k) ?? []), i]); });
  const tornSet = new Set(meta.torn);
  document.querySelectorAll<HTMLElement>('.lrow').forEach((row) => {
    row.addEventListener('pointerenter', () => { rigs.forEach((r) => (r.focus = row.dataset.key!)); row.classList.add('on'); });
    row.addEventListener('pointerleave', () => { rigs.forEach((r) => (r.focus = null)); row.classList.remove('on'); });
  });

  // ---------- chart: the test's key measure through the run ----------
  const cv = $<HTMLCanvasElement>('chart');
  let series: { h: Float32Array; i: Float32Array; key: string; label: string } = { h: new Float32Array(), i: new Float32Array(), key: 'slide', label: '' };
  const keyOf = (name: string) => (name === 'varus' || name === 'valgus' ? 'open' : 'slide');
  const buildSeries = () => {
    const key = keyOf(test), n = cH.frames;
    const h = new Float32Array(n), i = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const fh = cH.data.subarray(k * cH.stride, (k + 1) * cH.stride), fi = cI.data.subarray(k * cI.stride, (k + 1) * cI.stride);
      h[k] = measure(cH, fh, refChart)[key]; i[k] = measure(cI, fi, refChart)[key];
    }
    series = { h, i, key, label: `${key === 'open' ? 'Opening of the joint (°)' : 'Shin slide (mm)'} · against the healthy knee at rest` };
    $('chart-title').textContent = series.label;
  };
  const drawChart = () => {
    const dpr = Math.min(devicePixelRatio, 2), w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const pad = { l: 34, r: 8, t: 8, b: 16 }, all = [...series.h, ...series.i];
    let lo = Math.min(0, ...all), hi = Math.max(1, ...all);
    const p = (hi - lo) * 0.1; lo -= p; hi += p;
    const X = (k: number) => pad.l + (k / (series.h.length - 1)) * (w - pad.l - pad.r), Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
    g.font = '10px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(214,222,226,.42)'; g.strokeStyle = 'rgba(214,222,226,.08)';
    for (const [a, b, name] of PHASES) {
      if (test === 'flexion' && name !== 'settle') continue;
      const xa = X((a / cH.duration) * (series.h.length - 1)), xb = X((b / cH.duration) * (series.h.length - 1));
      g.fillStyle = name === 'load' ? 'rgba(159,226,255,.06)' : 'rgba(255,255,255,.015)'; g.fillRect(xa, pad.t, xb - xa, h - pad.t - pad.b);
      g.fillStyle = 'rgba(214,222,226,.42)'; g.textAlign = 'center'; g.fillText(name, (xa + xb) / 2, h - 4);
    }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    const step = niceStep(hi - lo);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) { g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(w - pad.r, Y(v)); g.stroke(); g.fillText(v.toFixed(0), pad.l - 5, Y(v)); }
    const css = getComputedStyle(document.documentElement);
    for (const [arr, col] of [[series.h, css.getPropertyValue('--healthy')], [series.i, css.getPropertyValue('--weak')]] as const) {
      g.beginPath(); arr.forEach((v, k) => (k ? g.lineTo : g.moveTo).call(g, X(k), Y(v)));
      g.strokeStyle = col.trim(); g.lineWidth = 1.8; g.stroke();
    }
    const xc = X((Math.min(t, cH.duration) / cH.duration) * (series.h.length - 1));
    g.beginPath(); g.moveTo(xc, pad.t); g.lineTo(xc, h - pad.b); g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1; g.stroke();
  };
  new ResizeObserver(drawChart).observe(cv);

  // ---------- test switching ----------
  const setTest = async (name: string) => {
    test = name;
    [cH, cI] = await Promise.all([clip(`${name}_healthy`), clip(`${name}_injured`)]);
    const loaded = name !== 'flexion';
    refChart = refOf(cH, loaded ? LOAD_T : 0);
    refH = refOf(cH, loaded ? LOAD_T : 0); refI = refOf(cI, loaded ? LOAD_T : 0);
    if (!loaded) refI = refH;   // bending: both against the healthy knee standing straight
    const info = meta.tests[name];
    // how far out of place the injured knee already sits before anyone pushes
    const k = Math.round(LOAD_T * meta.fps);
    const rest = measure(cI, cI.data.subarray(k * cI.stride, (k + 1) * cI.stride), refChart);
    const restKey = name === 'varus' || name === 'valgus' ? 'open' : 'slide';
    const rv = rest[restKey], restTxt = restKey === 'open'
      ? `${Math.abs(rv).toFixed(1)}° bent ${rv >= 0 ? 'outward (varus)' : 'inward (valgus)'}`
      : `${Math.abs(rv).toFixed(1)} mm ${rv >= 0 ? 'forward' : 'back'}`;
    $('test-what').textContent = info.what;
    $('test-rest').textContent = loaded ? `Before the push, the injured shin already sits ${restTxt} of the healthy one. Numbers below: movement once the load starts.`
      : 'Numbers below: drift from the healthy knee standing straight.';
    $('test-checks').textContent = info.checks === 'all' ? 'every ligament in turn' : `the ${info.checks}`;
    $('phases').innerHTML = (name === 'flexion' ? [[0, 0.5, 'settle'], [0.5, 3, 'bend 0→90°']] as const : PHASES)
      .map(([a, b, n]) => `<i style="left:${(a / 3) * 100}%;width:${((b - a) / 3) * 100}%">${n}</i>`).join('');
    buildSeries();
    t = 0; setPlaying(true);
    applyView();
  };
  segment('test', (b) => { void setTest(b.dataset.test!); });

  // ---------- views ----------
  const VIEWS: Record<string, [number, number, number]> = {
    front: [0.62, 0.0, 0], three: [0.44, 0.10, 0.40], back: [-0.62, 0.03, 0], below: [0.40, -0.30, 0.30],
  };
  let view = 'three';
  const cam = { from: new THREE.Vector3(), to: new THREE.Vector3(), tf: new THREE.Vector3(), tt: new THREE.Vector3(), k: 1 };
  const target = new THREE.Vector3(0, -0.025, 0);
  const applyView = () => {
    cam.from.copy(stage.camera.position); cam.tf.copy(stage.controls.target);
    cam.to.set(...VIEWS[view]); cam.tt.copy(target); cam.k = 0;
  };
  segment('view', (b) => { view = b.dataset.view!; applyView(); });
  stage.controls.addEventListener('start', () => { cam.k = 1; });
  segment('bone', (b) => rigs.forEach((r) => r.setGlass(b.dataset.bone === 'glass')));
  rigs.forEach((r) => r.setGlass(true));

  // ---------- hover a ligament ----------
  const tip = $('tip'), ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let hoverAt: PointerEvent | null = null;
  stage.renderer.domElement.addEventListener('pointermove', (e) => { hoverAt = e; });
  stage.renderer.domElement.addEventListener('pointerleave', () => { hoverAt = null; tip.hidden = true; });
  const hover = () => {
    if (!hoverAt || hoverAt.buttons) { tip.hidden = true; return; }
    const r = stage.renderer.domElement.getBoundingClientRect();
    ndc.set(((hoverAt.clientX - r.left) / r.width) * 2 - 1, -((hoverAt.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);
    const hit = ray.intersectObjects([...healthy.pickables(), ...injured.pickables()], false)[0];
    if (!hit) { tip.hidden = true; return; }
    const isInj = injured.pickables().includes(hit.object as THREE.Mesh), rig = isInj ? injured : healthy, c = isInj ? cI : cH;
    const name = hit.object.name, k = meta.bundles.indexOf(name), s = STRUCTS.find((x) => x.key === structureOf(name));
    const torn = isInj && tornSet.has(name);
    tip.innerHTML = `<b>${s?.name ?? name} · bundle ${name}</b><span>${isInj ? 'injured' : 'healthy'} knee · ${torn ? 'torn: carries nothing'
      : `strain ${rig.values[c.oStrain + k].toFixed(1)}% · force ${rig.values[c.oForce + k].toFixed(0)} N`}</span>`;
    tip.style.left = `${hoverAt.clientX}px`; tip.style.top = `${hoverAt.clientY}px`; tip.hidden = false;
  };

  // ---------- dialogs ----------
  $('open-about').onclick = () => ($('about') as HTMLDialogElement).showModal();
  $('open-method').onclick = () => ($('method') as HTMLDialogElement).showModal();

  // ---------- frame loop ----------
  let tick = 0;
  stage.onFrame((dt) => {
    if (playing) t = (t + dt * speed) % (cH.duration + HOLD);
    const tt = Math.min(t, cH.duration), info = meta.tests[test];
    healthy.update(cH, tt, info); injured.update(cI, tt, info);
    if (cam.k < 1) {
      cam.k = Math.min(1, cam.k + dt / 1.1);
      const e = cam.k < 0.5 ? 4 * cam.k ** 3 : 1 - (-2 * cam.k + 2) ** 3 / 2;
      stage.camera.position.lerpVectors(cam.from, cam.to, e); stage.controls.target.lerpVectors(cam.tf, cam.tt, e);
    }
    $('head').style.left = `${(tt / cH.duration) * 100}%`;
    if ((tick = (tick + 1) % 3) === 0) {
      const mh = measure(cH, healthy.values, refH), mi = measure(cI, injured.values, refI);
      const waiting = test !== 'flexion' && tt < LOAD_T;   // the test load has not started yet
      for (const r of rows) {
        const fmt = (v: number) => (waiting ? '·' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}${r.unit === '°' ? '°' : ''}`);
        $(`h-${r.key}`).textContent = r.key === 'bend' ? `${mh.bend.toFixed(0)}°` : fmt(mh[r.key]);
        $(`i-${r.key}`).textContent = r.key === 'bend' ? `${mi.bend.toFixed(0)}°` : fmt(mi[r.key]);
      }
      $('load').textContent = info.load === 'none' ? 'no extra load' : info.load === 'force'
        ? `${Math.abs(mh.load).toFixed(0)} N ${mh.load * info.dir >= 0 ? (info.dir > 0 ? 'forward' : 'backward') : ''}`
        : `${Math.abs(mh.load).toFixed(1)} N·m ${info.dir > 0 ? 'varus' : 'valgus'}`;
      const ph = PHASES.find(([a, b]) => tt >= a && tt < b)?.[2] ?? 'load';
      $('clock').textContent = test === 'flexion' ? `${tt.toFixed(2)} s` : `${tt.toFixed(2)} s · ${ph}`;
      for (const s of STRUCTS) {
        const ids = bundlesOf.get(s.key) ?? [];
        const sum = (rig: KneeRig, c: KneeClip) => ids.reduce((acc, k) => acc + rig.values[c.oForce + k], 0);
        $(`fh-${s.key}`).textContent = `${sum(healthy, cH).toFixed(0)} N`;
        $(`fi-${s.key}`).textContent = s.injured === 'torn' ? '—' : `${sum(injured, cI).toFixed(0)} N`;
      }
      drawChart();
      hover();
    }
  });

  await setTest('lachman');
  stage.camera.position.set(...VIEWS[view]); stage.controls.target.copy(target); cam.k = 1;
  stage.settle();
  const veil = $('loading'); veil.classList.add('gone'); setTimeout(() => veil.remove(), 900);
  // test hook: freeze at a time / switch test from the console or a headless check
  (window as unknown as { __knee: unknown }).__knee = {
    stage, rigs, seek: (s: number) => { setPlaying(false); t = s; }, test: (n: string) => setTest(n),
  };
}

function niceStep(range: number) {
  const s = 10 ** Math.floor(Math.log10(range / 3));
  return [1, 2, 5, 10].map((k) => k * s).find((k) => range / k <= 4)!;
}

function segment(id: string, onPick: (b: HTMLButtonElement) => void) {
  const root = document.getElementById(id)!;
  root.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    onPick(b);
  }));
}

main().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading')!;
  l.innerHTML = `<span>Could not load: ${String(e.message ?? e)}</span>`;
});
