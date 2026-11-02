"""Export the full-body twin for the live page (web/public/live/): bones, muscle routes, physics tables.

Source: the Lenhart 2015 full-body OpenSim model (opensim-jam, Apache-2.0), loaded through the
kinematics-only copy (knee/kin_models.py). It has complete standard bones on the LEFT leg and 44
3D muscles on the RIGHT leg only, so the twin uses the left-leg bones for both legs (mirrored for
the right) and the right-leg muscles for both legs (mirrored for the left).

Twin segments (each in its own OpenSim body frame, metres, y up):
  pelvis, torso, head, femur, patella, tibia (with fibula), foot (talus + calcn + toes),
  humerus, forearm (ulna + radius), hand; leg and arm segments exist as _R and _L.

Physics tables (right leg, mirrored at run time):
  muscle Fmax, optimal fibre length, tendon slack length, pennation, length at neutral;
  moment arms against hip_flex / hip_add / hip_rot / ankle_flex (OpenSim computeMomentArm) and against
  knee_flex from the solved passive flexion run (knee/runs/deepflex_healthy): in this model the
  quadriceps pull through a contact-guided patella, so their knee leverage only exists along that
  solved trajectory (r = -dL/dtheta with the hip held neutral).
"""
import json
import struct
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import numpy as np
import opensim as osim

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / 'knee' / 'vendor' / 'opensim-jam' / 'opensim-jam-release' / 'models' / 'lenhart2015'
GEO = MODELS / 'Geometry'
OUT = ROOT / 'web' / 'public' / 'live'
DEEPFLEX = ROOT / 'knee' / 'runs' / 'deepflex_healthy' / 'results'
DEG = np.pi / 180

GROUPS = {
    'Quadriceps': ['recfem', 'vaslat', 'vasmed', 'vasint'],
    'Hamstrings': ['bflh', 'bfsh', 'semimem', 'semiten'],
    'Gluteals': ['glmax1', 'glmax2', 'glmax3', 'glmed1', 'glmed2', 'glmed3', 'glmin1', 'glmin2', 'glmin3', 'tfl'],
    'Deep hip': ['piri', 'gem', 'quadfem'],
    'Adductors': ['addbrev', 'addlong', 'addmagProx', 'addmagMid', 'addmagDist', 'addmagIsch', 'grac', 'pect'],
    'Hip flexors': ['iliacus', 'psoas', 'sart'],
    'Calf': ['gaslat', 'gasmed', 'soleus', 'tibpost', 'fdl', 'fhl', 'perlong', 'perbrev'],
    'Shin': ['tibant', 'edl', 'ehl', 'pertert'],
}
PRETTY = {
    'recfem': 'Rectus femoris', 'vaslat': 'Vastus lateralis', 'vasmed': 'Vastus medialis', 'vasint': 'Vastus intermedius',
    'bflh': 'Biceps femoris (long)', 'bfsh': 'Biceps femoris (short)', 'semimem': 'Semimembranosus', 'semiten': 'Semitendinosus',
    'glmax1': 'Gluteus maximus (upper)', 'glmax2': 'Gluteus maximus (middle)', 'glmax3': 'Gluteus maximus (lower)',
    'glmed1': 'Gluteus medius (front)', 'glmed2': 'Gluteus medius (middle)', 'glmed3': 'Gluteus medius (back)',
    'glmin1': 'Gluteus minimus (front)', 'glmin2': 'Gluteus minimus (middle)', 'glmin3': 'Gluteus minimus (back)',
    'tfl': 'Tensor fasciae latae', 'piri': 'Piriformis', 'gem': 'Gemelli', 'quadfem': 'Quadratus femoris',
    'addbrev': 'Adductor brevis', 'addlong': 'Adductor longus', 'addmagProx': 'Adductor magnus (upper)',
    'addmagMid': 'Adductor magnus (middle)', 'addmagDist': 'Adductor magnus (lower)', 'addmagIsch': 'Adductor magnus (ischial)',
    'grac': 'Gracilis', 'pect': 'Pectineus', 'iliacus': 'Iliacus', 'psoas': 'Psoas', 'sart': 'Sartorius',
    'gaslat': 'Gastrocnemius (lateral)', 'gasmed': 'Gastrocnemius (medial)', 'soleus': 'Soleus', 'tibpost': 'Tibialis posterior',
    'fdl': 'Flexor digitorum longus', 'fhl': 'Flexor hallucis longus', 'perlong': 'Peroneus longus', 'perbrev': 'Peroneus brevis',
    'tibant': 'Tibialis anterior', 'edl': 'Extensor digitorum longus', 'ehl': 'Extensor hallucis longus', 'pertert': 'Peroneus tertius',
}


