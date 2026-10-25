"""Build the injured knee and the clinical test inputs for the OpenSim JAM forsim tool.

Models (Lenhart 2015 knee, opensim-jam, Apache-2.0):
  healthy  the published model, unchanged
  injured  ACL, PCL and LCL bundles removed (grade 3 = complete tears), MCL stretched
           (superficial + deep MCL: slack length +MCL_SLACK, stiffness x MCL_STIFF; an illustrative
           assumption for a sprained, not torn, MCL)

Tests (same timing as the published anterior-laxity example: settle 0.5 s, flex 1 s, hold 0.5 s,
load ramps over 1 s):
  lachman      knee 25 deg, 100 N anterior force on the tibia
  post_drawer  knee 90 deg, 100 N posterior force
  varus        knee 20 deg, 10 N*m varus moment (opens the lateral side, LCL)
  valgus       knee 20 deg, 10 N*m valgus moment (opens the medial side, MCL)
  flexion      passive flexion 0 -> 90 deg, no load
"""
import re
import shutil
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
JAM = HERE / 'vendor' / 'opensim-jam' / 'opensim-jam-release'
MODELS = JAM / 'models' / 'lenhart2015'
EXAMPLE = JAM / 'examples' / 'anterior_laxity' / 'inputs'
RUNS = HERE / 'runs'

TORN = ('ACLam', 'ACLpl', 'PCLal', 'PCLpm', 'LCL')
STRETCHED = ('MCLs', 'MCLd')
MCL_SLACK, MCL_STIFF = 0.06, 0.5

TESTS = {   # knee angle, hip angle, force x (N, +anterior), torque about tibia x (N*m)
    'lachman': (25, 25, 100, 0),
    'post_drawer': (90, 45, -100, 0),
    'varus': (20, 20, 0, 10),
    'valgus': (20, 20, 0, -10),
}
DT = 0.01


def build_injured():
    src = (MODELS / 'lenhart2015.osim').read_text()
    # drop every bundle of the torn ligaments
    pattern = r'\s*<Blankevoort1991Ligament name="(%s)\d+">.*?</Blankevoort1991Ligament>' % '|'.join(TORN)
    out, n = re.subn(pattern, '', src, flags=re.S)
    # loosen and weaken the stretched MCL bundles
    def stretch(m):
        block = m.group(0)
        block = re.sub(r'<slack_length>([^<]+)</slack_length>',
                       lambda s: f'<slack_length>{float(s.group(1)) * (1 + MCL_SLACK):.10g}</slack_length>', block)
        block = re.sub(r'<linear_stiffness>([^<]+)</linear_stiffness>',
                       lambda s: f'<linear_stiffness>{float(s.group(1)) * MCL_STIFF:.10g}</linear_stiffness>', block)
        return block
    out, k = re.subn(r'<Blankevoort1991Ligament name="(%s)\d+">.*?</Blankevoort1991Ligament>' % '|'.join(STRETCHED),
                     stretch, out, flags=re.S)
    (MODELS / 'lenhart2015_injured.osim').write_text(out)
    print(f'injured model: removed {n} bundles ({", ".join(TORN)}), stretched {k} MCL bundles')


def smooth(a, b, n):
    """Smoothstep ramp from a to b over n samples (same shape as the example's ramps)."""
    s = np.linspace(0, 1, n)
    return a + (b - a) * (3 * s ** 2 - 2 * s ** 3)


def sto(path, title, cols, data):
    head = f'{title}\nDataType=double\nversion=3\nOpenSimVersion=4.0\nendheader\n'   # same header as the example
    with open(path, 'w') as f:
        f.write(head + '\t'.join(cols) + '\n')
        for row in data:
            f.write('\t'.join(f'{v:.6g}' for v in row) + '\n')


def test_inputs(name, knee, hip, fx, tx, out):
    t = np.round(np.arange(0, 3 + DT / 2, DT), 4)
    flex = np.zeros_like(t)
    a, b = np.searchsorted(t, 0.5), np.searchsorted(t, 1.5)
    flex[a:b] = smooth(0, 1, b - a); flex[b:] = 1
    load = np.zeros_like(t)
    c = np.searchsorted(t, 2.0)
    load[c:] = smooth(0, 1, len(t) - c)
    sto(out / 'prescribed_coordinates.sto', name, ['time', 'hip_flex_r', 'knee_flex_r'],
        np.column_stack([t, hip * flex, knee * flex]))
    cols = ['time'] + [f'tibia_proximal_r_force_v{a}' for a in 'xyz'] + [f'tibia_proximal_r_force_p{a}' for a in 'xyz'] \
        + [f'tibia_proximal_r_torque_{a}' for a in 'xyz']
    z = np.zeros_like(t)
    sto(out / 'external_loads.sto', name, cols,
        np.column_stack([t, fx * load, z, z, z, z - 0.1, z, tx * load, z, z]))


def flexion_inputs(out):
    t = np.round(np.arange(0, 3 + DT / 2, DT), 4)
    flex = np.zeros_like(t)
    a = np.searchsorted(t, 0.5)
    flex[a:] = smooth(0, 1, len(t) - a)
    sto(out / 'prescribed_coordinates.sto', 'flexion', ['time', 'hip_flex_r', 'knee_flex_r'],
        np.column_stack([t, 30 * flex, 90 * flex]))
    cols = ['time'] + [f'tibia_proximal_r_force_v{a}' for a in 'xyz'] + [f'tibia_proximal_r_force_p{a}' for a in 'xyz'] \
        + [f'tibia_proximal_r_torque_{a}' for a in 'xyz']
    z = np.zeros_like(t)
    sto(out / 'external_loads.sto', 'flexion', cols, np.column_stack([t, z, z, z, z, z - 0.1, z, z, z, z]))


def settings(test, model, out):
    xml = (EXAMPLE / 'forsim_settings.xml').read_text()
    xml = re.sub(r'<model_file>.*?</model_file>', f'<model_file>{(MODELS / f"lenhart2015{model}.osim").as_posix()}</model_file>', xml)
    xml = re.sub(r'<results_directory>.*?</results_directory>', '<results_directory>../results</results_directory>', xml)
    xml = re.sub(r'<results_file_basename>.*?</results_file_basename>', f'<results_file_basename>{test}</results_file_basename>', xml)
    (out / 'forsim_settings.xml').write_text(xml)
    shutil.copy(EXAMPLE / 'external_loads.xml', out / 'external_loads.xml')


if __name__ == '__main__':
    build_injured()
    for model, suffix in (('healthy', ''), ('injured', '_injured')):
        for test, args in [*TESTS.items(), ('flexion', None)]:
            out = RUNS / f'{test}_{model}' / 'inputs'
            out.mkdir(parents=True, exist_ok=True)
            (out.parent / 'results').mkdir(exist_ok=True)
            if args:
                test_inputs(test, *args, out)
            else:
                flexion_inputs(out)
            settings(test, suffix, out)
            print('ready', out.parent.name)
