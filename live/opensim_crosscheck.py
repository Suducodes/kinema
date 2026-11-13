"""OpenSim cross-check of KINEMA's browser physics, for one pilot-mode physics file.

    python live/opensim_crosscheck.py <hold>_physics.csv [--out DIR] [--dry-run] [--plain-scaling]

What it tests: whether the browser's reimplementation of inverse dynamics (ID) and static
optimisation (SO) reproduces what OpenSim 4.6 computes from the SAME inputs: the app's kinematics and
the app's estimated ground force, on the same Lenhart 2015 model. It does NOT test whether the app's
ground-force estimate (from video) is right; that needs a force plate.

Steps
  1. Read the app's physics CSV (+ its .json metadata) written by pilot mode.
  2. Scale lenhart2015_kin.osim by the app's single scale factor, to the app's body mass; gravity 9.81.
  3. Kinematics (.mot): the app's OpenSim-named angles (pelvis, hips, knees, ankles). The right knee's
     secondary coordinates (knee add/rot/tx/ty/tz and the patella's pf_*) follow knee flexion along the
     solved OpenSim JAM knee-bending run (knee/runs/deepflex_healthy), the same run the app's knee moment
     arms come from; for SO they are tied to knee_flex_r by CoordinateCouplerConstraints.
  4. External loads: the app's ground force and centre of pressure for each foot, applied to calcn_r/l.
  5. OpenSim Inverse Dynamics (no filtering) and Static Optimization (sum of squared activations), with
     reserve actuators on hip_flex/add/rot_r, knee_flex_r and ankle_flex_r whose optimal forces are the
     app's residual allowances (sigma), so OpenSim minimises exactly sum a^2 + sum (residual/sigma)^2.
  6. Compare joint moments and muscle activations frame by frame: RMSE, correlation, peak difference;
     report how far OpenSim's bodies end up from the app's segment poses; list every non-equivalence.

--dry-run writes the OpenSim input files and the report skeleton without importing OpenSim.
"""
import argparse
import csv
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / 'knee' / 'vendor' / 'opensim-jam' / 'opensim-jam-release' / 'models' / 'lenhart2015' / 'lenhart2015_kin.osim'
DEEPFLEX = ROOT / 'knee' / 'runs' / 'deepflex_healthy' / 'results' / 'deepflex_states.sto'
COORDS = ['hip_flex', 'hip_add', 'hip_rot', 'knee_flex', 'ankle_flex']
SECONDARY_R = ['knee_add_r', 'knee_rot_r', 'knee_tx_r', 'knee_ty_r', 'knee_tz_r', 'pf_flex_r', 'pf_rot_r', 'pf_tilt_r', 'pf_tx_r', 'pf_ty_r', 'pf_tz_r']
POSE_BODIES = {'pelvis': 'pelvis', 'femur_r': 'femur_r', 'tibia_r': 'tibia_r', 'foot_r': 'calcn_r', 'femur_l': 'femur_l', 'tibia_l': 'tibia_l', 'foot_l': 'calcn_l'}
STATEMENT = ('This cross-check tests the FAITHFULNESS of KINEMA\'s browser reimplementation of inverse dynamics and static '
             'optimisation against OpenSim 4.6 given identical inputs (the app\'s kinematics and the app\'s estimated ground force). '
             'It does NOT test the accuracy of the ground-force estimate, which comes from video and would need a force plate.')


# ----------------------------------------------------------------------------- inputs
def read_physics(path):
    with open(path, newline='') as f:
        rows = list(csv.reader(f))
    head, data = rows[0], np.array([[float(x) for x in r] for r in rows[1:] if r], float)
    cols = {h: data[:, i] for i, h in enumerate(head)}
    meta_path = Path(path).with_suffix('.json')
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    return cols, meta


def model_coordinates(model_path):
    """Every coordinate of the model: name, motion type (rotational / translational), default value."""
    root = ET.parse(model_path).getroot()
    out = []
    for c in root.iter('Coordinate'):
        name = c.get('name')
        dv = c.findtext('default_value')
        out.append((name, float(dv) if dv else 0.0, None))
    # motion type: in this model the translational coordinates are exactly the ones named tx / ty / tz
    return [(n, d, any(part in ('tx', 'ty', 'tz') for part in n.split('_'))) for n, d, _ in out]


