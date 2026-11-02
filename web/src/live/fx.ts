import * as THREE from 'three';
import type { Stage } from '../stage';
import type { Twin, TwinMeta } from './assets';
import { SIDES, type SegPose, type Side } from './body';
import type { PhysView } from './scene';

/**
 * Optional visual layers over the twin, each switched on its own from the Visuals panel:
 *  - hologram skin: a soft fresnel body envelope with drifting scan lines;
 *  - load paths: light streaming up each leg from the centre of pressure, faster and brighter with the
 *    estimated joint load (ground force plus the forces of the muscles crossing each joint);
 *  - angle arcs: protractor sectors at the knees, hips and elbows with their angle;
 *  - motion trails: fading paths of the knees and hands, and the centre of mass drawn on the floor;
 *  - foot pressure: a heat print under each foot, shifted toward the centre of pressure.
 */
export interface FxFlags {
  hands: boolean; firing: boolean; deep: boolean; holo: boolean;
  load: boolean; arcs: boolean; trails: boolean; pressure: boolean; mirror: boolean; bullet: boolean;
}
export const FX_DEFAULT: FxFlags = { hands: true, firing: true, deep: false, holo: false, load: false, arcs: false, trails: false, pressure: false, mirror: false, bullet: false };

type J = Record<string, THREE.Vector3>;
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- hologram skin
const HOLO = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.45, 0.85, 1.0) } },
  vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix*w; vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
  fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vW;
    void main(){
      float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
      float scan = 0.5 + 0.5 * sin(vW.y * 140.0 - uTime * 3.0);
      float sweep = smoothstep(0.06, 0.0, abs(fract(vW.y * 0.45 - uTime * 0.18) - 0.5));
      float a = 0.035 + 0.62 * rim + 0.08 * scan * rim + 0.3 * sweep * (0.3 + rim);
      gl_FragColor = vec4(uColor * a, a);
    }`,
});

// ---------------------------------------------------------------- particles (load paths)
const DOTS = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 400 } },
  vertexShader: `attribute float aSize; attribute vec3 aColor; varying vec3 vC;
    void main(){ vC = aColor; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize * (uScale / -mv.z); gl_Position = projectionMatrix*mv; }`.replace('void main', 'uniform float uScale; void main'),
  fragmentShader: 'varying vec3 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25) discard; float a = exp(-r * 18.0); gl_FragColor = vec4(vC * a, a); }',
});
const loadColour = (bw: number, out: THREE.Color) => out.setRGB(0.45, 0.85, 1.0).lerp(new THREE.Color(1.0, 0.95, 0.85), Math.min(bw / 2, 1))
  .lerp(new THREE.Color(1.0, 0.55, 0.18), Math.min(Math.max((bw - 2) / 3, 0), 1));

// ---------------------------------------------------------------- foot pressure
const PRESS = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uCop: { value: new THREE.Vector2(0.5, 0) }, uLoad: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform vec2 uCop; uniform float uLoad; varying vec2 vUv;
    vec3 heat(float t){ return t < 0.33 ? mix(vec3(0.05,0.2,0.9), vec3(0.1,0.9,0.6), t/0.33) : t < 0.66 ? mix(vec3(0.1,0.9,0.6), vec3(1.0,0.85,0.1), (t-0.33)/0.33) : mix(vec3(1.0,0.85,0.1), vec3(1.0,0.2,0.05), (t-0.66)/0.34); }
    void main(){
      vec2 p = vec2(vUv.x, (vUv.y - 0.5) * 2.0);           // x heel->toe, y across the foot
      float w = 0.36 + 0.2 * smoothstep(0.1, 0.7, p.x);      // foot outline: narrow heel, wide forefoot
      float inside = smoothstep(1.0, 0.82, abs(p.y) / w) * smoothstep(0.0, 0.08, p.x) * smoothstep(1.0, 0.9, p.x);
      float heelW = 1.0 - smoothstep(0.15, 0.85, uCop.x), foreW = 1.0 - heelW;
      float heel = exp(-pow((p.x - 0.18) / 0.13, 2.0) - pow((p.y - uCop.y * 0.4) / 0.32, 2.0)) * heelW;
      float fore = exp(-pow((p.x - 0.7) / 0.17, 2.0) - pow((p.y - uCop.y * 0.4) / 0.42, 2.0)) * foreW;
      float c = exp(-pow((p.x - uCop.x) / 0.1, 2.0) - pow((p.y - uCop.y) / 0.25, 2.0)) * 0.6;
      float t = clamp((heel + fore + c) * uLoad, 0.0, 1.0);
      float a = inside * (0.12 + 0.88 * t) * step(0.02, uLoad);
      gl_FragColor = vec4(heat(t) * a, a);
    }`,
});

