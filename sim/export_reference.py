"""Write the Fukuchi 2018 mean +/- SD reference bands for the website charts."""
import json
from pathlib import Path

import numpy as np

from validate import reference

OUT = Path(__file__).resolve().parents[1] / 'web' / 'public' / 'data' / 'reference.json'

ref = reference()
out = {
    'source': 'Fukuchi, Fukuchi & Duarte 2018, PeerJ 6:e4640 (CC BY 4.0); 23 young adults, treadmill ~1.2 m/s (1.10-1.29)',
    'n': int(len(ref['hip_angle'])),
    'conventions': {'angles': 'flexion / dorsiflexion positive (deg)',
                    'moments': 'N.m/kg; hip flexor+, knee extensor+, ankle plantarflexor+'},
}
for k, v in ref.items():
    out[k] = {'mean': np.round(v.mean(0), 3).tolist(), 'sd': np.round(v.std(0, ddof=1), 3).tolist()}
OUT.write_text(json.dumps(out))
print('wrote', OUT, 'n =', out['n'])
