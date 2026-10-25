# KINEMA · Twin Walkers

Two walkers on two treadmills: the same body at the same speed, except that one has calf
muscles at 40% of normal strength. Neither walker is motion-captured or animated. Each one
is an **OpenSim Moco predictive simulation**: the optimiser invents the whole gait by
minimising muscle effort. The weak twin's limp (lost push-off, heel-dominant stance, the
thigh and hip taking over) emerges from the physics.

**Live viewer:** https://suducodes.github.io/kinema/

## Status

| Part | State |
|---|---|
| Simulation pipeline (Moco, 2D model) | Working; reproduces the official OpenSim example bit-for-bit (objective 0.13507) |
| Gastrocnemius path fix (`sim/fix_gastroc.py`) | Done; knee moment arm at 90° flexion −2.21 cm vs reference −1.61 cm (bug: −0.14 cm) |
| Research-grade runs (wide limits, fixed + self-selected speed, robustness, mesh refinement) | Running (`sim/batch.py`) |
| Validation vs real walkers (`sim/validate.py`, Fukuchi 2018, n = 23) | Baseline done on the original model; fixed-model validation pending |
| Viewer data | Currently the proof-of-concept runs (original model); will be replaced by the research-grade runs |

## Pipeline

```
sim/predict.py      Moco predictive gait (official example, parameterised; --regression checks it)
sim/fix_gastroc.py  condyle wrap + origin fix for the 2D model's gastrocnemius
sim/batch.py        4 conditions x (base, alternate initial guess, 2x mesh)
sim/validate.py     simulated healthy gait vs Fukuchi 2018 (RMSE, r, % within ±1/±2 SD)
sim/export_web.py   run -> web/public/data/*.bin + *.json (seamless loop, interpolated)
blender/            Cycles film (build_twins.py, render_anim.py, encode_v2.py), bones.glb bake
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
