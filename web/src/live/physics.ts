import * as THREE from 'three';
import { COORDS, interp, type Coord, type TwinMeta } from './assets';
import { QuadFit } from './filters';
import { SIDES, type Body, type Side } from './body';

/**
 * Real-time physics on the reconstructed body, every tracked frame:
 *  1. segment accelerations from a causal quadratic fit of each segment's centre of mass and spin;
 *  2. ground reaction force = sum of m (a - g) over all segments (Newton's second law for the whole
 *     body), shared between the feet in contact by where the centre of pressure falls between them;
 *  3. 3D Newton-Euler inverse dynamics up each leg (foot -> shank -> thigh) for the net joint moments,
 *     projected on the OpenSim coordinates (hip flex/add/rot, knee flex, ankle flex);
 *  4. static optimisation per leg: share those moments across 44 muscles, minimising the sum of
 *     squared activations, with OpenSim moment arms and force-length-limited capacity.
 * Video gives no force sensors: ground forces and muscle activations are model estimates.
 */
const G = new THREE.Vector3(0, -9.81, 0);
const DYN = ['pelvis', 'torso', 'head', 'femur_R', 'femur_L', 'tibia_R', 'tibia_L', 'foot_R', 'foot_L',
  'humerus_R', 'humerus_L', 'forearm_R', 'forearm_L', 'hand_R', 'hand_L'];
/** Allowed residual per coordinate (N m): tight for the sagittal joints, loose for hip rotation (poorly observed). */
const SIGMA: Record<Coord, number> = { hip_flex: 2, hip_add: 4, hip_rot: 10, knee_flex: 2, ankle_flex: 2 };

interface SegState {
  m: number; comLocal: THREE.Vector3; Ilocal: THREE.Matrix3;
  c: THREE.Vector3; a: THREE.Vector3; w: THREE.Vector3; alpha: THREE.Vector3;
  fitC: QuadFit; fitW: QuadFit; prevQ: THREE.Quaternion | null; prevT: number;
}

export interface SideResult {
  tau: Record<Coord, number>;          // net joint moment on each coordinate (N m)
  act: Float32Array;                    // muscle activations 0-1 (meta.muscles.names order)
  force: Float32Array;                  // muscle force (N)
  residual: Record<Coord, number>;      // moment the muscles could not supply (N m)
  grf: THREE.Vector3; cop: THREE.Vector3;
}

export class Physics {
  readonly seg: Record<string, SegState> = {};
  readonly res: Record<Side, SideResult>;
  mass = 70;
  private massRatio = 1;
  private strength = 1;
  private readonly names: string[];
  private readonly cum: Record<string, Record<Coord, number[]>> = {};   // integral of the moment arm (m), for muscle length
  bodyWeight = 0;
  totalGrf = new THREE.Vector3();
  private share_ = 0.5;
  private lastT = 0;
  /** Normalised fibre length of every muscle (for inspection). */
  readonly lfib: Record<Side, Float64Array>;

  constructor(readonly meta: TwinMeta) {
    this.names = meta.muscles.names;
    for (const k of DYN) {
      const p = meta.segments[k.replace(/_[RL]$/, '')];
      const com = new THREE.Vector3(...p.com);
      const I = new THREE.Matrix3().set(p.I[0][0], p.I[0][1], p.I[0][2], p.I[1][0], p.I[1][1], p.I[1][2], p.I[2][0], p.I[2][1], p.I[2][2]);
      if (k.endsWith('_L')) {   // mirror across z: com.z flips, inertia products with z flip
        com.z = -com.z;
        const e = I.elements; e[2] = -e[2]; e[6] = -e[6]; e[5] = -e[5]; e[7] = -e[7];
      }
      this.seg[k] = { m: p.mass, comLocal: com, Ilocal: I, c: new THREE.Vector3(), a: new THREE.Vector3(), w: new THREE.Vector3(),
        alpha: new THREE.Vector3(), fitC: new QuadFit(3, 0.26, 16), fitW: new QuadFit(3, 0.26, 16), prevQ: null, prevT: 0 };
    }
    // cumulative integrals of each moment-arm table from 0 deg (trapezoid, radians)
    for (const n of this.names) {
      this.cum[n] = {} as Record<Coord, number[]>;
      for (const c of COORDS) {
        const g = meta.arms.grids[c], r = meta.arms.r[n][c];
        const out = new Array(g.length).fill(0);
        const i0 = g.findIndex((x) => x >= 0);
        for (let i = i0 + 1; i < g.length; i++) out[i] = out[i - 1] + 0.5 * (r[i] + r[i - 1]) * THREE.MathUtils.degToRad(g[i] - g[i - 1]);
        for (let i = i0 - 1; i >= 0; i--) out[i] = out[i + 1] - 0.5 * (r[i] + r[i + 1]) * THREE.MathUtils.degToRad(g[i + 1] - g[i]);
        this.cum[n][c] = out;
      }
    }
    const blank = (): SideResult => ({ tau: zeros(), act: new Float32Array(this.names.length), force: new Float32Array(this.names.length),
      residual: zeros(), grf: new THREE.Vector3(), cop: new THREE.Vector3() });
    this.res = { R: blank(), L: blank() };
    this.lfib = { R: new Float64Array(this.names.length), L: new Float64Array(this.names.length) };
    this.setMass(70);
  }

