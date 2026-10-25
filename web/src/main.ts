import './app.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Stage } from './stage';
import { Studio } from './studio';
import { Twin } from './twin';
import { loadClip, type Clip } from './data';
import { Chart, cycleCurve, phaseAt, timeAtPhase, type Band } from './charts';
import { HeatMap } from './heat';
import { renderAtlas, MUSCLE_ORDER, SHORT, type AtlasEntry } from './atlas';
import { playIntro } from './intro';
import { methodHtml } from './method';
import { findingsHtml } from './findings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SIDE_X = 1.1;
const NAMES: Record<string, string> = {
  soleus: 'Soleus', gastroc: 'Gastrocnemius', tib_ant: 'Tibialis anterior', vasti: 'Vasti (quadriceps)',
  rect_fem: 'Rectus femoris', hamstrings: 'Hamstrings', bifemsh: 'Biceps femoris (short head)',
  glut_max: 'Gluteus maximus', iliopsoas: 'Iliopsoas',
};
const prettyMuscle = (n: string) => `${NAMES[n.replace(/_[rl]$/, '')] ?? n} (${n.endsWith('_r') ? 'right' : 'left'})`;
const fract = (x: number) => ((x % 1) + 1) % 1;

interface DialLevel { s: number; clip: string }
type Entry = AtlasEntry & { phrase?: string };

