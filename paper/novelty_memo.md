# Phase 0: novelty memo (v0, 2026-10-24)

Status: **v0, based on abstracts and search snippets only.** The two closest works
(★) must be read in full before the gate is passed.

## Closest prior work

| # | Work | What it does | What it does not do |
|---|---|---|---|
| ★1 | **Bidirectional GaitNet**, Park et al., SIGGRAPH 2023 ([arXiv 2306.04161](https://arxiv.org/abs/2306.04161)) | Forward model (anatomy → gait) distilled from a predictive gait simulator, 304-muscle model. Backward model (gait → anatomy, incl. per-muscle weakness) as the encoder of a VAE. Checked against patient exam data | No reported calibrated uncertainty and no identifiability analysis (from the abstract). Not OpenSim/Moco. No physics audit of predictions. Sample efficiency of data generation not studied |
| ★2 | **Estimating impairment contributions in CP with predictive simulations**, JNER 2025 ([link](https://link.springer.com/article/10.1186/s12984-025-01767-w)) | Per-patient predictive sims at 8 personalisation levels to attribute gait deviations to weakness, contracture or bone deformity | Forward comparison, not inference. Expensive per patient. No surrogate, no posterior |
| 3 | Gambietz … Koelewijn, learned state prior for gait sims, arXiv 2610.08506 (Oct 2026) | VAE prior makes predictive sims more realistic; forward what-if on weakness (trunk lean, waddling) | Not a surrogate; no inverse, no uncertainty |
| 4 | Ong et al., plantarflexor weakness/contracture, PLoS CB 2019 ([PMC6797212](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6797212/)) | Predictive sims, 9-DOF 18-muscle model; notes that tracking data cannot separate weakness from contracture | Forward only; that remark is exactly the identifiability problem we target |
| 5 | Dembia et al., OpenSim Moco, PLoS CB 2020 | The tool; hip-abductor/dorsiflexor weakness example solves in about 15 min | — |
| 6 | Gait data augmentation via Moco, arXiv 2307.08092 | Generates synthetic gait cycles with Moco across anthropometrics | No emulator, no inverse |
| 7 | Simulation-based inference / NPE literature (e.g. Lueckmann et al. 2021 benchmark) | Amortised Bayesian posteriors from simulators | Not applied to musculoskeletal gait that we could find |

No paper we found trains an emulator on Moco predictive simulations, or applies simulation-based inference to musculoskeletal gait.

## Consequence: re-scoped claim

A plain forward surrogate plus inverse mode **is not novel** (GaitNet does both). Our lead contribution becomes:

> **Identifiability-aware, amortised Bayesian inference of muscle impairments from gait**: learned from OpenSim Moco predictive simulations, with uncertainty-driven active learning and a physics audit of every prediction.

Concretely:
1. **Posterior, not a point estimate.** Neural posterior estimation over impairment parameters. The posterior shape shows which impairments gait can and cannot distinguish (e.g. weakness vs contracture, as in work 4).
2. **Identifiability map.** Across the parameter space, which muscle groups are recoverable from kinematics alone vs kinematics + GRF vs + EMG-like activations. *This map is the headline figure.*
3. **Active learning.** Choose Moco runs where the emulator/posterior is least certain; report simulations saved vs random sampling.
4. **Physics audit.** Inverse-dynamics residuals on emulated gaits, an independent plausibility check.
5. **Open dataset** of Moco predictive simulations with provenance (none found public at this scale).

Novelty risk remaining: a full-text read of ★1 may show uncertainty handling inside its VAE. Even so, the identifiability map, OpenSim/Moco basis, active learning and audit still differentiate it.

## Pre-registered thresholds (proposed, **user must confirm**)

Fixed now, before any data exists:
- Forward emulator on the frozen test set: joint-angle RMSE ≤ 3°, normalised joint-moment RMSE ≤ 10% of the range, muscle-activation RMSE ≤ 0.08.
- Calibration: 90% intervals cover 85–95% of test outcomes.
- Active learning: reach the random-sampling accuracy with ≥ 30% fewer simulations, or report honestly that it didn't.
- Inverse: on identifiable parameters, posterior-mean error ≤ 0.1 (strength-scale units); 90% credible intervals cover truth 85–95%.
- Speed-up vs Moco: ≥ 10⁴× per query.

## Update (later on 2026-10-24): direction changed to the Compensation Fingerprints atlas

The user found the inference framing too close to GaitNet and the Cliff/hysteresis idea too risky. The current direction is a **predictive, graded, per-muscle weakness atlas**.

- **van der Krogt et al. 2012** ([PMC4890623](https://pmc.ncbi.nlm.nih.gov/articles/PMC4890623/)) is the key prior. It weakened each muscle until normal walking failed and found gait most sensitive to plantarflexors, hip abductors and hip flexors. **Kinematics were held fixed**: it asks how weak a muscle can get while the gait stays normal, not how the gait adapts.
- Synergy follow-up (J Biomech 2022, [bioRxiv](https://www.biorxiv.org/content/10.1101/2021.06.06.447290v2.full)): tolerance depends on how many synergies control the muscles. Also fixed-kinematics style.
- Predictive weakness studies cover one or two muscle groups each: Ong 2019 (plantarflexors), Falisse 2019 (hip and others at 50/75/90%), hemiparesis studies.
- **Gap:** a free-kinematics (predictive) version across all muscle groups at graded levels, giving the visible fingerprint, hidden load and energy cost, and the "silent zone" before gait visibly changes. If any group shows an abrupt jump between levels, it is followed up as the Cliff idea.
- **Must read:** the Denayer et al. 2025 JNER systematic review of predictive simulations, which may list a prior atlas.

## To do before passing the gate
- [ ] Read ★1 and ★2 full text (user + Claude).
- [ ] One more search pass: "amortized inference musculoskeletal", "Bayesian calibration muscle-tendon parameters", SCONE/MyoSuite + surrogates.
- [ ] User confirms thresholds.