# ----------------------------------------------------------------------------- helpers
def mat(T):
    M = np.eye(4)
    R = T.R()
    M[:3, :3] = [[R.get(r, c) for c in range(3)] for r in range(3)]
    M[:3, 3] = T.p().to_numpy()
    return M


def apply(M, v):
    return (M @ np.append(v, 1.0))[:3]


def quat(R):
    w = np.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = np.copysign(np.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2, R[2, 1] - R[1, 2])
    y = np.copysign(np.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2, R[0, 2] - R[2, 0])
    z = np.copysign(np.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2, R[1, 0] - R[0, 1])
    return [x, y, z, w]


MIRROR = np.diag([1.0, 1.0, -1.0])


def read_vtp(path):
    piece = ET.parse(path).find('.//Piece')
    arr = lambda node: np.array(node.text.split(), float)
    P = arr(piece.find('Points/DataArray')).reshape(-1, 3)
    nn = piece.find("PointData/DataArray[@Name='Normals']")
    N = arr(nn).reshape(-1, 3) if nn is not None else None
    polys = piece.find('Polys')
    conn = arr(polys.find("DataArray[@Name='connectivity']")).astype(int)
    offs = arr(polys.find("DataArray[@Name='offsets']")).astype(int)
    tris, start = [], 0
    for o in offs:
        poly = conn[start:o]
        tris += [[poly[0], poly[k], poly[k + 1]] for k in range(1, len(poly) - 1)]
        start = o
    return P, N, np.array(tris, int)


def vertex_normals(P, T):
    N = np.zeros_like(P)
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    for k in range(3):
        np.add.at(N, T[:, k], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def write_glb(meshes, path):
    """Minimal glTF 2.0 binary: one node + mesh per entry (positions, normals, uint32 indices)."""
    bin_parts, views, accessors, gl_meshes, nodes = [], [], [], [], []
    offset = 0

    def add(data, target):
        nonlocal offset
        raw = data.tobytes()
        pad = (-len(raw)) % 4
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(raw), 'target': target})
        bin_parts.append(raw + b'\0' * pad)
        offset += len(raw) + pad
        return len(views) - 1

    for name, (P, N, T) in meshes.items():
        P = P.astype(np.float32); N = N.astype(np.float32); I = T.astype(np.uint32).ravel()
        vp, vn, vi = add(P, 34962), add(N, 34962), add(I, 34963)
        accessors += [
            {'bufferView': vp, 'componentType': 5126, 'count': len(P), 'type': 'VEC3', 'min': P.min(0).tolist(), 'max': P.max(0).tolist()},
            {'bufferView': vn, 'componentType': 5126, 'count': len(N), 'type': 'VEC3'},
            {'bufferView': vi, 'componentType': 5125, 'count': len(I), 'type': 'SCALAR'},
        ]
        a = len(accessors) - 3
        gl_meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': a, 'NORMAL': a + 1}, 'indices': a + 2}]})
        nodes.append({'name': name, 'mesh': len(gl_meshes) - 1})
    blob = b''.join(bin_parts)
    gltf = {'asset': {'version': '2.0', 'generator': 'kinema export_twin.py'}, 'scene': 0,
            'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': gl_meshes,
            'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}]}
    js = json.dumps(gltf).encode()
    js += b' ' * ((-len(js)) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(blob), 0x004E4942) + blob)