def read_sto(path):
    lines = Path(path).read_text().splitlines()
    i = next(k for k, l in enumerate(lines) if l.strip() == 'endheader')
    head = lines[i + 1].split('\t')
    data = np.loadtxt(lines[i + 2:])
    return head, data


def secondary_tables():
    """The right knee's secondary coordinates against knee flexion (rad), from the solved JAM knee-bending run."""
    head, data = read_sto(DEEPFLEX)
    col = lambda c: data[:, next(k for k, h in enumerate(head) if h.endswith(f'/{c}/value'))]
    q = col('knee_flex_r')
    order = np.argsort(q)
    q = q[order]
    keep = np.concatenate([[True], np.diff(q) > 1e-4])
    tables = {c: (q[keep], col(c)[order][keep]) for c in SECONDARY_R}
    return tables


# ----------------------------------------------------------------------------- files for OpenSim
def write_mot(path, t, cols, in_degrees=True, name='coordinates'):
    names = list(cols)
    with open(path, 'w', newline='\n') as f:
        f.write(f'{name}\nversion=1\nnRows={len(t)}\nnColumns={len(names) + 1}\ninDegrees={"yes" if in_degrees else "no"}\nendheader\n')
        f.write('time\t' + '\t'.join(names) + '\n')
        for i in range(len(t)):
            f.write(f'{t[i]:.6f}\t' + '\t'.join(f'{cols[n][i]:.8f}' for n in names) + '\n')


def build_kinematics(P, coords, tables, k):
    """Coordinate values per frame (degrees for rotations, metres for translations)."""
    n = len(P['t_s'])
    out = {}
    for name, default, trans in coords:
        out[name] = np.full(n, default * (k if trans else 180 / math.pi))
    out['pelvis_tilt'], out['pelvis_list'], out['pelvis_rot'] = P['pelvis_tilt_deg'], P['pelvis_list_deg'], P['pelvis_rot_deg']
    out['pelvis_tx'], out['pelvis_ty'], out['pelvis_tz'] = P['pelvis_tx_m'], P['pelvis_ty_m'], P['pelvis_tz_m']
    for s in ('r', 'l'):
        for c in COORDS:
            out[f'{c}_{s}'] = P[f'{c}_{s}_deg']
    qk = P['knee_flex_r_rad']
    for c, (x, y) in tables.items():
        v = np.interp(qk, x, y)
        out[c] = v * k if c.endswith(('_tx_r', '_ty_r', '_tz_r')) else np.degrees(v)
    return out


def write_external_loads(folder, P):
    t = P['t_s']
    cols = {}
    for s in ('r', 'l'):
        for a in 'xyz':
            cols[f'ground_force_{s}_v{a}'] = P[f'grf_{s}_{a}_N']
        for a in 'xyz':
            cols[f'ground_force_{s}_p{a}'] = P[f'cop_{s}_{a}_m']
        for a in 'xyz':
            cols[f'ground_torque_{s}_{a}'] = np.zeros_like(t)
    write_mot(folder / 'grf.mot', t, cols, in_degrees=False, name='grf')
    forces = ''.join(f"""
      <ExternalForce name="foot_{s}">
        <applied_to_body>calcn_{s}</applied_to_body>
        <force_expressed_in_body>ground</force_expressed_in_body>
        <point_expressed_in_body>ground</point_expressed_in_body>
        <force_identifier>ground_force_{s}_v</force_identifier>
        <point_identifier>ground_force_{s}_p</point_identifier>
        <torque_identifier>ground_torque_{s}_</torque_identifier>
        <data_source_name>grf</data_source_name>
      </ExternalForce>""" for s in ('r', 'l'))
    (folder / 'external_loads.xml').write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<OpenSimDocument Version="40000">
  <ExternalLoads name="kinema_estimated_grf">
    <objects>{forces}
    </objects>
    <datafile>grf.mot</datafile>
  </ExternalLoads>
