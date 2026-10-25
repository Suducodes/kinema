"""Research-grade Twin Walkers batch: 4 conditions x (base, alternate guess, refined mesh).

Stage A  mesh 50, wide bounds, tracking guess        rg_{h,w}_{fix,free}
Stage B  same, but starting from the *other* strength's stage-A solution   ..._g2
Stage C  mesh 100, starting from the stage-A solution                       ..._m100
Runs up to --jobs solves in parallel; each writes data/runs/<tag>/meta.json.
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE.parent / 'data' / 'runs'
COND = {'h': 1.0, 'w': 0.4}
SPEED = {'fix': '1.2', 'free': 'free'}


def cmd(tag, pf, speed, mesh, guess=None):
    c = [sys.executable, str(HERE / 'predict.py'), '--tag', tag, '--pf', str(pf), '--speed', speed,
         '--mesh', str(mesh), '--bounds', 'wide']
    if guess:
        c += ['--guess', str(guess)]
    return tag, c


def run_stage(jobs, n):
    env = dict(os.environ)
    queue, live = list(jobs), []
    while queue or live:
        while queue and len(live) < n:
            tag, c = queue.pop(0)
            if (RUNS / tag / 'meta.json').exists():
                print('skip', tag, flush=True)
                continue
            (RUNS / tag).mkdir(parents=True, exist_ok=True)
            log = open(RUNS / tag / 'solve.log', 'w')
            live.append((tag, subprocess.Popen(c, stdout=log, stderr=subprocess.STDOUT, cwd=HERE, env=env), log))
            print('start', tag, flush=True)
        for item in list(live):
            tag, p, log = item
            if p.poll() is not None:
                log.close()
                live.remove(item)
                print('done ', tag, 'exit', p.returncode, flush=True)
        if live:
            import time
            time.sleep(5)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args()
    A = [cmd(f'rg_{c}_{s}', pf, sp, 50) for c, pf in COND.items() for s, sp in SPEED.items()]
    run_stage(A, a.jobs)
    other = {'h': 'w', 'w': 'h'}
    B = [cmd(f'rg_{c}_{s}_g2', pf, sp, 50, RUNS / f'rg_{other[c]}_{s}' / 'halfstride.sto')
         for c, pf in COND.items() for s, sp in SPEED.items()]
    C = [cmd(f'rg_{c}_{s}_m100', pf, sp, 100, RUNS / f'rg_{c}_{s}' / 'halfstride.sto')
         for c, pf in COND.items() for s, sp in SPEED.items()]
    run_stage(B + C, a.jobs)
    print('BATCH COMPLETE', flush=True)