# ----------------------------------------------------------------------------- model
def load():
    m = osim.Model(str(MODELS / 'lenhart2015_kin.osim'))
    s = m.initSystem()
    return m, s


def body_M(m, s, name):
    return mat(m.getBodySet().get(name).getTransformInGround(s))


def rel(m, s, child, parent):
    """Transform of `child` body expressed in `parent` body frame (4x4)."""
    return np.linalg.inv(body_M(m, s, parent)) @ body_M(m, s, child)


def sto(path):
    lines = Path(path).read_text().splitlines()
    i = next(k for k, l in enumerate(lines) if l.strip() == 'endheader')
    return lines[i + 1].split('\t'), np.loadtxt(lines[i + 2:])


def apply_state_row(m, s, head, row, keep=lambda n: True):
    names = {m.getStateVariableNames().getitem(i) for i in range(m.getNumStateVariables())}
    for j, n in enumerate(head):
        if n in names and n.endswith('/value') and keep(n):
            m.setStateVariableValue(s, n, float(row[j]))
    m.realizePosition(s)


# ----------------------------------------------------------------------------- hands
# finger bones in tracking order: (mesh stem, piece index, MediaPipe hand landmark from -> to)
FINGERS = {
    'thumb': [('metacarpal1', 0, 1, 2), ('thumb_proximal', 1, 2, 3), ('thumb_distal', 2, 3, 4)],
    'index': [('index_proximal', 0, 5, 6), ('index_medial', 1, 6, 7), ('index_distal', 2, 7, 8)],
    'middle': [('middle_proximal', 0, 9, 10), ('middle_medial', 1, 10, 11), ('middle_distal', 2, 11, 12)],
    'ring': [('ring_proximal', 0, 13, 14), ('ring_medial', 1, 14, 15), ('ring_distal', 2, 15, 16)],
    'little': [('little_proximal', 0, 17, 18), ('little_medial', 1, 18, 19), ('little_distal', 2, 19, 20)],
}
PIECE = 'pmd'   # proximal (the thumb's metacarpal), middle, distal


def rotation_about(M0, M1):
    """Axis (unit), angle and a point on the axis of the rigid motion M1 @ inv(M0)."""
    D = M1 @ np.linalg.inv(M0)
    R, t = D[:3, :3], D[:3, 3]
    ang = np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))
    ax = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * np.sin(ang))
    p = np.linalg.lstsq(np.eye(3) - R, t, rcond=None)[0]   # a point the motion leaves on the axis
    return ax, ang, p


