"""Compare Twin Walkers runs: gait timing, joint angles, calf activation, GRF."""
import math
import sys
from pathlib import Path

import numpy as np
import opensim as osim

RUNS = Path(__file__).resolve().parents[1] / 'data' / 'runs'


def load(tag):
    traj = osim.MocoTrajectory(str(RUNS / tag / 'stride.sto'))
    t = np.array(traj.getTimeMat())
    states = {n: np.array(traj.getStateMat(n)) for n in traj.getStateNames()}
    controls = {n: np.array(traj.getControlMat(n)) for n in traj.getControlNames()}
    grf = osim.TimeSeriesTable(str(RUNS / tag / 'grf.sto'))
    vy = np.array(grf.getDependentColumn('ground_force_r_vy').to_numpy())
    vx = np.array(grf.getDependentColumn('ground_force_r_vx').to_numpy())
    return t, states, controls, vx, vy


def deg(x):
    return np.degrees(x)


def summarize(tag):
    t, s, c, vx, vy = load(tag)
    ank = deg(s['/jointset/ankle_r/ankle_angle_r/value'])
    knee = deg(s['/jointset/knee_r/knee_angle_r/value'])
    hip = deg(s['/jointset/hip_r/hip_flexion_r/value'])
    trunk = deg(s['/jointset/lumbar/lumbar/value'])
    stance = vy > 20
    bw = 62.0 * 9.80665  # 2D_gait.osim total mass is 62 kg
    act = {m: s[f'/{m}/activation'] for m in ('soleus_r', 'gastroc_r', 'tib_ant_r', 'vasti_r', 'glut_max_r', 'hamstrings_r')}
    idx_hs = int(np.argmax(stance))  # first stance sample = heel strike
    out = {
        'stride_time_s': t[-1] - t[0],
        'stance_pct': 100 * stance.mean(),
        'ankle_at_contact_deg': ank[idx_hs],
        'ankle_max_dorsi_deg': ank.max(),
        'ankle_max_plantar_deg': ank.min(),
        'knee_max_flex_deg': -knee.min(),
        'hip_range_deg': hip.max() - hip.min(),
        'trunk_mean_deg': trunk.mean(),
        'peak_vGRF_BW': vy.max() / bw,
        'peak_propulsive_BW': vx.max() / bw,
        'peak_braking_BW': -vx.min() / bw,
    }
    out.update({f'peak_act_{m}': a.max() for m, a in act.items()})
    out['mean_act_all'] = np.mean([v.mean() for k, v in s.items() if k.endswith('/activation')])
    return out


if __name__ == '__main__':
    tags = sys.argv[1:] or ['pf_1.00', 'pf_0.40']
    rows = {tag: summarize(tag) for tag in tags}
    keys = list(next(iter(rows.values())).keys())
    print(f"{'metric':28s}" + ''.join(f'{t:>12s}' for t in tags))
    for k in keys:
        print(f'{k:28s}' + ''.join(f'{rows[t][k]:12.3f}' for t in tags))
