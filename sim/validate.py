"""Validate a simulated healthy gait against Fukuchi et al. 2018 (PeerJ, CC BY 4.0).

Reference: 23 young adults, treadmill trial closest to 1.2 m/s (1.10-1.29 m/s),
sagittal (Visual3D Z) hip/knee/ankle angles (deg) and net joint moments (N.m/kg),
each normalised to 0-100 % of the gait cycle from right heel strike.
Simulation: right heel strike detected from the right vertical GRF; net joint
moments = sum over muscles (and the lumbar actuator is not involved) of
tendon force x moment arm. Signs mapped to the reference convention, which was
identified from the physiology of the reference curves themselves (not by picking
the sign that correlates best): angles flexion / dorsiflexion positive; moments
hip flexor-positive (early-stance extensor moment is negative), knee
extensor-positive (+ at loading response, - in terminal swing), ankle
plantarflexor-positive.

    python validate.py <run_tag> [--model path]
"""
import argparse
import json
from pathlib import Path

import numpy as np
import opensim as osim

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / 'data' / 'validation' / 'fukuchi2018' / 'trials'
PCT = np.linspace(0, 100, 101)


def reference():
    out = {k: [] for k in ('hip_angle', 'knee_angle', 'ankle_angle', 'hip_moment', 'knee_moment', 'ankle_moment')}
    for ang in sorted(REF.glob('*ang.txt')):
        a = np.genfromtxt(ang, names=True, delimiter='\t')
        k = np.genfromtxt(str(ang).replace('ang.txt', 'knt.txt'), names=True, delimiter='\t')
        out['hip_angle'].append(a['RHipAngleZ'])
        out['knee_angle'].append(a['RKneeAngleZ'])
        out['ankle_angle'].append(a['RAnkleAngleZ'])
        out['hip_moment'].append(k['RHipMomentZ'])
        out['knee_moment'].append(k['RKneeMomentZ'])
        out['ankle_moment'].append(k['RAnkleMomentZ'])
    return {k: np.array(v) for k, v in out.items()}


def simulated(tag, model_path):
    run = ROOT / 'data' / 'runs' / tag
    model = osim.Model(str(model_path))
    model.initSystem()
    table = osim.TimeSeriesTable(str(run / 'stride.sto'))
    traj = osim.StatesTrajectory.createFromStatesTable(model, table, True, True)
    t = np.array([traj.get(i).getTime() for i in range(traj.getSize())])
    grf = osim.TimeSeriesTable(str(run / 'grf.sto'))
    vy = np.interp(t, np.array(grf.getIndependentColumn()), grf.getDependentColumn('ground_force_r_vy').to_numpy())
    mass = model.getTotalMass(model.initSystem())
    coords = {j: model.getCoordinateSet().get(c) for j, c in
              (('hip', 'hip_flexion_r'), ('knee', 'knee_angle_r'), ('ankle', 'ankle_angle_r'))}
    muscles = [model.getMuscles().get(i) for i in range(model.getMuscles().getSize())] \
        if model.getMuscles().getSize() else \
        [osim.Muscle.safeDownCast(c) for c in model.getComponentsList() if c.getConcreteClassName().endswith('Muscle')]
    ang = {j: [] for j in coords}
    mom = {j: [] for j in coords}
    for i in range(traj.getSize()):
        s = traj.get(i)
        model.realizeDynamics(s)
        for j, c in coords.items():
            ang[j].append(np.degrees(c.getValue(s)))
            mom[j].append(sum(m.getTendonForce(s) * m.getGeometryPath().computeMomentArm(s, c) for m in muscles) / mass)
    ang = {j: np.array(v) for j, v in ang.items()}
    mom = {j: np.array(v) for j, v in mom.items()}
    # Right heel strike: first rise of right vertical GRF through 20 N.
    hs = next(i for i in range(1, len(vy)) if vy[i - 1] < 20 <= vy[i])
    T = t[-1] - t[0]
    phase = ((t - t[hs]) % T) / T * 100
    order = np.argsort(phase)

    def norm(x):
        return np.interp(PCT, phase[order], x[order], period=100)
    return {
        'hip_angle': norm(ang['hip']),
        'knee_angle': norm(-ang['knee']),          # model: negative = flexion
        'ankle_angle': norm(ang['ankle']),
        'hip_moment': norm(mom['hip']),            # flexor positive in both
        'knee_moment': norm(mom['knee']),          # model coordinate positive = extension = reference
        'ankle_moment': norm(-mom['ankle']),       # plantarflexor positive
    }


def compare(sim, ref):
    rows = {}
    for k, r in ref.items():
        mu, sd = r.mean(0), r.std(0, ddof=1)
        s = sim[k]
        rows[k] = {
            'rmse': float(np.sqrt(np.mean((s - mu) ** 2))),
            'r': float(np.corrcoef(s, mu)[0, 1]),
            'within_1sd_pct': float(100 * np.mean(np.abs(s - mu) <= sd)),
            'within_2sd_pct': float(100 * np.mean(np.abs(s - mu) <= 2 * sd)),
            'ref_range': float(mu.max() - mu.min()),
        }
    return rows


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('tag')
    ap.add_argument('--model', default=str(ROOT / 'sim' / 'models' / '2D_gait_fixed.osim'))
    a = ap.parse_args()
    ref = reference()
    sim = simulated(a.tag, a.model)
    res = compare(sim, ref)
    out = ROOT / 'data' / 'runs' / a.tag / 'validation.json'
    out.write_text(json.dumps({'n_subjects': len(ref['hip_angle']), 'metrics': res,
                               'sim': {k: v.tolist() for k, v in sim.items()},
                               'ref_mean': {k: v.mean(0).tolist() for k, v in ref.items()},
                               'ref_sd': {k: v.std(0, ddof=1).tolist() for k, v in ref.items()}}, indent=1))
    print(f"{'signal':14s} {'RMSE':>8s} {'r':>6s} {'±1SD%':>7s} {'±2SD%':>7s}  (ref range)")
    for k, m in res.items():
        unit = '°' if 'angle' in k else 'Nm/kg'
        print(f"{k:14s} {m['rmse']:7.2f}{unit[:1]:1s} {m['r']:6.2f} {m['within_1sd_pct']:6.0f}% {m['within_2sd_pct']:6.0f}%  ({m['ref_range']:.2f})")
