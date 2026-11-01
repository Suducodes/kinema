import * as THREE from 'three';
import type { TwinMeta, V3 } from './assets';
import type { Frame } from './body';

/**
 * A demo performer for visitors without a camera, and the test harness for the pipeline: forward
 * kinematics of the same OpenSim skeleton turns prescribed joint angles into the 33 landmarks the
 * camera tracker would give (plus a little tracking noise). The angles it was given are returned too,
 * so reconstruction error can be measured.
 */
export type DemoMove = 'squat' | 'lunge' | 'jump';

export interface DemoTruth { knee: [number, number]; hip: [number, number]; ankle: [number, number]; lift: number }

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
const mir = (a: V3) => new THREE.Vector3(a[0], a[1], -a[2]);
const ease = (x: number) => (1 - Math.cos(Math.PI * Math.min(Math.max(x, 0), 1))) / 2;

export class Demo {
  private readonly scale = 1.04;   // a ~1.75 m performer
  private standY: number | undefined;
  constructor(private readonly meta: TwinMeta, public move: DemoMove = 'squat') {}

  /** Joint angles (deg) and pelvis lift (m) of the routine at time t (s). */
  private pose(t: number) {
    // rot = hip internal rotation: with a bent knee it swings the knee inward over a planted foot (valgus)
    const p: { knee: number[]; hip: number[]; ankle: number[]; add: number[]; rot: number[]; tilt: number; lumbar: number;
      armFlex: number[]; armAbd: number[]; elbow: number[]; lift: number; yaw: number; lean?: number } = { knee: [0, 0], hip: [0, 0], ankle: [0, 0], add: [0, 0], rot: [0, 0], tilt: 0, lumbar: 0, armFlex: [5, 5], armAbd: [8, 8], elbow: [12, 12], lift: 0, yaw: 0 };
    p.lean = 3;   // people stand leaning ~3 degrees forward at the ankles: the centre of mass sits over the forefoot
    if (this.move === 'squat') {
      const T = 3.4, k = Math.floor(t / T), u = (t % T) / T;
      const d = u < 0.12 ? 0 : u < 0.47 ? ease((u - 0.12) / 0.35) : u < 0.55 ? 1 : u < 0.9 ? 1 - ease((u - 0.55) / 0.35) : 0;
      const depth = [1, 0.85, 1.05][k % 3], cave = [0, 0, 26][k % 3];   // the third rep caves in
      p.knee = [108 * d * depth, 104 * d * depth];
      p.hip = [96 * d * depth, 93 * d * depth];
      p.ankle = [27 * d * depth, 26 * d * depth];
      p.rot = [cave * d, cave * d * 0.6];
      p.tilt = 22 * d; p.lumbar = 10 * d;
      p.armFlex = [5 + 80 * d, 5 + 80 * d]; p.armAbd = [8 - 4 * d, 8 - 4 * d];
    } else if (this.move === 'lunge') {
      const T = 4.2, k = Math.floor(t / T), u = (t % T) / T, lead = k % 2;
      const d = u < 0.12 ? 0 : u < 0.45 ? ease((u - 0.12) / 0.33) : u < 0.55 ? 1 : u < 0.88 ? 1 - ease((u - 0.55) / 0.33) : 0;
      const f = lead, b = 1 - lead;
      p.hip[f] = 85 * d; p.knee[f] = 92 * d; p.ankle[f] = 18 * d;
      p.hip[b] = -12 * d; p.knee[b] = 88 * d; p.ankle[b] = -10 * d;
      p.tilt = 6 * d; p.armFlex = [8, 8]; p.armAbd = [10, 10];
    } else {
      // countermovement jump and landing
      const T = 3.6, u = (t % T);
      const crouch = u < 0.4 ? 0 : u < 0.9 ? ease((u - 0.4) / 0.5) : u < 1.15 ? 1 - ease((u - 0.9) / 0.25) : 0;
      const air = u >= 1.15 && u < 1.55;
      const land = u >= 1.55 && u < 2.6 ? Math.sin(Math.PI * Math.min((u - 1.55) / 0.55, 1)) * (u < 2.1 ? 1 : 1 - ease((u - 2.1) / 0.5)) : 0;
      const dd = Math.max(crouch * 0.75, land * 0.62);
      p.knee = [100 * dd + (air ? 12 : 0), 100 * dd + (air ? 12 : 0)];
      p.hip = [80 * dd + (air ? 8 : 0), 80 * dd + (air ? 8 : 0)];
      // an athletic landing: shins well forward and chest over the knees keep the weight over the forefoot
      p.ankle = [32 * dd - (air ? 18 : 0), 32 * dd - (air ? 18 : 0)];
      p.rot = [land * 24, land * 24];   // knees cave in on landing (hip internal rotation)
      p.tilt = 28 * dd; p.lumbar = 10 * dd;
      // arms swing up for the take-off and stay forward through the landing (no whip down at touch-down)
      const arms = 5 + 70 * crouch + (air ? 60 : 0) + 55 * land;
      p.armFlex = [arms, arms];
      if (air) { const a = (u - 1.15) / 0.4; p.lift = 4 * 0.24 * a * (1 - a); }
    }
    return p;
  }

