import * as THREE from 'three';
import type { Clip } from './data';

/** Pale resting muscle -> deep red when fully active; tendon ends glossy off-white. */
const REST = new THREE.Color(0.40, 0.14, 0.12), ACTIVE = new THREE.Color(0.58, 0.03, 0.025);
const TENDON = new THREE.Color(0.86, 0.82, 0.74);
const SHEEN = new THREE.Color(0.95, 0.55, 0.5), BLACK = new THREE.Color(0, 0, 0);
const SEG = 40, RAD = 12;          // tube resolution along / around each muscle
const AXES = ['x', 'y', 'z'] as const;
const COS = Float32Array.from({ length: RAD + 1 }, (_, j) => Math.cos((j / RAD) * Math.PI * 2));
const SIN = Float32Array.from({ length: RAD + 1 }, (_, j) => Math.sin((j / RAD) * Math.PI * 2));
const ACT_FULL = 0.4;              // activation drawn as fully saturated (same scale as the film)

const BONE = new THREE.MeshPhysicalMaterial({
  color: 0xf1e8d6, vertexColors: true, roughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.55,
  sheen: 0.3, sheenColor: new THREE.Color(0xfff2dc), sheenRoughness: 0.6,
});

/** Fusiform radius profile along a muscle: thin tendon at both ends, full belly between. */
function profile(u: number) {
  const v = Math.min(Math.max((u - 0.12) / 0.76, 0), 1);
  return 0.18 + 0.82 * Math.sin(Math.PI * v) ** 0.8;
}

class MuscleTube {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  readonly mat: THREE.MeshPhysicalMaterial;
  private readonly pts: THREE.Vector3[];
  belly: number;

