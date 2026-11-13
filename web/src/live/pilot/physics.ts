import * as THREE from 'three';
import { COORDS, type TwinMeta } from '../assets';
import { SIDES, type Body } from '../body';
import { SIGMA, type Physics } from '../physics';

/**
 * Per-frame physics record for the OpenSim cross-check (live/opensim_crosscheck.py): everything the
 * browser computed, in OpenSim's coordinate names for the Lenhart 2015 model, plus the segment poses
 * themselves so the script can rebuild the same kinematics in OpenSim and report any mismatch.
 */
const POSE_SEGS = ['pelvis', 'torso', 'femur_R', 'tibia_R', 'foot_R', 'femur_L', 'tibia_L', 'foot_L'];
const DEG = 180 / Math.PI;

/** R = Rz(a) Rx(b) Ry(c) (OpenSim CustomJoint order used by the pelvis and hips here): returns [a, b, c] rad. */
function zxy(q: THREE.Quaternion) {
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements, m = (r: number, c: number) => e[c * 4 + r];
  return [Math.atan2(-m(0, 1), m(1, 1)), Math.asin(THREE.MathUtils.clamp(m(2, 1), -1, 1)), Math.atan2(-m(2, 0), m(2, 2))];
}

export class PhysicsLog {
  readonly header: string[];
  private rows: { t: number; v: number[] }[] = [];
  private frame = 0;
  constructor(private readonly meta: TwinMeta) {
    const n = meta.muscles.names;
    const ang = (c: string) => [`${c}_deg`, `${c}_rad`];
    const sides = SIDES.map((s) => s.toLowerCase());
    this.header = ['frame', 't_s', 'scale_factor', 'height_m', 'mass_kg',
      ...['pelvis_tilt', 'pelvis_list', 'pelvis_rot'].flatMap(ang), 'pelvis_tx_m', 'pelvis_ty_m', 'pelvis_tz_m',
      ...sides.flatMap((s) => COORDS.map((c) => `${c}_${s}`).flatMap(ang)),
      ...sides.flatMap((s) => ['x', 'y', 'z'].map((a) => `grf_${s}_${a}_N`)), ...sides.flatMap((s) => ['x', 'y', 'z'].map((a) => `cop_${s}_${a}_m`)),
      ...sides.flatMap((s) => COORDS.map((c) => `moment_${c}_${s}_Nm`)), ...sides.flatMap((s) => COORDS.map((c) => `moment_${c}_${s}_Nmkg`)),
      ...sides.flatMap((s) => COORDS.map((c) => `residual_${c}_${s}_Nm`)),
      ...sides.flatMap((s) => n.map((m) => `act_${m}_${s}`)), ...sides.map((s) => `so_cost_${s}`),
      ...POSE_SEGS.flatMap((k) => ['px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw'].map((a) => `pose_${k.toLowerCase()}_${a}`)),
      ...sides.flatMap((s) => ['hip', 'knee', 'ankle'].flatMap((j) => ['x', 'y', 'z'].map((a) => `joint_${j}_${s}_${a}_m`))),
    ];
  }

  /** Record the current frame (call right after physics has run for it). */
  push(t: number, body: Body, phys: Physics, heightM: number) {
    const A = body.angles, P = body.seg.pelvis, v: number[] = [this.frame++, t, body.scale.femur, heightM, phys.mass];
    const pr = zxy(P.quat);
    for (const a of pr) v.push(a * DEG, a);
    v.push(P.pos.x, P.pos.y, P.pos.z);
    for (const s of SIDES) for (const c of COORDS) v.push(A[s][c], A[s][c] / DEG);
    for (const s of SIDES) v.push(phys.res[s].grf.x, phys.res[s].grf.y, phys.res[s].grf.z);
    for (const s of SIDES) v.push(phys.res[s].cop.x, phys.res[s].cop.y, phys.res[s].cop.z);
    for (const s of SIDES) for (const c of COORDS) v.push(phys.res[s].tau[c]);
    for (const s of SIDES) for (const c of COORDS) v.push(phys.res[s].tau[c] / phys.mass);
    for (const s of SIDES) for (const c of COORDS) v.push(phys.res[s].residual[c]);
    for (const s of SIDES) v.push(...phys.res[s].actRaw);
    for (const s of SIDES) v.push(phys.res[s].cost);
    for (const k of POSE_SEGS) { const p = body.seg[k]; v.push(p.pos.x, p.pos.y, p.pos.z, p.quat.x, p.quat.y, p.quat.z, p.quat.w); }
    for (const s of SIDES) for (const j of ['hip', 'knee', 'ankle']) { const p = body.pts[`${j}_${s}`]; v.push(p?.x ?? NaN, p?.y ?? NaN, p?.z ?? NaN); }
    this.rows.push({ t, v });
    while (this.rows.length && t - this.rows[0].t > 8) this.rows.shift();
  }

  clear() { this.rows = []; }

  /** CSV of every frame in [t0, t1]. */
  window(t0: number, t1: number) {
    const rows = this.rows.filter((r) => r.t >= t0 - 1e-6 && r.t <= t1 + 1e-6);
    const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toPrecision(8));
    return { n: rows.length, csv: [this.header.join(','), ...rows.map((r) => r.v.map(fmt).join(','))].join('\n') };
  }

  /** Metadata stamped into every physics export. */
  metadata(extra: Record<string, unknown>, hashes: { json: string; glb: string }) {
    return {
      format: 'kinema-physics-v1',
      app: { version: __APP_VERSION__, commit: __APP_COMMIT__ },
      model: { source: this.meta.source, twin_json_sha256_16: hashes.json, twin_glb_sha256_16: hashes.glb, model_mass_kg: this.meta.model_mass },
      world_frame: 'metres; y up; x to the camera\'s right; z toward the camera (OpenSim ground needs y up only)',
      gravity_m_s2: 9.81,
      angles: 'OpenSim coordinate names of the Lenhart 2015 model. knee_flex: straight = 0, flexion positive. pelvis_tilt/list/rot and hip_flex/add/rot ' +
        'are body-fixed Z-X-Y rotations (pelvis in ground, femur in pelvis), as the model\'s CustomJoints; the left side uses OpenSim\'s left-side ' +
        'signs. ankle_flex is the foot\'s long axis in the tibia frame (dorsiflexion positive). Values come from the app\'s segment poses (pose_* columns).',
      moments: 'net joint moments from the app\'s 3D Newton-Euler inverse dynamics (foot -> shank -> thigh), projected on the OpenSim coordinate axes; ' +
        'positive = the coordinate\'s positive direction (e.g. negative knee_flex moment = knee extensor moment).',
      activations: 'the optimiser\'s output for this frame (no display smoothing): min sum a^2 + sum (residual/sigma)^2, 0 <= a <= 1',
      sigma_Nm: SIGMA,
      muscle_order: this.meta.muscles.names,
      note: 'Ground reaction force and centre of pressure are the app\'s estimates from whole-body Newton-Euler, not measurements.',
      ...extra,
    };
  }
}
