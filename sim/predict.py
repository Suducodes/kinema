"""Parameterised Moco predictive gait simulation (2D model), faithful to the official
example2DWalking.py. That example was verified to give physiological activations;
an earlier rewrite of mine did not, so this file mirrors it line for line and only
exposes the knobs below. `--regression` checks it still reproduces the official
objective (0.135) before any new run is trusted.

    python predict.py --model models/2D_gait_fixed.osim --pf 0.4 --speed free --mesh 50 --tag x
"""
import argparse
import json
import math
import re
import time
from pathlib import Path

import opensim as osim

HERE = Path(__file__).resolve().parent
RUNS = HERE.parent / 'data' / 'runs'
REF_DIR = HERE / 'models'  # referenceCoordinates.sto, referenceGRF.xml/.sto live here

ORIGINAL_BOUNDS = {  # official example (degrees, time in s)
    'pelvis_tilt': (-20, -10), 'hip_flexion': (-10, 60), 'knee_angle': (-50, 0),
    'ankle_angle': (-15, 25), 'lumbar': (0, 20), 'time': (0.4, 0.6)}
WIDE_BOUNDS = {  # wide enough that a physiological gait should never touch them
    'pelvis_tilt': (-35, 5), 'hip_flexion': (-30, 80), 'knee_angle': (-90, 0),
    'ankle_angle': (-35, 35), 'lumbar': (-10, 35), 'time': (0.3, 0.9)}
# Wide joints, but pelvis held to +-5 deg around the reference mean (-15.1 deg); real sagittal pelvis
# tilt range in gait is ~3-5 deg. Fully free, the 2D model rocks the pelvis ~27 deg per stride.
PELVIS_BOUNDS = dict(WIDE_BOUNDS, pelvis_tilt=(-20, -10))


def add_symmetry(problem, model, actuator_pairs=True):
    goal = osim.MocoPeriodicityGoal('symmetryGoal')
    problem.addGoal(goal)
    names = model.getStateVariableNames()
    for i in range(names.getSize()):
        n = names.getitem(i)
        if n.startswith('/jointset'):
            if '_r' in n:
                goal.addStatePair(osim.MocoPeriodicityGoalPair(n, re.sub(r'_r', '_l', n)))
            if '_l' in n:
                goal.addStatePair(osim.MocoPeriodicityGoalPair(n, re.sub(r'_l', '_r', n)))
            if not ('_r' in n or '_l' in n or 'pelvis_tx/value' in n or '/activation' in n):
                goal.addStatePair(osim.MocoPeriodicityGoalPair(n))
    for i in range(names.getSize()):
        n = names.getitem(i)
        if n.endswith('/activation'):
            if '_r' in n:
                goal.addStatePair(osim.MocoPeriodicityGoalPair(n, re.sub(r'_r', '_l', n)))
            if '_l' in n:
                goal.addStatePair(osim.MocoPeriodicityGoalPair(n, re.sub(r'_l', '_r', n)))
    goal.addControlPair(osim.MocoPeriodicityGoalPair('/lumbarAct'))


def set_bounds(problem, b, model):
    deg = math.radians
    problem.setStateInfo('/jointset/groundPelvis/pelvis_tilt/value', [deg(b['pelvis_tilt'][0]), deg(b['pelvis_tilt'][1])])
    problem.setStateInfo('/jointset/groundPelvis/pelvis_tx/value', [0, 1])
    problem.setStateInfo('/jointset/groundPelvis/pelvis_ty/value', [0.75, 1.25])
    for side in ('l', 'r'):
        problem.setStateInfo(f'/jointset/hip_{side}/hip_flexion_{side}/value', [deg(x) for x in b['hip_flexion']])
        problem.setStateInfo(f'/jointset/knee_{side}/knee_angle_{side}/value', [deg(x) for x in b['knee_angle']])
        problem.setStateInfo(f'/jointset/ankle_{side}/ankle_angle_{side}/value', [deg(x) for x in b['ankle_angle']])
    problem.setStateInfo('/jointset/lumbar/lumbar/value', [deg(x) for x in b['lumbar']])


