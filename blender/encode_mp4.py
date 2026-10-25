"""Encode renders/anim/f_*.png to an H.264 MP4 at 30 fps (run: blender -b --factory-startup --python encode_mp4.py)."""
from pathlib import Path

import bpy

SRC = Path(r'C:\Users\Sudarshan\claude_code\kinema\blender\renders\anim')
OUT = r'C:\Users\Sudarshan\claude_code\kinema\blender\renders\twin_walkers_v1.mp4'

files = sorted(SRC.glob('f_*.png'))
sc = bpy.context.scene
sc.sequence_editor_create()
seqs = sc.sequence_editor.strips if hasattr(sc.sequence_editor, 'strips') else sc.sequence_editor.sequences
strip = seqs.new_image('frames', str(files[0]), channel=1, frame_start=1)
for f in files[1:]:
    strip.elements.append(f.name)
sc.frame_start, sc.frame_end = 1, len(files)
sc.render.fps = 30
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1920, 1080, 100
if hasattr(sc.render.image_settings, 'media_type'):  # Blender 5.x splits image vs video output
    sc.render.image_settings.media_type = 'VIDEO'
sc.render.image_settings.file_format = 'FFMPEG'
sc.render.ffmpeg.format = 'MPEG4'
sc.render.ffmpeg.codec = 'H264'
sc.render.ffmpeg.constant_rate_factor = 'HIGH'
sc.render.ffmpeg.ffmpeg_preset = 'GOOD'
sc.render.filepath = OUT
bpy.ops.render.render(animation=True)
print('encoded', len(files), 'frames ->', OUT)