/** A fading line through the last `n` positions of a point. */
class Trail {
  readonly line: THREE.Line;
  private readonly pos: Float32Array; private readonly col: Float32Array;
  private readonly hist: THREE.Vector3[] = [];
  constructor(private readonly n: number, private readonly color: THREE.Color) {
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.line.frustumCulled = false; this.line.renderOrder = 8;
  }
  push(p: THREE.Vector3) {
    this.hist.push(p.clone()); if (this.hist.length > this.n) this.hist.shift();
    const m = this.hist.length;
    for (let i = 0; i < this.n; i++) {
      const q = this.hist[Math.min(i, m - 1)] ?? p;
      this.pos.set([q.x, q.y, q.z], i * 3);
      const a = i < m ? (i / Math.max(m - 1, 1)) ** 1.6 : 0;
      this.col.set([this.color.r * a, this.color.g * a, this.color.b * a, a], i * 4);
    }
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.attributes.color.needsUpdate = true;
  }
  clear() { this.hist.length = 0; }
}

/** A protractor at a joint: filled sector + edge from one limb direction to the other, with a label. */
class Arc {
  readonly group = new THREE.Group();
  private readonly fill: THREE.Mesh; private readonly edge: THREE.Line;
  private readonly fp: Float32Array; private readonly ep: Float32Array;
  readonly label: HTMLDivElement;
  readonly at = new THREE.Vector3();
  constructor(labels: HTMLElement, color: number) {
    const N = 24;
    this.fp = new Float32Array((N + 2) * 3); this.ep = new Float32Array((N + 1) * 3);
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(this.fp, 3));
    fg.setIndex(Array.from({ length: N }, (_, i) => [0, i + 1, i + 2]).flat());
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(this.ep, 3));
    this.fill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    this.edge = new THREE.Line(eg, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }));
    this.fill.frustumCulled = this.edge.frustumCulled = false;
    this.fill.renderOrder = this.edge.renderOrder = 9;
    this.group.add(this.fill, this.edge);
    this.label = document.createElement('div'); this.label.className = 'arc-label';
    this.label.style.setProperty('--c', `#${new THREE.Color(color).getHexString()}`);
    labels.appendChild(this.label);
  }
  /** Sector at `c` from direction `a` to `b`, radius r; `text` shown at its middle. */
  set(c: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, text: string) {
    const u = a.clone().normalize(), w = b.clone().normalize();
    const ang = u.angleTo(w), axis = new THREE.Vector3().crossVectors(u, w);
    if (axis.lengthSq() < 1e-8) axis.set(0, 0, 1); axis.normalize();
    const N = 24, q = new THREE.Quaternion(), v = new THREE.Vector3();
    this.fp.set([c.x, c.y, c.z], 0);
    for (let i = 0; i <= N; i++) {
      q.setFromAxisAngle(axis, (ang * i) / N); v.copy(u).applyQuaternion(q).multiplyScalar(r).add(c);
      this.fp.set([v.x, v.y, v.z], (i + 1) * 3); this.ep.set([v.x, v.y, v.z], i * 3);
    }
    this.fill.geometry.attributes.position.needsUpdate = true; this.edge.geometry.attributes.position.needsUpdate = true;
    q.setFromAxisAngle(axis, ang / 2); this.at.copy(u).applyQuaternion(q).multiplyScalar(r * 1.55).add(c);
    this.label.textContent = text;
  }
}

export class Fx {
  flags: FxFlags = { ...FX_DEFAULT };
  private readonly holo = new THREE.Group();
  private readonly caps: { mesh: THREE.Mesh; len: number; key: string }[] = [];
  private readonly dots: THREE.Points;
  private readonly dotPos: Float32Array; private readonly dotSize: Float32Array; private readonly dotCol: Float32Array;
  private readonly phase: Float32Array;
  private readonly PER = 70;   // particles per leg (plus 3 joint glows)
  private readonly arcs: Record<string, Arc> = {};
  private readonly arcGroup = new THREE.Group();
  private readonly trails: Record<string, Trail> = {};
  private readonly trailGroup = new THREE.Group();
  private readonly prints: Record<Side, THREE.Mesh>;
  private readonly crossing: Record<'hip' | 'knee' | 'ankle', number[]>;
  private time = 0;
  /** Estimated compressive joint load (body weights), for the load paths. */
  readonly load: Record<Side, { hip: number; knee: number; ankle: number }> = { R: { hip: 0, knee: 0, ankle: 0 }, L: { hip: 0, knee: 0, ankle: 0 } };
  /** Angle labels to draw (screen placement happens in the page, which knows about mirroring). */
  readonly labels: Arc[] = [];