def weakened(model_path, pf, out_path):
    """Copy of the model with soleus + gastroc max isometric force scaled by pf (both legs)."""
    m = osim.Model(str(model_path))
    m.initSystem()
    for n in ('soleus_r', 'soleus_l', 'gastroc_r', 'gastroc_l'):
        mu = m.updMuscles().get(n) if m.getMuscles().getSize() else osim.Muscle.safeDownCast(m.updComponent('/' + n))
        mu.setMaxIsometricForce(mu.getMaxIsometricForce() * pf)
    m.printToXML(str(out_path))
    return out_path


def tracking_guess(model_path, bounds):
    """Official example's tracking problem (healthy reference data) -> initial guess."""
    track = osim.MocoTrack()
    track.setName('gaitTracking')
    table = osim.TableProcessor(str(REF_DIR / 'referenceCoordinates.sto'))
    table.append(osim.TabOpLowPassFilter(6))
    mp = osim.ModelProcessor(str(model_path))
    track.setModel(mp)
    track.setStatesReference(table)
    track.set_states_global_tracking_weight(1)
    track.set_allow_unused_references(True)
    track.set_track_reference_position_derivatives(True)
    track.set_apply_tracked_states_to_guess(True)
    track.set_initial_time(0.0)
    track.set_final_time(0.470089)
    study = track.initialize()
    problem = study.updProblem()
    model = mp.process()
    model.initSystem()
    add_symmetry(problem, model)
    osim.MocoControlGoal.safeDownCast(problem.updGoal('control_effort')).setWeight(10)
    contact = osim.MocoContactTrackingGoal('contact', 1)
    contact.setExternalLoadsFile(str(REF_DIR / 'referenceGRF.xml'))
    for side, label in (('r', 'Right_GRF'), ('l', 'Left_GRF')):
        v = osim.StdVectorString()
        v.append(f'contactHeel_{side}')
        v.append(f'contactFront_{side}')
        contact.addContactGroup(v, label)
    contact.setProjection('plane')
    contact.setProjectionVector(osim.Vec3(0, 0, 1))
    problem.addGoal(contact)
    set_bounds(problem, ORIGINAL_BOUNDS, model)  # tracking uses the original bounds, as in the example
    return study.solve()


def predict(model_path, guess, bounds, speed, mesh, stability=0.0):
    study = osim.MocoStudy()
    study.setName('gaitPrediction')
    problem = study.updProblem()
    mp = osim.ModelProcessor(str(model_path))
    problem.setModelProcessor(mp)
    model = mp.process()
    model.initSystem()
    add_symmetry(problem, model)
    if speed != 'free':
        sg = osim.MocoAverageSpeedGoal('speed')
        problem.addGoal(sg)
        sg.set_desired_average_speed(float(speed))
    effort = osim.MocoControlGoal('effort', 10)
    problem.addGoal(effort)
    effort.setExponent(3)
    effort.setDivideByDisplacement(True)
    if stability > 0:
        # Head/trunk stability ("soft landing"): squared norm of the torso's linear acceleration per
        # metre walked. People damp trunk/head accelerations, partly by flexing the stance knee at
        # loading; an effort-only cost has no reason to, so it lands stiff-kneed.
        stab = osim.MocoOutputGoal('stability', stability)
        problem.addGoal(stab)
        stab.setOutputPath('/bodyset/torso|linear_acceleration')
        stab.setExponent(2)
        stab.setDivideByDisplacement(True)
    problem.setTimeBounds(0, list(bounds['time']))
    set_bounds(problem, bounds, model)
    solver = study.initCasADiSolver()
    solver.set_num_mesh_intervals(mesh)
    solver.set_verbosity(2)
    solver.set_optim_solver('ipopt')
    solver.set_optim_convergence_tolerance(1e-4)
    solver.set_optim_constraint_tolerance(1e-4)
    solver.set_optim_max_iterations(3000)
    if isinstance(guess, (str, Path)):
        solver.setGuessFile(str(guess))
    else:
        solver.setGuess(guess)
    sol = study.solve()
    if not sol.success():
        sol.unseal()
    return sol, model