def hand_parts(m, s, sl, meshes):
    """Hand body split into the rigid palm (carpals, metacarpals 2-5) and 15 aimable finger pieces.

    Each piece's mesh is stored relative to its proximal joint centre, in the hand frame's orientation;
    its rest direction (proximal -> distal joint) is exported for aiming at run time."""
    by_file = {}
    for f, Mfb, scale in meshes:
        P, N, T = read_vtp(GEO / f)
        P = P * scale
        P = (Mfb[:3, :3] @ P.T).T + Mfb[:3, 3]
        by_file[f.replace('_lvs.vtp', '').replace('_rvs.vtp', '').replace('.vtp', '')] = (P, vertex_normals(P, T), T)
    finger_files = {stem for chain in FINGERS.values() for stem, *_ in chain}
    n, Ps, Ns, Ts = 0, [], [], []
    for k, (P, N, T) in by_file.items():
        if k in finger_files:
            continue
        Ps.append(P); Ns.append(N); Ts.append(T + n); n += len(P)
    out = {'hand': (np.vstack(Ps), np.vstack(Ns), np.vstack(Ts))}
    pieces, chains = {}, {}
    for finger, chain in FINGERS.items():
        chains[finger] = []
        for stem, k, a, b in chain:
            P, N, T = by_file[stem]
            c = P.mean(0)
            vt = np.linalg.svd(P - c, full_matrices=False)[2]
            ax = vt[0] if np.dot(vt[0], c) > 0 else -vt[0]   # pointing away from the wrist (hand origin)
            proj = (P - c) @ ax
            L = proj.max() - proj.min()
            near = lambda end: P[np.abs(proj - end) < 0.12 * L].mean(0)
            o, tip = near(proj.min()), near(proj.max())
            name = f'{finger}_{PIECE[k]}'
            pieces[name] = {'origin': np.round(o, 5).tolist(), 'tip': np.round(tip, 5).tolist(), 'from': a, 'to': b}
            chains[finger].append(name)
            out[name] = (P - o, N, T)
    # hand frame features: wrist at the origin, knuckles, and the palmar side (where the resting fingers curl)
    mcp = {f: np.array(pieces[f'{f}_p']['origin']) for f in ('index', 'middle', 'little')}
    tips = np.mean([pieces[f'{f}_d']['tip'] for f in ('index', 'middle', 'ring', 'little')], axis=0)
    long_ax = mcp['middle'] / np.linalg.norm(mcp['middle'])
    lat = mcp['index'] - mcp['little']
    lat = lat - long_ax * np.dot(lat, long_ax)
    lat /= np.linalg.norm(lat)
    palmar = np.cross(long_ax, lat)
    curl = tips - long_ax * np.dot(tips, long_ax)
    if np.dot(palmar, curl) < 0:
        palmar = -palmar
    # forearm: the radius in the ulna frame and its roll axis (pronation/supination); the hand on the radius
    cs = m.getCoordinateSet().get(f'pro_sup_{sl}')
    q0 = cs.getValue(s)
    cs.setValue(s, 0.0, True); M0 = rel(m, s, f'radius_{sl}', f'ulna_{sl}')
    palm0 = rel(m, s, f'hand_{sl}', f'ulna_{sl}')[:3, :3] @ palmar
    cs.setValue(s, 0.5, True); M1 = rel(m, s, f'radius_{sl}', f'ulna_{sl}')
    ax, ang, piv = rotation_about(M0, M1)
    if ang < 0.4:
        raise RuntimeError('radioulnar axis estimate failed')
    cs.setValue(s, q0, True)
    M_hand_rad = rel(m, s, f'hand_{sl}', f'radius_{sl}')
    print(f'  {sl}: pro_sup axis {np.round(ax, 3)} (turn {ang:.3f} rad for 0.5), default {q0:.3f}, palm at 0 (ulna frame) {np.round(palm0, 2)}')
    info = {
        'radius0': {'pos': np.round(M0[:3, 3], 5).tolist(), 'quat': np.round(quat(M0[:3, :3]), 6).tolist()},
        'prosup': {'axis': np.round(ax, 5).tolist(), 'pivot': np.round(piv, 5).tolist(), 'default': round(q0, 5),
                   'range': [0, round(cs.getRangeMax(), 5)], 'palm_at_0': np.round(palm0, 4).tolist()},
        'hand_in_radius': {'pos': np.round(M_hand_rad[:3, 3], 5).tolist(), 'quat': np.round(quat(M_hand_rad[:3, :3]), 6).tolist()},
        'knuckles': {k: np.round(v, 5).tolist() for k, v in mcp.items()},
        'palmar': np.round(palmar, 4).tolist(),
        'pieces': pieces, 'chains': chains,
    }
    return info, out


