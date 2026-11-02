import * as THREE from 'three';
import { interp, type TwinMeta, type V3 } from './assets';

/**
 * Body reconstruction: 33 tracked landmarks -> the twin's 17 segments, each placed as its real
 * OpenSim body frame (x anterior, y up, z to the subject's right). Segments are chained joint to
 * joint (pelvis -> femur -> tibia -> foot, torso -> humerus -> forearm -> hand) with calibrated,
 * fixed lengths, so the skeleton never stretches or comes apart; landmarks only give directions.
 * Joint angles follow OpenSim conventions so the moment-arm tables apply directly.
 */
export const LM = {
  nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lPinky: 17, rPinky: 18,
  lIndex: 19, rIndex: 20, lThumb: 21, rThumb: 22, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28,
  lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
} as const;
export type Side = 'R' | 'L';
export const SIDES: Side[] = ['R', 'L'];

export interface Frame {
  /** 33 landmarks in metres: x to the camera's right, y up, z toward the camera (person faces +z). */
  world: THREE.Vector3[];
  visibility: number[];
  /** Pelvis height change since calibration from the image (m), when known (jumps), else null. */
  lift: number | null;
  t: number;
}

export interface SegPose { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number }

export interface Angles {
  hip_flex: number; hip_add: number; hip_rot: number; knee_flex: number; ankle_flex: number;
  valgus: number; elbow: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
const mir = (a: V3) => new THREE.Vector3(a[0], a[1], -a[2]);

/** Rotation taking local (primary, secondary) to world (primary, secondary); primary is kept exactly. */
function alignQuat(pl: THREE.Vector3, sl: THREE.Vector3, pw: THREE.Vector3, sw: THREE.Vector3, out: THREE.Quaternion) {
  const basis = (p: THREE.Vector3, s: THREE.Vector3) => {
    const a = p.clone().normalize();
    const b = s.clone().addScaledVector(a, -s.dot(a)).normalize();
    const c = new THREE.Vector3().crossVectors(a, b);
    return new THREE.Matrix4().makeBasis(a, b, c);
  };
  const L = basis(pl, sl), W = basis(pw, sw);
  return out.setFromRotationMatrix(W.multiply(L.transpose()));
}

/** Standing height of the unscaled model, floor to skull top, every segment in its neutral pose. */
export function modelHeight(meta: TwinMeta) {
  const r = meta.refs;
  const top = r.pelvis.lumbar[1] + r.torso.neck[1] + r.head.top[1];
  const bottom = r.pelvis.hipL[1] + r.femur.knee[1] + r.tibia.ankle[1] - r.foot.ankle[1] + r.foot.heel[1];
  return top - bottom + 0.02;   // heel pad and scalp
}

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };

export class Body {
  readonly seg: Record<string, SegPose> = {};
  readonly angles: Record<Side, Angles>;
  /** Named world points of the reconstructed skeleton (joint centres, heel, toe ...). */
  readonly pts: Record<string, THREE.Vector3> = {};
  readonly ref: Record<string, THREE.Vector3> = {};
  /** Segment scale factors (twin length / model length): one factor for every segment, from the user's
   * height, so the twin keeps adult proportions. Landmark distances are too noisy (and guessed for limbs
   * out of view) to size individual bones. */
  readonly scale: Record<string, number> = {};
  private samples: Record<string, number[]> = {};
  calibrated = false;
  /** Multiplies raw landmark distances (MediaPipe's metric scale is approximate): set from the user's height. */
  heightGain = 1;
  standingPelvisY = 0.95;
  trunkLean = 0;
  trunkSide = 0;
  contact: Record<Side, boolean> = { R: true, L: true };
  footMinY: Record<Side, number> = { R: 0, L: 0 };

