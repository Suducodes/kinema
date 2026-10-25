"""Background render of one shot.

    blender -b twin_walkers.blend --python render_anim.py -- <camera> <first> <last> <step> <width> <height> <out_dir>

The simulation is baked at 120 fps: the wide shot renders every 4th frame
(real time at 30 fps); the ankle shots render every frame (4x slow motion at 30 fps).
"""
import sys
from pathlib import Path

import bpy

cam, first, last, step, w, h, out = sys.argv[sys.argv.index('--') + 1:]

prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'
prefs.get_devices()
for d in prefs.devices:
    d.use = d.type == 'OPTIX'

sc = bpy.context.scene
sc.camera = bpy.data.objects[cam]
sc.cycles.device = 'GPU'
sc.cycles.samples = 128
sc.cycles.use_denoising = True
sc.cycles.denoiser = 'OPTIX'
sc.render.use_persistent_data = True
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = int(w), int(h), 100
sc.frame_start, sc.frame_end, sc.frame_step = int(first), int(last), int(step)
sc.render.image_settings.file_format = 'PNG'
Path(out).mkdir(parents=True, exist_ok=True)
sc.render.filepath = str(Path(out) / 'f_')
bpy.ops.render.render(animation=True)
