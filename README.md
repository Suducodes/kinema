# KINEMA · Twin Walkers

Two walkers on two treadmills: the same body at the same speed, except that one has calf
muscles at 40% of normal strength. Neither walker is motion-captured or animated. Each one
is an **OpenSim Moco predictive simulation**: the optimiser invents the whole gait by
minimising muscle effort. The weak twin's limp (lost push-off, heel-dominant stance, the
thigh and hip taking over) emerges from the physics.

**Live viewer:** https://suducodes.github.io/kinema/

## In the viewer

- **Weakness dial:** drag calf strength from 100% to 20%. The solved levels are 100 / 80 / 60 / 40 / 20%; between them the walker is blended at matched gait phase.
- **Compensation atlas:** one card per weakened muscle group (40%), each its own predictive simulation, with an activation fingerprint against the healthy walker. Click a card to make it walk.
- **Muscle map:** heat strips of every right-leg muscle across the gait cycle, healthy against the right twin.
- **X-ray load:** glass bones, muscles coloured by tendon force, and ground reaction force arrows.
- **Intro:** a short camera move with three captions on first visit.

## Motion Twin (live.html): real-time skeleto-muscular twin

A webcam drives the full-body Lenhart 2015 OpenSim skeleton with 88 leg muscles, entirely in the browser:

1. MediaPipe Pose Landmarker (33 3D points), One Euro smoothing.
2. Each OpenSim bone placed by aligning its body frame to the points, chained joint to joint with lengths calibrated to the user's height.
3. Ground force from Newton's second law over all segments, centre of pressure from the whole-body angular-momentum balance.
4. 3D Newton-Euler inverse dynamics up each leg; static optimisation (sum of squared activations) across 44 muscles per leg with OpenSim moment arms. The quadriceps' leverage through the patella comes from a solved OpenSim JAM knee-bending run (0-130 deg).
5. Coach (reps, depth, knee valgus, unevenness, tempo, landing softness), X-ray, record and CSV export, a demo performer, and a built-in self-check against known truth.

`live/export_twin.py` builds `web/public/live/` (bones GLB, muscle routes, moment-arm tables). Self-check on a synthetic squat: knee 0.5 deg, hip 2.2 deg, ankle 0.7 deg mean error; standing ground force 1.00 body weight.

## Status

| Part | State |
|---|---|
| Simulation pipeline (Moco, 2D model) | Working; reproduces the official OpenSim example bit-for-bit (objective 0.13507) |
| Gastrocnemius path fix (`sim/fix_gastroc.py`) | Done; knee moment arm at 90° flexion −2.21 cm vs reference −1.61 cm (bug: −0.14 cm) |
| Final twins (`sb_*`: wide joints, pelvis ±5°, trunk-stability weight 0.003, 1.2 m/s) | Done; 6/6 converged, alternate guess and 2× mesh agree within 0.3%; weak/healthy effort 3.15× |
| Validation vs real walkers (`sim/validate.py`, Fukuchi 2018, n = 23) | Healthy twin: hip 10.6°, knee 14.1°, ankle 3.4° RMSE; hip moment r = 0.97 |
| Self-selected speed | Dropped for now: an effort-only cost makes the walker creep (~0.45 m/s); needs a metabolic cost with a resting term |
| Viewer data | Final twins, plus the weakness-dial levels and atlas runs |

## Pipeline

```
sim/predict.py      Moco predictive gait (official example, parameterised; --regression checks it)
sim/fix_gastroc.py  condyle wrap + origin fix for the 2D model's gastrocnemius
sim/batch.py        4 conditions x (base, alternate initial guess, 2x mesh)
sim/validate.py     simulated healthy gait vs Fukuchi 2018 (RMSE, r, % within ±1/±2 SD)
sim/sweep_stability.py  trunk-stability weight calibration (healthy twin only)
sim/atlas.py        weakness-dial levels + atlas groups (same settings as the twins)
sim/export_web.py   run -> web/public/data/*.bin + *.json (seamless loop, interpolated)
sim/export_atlas.py dial + atlas runs -> viewer clips, fingerprints in manifest.json
blender/            Cycles film (render_film.ps1 runs build_twins.py, render_anim.py, encode_v2.py), bones.glb bake
web/                Vite + three.js viewer
```

Environment: `env/environment.yml` (conda, OpenSim 4.6). On Windows, put the env's
`Library\bin` on PATH or CasADi cannot load IPOPT.

## Limits (stated, not hidden)

- 2D model: sagittal motion only, so no side-to-side compensation, no arms, one trunk segment.
- Weakness is modelled as lost maximum force only (no tendon, sensory or control changes).
- Effort-minimising walkers; people may not choose the least-effort gait.

## Credits and licences

- OpenSim / Moco (Stanford, Apache 2.0). `sim/models/2D_gait.osim` and the reference files are
  from the opensim-core `example2DWalking` (Falisse et al. 2019; derived from gait10dof18musc).
  That example notes a gastrocnemius path issue, which `sim/fix_gastroc.py` addresses.
- Validation data: Fukuchi, Fukuchi & Duarte (2018), *A public dataset of overground and treadmill
  walking kinematics and kinetics in healthy individuals*, PeerJ 6:e4640, CC BY 4.0
  (figshare 10.6084/m9.figshare.5722711). Only the needed files are fetched, via `sim/remote_zip.py`.
- Comparison literature: van der Krogt et al. 2012; Ong et al. 2019; Falisse et al. 2019.
