"""Build the Twin Walkers scene from data/anim/*.json (run inside Blender).

Re-runnable: it clears and rebuilds the 'KINEMA' collection only.
Bones are the OpenSim meshes, muscles are NURBS tubes along the exact
OpenSim muscle paths, coloured by activation. Both twins walk on treadmills
at the simulated 1.2 m/s.
"""
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector, Quaternion

ROOT = Path(r'C:\Users\Sudarshan\claude_code\kinema')
BONES = ROOT / 'blender' / 'bones'
TWINS = [('sb_h_fix', 'Healthy', -1.05), ('sb_w_fix', 'WeakCalves', 1.05)]  # (tag, label, x offset)
FPS = 120  # overwritten from the exported JSON
RIB_PITCH = 0.008  # m; 1.2 m/s * 8 s / 0.008 = 1200 ribs per loop, so the belt loops seamlessly


# ---------------------------------------------------------------- helpers

def collection(name, parent=None):
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if col.name not in (parent or bpy.context.scene.collection).children:
        (parent or bpy.context.scene.collection).children.link(col)
    return col


def clear(col):
    for child in list(col.children):
        clear(child)
        bpy.data.collections.remove(child)
    for ob in list(col.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


def bsdf(mat):
    return next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def set_input(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value


def fcurve(idblock, path, index):
    """Keyframe curve for idblock.path[index] that works with Blender 4.4+ slotted actions."""
    ad = idblock.animation_data or idblock.animation_data_create()
    if ad.action is None:
        ad.action = bpy.data.actions.new(f'{idblock.name}_act')
    act = ad.action
    if hasattr(act, 'fcurve_ensure_for_datablock'):
        return act.fcurve_ensure_for_datablock(idblock, path, index=index)
    return act.fcurves.find(path, index=index) or act.fcurves.new(path, index=index)


def bake(idblock, path, index, values, interp='LINEAR'):
    fc = fcurve(idblock, path, index)
    fc.keyframe_points.clear()
    fc.keyframe_points.add(len(values))
    co = []
    for f, v in enumerate(values):
        co += [f + 1, v]
    fc.keyframe_points.foreach_set('co', co)
    for kp in fc.keyframe_points:
        kp.interpolation = interp
    fc.update()


# ---------------------------------------------------------------- materials

def mat_bone():
    m = bpy.data.materials.get('K_Bone') or bpy.data.materials.new('K_Bone')
    m.use_nodes = True
    nt = m.node_tree
    p = bsdf(m)
    set_input(p, 'Base Color', (0.80, 0.74, 0.62, 1))
    set_input(p, 'Roughness', 0.52)
    set_input(p, 'Subsurface Weight', 0.12)
    set_input(p, 'Subsurface Radius', (0.012, 0.008, 0.005))
    set_input(p, 'Subsurface Scale', 0.02)
    # Fine surface pitting so bone isn't plastic-smooth.
    if not any(n.type == 'BUMP' for n in nt.nodes):
        noise = nt.nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 900
        noise.inputs['Detail'].default_value = 6
        bump = nt.nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 0.08
        bump.inputs['Distance'].default_value = 0.0004
        nt.links.new(noise.outputs['Fac'], bump.inputs['Height'])
        nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    return m


def mat_muscle():
    """One shared material; activation arrives through Object Info > Color.r (0..1)."""
    m = bpy.data.materials.get('K_Muscle') or bpy.data.materials.new('K_Muscle')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL'):
            nt.nodes.remove(n)
    p = bsdf(m)
    info = nt.nodes.new('ShaderNodeObjectInfo')
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(info.outputs['Color'], sep.inputs['Color'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    cr.elements[0].position, cr.elements[0].color = 0.0, (0.42, 0.20, 0.19, 1)   # resting: pale, desaturated
    cr.elements[1].position, cr.elements[1].color = 1.0, (0.55, 0.035, 0.03, 1)  # fully active: deep red
    nt.links.new(sep.outputs['Red'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], p.inputs['Base Color'])
    # Tendon ends: lighter, glossier. Driven by the curve's U coordinate (Generated.x).
    coord = nt.nodes.new('ShaderNodeTexCoord')
    sepxyz = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(coord.outputs['Generated'], sepxyz.inputs['Vector'])
    tend = nt.nodes.new('ShaderNodeValToRGB')
    tr = tend.color_ramp
    tr.elements[0].position, tr.elements[0].color = 0.16, (1, 1, 1, 1)
    tr.elements[1].position, tr.elements[1].color = 0.26, (0, 0, 0, 1)
    e2 = tr.elements.new(0.74); e2.color = (0, 0, 0, 1)
    e3 = tr.elements.new(0.84); e3.color = (1, 1, 1, 1)
    nt.links.new(sepxyz.outputs['X'], tend.inputs['Fac'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    nt.links.new(tend.outputs['Color'], mix.inputs['Factor'])
    nt.links.new(ramp.outputs['Color'], mix.inputs['A'])
    mix.inputs['B'].default_value = (0.86, 0.82, 0.74, 1)
    nt.links.new(mix.outputs['Result'], p.inputs['Base Color'])
    rough = nt.nodes.new('ShaderNodeMapRange')
    rough.inputs['To Min'].default_value = 0.42
    rough.inputs['To Max'].default_value = 0.22
    nt.links.new(tend.outputs['Color'], rough.inputs['Value'])
    nt.links.new(rough.outputs['Result'], p.inputs['Roughness'])
    set_input(p, 'Subsurface Weight', 0.35)
    set_input(p, 'Subsurface Radius', (0.03, 0.008, 0.005))
    set_input(p, 'Subsurface Scale', 0.03)
    set_input(p, 'Coat Weight', 0.25)
    set_input(p, 'Coat Roughness', 0.18)
    return m


def mat_simple(name, color, rough, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    p = bsdf(m)
    set_input(p, 'Base Color', (*color, 1))
    set_input(p, 'Roughness', rough)
    set_input(p, 'Metallic', metallic)
    return m


def mat_belt():
    """Rubber belt with fine transverse ribs; the ribs scroll at belt speed."""
    m = bpy.data.materials.get('K_Belt') or bpy.data.materials.new('K_Belt')
    m.use_nodes = True
    nt = m.node_tree
    p = bsdf(m)
    set_input(p, 'Base Color', (0.035, 0.035, 0.037, 1))
    set_input(p, 'Roughness', 0.78)
    if not any(n.type == 'BUMP' for n in nt.nodes):
        coord = nt.nodes.new('ShaderNodeTexCoord')
        mapping = nt.nodes.new('ShaderNodeMapping')
        mapping.name = 'BeltScroll'
        wave = nt.nodes.new('ShaderNodeTexWave')
        wave.wave_type, wave.bands_direction = 'BANDS', 'X'
        wave.inputs['Scale'].default_value = 1.0
        wave.inputs['Distortion'].default_value = 0.0
        noise = nt.nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 400
        add = nt.nodes.new('ShaderNodeMath'); add.operation = 'ADD'
        mul = nt.nodes.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = 0.15
        bump = nt.nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 0.35
        nt.links.new(coord.outputs['Object'], mapping.inputs['Vector'])
        # X-band wave period is 2*pi/20 texture units; scale so one period = RIB_PITCH metres.
        mapping.inputs['Scale'].default_value = (2 * math.pi / (20 * RIB_PITCH), 1, 1)
        nt.links.new(mapping.outputs['Vector'], wave.inputs['Vector'])
        nt.links.new(noise.outputs['Fac'], mul.inputs[0])
        nt.links.new(wave.outputs['Fac'], add.inputs[0])
        nt.links.new(mul.outputs['Value'], add.inputs[1])
        nt.links.new(add.outputs['Value'], bump.inputs['Height'])
        nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    return m


# ---------------------------------------------------------------- builders

P = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))  # OpenSim -> Blender basis


def import_bone(file, scale, name, col):
    path = BONES / file.replace('.vtp', '.obj')
    verts, faces = [], []
    for line in path.read_text().splitlines():
        if line.startswith('v '):
            x, y, z = map(float, line.split()[1:4])
            v = P @ Vector((x * scale[0], y * scale[1], z * scale[2]))
            verts.append(v)
        elif line.startswith('f '):
            faces.append([int(k) - 1 for k in line.split()[1:]])
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    sub = ob.modifiers.new('Subdiv', 'SUBSURF')
    sub.levels, sub.render_levels = 1, 2
    ob.modifiers.new('Smooth', 'SMOOTH').factor = 0.3
    ob.data.materials.append(mat_bone())
    ob.rotation_mode = 'QUATERNION'
    return ob


def animate_object(ob, frames, key, x_off):
    loc = [[], [], []]
    quat = [[], [], [], []]
    prev = None
    for fr in frames:
        d = fr['meshes'][key]
        R = Matrix(d['R'])
        q = R.to_quaternion()
        if prev is not None and prev.dot(q) < 0:  # keep quaternion continuous
            q.negate()
        prev = q
        for k in range(3):
            loc[k].append(d['p'][k] + (x_off if k == 0 else 0))
        for k in range(4):
            quat[k].append(q[k])
    for k in range(3):
        bake(ob, 'location', k, loc[k])
    for k in range(4):
        bake(ob, 'rotation_quaternion', k, quat[k])


def build_muscle(name, fmax, frames, x_off, col):
    n = len(frames[0]['muscles'][name])
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    belly = 0.007 + 0.00032 * math.sqrt(fmax)  # radius tracks muscle size
    cu.bevel_depth = belly
    cu.bevel_resolution = 4
    cu.resolution_u = 10
    cu.use_fill_caps = True
    sp = cu.splines.new('NURBS')
    sp.points.add(n - 1)
    sp.order_u = 3
    sp.use_endpoint_u = True
    for i, pt in enumerate(sp.points):
        u = i / (n - 1)
        # Fusiform profile: thin tendon at both ends, full belly in the middle.
        pt.radius = 0.18 + 0.82 * math.sin(math.pi * min(max((u - 0.12) / 0.76, 0), 1)) ** 0.8
    ob = bpy.data.objects.new(name, cu)
    col.objects.link(ob)
    ob.data.materials.append(mat_muscle())
    for i in range(n):
        for k in range(3):
            vals = [fr['muscles'][name][i][k] + (x_off if k == 0 else 0) for fr in frames]
            bake(cu, f'splines[0].points[{i}].co', k, vals)
        bake(cu, f'splines[0].points[{i}].co', 3, [1.0] * len(frames))
    # Activation -> object colour (red channel), scaled so 0.4 activation reads as full.
    acts = [min(fr['act'][name] / 0.4, 1.0) for fr in frames]
    bake(ob, 'color', 0, acts)
    return ob


def build_treadmill(x, col, length=1.7, width=0.62, speed=1.2, frames=240):
    belt = bpy.data.meshes.new('belt')
    hw, hl = width / 2, length / 2
    belt.from_pydata([(-hl, -hw, 0), (hl, -hw, 0), (hl, hw, 0), (-hl, hw, 0)], [], [(0, 1, 2, 3)])
    bo = bpy.data.objects.new('Treadmill_Belt', belt)
    bo.location = (x, 0, -0.002)
    col.objects.link(bo)
    m = mat_belt()
    bo.data.materials.append(m)
    # Ribs scroll backwards at belt speed. Mapping offsets live in scaled texture space.
    sx = m.node_tree.nodes['BeltScroll'].inputs['Scale'].default_value[0]
    bake(m.node_tree, 'nodes["BeltScroll"].inputs[1].default_value', 0,
         [-(f / FPS) * speed * sx for f in range(frames)])
    deck = bpy.data.objects.new('Treadmill_Deck', bpy.data.meshes.new('deck'))
    col.objects.link(deck)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(deck.data); bm.free()
    deck.scale = (length + 0.22, width + 0.24, 0.12)
    deck.location = (x, 0, -0.064)
    bev = deck.modifiers.new('Bevel', 'BEVEL'); bev.width = 0.012; bev.segments = 3
    deck.data.materials.append(mat_simple('K_DeckPaint', (0.06, 0.062, 0.066), 0.45))
    for side in (-1, 1):
        rail = bpy.data.objects.new(f'Treadmill_Rail{side}', bpy.data.meshes.new('rail'))
        col.objects.link(rail)
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(rail.data); bm.free()
        rail.scale = (length + 0.2, 0.09, 0.022)
        rail.location = (x, side * (width / 2 + 0.06), 0.004)
        b2 = rail.modifiers.new('Bevel', 'BEVEL'); b2.width = 0.006; b2.segments = 3
        rail.data.materials.append(mat_simple('K_Aluminium', (0.80, 0.81, 0.82), 0.32, 1.0))


def build_stage(col):
    import bmesh
    # Seamless cyclorama: floor that curves up into a back wall.
    cyc = bpy.data.objects.new('Cyclorama', bpy.data.meshes.new('cyc'))
    col.objects.link(cyc)
    bm = bmesh.new()
    prof = [(y, 0.0) for y in (-6, -2, 1.5)]
    r = 1.6
    for k in range(1, 13):
        a = k / 12 * math.pi / 2
        prof.append((1.5 + r * math.sin(a), r - r * math.cos(a)))
    prof += [(3.1, 3.5), (3.1, 7.0)]
    left = [bm.verts.new((-12, y, z - 0.07)) for y, z in prof]
    right = [bm.verts.new((12, y, z - 0.07)) for y, z in prof]
    for i in range(len(prof) - 1):
        bm.faces.new((left[i], right[i], right[i + 1], left[i + 1]))
    bm.to_mesh(cyc.data); bm.free()
    cyc.data.polygons.foreach_set('use_smooth', [True] * len(cyc.data.polygons))
    cyc.data.materials.append(mat_simple('K_Studio', (0.045, 0.047, 0.05), 0.85))

    def area(name, loc, rot, size, energy, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.shape, ld.size, ld.energy, ld.color = 'RECTANGLE', size[0], energy, color
        ld.size_y = size[1]
        lo = bpy.data.objects.new(name, ld)
        lo.location, lo.rotation_euler = loc, rot
        col.objects.link(lo)
    area('Key_Softbox', (-1.8, -3.4, 3.4), (math.radians(52), 0, math.radians(-28)), (1.8, 1.2), 380, (1.0, 0.97, 0.93))
    area('Fill', (3.5, -3.0, 1.6), (math.radians(75), 0, math.radians(48)), (2.5, 2.5), 40, (0.92, 0.95, 1.0))
    area('Rim_Left', (-3.8, 2.2, 2.0), (math.radians(70), 0, math.radians(-125)), (0.4, 2.2), 650)
    area('Rim_Right', (3.8, 2.2, 2.0), (math.radians(70), 0, math.radians(125)), (0.4, 2.2), 650)

    cam_d = bpy.data.cameras.new('Cam')
    cam_d.lens = 48
    cam_d.dof.use_dof = True
    cam_d.dof.aperture_fstop = 4.0
    cam = bpy.data.objects.new('Camera_Main', cam_d)
    col.objects.link(cam)
    cam.location = (0.0, -5.6, 1.08)
    cam.rotation_euler = (math.radians(86), 0, 0)
    target = bpy.data.objects.new('CamTarget', None)
    target.location = (0, 0, 0.9)
    col.objects.link(target)
    cam_d.dof.focus_object = target
    bpy.context.scene.camera = cam


def build_ankle_camera(label, data, x_off, col):
    """Close-up camera on the right ankle, centred on the foot around right toe-off."""
    frames = data['frames']
    grf = [fr['readout']['grf_r_bw'] for fr in frames]
    # First right toe-off: vertical GRF falls through 5% BW after being loaded.
    toe_off = next(i for i in range(1, len(grf)) if grf[i - 1] >= 0.05 > grf[i] and max(grf[:i]) > 0.5)
    foot_key = next(m['name'] for m in data['meshes'] if m['file'] == 'r_foot.vtp')
    lo, hi = max(0, toe_off - int(0.35 * FPS)), min(len(frames) - 1, toe_off + int(0.20 * FPS))
    xs = [frames[i]['meshes'][foot_key]['p'][0] for i in range(lo, hi + 1)]
    target = bpy.data.objects.new(f'AnkleTarget_{label}', None)
    target.location = (sum(xs) / len(xs) + x_off - 0.13, -0.08, 0.17)
    col.objects.link(target)
    cam_d = bpy.data.cameras.new(f'CamAnkle_{label}')
    cam_d.lens = 62
    cam_d.sensor_fit = 'VERTICAL'
    cam_d.dof.use_dof = True
    cam_d.dof.aperture_fstop = 2.8
    cam_d.dof.focus_object = target
    cam = bpy.data.objects.new(f'Camera_Ankle_{label}', cam_d)
    cam.location = (target.location.x + 0.15, -1.9, 0.36)
    col.objects.link(cam)
    track = cam.constraints.new('TRACK_TO')
    track.target, track.track_axis, track.up_axis = target, 'TRACK_NEGATIVE_Z', 'UP_Y'
    cam['slowmo_frames'] = [lo + 1, hi + 1]  # 1-based Blender frames
    cam['toe_off_frame'] = toe_off + 1
    return cam


def setup_render(frames):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 256
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 1, frames
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.exposure = -0.4
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    world = sc.world or bpy.data.worlds.new('World')
    sc.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.012, 0.012, 0.014, 1)
    bg.inputs['Strength'].default_value = 1.0


def main():
    global FPS
    root = collection('KINEMA')
    clear(root)
    bpy.data.orphans_purge(do_recursive=True)
    for ob in list(bpy.data.objects):
        if ob.name in ('Cube', 'Light', 'Camera') and ob.users_collection and ob.users_collection[0].name == 'Collection':
            bpy.data.objects.remove(ob, do_unlink=True)
    stage = collection('Stage', root)
    n_frames = 0
    # Draw both twins with healthy muscle sizes: weakness is modelled as lost force, not visible atrophy.
    healthy = json.loads((ROOT / 'data' / 'anim' / f'{TWINS[0][0]}.json').read_text())['muscles']
    for tag, label, x in TWINS:
        data = json.loads((ROOT / 'data' / 'anim' / f'{tag}.json').read_text())
        frames = data['frames']
        n_frames = len(frames)
        FPS = data['fps']
        col = collection(f'Twin_{label}', root)
        for m in data['meshes']:
            ob = import_bone(m['file'], m['scale'], f'{label}_{m["name"]}', col)
            animate_object(ob, frames, m['name'], x)
        for name in data['muscles']:
            build_muscle(name, healthy[name]['fmax'], frames, x, col).name = f'{label}_{name}'
        build_treadmill(x, stage, frames=n_frames)
        build_ankle_camera(label, data, x, stage)
    build_stage(stage)
    setup_render(n_frames)
    print('built', n_frames, 'frames')


main()
