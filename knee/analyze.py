"""Summarise the knee tests: laxity (change under the applied load) and ligament load sharing.

Laxity = knee coordinate at the end of the load ramp minus its value just before the load starts
(t = 2.0 s), i.e. what the clinician's hand would feel. Ligament forces are summed per structure.
Writes runs/summary.json.
"""
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np

RUNS = Path(__file__).resolve().parent / 'runs'
COORDS = {'knee_tx_r': ('anterior translation', 'mm', 1000), 'knee_ty_r': ('superior translation', 'mm', 1000),
          'knee_tz_r': ('lateral translation', 'mm', 1000), 'knee_add_r': ('adduction (varus +)', 'deg', 57.29578),
          'knee_rot_r': ('internal rotation', 'deg', 57.29578)}


def load(p):
    lines = Path(p).read_text().splitlines()
    i = next(k for k, l in enumerate(lines) if l.strip() == 'endheader')
    head = lines[i + 1].split('\t')
    return head, np.loadtxt(lines[i + 2:])


def coords(run):
    st = next((run / 'results').glob('*_states.sto'))
    h, d = load(st)
    out = {}
    for c, (_label, _unit, k) in COORDS.items():
        col = next((j for j, n in enumerate(h) if n.endswith(f'/{c}/value')), None)
        if col is not None:
            out[c] = d[:, col] * k
    return d[:, 0], out


LIG = r'(ACLam|ACLpl|PCLal|PCLpm|LCL|MCLs|MCLd|MCLp|pCAP|PFL|ITB|lPFL|mPFL|PT)\d+'


def ligaments(run):
    """Total force per ligament (N, summed over bundles) and peak bundle strain (%) over time."""
    fr = next((run / 'results').glob('*ForceReporter_forces.sto'))
    h, d = load(fr)
    force = defaultdict(lambda: np.zeros(len(d)))
    strain = defaultdict(lambda: np.full(len(d), -np.inf))
    for j, n in enumerate(h):
        m = re.fullmatch(LIG + r'\.(force_total|strain)', n)
        if m and m.group(2) == 'force_total':
            force[m.group(1)] += d[:, j]
        elif m:
            strain[m.group(1)] = np.maximum(strain[m.group(1)], d[:, j] * 100)
    return d[:, 0], dict(force), dict(strain)


if __name__ == '__main__':
    summary = {}
    for run in sorted(p for p in RUNS.iterdir() if p.is_dir() and p.name != 'anterior_laxity'):
        if not list((run / 'results').glob('*_states.sto')):
            continue
        t, c = coords(run)
        a, b = np.searchsorted(t, 1.995), len(t) - 1
        delta = {k: round(float(v[b] - v[a]), 2) for k, v in c.items()}
        tl, lig, strain = ligaments(run)
        peak = {k: round(float(v[-1]), 1) for k, v in lig.items()}
        summary[run.name] = {'delta': delta, 'ligament_force_end_N': peak,
                             'ligament_strain_end_pct': {k: round(float(v[-1]), 2) for k, v in strain.items()}}
        if run.name.startswith('flexion'):   # ligament force vs knee angle, every 10 deg
            h, d = load(next((run / 'results').glob('*_states.sto')))
            flex = np.degrees(d[:, next(j for j, n in enumerate(h) if n.endswith('/knee_flex_r/value'))])
            ang = np.interp(tl, d[:, 0], flex)
            later = tl >= 0.5                       # the flexion ramp (angles rise monotonically)
            grid = np.arange(0, 91, 10)
            summary[run.name]['vs_flexion'] = {'deg': grid.tolist(), **{
                k: np.round(np.interp(grid, ang[later], v[later]), 1).tolist() for k, v in lig.items()}}
        print(f'{run.name:22s}', ' '.join(f'{k.split("_")[1]}={v:+.1f}' for k, v in delta.items()),
              '| top:', ', '.join(f'{k} {v:.0f}N' for k, v in sorted(peak.items(), key=lambda x: -x[1])[:4]))
    (RUNS / 'summary.json').write_text(json.dumps(summary, indent=1))