# ----------------------------------------------------------------------------- export
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    m, s = load()
    src = next(DEEPFLEX.glob('*_states.sto'), None)
    if src is None:   # the 0-130 deg run is not done yet: fall back to the 0-90 deg one (knee arms held past 90)
        src = next((ROOT / 'knee' / 'runs' / 'flexion_healthy' / 'results').glob('*_states.sto'))
        print('NOTE: using', src.parent.parent.name, '(0-90 deg) for the knee moment arms')
    deep_h, deep = sto(src)
    knee0 = deep[0]
    # neutral pose: every coordinate at its default except the right knee and patella, taken from the
    # solved passive-flexion run at its first (straight-knee) frame
    apply_state_row(m, s, deep_h, knee0, keep=lambda n: '/knee_r/' in n or '/pf_r/' in n)

    # ---- meshes per Lenhart body, in that body's frame
    by_body = defaultdict(list)
    for c in m.getComponentsList():
        if c.getConcreteClassName() != 'Mesh':
            continue
        g = osim.Mesh.safeDownCast(c)
        f = g.get_mesh_file()
        if not f.endswith('.vtp'):
            continue   # the MRI knee STLs cover only the knee region; the twin uses complete standard bones
        frame = g.getFrame()
        body = frame.findBaseFrame().getName()
        Mfb = mat(frame.findTransformInBaseFrame())
        scale = np.array(osim.Vec3(g.get_scale_factors()).to_numpy())
        by_body[body].append((f, Mfb, scale))

    def body_mesh(body, extra=np.eye(4)):
        """All meshes of a Lenhart body, moved by `extra` (body frame -> twin segment frame)."""
        Ps, Ns, Ts, n = [], [], [], 0
        for f, Mfb, scale in by_body[body]:
            P, N, T = read_vtp(GEO / f)
            P = P * scale
            M = extra @ Mfb
            P = (M[:3, :3] @ P.T).T + M[:3, 3]
            Ns.append(vertex_normals(P, T))
            Ps.append(P); Ts.append(T + n); n += len(P)
        return np.vstack(Ps), np.vstack(Ns), np.vstack(Ts)

    def mirrored(mesh):
        P, N, T = mesh
        return P @ MIRROR, N @ MIRROR, T[:, ::-1].copy()

    seg_mesh = {}
    seg_mesh['pelvis'] = body_mesh('pelvis')
    seg_mesh['torso'] = body_mesh('torso')
    seg_mesh['head'] = body_mesh('neckhead')
    # legs: standard LEFT bones, mirrored to make the right leg (left frames are mirror images of right ones)
    leg = {
        'femur': body_mesh('femur_l'),
        'tibia': body_mesh('tibia_l'),
        'patella': body_mesh('patella_l'),
    }
    M_talus_in_calcn = rel(m, s, 'talus_l', 'calcn_l')
    M_toes_in_calcn = rel(m, s, 'toes_l', 'calcn_l')
    foot = [body_mesh('calcn_l'), body_mesh('talus_l', M_talus_in_calcn), body_mesh('toes_l', M_toes_in_calcn)]
    leg['foot'] = (np.vstack([f[0] for f in foot]), np.vstack([f[1] for f in foot]),
                   np.vstack([foot[0][2], foot[1][2] + len(foot[0][0]), foot[2][2] + len(foot[0][0]) + len(foot[1][0])]))
    for k, v in leg.items():
        seg_mesh[f'{k}_L'] = v
        seg_mesh[f'{k}_R'] = mirrored(v)
    # arms: ulna (forearm), radius (rolls about the radioulnar axis) and the hand, whose finger bones are
    # separate pieces so they can be aimed from tracked hand points
    arm = {}
    for side, sl in (('R', 'r'), ('L', 'l')):
        seg_mesh[f'humerus_{side}'] = body_mesh(f'humerus_{sl}')
        seg_mesh[f'forearm_{side}'] = body_mesh(f'ulna_{sl}')
        seg_mesh[f'radius_{side}'] = body_mesh(f'radius_{sl}')
        arm[side], pieces = hand_parts(m, s, sl, by_body[f'hand_{sl}'])
        for k, v in pieces.items():
            seg_mesh[f'{k}_{side}'] = v
    write_glb(seg_mesh, OUT / 'twin.glb')

    # ---- landmark reference points in each twin segment frame (the browser aligns segments to these)
    def origin_in(child, parent):
        return rel(m, s, child, parent)[:3, 3]

    foot_P = leg['foot'][0]
    low = foot_P[:, 1] < foot_P[:, 1].min() + 0.02
    heel = foot_P[low][np.argmin(foot_P[low][:, 0])]
    toe = foot_P[np.argmax(foot_P[:, 0])]
    skull = body_mesh('neckhead')[0]
    hand_P = np.vstack([seg_mesh['hand_L'][0]] + [seg_mesh[f'{f}_d_L'][0] + np.array(arm['L']['pieces'][f'{f}_d']['origin'])
                        for f in ('index', 'middle', 'little')])
    ref_L = {
        'pelvis': {'hipR': origin_in('femur_r', 'pelvis'), 'hipL': origin_in('femur_l', 'pelvis'),
                   'lumbar': origin_in('torso', 'pelvis')},
        'torso': {'shoulderR': origin_in('humerus_r', 'torso'), 'shoulderL': origin_in('humerus_l', 'torso'),
                  'neck': origin_in('neckhead', 'torso')},
        'head': {'center': (skull.min(0) + skull.max(0)) / 2, 'top': np.array([0, skull[:, 1].max(), 0])},
        'femur': {'knee': origin_in('tibia_l', 'femur_l')},
        'tibia': {'ankle': origin_in('talus_l', 'tibia_l')},
        'foot': {'ankle': M_talus_in_calcn[:3, 3], 'heel': heel, 'toe': toe},
        'humerus': {'elbow': origin_in('ulna_l', 'humerus_l')},
        'forearm': {'wrist': rel(m, s, 'hand_l', 'ulna_l')[:3, 3]},
        'hand': {'tip': hand_P[np.argmin(hand_P[:, 1])]},
    }
    refs = {k: {kk: np.round(vv, 5).tolist() for kk, vv in v.items()} for k, v in ref_L.items()}

    # ---- patella pose in the femur frame against knee flexion (left coupler, mirrored at run time)
    knee_grid = np.arange(0, 131, 5.0)
    patella = []
    for q in knee_grid:
        m.getCoordinateSet().get('knee_flex_l').setValue(s, -q * DEG if m.getCoordinateSet().get('knee_flex_l').getRangeMax() <= 0.01 else q * DEG, True)
        m.realizePosition(s)
        M = rel(m, s, 'patella_l', 'femur_l')
        patella.append([*np.round(M[:3, 3], 5).tolist(), *np.round(quat(M[:3, :3]), 6).tolist()])
    m.getCoordinateSet().get('knee_flex_l').setValue(s, 0, True)

    # ---- muscle routes at the neutral pose, each point fixed in a twin segment (right side)
    apply_state_row(m, s, deep_h, knee0, keep=lambda n: '/knee_r/' in n or '/pf_r/' in n)
    M_patR_in_femR = rel(m, s, 'patella_r', 'femur_r')
    # the twin's right patella is the mirrored left patella at knee 0: re-anchor patella_r points onto it
    M_twinpat_in_fem = np.eye(4)
    p0 = patella[0]
    from_q = lambda q: np.array([[1 - 2 * (q[1] ** 2 + q[2] ** 2), 2 * (q[0] * q[1] - q[2] * q[3]), 2 * (q[0] * q[2] + q[1] * q[3])],
                                 [2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[0] ** 2 + q[2] ** 2), 2 * (q[1] * q[2] - q[0] * q[3])],
                                 [2 * (q[0] * q[2] - q[1] * q[3]), 2 * (q[1] * q[2] + q[0] * q[3]), 1 - 2 * (q[0] ** 2 + q[1] ** 2)]])
    M_twinpat_in_fem[:3, :3] = MIRROR @ from_q(p0[3:]) @ MIRROR
    M_twinpat_in_fem[:3, 3] = MIRROR @ np.array(p0[:3])
    body_map = {
        'pelvis': ('pelvis', np.eye(4)),
        'femur_r': ('femur', np.eye(4)),
        'femur_distal_r': ('femur', rel(m, s, 'femur_distal_r', 'femur_r')),
        'patella_r': ('patella', np.linalg.inv(M_twinpat_in_fem) @ M_patR_in_femR),
        'tibia_r': ('tibia', np.eye(4)),
        'tibia_proximal_r': ('tibia', rel(m, s, 'tibia_proximal_r', 'tibia_r')),
        'talus_r': ('foot', rel(m, s, 'talus_r', 'calcn_r')),
        'calcn_r': ('foot', np.eye(4)),
        'toes_r': ('foot', rel(m, s, 'toes_r', 'calcn_r')),
    }
    muscles = [osim.Millard2012EquilibriumMuscle.safeDownCast(c) for c in m.getComponentsList()
               if c.getConcreteClassName() == 'Millard2012EquilibriumMuscle']
    routes, params = {}, {}
    for mu in muscles:
        name = mu.getName()[:-2]
        path = mu.getGeometryPath().getCurrentPath(s)
        pts = []
        for k in range(path.getSize()):
            pp = path.get(k)
            body = pp.getParentFrame().findBaseFrame().getName()
            seg, M = body_map[body]
            loc = apply(mat(pp.getParentFrame().findTransformInBaseFrame()), pp.getLocation(s).to_numpy())
            pts.append([seg, *np.round(apply(M, loc), 5).tolist()])
        routes[name] = pts
        params[name] = {'fmax': round(mu.getMaxIsometricForce(), 1), 'lopt': round(mu.getOptimalFiberLength(), 5),
                        'lts': round(mu.getTendonSlackLength(), 5),
                        'penn': round(mu.getPennationAngleAtOptimalFiberLength(), 4),
                        'L0': round(mu.getGeometryPath().getLength(s), 5), 'pretty': PRETTY.get(name, name)}

    # ---- moment arms: hip and ankle by OpenSim, knee along the solved flexion trajectory
    grids = {'hip_flex': np.arange(-30, 121, 5.0), 'hip_add': np.arange(-40, 41, 5.0),
             'hip_rot': np.arange(-40, 41, 5.0), 'ankle_flex': np.arange(-40, 41, 5.0)}
    arms = {name: {} for name in params}
    for key, grid in grids.items():
        coord = m.getCoordinateSet().get(f'{key}_r')
        for name in params:
            arms[name][key] = []
        for q in grid:
            apply_state_row(m, s, deep_h, knee0, keep=lambda n: '/knee_r/' in n or '/pf_r/' in n)
            coord.setValue(s, q * DEG, False)
            m.realizePosition(s)
            for mu in muscles:
                arms[mu.getName()[:-2]][key].append(round(mu.getGeometryPath().computeMomentArm(s, coord), 5))
        coord.setValue(s, 0, False)
    # knee: lengths along the solved passive flexion (hip coordinates forced neutral)
    kcol = deep_h.index(next(n for n in deep_h if n.endswith('/knee_flex_r/value')))
    flex = np.degrees(deep[:, kcol])
    order = np.argsort(flex)
    L = {name: [] for name in params}
    hip_zero = lambda n: '/knee_r/' in n or '/pf_r/' in n
    for row in deep:
        apply_state_row(m, s, deep_h, row, keep=hip_zero)
        for mu in muscles:
            L[mu.getName()[:-2]].append(mu.getGeometryPath().getLength(s))
    for name in params:
        f, l = flex[order], np.array(L[name])[order]
        keep = np.concatenate([[True], np.diff(f) > 0.05])
        f, l = f[keep], l[keep]
        fg = knee_grid[knee_grid <= f.max()]
        lg = np.interp(fg, f, l)
        r = -np.gradient(lg, fg * DEG)
        r = np.convolve(np.pad(r, 2, mode='edge'), np.ones(5) / 5, mode='valid')   # light smoothing
        r = np.concatenate([r, np.full(len(knee_grid) - len(r), r[-1])])          # hold the last value past the run
        arms[name]['knee_flex'] = np.round(r, 5).tolist()
    grids['knee_flex'] = knee_grid

    # ---- joint axes (right side, in the parent segment frame) and segment inertia
    def axis(joint, k, frame_body):
        j = osim.CustomJoint.safeDownCast(m.getJointSet().get(joint))
        st = j.getSpatialTransform()
        a = np.array(st.getTransformAxis(k).getAxis().to_numpy())
        Mp = mat(j.getParentFrame().findTransformInBaseFrame())
        Mp = rel(m, s, j.getParentFrame().findBaseFrame().getName(), frame_body) @ Mp
        return np.round(Mp[:3, :3] @ a, 5).tolist()
    axes = {'hip': [axis('hip_r', k, 'pelvis') for k in range(3)],
            'knee': axis('knee_r', 0, 'femur_r'), 'ankle': axis('ankle_r', 0, 'tibia_r')}

    def inertia(bodies, frame_body):
        mass, com, I = 0.0, np.zeros(3), np.zeros((3, 3))
        parts = []
        for b in bodies:
            B = m.getBodySet().get(b)
            Mb = rel(m, s, b, frame_body)
            c = apply(Mb, B.get_mass_center().to_numpy())
            v6 = B.get_inertia()
            Iv = [v6.get(i) for i in range(6)]
            Ib = np.array([[Iv[0], Iv[3], Iv[4]], [Iv[3], Iv[1], Iv[5]], [Iv[4], Iv[5], Iv[2]]])
            parts.append((B.getMass(), c, Mb[:3, :3] @ Ib @ Mb[:3, :3].T))
            mass += B.getMass(); com += B.getMass() * c
        com /= mass
        for mb, c, Ib in parts:
            d = c - com
            I += Ib + mb * (np.dot(d, d) * np.eye(3) - np.outer(d, d))
        return {'mass': round(mass, 4), 'com': np.round(com, 5).tolist(), 'I': np.round(I, 6).tolist()}
    segs = {
        'pelvis': inertia(['pelvis'], 'pelvis'), 'torso': inertia(['torso'], 'torso'), 'head': inertia(['neckhead'], 'neckhead'),
        'femur': inertia(['femur_r', 'femur_distal_r'], 'femur_r'),
        'tibia': inertia(['tibia_r', 'tibia_proximal_r', 'patella_r'], 'tibia_r'),
        'foot': inertia(['talus_r', 'calcn_r', 'toes_r'], 'calcn_r'),
        'humerus': inertia(['humerus_r'], 'humerus_r'), 'forearm': inertia(['ulna_r', 'radius_r'], 'ulna_r'), 'hand': inertia(['hand_r'], 'hand_r'),
    }
    model_mass = sum(v['mass'] * (2 if k in ('femur', 'tibia', 'foot', 'humerus', 'forearm', 'hand') else 1) for k, v in segs.items())

    meta = {
        'source': 'Lenhart et al. 2015 full-body OpenSim model (opensim-jam, Apache-2.0)',
        'model_mass': round(model_mass, 2),
        'refs': refs, 'segments': segs, 'axes': axes,
        'patella': {'knee': knee_grid.tolist(), 'pose': patella},
        'arm': arm,
        'muscles': {'names': list(params), 'params': params, 'routes': routes, 'groups': GROUPS},
        'arms': {'grids': {k: v.tolist() for k, v in grids.items()}, 'r': arms},
    }
    (OUT / 'twin.json').write_text(json.dumps(meta))
    tris = sum(len(v[2]) for v in seg_mesh.values())
    print(f'twin.glb: {len(seg_mesh)} segments, {tris} triangles, {(OUT / "twin.glb").stat().st_size / 1e6:.2f} MB')
    print(f'twin.json: {len(params)} muscles, {(OUT / "twin.json").stat().st_size / 1e6:.2f} MB, model mass {model_mass:.1f} kg')
    for n in ('vaslat', 'recfem', 'semiten', 'gasmed', 'soleus', 'tibant', 'glmax2', 'iliacus'):
        a = arms[n]
        print(f'  {n:8s} knee@0/60/110 {a["knee_flex"][0]:+.3f} {a["knee_flex"][12]:+.3f} {a["knee_flex"][22]:+.3f}'
              f' | hip_flex@0 {a["hip_flex"][6]:+.3f} | ankle@0 {a["ankle_flex"][8]:+.3f}')


if __name__ == '__main__':
    main()
