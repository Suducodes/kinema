"""Decimate the Lenhart knee STLs into one web GLB (run with blender -b --factory-startup --python).

Note: Blender 5.1's STL importer ignores up_axis here, so the GLB ends up a quarter turn about x from
the OpenSim body frames (glb y = stl z, glb z = -stl y). The viewer rotates the geometry back
(web/src/knee/main.ts); the printed bounds below are in Blender's frame, not the file's.
"""
import sys
from pathlib import Path

import bpy

GEO = Path(sys.argv[sys.argv.index('--') + 1])
OUT = Path(sys.argv[sys.argv.index('--') + 2])
TARGET = {  # triangles per mesh in the web model
    'femur-bone': 26000, 'tibia-bone': 20000, 'fibula-bone': 5000, 'patella-bone': 7000,
    'femur-cartilage': 9000, 'tibia-cartilage': 6000, 'patella-cartilage': 3000,
}

bpy.ops.wm.read_factory_settings(use_empty=True)
for key, tris in TARGET.items():
    f = GEO / f'lenhart2015-R-{key}.stl'
    bpy.ops.wm.stl_import(filepath=str(f), forward_axis='NEGATIVE_Z', up_axis='Y')
    ob = bpy.context.selected_objects[0]
    ob.name = key
    n = len(ob.data.polygons)
    if n > tris:
        mod = ob.modifiers.new('dec', 'DECIMATE')
        mod.ratio = tris / n
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_smooth()
    # Blender stores the y-up file as z-up: x stays, file y -> blender z, file z -> blender -y
    vs = [v.co for v in ob.data.vertices]
    lo = [min(v[i] for v in vs) for i in range(3)]
    hi = [max(v[i] for v in vs) for i in range(3)]
    print(f'{key}: {n} -> {len(ob.data.polygons)} tris; file-frame bounds x[{lo[0]:.3f},{hi[0]:.3f}] y[{lo[2]:.3f},{hi[2]:.3f}] z[{-hi[1]:.3f},{-lo[1]:.3f}]')

bpy.ops.export_scene.gltf(filepath=str(OUT), export_format='GLB', export_yup=True, export_apply=True,
                          export_normals=True, export_materials='NONE', export_texcoords=False)
print('wrote', OUT)
