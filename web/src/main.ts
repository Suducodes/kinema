import './app.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Stage } from './stage';
import { Studio } from './studio';
import { Twin } from './twin';
import { loadClip, type Clip } from './data';
import { Chart, cycleCurve, phaseAt, timeAtPhase, type Band } from './charts';
import { methodHtml } from './method';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SIDE_X = 1.1;
const NAMES: Record<string, string> = {
  soleus: 'Soleus', gastroc: 'Gastrocnemius', tib_ant: 'Tibialis anterior', vasti: 'Vasti (quadriceps)',
  rect_fem: 'Rectus femoris', hamstrings: 'Hamstrings', bifemsh: 'Biceps femoris (short head)',
  glut_max: 'Gluteus maximus', iliopsoas: 'Iliopsoas',
};
const prettyMuscle = (n: string) => `${NAMES[n.replace(/_[rl]$/, '')] ?? n} (${n.endsWith('_r') ? 'right' : 'left'})`;

async function main() {
  const manifest = await fetch(`${import.meta.env.BASE_URL}data/manifest.json`).then((r) => r.json());
  const [healthyClip, weakClip, gltf, reference] = await Promise.all([
    loadClip(manifest.healthy), loadClip(manifest.weak),
    new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/bones.glb`),
    fetch(`${import.meta.env.BASE_URL}data/reference.json`).then((r) => r.json()),
  ]);
  const boneGeo = new Map<string, THREE.BufferGeometry>();
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) boneGeo.set(o.name, (o as THREE.Mesh).geometry); });

  const stage = new Stage($('stage'));
  const studio = new Studio(stage, [-SIDE_X, SIDE_X]);
  const healthy = new Twin(healthyClip, boneGeo, -SIDE_X);
  const weak = new Twin(weakClip, boneGeo, SIDE_X);
  weak.matchSizes(healthy);
  stage.scene.add(healthy.group, weak.group);
  const twins = [healthy, weak];
  (window as unknown as { __kinema: unknown }).__kinema = { stage, twins };

  // ---------- playback ----------
  let t = 0, playing = true, speed = 1;
  const duration = healthyClip.duration;          // both clips share the seamless loop length
  const frameDt = 1 / healthyClip.h.fps;
  const playBtn = $('play');
  const setPlaying = (p: boolean) => { playing = p; playBtn.textContent = p ? '❚❚' : '▶'; playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play'); };
  playBtn.onclick = () => setPlaying(!playing);
  $('back').onclick = () => { setPlaying(false); t = (t - frameDt + duration) % duration; };
  $('fwd').onclick = () => { setPlaying(false); t = (t + frameDt) % duration; };
  segment('speed', (b) => { speed = Number(b.dataset.speed); });
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    if (e.code === 'ArrowLeft') $('back').click();
    if (e.code === 'ArrowRight') $('fwd').click();
  });

  // timeline with gait-event ticks for both twins
  const tl = $('timeline'), head = $('head'), ticks = $('ticks');
  for (const [cls, clip] of [['h', healthyClip], ['w', weakClip]] as [string, Clip][]) {
    for (const f of clip.h.events.heel_strike_r) ticks.insertAdjacentHTML('beforeend', `<i class="${cls}" style="left:${(f / clip.h.frames) * 100}%"></i>`);
    for (const f of clip.h.events.toe_off_r) ticks.insertAdjacentHTML('beforeend', `<i class="${cls} to" style="left:${(f / clip.h.frames) * 100}%"></i>`);
  }
  const scrub = (e: PointerEvent) => { const r = tl.getBoundingClientRect(); t = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 0.9999) * duration; };
  tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); setPlaying(false); scrub(e); });
  tl.addEventListener('pointermove', (e) => { if (e.buttons) scrub(e); });

  // ---------- layout + camera shots ----------
  let layout: 'side' | 'overlay' = 'side', shot = 'body', focus: 'h' | 'w' = 'w';
  const jointFile = { hip: 'femur_r', knee: 'tibia_r', ankle: 'r_talus' } as const;
  const meanJoint = (clip: Clip, file: string) => {
    const i = clip.h.meshes.findIndex((m) => m.file === file), v = new THREE.Vector3();
    for (let f = 0; f < clip.h.frames; f++) v.add(new THREE.Vector3().fromArray(clip.data, f * clip.h.stride + i * 7));
    return v.divideScalar(clip.h.frames);
  };
  const cam = { from: new THREE.Vector3(), to: new THREE.Vector3(), tFrom: new THREE.Vector3(), tTo: new THREE.Vector3(), k: 1 };
  const goTo = (pos: THREE.Vector3, target: THREE.Vector3) => {
    cam.from.copy(stage.camera.position); cam.tFrom.copy(stage.controls.target);
    cam.to.copy(pos); cam.tTo.copy(target); cam.k = 0;
  };
  const applyShot = () => {
    const twin = layout === 'overlay' ? weak : focus === 'h' ? healthy : weak;
    if (shot === 'body') {
      const d = layout === 'overlay' ? 3.4 : 5.5;
      goTo(new THREE.Vector3(0, 1.0, d), new THREE.Vector3(0, 0.74, 0));
      return;
    }
    const j = meanJoint(twin.clip, jointFile[shot as keyof typeof jointFile]).add(new THREE.Vector3(twin.group.position.x, 0, 0));
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
  type Row = { label: string; unit: string; get: (tw: Twin) => number; fmt: (v: number) => string; hot?: (v: number) => boolean };
  const act = (name: string) => (tw: Twin) => tw.values[tw.clip.oAct + tw.clip.muscleIndex(name)] * 100;
  const rows: (Row | string)[] = [
    'Right leg angles',
    { label: 'Ankle', unit: '°', get: (tw) => tw.values[tw.clip.oRead], fmt: (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'DF' : 'PF'}` },
    { label: 'Knee flexion', unit: '°', get: (tw) => -tw.values[tw.clip.oRead + 1], fmt: (v) => `${v.toFixed(1)}°` },
    { label: 'Hip flexion', unit: '°', get: (tw) => tw.values[tw.clip.oRead + 2], fmt: (v) => `${v.toFixed(1)}°` },
    'Muscle activation',
    { label: 'Soleus', unit: '%', get: act('soleus_r'), fmt: (v) => `${v.toFixed(0)}%`, hot: (v) => v > 30 },
    { label: 'Gastrocnemius', unit: '%', get: act('gastroc_r'), fmt: (v) => `${v.toFixed(0)}%`, hot: (v) => v > 30 },
    { label: 'Vasti', unit: '%', get: act('vasti_r'), fmt: (v) => `${v.toFixed(0)}%`, hot: (v) => v > 30 },
    { label: 'Gluteus max', unit: '%', get: act('glut_max_r'), fmt: (v) => `${v.toFixed(0)}%`, hot: (v) => v > 30 },
    'Ground reaction',
    { label: 'Vertical force', unit: 'BW', get: (tw) => tw.values[tw.clip.oGrf + 1] / (tw.clip.h.mass * 9.80665), fmt: (v) => `${v.toFixed(2)} BW` },
  ];
  const cells: [HTMLElement, HTMLElement, Row][] = [];
  for (const r of rows) {
    if (typeof r === 'string') { rowsEl.insertAdjacentHTML('beforeend', `<div class="group">${r}</div>`); continue; }
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<span>${r.label}</span><b></b><b></b>`;
    rowsEl.appendChild(row);
    cells.push([row.children[1] as HTMLElement, row.children[2] as HTMLElement, r]);
  }

  // ---------- charts (one gait cycle, both twins, healthy vs real humans) ----------
  const series = (pick: (c: Clip, f: number) => number) =>
    [healthyClip, weakClip].map((c) => cycleCurve(c, (f) => pick(c, f)));
  const val = (c: Clip, f: number, k: number) => c.data[f * c.h.stride + k];
  const [ankH, ankW] = series((c, f) => val(c, f, c.oRead));
  const [solH, solW] = series((c, f) => val(c, f, c.oAct + c.muscleIndex('soleus_r')) * 100);
  const [vasH, vasW] = series((c, f) => val(c, f, c.oAct + c.muscleIndex('vasti_r')) * 100);
  const [grfH, grfW] = series((c, f) => val(c, f, c.oGrf + 1) / (c.h.mass * 9.80665));
  const band: Band = { ...reference.ankle_angle, label: `Real walkers (n=${reference.n}, ±1 SD)` };
  const H = 'var(--healthy)', W = 'var(--weak)';
  const css = getComputedStyle(document.documentElement);
  const col = (v: string) => css.getPropertyValue(v.slice(4, -1)).trim();
  const charts = [
    new Chart('Ankle angle', '° dorsiflexion +', [{ label: 'Healthy', color: col(H), data: ankH }, { label: 'Weak calves', color: col(W), data: ankW }], band),
    new Chart('Activation', '% of max', [
      { label: 'Soleus', color: col(H), data: solH }, { label: '', color: col(W), data: solW },
      { label: 'Vasti', color: col(H), data: vasH, dash: [4, 3] }, { label: '', color: col(W), data: vasW, dash: [4, 3] }], undefined, [0, 60]),
    new Chart('Vertical ground force', 'body weights', [{ label: 'Healthy', color: col(H), data: grfH }, { label: 'Weak calves', color: col(W), data: grfW }]),
  ];
  for (const c of charts) {
    $('charts').appendChild(c.el);
    c.onSeek = (p) => { setPlaying(false); t = timeAtPhase(focus === 'h' ? healthyClip : weakClip, t, p); };
    c.el.querySelectorAll('footer i').forEach((i) => { if (!(i.nextSibling?.textContent ?? '').trim() && !i.classList.contains('band')) (i as HTMLElement).style.display = 'none'; });
  }

  // ---------- hover a muscle ----------
  const tip = $('tip');
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let hoverAt: PointerEvent | null = null;
  stage.renderer.domElement.addEventListener('pointermove', (e) => { hoverAt = e; });
  stage.renderer.domElement.addEventListener('pointerleave', () => { hoverAt = null; tip.hidden = true; });
  const hover = () => {
    if (!hoverAt || hoverAt.buttons) { tip.hidden = true; return; }
    const r = stage.renderer.domElement.getBoundingClientRect();
    ndc.set(((hoverAt.clientX - r.left) / r.width) * 2 - 1, -((hoverAt.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);
    const pool = layout === 'overlay' ? weak.pickables() : [...healthy.pickables(), ...weak.pickables()];
    const hit = ray.intersectObjects(pool, false)[0];
    if (!hit) { tip.hidden = true; return; }
    const tw = weak.pickables().includes(hit.object as THREE.Mesh) ? weak : healthy;
    const k = tw.clip.muscleIndex(hit.object.name);
    const a = tw.values[tw.clip.oAct + k] * 100, f = tw.values[tw.clip.oForce + k], fmax = tw.clip.h.muscles[k].fmax;
    tip.innerHTML = `<b>${prettyMuscle(hit.object.name)}</b><span>${tw === healthy ? 'healthy' : 'weak calves'} · activation ${a.toFixed(0)}%<br>tendon force ${(f / 1000).toFixed(2)} kN of ${(fmax / 1000).toFixed(2)} kN max</span>`;
    tip.style.left = `${hoverAt.clientX}px`; tip.style.top = `${hoverAt.clientY}px`;
    tip.hidden = false;
  };

  // ---------- dialogs ----------
  $('method-body').innerHTML = methodHtml(manifest, reference);
  $('open-method').onclick = () => ($('method') as HTMLDialogElement).showModal();
  $('open-film').onclick = () => { ($('film') as HTMLDialogElement).showModal(); ($('film-video') as HTMLVideoElement).play().catch(() => {}); };
  $('film').addEventListener('close', () => ($('film-video') as HTMLVideoElement).pause());

  // ---------- frame loop ----------
  const feet: THREE.Vector4[] = [];
  let uiTick = 0;
  stage.onFrame((dt) => {
    if (playing) t = (t + dt * speed) % duration;
    for (const tw of twins) tw.update(t);
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
      const ph = phaseAt(healthyClip, t), pw = phaseAt(weakClip, t);
      $('phase-h').textContent = `${ph.toFixed(0)}%`; $('phase-w').textContent = `${pw.toFixed(0)}%`;
      for (const c of charts) c.setCursors([{ p: ph, color: col(H) }, { p: pw, color: col(W) }]);
      hover();
    }
  });

  applyLayout();
  stage.camera.position.copy(cam.to); stage.controls.target.copy(cam.tTo); cam.k = 1;
  stage.settle();
  const veil = $('loading');
  veil.classList.add('gone');
  setTimeout(() => veil.remove(), 900);   // transitions can stall in background tabs
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
