"""Export a Moco gait run to a frame-by-frame JSON for Blender.

For each frame: world transform of every mesh's frame, each muscle's path
resampled to N points, muscle activation, GRF, and readouts for overlays.
States are linearly interpolated between solver samples (smooth slow motion).
Forward pelvis travel is removed (treadmill). The clip length is split into a
whole number of strides so the clip loops seamlessly; the tiny time-scale this
needs is recorded in the output.

    python export_anim.py pf_1.00 pf_0.40 --fps 120 --seconds 8
"""
import argparse
import json
from pathlib import Path

import numpy as np
import opensim as osim

ROOT = Path(__file__).resolve().parents[1]
MODELS = {'pf_1.00': 'control_official/2D_gait.osim',
          'pf_0.40': 'official_pf040/2D_gait_pf040.osim'}
N_PATH = 14
BW = 62.0 * 9.80665


def to_blender(v):
    """OpenSim (x fwd, y up, z right) -> Blender (x fwd, y left, z up)."""
    return [float(v[0]), float(-v[2]), float(v[1])]


def rot_to_blender(R):
    """Rotation matrix change of basis with the same axis map as to_blender."""
    P = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)
    return (P @ R @ P.T).tolist()


def resample(points, n):
    pts = np.asarray(points)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] == 0:
        return np.repeat(pts[:1], n, axis=0)
    u = np.linspace(0, s[-1], n)
    return np.stack([np.interp(u, s, pts[:, k]) for k in range(3)], axis=1)


def export(tag, fps, seconds):
    model = osim.Model(str(ROOT / 'sim' / MODELS[tag]))
    state = model.initSystem()
    table = osim.TimeSeriesTable(str(ROOT / 'data' / 'runs' / tag / 'stride.sto'))
    times = np.array(table.getIndependentColumn())
    t0, T = times[0], times[-1] - times[0]
    model_states = set(model.getStateVariableNames().getitem(i)
                       for i in range(model.getNumStateVariables()))
    cols = {c: table.getDependentColumn(c).to_numpy() for c in table.getColumnLabels() if c in model_states}

    grf = osim.TimeSeriesTable(str(ROOT / 'data' / 'runs' / tag / 'grf.sto'))
    gt = np.array(grf.getIndependentColumn())
    gcol = {c: grf.getDependentColumn(c).to_numpy() for c in
            ('ground_force_r_vx', 'ground_force_r_vy', 'ground_force_r_px',
             'ground_force_l_vx', 'ground_force_l_vy', 'ground_force_l_px')}

    meshes = []
    for c in model.getComponentsList():
        if c.getConcreteClassName() == 'Mesh':
            mesh = osim.Mesh.safeDownCast(c)
            meshes.append({'name': c.getName(), 'file': mesh.get_mesh_file(),
                           'scale': [float(x) for x in osim.Vec3(mesh.get_scale_factors()).to_numpy()],
                           'frame': mesh.getFrame()})
    muscles = [osim.Muscle.safeDownCast(m) for m in model.getComponentsList()
               if m.getConcreteClassName() == 'DeGrooteFregly2016Muscle']

    tx = cols['/jointset/groundPelvis/pelvis_tx/value']
    speed = (tx[-1] - tx[0]) / T

    # Whole number of strides in the clip -> seamless loop.
    n_cycles = max(1, round(seconds / T))
    T_play = seconds / n_cycles
    time_scale = T / T_play

    n_frames = int(round(fps * seconds))
    frames = []
    for f in range(n_frames):
        tm = ((f / fps) % T_play) * time_scale  # time within the simulated stride
        t_sim = t0 + tm
        for name, v in cols.items():
            model.setStateVariableValue(state, name, float(np.interp(t_sim, times, v)))
        state.setTime(t_sim)
        model.realizePosition(state)
        shift = -tm * speed - tx[0]
        frame = {'meshes': {}, 'muscles': {}, 'act': {}}
        for m in meshes:
            X = m['frame'].getTransformInGround(state)
            p = X.p().to_numpy().copy()
            p[0] += shift
            R = np.array([[X.R().get(r, k) for k in range(3)] for r in range(3)])
            frame['meshes'][m['name']] = {'p': to_blender(p), 'R': rot_to_blender(R)}
        for mu in muscles:
            path = mu.getGeometryPath().getCurrentPath(state)
            pts = []
            for k in range(path.getSize()):
                q = path.get(k).getLocationInGround(state).to_numpy().copy()
                q[0] += shift
                pts.append(q)
            frame['muscles'][mu.getName()] = [to_blender(q) for q in resample(pts, N_PATH)]
            frame['act'][mu.getName()] = float(mu.getActivation(state))
        g = {k: float(np.interp(t_sim, gt, v)) for k, v in gcol.items()}
        frame['grf'] = {side: {'fx': g[f'ground_force_{side}_vx'], 'fy': g[f'ground_force_{side}_vy'],
                               'px': g[f'ground_force_{side}_px'] + shift} for side in ('r', 'l')}
        frame['readout'] = {
            'ankle_r_deg': float(np.degrees(model.getCoordinateSet().get('ankle_angle_r').getValue(state))),
            'soleus_r_act': frame['act']['soleus_r'],
            'vasti_r_act': frame['act']['vasti_r'],
            'grf_r_bw': g['ground_force_r_vy'] / BW,
            'phase_pct': 100 * tm / T,
        }
        frames.append(frame)

    out = {'tag': tag, 'fps': fps, 'stride_s': T, 'speed_mps': speed,
           'loop': {'seconds': seconds, 'strides': n_cycles, 'time_scale': time_scale},
           'meshes': [{k: v for k, v in m.items() if k != 'frame'} for m in meshes],
           'muscles': {mu.getName(): {'fmax': mu.getMaxIsometricForce()} for mu in muscles},
           'frames': frames}
    dst = ROOT / 'data' / 'anim' / f'{tag}.json'
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out))
    print(f'{tag}: {n_frames} frames @ {fps} fps, stride {T:.3f}s, {n_cycles} strides/loop, '
          f'time scale {time_scale:.4f}, speed {speed:.3f} m/s -> {dst}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('tags', nargs='+')
    ap.add_argument('--fps', type=int, default=120)
    ap.add_argument('--seconds', type=float, default=8)
    a = ap.parse_args()
    for tag in a.tags:
        export(tag, a.fps, a.seconds)
