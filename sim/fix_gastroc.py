"""Fix the 2D_gait.osim gastrocnemius knee moment arm.

Problem: the gastroc's femoral via-point is a ConditionalPathPoint active only for
knee angles in [-45, 10] deg. The reference gait10dof18musc model keeps a large
knee moment arm at deep flexion because its knee is a moving-axis CustomJoint; the
2D model's knee is a fixed-axis PinJoint, so once the via-point switches off the
muscle line passes almost through the knee axis and the moment arm collapses
(-0.14 cm at 90 deg vs -1.61 cm in the reference).

Fix: replace the conditional via-point with an always-active PathPoint, optionally
pushed posteriorly by `--posterior` metres, and report the moment-arm curve
against the reference so the choice is documented, not guessed.

    python fix_gastroc.py --posterior 0.000 --out models/2D_gait_fixed.osim
"""
import argparse
from pathlib import Path

import numpy as np
import opensim as osim

HERE = Path(__file__).resolve().parent
REF = Path(osim.__file__).parent / 'tests' / 'gait10dof18musc_subject01.osim'
ANGLES = list(range(0, -95, -15))


def moment_arms(model, side='r'):
    s = model.initSystem()
    mu = model.getMuscles().get(f'gastroc_{side}') if model.getMuscles().getSize() \
        else osim.Muscle.safeDownCast(model.getComponent(f'/gastroc_{side}'))
    knee = model.getCoordinateSet().get(f'knee_angle_{side}')
    out = []
    for a in ANGLES:
        knee.setValue(s, np.radians(a))
        model.realizePosition(s)
        out.append(mu.getGeometryPath().computeMomentArm(s, knee) * 100)
    return np.array(out)


def fix(src, dst, posterior):
    """Edit the XML: ConditionalPathPoint -> PathPoint (keeps name, frame socket, location)."""
    import xml.etree.ElementTree as ET
    tree = ET.parse(src)
    n = 0
    for muscle in tree.iter('DeGrooteFregly2016Muscle'):
        if not muscle.get('name', '').startswith('gastroc_'):
            continue
        for parent in muscle.iter('objects'):
            for i, cond in enumerate(list(parent)):
                if cond.tag != 'ConditionalPathPoint':
                    continue
                pp = ET.Element('PathPoint', {'name': cond.get('name')})
                for tag in ('socket_parent_frame', 'location'):
                    pp.append(cond.find(tag))
                loc = [float(x) for x in pp.find('location').text.split()]
                loc[0] -= posterior  # -x is posterior in the femur frame
                pp.find('location').text = ' '.join(f'{v:.6f}' for v in loc)
                parent.remove(cond)
                parent.insert(i, pp)
                n += 1
    assert n == 2, f'expected 2 conditional points, replaced {n}'
    tree.write(dst, encoding='UTF-8', xml_declaration=True)
    return osim.Model(str(dst))


def strip_conditional(src, dst):
    """Remove the gastroc ConditionalPathPoints entirely (the wrap cylinder replaces them)."""
    import xml.etree.ElementTree as ET
    tree = ET.parse(src)
    n = 0
    for muscle in tree.iter('DeGrooteFregly2016Muscle'):
        if muscle.get('name', '').startswith('gastroc_'):
            for parent in muscle.iter('objects'):
                for cond in [c for c in parent if c.tag == 'ConditionalPathPoint']:
                    parent.remove(cond)
                    n += 1
    assert n == 2, n
    tree.write(dst, encoding='UTF-8', xml_declaration=True)


def mt_length(model, side):
    s = model.initSystem()  # default pose: all coordinates at 0
    mu = model.getMuscles().get(f'gastroc_{side}') if model.getMuscles().getSize() \
        else osim.Muscle.safeDownCast(model.getComponent(f'/gastroc_{side}'))
    model.realizePosition(s)
    return mu.getLength(s)


