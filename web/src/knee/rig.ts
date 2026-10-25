import * as THREE from 'three';
import type { KneeClip, KneeMeta } from './data';

/**
 * One knee: femur fixed (everything is exported in the distal femur's frame), tibia + fibula and
 * patella placed per frame, every ligament bundle a tube along its OpenSim path (wrapping included),
 * coloured by strain. Torn bundles are drawn as frayed stumps at their real attachments.
 */
const SEG = 18, RAD = 7;
const COS = Float32Array.from({ length: RAD + 1 }, (_, j) => Math.cos((j / RAD) * Math.PI * 2));
const SIN = Float32Array.from({ length: RAD + 1 }, (_, j) => Math.sin((j / RAD) * Math.PI * 2));
const R_LIG = 0.0013;
const SLACK = new THREE.Color(0.30, 0.36, 0.42);
const TAUT = [new THREE.Color(0.96, 0.86, 0.58), new THREE.Color(0.98, 0.52, 0.16), new THREE.Color(0.86, 0.12, 0.07)];
const STRAIN_FULL = 8;   // % strain drawn as deep red

/** Bundle-name prefix -> anatomical structure shown in the legend. */
export const STRUCTURE: Record<string, string> = {
  ACLam: 'ACL', ACLpl: 'ACL', PCLal: 'PCL', PCLpm: 'PCL', LCL: 'LCL', MCLs: 'MCL', MCLd: 'MCL', MCLp: 'POL',
  pCAP: 'CAP', PFL: 'PFL', ITB: 'ITB', PT: 'PT', lPFL: 'PFL_pat', mPFL: 'PFL_pat',
};
export const structureOf = (bundle: string) => STRUCTURE[bundle.replace(/\d+$/, '')] ?? bundle;

/** Strain (%) -> colour; slack bundles are cool grey. */
export function strainColor(s: number, out = new THREE.Color()) {
  if (!(s > 0)) return out.copy(SLACK);
  const x = Math.min(s / STRAIN_FULL, 1) * 2, i = Math.min(Math.floor(x), 1);
  return out.copy(TAUT[i]).lerp(TAUT[i + 1], x - i);
}

class Tube {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.MeshPhysicalMaterial;
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly geo = new THREE.BufferGeometry();
  private static readonly T = new THREE.Vector3();
  private static readonly N = new THREE.Vector3();
  private static readonly B = new THREE.Vector3();
  private static readonly P = new THREE.Vector3();
  private static readonly A = new THREE.Vector3();

  constructor(readonly name: string, private readonly taper: (u: number) => number) {
    const nv = (SEG + 1) * (RAD + 1);
    this.pos = new Float32Array(nv * 3); this.nrm = new Float32Array(nv * 3);
    const idx: number[] = [];
    for (let i = 0; i < SEG; i++) for (let j = 0; j < RAD; j++) {
      const a = i * (RAD + 1) + j, b = a + RAD + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.MeshPhysicalMaterial({ color: SLACK.clone(), roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.2, sheen: 0.4, sheenColor: new THREE.Color(0.9, 0.85, 0.8) });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
  }

  /** Polyline pts (n points, xyz) between u0 and u1 of its length, piecewise-linear (paths are short). */
  update(pts: ArrayLike<number>, base: number, n: number, u0 = 0, u1 = 1) {
    const { T, N, B, P, A } = Tube;
    let total = 0;
    for (let k = 1; k < n; k++) total += Math.hypot(pts[base + k * 3] - pts[base + k * 3 - 3], pts[base + k * 3 + 1] - pts[base + k * 3 - 2], pts[base + k * 3 + 2] - pts[base + k * 3 - 1]);
    for (let i = 0; i <= SEG; i++) {
      const u = u0 + (u1 - u0) * (i / SEG);
      let target = u * total, k = 1, acc = 0, len = 0;
      for (; k < n; k++) {
        len = Math.hypot(pts[base + k * 3] - pts[base + k * 3 - 3], pts[base + k * 3 + 1] - pts[base + k * 3 - 2], pts[base + k * 3 + 2] - pts[base + k * 3 - 1]);
        if (acc + len >= target || k === n - 1) break;
        acc += len;
      }
      const w = len > 0 ? Math.min(Math.max((target - acc) / len, 0), 1) : 0, o0 = base + (k - 1) * 3, o1 = base + k * 3;
      P.set(pts[o0] + (pts[o1] - pts[o0]) * w, pts[o0 + 1] + (pts[o1 + 1] - pts[o0 + 1]) * w, pts[o0 + 2] + (pts[o1 + 2] - pts[o0 + 2]) * w);
      T.set(pts[o1] - pts[o0], pts[o1 + 1] - pts[o0 + 1], pts[o1 + 2] - pts[o0 + 2]).normalize();
      A.set(Math.abs(T.x) < 0.9 ? 1 : 0, Math.abs(T.x) < 0.9 ? 0 : 1, 0);
      B.crossVectors(T, A).normalize(); N.crossVectors(B, T);
      const r = R_LIG * this.taper(i / SEG);
      for (let j = 0; j <= RAD; j++) {
        const o = (i * (RAD + 1) + j) * 3, nx = N.x * COS[j] + B.x * SIN[j], ny = N.y * COS[j] + B.y * SIN[j], nz = N.z * COS[j] + B.z * SIN[j];
        this.pos[o] = P.x + nx * r; this.pos[o + 1] = P.y + ny * r; this.pos[o + 2] = P.z + nz * r;
        this.nrm[o] = nx; this.nrm[o + 1] = ny; this.nrm[o + 2] = nz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }
}

const BONE = new THREE.MeshPhysicalMaterial({ color: 0xece2cf, roughness: 0.52, clearcoat: 0.12, clearcoatRoughness: 0.6, sheen: 0.25, sheenColor: new THREE.Color(0xfff2dc) });
const CART = new THREE.MeshPhysicalMaterial({ color: 0x9fc6db, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 });
const CART_GLASS = new THREE.MeshPhysicalMaterial({ color: 0x9fc6db, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08, transparent: true, opacity: 0.28, depthWrite: false });
/** X-ray glass: bone silhouettes glow at their rims and are clear in the middle, so the cruciates show through. */
const GLASS = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uColor: { value: new THREE.Color(0.80, 0.90, 0.98) } },
  vertexShader: /* glsl */ `
    varying vec3 vN; varying vec3 vV;
    void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
    void main() {
      float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
      float a = 0.04 + 0.62 * pow(rim, 2.4);
      gl_FragColor = vec4(uColor, a);
    }`,
});

