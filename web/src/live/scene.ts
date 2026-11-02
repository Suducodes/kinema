import * as THREE from 'three';
import type { Stage } from '../stage';
import { softboxEnvironment, sky } from '../studio';
import type { Twin } from './assets';
import { SIDES, type Body, type SegPose, type Side } from './body';
import type { Physics } from './physics';

/**
 * The live lab: the twin's bones (OpenSim meshes) placed every frame, 88 muscles as tubes along their
 * OpenSim routes coloured by estimated activation, ground force arrows from each foot's centre of
 * pressure, and the centre of mass over the base of support. Lit by the same softbox environment as
 * Twin Walkers; a graphite floor with a capture ring and soft contact shadows.
 */
export type Look = 'muscles' | 'xray' | 'bones';

const N_PTS = 14, SEG = 26, RAD = 10;
const COS = Float32Array.from({ length: RAD + 1 }, (_, j) => Math.cos((j / RAD) * Math.PI * 2));
const SIN = Float32Array.from({ length: RAD + 1 }, (_, j) => Math.sin((j / RAD) * Math.PI * 2));
const REST = new THREE.Color(0.36, 0.12, 0.11), HOT = new THREE.Color(0.95, 0.2, 0.08);
const XRAY = [[0.02, 0.04, 0.10], [0.05, 0.13, 0.36], [0.78, 0.22, 0.07], [1.0, 0.6, 0.14], [1.0, 0.92, 0.72]];
const TENDON = new THREE.Color(0.88, 0.85, 0.78);

const BONE = new THREE.MeshPhysicalMaterial({ color: 0xeee5d3, roughness: 0.5, clearcoat: 0.18, clearcoatRoughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color(0xfff2dc), sheenRoughness: 0.6 });
const GLASS = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uColor: { value: new THREE.Color(0.78, 0.9, 1.0) } },
  vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
  fragmentShader: 'uniform vec3 uColor; varying vec3 vN; varying vec3 vV; void main(){ float rim = 1.0-abs(dot(normalize(vN),normalize(vV))); gl_FragColor = vec4(uColor, 0.03+0.6*pow(rim,2.3)); }',
});

function profile(u: number) { const v = Math.min(Math.max((u - 0.1) / 0.8, 0), 1); return 0.2 + 0.8 * Math.sin(Math.PI * v) ** 0.75; }

/** One muscle: a fusiform tube through its route, tendon ends lighter (shader), colour = activation. */
class Muscle {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.MeshPhysicalMaterial;
  private readonly geo = new THREE.BufferGeometry();
  private readonly pos: Float32Array; private readonly nrm: Float32Array;
  private readonly raw: THREE.Vector3[]; private readonly pts = Array.from({ length: N_PTS }, () => new THREE.Vector3());
  private static readonly T = new THREE.Vector3(); private static readonly N = new THREE.Vector3();
  private static readonly B = new THREE.Vector3(); private static readonly P = new THREE.Vector3(); private static readonly A = new THREE.Vector3();