  constructor(private readonly stage: Stage, twin: Twin, root: THREE.Group, private readonly labelRoot: HTMLElement) {
    // hologram envelope: capsules along the limbs, ellipsoids for trunk, pelvis and head
    const cap = (key: string) => { const m = new THREE.Mesh(new THREE.BufferGeometry(), HOLO); m.renderOrder = 12; m.frustumCulled = false; this.holo.add(m); this.caps.push({ mesh: m, len: 0, key }); };
    for (const s of SIDES) for (const k of ['thigh', 'shank', 'foot', 'upper', 'fore', 'hand']) cap(`${k}_${s}`);
    for (const k of ['torso', 'pelvis', 'neck', 'head']) cap(k);
    // load paths
    const n = (this.PER + 3) * 2;
    this.dotPos = new Float32Array(n * 3); this.dotSize = new Float32Array(n); this.dotCol = new Float32Array(n * 3);
    this.phase = Float32Array.from({ length: n }, () => Math.random());
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.dotSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.dotCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.dots = new THREE.Points(g, DOTS); this.dots.frustumCulled = false; this.dots.renderOrder = 10;
    const meta = twin.meta, names = meta.muscles.names;
    const crosses = (coords: string[]) => names.map((nm, i) => (coords.some((c) => (meta.arms.r[nm] as Record<string, number[]>)[c].some((r) => Math.abs(r) > 0.004)) ? i : -1)).filter((i) => i >= 0);
    this.crossing = { hip: crosses(['hip_flex', 'hip_add', 'hip_rot']), knee: crosses(['knee_flex']), ankle: crosses(['ankle_flex']) };
    // angle arcs
    const col = { R: 0xff9a6b, L: 0x9fdcff };
    for (const s of SIDES) for (const j of ['knee', 'hip', 'elbow']) { const a = new Arc(labelRoot, col[s]); this.arcs[`${j}_${s}`] = a; this.arcGroup.add(a.group); this.labels.push(a); }
    // trails
    const tc: Record<string, THREE.Color> = { knee_R: new THREE.Color(1, 0.55, 0.35), knee_L: new THREE.Color(0.55, 0.85, 1), wrist_R: new THREE.Color(1, 0.8, 0.6), wrist_L: new THREE.Color(0.7, 0.9, 1), com: new THREE.Color(1, 0.9, 0.55) };
    for (const [k, c] of Object.entries(tc)) { this.trails[k] = new Trail(k === 'com' ? 120 : 50, c); this.trailGroup.add(this.trails[k].line); }
    // foot prints
    const print = () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), PRESS.clone()); m.renderOrder = 5; return m; };
    this.prints = { R: print(), L: print() };
    root.add(this.holo, this.dots, this.arcGroup, this.trailGroup, this.prints.R, this.prints.L);
    this.setVisible(false);
  }

  private setVisible(all: boolean) {
    const f = this.flags;
    this.holo.visible = all || f.holo; this.dots.visible = all || f.load; this.arcGroup.visible = all || f.arcs;
    this.trailGroup.visible = all || f.trails; this.prints.R.visible = this.prints.L.visible = all || f.pressure;
    this.labelRoot.hidden = !f.arcs;
  }

  warm() { this.setVisible(true); }

  /** Named joint centres of a (displayed) pose. */
  joints(seg: Record<string, SegPose>, ref: Record<string, THREE.Vector3>): J {
    const at = (k: string, local: THREE.Vector3) => local.clone().multiplyScalar(seg[k].scale).applyQuaternion(seg[k].quat).add(seg[k].pos);
    const j: J = { lumbar: seg.torso.pos.clone(), neck: seg.head.pos.clone(), headTop: at('head', ref.headTop), headC: at('head', ref.headCenter) };
    for (const s of SIDES) {
      j[`hip_${s}`] = seg[`femur_${s}`].pos.clone(); j[`knee_${s}`] = seg[`tibia_${s}`].pos.clone();
      j[`ankle_${s}`] = at(`foot_${s}`, ref[`ankleF_${s}`]); j[`heel_${s}`] = at(`foot_${s}`, ref[`heel_${s}`]); j[`toe_${s}`] = at(`foot_${s}`, ref[`toe_${s}`]);
      j[`shoulder_${s}`] = seg[`humerus_${s}`].pos.clone(); j[`elbow_${s}`] = seg[`forearm_${s}`].pos.clone(); j[`wrist_${s}`] = seg[`hand_${s}`].pos.clone();
      j[`fingers_${s}`] = seg[`middle_d_${s}`].pos.clone();
    }
    j.pelvisC = j.hip_R.clone().add(j.hip_L).multiplyScalar(0.5);
    return j;
  }

  update(j: J, seg: Record<string, SegPose>, com: THREE.Vector3, phys: PhysView, dt: number, meta: TwinMeta, mirror: boolean) {
    this.time += dt;
    this.setVisible(false);
    const f = this.flags, sc = seg.femur_R.scale;
    // joint loads (body weights): ground force plus the muscles pulling across each joint
    for (const s of SIDES) {
      const r = phys.res[s], g = r.grf.length();
      const sum = (ids: number[]) => ids.reduce((a, i) => a + r.force[i], 0);
      this.load[s].ankle = (g + sum(this.crossing.ankle)) / phys.bodyWeight;
      this.load[s].knee = (g + sum(this.crossing.knee)) / phys.bodyWeight;
      this.load[s].hip = (g + sum(this.crossing.hip)) / phys.bodyWeight;
    }
    if (f.holo) this.updateHolo(j, seg, sc);
    if (f.load) this.updateLoad(j, phys, dt);
    if (f.arcs) this.updateArcs(j, seg);
    if (f.trails) {
      for (const k of ['knee_R', 'knee_L', 'wrist_R', 'wrist_L']) this.trails[k].push(j[k]);
      this.trails.com.push(new THREE.Vector3(com.x, mirror ? com.y : 0.006, com.z));
    }
    if (f.pressure) for (const s of SIDES) {
      const h = j[`heel_${s}`], t = j[`toe_${s}`], m = this.prints[s], u = (m.material as THREE.ShaderMaterial).uniforms;
      const d = t.clone().sub(h).setY(0), L = Math.max(d.length(), 0.05);
      m.position.set((h.x + t.x) / 2, 0.005, (h.z + t.z) / 2);
      m.rotation.set(0, -Math.atan2(d.z, d.x), 0);
      m.scale.set(L * 1.2, 1, L * 0.5);
      const cop = phys.res[s].cop, rel = cop.clone().sub(h).setY(0), fwd = d.clone().normalize(), lat = new THREE.Vector3(-fwd.z, 0, fwd.x);
      u.uCop.value.set(THREE.MathUtils.clamp(rel.dot(fwd) / (L * 1.2) + 0.08, 0, 1), THREE.MathUtils.clamp(rel.dot(lat) / (L * 0.25), -1, 1));
      u.uLoad.value = Math.min(phys.res[s].grf.y / phys.bodyWeight * 1.6, 1.4);
      m.visible = Math.max(h.y, t.y) < 0.12 && !mirror;
    }
    HOLO.uniforms.uTime.value = this.time;
    void meta;
  }

  private updateHolo(j: J, seg: Record<string, SegPose>, sc: number) {
    const span: Record<string, [string, string, number]> = {};
    for (const s of SIDES) {
      span[`thigh_${s}`] = [`hip_${s}`, `knee_${s}`, 0.072]; span[`shank_${s}`] = [`knee_${s}`, `ankle_${s}`, 0.05];
      span[`foot_${s}`] = [`heel_${s}`, `toe_${s}`, 0.036]; span[`upper_${s}`] = [`shoulder_${s}`, `elbow_${s}`, 0.046];
      span[`fore_${s}`] = [`elbow_${s}`, `wrist_${s}`, 0.036]; span[`hand_${s}`] = [`wrist_${s}`, `fingers_${s}`, 0.03];
    }
    span.neck = ['neck', 'headC', 0.045];
    for (const c of this.caps) {
      let a: THREE.Vector3, b: THREE.Vector3, r: number, scl = new THREE.Vector3(1, 1, 1), q: THREE.Quaternion | null = null;
      if (span[c.key]) { const [p0, p1, rr] = span[c.key]; a = j[p0]; b = j[p1]; r = rr * sc; }
      else if (c.key === 'torso') { a = j.lumbar; b = j.neck.clone().lerp(j.lumbar, 0.08); r = 0.125 * sc; scl.set(0.78, 1, 1.32); q = seg.torso.quat; }
      else if (c.key === 'pelvis') { a = j.pelvisC.clone().addScaledVector(UP, -0.02); b = j.lumbar; r = 0.105 * sc; scl.set(0.95, 1, 1.45); q = seg.pelvis.quat; }
      else { a = j.headC.clone().addScaledVector(UP, -0.05 * sc); b = j.headC.clone().addScaledVector(UP, 0.06 * sc); r = 0.09 * sc; scl.set(1.12, 1, 0.92); q = seg.head.quat; }
      const len = Math.max(a.distanceTo(b), 0.001);
      if (Math.abs(len - c.len) > 0.004 || !c.len) { c.mesh.geometry.dispose(); c.mesh.geometry = new THREE.CapsuleGeometry(r, len, 6, 20); c.len = len; }
      c.mesh.position.copy(a).add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a).normalize();
      if (q) {
        // ellipsoid parts follow their segment's orientation, with the capsule's axis on the segment's long line
        c.mesh.quaternion.copy(q).premultiply(new THREE.Quaternion().setFromUnitVectors(UP.clone().applyQuaternion(q), dir));
      } else c.mesh.quaternion.setFromUnitVectors(UP, dir);
      c.mesh.scale.copy(scl);
    }
  }

  private updateLoad(j: J, phys: PhysView, dt: number) {
    const col = new THREE.Color(), p = new THREE.Vector3();
    let o = 0;
    for (const s of SIDES) {
      const L = this.load[s], g = phys.res[s].grf.y / phys.bodyWeight;
      const cop = phys.res[s].cop.clone().setY(0.01);
      const path = [cop, j[`ankle_${s}`], j[`knee_${s}`], j[`hip_${s}`], j.pelvisC.clone().lerp(j.lumbar, 0.6)];
      const segLoad = [L.ankle, L.knee, L.hip, L.hip * 0.6];
      const lens = path.slice(1).map((q, i) => q.distanceTo(path[i])), total = lens.reduce((a, b) => a + b, 0) || 1;
      const on = g > 0.04;
      for (let i = 0; i < this.PER; i++, o++) {
        this.phase[o] = (this.phase[o] + dt * (0.25 + 0.55 * Math.min(L.knee, 4))) % 1;
        let d = this.phase[o] * total, k = 0;
        while (k < lens.length - 1 && d > lens[k]) { d -= lens[k]; k++; }
        p.lerpVectors(path[k], path[k + 1], Math.min(d / (lens[k] || 1), 1));
        const jit = 0.012 * Math.sin(o * 12.9898 + this.time * 3);
        p.x += jit; p.z += 0.012 * Math.cos(o * 78.233 + this.time * 2.3);
        const bw = segLoad[k];
        this.dotPos.set([p.x, p.y, p.z], o * 3);
        this.dotSize[o] = on ? 0.012 + 0.008 * Math.min(bw, 4) : 0;
        loadColour(bw, col).multiplyScalar(0.55 + 0.45 * Math.min(bw / 3, 1));
        this.dotCol.set([col.r, col.g, col.b], o * 3);
      }
      // a glow at each joint, sized by its load
      (['ankle', 'knee', 'hip'] as const).forEach((jn) => {
        const q = j[`${jn}_${s}`], bw = L[jn];
        this.dotPos.set([q.x, q.y, q.z], o * 3);
        this.dotSize[o] = on ? 0.05 + 0.03 * Math.min(bw, 5) : 0;
        loadColour(bw, col).multiplyScalar(0.5);
        this.dotCol.set([col.r, col.g, col.b], o * 3);
        o++;
      });
    }
    const g = this.dots.geometry;
    g.attributes.position.needsUpdate = g.attributes.aSize.needsUpdate = g.attributes.aColor.needsUpdate = true;
    DOTS.uniforms.uScale.value = this.stage.renderer.domElement.clientHeight * 2.2;
  }

  private updateArcs(j: J, seg: Record<string, SegPose>) {
    const sc = seg.femur_R.scale;
    for (const s of SIDES) {
      const thigh = j[`knee_${s}`].clone().sub(j[`hip_${s}`]), shank = j[`ankle_${s}`].clone().sub(j[`knee_${s}`]);
      const deg = (v: number) => `${Math.round(THREE.MathUtils.radToDeg(v))}°`;
      this.arcs[`knee_${s}`].set(j[`knee_${s}`], thigh, shank, 0.09 * sc, deg(thigh.angleTo(shank)));
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(seg.pelvis.quat);
      this.arcs[`hip_${s}`].set(j[`hip_${s}`], down, thigh, 0.11 * sc, deg(down.angleTo(thigh)));
      const up = j[`elbow_${s}`].clone().sub(j[`shoulder_${s}`]), fo = j[`wrist_${s}`].clone().sub(j[`elbow_${s}`]);
      this.arcs[`elbow_${s}`].set(j[`elbow_${s}`], up, fo, 0.07 * sc, deg(up.angleTo(fo)));
    }
  }

  clearTrails() { Object.values(this.trails).forEach((t) => t.clear()); }
}