  constructor(readonly name: string, fmax: number, nPath: number) {
    this.belly = 0.007 + 0.00032 * Math.sqrt(fmax);
    this.pts = Array.from({ length: nPath }, () => new THREE.Vector3());
    const nv = (SEG + 1) * (RAD + 1);
    this.pos = new Float32Array(nv * 3);
    this.nrm = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const idx: number[] = [];
    for (let i = 0; i <= SEG; i++) for (let j = 0; j <= RAD; j++) {
      uv.set([i / SEG, j / RAD], (i * (RAD + 1) + j) * 2);
      if (i < SEG && j < RAD) {
        const a = i * (RAD + 1) + j, b = a + RAD + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.mat = new THREE.MeshPhysicalMaterial({
      color: REST.clone(), roughness: 0.48, clearcoat: 0.55, clearcoatRoughness: 0.16,   // wet fascia
      sheen: 0.6, sheenColor: SHEEN.clone(), sheenRoughness: 0.45,
    });
    // tendon ends: lighter and glossier, driven by u along the muscle
    this.mat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying float vU;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvU = uv.x;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
        varying float vU;
        float tendonMask() { return 1.0 - smoothstep(0.16, 0.26, vU) + smoothstep(0.74, 0.84, vU); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${TENDON.r}, ${TENDON.g}, ${TENDON.b}), tendonMask());`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.22, tendonMask());');
    };
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
  }

  private static readonly T = new THREE.Vector3();
  private static readonly N = new THREE.Vector3();
  private static readonly B = new THREE.Vector3();
  private static readonly P = new THREE.Vector3();
  private static readonly up = new THREE.Vector3(0, 0, 1);

  /** Healthy max force, so X-ray colours a weakened muscle by what it can no longer deliver. */
  fmaxRef = 1;
  xray = false;
  load = 0;

  /**
   * Uniform Catmull-Rom position (P) and tangent (T) at u in [0, 1]. The exported path points are
   * already evenly spaced by arc length, so no arc-length remapping is needed; nothing allocates.
   */
  private sample(u: number, P: THREE.Vector3, T: THREE.Vector3) {
    const p = this.pts, n = p.length - 1;
    const x = u * n, i = Math.min(Math.floor(x), n - 1), s = x - i;
    const p1 = p[i], p2 = p[i + 1];
    const p0 = i > 0 ? p[i - 1] : null, p3 = i + 2 <= n ? p[i + 2] : null;
    const s2 = s * s, s3 = s2 * s;
    for (const c of AXES) {
      const b = p1[c], e = p2[c];
      const a = p0 ? p0[c] : 2 * b - e, d = p3 ? p3[c] : 2 * e - b;   // reflected ends
      const c1 = -a + e, c2 = 2 * a - 5 * b + 4 * e - d, c3 = -a + 3 * b - 3 * e + d;
      P[c] = 0.5 * (2 * b + c1 * s + c2 * s2 + c3 * s3);
      T[c] = 0.5 * (c1 + 2 * c2 * s + 3 * c3 * s2);
    }
    T.normalize();
  }

  update(points: ArrayLike<number>, base: number, activation: number) {
    for (let k = 0; k < this.pts.length; k++) this.pts[k].set(points[base + k * 3], points[base + k * 3 + 1], points[base + k * 3 + 2]);
    const { T, N, B, P, up } = MuscleTube;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      this.sample(u, P, T);
      // a stable frame: the walkers move in the x-y plane, so z is never parallel to a muscle
      B.crossVectors(T, up).normalize(); N.crossVectors(B, T).normalize();
      const r = this.belly * profile(u);
      for (let j = 0; j <= RAD; j++) {
        const c = COS[j], s = SIN[j];
        const o = (i * (RAD + 1) + j) * 3;
        const nx = N.x * c + B.x * s, ny = N.y * c + B.y * s, nz = N.z * c + B.z * s;
        this.pos[o] = P.x + nx * r; this.pos[o + 1] = P.y + ny * r; this.pos[o + 2] = P.z + nz * r;
        this.nrm[o] = nx; this.nrm[o + 1] = ny; this.nrm[o + 2] = nz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    if (this.xray) {
      loadColor(Math.min(this.load / this.fmaxRef / LOAD_FULL, 1), this.mat.color);
      this.mat.emissive.copy(this.mat.color).multiplyScalar(0.85);
    } else {
      this.mat.color.copy(REST).lerp(ACTIVE, Math.min(activation / ACT_FULL, 1));
      this.mat.emissive.setRGB(0, 0, 0);
    }
  }
}

/** X-ray: tendon force as a fraction of the healthy max, on a dark-blue -> amber -> white ramp. */
const LOAD_FULL = 0.45;
const RAMP = [[0.012, 0.02, 0.05], [0.04, 0.09, 0.26], [0.72, 0.17, 0.06], [1.0, 0.5, 0.1], [1.0, 0.88, 0.62]];
function loadColor(x: number, out: THREE.Color) {
  const s = x * (RAMP.length - 1), i = Math.min(Math.floor(s), RAMP.length - 2), w = s - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w);
}

/** Ground reaction force arrow, drawn from the centre of pressure. */
class ForceArrow {
  readonly group = new THREE.Group();
  private static readonly MAT = new THREE.MeshBasicMaterial({ color: 0x9fe2ff, transparent: true, opacity: 0.85, depthWrite: false });
  private readonly shaft: THREE.Mesh;
  private readonly tip: THREE.Mesh;
  private static readonly dir = new THREE.Vector3();
  private static readonly yAxis = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 1, 10).translate(0, 0.5, 0), ForceArrow.MAT);
    this.tip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.05, 14).translate(0, 0.025, 0), ForceArrow.MAT);
    this.group.add(this.shaft, this.tip);
    this.group.renderOrder = 5;
    this.group.visible = false;
  }

  set(x: number, z: number, fx: number, fy: number, bw: number) {
    const mag = Math.hypot(fx, fy);
    this.group.visible = mag > 0.04 * bw;
    if (!this.group.visible) return;
    const len = (mag / bw) * 0.55;
    this.group.position.set(x, 0.002, z);
    this.group.quaternion.setFromUnitVectors(ForceArrow.yAxis, ForceArrow.dir.set(fx / mag, fy / mag, 0));
    this.shaft.scale.set(1, Math.max(len - 0.05, 0.001), 1);
    this.tip.position.y = Math.max(len - 0.05, 0.001);
  }
}

/**
 * A walker: bones from bones.glb placed by the clip's per-frame transforms, plus live muscles.
 * It can also show a blend of two runs (the weakness dial): both are sampled at the same gait
 * phase, positions and muscle paths are lerped and bone rotations slerped.
 */
export class Twin {
  readonly group = new THREE.Group();
  readonly muscles: MuscleTube[];
  private readonly bones: THREE.Mesh[] = [];
  private readonly frame: Float32Array;
  private readonly frameB: Float32Array;
  private readonly q0 = new THREE.Quaternion();
  private readonly q1 = new THREE.Quaternion();
  private readonly qa: THREE.Quaternion[];
  private readonly qb: THREE.Quaternion[];
  private readonly arrows = { r: new ForceArrow(), l: new ForceArrow() };
  private readonly footIdx: { r: number; l: number };
  ghost = false;
  xray = false;
  /** Blend sources: clip `a`, or a -> b with weight w. */
  a: Clip; b: Clip | null = null; w = 0;

  constructor(readonly clip: Clip, boneGeo: Map<string, THREE.BufferGeometry>, public offsetX: number) {
    this.a = clip;
    this.group.position.x = offsetX;
    for (const m of clip.h.meshes) {
      const g = boneGeo.get(m.file);
      if (!g) throw new Error(`bone ${m.file} missing from bones.glb`);
      const mesh = new THREE.Mesh(g, BONE.clone());
      mesh.scale.fromArray(m.scale);
      mesh.matrixAutoUpdate = true;
      this.bones.push(mesh);
      this.group.add(mesh);
    }
    this.muscles = clip.h.muscles.map((m) => new MuscleTube(m.name, m.fmax, clip.h.nPath));
    // both walkers are drawn with healthy muscle sizes: weakness is lost force, not visible atrophy
    for (const t of this.muscles) this.group.add(t.mesh);
    this.muscles.forEach((t, k) => (t.fmaxRef = clip.h.muscles[k].fmax));
    this.frame = new Float32Array(clip.h.stride);
    this.frameB = new Float32Array(clip.h.stride);
    this.qa = this.bones.map(() => new THREE.Quaternion());
    this.qb = this.bones.map(() => new THREE.Quaternion());
    const files = clip.h.meshes.map((m) => m.file);
    this.footIdx = { r: files.indexOf('r_foot'), l: files.indexOf('l_foot') };
    this.group.add(this.arrows.r.group, this.arrows.l.group);
  }

  /** Healthy muscle sizes (and healthy max forces for X-ray) for both twins (call with the healthy twin). */
  matchSizes(healthy: Twin) {
    this.muscles.forEach((t, i) => { t.belly = healthy.muscles[i].belly; t.fmaxRef = healthy.muscles[i].fmaxRef; });
  }

  /** Show run `a`, or a blend a -> b with weight w (0-1). */
  setSource(a: Clip, b: Clip | null = null, w = 0) { this.a = a; this.b = w > 0 ? b : null; this.w = b ? w : 0; }

  /** Played stride length of what is shown (blended). */
  get strideSeconds() { return this.b ? this.a.strideSeconds * (1 - this.w) + this.b.strideSeconds * this.w : this.a.strideSeconds; }

  /** Max isometric force of muscle k in what is shown. */
  fmax(k: number) { const fa = this.a.h.muscles[k].fmax; return this.b ? fa * (1 - this.w) + this.b.h.muscles[k].fmax * this.w : fa; }

  /** Frame at fractional frame index x of clip c, into `out` (+ bone rotations into q). */
  private fill(c: Clip, x: number, out: Float32Array, q: THREE.Quaternion[]) {
    const s = c.h.stride, d = c.data, n = c.h.frames;
    const f0 = Math.floor(x) % n, f1 = (f0 + 1) % n, w = x - Math.floor(x);
    const a = f0 * s, b = f1 * s;
    for (let k = 0; k < s; k++) out[k] = d[a + k] * (1 - w) + d[b + k] * w;
    for (let i = 0; i < q.length; i++) {
      const o = i * 7;
      this.q0.set(d[a + o + 3], d[a + o + 4], d[a + o + 5], d[a + o + 6]);
      this.q1.set(d[b + o + 3], d[b + o + 4], d[b + o + 5], d[b + o + 6]);
      q[i].slerpQuaternions(this.q0, this.q1, w);
    }
  }

  /** Interpolated frame at clip time t (positions lerped, rotations slerped). */
  update(t: number) {
    const c = this.a, x = (((t * c.h.fps) % c.h.frames) + c.h.frames) % c.h.frames;
    this.fill(c, x, this.frame, this.qa);
    this.apply();
  }

  /** Frame at gait phase p (0-1), blended between the two sources when the dial sits between runs. */
  updatePhase(p: number) {
    this.fill(this.a, this.a.frameAtPhase(p), this.frame, this.qa);
    if (this.b) {
      const w = this.w;
      this.fill(this.b, this.b.frameAtPhase(p), this.frameB, this.qb);
      for (let k = 0; k < this.frame.length; k++) this.frame[k] = this.frame[k] * (1 - w) + this.frameB[k] * w;
      for (let i = 0; i < this.qa.length; i++) this.qa[i].slerp(this.qb[i], w);
    }
    this.apply();
  }

  private apply() {
    const c = this.clip, f = this.frame;
    for (let i = 0; i < this.bones.length; i++) {
      const o = i * 7;
      this.bones[i].position.set(f[o], f[o + 1], f[o + 2]);
      this.bones[i].quaternion.copy(this.qa[i]);
    }
    for (let k = 0; k < this.muscles.length; k++) {
      this.muscles[k].load = f[c.oForce + k];
      this.muscles[k].update(f, c.oPath + k * c.P * 3, f[c.oAct + k]);
    }
    const bw = c.h.mass * 9.80665;
    for (const [side, o] of [['r', c.oGrf], ['l', c.oGrf + 3]] as const) {
      const foot = this.footIdx[side];
      this.arrows[side].group.visible = false;
      if (this.xray) this.arrows[side].set(f[o + 2], f[foot * 7 + 2], f[o], f[o + 1], bw);
    }
  }

  get values() { return this.frame; }

  /** World-space foot contact info for the floor shadows: [x, z, height, size]. */
  feet(out: THREE.Vector4[]) {
    out.length = 0;
    for (let i = 0; i < this.bones.length; i++) {
      const f = this.clip.h.meshes[i].file;
      if (f !== 'r_foot' && f !== 'l_foot' && f !== 'r_bofoot' && f !== 'l_bofoot') continue;
      const p = this.bones[i].position;
      out.push(new THREE.Vector4(p.x + this.offsetX + (f.endsWith('bofoot') ? 0.0 : 0.06), p.z, Math.max(p.y - 0.03, 0), f.endsWith('bofoot') ? 0.07 : 0.11));
    }
    return out;
  }

  setGhost(on: boolean) { this.ghost = on; this.look(); }

  /** Make the force arrows visible for one shader warm-up pass (they are normally hidden until loaded). */
  showArrowsForWarmup() { this.arrows.r.group.visible = this.arrows.l.group.visible = true; }

  /** X-ray: glassy bones, muscles coloured by load, ground force arrows. */
  setXray(on: boolean) {
    this.xray = on;
    // Only uniforms change here (never sheen/clearcoat on-off), so no shader is recompiled on toggle.
    for (const t of this.muscles) {
      t.xray = on;
      t.mat.sheenColor.copy(on ? BLACK : SHEEN);   // no fascia sheen: the colour is the data
      t.mat.clearcoat = on ? 0.3 : 0.55;
      t.mat.envMapIntensity = on ? 0.18 : 1;   // studio reflections would wash out the load colours
    }
    this.look();
  }

  private look() {
    const set = (m: THREE.Material, opacity: number) => {
      const t = opacity < 1;
      if (m.transparent !== t || m.opacity !== opacity) { m.transparent = t; m.opacity = opacity; m.depthWrite = !t; m.needsUpdate = true; }
    };
    const boneOpacity = this.ghost ? (this.xray ? 0.06 : 0.18) : this.xray ? 0.14 : 1;
    this.bones.forEach((b) => set(b.material as THREE.Material, boneOpacity));
    this.muscles.forEach((t) => set(t.mat, this.ghost ? (this.xray ? 0.35 : 0.18) : 1));
  }

  pickables() { return this.muscles.map((m) => m.mesh); }
}
