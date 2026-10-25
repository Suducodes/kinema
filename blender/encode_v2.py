"""Edit + encode Twin Walkers v2 with subtle live data labels (Blender VSE, run with blender -b --factory-startup).

Outputs:
  renders/twin_walkers_v2.mp4       wide 8 s loop -> 4x slow-mo push-off split screen
  renders/twin_walkers_loop_v2.mp4  wide 8 s seamless loop only
Readouts come straight from the exported simulation frames (data/anim/*.json).
"""
import json
from pathlib import Path

import bpy

KIN = Path(r'C:\Users\Sudarshan\claude_code\kinema')
R = KIN / 'blender' / 'renders' / 'v2'
SLOWMO = {'healthy': (25, 91), 'weak': (14, 80)}  # Blender frames rendered for each ankle shot
TOE_OFF_INDEX = 42  # both slow-mo shots are cut so right toe-off lands on this output frame
WIDE_STEP = 4
TWINS = {'healthy': ('pf_1.00', 'HEALTHY', 'calf strength 100%', 0.235),
         'weak': ('pf_0.40', 'WEAK CALVES', 'calf strength 40%', 0.735)}

FONT_TITLE = bpy.data.fonts.load(r'C:\Windows\Fonts\bahnschrift.ttf')
FONT_DATA = bpy.data.fonts.load(r'C:\Windows\Fonts\consola.ttf')
WHITE = (0.95, 0.95, 0.94, 1.0)
DIM = (0.95, 0.95, 0.94, 0.82)
FAINT = (0.95, 0.95, 0.94, 0.5)

data = {k: json.loads((KIN / 'data' / 'anim' / f'{tag}.json').read_text())['frames']
        for k, (tag, *_rest) in TWINS.items()}


def strips(sc):
    se = sc.sequence_editor
    return se.strips if hasattr(se, 'strips') else se.sequences


def set_any(obj, names, value):
    for n in names:
        if hasattr(obj, n):
            try:
                setattr(obj, n, value)
                return
            except (TypeError, AttributeError):
                pass


def text(sc, body, channel, start, length, x, y, size, font, color, align='CENTER'):
    s = strips(sc)
    try:
        t = s.new_effect(name='txt', type='TEXT', channel=channel, frame_start=start, length=length)
    except TypeError:
        t = s.new_effect(name='txt', type='TEXT', channel=channel, frame_start=start, frame_end=start + length)
    t.text = body
    t.font_size = size
    t.font = font
    t.color = color
    t.location = (x, y)
    set_any(t, ('alignment_x', 'align_x'), align)
    set_any(t, ('anchor_x',), align)
    t.use_shadow = True
    set_any(t, ('shadow_color',), (0, 0, 0, 0.6))
    t.blend_type = 'ALPHA_OVER'
    return t


def images(sc, folder, channel, start, fit='SCALE_TO_FIT', offset_x=0):
    files = sorted(folder.glob('f_*.png'))
    im = strips(sc).new_image(name=folder.name, filepath=str(files[0]), channel=channel, frame_start=start)
    for f in files[1:]:
        im.elements.append(f.name)
    set_any(im, ('fit_method',), fit)
    im.transform.offset_x = offset_x
    return len(files)


def readout(fr):
    r = fr['readout']
    a = r['ankle_r_deg']
    ankle = f'{abs(a):4.1f}° {"DF" if a >= 0 else "PF"}'
    return (f'ankle {ankle}   soleus {100 * r["soleus_r_act"]:3.0f}%   '
            f'vasti {100 * r["vasti_r_act"]:3.0f}%   vGRF {r["grf_r_bw"]:4.2f} BW')


FOOTER = 'right leg  ·  DF/PF = dorsi/plantarflexion  ·  activation 0–100%  ·  vGRF in body weights'


def wide_block(sc, start):
    # All labels live in the dark band below the treadmills, clear of the anatomy.
    n = images(sc, R / 'wide', 1, start)
    for key, (_tag, title, sub, x) in TWINS.items():
        text(sc, f'{title}   ·   {sub}', 3 if key == 'healthy' else 4, start, n, x, 0.112, 24, FONT_TITLE, WHITE)
        for k in range(n):
            text(sc, readout(data[key][k * WIDE_STEP]), 6 if key == 'healthy' else 7,
                 start + k, 1, x, 0.068, 19, FONT_DATA, DIM)
    text(sc, FOOTER, 5, start, n, 0.5, 0.022, 15, FONT_DATA, FAINT)
    return n


def slowmo_block(sc, start):
    n = images(sc, R / 'ankle_healthy', 1, start, fit='ORIGINAL', offset_x=-482)
    images(sc, R / 'ankle_weak', 2, start, fit='ORIGINAL', offset_x=482)
    for key, x in (('healthy', 0.25), ('weak', 0.75)):
        _tag, title, sub, _x = TWINS[key]
        text(sc, f'{title}   ·   {sub}', 3 if key == 'healthy' else 4, start, n, x, 0.112, 22, FONT_TITLE, WHITE)
        lo = SLOWMO[key][0] - 1
        for k in range(n):
            text(sc, readout(data[key][lo + k]), 6 if key == 'healthy' else 7,
                 start + k, 1, x, 0.068, 17, FONT_DATA, DIM)
    text(sc, 'PUSH-OFF  ·  4× SLOW MOTION  ·  clips aligned at right toe-off', 5, start, n, 0.5, 0.022, 15,
         FONT_DATA, FAINT)
    marker = text(sc, '  TOE-OFF  ', 8, start + TOE_OFF_INDEX - 3, 18, 0.5, 0.165, 18, FONT_TITLE, (1, 1, 1, 0.9))
    set_any(marker, ('use_box',), True)
    set_any(marker, ('box_color',), (0.05, 0.05, 0.055, 1.0))
    return n


def encode(path, film):
    sc = bpy.context.scene
    if sc.sequence_editor:
        for s in list(strips(sc)):
            strips(sc).remove(s)
    sc.sequence_editor_create()
    n = wide_block(sc, 1)
    if film:
        n += slowmo_block(sc, n + 1)
    sc.frame_start, sc.frame_end = 1, n
    sc.render.fps = 30
    # Frames are already AgX-graded display images: pass them through untouched.
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0
    sc.view_settings.gamma = 1
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1920, 1080, 100
    if hasattr(sc.render.image_settings, 'media_type'):
        sc.render.image_settings.media_type = 'VIDEO'
    sc.render.image_settings.file_format = 'FFMPEG'
    sc.render.ffmpeg.format = 'MPEG4'
    sc.render.ffmpeg.codec = 'H264'
    sc.render.ffmpeg.constant_rate_factor = 'HIGH'
    sc.render.ffmpeg.ffmpeg_preset = 'GOOD'
    sc.render.filepath = str(path)
    bpy.ops.render.render(animation=True)
    print('encoded', n, 'frames ->', path)


encode(KIN / 'blender' / 'renders' / 'twin_walkers_loop_v2.mp4', film=False)
encode(KIN / 'blender' / 'renders' / 'twin_walkers_v2.mp4', film=True)