  constructor(readonly meta: TwinMeta) {
    const r = meta.refs;
    const put = (k: string, v: THREE.Vector3) => (this.ref[k] = v);
    put('hipR', v3(r.pelvis.hipR)); put('hipL', v3(r.pelvis.hipL)); put('lumbar', v3(r.pelvis.lumbar));
    put('shoulderR', v3(r.torso.shoulderR)); put('shoulderL', v3(r.torso.shoulderL)); put('neck', v3(r.torso.neck));
    put('headCenter', v3(r.head.center)); put('headTop', v3(r.head.top));
    for (const s of SIDES) {
      const f = s === 'R' ? mir : v3;   // leg and arm references were exported from the left bodies
      put(`knee_${s}`, f(r.femur.knee)); put(`ankleT_${s}`, f(r.tibia.ankle));
      put(`ankleF_${s}`, f(r.foot.ankle)); put(`heel_${s}`, f(r.foot.heel)); put(`toe_${s}`, f(r.foot.toe));
      put(`elbow_${s}`, f(r.humerus.elbow)); put(`wrist_${s}`, f(r.forearm.wrist)); put(`tip_${s}`, f(r.hand.tip));
    }
    for (const k of ['pelvis', 'torso', 'head', 'femur_R', 'femur_L', 'patella_R', 'patella_L', 'tibia_R', 'tibia_L', 'foot_R', 'foot_L',
      'humerus_R', 'humerus_L', 'forearm_R', 'forearm_L', 'hand_R', 'hand_L']) {
      this.seg[k] = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 };
      this.scale[k.replace(/_[RL]$/, '')] = 1;
    }
    this.setHeight(1.72);
    const z = (): Angles => ({ hip_flex: 0, hip_add: 0, hip_rot: 0, knee_flex: 0, ankle_flex: 0, valgus: 0, elbow: 0 });
    this.angles = { R: z(), L: z() };
  }

  /** Model length of each scaled piece, for calibration. */
  private modelLength(key: string) {
    const r = this.ref;
    switch (key) {
      case 'pelvis': return r.hipR.distanceTo(r.hipL);
      case 'torso': return r.shoulderR.clone().add(r.shoulderL).multiplyScalar(0.5).length();
      case 'head': return r.headCenter.length();
      case 'femur': return r.knee_L.length();
      case 'tibia': return r.ankleT_L.length();
      case 'foot': return r.toe_L.distanceTo(r.heel_L);
      case 'humerus': return r.elbow_L.length();
      case 'forearm': return r.wrist_L.length();
      case 'hand': return r.tip_L.length();
      default: return 1;
    }
  }

  /** Landmark length of each piece in this frame (both sides averaged). */
  private measured(w: THREE.Vector3[]) {
    const d = (a: number, b: number) => w[a].distanceTo(w[b]);
    const mid = (a: number, b: number) => w[a].clone().add(w[b]).multiplyScalar(0.5);
    const hipMid = mid(LM.lHip, LM.rHip), shMid = mid(LM.lSh, LM.rSh), earMid = mid(LM.lEar, LM.rEar);
    // the lumbar joint sits above the hip line by the model's proportion of the trunk
    const trunk = shMid.distanceTo(hipMid);
    return {
      pelvis: d(LM.lHip, LM.rHip), torso: trunk * 0.86, head: earMid.distanceTo(shMid) * 0.75,
      femur: (d(LM.lHip, LM.lKnee) + d(LM.rHip, LM.rKnee)) / 2, tibia: (d(LM.lKnee, LM.lAnk) + d(LM.rKnee, LM.rAnk)) / 2,
      foot: (d(LM.lHeel, LM.lToe) + d(LM.rHeel, LM.rToe)) / 2, humerus: (d(LM.lSh, LM.lEl) + d(LM.rSh, LM.rEl)) / 2,
      forearm: (d(LM.lEl, LM.lWr) + d(LM.rEl, LM.rWr)) / 2,
      hand: (d(LM.lWr, LM.lIndex) + d(LM.rWr, LM.rIndex)) / 2 * 1.1,
    } as Record<string, number>;
  }

  /** Trunk lean recorded while standing tall: a person's own upright posture reads as zero lean. */
  private leanOffset = 0;
  private leanSamples: number[] | null = null;

  /** Feed calibration frames (stand tall); call finishCalibration() after ~1.5 s. */
  addCalibrationSample(f: Frame) {
    const m = this.measured(f.world);
    for (const [k, v] of Object.entries(m)) (this.samples[k] ??= []).push(v);
    this.leanSamples ??= [];
  }

  /** Scale the whole twin to a standing height (m). */
  setHeight(h: number) {
    const k = h / modelHeight(this.meta);
    for (const key of Object.keys(this.scale)) this.scale[key] = k;
  }

  finishCalibration(userHeight: number) {
    const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? 1; };
    this.setHeight(userHeight);
    // MediaPipe's metric scale is approximate: one gain maps landmark distances onto the twin. The median
    // over the long bones is robust to a limb that is out of view (its length is a guess).
    const ratios: number[] = [];
    for (const k of ['pelvis', 'torso', 'femur', 'tibia', 'humerus', 'forearm']) {
      const m = median(this.samples[k] ?? []);
      if (m > 0.02) ratios.push((this.scale[k] * this.modelLength(k)) / m);
    }
    this.heightGain = ratios.length ? Math.min(Math.max(median(ratios), 0.75), 1.35) : 1;
    this.samples = {};
    if (this.leanSamples?.length) this.leanOffset = this.leanSamples.reduce((a, b) => a + b, 0) / this.leanSamples.length;
    this.leanSamples = null;
    this.calibrated = true;
    this.needStanding = true;   // the next frame (still standing) records the standing pelvis height
  }
  private needStanding = false;

  /** Reconstruct every segment from one frame of landmarks. */
  update(f: Frame) {
    const g = this.heightGain;
    const w = f.world.map((p) => p.clone().multiplyScalar(g));
    const P = (i: number) => w[i];
    const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
    const sc = this.scale, r = this.ref, S = this.seg, pts = this.pts;
    const place = (k: string, origin: THREE.Vector3, q: THREE.Quaternion, s: number) => {
      S[k].pos.copy(origin); S[k].quat.copy(q); S[k].scale = s;
    };
    const toWorld = (k: string, local: THREE.Vector3) => local.clone().multiplyScalar(S[k].scale).applyQuaternion(S[k].quat).add(S[k].pos);
    const axis = (k: string, a: THREE.Vector3) => a.clone().applyQuaternion(S[k].quat);
    const q = new THREE.Quaternion();

    // ---- pelvis: lateral from the hips; tilt shares the trunk's lean away from the model's own neutral
    // trunk line (60 % pelvis, 40 % lumbar spine), so an upright stance reads as zero tilt
    const hipL = P(LM.lHip), hipR = P(LM.rHip), hipMid = mid(hipL, hipR), shMid = mid(P(LM.lSh), P(LM.rSh));
    const zP = hipR.clone().sub(hipL).normalize();
    const trunkUp = shMid.clone().sub(hipMid).normalize();
    const localHipMid = mid(r.hipR, r.hipL), localLat = r.hipR.clone().sub(r.hipL);
    const localTrunk = r.lumbar.clone().add(mid(r.shoulderR, r.shoulderL)).sub(localHipMid);
    const qUpright = alignQuat(localLat, UP, zP.clone().setY(0).normalize(), UP, new THREE.Quaternion());
    const qFull = alignQuat(localLat, localTrunk, zP, trunkUp, new THREE.Quaternion());
    q.copy(qUpright).slerp(qFull, 0.6);
    const origin = hipMid.clone().sub(localHipMid.clone().multiplyScalar(sc.pelvis).applyQuaternion(q));
    place('pelvis', origin, q, sc.pelvis);
    // trunk lean: forward angle of the hip-shoulder line from where it would point standing upright
    const neutral = localTrunk.clone().applyQuaternion(qUpright).normalize();
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(qUpright);
    const lean = (v: THREE.Vector3) => Math.atan2(v.dot(fwd), v.dot(UP));
    this.trunkLean = THREE.MathUtils.radToDeg(lean(trunkUp) - lean(neutral)) - this.leanOffset;
    this.trunkSide = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(trunkUp.dot(zP), -1, 1)));
    if (this.leanSamples) this.leanSamples.push(this.trunkLean + this.leanOffset);

    // ---- torso and head
    const lumbar = toWorld('pelvis', r.lumbar);
    const zT = P(LM.rSh).clone().sub(P(LM.lSh)).normalize();
    const shLocal = mid(r.shoulderR, r.shoulderL);
    alignQuat(shLocal, r.shoulderR.clone().sub(r.shoulderL), shMid.clone().sub(lumbar), zT, q);
    place('torso', lumbar, q, sc.torso);
    const neck = toWorld('torso', r.neck);
    // the head follows the ears, held 40 % toward the trunk's own line: ear points are among the noisiest
    // landmarks, and a nodding skull reads as tracking error, not movement
    const earMid = mid(P(LM.lEar), P(LM.rEar));
    const headDir = r.headCenter.clone().applyQuaternion(S.torso.quat).normalize().lerp(earMid.clone().sub(neck).normalize(), 0.6);
    const headLat = zT.clone().lerp(P(LM.rEar).clone().sub(P(LM.lEar)).normalize(), 0.6);
    alignQuat(r.headCenter, new THREE.Vector3(0, 0, 1), headDir, headLat, q);
    place('head', neck, q, sc.head);
    pts.lumbar = lumbar; pts.neck = neck; pts.headTop = toWorld('head', r.headTop);

    for (const s of SIDES) {
      const R = s === 'R';
      const iKnee = R ? LM.rKnee : LM.lKnee, iAnk = R ? LM.rAnk : LM.lAnk;
      const iHeel = R ? LM.rHeel : LM.lHeel, iToe = R ? LM.rToe : LM.lToe;
      // ---- femur: direction hip -> knee; lateral from the pelvis, turning with the knee's bending plane
      const hip = toWorld('pelvis', R ? r.hipR : r.hipL);
      const kneeLM = P(iKnee), ankLM = P(iAnk);
      const thigh = kneeLM.clone().sub(hip), shank = ankLM.clone().sub(kneeLM);
      const bend = thigh.angleTo(shank);
      const plane = new THREE.Vector3().crossVectors(thigh, shank).normalize();
      if (plane.dot(zP) < 0) plane.negate();
      const lat = zP.clone().lerp(plane, smooth(0.25, 0.8, bend)).normalize();
      alignQuat(r[`knee_${s}`], new THREE.Vector3(0, 0, 1), thigh, lat, q);
      place(`femur_${s}`, hip, q, sc.femur);
      const knee = toWorld(`femur_${s}`, r[`knee_${s}`]);
      // ---- tibia: knee -> ankle, lateral from the femur
      alignQuat(r[`ankleT_${s}`], new THREE.Vector3(0, 0, 1), ankLM.clone().sub(knee), axis(`femur_${s}`, new THREE.Vector3(0, 0, 1)), q);
      place(`tibia_${s}`, knee, q, sc.tibia);
      const ankle = toWorld(`tibia_${s}`, r[`ankleT_${s}`]);
      // ---- foot: heel -> toe; lateral is the tibia's lateral made horizontal (a planted foot stays flat
      // when the shank tilts in or out); placed so its ankle sits on the tibia's
      const footDir = P(iToe).clone().sub(P(iHeel));
      const footLat = axis(`tibia_${s}`, new THREE.Vector3(0, 0, 1)).setY(0);
      if (footLat.lengthSq() < 1e-4) footLat.copy(zP);
      alignQuat(r[`toe_${s}`].clone().sub(r[`heel_${s}`]), new THREE.Vector3(0, 0, 1), footDir, footLat, q);
      const fo = ankle.clone().sub(r[`ankleF_${s}`].clone().multiplyScalar(sc.foot).applyQuaternion(q));
      place(`foot_${s}`, fo, q, sc.foot);
      pts[`hip_${s}`] = hip; pts[`knee_${s}`] = knee; pts[`ankle_${s}`] = ankle;
      pts[`heel_${s}`] = toWorld(`foot_${s}`, r[`heel_${s}`]); pts[`toe_${s}`] = toWorld(`foot_${s}`, r[`toe_${s}`]);

      // ---- arms
      const iEl = R ? LM.rEl : LM.lEl, iWr = R ? LM.rWr : LM.lWr;
      const iIdx = R ? LM.rIndex : LM.lIndex, iPk = R ? LM.rPinky : LM.lPinky, iTh = R ? LM.rThumb : LM.lThumb;
      const shoulder = toWorld('torso', R ? r.shoulderR : r.shoulderL);
      const upper = P(iEl).clone().sub(shoulder), fore = P(iWr).clone().sub(P(iEl));
      const ePlane = new THREE.Vector3().crossVectors(upper, fore).normalize();
      if (ePlane.dot(zT) < 0) ePlane.negate();
      const eLat = zT.clone().lerp(ePlane, smooth(0.35, 0.9, upper.angleTo(fore))).normalize();
      alignQuat(r[`elbow_${s}`], new THREE.Vector3(0, 0, 1), upper, eLat, q);
      place(`humerus_${s}`, shoulder, q, sc.humerus);
      const elbow = toWorld(`humerus_${s}`, r[`elbow_${s}`]);
      // forearm roll from the hand: thumb is lateral in the anatomical position
      const thumbSide = P(iTh).clone().sub(P(iPk)).multiplyScalar(R ? 1 : -1);
      alignQuat(r[`wrist_${s}`], new THREE.Vector3(0, 0, 1), P(iWr).clone().sub(elbow), thumbSide, q);
      place(`forearm_${s}`, elbow, q, sc.forearm);
      const wrist = toWorld(`forearm_${s}`, r[`wrist_${s}`]);
      alignQuat(r[`tip_${s}`], new THREE.Vector3(0, 0, 1), mid(P(iIdx), P(iPk)).sub(wrist), thumbSide, q);
      place(`hand_${s}`, wrist, q, sc.hand);
      pts[`shoulder_${s}`] = shoulder; pts[`elbow_${s}`] = elbow; pts[`wrist_${s}`] = wrist;

      this.computeAngles(s);
      this.placePatella(s);
    }

    // ---- vertical placement: feet on the floor, or the image-measured lift when airborne
    const lowest = (s: Side) => Math.min(pts[`heel_${s}`].y, pts[`toe_${s}`].y, pts[`ankle_${s}`].y - 0.05 * sc.foot);
    let dy = -Math.min(lowest('R'), lowest('L'));
    if (this.needStanding) { this.standingPelvisY = S.pelvis.pos.y + dy; this.needStanding = false; }
    else if (f.lift !== null && this.calibrated && f.lift > 0.05) {
      // airborne only when the image shows the pelvis above its standing height (impossible in a squat)
      // and higher than the feet-on-the-floor reconstruction allows
      const pelvisFromLift = this.standingPelvisY + f.lift;
      const pelvisContact = S.pelvis.pos.y + dy;
      if (pelvisFromLift > pelvisContact + 0.05) dy = pelvisFromLift - S.pelvis.pos.y;
    }
    for (const k of Object.keys(S)) S[k].pos.y += dy;
    for (const k of Object.keys(pts)) pts[k].y += dy;
    for (const s of SIDES) this.footMinY[s] = lowest(s);
    // contact: a foot is down unless it is clearly higher than the floor (6 cm), so reconstruction
    // error on a planted foot does not take its load away
    for (const s of SIDES) this.contact[s] = this.footMinY[s] < 0.06;
    pts.com = this.centreOfMass();
  }

  /** Patella follows knee flexion along the model's coupler path (mirrored for the right leg). */
  private placePatella(s: Side) {
    const tab = this.meta.patella, k = this.angles[s].knee_flex;
    const v = (j: number) => interp(tab.knee, tab.pose.map((p) => p[j]), k);
    const p = new THREE.Vector3(v(0), v(1), v(2)), q = new THREE.Quaternion(v(3), v(4), v(5), v(6)).normalize();
    if (s === 'R') { p.z = -p.z; q.set(-q.x, -q.y, q.z, q.w); }   // reflection across z of a rotation
    const fem = this.seg[`femur_${s}`];
    this.seg[`patella_${s}`].pos.copy(p.multiplyScalar(fem.scale).applyQuaternion(fem.quat).add(fem.pos));
    this.seg[`patella_${s}`].quat.copy(fem.quat).multiply(q);
    this.seg[`patella_${s}`].scale = fem.scale;
  }

  /** OpenSim-convention angles (degrees); the left side is mirrored so the same tables apply. */
  private computeAngles(s: Side) {
    const S = this.seg, A = this.angles[s];
    const qp = S.pelvis.quat, qf = S[`femur_${s}`].quat, qt = S[`tibia_${s}`].quat, qft = S[`foot_${s}`].quat;
    // hip: R = Rz(flex) Rx(add) Ry(rot) of femur relative to pelvis
    const Rrel = new THREE.Matrix4().makeRotationFromQuaternion(qp.clone().invert().multiply(qf)).elements;
    const m = (r: number, c: number) => Rrel[c * 4 + r];
    const add = Math.asin(THREE.MathUtils.clamp(m(2, 1), -1, 1));
    const flex = Math.atan2(-m(0, 1), m(1, 1));
    const rot = Math.atan2(-m(2, 0), m(2, 2));
    const sgn = s === 'R' ? 1 : -1;   // left adduction and internal rotation are about -x and -y
    A.hip_flex = THREE.MathUtils.radToDeg(flex);
    A.hip_add = THREE.MathUtils.radToDeg(add) * sgn;
    A.hip_rot = THREE.MathUtils.radToDeg(rot) * sgn;
    // knee: tibia relative to femur about the femur's lateral axis (flexion positive)
    const yf = new THREE.Vector3(0, 1, 0).applyQuaternion(qf), yt = new THREE.Vector3(0, 1, 0).applyQuaternion(qt);
    const zf = new THREE.Vector3(0, 0, 1).applyQuaternion(qf);
    A.knee_flex = Math.max(0, THREE.MathUtils.radToDeg(-Math.atan2(new THREE.Vector3().crossVectors(yf, yt).dot(zf), yf.dot(yt))));
    // ankle: foot's long axis in the tibia frame (dorsiflexion positive)
    const xfo = new THREE.Vector3(1, 0, 0).applyQuaternion(qft), xt = new THREE.Vector3(1, 0, 0).applyQuaternion(qt);
    A.ankle_flex = THREE.MathUtils.radToDeg(Math.atan2(xfo.dot(yt), xfo.dot(xt)));
    // knee valgus: how far the knee sits medial of the hip-ankle line (pelvis frontal plane), as an
    // angle over half the leg length. Stable in deep flexion, where a projected knee angle blows up.
    const zp = new THREE.Vector3(0, 0, 1).applyQuaternion(qp);
    const hip = this.pts[`hip_${s}`], knee = this.pts[`knee_${s}`], ank = this.pts[`ankle_${s}`];
    const medial = s === 'R' ? zp.clone().negate() : zp;
    const dev = knee.clone().sub(hip.clone().add(ank).multiplyScalar(0.5)).dot(medial);
    const half = 0.5 * (hip.distanceTo(knee) + knee.distanceTo(ank));
    A.valgus = THREE.MathUtils.radToDeg(Math.atan2(dev, half));
    // elbow (for display)
    const yh = new THREE.Vector3(0, 1, 0).applyQuaternion(S[`humerus_${s}`].quat), ya = new THREE.Vector3(0, 1, 0).applyQuaternion(S[`forearm_${s}`].quat);
    A.elbow = THREE.MathUtils.radToDeg(yh.angleTo(ya));
  }

  /** Whole-body centre of mass from the segment parameters. */
  centreOfMass() {
    const c = new THREE.Vector3();
    let M = 0;
    for (const [k, pose] of Object.entries(this.seg)) {
      const p = this.meta.segments[k.replace(/_[RL]$/, '')];
      if (!p || k.startsWith('patella')) continue;
      const com = new THREE.Vector3(...p.com);
      if (k.endsWith('_L')) com.z = -com.z;
      c.addScaledVector(com.multiplyScalar(pose.scale).applyQuaternion(pose.quat).add(pose.pos), p.mass);
      M += p.mass;
    }
    return c.divideScalar(M);
  }
}
