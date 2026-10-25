"""Export the weakness-dial and atlas runs to the viewer and list them in manifest.json.

Uses whatever runs have finished and converged; re-run after atlas.py completes.
  dial   plantarflexor strength 100 / 80 / 60 / 40 / 20 %
  atlas  one card per weakened group (40 %), with an activation fingerprint vs the healthy twin
"""
import json
import re
from pathlib import Path

import numpy as np
import opensim as osim

from export_web import export

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / 'data' / 'runs'
DATA = ROOT / 'web' / 'public' / 'data'
HEALTHY_MODEL = ROOT / 'sim' / 'models' / '2D_gait_fixed.osim'
RIGHT = ['glut_max_r', 'iliopsoas_r', 'rect_fem_r', 'hamstrings_r', 'bifemsh_r', 'vasti_r', 'gastroc_r', 'soleus_r', 'tib_ant_r']

DIAL = [(1.0, 'sb_h_fix', 'sb_healthy'), (0.8, 'at_pf_0.80', 'dial_080'), (0.6, 'at_pf_0.60', 'dial_060'),
        (0.4, 'sb_w_fix', 'sb_weak'), (0.2, 'at_pf_0.20', 'dial_020')]
ATLAS = [  # id, run, clip, label, muscles, phrase, weakened (right leg)
    ('plantarflexors', 'sb_w_fix', 'sb_weak', 'Calves', 'soleus + gastrocnemius', 'calf muscles', ['soleus_r', 'gastroc_r']),
    ('vasti', 'at_vasti_0.40', 'atlas_vasti', 'Quadriceps', 'vasti', 'quadriceps (vasti)', ['vasti_r']),
    ('glut_max', 'at_glut_max_0.40', 'atlas_glut_max', 'Gluteus max', 'gluteus maximus', 'gluteus maximus muscles', ['glut_max_r']),
    ('hamstrings', 'at_hamstrings_0.40', 'atlas_hamstrings', 'Hamstrings', 'hamstrings + biceps femoris short head', 'hamstrings', ['hamstrings_r', 'bifemsh_r']),
    ('hip_flexors', 'at_hip_flexors_0.40', 'atlas_hip_flexors', 'Hip flexors', 'iliopsoas + rectus femoris', 'hip flexors', ['iliopsoas_r', 'rect_fem_r']),
    ('tib_ant', 'at_tib_ant_0.40', 'atlas_tib_ant', 'Tibialis anterior', 'tibialis anterior', 'shin muscles (tibialis anterior)', ['tib_ant_r']),
]


def meta(run):
    f = RUNS / run / 'meta.json'
    return json.loads(f.read_text(encoding='utf-8-sig')) if f.exists() else None


def effort(run):
    """The effort term of the objective (without the trunk-stability term), from the solver log."""
    hits = re.findall(r'effort:\s*([0-9.eE+-]+)', (RUNS / run / 'solve.log').read_text(errors='ignore'))
    return float(hits[-1]) if hits else meta(run)['objective']


def mean_activation(run):
    t = osim.TimeSeriesTable(str(RUNS / run / 'stride.sto'))
    labels = list(t.getColumnLabels())
    out = {}
    for m in RIGHT:
        col = next(c for c in labels if c.endswith(f'/{m}/activation'))
        out[m] = float(np.mean(t.getDependentColumn(col).to_numpy()))
    return out


def model_for(run):
    return RUNS / run / 'model.osim' if (RUNS / run / 'model.osim').exists() else HEALTHY_MODEL


def ok(run):
    m = meta(run)
    return m is not None and m.get('converged') and (RUNS / run / 'stride.sto').exists()


def ensure_clip(run, clip):
    if not (DATA / f'{clip}.bin').exists() or (DATA / f'{clip}.json').stat().st_mtime < (RUNS / run / 'stride.sto').stat().st_mtime:
        export(run, model_for(run), clip, 60, 8)


if __name__ == '__main__':
    href = mean_activation('sb_h_fix')
    e0 = effort('sb_h_fix')
    dial = []
    for s, run, clip in DIAL:
        if ok(run):
            ensure_clip(run, clip)
            dial.append({'s': s, 'clip': clip, 'run': run, 'effort_ratio': round(effort(run) / e0, 3),
                         'step_s': meta(run)['half_stride_s']})
    atlas = []
    for gid, run, clip, label, muscles, phrase, weak in ATLAS:
        m = meta(run)
        if m is None:
            continue
        entry = {'id': gid, 'label': label, 'muscles': muscles, 'phrase': phrase, 'clip': clip, 'run': run,
                 'strength': 0.4, 'weakened': weak, 'converged': bool(ok(run)), 'robust': run.startswith('sb_'),
                 'effort_ratio': 0.0, 'step_s': m['half_stride_s'], 'fingerprint': {}}
        if entry['converged']:
            ensure_clip(run, clip)
            a = mean_activation(run)
            entry['fingerprint'] = {k: round(a[k] / href[k], 3) for k in RIGHT}
            entry['effort_ratio'] = round(effort(run) / e0, 3)
        atlas.append(entry)
    man = json.loads((DATA / 'manifest.json').read_text(encoding='utf-8-sig'))
    man['dial'] = dial
    man['atlas'] = atlas
    # every predictive solve run for this study (regression, wide/pelvis/stability batches, sweep, atlas)
    metas = [m for m in (meta(d.name) for d in RUNS.iterdir() if d.is_dir() and not d.name.startswith('_')) if m]
    man['stats'] = {'solves': len(metas), 'converged': sum(bool(m.get('converged')) for m in metas),
                    'cpu_hours': round(sum(m.get('wall_time_s', 0) for m in metas) / 3600, 1)}
    (DATA / 'manifest.json').write_text(json.dumps(man, indent=1, ensure_ascii=False), encoding='utf-8')
    print('dial', [(d['s'], d['clip']) for d in dial])
    for e in atlas:
        top = sorted(((v, k) for k, v in e['fingerprint'].items() if k not in e['weakened']), reverse=True)[:3]
        print(f"{e['id']:15s} conv={e['converged']} effort x{e['effort_ratio']:.2f} step {e['step_s']:.3f}s top {top}")
