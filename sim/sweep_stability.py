"""Calibrate the torso-stability weight on the HEALTHY model only (pelvis bounds, 1.2 m/s, mesh 50).

The weight is chosen by validation against Fukuchi 2018 and then frozen; the weak model never
influences the choice. Runs data/runs/st_h_<w> in parallel, warm-started from pv_h_fix.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE.parent / 'data' / 'runs'
WEIGHTS = [float(w) for w in (sys.argv[1] if len(sys.argv) > 1 else '0.001,0.003,0.01,0.03').split(',')]

live = []
for w in WEIGHTS:
    tag = f'st_h_{w:g}'
    (RUNS / tag).mkdir(parents=True, exist_ok=True)
    c = [sys.executable, str(HERE / 'predict.py'), '--tag', tag, '--pf', '1.0', '--speed', '1.2', '--mesh', '50',
         '--bounds', 'pelvis', '--stability', str(w), '--guess', str(RUNS / 'pv_h_fix' / 'halfstride.sto')]
    log = open(RUNS / tag / 'solve.log', 'w')
    live.append((tag, subprocess.Popen(c, stdout=log, stderr=subprocess.STDOUT, cwd=HERE, env=dict(os.environ)), log))
    print('start', tag, flush=True)
while live:
    for item in list(live):
        tag, p, log = item
        if p.poll() is not None:
            log.close()
            live.remove(item)
            print('done ', tag, 'exit', p.returncode, flush=True)
    time.sleep(5)
print('SWEEP COMPLETE', flush=True)
