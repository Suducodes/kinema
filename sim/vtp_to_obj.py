"""Convert ASCII VTK PolyData (.vtp) bone meshes to OBJ in OpenSim body coordinates."""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def read_array(piece, section, name):
    for arr in piece.find(section).iter('DataArray'):
        if arr.get('Name') == name or (name is None):
            if arr.get('format') != 'ascii':
                raise ValueError(f'{section}/{name} is not ascii')
            return [float(x) for x in arr.text.split()]
    raise KeyError(name)


def convert(src, dst):
    piece = ET.parse(src).getroot().find('PolyData/Piece')
    pts = read_array(piece, 'Points', None)
    polys = piece.find('Polys')
    conn = offs = None
    for arr in polys.iter('DataArray'):
        vals = [int(x) for x in arr.text.split()]
        if arr.get('Name') == 'connectivity':
            conn = vals
        elif arr.get('Name') == 'offsets':
            offs = vals
    lines = [f'v {pts[i]:.6f} {pts[i+1]:.6f} {pts[i+2]:.6f}' for i in range(0, len(pts), 3)]
    start = 0
    for end in offs:
        lines.append('f ' + ' '.join(str(k + 1) for k in conn[start:end]))
        start = end
    Path(dst).write_text('\n'.join(lines))
    return len(pts) // 3, len(offs)


if __name__ == '__main__':
    src_dir, dst_dir = Path(sys.argv[1]), Path(sys.argv[2])
    dst_dir.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[3:]:
        nv, nf = convert(src_dir / f'{name}.vtp', dst_dir / f'{name}.obj')
        print(f'{name}: {nv} verts, {nf} faces')
