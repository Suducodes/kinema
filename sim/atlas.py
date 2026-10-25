"""Atlas + weakness-dial runs, same settings as the final twins (sb_*: pelvis bounds, 1.2 m/s, stability 0.003).

Dial   plantarflexors at 80 / 60 / 20 % (100 and 40 % are sb_h_fix / sb_w_fix)   at_pf_<s>
Atlas  each other muscle group at 40 %                                            at_<group>_0.40
Single solve per condition (mesh 50, warm-started from the nearest final twin); the robustness
checks were done on the twins only.
"""
import argparse
import sys

from batch import RUNS, HERE, run_stage


def cmd(tag, group, pf, guess):
    return tag, [sys.executable, str(HERE / 'predict.py'), '--tag', tag, '--group', group, '--pf', str(pf),
                 '--speed', '1.2', '--mesh', '50', '--bounds', 'pelvis', '--stability', '0.003',
                 '--guess', str(RUNS / guess / 'halfstride.sto')]


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args()
    jobs = [cmd('at_pf_0.80', 'plantarflexors', 0.8, 'sb_h_fix'),
            cmd('at_pf_0.60', 'plantarflexors', 0.6, 'sb_w_fix'),
            cmd('at_pf_0.20', 'plantarflexors', 0.2, 'sb_w_fix')]
    jobs += [cmd(f'at_{g}_0.40', g, 0.4, 'sb_h_fix') for g in ('vasti', 'glut_max', 'hamstrings', 'hip_flexors', 'tib_ant')]
    run_stage(jobs, a.jobs)
    print('ATLAS COMPLETE', flush=True)