  setMass(kg: number) {
    this.mass = kg;
    this.massRatio = kg / this.meta.model_mass;
    this.strength = Math.pow(this.massRatio, 2 / 3);
    this.bodyWeight = kg * 9.81;
  }

  reset() { for (const s of Object.values(this.seg)) { s.fitC.reset(); s.fitW.reset(); s.prevQ = null; } }

  update(body: Body, t: number) {
    // ---- 1. segment kinematics
    const vel = new Float64Array(3), acc = new Float64Array(3);
    for (const k of DYN) {
      const s = this.seg[k], pose = body.seg[k];
      s.c.copy(s.comLocal).multiplyScalar(pose.scale).applyQuaternion(pose.quat).add(pose.pos);
      s.fitC.push(t, [s.c.x, s.c.y, s.c.z]);
      s.fitC.derivatives(vel, acc);
      s.a.set(acc[0], acc[1], acc[2]);
      if (s.prevQ && t > s.prevT) {
        const dq = pose.quat.clone().multiply(s.prevQ.clone().invert());
        if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
        const ang = 2 * Math.acos(Math.min(dq.w, 1)), sn = Math.sqrt(Math.max(1 - dq.w * dq.w, 1e-12));
        const wv = ang < 1e-6 ? new THREE.Vector3() : new THREE.Vector3(dq.x, dq.y, dq.z).divideScalar(sn).multiplyScalar(ang / (t - s.prevT));
        s.fitW.push(t, [wv.x, wv.y, wv.z]);
        s.fitW.derivatives(vel, acc);
        s.w.copy(wv); s.alpha.set(vel[0], vel[1], vel[2]);
      }
      s.prevQ = pose.quat.clone(); s.prevT = t;
    }

    // ---- 2. ground reaction force and its split between the feet
    const M = this.massRatio, F = new THREE.Vector3();
    for (const k of DYN) { const s = this.seg[k]; F.addScaledVector(s.a.clone().sub(G), s.m * M); }
    const com = body.pts.com;
    const contactR = body.contact.R, contactL = body.contact.L;
    if (!contactR && !contactL) F.set(0, 0, 0);
    F.y = Math.max(F.y, 0);
    this.totalGrf.copy(F);
    // centre of pressure from the whole-body moment balance about the centre of mass:
    // (cop - com) x F = dH/dt, with dH/dt = sum m (c_i - com) x a_i + I alpha + w x I w (swinging arms included)
    const cop = new THREE.Vector3(com.x, 0, com.z);
    if (F.y > 0.2 * this.bodyWeight) {
      const Hd = new THREE.Vector3(), tmp = new THREE.Vector3();
      for (const k of DYN) {
        const g = this.seg[k], pose = body.seg[k], m = g.m * M;
        Hd.add(tmp.crossVectors(g.c.clone().sub(com), g.a).multiplyScalar(m));
        const Rm = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(pose.quat));
        const I = Rm.clone().multiply(g.Ilocal).multiply(Rm.clone().transpose()).multiplyScalar(M * pose.scale * pose.scale);
        Hd.add(g.alpha.clone().applyMatrix3(I)).add(tmp.crossVectors(g.w, g.w.clone().applyMatrix3(I)));
      }
      cop.x = com.x + (Hd.z - com.y * F.x) / F.y;
      cop.z = com.z + (-com.y * F.z - Hd.x) / F.y;
    }
    const footSeg = (s: Side) => [body.pts[`heel_${s}`].clone().setY(0), body.pts[`toe_${s}`].clone().setY(0)];
    const onFoot = (s: Side, p: THREE.Vector3) => {
      const [h, toe] = footSeg(s), d = toe.clone().sub(h), u = THREE.MathUtils.clamp(p.clone().sub(h).dot(d) / Math.max(d.lengthSq(), 1e-6), 0.05, 0.95);
      return h.addScaledVector(d, u);
    };
    // left/right share follows where the centre of mass sits between the feet (smoothed, ~0.15 s):
    // horizontal accelerations from video are too noisy to move weight between legs
    let wR = contactR ? 1 : 0;
    if (contactR && contactL) {
      const cR = footSeg('R').reduce((a, b) => a.add(b)).multiplyScalar(0.5), cL = footSeg('L').reduce((a, b) => a.add(b)).multiplyScalar(0.5);
      const d = cR.clone().sub(cL);
      const target = THREE.MathUtils.clamp(new THREE.Vector3(com.x, 0, com.z).sub(cL).dot(d) / Math.max(d.lengthSq(), 1e-6), 0, 1);
      this.share_ += (target - this.share_) * Math.min(1, (t - this.lastT) / 0.15);
      wR = this.share_;
    }
    this.lastT = t;
    for (const s of SIDES) {
      const w = s === 'R' ? wR : 1 - wR;
      this.res[s].grf.copy(F).multiplyScalar(w);
      this.res[s].cop.copy(onFoot(s, cop));
    }