def bound_hits(sol, bounds, tol_deg=0.5):
    """Which coordinates / time sit within tol of a bound (a solution 'pinned' to a limit)."""
    import numpy as np
    hits = []
    for coord, (lo, hi) in bounds.items():
        if coord == 'time':
            T = sol.getFinalTime() - sol.getInitialTime()
            if T <= lo + 1e-3 or T >= hi - 1e-3:
                hits.append(f'time={T:.3f}')
            continue
        for n in sol.getStateNames():
            if coord in n and n.endswith('/value'):
                v = np.degrees(np.array(sol.getStateMat(n)))
                if v.min() <= lo + tol_deg or v.max() >= hi - tol_deg:
                    hits.append(f'{n.split("/")[-2]} [{v.min():.1f},{v.max():.1f}]')
    return hits


def run(a):
    t0 = time.time()
    bounds = {'wide': WIDE_BOUNDS, 'pelvis': PELVIS_BOUNDS, 'original': ORIGINAL_BOUNDS}[a.bounds]
    run_dir = RUNS / a.tag
    run_dir.mkdir(parents=True, exist_ok=True)
    model_path = Path(a.model)
    if a.pf != 1.0:
        model_path = weakened(model_path, a.pf, run_dir / 'model.osim')
    guess = a.guess if a.guess else tracking_guess(a.model, bounds)
    sol, model = predict(model_path, guess, bounds, a.speed, a.mesh, a.stability)
    sol.write(str(run_dir / 'halfstride.sto'))
    stride = osim.createPeriodicTrajectory(sol)
    stride.write(str(run_dir / 'stride.sto'))
    cr, cl = osim.StdVectorString(), osim.StdVectorString()
    for side, v in (('r', cr), ('l', cl)):
        v.append(f'contactHeel_{side}')
        v.append(f'contactFront_{side}')
    osim.STOFileAdapter.write(osim.createExternalLoadsTableForGait(model, stride, cr, cl), str(run_dir / 'grf.sto'))
    tx = sol.getStateMat('/jointset/groundPelvis/pelvis_tx/value')
    T = sol.getFinalTime() - sol.getInitialTime()
    meta = {
        'tag': a.tag, 'model': str(a.model), 'plantarflexor_strength': a.pf, 'speed_mode': a.speed,
        'mesh_intervals': a.mesh, 'bounds': a.bounds, 'stability_weight': a.stability, 'guess': str(a.guess or 'tracking'),
        'converged': bool(sol.success()), 'status': sol.getStatus(), 'iterations': sol.getNumIterations(),
        'objective': sol.getObjective(), 'speed_mps': float((tx[-1] - tx[0]) / T), 'half_stride_s': T,
        'bound_hits': bound_hits(sol, bounds), 'wall_time_s': round(time.time() - t0, 1),
        'opensim': osim.GetVersion(),
    }
    (run_dir / 'meta.json').write_text(json.dumps(meta, indent=2))
    print('RESULT', json.dumps(meta))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=str(HERE / 'models' / '2D_gait_fixed.osim'))
    ap.add_argument('--pf', type=float, default=1.0)
    ap.add_argument('--speed', default='1.2', help="m/s, or 'free'")
    ap.add_argument('--mesh', type=int, default=50)
    ap.add_argument('--bounds', choices=['wide', 'pelvis', 'original'], default='wide')
    ap.add_argument('--stability', type=float, default=0.0, help='weight of the torso-acceleration goal')
    ap.add_argument('--guess', default=None, help='path to a .sto guess; default = tracking solve')
    ap.add_argument('--tag', required=True)
    ap.add_argument('--regression', action='store_true', help='original model+bounds; expect objective ~0.135')
    a = ap.parse_args()
    if a.regression:
        a.model, a.pf, a.speed, a.mesh, a.bounds = str(HERE / 'models' / '2D_gait.osim'), 1.0, '1.2', 50, 'original'
    run(a)