</OpenSimDocument>
""")


# ----------------------------------------------------------------------------- OpenSim
def prepare_model(osim, k, mass, strength, emulate_arms, tables, sigma, coords):
    model = osim.Model(str(MODEL))
    model.setGravity(osim.Vec3(0, -9.81, 0))
    state = model.initSystem()
    scale_set = osim.ScaleSet()
    for b in range(model.getBodySet().getSize()):
        sc = osim.Scale()
        sc.setSegmentName(model.getBodySet().get(b).getName()); sc.setScaleFactors(osim.Vec3(k, k, k)); sc.setApply(True)
        scale_set.cloneAndAppend(sc)
    model.scale(state, scale_set, True, mass)
    # muscles as the app models them: strength x (mass / model mass)^(2/3); rigid tendon; no passive fibre force.
    # The app uses the UNSCALED model's moment arms; emulated here by dividing max force by k (moment = a F r).
    f_scale = strength / (k if emulate_arms else 1.0)
    notes = []
    for i in range(model.getMuscles().getSize()):
        mu = model.getMuscles().get(i)
        mu.setMaxIsometricForce(mu.getMaxIsometricForce() * f_scale)
        mil = osim.Millard2012EquilibriumMuscle.safeDownCast(mu)
        if mil is not None:
            mil.set_ignore_tendon_compliance(True)
            try:
                mil.set_ignore_passive_fiber_force(True)
            except AttributeError:
                if not notes:
                    notes.append('This OpenSim build has no ignore_passive_fiber_force: OpenSim muscles keep their passive force (the app has none).')
    # right knee secondary coordinates tied to knee flexion (translations scaled by k)
    for c, (x, y) in tables.items():
        trans = c.endswith(('_tx_r', '_ty_r', '_tz_r'))
        fn = osim.SimmSpline()
        for xi, yi in zip(x[::3], y[::3]):
            fn.addPoint(float(xi), float(yi * k if trans else yi))
        cc = osim.CoordinateCouplerConstraint()
        cc.setName(f'couple_{c}')
        names = osim.ArrayStr(); names.append('knee_flex_r')
        cc.setIndependentCoordinateNames(names); cc.setDependentCoordinateName(c); cc.setFunction(fn)
        model.addConstraint(cc)
    # reserves: the app's residual allowance on its five coordinates; cheap everywhere the app balances nothing
    dependent = set(tables)
    for name, _, _ in coords:
        if name in dependent:
            continue
        base = name[:-2] if name.endswith('_r') else None
        ca = osim.CoordinateActuator(name)
        ca.setName(f'reserve_{name}')
        ca.setOptimalForce(float(sigma[base]) if base in sigma else 1000.0)
        ca.setMinControl(-1e6); ca.setMaxControl(1e6)
        model.addForce(ca)
    model.finalizeConnections()
    model.initSystem()
    return model, notes


def run_opensim(folder, P, kin, coords, tables, meta, emulate_arms):
    import opensim as osim
    k = float(np.median(P['scale_factor'])); mass = float(np.median(P['mass_kg']))
    model_mass = float(meta.get('model', {}).get('model_mass_kg', 62.0))
    strength = (mass / model_mass) ** (2 / 3)
    sigma = meta.get('sigma_Nm', {'hip_flex': 2, 'hip_add': 4, 'hip_rot': 10, 'knee_flex': 2, 'ankle_flex': 2})
    model, notes = prepare_model(osim, k, mass, strength, emulate_arms, tables, sigma, coords)
    model.printToXML(str(folder / 'model_scaled_crosscheck.osim'))
    t0, t1 = float(P['t_s'][0]), float(P['t_s'][-1])
    # inverse dynamics
    idt = osim.InverseDynamicsTool()
    idt.setModel(model)
    idt.setCoordinatesFileName(str(folder / 'kinematics.mot'))
    idt.setExternalLoadsFileName(str(folder / 'external_loads.xml'))
    idt.setLowpassCutoffFrequency(-1)
    idt.setStartTime(t0); idt.setEndTime(t1)
    excl = osim.ArrayStr(); excl.append('Muscles'); excl.append('Actuators')
    idt.setExcludedForces(excl)
    idt.setResultsDir(str(folder)); idt.setOutputGenForceFileName('id_opensim.sto')
    idt.run()
    # static optimisation
    at = osim.AnalyzeTool(model)
    at.setName('so')
    at.setCoordinatesFileName(str(folder / 'kinematics.mot'))
    at.setExternalLoadsFileName(str(folder / 'external_loads.xml'))
    at.setLowpassCutoffFrequency(-1)
    at.setInitialTime(t0); at.setFinalTime(t1)
    at.setResultsDir(str(folder))
    so = osim.StaticOptimization()
    so.setStartTime(t0); so.setEndTime(t1)
    so.setUseModelForceSet(True); so.setActivationExponent(2); so.setUseMusclePhysiology(True)
    so.setConvergenceCriterion(1e-6); so.setMaxIterations(500)
    at.getAnalysisSet().cloneAndAppend(so)
    at.run()
    # where OpenSim's bodies sit compared with the app's segment poses
    pose = pose_mismatch(osim, model, kin, P)
    return pose, {'k': k, 'mass': mass, 'strength': strength, 'force_scale': strength / (k if emulate_arms else 1), 'notes': notes}


def pose_mismatch(osim, model, kin, P):
    state = model.initSystem()
    cs = model.getCoordinateSet()
    err = {b: {'deg': [], 'mm': []} for b in POSE_BODIES}
    for i in range(len(P['t_s'])):
        for j in range(cs.getSize()):
            c = cs.get(j)
            if c.getName() in kin:
                v = kin[c.getName()][i]
                c.setValue(state, math.radians(v) if c.getMotionType() == 1 else v, False)
        model.realizePosition(state)
        for key, body in POSE_BODIES.items():
            T = model.getBodySet().get(body).getTransformInGround(state)
            p = np.array([T.p().get(a) for a in range(3)])
            R = np.array([[T.R().get(r, c) for c in range(3)] for r in range(3)])
            pa = np.array([P[f'pose_{key}_p{a}'][i] for a in 'xyz'])
            q = [P[f'pose_{key}_q{a}'][i] for a in 'xyzw']
            Ra = quat_to_R(q)
            ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(Ra.T @ R) - 1) / 2))))
            err[key]['deg'].append(ang); err[key]['mm'].append(1000 * np.linalg.norm(p - pa))
    return {b: {'deg_mean': float(np.mean(v['deg'])), 'mm_mean': float(np.mean(v['mm']))} for b, v in err.items()}


def quat_to_R(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


# ----------------------------------------------------------------------------- comparison
def agreement(app, osim_v):
    d = app - osim_v
    r = float(np.corrcoef(app, osim_v)[0, 1]) if np.std(app) > 1e-9 and np.std(osim_v) > 1e-9 else float('nan')
    return {'rmse': float(np.sqrt(np.mean(d * d))), 'r': r, 'peak_diff': float(d[np.argmax(np.abs(d))]),
            'app_mean': float(np.mean(app)), 'opensim_mean': float(np.mean(osim_v))}


def knee_effective(id_cols, tables, qk):
    """Knee flexion moment with the coupled secondary coordinates folded in (virtual work):
    tau_eff = tau_knee_flex + sum dq_dep/dq_flex * tau_dep. ID itself ignores the coupler constraints."""
    tau = id_cols['knee_flex_r_moment'].copy()
    for c, (x, y) in tables.items():
        key = f'{c}_{"force" if c.endswith(("_tx_r", "_ty_r", "_tz_r")) else "moment"}'
        if key in id_cols:
            dydx = np.interp(qk, x, np.gradient(y, x))
            tau += dydx * id_cols[key]
    return tau


def compare(folder, P, tables, meta):
    head, data = read_sto(folder / 'id_opensim.sto')
    id_cols = {h: data[:, i] for i, h in enumerate(head)}
    moments = {}
    for s in ('r', 'l'):
        for c in COORDS:
            app = P[f'moment_{c}_{s}_Nm']
            if c == 'knee_flex' and s == 'r':
                os_v = knee_effective(id_cols, tables, P['knee_flex_r_rad'])
            else:
                os_v = id_cols.get(f'{c}_{s}_moment')
            if os_v is not None:
                moments[f'{c}_{s}'] = agreement(app, os_v[:len(app)])
    acts = {}
    act_file = next(folder.glob('so_StaticOptimization_activation.sto'), None)
    if act_file:
        head, data = read_sto(act_file)
        so_cols = {h: data[:, i] for i, h in enumerate(head)}
        for m in meta.get('muscle_order', []):
            if f'{m}_r' in so_cols and f'act_{m}_r' in P:
                acts[m] = agreement(P[f'act_{m}_r'], so_cols[f'{m}_r'][:len(P['t_s'])])
    return moments, acts


# ----------------------------------------------------------------------------- report
DIFFERENCES = [
    'Force-length curve: the app uses a Gaussian active curve (width 0.62, floor 0.25); OpenSim uses the Millard 2012 curve. Not made identical.',
    'Passive fibre force: the app has none; it is switched off in the OpenSim model here (ignore_passive_fiber_force).',
    'Tendon: the app assumes a rigid tendon; set rigid here too (ignore_tendon_compliance).',
    'Force-velocity: the app ignores it; OpenSim SO includes it. Holds are near-static, so the effect should be small.',
    'Moment arms: the app interpolates 1-D tables per coordinate (hip and ankle from OpenSim at neutral posture, knee from the solved JAM knee-bending run with the hip neutral); OpenSim computes them at the full current pose.',
    'Moment-arm scaling: the app uses the UNSCALED model\'s moment arms while scaling the skeleton by k; emulated here by dividing max isometric force by k (default; --plain-scaling turns this off and is the more anatomical choice).',
    'Muscle strength: the app scales max isometric force by (mass / model mass)^(2/3); OpenSim scaling does not, so it is applied here.',
    'Segments: the app lumps patella with the tibia and talus/calcaneus/toes into one foot, and builds the right leg from the mirrored LEFT standard bones; OpenSim uses its own right-leg bodies (MRI-based knee). See the pose mismatch table.',
    'Knee: the app rotates the tibia rigidly about one knee point; OpenSim\'s 6-degree-of-freedom knee follows the solved knee-bending run. ID ignores coupler constraints, so the knee flexion moment is compared after folding in the secondary coordinates by virtual work.',
    'Accelerations: the app uses a causal quadratic fit over 0.26 s; OpenSim ID fits splines to the coordinates (no low-pass filter here).',
    'Ankle: the app\'s foot can tilt freely in 3D; here only ankle_flex is carried over (subtalar and toes at 0).',
    'Reserves: hip_flex/add/rot_r, knee_flex_r and ankle_flex_r carry reserves with optimal force equal to the app\'s sigma, so the cost matches the app\'s sum a^2 + sum (residual/sigma)^2. Every other coordinate gets a cheap reserve (1000), because the app balances nothing there.',
    'Gravity: set to 9.81 m/s^2 to match the app (OpenSim default 9.80665).',
]


def report(folder, P, meta, moments, acts, pose, info, dry):
    lines = ['# OpenSim cross-check of KINEMA browser physics', '', f'**{STATEMENT}**', '',
             f'- Input: `{meta.get("hold", "?")}` ({len(P["t_s"])} frames, {P["t_s"][0]:.2f} to {P["t_s"][-1]:.2f} s)',
             f'- App: version {meta.get("app", {}).get("version", "?")}, commit {meta.get("app", {}).get("commit", "?")}; '
             f'twin.json {meta.get("model", {}).get("twin_json_sha256_16", "?")}, twin.glb {meta.get("model", {}).get("twin_glb_sha256_16", "?")}',
             f'- Height {np.median(P["height_m"]):.2f} m, mass {np.median(P["mass_kg"]):.1f} kg, scale factor k = {np.median(P["scale_factor"]):.4f}', '']
    if info:
        lines += [f'- Muscle max force multiplier used in OpenSim: {info["force_scale"]:.4f} (strength {info["strength"]:.4f})'] + [f'- NOTE: {n}' for n in info.get('notes', [])] + ['']
    if dry:
        lines += ['**Dry run:** OpenSim was not run. The input files for it are in this folder (kinematics.mot, grf.mot, external_loads.xml).', '']
    if moments:
        lines += ['## Joint moments (N m): app vs OpenSim ID', '', '| coordinate | app mean | OpenSim mean | RMSE | r | peak diff |', '|---|---|---|---|---|---|']
        lines += [f'| {k} | {v["app_mean"]:.2f} | {v["opensim_mean"]:.2f} | {v["rmse"]:.2f} | {v["r"]:.3f} | {v["peak_diff"]:.2f} |' for k, v in moments.items()]
        lines.append('')
    if acts:
        all_rmse = np.sqrt(np.mean([v['rmse'] ** 2 for v in acts.values()]))
        lines += ['## Muscle activations (0-1): app vs OpenSim SO (right leg)', '', f'Pooled RMSE over {len(acts)} muscles: **{all_rmse:.3f}**', '',
                  '| muscle | app mean | OpenSim mean | RMSE | r |', '|---|---|---|---|---|']
        top = sorted(acts.items(), key=lambda kv: -max(kv[1]['app_mean'], kv[1]['opensim_mean']))
        lines += [f'| {k} | {v["app_mean"]:.3f} | {v["opensim_mean"]:.3f} | {v["rmse"]:.3f} | {v["r"]:.3f} |' for k, v in top]
        lines.append('')
    if pose:
        lines += ['## Kinematic mapping: OpenSim bodies vs the app\'s segment poses', '', '| segment | mean orientation diff (deg) | mean origin distance (mm) |', '|---|---|---|']
        lines += [f'| {k} | {v["deg_mean"]:.2f} | {v["mm_mean"]:.1f} |' for k, v in pose.items()]
        lines.append('')
    lines += ['## Not equivalent (stated, not hidden)', ''] + [f'- {d}' for d in DIFFERENCES] + ['']
    (folder / 'crosscheck_report.md').write_text('\n'.join(lines), encoding='utf-8')
    (folder / 'crosscheck_summary.json').write_text(json.dumps({'statement': STATEMENT, 'moments': moments, 'activations': acts, 'pose_mismatch': pose,
                                                                'settings': info, 'differences': DIFFERENCES, 'dry_run': dry}, indent=1))


def plots(folder, P, moments, tables):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print('matplotlib not installed: skipping plots')
        return
    head, data = read_sto(folder / 'id_opensim.sto')
    id_cols = {h: data[:, i] for i, h in enumerate(head)}
    fig, axes = plt.subplots(2, 5, figsize=(16, 6), sharex=True)
    for row, s in enumerate(('r', 'l')):
        for col, c in enumerate(COORDS):
            ax = axes[row, col]
            os_v = knee_effective(id_cols, tables, P['knee_flex_r_rad']) if (c == 'knee_flex' and s == 'r') else id_cols.get(f'{c}_{s}_moment')
            ax.plot(P['t_s'], P[f'moment_{c}_{s}_Nm'], label='KINEMA (browser)')
            if os_v is not None:
                ax.plot(P['t_s'], os_v[:len(P['t_s'])], '--', label='OpenSim ID')
            ax.set_title(f'{c}_{s} (N m)', fontsize=9)
    axes[0, 0].legend(fontsize=8)
    fig.tight_layout(); fig.savefig(folder / 'moments_overlay.png', dpi=130); plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('physics_csv')
    ap.add_argument('--out', default=None)
    ap.add_argument('--dry-run', action='store_true', help='write the OpenSim inputs and the report skeleton; do not import OpenSim')
    ap.add_argument('--plain-scaling', action='store_true', help='use the scaled model\'s own moment arms (do not emulate the app\'s unscaled ones)')
    a = ap.parse_args()
    src = Path(a.physics_csv)
    folder = Path(a.out) if a.out else src.with_name(src.stem + '_crosscheck')
    folder.mkdir(parents=True, exist_ok=True)
    P, meta = read_physics(src)
    coords = model_coordinates(MODEL)
    tables = secondary_tables()
    k = float(np.median(P['scale_factor']))
    kin = build_kinematics(P, coords, tables, k)
    write_mot(folder / 'kinematics.mot', P['t_s'], kin)
    write_external_loads(folder, P)
    print(STATEMENT)
    if a.dry_run:
        report(folder, P, meta, {}, {}, {}, None, True)
        print(f'dry run: wrote {folder}')
        return
    try:
        pose, info = run_opensim(folder, P, kin, coords, tables, meta, not a.plain_scaling)
    except ImportError as e:
        sys.exit(f'OpenSim could not be imported ({e}). Use --dry-run to write the inputs only.')
    moments, acts = compare(folder, P, tables, meta)
    report(folder, P, meta, moments, acts, pose, info, False)
    plots(folder, P, moments, tables)
    print(f'wrote {folder / "crosscheck_report.md"}')


if __name__ == '__main__':
    main()