async function main() {
  // the intro plays once per visit; hide the UI before anything is drawn so it never flashes
  let seen = false;
  try { seen = sessionStorage.getItem('kinema-intro') === '1'; sessionStorage.setItem('kinema-intro', '1'); } catch { /* private mode */ }
  const withIntro = !seen && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (withIntro) document.body.classList.add('intro');
  const base = import.meta.env.BASE_URL;
  const manifest = await fetch(`${base}data/manifest.json`).then((r) => r.json());
  const [healthyClip, weakClip, gltf, reference] = await Promise.all([
    loadClip(manifest.healthy), loadClip(manifest.weak),
    new GLTFLoader().loadAsync(`${base}models/bones.glb`),
    fetch(`${base}data/reference.json`).then((r) => r.json()),
  ]);
  const boneGeo = new Map<string, THREE.BufferGeometry>();
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) boneGeo.set(o.name, (o as THREE.Mesh).geometry); });

  // every run is fetched once; the two twins' runs are already in
  const clips = new Map<string, Promise<Clip>>([[manifest.healthy, Promise.resolve(healthyClip)], [manifest.weak, Promise.resolve(weakClip)]]);
  const clip = (name: string) => { if (!clips.has(name)) clips.set(name, loadClip(name)); return clips.get(name)!; };

  const stage = new Stage($('stage'));
  const studio = new Studio(stage, [-SIDE_X, SIDE_X]);
  const healthy = new Twin(healthyClip, boneGeo, -SIDE_X);
  const weak = new Twin(weakClip, boneGeo, SIDE_X);
  weak.matchSizes(healthy);
  stage.scene.add(healthy.group, weak.group);
  const twins = [healthy, weak];
  (window as unknown as { __kinema: unknown }).__kinema = { stage, twins };

  // ---------- playback ----------
  // The healthy twin plays its seamless 8 s loop by time t. The right twin follows its own gait
  // phase, so it can be blended between runs with different cadences (the weakness dial).
  let t = 0, phase = 0;
  let playing = true, speed = 1, introSpeed = 1;
  const duration = healthyClip.duration;
  const frameDt = 1 / healthyClip.h.fps;
  const playBtn = $('play');
  const setPlaying = (p: boolean) => { playing = p; playBtn.textContent = p ? '❚❚' : '▶'; playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play'); };
  const step = (d: number) => { setPlaying(false); t = (t + d + duration) % duration; phase = fract(phase + d / weak.strideSeconds); };
  playBtn.onclick = () => setPlaying(!playing);
  $('back').onclick = () => step(-frameDt);
  $('fwd').onclick = () => step(frameDt);
  segment('speed', (b) => { speed = Number(b.dataset.speed); });
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || document.body.classList.contains('intro')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    if (e.code === 'ArrowLeft') $('back').click();
    if (e.code === 'ArrowRight') $('fwd').click();
  });

  // timeline: healthy gait-event ticks (the right twin's cadence changes with the dial)
  const tl = $('timeline'), head = $('head'), ticks = $('ticks');
  for (const f of healthyClip.h.events.heel_strike_r) ticks.insertAdjacentHTML('beforeend', `<i class="h" style="left:${(f / healthyClip.h.frames) * 100}%"></i>`);
  for (const f of healthyClip.h.events.toe_off_r) ticks.insertAdjacentHTML('beforeend', `<i class="h to" style="left:${(f / healthyClip.h.frames) * 100}%"></i>`);
  const scrub = (e: PointerEvent) => {
    const r = tl.getBoundingClientRect();
    t = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 0.9999) * duration;
    phase = fract(t / weak.strideSeconds);
  };
  tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); setPlaying(false); scrub(e); });
  tl.addEventListener('pointermove', (e) => { if (e.buttons) scrub(e); });

  // ---------- layout + camera shots ----------
  let layout: 'side' | 'overlay' = 'side', shot = 'body', focus: 'h' | 'w' = 'w';
  const jointFile = { hip: 'femur_r', knee: 'tibia_r', ankle: 'r_talus' } as const;
  const meanJoint = (c: Clip, file: string) => {
    const i = c.h.meshes.findIndex((m) => m.file === file), v = new THREE.Vector3();
    for (let f = 0; f < c.h.frames; f++) v.add(new THREE.Vector3().fromArray(c.data, f * c.h.stride + i * 7));
    return v.divideScalar(c.h.frames);
  };
  const cam = { from: new THREE.Vector3(), to: new THREE.Vector3(), tFrom: new THREE.Vector3(), tTo: new THREE.Vector3(), k: 1 };
  const goTo = (pos: THREE.Vector3, target: THREE.Vector3) => {
    cam.from.copy(stage.camera.position); cam.tFrom.copy(stage.controls.target);
    cam.to.copy(pos); cam.tTo.copy(target); cam.k = 0;
  };
  const BODY = { pos: new THREE.Vector3(0, 1.0, 5.5), target: new THREE.Vector3(0, 0.74, 0) };
  const applyShot = () => {
    const twin = layout === 'overlay' ? weak : focus === 'h' ? healthy : weak;
    if (shot === 'body') {
      goTo(layout === 'overlay' ? new THREE.Vector3(0, 1.0, 3.4) : BODY.pos, BODY.target);
      return;
    }
    const j = meanJoint(twin.a, jointFile[shot as keyof typeof jointFile]).add(new THREE.Vector3(twin.group.position.x, 0, 0));
    const dist = { hip: 1.5, knee: 1.25, ankle: 0.95 }[shot as 'hip'] ?? 1.3;
    goTo(new THREE.Vector3(j.x + 0.25, j.y + 0.12, j.z + dist), new THREE.Vector3(j.x, j.y, j.z));
  };
  const applyLayout = () => {
    const overlay = layout === 'overlay';
    healthy.group.position.x = overlay ? 0 : -SIDE_X;
    weak.group.position.x = overlay ? 0 : SIDE_X;
    healthy.offsetX = healthy.group.position.x;
    weak.offsetX = weak.group.position.x;
    healthy.setGhost(overlay);
    studio.layout(overlay ? [0, 0] : [-SIDE_X, SIDE_X], [!overlay, true]);
    $('focus').style.display = overlay ? 'none' : '';
    applyShot();
  };
  segment('layout', (b) => { layout = b.dataset.layout as typeof layout; applyLayout(); });
  segment('shots', (b) => { shot = b.dataset.shot!; applyShot(); });
  segment('focus', (b) => { focus = b.dataset.focus as typeof focus; applyShot(); });
  stage.controls.addEventListener('start', () => { cam.k = 1; });   // the user takes the camera

  // ---------- readouts ----------
  const rowsEl = $('rows');
  type Row = { label: string; get: (tw: Twin) => number; fmt: (v: number) => string; hot?: (v: number) => boolean };
  const act = (name: string) => (tw: Twin) => tw.values[tw.clip.oAct + tw.clip.muscleIndex(name)] * 100;
  const pct = (v: number) => `${v.toFixed(0)}%`, hot = (v: number) => v > 30;
  const rows: (Row | string)[] = [
    'Right leg angles',
    { label: 'Ankle', get: (tw) => tw.values[tw.clip.oRead], fmt: (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'DF' : 'PF'}` },
    { label: 'Knee flexion', get: (tw) => -tw.values[tw.clip.oRead + 1], fmt: (v) => `${v.toFixed(1)}°` },
    { label: 'Hip flexion', get: (tw) => tw.values[tw.clip.oRead + 2], fmt: (v) => `${v.toFixed(1)}°` },
    'Muscle activation',
    { label: 'Soleus', get: act('soleus_r'), fmt: pct, hot },
    { label: 'Gastrocnemius', get: act('gastroc_r'), fmt: pct, hot },
    { label: 'Vasti', get: act('vasti_r'), fmt: pct, hot },
    { label: 'Gluteus max', get: act('glut_max_r'), fmt: pct, hot },
    { label: 'Hamstrings', get: act('hamstrings_r'), fmt: pct, hot },
    'Ground reaction',
    { label: 'Vertical force', get: (tw) => tw.values[tw.clip.oGrf + 1] / (tw.clip.h.mass * 9.80665), fmt: (v) => `${v.toFixed(2)} BW` },
  ];
  const cells: [HTMLElement, HTMLElement, Row][] = [];
  for (const r of rows) {
    if (typeof r === 'string') { rowsEl.insertAdjacentHTML('beforeend', `<div class="group">${r}</div>`); continue; }
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<span>${r.label}</span><b></b><b></b>`;
    rowsEl.appendChild(row);
    cells.push([row.children[1] as HTMLElement, row.children[2] as HTMLElement, r]);
  }

  // ---------- per-run cycle curves (charts + muscle map), blended for the right twin ----------
  const val = (c: Clip, f: number, k: number) => c.data[f * c.h.stride + k];
  const heatIdx = MUSCLE_ORDER.map((m) => healthyClip.muscleIndex(m));
  const curveCache = new Map<Clip, Float32Array[]>();
  const curves = (c: Clip) => {
    if (!curveCache.has(c)) {
      const bw = c.h.mass * 9.80665;
      curveCache.set(c, [
        cycleCurve(c, (f) => val(c, f, c.oRead)),
        cycleCurve(c, (f) => val(c, f, c.oAct + c.muscleIndex('soleus_r')) * 100),
        cycleCurve(c, (f) => val(c, f, c.oAct + c.muscleIndex('vasti_r')) * 100),
        cycleCurve(c, (f) => val(c, f, c.oGrf + 1) / bw),
        ...heatIdx.map((k) => cycleCurve(c, (f) => val(c, f, c.oAct + k))),
      ]);
    }
    return curveCache.get(c)!;
  };
  const cH = curves(healthyClip);
  const subj = curves(weakClip).map((a) => new Float32Array(a));   // live arrays the charts draw from
  const blendCurves = () => {
    const A = curves(weak.a), B = weak.b ? curves(weak.b) : null, w = weak.w;
    subj.forEach((dst, i) => { for (let p = 0; p < dst.length; p++) dst[p] = B ? A[i][p] * (1 - w) + B[i][p] * w : A[i][p]; });
  };

  const band: Band = { ...reference.ankle_angle, label: `Real walkers (n=${reference.n}, ±1 SD)` };
  const css = getComputedStyle(document.documentElement);
  const H = css.getPropertyValue('--healthy').trim(), W = css.getPropertyValue('--weak').trim();
  const charts = [
    new Chart('Ankle angle', '° dorsiflexion +', [{ label: 'Healthy', color: H, data: cH[0] }, { label: 'Right twin', color: W, data: subj[0] }], band),
    new Chart('Activation', '% of max', [
      { label: 'Soleus', color: H, data: cH[1] }, { label: '', color: W, data: subj[1] },
      { label: 'Vasti', color: H, data: cH[2], dash: [4, 3] }, { label: '', color: W, data: subj[2], dash: [4, 3] }], undefined, [0, 60]),
    new Chart('Vertical ground force', 'body weights', [{ label: 'Healthy', color: H, data: cH[3] }, { label: 'Right twin', color: W, data: subj[3] }]),
  ];
  const seekPhase = (p: number) => { setPlaying(false); t = timeAtPhase(healthyClip, t, p); phase = p / 100; };
  for (const c of charts) {
    $('charts').appendChild(c.el);
    c.onSeek = seekPhase;
    c.el.querySelectorAll('footer i').forEach((i) => { if (!(i.nextSibling?.textContent ?? '').trim() && !i.classList.contains('band')) (i as HTMLElement).style.display = 'none'; });
  }
  const heatmap = new HeatMap(MUSCLE_ORDER.map((m) => SHORT[m]));
  heatmap.el.hidden = true;
  heatmap.onSeek = seekPhase;
  $('charts').appendChild(heatmap.el);
  segment('panel', (b) => {
    const map = b.dataset.panel === 'map';
    charts.forEach((c) => (c.el.hidden = map));
    heatmap.el.hidden = !map;
    $('charts').classList.toggle('map', map);
  });

  // ---------- the right twin: weakness dial + atlas ----------
  const dial: DialLevel[] = [...(manifest.dial ?? [])].sort((a: DialLevel, b: DialLevel) => b.s - a.s);
  const atlas: Entry[] = manifest.atlas ?? [];
  const calves = atlas.find((e) => e.id === 'plantarflexors');
  let current = calves ?? { id: 'plantarflexors', label: 'Calves', phrase: 'calf muscles', strength: 0.4, weakened: ['soleus_r', 'gastroc_r'] } as Entry;
  let dialValue = 0.4;
  const dialInput = $<HTMLInputElement>('dial-input');

  const describe = () => {
    const isDial = current.id === 'plantarflexors';
    const s = isDial ? dialValue : current.strength, p = Math.round(s * 100);
    $('subj-name').textContent = current.label;
    $('subj-pct').textContent = `${p}%`;
    $('readout-w').textContent = `${current.label} ${p}%`;
    $('mast-w').textContent = s >= 0.995 ? 'Both twins are at full strength now: drag the dial to weaken the right one.'
      : `The right twin's ${current.phrase ?? current.label.toLowerCase()} keep only ${p} % of their strength`;
    $('mast-tail').textContent = s >= 0.995 ? '' : ', and it has to find another way to walk.';
    $('dial').classList.toggle('atlas-mode', !isDial);
    const solved = dial.some((d) => Math.abs(d.s - s) < 0.005);
    $('dial-note').textContent = !isDial ? `Atlas run: ${current.muscles} at ${p}%.`
      : solved ? 'Solved simulation at this strength.' : 'Between solved runs: the walker is blended from the two nearest.';
    const marked = current.weakened.map((m) => MUSCLE_ORDER.indexOf(m)).filter((i) => i >= 0);
    heatmap.setData(cH.slice(4), subj.slice(4), `${current.label} ${p}%`, s >= 0.995 ? [] : marked);
    charts.forEach((c) => c.draw());
  };

  const setDial = (s: number) => {
    dialValue = s;
    const loaded = dial.every((d) => dialClips.has(d.clip));
    if (loaded && dial.length > 1) {
      let i = 0;
      while (i < dial.length - 2 && s < dial[i + 1].s) i++;
      const hi = dial[i], lo = dial[i + 1], w = Math.min(Math.max((hi.s - s) / (hi.s - lo.s), 0), 1);
      const a = dialClips.get(hi.clip)!, b = dialClips.get(lo.clip)!;
      if (w < 0.005) weak.setSource(a); else if (w > 0.995) weak.setSource(b); else weak.setSource(a, b, w);
    }
    blendCurves();
    describe();
  };

  const dialClips = new Map<string, Clip>();
  if (dial.length) {
    dialInput.disabled = true;
    $('dial').classList.add('loading');
    // solved levels as dots on the dial track
    const lo = Number(dialInput.min), hi = Number(dialInput.max);
    $('dial-dots').innerHTML = dial.map((d) => `<i style="left:${((d.s * 100 - lo) / (hi - lo)) * 100}%" title="solved: ${Math.round(d.s * 100)}%"></i>`).join('');
    Promise.all(dial.map(async (d) => dialClips.set(d.clip, await clip(d.clip)))).then(() => {
      dialInput.disabled = false;
      $('dial').classList.remove('loading');
      dial.forEach((d) => curves(dialClips.get(d.clip)!));
    }).catch((e) => { console.error(e); $('dial-note').textContent = 'Dial runs could not be loaded.'; });
  } else {
    $('dial').classList.add('no-dial');
  }
  dialInput.addEventListener('input', () => {
    if (current.id !== 'plantarflexors' && calves) { current = calves; }
    setDial(Number(dialInput.value) / 100);
  });

  const pickAtlas = async (e: Entry) => {
    ($('atlas') as HTMLDialogElement).close();
    if (e.id === 'plantarflexors') {
      current = e;
      dialInput.value = String(Math.round(dialValue * 100));
      setDial(dialValue);
      return;
    }
    $('dial-note').textContent = `Loading ${e.label}…`;
    const c = await clip(e.clip);
    current = e;
    weak.setSource(c);
    blendCurves();
    describe();
  };
  $('open-atlas').onclick = () => {
    renderAtlas($('atlas-body'), atlas, current.id, pickAtlas);
    ($('atlas') as HTMLDialogElement).showModal();
  };
  if (!atlas.length) $('open-atlas').hidden = true;
  $('dial-back').onclick = () => { if (calves) pickAtlas(calves); };

  // ---------- X-ray load mode ----------
  let xray = false;
  $('xray').onclick = () => {
    xray = !xray;
    twins.forEach((tw) => tw.setXray(xray));
    $('xray').setAttribute('aria-pressed', String(xray));
    $('xray-legend').hidden = !xray;
    document.body.classList.toggle('xray', xray);
  };

  // ---------- hover a muscle ----------
  const tip = $('tip');
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let hoverAt: PointerEvent | null = null;
  stage.renderer.domElement.addEventListener('pointermove', (e) => { hoverAt = e; });
  stage.renderer.domElement.addEventListener('pointerleave', () => { hoverAt = null; tip.hidden = true; });
  const hover = () => {
    if (!hoverAt || hoverAt.buttons || document.body.classList.contains('intro')) { tip.hidden = true; return; }
    const r = stage.renderer.domElement.getBoundingClientRect();
    ndc.set(((hoverAt.clientX - r.left) / r.width) * 2 - 1, -((hoverAt.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);
    const pool = layout === 'overlay' ? weak.pickables() : [...healthy.pickables(), ...weak.pickables()];
    const hit = ray.intersectObjects(pool, false)[0];
    if (!hit) { tip.hidden = true; return; }
    const tw = weak.pickables().includes(hit.object as THREE.Mesh) ? weak : healthy;
    const k = tw.clip.muscleIndex(hit.object.name);
    const a = tw.values[tw.clip.oAct + k] * 100, f = tw.values[tw.clip.oForce + k], fmax = tw.fmax(k);
    const who = tw === healthy ? 'healthy' : `${current.label.toLowerCase()} ${$('subj-pct').textContent}`;
    tip.innerHTML = `<b>${prettyMuscle(hit.object.name)}</b><span>${who} · activation ${a.toFixed(0)}%<br>tendon force ${(f / 1000).toFixed(2)} kN of ${(fmax / 1000).toFixed(2)} kN max</span>`;
    tip.style.left = `${hoverAt.clientX}px`; tip.style.top = `${hoverAt.clientY}px`;
    tip.hidden = false;
  };

  // ---------- dialogs ----------
  $('method-body').innerHTML = methodHtml(manifest, reference);
  $('findings-body').innerHTML = findingsHtml(manifest);
  $('open-findings').onclick = () => ($('findings') as HTMLDialogElement).showModal();
  $('open-method').onclick = () => ($('method') as HTMLDialogElement).showModal();
  $('open-film').onclick = () => { ($('film') as HTMLDialogElement).showModal(); ($('film-video') as HTMLVideoElement).play().catch(() => {}); };
  $('film').addEventListener('close', () => ($('film-video') as HTMLVideoElement).pause());

  // ---------- frame loop ----------
  const feet: THREE.Vector4[] = [];
  let uiTick = 0;
  stage.onFrame((dt) => {
    if (playing) {
      const d = dt * speed * introSpeed;
      t = (t + d) % duration;
      phase = fract(phase + d / weak.strideSeconds);
    }
    healthy.update(t);
    weak.updatePhase(phase);
    twins.forEach((tw, i) => studio.update(i, t * tw.clip.h.speed, tw.feet(feet)));
    if (layout === 'overlay') studio.update(1, t * weak.clip.h.speed, [...weak.feet([]), ...healthy.feet([])].slice(0, 8));
    if (cam.k < 1) {
      cam.k = Math.min(1, cam.k + dt / 1.1);
      const e = cam.k < 0.5 ? 4 * cam.k ** 3 : 1 - (-2 * cam.k + 2) ** 3 / 2;
      stage.camera.position.lerpVectors(cam.from, cam.to, e);
      stage.controls.target.lerpVectors(cam.tFrom, cam.tTo, e);
    }
    head.style.left = `${(t / duration) * 100}%`;
    $('clock').textContent = `${t.toFixed(2)} s`;
    if ((uiTick = (uiTick + 1) % 3) === 0) {       // text and charts at ~20 Hz
      for (const [hEl, wEl, r] of cells) {
        const hv = r.get(healthy), wv = r.get(weak);
        hEl.textContent = r.fmt(hv); wEl.textContent = r.fmt(wv);
        hEl.classList.toggle('hot', !!r.hot?.(hv)); wEl.classList.toggle('hot', !!r.hot?.(wv));
      }
      const ph = phaseAt(healthyClip, t), pw = phase * 100;
      $('phase-h').textContent = `${ph.toFixed(0)}%`; $('phase-w').textContent = `${pw.toFixed(0)}%`;
      if (heatmap.el.hidden) for (const c of charts) c.setCursors([{ p: ph, color: H }, { p: pw, color: W }]);
      else heatmap.setCursors(ph, pw);
      hover();
    }
  });

  setDial(dialValue);
  applyLayout();
  stage.camera.position.copy(cam.to); stage.controls.target.copy(cam.tTo); cam.k = 1;
  // Compile every look (normal / X-ray x solid / overlay ghost) while the loading veil is still up,
  // so switching modes later never stalls on a shader compile.
  healthy.update(0); weak.updatePhase(0);
  for (const xr of [true, false]) {
    for (const ghost of [true, false]) {
      twins.forEach((tw) => { tw.setXray(xr); tw.setGhost(ghost); tw.showArrowsForWarmup(); });
      stage.renderer.compile(stage.scene, stage.camera);
      stage.renderer.render(stage.scene, stage.camera);
    }
  }
  twins.forEach((tw) => tw.setXray(false)); healthy.setGhost(false); weak.setGhost(false);
  stage.settle();
  const veil = $('loading');
  veil.classList.add('gone');
  setTimeout(() => veil.remove(), 900);   // transitions can stall in background tabs

  // ---------- cinematic intro (once per visit; "Intro" replays it) ----------
  const intro = () => {
    if (layout !== 'side') $('layout').querySelector<HTMLButtonElement>('[data-layout="side"]')!.click();
    const x = SIDE_X, ankle = meanJoint(weakClip, 'r_talus').add(new THREE.Vector3(x, 0, 0));
    const knee = meanJoint(weakClip, 'tibia_r').add(new THREE.Vector3(x, 0, 0));
    cam.k = 1;
    return playIntro(stage, [
      { at: 0, pos: ankle.clone().add(new THREE.Vector3(0.32, 0.04, 0.62)), target: ankle.clone().add(new THREE.Vector3(0, 0.03, 0)) },
      { at: 3.4, pos: knee.clone().add(new THREE.Vector3(0.75, 0.2, 1.45)), target: knee.clone().add(new THREE.Vector3(-0.05, 0.12, 0)) },
      { at: 6.6, pos: new THREE.Vector3(2.9, 1.25, 4.1), target: new THREE.Vector3(0.45, 0.82, 0) },
      { at: 9.4, pos: BODY.pos.clone(), target: BODY.target.clone() },
    ], [
      { from: 0.5, to: 3.2, text: 'Nothing on this screen is animated.' },
      { from: 3.5, to: 6.3, text: 'Each walker is solved by OpenSim Moco: 18 muscles, finding the least-effort way to walk.' },
      { from: 6.6, to: 9.4, text: "The right twin's calves keep 40 % of their strength. Watch where the work goes." },
    ], (s) => { introSpeed = s; });
  };
  $('open-intro').onclick = () => { setPlaying(true); intro(); };
  if (withIntro) intro();
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