def add_condyle_wrap(src, dst, radius, origin_up=0.0):
    """Raise the gastroc origin by `origin_up` m (it really sits above the condyles), wrap the
    path posteriorly around a cylinder on the knee axis, and shorten tendon slack length by
    the added musculotendon length so the fibre operating range is unchanged."""
    model = osim.Model(str(src))
    model.initSystem()
    before = {side: mt_length(osim.Model(str(src)), side) for side in ('r', 'l')}
    for side in ('r', 'l'):
        path = f'/gastroc_{side}' if model.hasComponent(f'/gastroc_{side}') else f'/forceset/gastroc_{side}'
        mu = osim.Muscle.safeDownCast(model.updComponent(path))
        origin = osim.PathPoint.safeDownCast(mu.updGeometryPath().updPathPointSet().get(0))
        loc = origin.get_location().to_numpy().copy()
        origin.set_location(osim.Vec3(float(loc[0]), float(loc[1] + origin_up), float(loc[2])))
    for side in ('r', 'l'):
        knee = model.getJointSet().get(f'knee_{side}')
        p = knee.getParentFrame().findTransformInBaseFrame().p().to_numpy().copy()  # copy: p() is a temporary
        centre = osim.Vec3(float(p[0]), float(p[1]), float(p[2]))  # knee axis in femur frame
        femur = model.updBodySet().get(f'femur_{side}')
        wc = osim.WrapCylinder()
        wc.setName(f'gas_condyles_{side}')
        wc.set_radius(radius)
        wc.set_length(0.12)
        wc.set_translation(centre)
        wc.set_quadrant('-x')  # posterior
        wc.setFrame(femur)
        femur.addWrapObject(wc)
        path = f'/gastroc_{side}' if model.hasComponent(f'/gastroc_{side}') else f'/forceset/gastroc_{side}'
        mu = osim.Muscle.safeDownCast(model.updComponent(path))
        mu.updGeometryPath().addPathWrap(wc)
    model.finalizeConnections()
    model.printToXML(str(dst))
    muscles_into_forceset(dst)
    # Keep fibre operating range: tendon slack absorbs the added path length.
    fixed = osim.Model(str(dst))
    for side in ('r', 'l'):
        added = mt_length(osim.Model(str(dst)), side) - before[side]
        mu = fixed.updMuscles().get(f'gastroc_{side}')
        mu.setTendonSlackLength(mu.getTendonSlackLength() + added)
    fixed.printToXML(str(dst))
    return osim.Model(str(dst))


def muscles_into_forceset(path):
    """2D_gait.osim keeps muscles as top-level <components>; on reload they then resolve
    their PathWrap before the femur has given the wrap cylinder its frame. Moving them
    into the standard <ForceSet> restores the normal connection order."""
    import xml.etree.ElementTree as ET
    tree = ET.parse(path)
    model = tree.getroot().find('Model')
    comps = model.find('components')
    fs_objects = model.find('ForceSet').find('objects')
    moved = 0
    if comps is not None:
        for m in [c for c in comps if c.tag == 'DeGrooteFregly2016Muscle']:
            comps.remove(m)
            fs_objects.append(m)
            moved += 1
    tree.write(path, encoding='UTF-8', xml_declaration=True)
    return moved


def rms(a, b):
    return float(np.sqrt(np.mean((a - b) ** 2)))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(HERE / 'models' / '2D_gait_fixed.osim'))
    a = ap.parse_args()
    src = HERE / 'models' / '2D_gait.osim'
    tmp = HERE / 'models' / '_nocond.osim'
    strip_conditional(src, tmp)
    ref = moment_arms(osim.Model(str(REF)))
    old = moment_arms(osim.Model(str(src)))
    print('knee angle deg :', ANGLES)
    print('reference  cm  :', np.round(ref, 2))
    print('original   cm  :', np.round(old, 2), ' RMS err', round(rms(old, ref), 2))
    best = None
    for up in (0.02, 0.03, 0.04, 0.05):
        for r in (0.018, 0.021, 0.024, 0.027, 0.030):
            new = moment_arms(add_condyle_wrap(tmp, a.out, r, up))
            e = rms(new, ref)
            print(f'origin +{up:.2f} m, r={r:.3f}:', np.round(new, 2), ' RMS', round(e, 2))
            if best is None or e < best[2]:
                best = (up, r, e, new)
    m = add_condyle_wrap(tmp, a.out, best[1], best[0])
    tmp.unlink()
    lts = m.getMuscles().get('gastroc_r').getTendonSlackLength()
    print(f'CHOSEN origin +{best[0]:.2f} m, radius {best[1]:.3f} m, RMS {best[2]:.2f} cm, '
          f'tendon slack {lts:.4f} m -> {a.out}')
    print('chosen curve cm:', np.round(best[3], 2))
