"""Kinematics-only copies of the knee models for OpenSim 4.6 (no JAM plugin).

The JAM cartilage contact classes (Smith2018*) are not in core OpenSim 4.6. Contact is only needed to
*solve* the motion (done by forsim); placing bones and ligament paths from the solved states only
needs the joints, bodies, ligaments and wrap surfaces, so the contact elements are stripped.
"""
import re
from pathlib import Path

MODELS = Path(__file__).resolve().parent / 'vendor' / 'opensim-jam' / 'opensim-jam-release' / 'models' / 'lenhart2015'


def strip(src: Path, dst: Path):
    xml = src.read_text()
    n = 0
    for cls in ('Smith2018ArticularContactForce', 'Smith2018ContactMesh'):
        xml, k = re.subn(rf'\s*<{cls} name="[^"]*">.*?</{cls}>', '', xml, flags=re.S)
        n += k
    dst.write_text(xml)
    return n


if __name__ == '__main__':
    for name in ('lenhart2015', 'lenhart2015_injured'):
        print(name, 'stripped', strip(MODELS / f'{name}.osim', MODELS / f'{name}_kin.osim'), 'contact elements')
