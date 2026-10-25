"""Export the knee simulations for the viewer (web/public/knee/).

Everything is expressed in the distal femur's frame (the camera stays on the knee):
  per frame  tibia [p q] | patella [p q] | ligament paths K points x 3 per bundle | strain % per bundle
             | force N per bundle | knee readouts [tx ty tz mm, add rot flex deg] | applied load
Ligament paths (including wrapping) come from OpenSim 4.6 on the kinematics-only models, placed by
the states that the JAM forsim tool solved. A torn bundle (absent from the injured model) is stored
as the straight line between its femoral and tibial attachments, so the viewer can draw the stumps.
"""
import json
import re
from pathlib import Path

import numpy as np
import opensim as osim

from analyze import load

HERE = Path(__file__).resolve().parent
MODELS = HERE / 'vendor' / 'opensim-jam' / 'opensim-jam-release' / 'models' / 'lenhart2015'
RUNS = HERE / 'runs'
OUT = HERE.parent / 'web' / 'public' / 'knee'
K = 6            # points per ligament path
STEP = 2         # keep every 2nd 10 ms sample -> 50 fps
TESTS = {
    'lachman': {'label': 'Lachman test', 'checks': 'ACL', 'load': 'force', 'dir': 1,
                'what': 'Knee bent 25°, the shin is pulled forward with 100 N. The ACL stops it sliding.'},
    'post_drawer': {'label': 'Posterior drawer', 'checks': 'PCL', 'load': 'force', 'dir': -1,
                    'what': 'Knee bent 90°, the shin is pushed back with 100 N. The PCL stops it sagging.'},
    'varus': {'label': 'Varus stress', 'checks': 'LCL', 'load': 'torque', 'dir': 1,
              'what': 'Knee bent 20°, a 10 N·m bend opens the outer side. The LCL holds it closed.'},
    'valgus': {'label': 'Valgus stress', 'checks': 'MCL', 'load': 'torque', 'dir': -1,
               'what': 'Knee bent 20°, a 10 N·m bend opens the inner side. The MCL holds it closed.'},
    'flexion': {'label': 'Bending 0→90°', 'checks': 'all', 'load': 'none', 'dir': 0,
                'what': 'The knee bends slowly with no extra load: each ligament tightens and slackens in turn.'},
}
READ = ['knee_tx_r', 'knee_ty_r', 'knee_tz_r', 'knee_add_r', 'knee_rot_r', 'knee_flex_r']


def mat(T):
    """SimTK Transform -> 4x4 numpy matrix."""
    M = np.eye(4)
    R = T.R()
    M[:3, :3] = [[R.get(r, c) for c in range(3)] for r in range(3)]
    M[:3, 3] = T.p().to_numpy()
    return M


def quat(R):
    """Rotation matrix -> quaternion (x, y, z, w)."""
    w = np.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = np.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2
    y = np.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2
    z = np.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2
    x = np.copysign(x, R[2, 1] - R[1, 2]); y = np.copysign(y, R[0, 2] - R[2, 0]); z = np.copysign(z, R[1, 0] - R[0, 1])
    return [x, y, z, w]


def pose(M):
    return [*M[:3, 3], *quat(M[:3, :3])]


def apply(M, v):
    return (M @ np.append(v, 1.0))[:3]


def resample(pts, n):
    pts = np.asarray(pts)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    if s[-1] == 0:
        return np.repeat(pts[:1], n, axis=0)
    u = np.linspace(0, s[-1], n)
    return np.stack([np.interp(u, s, pts[:, k]) for k in range(3)], axis=1)


def attachments(model):
    """Femoral (first) and tibial (last) path point of every bundle, in their own body frames."""
    out = {}
    for c in model.getComponentsList():
        if c.getConcreteClassName() != 'Blankevoort1991Ligament':
            continue
        pps = osim.Blankevoort1991Ligament.safeDownCast(c).getGeometryPath().getPathPointSet()
        first, last = pps.get(0), pps.get(pps.getSize() - 1)
        out[c.getName()] = [(osim.PathPoint.safeDownCast(p).getParentFrame().getName(),
                             osim.PathPoint.safeDownCast(p).get_location().to_numpy().copy()) for p in (first, last)]
    return out