    // ---- 3. inverse dynamics up each leg, 4. muscle sharing
    for (const s of SIDES) {
      const r = this.res[s];
      const { hip, knee, ankle } = this.legID(body, s, r.grf, r.cop);
      const qp = body.seg.pelvis.quat, A = body.angles[s], sg = s === 'R' ? 1 : -1;
      const rz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(A.hip_flex));
      const rx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(sg, 0, 0), THREE.MathUtils.degToRad(A.hip_add));
      const w1 = new THREE.Vector3(0, 0, 1).applyQuaternion(qp);
      const w2 = new THREE.Vector3(sg, 0, 0).applyQuaternion(rz).applyQuaternion(qp);
      const w3 = new THREE.Vector3(0, sg, 0).applyQuaternion(rx).applyQuaternion(rz).applyQuaternion(qp);
      r.tau.hip_flex = hip.dot(w1); r.tau.hip_add = hip.dot(w2); r.tau.hip_rot = hip.dot(w3);
      r.tau.knee_flex = knee.dot(new THREE.Vector3(0, 0, -1).applyQuaternion(body.seg[`femur_${s}`].quat));
      r.tau.ankle_flex = ankle.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(body.seg[`tibia_${s}`].quat));
      this.share(body, s);
    }
  }

  /** Net joint moments on the foot (ankle), shank (knee) and thigh (hip), world frame. */
  private legID(body: Body, s: Side, grf: THREE.Vector3, cop: THREE.Vector3) {
    const M = this.massRatio;
    const step = (k: string, P: THREE.Vector3, Fd: THREE.Vector3, Md: THREE.Vector3, D: THREE.Vector3) => {
      const g = this.seg[k], pose = body.seg[k], m = g.m * M;
      const Rm = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(pose.quat));
      const I = Rm.clone().multiply(g.Ilocal).multiply(Rm.clone().transpose()).multiplyScalar(M * pose.scale * pose.scale);
      const Fp = g.a.clone().sub(G).multiplyScalar(m).sub(Fd);
      const Iw = g.w.clone().applyMatrix3(I), Ia = g.alpha.clone().applyMatrix3(I);
      const Mp = Ia.add(new THREE.Vector3().crossVectors(g.w, Iw)).sub(Md)
        .sub(new THREE.Vector3().crossVectors(P.clone().sub(g.c), Fp))
        .sub(new THREE.Vector3().crossVectors(D.clone().sub(g.c), Fd));
      return { Fp, Mp };
    };
    const zero = new THREE.Vector3();
    const foot = step(`foot_${s}`, body.pts[`ankle_${s}`], grf, zero, cop);
    const shank = step(`tibia_${s}`, body.pts[`knee_${s}`], foot.Fp.clone().negate(), foot.Mp.clone().negate(), body.pts[`ankle_${s}`]);
    const thigh = step(`femur_${s}`, body.pts[`hip_${s}`], shank.Fp.clone().negate(), shank.Mp.clone().negate(), body.pts[`knee_${s}`]);
    return { ankle: foot.Mp, knee: shank.Mp, hip: thigh.Mp };
  }

  /** Static optimisation: min sum a^2 + sum (residual/sigma)^2, 0 <= a <= 1. */
  private share(body: Body, s: Side) {
    const r = this.res[s], A = body.angles[s], names = this.names, P = this.meta.muscles.params, n = names.length;
    const cap = new Float64Array(n), arm: Float64Array[] = COORDS.map(() => new Float64Array(n)), lfib = this.lfib[s];
    for (let i = 0; i < n; i++) {
      const nm = names[i], p = P[nm];
      let L = p.L0;
      COORDS.forEach((c, j) => {
        const g = this.meta.arms.grids[c], q = A[c];
        arm[j][i] = interp(g, this.meta.arms.r[nm][c], q);
        L -= interp(g, this.cum[nm][c], q);
      });
      // active force-length (Gaussian, width close to the De Groote-Fregly 2016 active curve); rigid tendon
      const lf = Math.max((L - p.lts) / Math.cos(p.penn), 0.2 * p.lopt) / p.lopt;
      const fl = Math.max(0.25, Math.exp(-(((lf - 1) / 0.62) ** 2)));
      lfib[i] = lf;
      cap[i] = p.fmax * this.strength * fl * Math.cos(p.penn);
    }
    const tau = COORDS.map((c) => r.tau[c]);
    const a = new Float64Array(n);
    // Sum of squared activations, OpenSim Static Optimization's default criterion (active-set solve on
    // the dual). A known trait: stronger muscles take proportionally more of the load.
    const w = new Float64Array(n).fill(1);
    {
      const state = new Int8Array(n);   // 0 free, -1 held at 0, 1 held at 1
      for (let iter = 0; iter < 14; iter++) {
        const target = tau.slice();
        for (let i = 0; i < n; i++) if (state[i] === 1) COORDS.forEach((_, j) => (target[j] -= arm[j][i] * cap[i]));
        // K = A_F W^-1 A_F^T + diag(sigma^2)
        const K = COORDS.map((cj, j) => COORDS.map((_, k) => {
          let v = j === k ? SIGMA[cj] ** 2 : 0;
          for (let i = 0; i < n; i++) if (state[i] === 0) v += (arm[j][i] * cap[i] * arm[k][i] * cap[i]) / w[i];
          return v;
        }));
        const y = solve(K, target);
        let changed = false;
        for (let i = 0; i < n; i++) {
          if (state[i] === 1) { a[i] = 1; continue; }
          if (state[i] === -1) { a[i] = 0; continue; }
          let v = 0;
          COORDS.forEach((_, j) => (v += arm[j][i] * cap[i] * y[j]));
          a[i] = v / w[i];
          if (a[i] < 0) { state[i] = -1; changed = true; } else if (a[i] > 1) { state[i] = 1; changed = true; }
        }
        if (!changed) break;
      }
    }
    COORDS.forEach((c, j) => {
      let produced = 0;
      for (let i = 0; i < n; i++) produced += arm[j][i] * cap[i] * Math.min(Math.max(a[i], 0), 1);
      r.residual[c] = tau[j] - produced;
    });
    for (let i = 0; i < n; i++) {
      const v = Math.min(Math.max(a[i], 0), 1);
      r.act[i] = r.act[i] * 0.35 + v * 0.65;   // a light display smoothing (about one video frame)
      r.force[i] = v * cap[i];
    }
  }
}

function zeros(): Record<Coord, number> { return { hip_flex: 0, hip_add: 0, hip_rot: 0, knee_flex: 0, ankle_flex: 0 }; }

/** Small dense solve (Gaussian elimination with partial pivoting). */
function solve(K: number[][], b: number[]) {
  const n = b.length, A = K.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / (row[i] || 1e-12));
}
