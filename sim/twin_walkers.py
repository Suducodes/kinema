"""Twin Walkers POC: healthy vs weak-plantarflexor predictive gait (OpenSim Moco, 2D model).

Usage (from kinema/sim/models):
    python ../twin_walkers.py guess            # tracking solve -> guess.sto (run once)
    python ../twin_walkers.py predict 1.0      # healthy
    python ../twin_walkers.py predict 0.4      # plantarflexors at 40% strength (60% weaker)

Based on the bundled example2DWalking.py (Falisse/Umberger). NOTE: the 2D_gait
model's gastroc path does not cross the knee (known upstream bug), so the
results are POC-only and must not be used for research.
"""
import json
import math
import re
import sys
import time
from pathlib import Path

import opensim as osim

MODEL = '2D_gait.osim'
PLANTARFLEXORS = ['soleus_r', 'soleus_l', 'gastroc_r', 'gastroc_l']
OUT = Path('../../data/runs')

BOUNDS = {
    '/jointset/groundPelvis/pelvis_tilt/value': [-20, -10],
    '/jointset/hip_l/hip_flexion_l/value': [-10, 60],
    '/jointset/hip_r/hip_flexion_r/value': [-10, 60],
    '/jointset/knee_l/knee_angle_l/value': [-50, 0],
    '/jointset/knee_r/knee_angle_r/value': [-50, 0],
    '/jointset/ankle_l/ankle_angle_l/value': [-15, 25],
    '/jointset/ankle_r/ankle_angle_r/value': [-15, 25],
    '/jointset/lumbar/lumbar/value': [0, 20],
}


def apply_bounds(problem):
    for path, (lo, hi) in BOUNDS.items():
        problem.setStateInfo(path, [math.radians(lo), math.radians(hi)])
    problem.setStateInfo('/jointset/groundPelvis/pelvis_tx/value', [0, 1])
    problem.setStateInfo('/jointset/groundPelvis/pelvis_ty/value', [0.75, 1.25])


def add_symmetry(problem, model):
    """Left-right symmetry so one step can be mirrored into a full stride."""
    goal = osim.MocoPeriodicityGoal('symmetryGoal')
    problem.addGoal(goal)
    names = model.getStateVariableNames()
    for i in range(names.getSize()):
        name = names.getitem(i)
        is_joint = name.startswith('/jointset')
        is_act = name.endswith('/activation')
        if not (is_joint or is_act):
            continue
        if '_r' in name:
            goal.addStatePair(osim.MocoPeriodicityGoalPair(name, re.sub(r'_r', '_l', name)))
        elif '_l' in name:
            goal.addStatePair(osim.MocoPeriodicityGoalPair(name, re.sub(r'_l', '_r', name)))
        elif is_joint and 'pelvis_tx/value' not in name:
            goal.addStatePair(osim.MocoPeriodicityGoalPair(name))
    goal.addControlPair(osim.MocoPeriodicityGoalPair('/lumbarAct'))


def weakened_model(strength):
    model = osim.Model(MODEL)
    for name in PLANTARFLEXORS:
        # In this model format the muscles are top-level components, not in the ForceSet.
        muscle = osim.Muscle.safeDownCast(model.updComponent(f'/{name}'))
        muscle.setMaxIsometricForce(muscle.getMaxIsometricForce() * strength)
    model.initSystem()
    return model


def write_outputs(solution, model, tag, meta):
    run = OUT / tag
    run.mkdir(parents=True, exist_ok=True)
    stride = osim.createPeriodicTrajectory(solution)
    stride.write(str(run / 'stride.sto'))
    contact_r = osim.StdVectorString()
    contact_l = osim.StdVectorString()
    for side, vec in (('r', contact_r), ('l', contact_l)):
        vec.append(f'contactHeel_{side}')
        vec.append(f'contactFront_{side}')
    grf = osim.createExternalLoadsTableForGait(model, stride, contact_r, contact_l)
    osim.STOFileAdapter.write(grf, str(run / 'grf.sto'))
    (run / 'meta.json').write_text(json.dumps(meta, indent=2))
    print(f'wrote {run}')


def solve_guess():
    track = osim.MocoTrack()
    track.setName('guessTracking')
    table = osim.TableProcessor('referenceCoordinates.sto')
    table.append(osim.TabOpLowPassFilter(6))
    track.setModel(osim.ModelProcessor(MODEL))
    track.setStatesReference(table)
    track.set_states_global_tracking_weight(1)
    track.set_allow_unused_references(True)
    track.set_track_reference_position_derivatives(True)
    track.set_apply_tracked_states_to_guess(True)
    track.set_initial_time(0.0)
    track.set_final_time(0.470089)
    study = track.initialize()
    problem = study.updProblem()
    model = osim.Model(MODEL)
    model.initSystem()
    add_symmetry(problem, model)
    osim.MocoControlGoal.safeDownCast(problem.updGoal('control_effort')).setWeight(10)
    contact = osim.MocoContactTrackingGoal('contact', 1)
    contact.setExternalLoadsFile('referenceGRF.xml')
    for side, label in (('r', 'Right_GRF'), ('l', 'Left_GRF')):
        names = osim.StdVectorString()
        names.append(f'contactHeel_{side}')
        names.append(f'contactFront_{side}')
        contact.addContactGroup(names, label)
    contact.setProjection('plane')
    contact.setProjectionVector(osim.Vec3(0, 0, 1))
    problem.addGoal(contact)
    apply_bounds(problem)
    study.solve().write('guess.sto')


def solve_predict(strength):
    t0 = time.time()
    model = weakened_model(strength)
    study = osim.MocoStudy()
    study.setName(f'predict_pf{strength:.2f}')
    problem = study.updProblem()
    problem.setModel(model)
    add_symmetry(problem, model)
    speed = osim.MocoAverageSpeedGoal('speed')
    speed.set_desired_average_speed(1.2)
    problem.addGoal(speed)
    effort = osim.MocoControlGoal('effort', 10)
    effort.setExponent(3)
    effort.setDivideByDisplacement(True)
    problem.addGoal(effort)
    problem.setTimeBounds(0, [0.4, 0.6])
    apply_bounds(problem)

    solver = study.initCasADiSolver()
    solver.set_num_mesh_intervals(50)
    solver.set_optim_solver('ipopt')
    solver.set_optim_convergence_tolerance(1e-4)
    solver.set_optim_constraint_tolerance(1e-4)
    solver.set_optim_max_iterations(2000)
    solver.setGuessFile('guess.sto')

    solution = study.solve()
    converged = solution.success()
    if not converged:
        solution.unseal()
    meta = {
        'plantarflexor_strength': strength,
        'converged': converged,
        'status': solution.getStatus(),
        'iterations': solution.getNumIterations(),
        'objective': solution.getObjective(),
        'wall_time_s': round(time.time() - t0, 1),
        'opensim': osim.GetVersion(),
        'model': MODEL,
        'caveat': 'gastroc path bug in 2D_gait.osim; POC only',
    }
    write_outputs(solution, model, f'pf_{strength:.2f}', meta)


if __name__ == '__main__':
    if sys.argv[1] == 'guess':
        solve_guess()
    else:
        solve_predict(float(sys.argv[2]))