  frame(t: number): { frame: Frame; truth: DemoTruth } {
    const p = this.pose(t), r = this.meta.refs, s = this.scale;
    // whole-body forward lean at the ankles: legs extend back at the hip, the ankles dorsiflex to keep the feet flat
    for (const i of [0, 1]) { p.hip[i] -= p.lean ?? 0; p.ankle[i] += p.lean ?? 0; }
    const rad = THREE.MathUtils.degToRad, Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
    const rot = (axis: THREE.Vector3, deg: number) => new THREE.Quaternion().setFromAxisAngle(axis, rad(deg));
    // model frame: x anterior, y up, z right. Pelvis first.
    const qp = rot(Z, -p.tilt);   // anterior tilt: the pelvis top rolls forward (rotation about -z)
    const P0 = new THREE.Vector3(0, 0, 0);
    const W = (q: THREE.Quaternion, o: THREE.Vector3, local: THREE.Vector3) => local.clone().multiplyScalar(s).applyQuaternion(q).add(o);
    const pts: Record<string, THREE.Vector3> = {};
    for (const [i, side] of (['R', 'L'] as const).entries()) {
      const R = side === 'R', f = R ? mir : v3, sg = R ? 1 : -1;
      const hip = W(qp, P0, v3(R ? r.pelvis.hipR : r.pelvis.hipL));
      const qf = qp.clone().multiply(rot(Z, p.hip[i])).multiply(rot(new THREE.Vector3(sg, 0, 0), p.add[i]))
        .multiply(rot(new THREE.Vector3(0, sg, 0), p.rot[i]));
      const knee = W(qf, hip, f(r.femur.knee));
      const qt = qf.clone().multiply(rot(Z, -p.knee[i]));
      const ankle = W(qt, knee, f(r.tibia.ankle));
      const qft = qt.clone().multiply(rot(Z, p.ankle[i]));
      const fo = ankle.clone().sub(f(r.foot.ankle).multiplyScalar(s).applyQuaternion(qft));
      Object.assign(pts, { [`hip${side}`]: hip, [`knee${side}`]: knee, [`ank${side}`]: ankle,
        [`heel${side}`]: W(qft, fo, f(r.foot.heel)), [`toe${side}`]: W(qft, fo, f(r.foot.toe)) });
    }
    const lumbar = W(qp, P0, v3(r.pelvis.lumbar));
    const qT = qp.clone().multiply(rot(Z, -p.lumbar));   // spine flexion brings the trunk further forward
    const neck = W(qT, lumbar, v3(r.torso.neck));
    const head = W(qT, neck, v3(r.head.center));
    pts.earR = head.clone().add(new THREE.Vector3(-0.01, 0, 0.075).applyQuaternion(qT));
    pts.earL = head.clone().add(new THREE.Vector3(-0.01, 0, -0.075).applyQuaternion(qT));
    pts.nose = head.clone().add(new THREE.Vector3(0.1, -0.02, 0).applyQuaternion(qT));
    for (const [i, side] of (['R', 'L'] as const).entries()) {
      const R = side === 'R', f = R ? mir : v3, sg = R ? 1 : -1;
      const sh = W(qT, lumbar, v3(R ? r.torso.shoulderR : r.torso.shoulderL));
      const qh = qT.clone().multiply(rot(Z, p.armFlex[i])).multiply(rot(X, -sg * p.armAbd[i]));
      const el = W(qh, sh, f(r.humerus.elbow));
      const qa = qh.clone().multiply(rot(Z, p.elbow[i]));
      const wr = W(qa, el, f(r.forearm.wrist));
      const tip = W(qa, wr, f(r.hand.tip));
      const lat = new THREE.Vector3(0, 0, sg * 0.03).applyQuaternion(qa);
      Object.assign(pts, { [`sh${side}`]: sh, [`el${side}`]: el, [`wr${side}`]: wr,
        [`idx${side}`]: tip.clone().add(lat.clone().multiplyScalar(0.6)), [`pk${side}`]: tip.clone().sub(lat),
        [`th${side}`]: wr.clone().lerp(tip, 0.4).add(lat.clone().multiplyScalar(1.6)) });
    }
    // feet on the floor, then the jump's lift
    const minY = Math.min(pts.heelR.y, pts.toeR.y, pts.heelL.y, pts.toeL.y);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);   // face the camera (+z)
    const hipMid = pts.hipR.clone().add(pts.hipL).multiplyScalar(0.5);
    const order: [number, string][] = [[0, 'nose'], [7, 'earL'], [8, 'earR'], [11, 'shL'], [12, 'shR'], [13, 'elL'], [14, 'elR'], [15, 'wrL'], [16, 'wrR'],
      [17, 'pkL'], [18, 'pkR'], [19, 'idxL'], [20, 'idxR'], [21, 'thL'], [22, 'thR'], [23, 'hipL'], [24, 'hipR'], [25, 'kneeL'], [26, 'kneeR'],
      [27, 'ankL'], [28, 'ankR'], [29, 'heelL'], [30, 'heelR'], [31, 'toeL'], [32, 'toeR']];
    const world = Array.from({ length: 33 }, () => new THREE.Vector3());
    const noise = () => (Math.random() - 0.5) * 0.008;
    for (const [i, k] of order) world[i].copy(pts[k]).sub(hipMid).applyQuaternion(yaw).add(new THREE.Vector3(noise(), noise(), noise()));
    for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) world[i].copy(world[0]);
    const pelvisY = -minY + p.lift;
    // what the image would show: the pelvis's height change from standing (negative in a squat)
    if (this.standY === undefined) { this.standY = 0; this.standY = this.frame(0).truth.lift; }
    return {
      frame: { world, visibility: new Array(33).fill(0.99), lift: pelvisY - this.standY, t },
      truth: { knee: [p.knee[0], p.knee[1]], hip: [p.hip[0], p.hip[1]], ankle: [p.ankle[0], p.ankle[1]], lift: pelvisY },
    };
  }
}
