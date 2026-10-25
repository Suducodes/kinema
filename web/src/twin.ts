import * as THREE from 'three';
import type { Clip } from './data';

/** Pale resting muscle -> deep red when fully active; tendon ends glossy off-white. */
const REST = new THREE.Color(0.40, 0.14, 0.12), ACTIVE = new THREE.Color(0.58, 0.03, 0.025);
const TENDON = new THREE.Color(0.86, 0.82, 0.74);
const SEG = 40, RAD = 12;          // tube resolution along / around each muscle
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
  private readonly curve = new THREE.CatmullRomCurve3([], false, 'centripetal');
  private readonly pts: THREE.Vector3[];
  belly: number;

  constructor(readonly name: string, fmax: number, nPath: number) {
    this.belly = 0.007 + 0.00032 * Math.sqrt(fmax);
    this.pts = Array.from({ length: nPath }, () => new THREE.Vector3());
    this.curve.points = this.pts;
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
      sheen: 0.6, sheenColor: new THREE.Color(0.95, 0.55, 0.5), sheenRoughness: 0.45,
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

  update(points: ArrayLike<number>, base: number, activation: number) {
    for (let k = 0; k < this.pts.length; k++) this.pts[k].set(points[base + k * 3], points[base + k * 3 + 1], points[base + k * 3 + 2]);
    const { T, N, B, P, up } = MuscleTube;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      this.curve.getPointAt(u, P);
      this.curve.getTangentAt(u, T);
      // a stable frame: the walkers move in the x-y plane, so z is never parallel to a muscle
      B.crossVectors(T, up).normalize(); N.crossVectors(B, T).normalize();
      const r = this.belly * profile(u);
      for (let j = 0; j <= RAD; j++) {
        const a = (j / RAD) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const o = (i * (RAD + 1) + j) * 3;
        const nx = N.x * c + B.x * s, ny = N.y * c + B.y * s, nz = N.z * c + B.z * s;
        this.pos[o] = P.x + nx * r; this.pos[o + 1] = P.y + ny * r; this.pos[o + 2] = P.z + nz * r;
        this.nrm[o] = nx; this.nrm[o + 1] = ny; this.nrm[o + 2] = nz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.mat.color.copy(REST).lerp(ACTIVE, Math.min(activation / ACT_FULL, 1));
  }
}

/** A walker: bones from bones.glb placed by the clip's per-frame transforms, plus live muscles. */
export class Twin {
  readonly group = new THREE.Group();
  readonly muscles: MuscleTube[];
  private readonly bones: THREE.Mesh[] = [];
  private readonly frame: Float32Array;
  private readonly q0 = new THREE.Quaternion();
  private readonly q1 = new THREE.Quaternion();
  ghost = false;

  constructor(readonly clip: Clip, boneGeo: Map<string, THREE.BufferGeometry>, public offsetX: number) {
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
    this.frame = new Float32Array(clip.h.stride);
  }

  /** Healthy muscle sizes for both twins (call with the healthy clip). */
  matchSizes(healthy: Twin) {
    this.muscles.forEach((t, i) => (t.belly = healthy.muscles[i].belly));
  }

  /** Interpolated frame at time t (positions lerped, rotations slerped). */
  update(t: number) {
    const c = this.clip, s = c.h.stride, d = c.data;
    const { f0, f1, w } = c.at(t);
    const a = f0 * s, b = f1 * s;
    for (let k = 0; k < s; k++) this.frame[k] = d[a + k] * (1 - w) + d[b + k] * w;
    for (let i = 0; i < this.bones.length; i++) {
      const o = i * 7;
      this.bones[i].position.set(this.frame[o], this.frame[o + 1], this.frame[o + 2]);
      this.q0.set(d[a + o + 3], d[a + o + 4], d[a + o + 5], d[a + o + 6]);
      this.q1.set(d[b + o + 3], d[b + o + 4], d[b + o + 5], d[b + o + 6]);
      this.bones[i].quaternion.slerpQuaternions(this.q0, this.q1, w);
    }
    for (let k = 0; k < this.muscles.length; k++) {
      this.muscles[k].update(this.frame, c.oPath + k * c.P * 3, this.frame[c.oAct + k]);
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

  setGhost(on: boolean) {
    this.ghost = on;
    const apply = (m: THREE.Material) => {
      m.transparent = on; m.opacity = on ? 0.18 : 1; m.depthWrite = !on; m.needsUpdate = true;
    };
    this.bones.forEach((b) => apply(b.material as THREE.Material));
    this.muscles.forEach((t) => apply(t.mat));
  }

  pickables() { return this.muscles.map((m) => m.mesh); }
}