def export(test, which, model, bundles, attach):
    run = RUNS / f'{test}_{which}'
    sh, sd = load(next((run / 'results').glob('*_states.sto')))
    fh, fd = load(next((run / 'results').glob('*ForceReporter_forces.sto')))
    state = model.initSystem()
    svars = {model.getStateVariableNames().getitem(i) for i in range(model.getNumStateVariables())}
    vcols = [(j, n) for j, n in enumerate(sh) if n in svars and n.endswith('/value')]
    femur = model.getBodySet().get('femur_distal_r')
    tibia, patella = model.getBodySet().get('tibia_proximal_r'), model.getBodySet().get('patella_r')
    ligs = {b: osim.Blankevoort1991Ligament.safeDownCast(model.getComponent(f'/forceset/{b}')) if model.hasComponent(f'/forceset/{b}') else None
            for b in bundles}
    rcol = {r: next(j for j, n in enumerate(sh) if n.endswith(f'/{r}/value')) for r in READ}
    ext = load(run / 'inputs' / 'external_loads.sto')
    lcol = 1 if TESTS[test]['load'] == 'force' else 7    # force_vx or torque_x
    rows = []
    for i in range(0, len(sd), STEP):
        t = sd[i, 0]
        for j, n in vcols:
            model.setStateVariableValue(state, n, float(sd[i, j]))
        model.realizePosition(state)
        Finv = np.linalg.inv(mat(femur.getTransformInGround(state)))
        row = pose(Finv @ mat(tibia.getTransformInGround(state))) + pose(Finv @ mat(patella.getTransformInGround(state)))
        fi = min(np.searchsorted(fd[:, 0], t - 1e-9), len(fd) - 1)
        strain, force = [], []
        for b in bundles:
            lg = ligs[b]
            if lg is not None:
                path = lg.getGeometryPath().getCurrentPath(state)
                pts = [apply(Finv, path.get(k).getLocationInGround(state).to_numpy()) for k in range(path.getSize())]
                strain.append(fd[fi, fh.index(f'{b}.strain')] * 100)
                force.append(fd[fi, fh.index(f'{b}.force_total')])
            else:   # torn: straight line between the attachments, nothing carried
                pts = []
                for frame, loc in attach[b]:
                    body = model.getBodySet().get(frame)
                    pts.append(apply(Finv @ mat(body.getTransformInGround(state)), loc))
                strain.append(np.nan); force.append(0.0)
            row += resample(pts, K).ravel().tolist()
        row += strain + force
        row += [sd[i, rcol[r]] * (1000 if r in ('knee_tx_r', 'knee_ty_r', 'knee_tz_r') else 57.29578) for r in READ]
        row += [float(np.interp(t, ext[1][:, 0], ext[1][:, lcol]))]
        rows.append(row)
    data = np.asarray(rows, dtype=np.float32)
    data.tofile(OUT / f'{test}_{which}.bin')
    return len(rows), data.shape[1]


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    healthy = osim.Model(str(MODELS / 'lenhart2015_kin.osim'))
    healthy.initSystem()
    attach = attachments(healthy)
    bundles = sorted(attach, key=lambda b: (re.sub(r'\d+$', '', b), int(re.search(r'\d+$', b).group())))
    injured = osim.Model(str(MODELS / 'lenhart2015_injured_kin.osim'))
    injured.initSystem()
    torn = [b for b in bundles if not injured.hasComponent(f'/forceset/{b}')]
    meta = {'K': K, 'fps': 100 / STEP, 'bundles': bundles, 'torn': torn,
            'groups': sorted({re.sub(r'\d+$', '', b) for b in bundles}), 'read': READ, 'tests': TESTS,
            'layout': 'tibia[7] patella[7] | paths[B*K*3] | strain[B] | force[B] | read[6] | load[1]',
            'stretched': {'bundles': ['MCLs', 'MCLd'], 'slack_pct': 6, 'stiffness_factor': 0.5},
            'meshes': {'femur-bone': 'femur', 'femur-cartilage': 'femur', 'tibia-bone': 'tibia', 'tibia-cartilage': 'tibia',
                       'fibula-bone': 'tibia', 'patella-bone': 'patella', 'patella-cartilage': 'patella'},
            'runs': {}}
    for test in TESTS:
        for which, model in (('healthy', healthy), ('injured', injured)):
            n, stride = export(test, which, model, bundles, attach)
            meta['runs'][f'{test}_{which}'] = {'frames': n, 'stride': stride}
            print(test, which, n, 'frames x', stride)
    summary = json.loads((RUNS / 'summary.json').read_text()) if (RUNS / 'summary.json').exists() else {}
    meta['summary'] = summary
    (OUT / 'knee.json').write_text(json.dumps(meta, indent=1))
    print('torn bundles:', len(torn))
