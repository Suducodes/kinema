"""Export a Moco gait run for the website (three.js shares OpenSim's axes: x fwd, y up, z right).

Writes web/public/data/<name>.json (header) + <name>.bin (Float32, frame-major):
  per frame: meshes [px py pz qx qy qz qw] x M | muscles [x y z] x N_PATH x K
             | activation x K | tendon force (N) x K | GRF r [fx fy px] | GRF l [fx fy px]
             | readout [ankle_r_deg knee_r_deg hip_r_deg]
States are linearly interpolated between solver samples; forward travel is removed
(treadmill); the clip is a whole number of strides so it loops seamlessly.

    python export_web.py <run_tag> <model.osim> <name> [--fps 60 --seconds 8]
"""
import argparse
import json
from pathlib import Path

import numpy as np
import opensim as osim

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'web' / 'public' / 'data'
N_PATH = 14


def resample(points, n):
    pts = np.asarray(points)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    if s[-1] == 0:
        return np.repeat(pts[:1], n, axis=0)
    u = np.linspace(0, s[-1], n)
    return np.stack([np.interp(u, s, pts[:, k]) for k in range(3)], axis=1)


def export(tag, model_path, name, fps, seconds):
    model = osim.Model(str(model_path))
    state = model.initSystem()
    run = ROOT / 'data' / 'runs' / tag
    table = osim.TimeSeriesTable(str(run / 'stride.sto'))
    times = np.array(table.getIndependentColumn())
    t0, T = times[0], times[-1] - times[0]
    svars = {model.getStateVariableNames().getitem(i) for i in range(model.getNumStateVariables())}
    cols = {c: table.getDependentColumn(c).to_numpy() for c in table.getColumnLabels() if c in svars}
    grf = osim.TimeSeriesTable(str(run / 'grf.sto'))
    gt = np.array(grf.getIndependentColumn())
    gcol = {c: grf.getDependentColumn(c).to_numpy() for c in grf.getColumnLabels()}

    meshes = [osim.Mesh.safeDownCast(c) for c in model.getComponentsList() if c.getConcreteClassName() == 'Mesh']
    muscles = [model.getMuscles().get(i) for i in range(model.getMuscles().getSize())] if model.getMuscles().getSize() \
        else [osim.Muscle.safeDownCast(c) for c in model.getComponentsList() if c.getConcreteClassName().endswith('Muscle')]
    cs = model.getCoordinateSet()
    tx = cols['/jointset/groundPelvis/pelvis_tx/value']
    speed = (tx[-1] - tx[0]) / T
    strides = max(1, round(seconds / T))
    T_play = seconds / strides
    scale = T / T_play
    n = int(round(fps * seconds))

    rows, events = [], {'heel_strike_r': [], 'toe_off_r': []}
    prev_vy = None
    for f in range(n):
        tm = ((f / fps) % T_play) * scale
        ts = t0 + tm
        for c, v in cols.items():
            model.setStateVariableValue(state, c, float(np.interp(ts, times, v)))
        state.setTime(ts)
        model.realizeDynamics(state)
        shift = -tm * speed - tx[0]
        row = []
        for m in meshes:
            X = m.getFrame().getTransformInGround(state)
            p = X.p().to_numpy().copy(); p[0] += shift
            q = X.R().convertRotationToQuaternion()  # SimTK: w, x, y, z
            row += [p[0], p[1], p[2], q.get(1), q.get(2), q.get(3), q.get(0)]
        for mu in muscles:
            path = mu.getGeometryPath().getCurrentPath(state)
            pts = []
            for k in range(path.getSize()):
                v = path.get(k).getLocationInGround(state).to_numpy().copy(); v[0] += shift
                pts.append(v)
            row += resample(pts, N_PATH).ravel().tolist()
        row += [mu.getActivation(state) for mu in muscles]
        row += [mu.getTendonForce(state) for mu in muscles]
        g = {c: float(np.interp(ts, gt, v)) for c, v in gcol.items()}
        for s in ('r', 'l'):
            row += [g[f'ground_force_{s}_vx'], g[f'ground_force_{s}_vy'], g[f'ground_force_{s}_px'] + shift]
        row += [np.degrees(cs.get(c).getValue(state)) for c in ('ankle_angle_r', 'knee_angle_r', 'hip_flexion_r')]
        rows.append(row)
        vy = g['ground_force_r_vy']
        if prev_vy is not None:
            if prev_vy < 20 <= vy:
                events['heel_strike_r'].append(f)
            if prev_vy >= 20 > vy:
                events['toe_off_r'].append(f)
        prev_vy = vy

    data = np.asarray(rows, dtype=np.float32)
    OUT.mkdir(parents=True, exist_ok=True)
    data.tofile(OUT / f'{name}.bin')
    meta = json.loads((run / 'meta.json').read_text(encoding='utf-8-sig')) if (run / 'meta.json').exists() else {}
    header = {
        'name': name, 'run': tag, 'fps': fps, 'frames': n, 'stride': len(rows[0]),
        'meshes': [{'name': m.getName(), 'file': Path(m.get_mesh_file()).stem,
                    'scale': list(osim.Vec3(m.get_scale_factors()).to_numpy())} for m in meshes],
        'muscles': [{'name': mu.getName(), 'fmax': mu.getMaxIsometricForce()} for mu in muscles],
        'nPath': N_PATH, 'events': events, 'mass': model.getTotalMass(state),
        'loop': {'seconds': seconds, 'strides': strides, 'timeScale': scale, 'strideS': T},
        'speed': speed, 'meta': meta,
    }
    (OUT / f'{name}.json').write_text(json.dumps(header, indent=1))
    print(f'{name}: {n} frames x {len(rows[0])} floats = {data.nbytes / 1e6:.2f} MB, '
          f'{strides} strides (x{scale:.4f}), events {events}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('tag'); ap.add_argument('model'); ap.add_argument('name')
    ap.add_argument('--fps', type=int, default=60)
    ap.add_argument('--seconds', type=float, default=8)
    a = ap.parse_args()
    export(a.tag, a.model, a.name, a.fps, a.seconds)