  constructor(readonly name: string, readonly side: Side, readonly route: [string, THREE.Vector3][], readonly belly: number) {
    this.raw = route.map(() => new THREE.Vector3());
    const nv = (SEG + 1) * (RAD + 1);
    this.pos = new Float32Array(nv * 3); this.nrm = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2), idx: number[] = [];
    for (let i = 0; i <= SEG; i++) for (let j = 0; j <= RAD; j++) {
      uv.set([i / SEG, j / RAD], (i * (RAD + 1) + j) * 2);
      if (i < SEG && j < RAD) { const a = i * (RAD + 1) + j, b = a + RAD + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.mat = new THREE.MeshPhysicalMaterial({ color: REST.clone(), roughness: 0.46, clearcoat: 0.5, clearcoatRoughness: 0.18, sheen: 0.5, sheenColor: new THREE.Color(0.95, 0.6, 0.55), sheenRoughness: 0.45 });
    this.mat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying float vU;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvU = uv.x;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
        varying float vU; float tendonMask() { return 1.0 - smoothstep(0.1, 0.2, vU) + smoothstep(0.8, 0.9, vU); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${TENDON.r}, ${TENDON.g}, ${TENDON.b}), tendonMask() * 0.85);`);
    };
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = `${name}_${side}`;
    this.mesh.frustumCulled = false;
  }

  update(body: { seg: Record<string, SegPose> }, scale: number) {
    // route points to world, then evenly respaced along the route
    let total = 0;
    this.route.forEach(([seg, local], k) => {
      const p = body.seg[seg];
      this.raw[k].copy(local).multiplyScalar(p.scale).applyQuaternion(p.quat).add(p.pos);
      if (k) total += this.raw[k].distanceTo(this.raw[k - 1]);
    });
    let k = 1, acc = 0;
    for (let i = 0; i < N_PTS; i++) {
      const target = (i / (N_PTS - 1)) * total;
      while (k < this.raw.length - 1 && acc + this.raw[k].distanceTo(this.raw[k - 1]) < target) { acc += this.raw[k].distanceTo(this.raw[k - 1]); k++; }
      const seg = this.raw[k].distanceTo(this.raw[k - 1]) || 1;
      this.pts[i].lerpVectors(this.raw[k - 1], this.raw[k], Math.min(Math.max((target - acc) / seg, 0), 1));
    }
    const { T, N, B, P, A } = Muscle, p = this.pts, n = N_PTS - 1;
    for (let i = 0; i <= SEG; i++) {
      const x = (i / SEG) * n, s0 = Math.min(Math.floor(x), n - 1), u = x - s0;
      const p1 = p[s0], p2 = p[s0 + 1], p0 = s0 > 0 ? p[s0 - 1] : null, p3 = s0 + 2 <= n ? p[s0 + 2] : null;
      for (const c of ['x', 'y', 'z'] as const) {
        const b = p1[c], e = p2[c], a = p0 ? p0[c] : 2 * b - e, d = p3 ? p3[c] : 2 * e - b;
        const c1 = -a + e, c2 = 2 * a - 5 * b + 4 * e - d, c3 = -a + 3 * b - 3 * e + d;
        P[c] = 0.5 * (2 * b + c1 * u + c2 * u * u + c3 * u * u * u);
        T[c] = 0.5 * (c1 + 2 * c2 * u + 3 * c3 * u * u);
      }
      T.normalize();
      A.set(Math.abs(T.y) < 0.9 ? 0 : 1, Math.abs(T.y) < 0.9 ? 1 : 0, 0);
      B.crossVectors(T, A).normalize(); N.crossVectors(B, T);
      const r = this.belly * scale * profile(i / SEG);
      for (let j = 0; j <= RAD; j++) {
        const o = (i * (RAD + 1) + j) * 3, nx = N.x * COS[j] + B.x * SIN[j], ny = N.y * COS[j] + B.y * SIN[j], nz = N.z * COS[j] + B.z * SIN[j];
        this.pos[o] = P.x + nx * r; this.pos[o + 1] = P.y + ny * r; this.pos[o + 2] = P.z + nz * r;
        this.nrm[o] = nx; this.nrm[o + 1] = ny; this.nrm[o + 2] = nz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }

  colour(a: number, look: Look) {
    if (look === 'xray') {
      const s = Math.min(a / 0.5, 1) * (XRAY.length - 1), i = Math.min(Math.floor(s), XRAY.length - 2), w = s - i;
      this.mat.color.setRGB(...(XRAY[i].map((v, k) => v + (XRAY[i + 1][k] - v) * w) as [number, number, number]));
      this.mat.emissive.copy(this.mat.color).multiplyScalar(0.9);
    } else {
      const w = Math.min(a / 0.45, 1);
      this.mat.color.copy(REST).lerp(HOT, w);
      this.mat.emissive.copy(HOT).multiplyScalar(0.55 * w * w);
    }
  }
}

class Arrow {
  readonly group = new THREE.Group();
  private readonly shaft: THREE.Mesh; private readonly tip: THREE.Mesh;
  constructor(color = 0x8fe3ff) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 1, 12).translate(0, 0.5, 0), m);
    this.tip = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 16).translate(0, 0.03, 0), m);
    this.group.add(this.shaft, this.tip);
    this.group.renderOrder = 6;
  }
  set(from: THREE.Vector3, vec: THREE.Vector3, perUnit: number) {
    const len = vec.length() * perUnit;
    this.group.visible = len > 0.03;
    if (!this.group.visible) return;
    this.group.position.copy(from);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vec.clone().normalize());
    this.shaft.scale.set(1, Math.max(len - 0.06, 0.001), 1);
    this.tip.position.y = Math.max(len - 0.06, 0.001);
  }
}

export class LiveScene {
  readonly root = new THREE.Group();
  readonly muscles: Muscle[] = [];
  private readonly bones = new Map<string, THREE.Mesh>();
  private readonly arrows: Record<Side, Arrow> = { R: new Arrow(), L: new Arrow() };
  private readonly com: THREE.Mesh;
  private readonly comLine: THREE.Line;
  private readonly comDot: THREE.Mesh;
  private readonly support: THREE.Line;
  private readonly floor: THREE.ShaderMaterial;
  look: Look = 'muscles';
  /** What is drawn: the reconstruction eased toward each new pose at display rate (tracking arrives at
   * 15-30 Hz with a little jitter; the eye wants continuous motion). Physics uses the unsmoothed pose. */
  private readonly shown: { seg: Record<string, SegPose> } = { seg: {} };
  private readonly comShown = new THREE.Vector3();
  private snapNext = true;

  constructor(stage: Stage, private readonly twin: Twin) {
    stage.scene.environment = softboxEnvironment(stage.renderer);
    stage.scene.background = new THREE.Color(0.030, 0.035, 0.039);
    stage.scene.fog = new THREE.FogExp2(new THREE.Color(0.030, 0.035, 0.039).getHex(), 0.06);
    const dome = sky(); dome.renderOrder = 21;
    this.floor = floorMaterial();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 128), this.floor);
    floor.rotation.x = -Math.PI / 2; floor.renderOrder = 20;
    stage.scene.add(dome, floor, this.root);

    for (const [name, g] of twin.geometry) {
      const m = new THREE.Mesh(g, BONE);
      m.matrixAutoUpdate = true;
      this.bones.set(name, m);
      this.root.add(m);
    }
    const meta = twin.meta;
    for (const s of SIDES) {
      for (const name of meta.muscles.names) {
        const route = meta.muscles.routes[name].map(([seg, x, y, z]) => {
          const local = new THREE.Vector3(x, y, s === 'R' ? z : -z);
          return [seg === 'pelvis' ? 'pelvis' : `${seg}_${s}`, local] as [string, THREE.Vector3];
        });
        const fmax = meta.muscles.params[name].fmax;
        const mu = new Muscle(name, s, route, 0.003 + 0.00016 * Math.sqrt(fmax));
        this.muscles.push(mu);
        this.root.add(mu.mesh);
      }
      this.root.add(this.arrows[s].group);
    }
    this.com = new THREE.Mesh(new THREE.SphereGeometry(0.026, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe6a8 }));
    this.com.renderOrder = 7;
    const dash = new THREE.LineDashedMaterial({ color: 0xffe6a8, dashSize: 0.03, gapSize: 0.025, transparent: true, opacity: 0.7 });
    this.comLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), dash);
    this.comDot = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.034, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.9, depthWrite: false }));
    this.support = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 5 }, () => new THREE.Vector3())),
      new THREE.LineBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.55 }));
    this.root.add(this.com, this.comLine, this.comDot, this.support);
  }

  setLook(look: Look) {
    this.look = look;
    for (const m of this.bones.values()) m.material = look === 'xray' ? GLASS : BONE;
    for (const mu of this.muscles) mu.mesh.visible = look !== 'bones';
    for (const mu of this.muscles) { mu.mat.sheenColor.setRGB(look === 'xray' ? 0 : 0.95, look === 'xray' ? 0 : 0.6, look === 'xray' ? 0 : 0.55); mu.mat.envMapIntensity = look === 'xray' ? 0.2 : 1; }
  }

  /** Make every material's shader exist up front (no stall when the look changes). */
  warm(stage: Stage) {
    for (const look of ['xray', 'bones', 'muscles'] as Look[]) { this.setLook(look); stage.renderer.compile(stage.scene, stage.camera); }
  }

  /** Jump straight to the next pose (new source, seek). */
  snap() { this.snapNext = true; }

  /** `dt` (s) since the last draw; 0 shows the pose exactly. */
  update(body: Body, phys: Physics, showForces: boolean, dt = 0) {
    const a = this.snapNext || dt <= 0 ? 1 : 1 - Math.exp(-dt / 0.045);
    for (const [k, p] of Object.entries(body.seg)) {
      const d = (this.shown.seg[k] ??= { pos: p.pos.clone(), quat: p.quat.clone(), scale: p.scale });
      if (a >= 1 || d.pos.distanceToSquared(p.pos) > 0.25) { d.pos.copy(p.pos); d.quat.copy(p.quat); d.scale = p.scale; }
      else { d.pos.lerp(p.pos, a); d.quat.slerp(p.quat, a); d.scale += (p.scale - d.scale) * a; }
    }
    if (a >= 1) this.comShown.copy(body.pts.com); else this.comShown.lerp(body.pts.com, a);
    this.snapNext = false;
    const seg = this.shown.seg;
    for (const [name, mesh] of this.bones) {
      const p = seg[name];
      if (!p) continue;
      mesh.position.copy(p.pos); mesh.quaternion.copy(p.quat); mesh.scale.setScalar(p.scale);
    }
    const names = this.twin.meta.muscles.names;
    for (let i = 0; i < this.muscles.length; i++) {
      const mu = this.muscles[i], k = i % names.length;
      if (this.look === 'bones') continue;
      mu.update(this.shown, seg[`femur_${mu.side}`].scale);
      mu.colour(phys.res[mu.side].act[k], this.look);
    }
    for (const s of SIDES) this.arrows[s].set(phys.res[s].cop.clone().setY(0.003), showForces ? phys.res[s].grf : new THREE.Vector3(), 0.55 / phys.bodyWeight);
    const c = this.comShown;
    this.com.position.copy(c);
    const lp = this.comLine.geometry.attributes.position as THREE.BufferAttribute;
    lp.setXYZ(0, c.x, c.y, c.z); lp.setXYZ(1, c.x, 0.002, c.z); lp.needsUpdate = true;
    this.comLine.computeLineDistances();
    this.comDot.position.set(c.x, 0.003, c.z);
    const sp = this.support.geometry.attributes.position as THREE.BufferAttribute;
    const corners = [body.pts.heel_R, body.pts.toe_R, body.pts.toe_L, body.pts.heel_L, body.pts.heel_R];
    corners.forEach((p, i) => sp.setXYZ(i, p.x, 0.004, p.z));
    sp.needsUpdate = true;
    this.support.visible = body.contact.R || body.contact.L;
    // contact shadows on the floor
    const feet = this.floor.uniforms.uFeet.value as THREE.Vector4[];
    (['R', 'L'] as Side[]).forEach((s, i) => {
      const h = body.pts[`heel_${s}`], t = body.pts[`toe_${s}`];
      feet[i * 2].set(h.x, h.z, Math.max(h.y, 0), 0.07);
      feet[i * 2 + 1].set((h.x + t.x) / 2 * 0.4 + t.x * 0.6, (h.z + t.z) / 2 * 0.4 + t.z * 0.6, Math.max(t.y, 0), 0.08);
    });
    (this.floor.uniforms.uCom.value as THREE.Vector2).set(c.x, c.z);
  }
}

/** Graphite floor: softbox pool, fading technical grid, capture ring, contact shadows, fog. */
function floorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFeet: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 9, 0.001)) },
      uCom: { value: new THREE.Vector2() },
      uFog: { value: new THREE.Color(0.030, 0.035, 0.039) },
    },
    vertexShader: 'varying vec3 vW; varying float vD; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix*w; vD = -mv.z; gl_Position = projectionMatrix*mv; }',
    fragmentShader: /* glsl */ `
      uniform vec4 uFeet[4]; uniform vec2 uCom; uniform vec3 uFog; varying vec3 vW; varying float vD;
      float line(vec2 p, float s){ vec2 g = abs(fract(p/s-0.5)-0.5)*s/fwidth(p); return 1.0-min(min(g.x,g.y),1.0); }
      void main(){
        float r = length(vW.xz);
        vec3 c = vec3(0.038,0.043,0.047) + vec3(0.10,0.095,0.09) * exp(-r*r*0.55);
        float grid = (line(vW.xz,0.25)*0.05 + line(vW.xz,1.0)*0.10) * (1.0 - smoothstep(1.5, 9.0, r));
        c = mix(c, vec3(0.55,0.68,0.74), grid);
        float ring = smoothstep(0.012, 0.0, abs(r - 0.95)) * 0.55 + smoothstep(0.005, 0.0, abs(r - 1.02)) * 0.25;
        float ticks = step(0.985, cos(atan(vW.z, vW.x) * 36.0)) * smoothstep(0.03, 0.0, abs(r - 0.985));
        c += vec3(0.45,0.78,0.92) * (ring + ticks * 0.5);
        float sh = 0.0;
        for (int i = 0; i < 4; i++) {
          vec2 d = (vW.xz - uFeet[i].xy) / uFeet[i].w;
          float lift = clamp(uFeet[i].z / 0.25, 0.0, 1.0);
          sh = max(sh, exp(-dot(d,d) * (1.6 - 0.9*lift)) * (0.8 - 0.7*lift));
        }
        c *= 1.0 - sh;
        float fog = 1.0 - exp(-0.0036 * vD * vD);
        gl_FragColor = vec4(mix(c, uFog, fog), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
