"""Bake the OpenSim bone meshes into one web glTF (run headless):

    blender -b --factory-startup --python export_bones_glb.py

Each bone: OBJ (OpenSim body frame) -> Blender axes -> subdivided once -> self-occlusion
(ambient occlusion) baked into a vertex colour -> exported as a named mesh. The glTF
exporter converts Blender Z-up back to Y-up, so vertices land in OpenSim body coordinates,
matching the per-frame transforms in web/public/data/*.bin.
"""
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(r'C:\Users\Sudarshan\claude_code\kinema')
BONES = ROOT / 'blender' / 'bones'
OUT = ROOT / 'web' / 'public' / 'models' / 'bones.glb'
P = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))  # OpenSim -> Blender

for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 96
sc.cycles.device = 'CPU'
sc.world = sc.world or bpy.data.worlds.new('W')
# AO reach at bone scale (default is 10 m, which darkens everything): crevices, not whole bones.
sc.world.light_settings.distance = 0.02

mat = bpy.data.materials.new('Bone')
mat.use_nodes = True

made = []
for obj_file in sorted(BONES.glob('*.obj')):
    verts, faces = [], []
    for line in obj_file.read_text().splitlines():
        if line.startswith('v '):
            verts.append(P @ Vector(map(float, line.split()[1:4])))
        elif line.startswith('f '):
            faces.append([int(k) - 1 for k in line.split()[1:]])
    me = bpy.data.meshes.new(obj_file.stem)
    me.from_pydata(verts, [], faces)
    me.validate()
    ob = bpy.data.objects.new(obj_file.stem, me)
    sc.collection.objects.link(ob)
    ob.data.materials.append(mat)
    sub = ob.modifiers.new('Subdiv', 'SUBSURF'); sub.levels = sub.render_levels = 1
    ob.modifiers.new('Smooth', 'SMOOTH').factor = 0.3
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    ob.data.polygons.foreach_set('use_smooth', [True] * len(ob.data.polygons))
    made.append(ob)

# Bake each bone's self-occlusion in isolation (bones are not posed together here).
for ob in made:
    for o in made:
        o.hide_render = o is not ob
    ca = ob.data.color_attributes.new('AO', 'FLOAT_COLOR', 'POINT')
    ob.data.color_attributes.active_color = ca
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    sc.render.bake.target = 'VERTEX_COLORS'
    sc.world = sc.world or bpy.data.worlds.new('W')
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS', margin=0)
    print('baked', ob.name, len(ob.data.vertices), 'verts')
for o in made:
    o.hide_render = False

OUT.parent.mkdir(parents=True, exist_ok=True)
kwargs = dict(filepath=str(OUT), export_format='GLB', export_yup=True, export_apply=True,
              export_materials='PLACEHOLDER', export_animations=False)
props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
if 'export_vertex_color' in props:
    kwargs['export_vertex_color'] = 'ACTIVE'
elif 'export_colors' in props:
    kwargs['export_colors'] = True
bpy.ops.export_scene.gltf(**kwargs)
print('EXPORTED', OUT, round(OUT.stat().st_size / 1e6, 2), 'MB')