export class KneeRig {
  readonly group = new THREE.Group();
  readonly tibia = new THREE.Group();
  readonly patella = new THREE.Group();
  readonly tubes: Tube[] = [];
  private readonly stumps = new Map<number, [Tube, Tube]>();
  private frame: Float32Array;
  private readonly q0 = new THREE.Quaternion();
  private readonly q1 = new THREE.Quaternion();
  private readonly arrow = new THREE.Group();
  private readonly arc = new THREE.Group();
  private readonly bones: THREE.Mesh[] = [];
  private readonly cartilage: THREE.Mesh[] = [];
  private readonly solid = BONE.clone();
  private readonly col = new THREE.Color();
  focus: string | null = null;   // ligament group to highlight (others dim)
  values: Float32Array;

  constructor(readonly meta: KneeMeta, meshes: Map<string, THREE.BufferGeometry>, readonly injured: boolean) {
    const femur = new THREE.Group();
    for (const [name, body] of Object.entries(meta.meshes)) {
      const g = meshes.get(name);
      if (!g) continue;
      const cart = name.includes('cartilage');
      const m = new THREE.Mesh(g, cart ? CART : this.solid);
      if (!cart) { this.bones.push(m); m.renderOrder = 2; } else this.cartilage.push(m);
      ({ femur, tibia: this.tibia, patella: this.patella }[body]).add(m);
    }
    this.group.add(femur, this.tibia, this.patella);
    const torn = new Set(injured ? meta.torn : []);
    meta.bundles.forEach((b, i) => {
      if (torn.has(b)) {
        // frayed stumps: a short tapered piece from each attachment
        const s: [Tube, Tube] = [new Tube(b, (u) => 1 - 0.75 * u), new Tube(b, (u) => 0.25 + 0.75 * u)];
        s.forEach((t) => { t.mat.color.setRGB(0.62, 0.16, 0.12); t.mat.transparent = true; t.mat.opacity = 0.9; this.group.add(t.mesh); });
        this.stumps.set(i, s);
        this.tubes.push(s[0]);
      } else {
        const t = new Tube(b, (u) => 0.55 + 0.45 * Math.sin(Math.PI * u));
        this.group.add(t.mesh);
        this.tubes.push(t);
      }
    });
    // applied load: a straight arrow (drawer tests) or a curved one (varus / valgus), in the tibia frame
    const amat = new THREE.MeshBasicMaterial({ color: 0x9fe2ff, transparent: true, opacity: 0.9, depthTest: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0016, 0.0016, 1, 10).translate(0, 0.5, 0), amat);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0055, 0.014, 14), amat);
    shaft.name = 'shaft'; tip.name = 'tip';
    this.arrow.add(shaft, tip); this.arrow.renderOrder = 10;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.0016, 8, 48, Math.PI * 1.3), amat);
    const rtip = new THREE.Mesh(new THREE.ConeGeometry(0.0055, 0.014, 14), amat);
    ring.name = 'ring'; rtip.name = 'rtip';
    this.arc.add(ring, rtip); this.arc.renderOrder = 10;
    this.tibia.add(this.arrow, this.arc);
    this.frame = new Float32Array(1);
    this.values = this.frame;
  }

  /** Swap bones (and cartilage) between solid and X-ray glass (separate materials: no shader recompiles). */
  setGlass(on: boolean) {
    for (const m of this.bones) m.material = on ? GLASS : this.solid;
    for (const m of this.cartilage) m.material = on ? CART_GLASS : CART;
  }

  /** Pose everything at time t of clip c (positions lerped, rotations slerped). */
  update(c: KneeClip, t: number, test: { load: string; dir: number }) {
    if (this.frame.length !== c.stride) this.frame = new Float32Array(c.stride);
    const f = this.frame, d = c.data, s = c.stride, { f0, f1, w } = c.at(t), a = f0 * s, b = f1 * s;
    for (let k = 0; k < s; k++) f[k] = d[a + k] * (1 - w) + d[b + k] * w;
    this.values = f;
    for (const [grp, o] of [[this.tibia, c.oTib], [this.patella, c.oPat]] as const) {
      grp.position.set(f[o], f[o + 1], f[o + 2]);
      this.q0.set(d[a + o + 3], d[a + o + 4], d[a + o + 5], d[a + o + 6]);
      this.q1.set(d[b + o + 3], d[b + o + 4], d[b + o + 5], d[b + o + 6]);
      grp.quaternion.slerpQuaternions(this.q0, this.q1, w);
    }
    const K = c.K;
    c.meta.bundles.forEach((name, i) => {
      const base = c.oPath + i * K * 3, stump = this.stumps.get(i);
      const dim = this.focus !== null && structureOf(name) !== this.focus;
      if (stump) {
        stump[0].update(f, base, K, 0, 0.3); stump[1].update(f, base, K, 0.7, 1);
        for (const t of stump) { t.mat.opacity = dim ? 0.15 : 0.9; }
        return;
      }
      const tube = this.tubes[i];
      // the iliotibial band runs up to the hip: draw only its knee end
      tube.update(f, base, K, name.startsWith('ITB') ? 0.78 : 0, 1);
      strainColor(f[c.oStrain + i], tube.mat.color);
      const taut = f[c.oStrain + i] > 0;
      tube.mat.emissive.copy(taut ? tube.mat.color : this.col.setRGB(0, 0, 0)).multiplyScalar(taut ? 0.25 : 0);
      const op = dim ? 0.12 : taut ? 1 : 0.6;
      if (tube.mat.opacity !== op) { tube.mat.transparent = op < 1; tube.mat.opacity = op; tube.mat.depthWrite = op >= 1; }
    });
    // load arrow at the application point (10 cm below the joint on the tibia)
    const load = f[c.oLoad], mag = Math.abs(load);
    this.arrow.visible = test.load === 'force' && mag > 1;
    this.arc.visible = test.load === 'torque' && mag > 0.1;
    if (this.arrow.visible) {
      const len = 0.012 + (mag / 100) * 0.05, sgn = Math.sign(load);
      this.arrow.position.set(-sgn * (len + 0.014), -0.1, 0);
      this.arrow.rotation.set(0, 0, -sgn * Math.PI / 2);
      const sh = this.arrow.getObjectByName('shaft')!, tp = this.arrow.getObjectByName('tip')!;
      sh.scale.set(1, len, 1); tp.position.set(0, len + 0.007, 0);
    }
    if (this.arc.visible) {
      const sgn = Math.sign(load), k = 0.5 + 0.5 * (mag / 10);
      this.arc.position.set(0, -0.1, 0);
      this.arc.rotation.set(0, Math.PI / 2, 0);
      this.arc.scale.set(k, k * sgn, k);
      const tp = this.arc.getObjectByName('rtip')!, ang = Math.PI * 1.3;
      tp.position.set(0.03 * Math.cos(ang), 0.03 * Math.sin(ang), 0);
      tp.rotation.set(0, 0, ang);
    }
  }

  pickables() { return this.tubes.map((t) => t.mesh); }
}
