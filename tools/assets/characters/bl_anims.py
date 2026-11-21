"""Blender step 2: bake every canonical clip onto the shared Biped rig of one gender.

usage: blender -b --python bl_anims.py -- <config.json>
config: {"gender", "skeleton": skeleton_<g>.json, "out": ".../anims_raw/<g>.gltf",
         "info": ".../anims_raw/<g>.json", "clips": [clip spec...]}
clip spec: {"name", "kind": "rb"|"m2m", "file", "mode", "loop", ...}
  rb modes:  "static"  in place already (root kept as authored)
             "walk"    remove the average horizontal travel (feet stay planted when the
                       client moves the character at `speed` m/s), loop-clean
             "inplace" remove the extracted root motion frame by frame (xy + yaw)
             "root"    keep root motion, relative to the clip's start ground frame
  m2m: retargeted from the Mesh2Motion skeleton (see retarget_m2m)

Rotations are transferred in world space bone by bone, so every bone of the rig ends
up with exactly the source orientation; only the root (Bip01) keeps a translation.
"""
import math
import os
import sys

sys.dont_write_bytecode = True  # keep tools/ free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Matrix, Quaternion, Vector  # noqa: E402
import bl_common as C  # noqa: E402

FPS = 30
cfg = C.read_json(C.args()[0])
C.reset()
sk = C.skeleton_from_json(C.read_json(cfg['skeleton']))
ORDER = sk['order']
PARENT = sk['parent']
REST_Q = {n: sk['rest'][n].to_quaternion() for n in ORDER}
REST_ROOT = sk['rest'][C.ROOT]
rig = C.build_rig(sk)
# canonical ground frame of the rig: at the origin, facing -Y (Biped root yaw)
CANON = Matrix.Rotation(-math.pi / 2, 4, 'Z')
FACE_BONES = {n for n in ORDER if n.startswith('Bip01 ') and n.split(' ', 1)[1] in (
    'REye LEye MJaw MBottomLip MTongue LMouthBottom RMouthBottom RMasseter LMasseter MUpperLip '
    'RCaninus LCaninus REyeBlinkBottom LEyeBlinkBottom RUpperlip LUpperlip RMouthCorner LMouthCorner '
    'RCheek LCheek REyeBlinkTop LEyeBlinkTop RInnerEyebrow LInnerEyebrow MMiddleEyebrow ROuterEyebrow '
    'LOuterEyebrow MNose').split()}
BODY_BONES = [n for n in ORDER if n not in FACE_BONES]


def yaw_frame(m):
    """Ground frame (xy translation + yaw only) of a world matrix."""
    loc = m.to_translation()
    fwd = m.to_3x3() @ Vector((1, 0, 0))
    yaw = math.atan2(fwd.y, fwd.x)
    return Matrix.Translation((loc.x, loc.y, 0)) @ Matrix.Rotation(yaw, 4, 'Z')


# ---------------------------------------------------------------- sampling
def sample_rb(path):
    arm, _meshes, new = C.import_fbx(path)
    helper = next((o for o in new if o.name.startswith('MotionExtractionHelper')), None)
    act = arm.animation_data.action
    f0, f1 = int(round(act.frame_range[0])), int(round(act.frame_range[1]))
    sc = bpy.context.scene
    frames, max_scale = [], 0.0
    # diagnostics: does the clip skeleton have the avatar's bone offsets?
    off_err = 0.0
    for n in ORDER[2:]:
        b = arm.data.bones.get(n)
        if b is None:
            raise RuntimeError(f'{path}: bone {n} missing')
        p = PARENT[n]
        if p == C.ROOT:
            continue
        a_len = (arm.data.bones[p].head_local - b.head_local).length * 0.01
        r_len = (sk['rest'][p].to_translation() - sk['rest'][n].to_translation()).length
        if n not in FACE_BONES:
            off_err = max(off_err, abs(a_len - r_len))
    for f in range(f0, f1 + 1):
        sc.frame_set(f)
        mw = arm.matrix_world.copy()
        root = C.norm_mat(mw)
        rot = {}
        for n in ORDER[1:]:
            loc, q, s = (mw @ arm.pose.bones[n].matrix).decompose()
            max_scale = max(max_scale, abs(s.x * 100 - 1), abs(s.y * 100 - 1), abs(s.z * 100 - 1))
            rot[n] = q
        rot[C.ROOT] = root.to_quaternion()
        frames.append({'root': root, 'rot': rot,
                       'ground': yaw_frame(helper.matrix_world) if helper else CANON.copy()})
    C.remove_objects(new)
    for a in list(bpy.data.actions):
        if a.users == 0 or a.name.startswith(('Bip01', 'MotionExtraction', 'ExposeTransform')):
            bpy.data.actions.remove(a)
    C.purge()
    return frames, {'boneOffsetErr': round(off_err, 4), 'poseScaleErr': round(max_scale, 4)}


def transform_frames(frames, per_frame):
    """Apply a world transform (one per frame) to the root; bones follow."""
    out = []
    for fr, T in zip(frames, per_frame):
        tq = T.to_quaternion()
        rot = {n: tq @ q for n, q in fr['rot'].items()}
        out.append({'root': T @ fr['root'], 'rot': rot, 'ground': T @ fr['ground']})
    return out


# ---------------------------------------------------------------- world -> rig basis
def to_basis(frames):
    rinv = REST_ROOT.inverted()
    Q = {n: [] for n in ORDER}
    L = []
    for fr in frames:
        loc, q, _ = (rinv @ fr['root']).decompose()
        L.append(loc)
        Q[C.ROOT].append(q)
        w = fr['rot']
        for n in ORDER[1:]:
            p = PARENT[n]
            Q[n].append(REST_Q[n].inverted() @ REST_Q[p] @ w[p].inverted() @ w[n])
    for n in ORDER:
        seq = Q[n]
        for i in range(len(seq)):
            seq[i].normalize()
            if i and seq[i].dot(seq[i - 1]) < 0:
                seq[i].negate()
    return Q, L


def loop_mismatch(Q, L):
    ang = max(Q[n][0].rotation_difference(Q[n][-1]).angle for n in BODY_BONES)
    steps = sorted(max(Q[n][i].rotation_difference(Q[n][i + 1]).angle for n in BODY_BONES)
                   for i in range(len(L) - 1))
    return math.degrees(ang), (L[0] - L[-1]).length, math.degrees(steps[len(steps) // 2])


def make_loop(Q, L, max_drift_deg=5.0, max_drift_m=0.03, xfade_s=1.0):
    """Make the clip loop seamlessly; returns (Q, L, method)."""
    ang, dist, step = loop_mismatch(Q, L)
    n = len(L)
    if ang <= max_drift_deg and dist <= max_drift_m:
        # spread the small end->start mismatch over the whole clip; last key == first key
        for b in ORDER:
            d = Q[b][0] @ Q[b][-1].inverted()
            for i in range(n):
                w = i / (n - 1)
                Q[b][i] = Quaternion().slerp(d, w) @ Q[b][i]
        d = L[0] - L[-1]
        for i in range(n):
            L[i] = L[i] + d * (i / (n - 1))
        return Q, L, f'drift-spread ({ang:.1f} deg, {dist * 100:.1f} cm)'
    # cross-fade the tail into the head: out[i] = mix(src[n-k+i], src[i]) for i < k
    k = min(int(xfade_s * FPS), n // 3)
    m = n - k
    for b in ORDER:
        src = Q[b]
        out = []
        for i in range(m):
            if i < k:
                t = i / k
                w = t * t * (3 - 2 * t)
                a, c = src[m + i], src[i]
                if a.dot(c) < 0:
                    c = -c
                out.append(a.slerp(c, w))
            else:
                out.append(src[i].copy())
        out.append(out[0].copy())
        Q[b] = out
    srcL = L
    outL = []
    for i in range(m):
        if i < k:
            t = i / k
            w = t * t * (3 - 2 * t)
            outL.append(srcL[m + i].lerp(srcL[i], w))
        else:
            outL.append(srcL[i].copy())
    outL.append(outL[0].copy())
    for b in ORDER:
        for i in range(1, len(Q[b])):
            if Q[b][i].dot(Q[b][i - 1]) < 0:
                Q[b][i].negate()
    return Q, outL, f'cross-fade {k} frames ({ang:.1f} deg, {dist * 100:.1f} cm apart)'


# ---------------------------------------------------------------- actions
def write_action(name, Q, L):
    ad = rig.animation_data or rig.animation_data_create()
    act = bpy.data.actions.new(name)
    ad.action = act
    n = len(L)
    for b in ORDER:
        path = f'pose.bones["{b}"].rotation_quaternion'
        for i in range(4):
            fc = act.fcurve_ensure_for_datablock(rig, path, index=i, group_name=b)
            fc.keyframe_points.add(n)
            co = [0.0] * (2 * n)
            for f in range(n):
                co[2 * f] = float(f)
                co[2 * f + 1] = Q[b][f][i]
            fc.keyframe_points.foreach_set('co', co)
            fc.update()
    path = f'pose.bones["{C.ROOT}"].location'
    for i in range(3):
        fc = act.fcurve_ensure_for_datablock(rig, path, index=i, group_name=C.ROOT)
        fc.keyframe_points.add(n)
        co = [0.0] * (2 * n)
        for f in range(n):
            co[2 * f] = float(f)
            co[2 * f + 1] = L[f][i]
        fc.keyframe_points.foreach_set('co', co)
        fc.update()
    track = ad.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act)
    ad.action = None


def to_gltf(v):
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def yaw_deg(m):
    fwd = m.to_3x3() @ Vector((1, 0, 0))
    return math.degrees(math.atan2(fwd.y, fwd.x))


def root_world(Q, L, i):
    B = Matrix.Translation(L[i]) @ Q[C.ROOT][i].to_matrix().to_4x4()
    return REST_ROOT @ B


# ---------------------------------------------------------------- Mesh2Motion retarget
M2M_MAP = {
    'pelvis': 'Bip01 Pelvis', 'spine_01': 'Bip01 Spine', 'spine_02': 'Bip01 Spine1',
    'spine_03': 'Bip01 Spine2', 'neck_01': 'Bip01 Neck', 'head': 'Bip01 Head',
}
for s, side in (('l', 'L'), ('r', 'R')):
    M2M_MAP.update({
        f'clavicle_{s}': f'Bip01 {side} Clavicle', f'upperarm_{s}': f'Bip01 {side} UpperArm',
        f'lowerarm_{s}': f'Bip01 {side} Forearm', f'hand_{s}': f'Bip01 {side} Hand',
        f'thigh_{s}': f'Bip01 {side} Thigh', f'calf_{s}': f'Bip01 {side} Calf',
        f'foot_{s}': f'Bip01 {side} Foot', f'ball_{s}': f'Bip01 {side} Toe0',
    })
    for fi, fn in enumerate(('thumb', 'index', 'middle', 'ring', 'pinky')):
        for j in range(3):
            M2M_MAP[f'{fn}_0{j + 1}_{s}'] = f'Bip01 {side} Finger{fi}' + ('' if j == 0 else str(j))
BIP2M2M = {v: k for k, v in M2M_MAP.items()}
# the child that defines each bone's direction (rig side / m2m side)
M2M_CHILD = {
    'pelvis': 'spine_01', 'spine_01': 'spine_02', 'spine_02': 'spine_03', 'spine_03': 'neck_01',
    'neck_01': 'head', 'head': 'head_leaf',
}
for s in ('l', 'r'):
    M2M_CHILD.update({f'clavicle_{s}': f'upperarm_{s}', f'upperarm_{s}': f'lowerarm_{s}',
                      f'lowerarm_{s}': f'hand_{s}', f'hand_{s}': f'middle_01_{s}',
                      f'thigh_{s}': f'calf_{s}', f'calf_{s}': f'foot_{s}', f'foot_{s}': f'ball_{s}',
                      f'ball_{s}': f'ball_leaf_{s}'})
    for fn in ('thumb', 'index', 'middle', 'ring', 'pinky'):
        M2M_CHILD[f'{fn}_01_{s}'] = f'{fn}_02_{s}'
        M2M_CHILD[f'{fn}_02_{s}'] = f'{fn}_03_{s}'
        M2M_CHILD[f'{fn}_03_{s}'] = f'{fn}_04_leaf_{s}'


def rig_child(n):
    """Direction child of a rig bone (via the m2m mapping); None for tips."""
    m = BIP2M2M[n]
    c = M2M_CHILD.get(m)
    while c and c not in M2M_MAP:
        return None
    return M2M_MAP.get(c) if c else None


def frame_from(primary, secondary):
    y = primary.normalized()
    x = (secondary - y * secondary.dot(y)).normalized()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed()  # columns x, y, z


def side_vector(name, heads, kind):
    """Secondary axis per bone family, measured in that skeleton's rest pose."""
    if kind == 'rig':
        side = 'L' if ' L ' in name else 'R'
        if name.startswith(f'Bip01 {side} Finger0'):
            return (heads[f'Bip01 {side} Finger2'] - heads[f'Bip01 {side} Hand']).cross(
                heads[f'Bip01 {side} Finger1'] - heads[f'Bip01 {side} Finger4'])
        if 'Finger' in name or 'Hand' in name or 'Forearm' in name:
            return heads[f'Bip01 {side} Finger1'] - heads[f'Bip01 {side} Finger4']
        if 'Clavicle' in name or 'UpperArm' in name:
            return Vector((0, -1, 0))  # forward
        return Vector((1, 0, 0))  # character's left (-X is right, faces -Y)
    s = 'l' if name.endswith('_l') else 'r'
    if 'thumb' in name:
        return (heads[f'middle_01_{s}'] - heads[f'hand_{s}']).cross(heads[f'index_01_{s}'] - heads[f'pinky_01_{s}'])
    if any(k in name for k in ('index', 'middle', 'ring', 'pinky', 'hand', 'lowerarm')):
        return heads[f'index_01_{s}'] - heads[f'pinky_01_{s}']
    if 'clavicle' in name or 'upperarm' in name:
        return Vector((0, -1, 0))
    return Vector((1, 0, 0))


def sample_m2m(path, synth_breath=False):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    mw = arm.matrix_world
    # rest pose of both skeletons, world space
    m_rest = {b.name: mw @ b.matrix_local for b in arm.data.bones}
    m_head = {k: v.to_translation() for k, v in m_rest.items()}
    r_head = {n: sk['rest'][n].to_translation() for n in ORDER}
    offset = {}
    for n in ORDER[1:]:
        if n not in BIP2M2M:
            continue
        m = BIP2M2M[n]
        rc = rig_child(n)
        mc = M2M_CHILD.get(m)
        if rc is None:  # finger tips: reuse the parent's direction
            rp = PARENT[n]
            rdir = r_head[n] - r_head[rp]
            mdir = m_head[m] - m_head[BIP2M2M[rp]]
        else:
            rdir = r_head[rc] - r_head[n]
            mdir = m_head[mc] - m_head[m]
        if n in ('Bip01 Pelvis', 'Bip01 Head'):
            # both rests stand upright looking ahead: align on world up / left, not on
            # bone directions (the two skeletons lean their neck and pelvis differently)
            rdir = mdir = Vector((0, 0, 1))
        Fr = frame_from(rdir, side_vector(n, r_head, 'rig'))
        Fm = frame_from(mdir, side_vector(m, m_head, 'm2m'))
        align = (Fm @ Fr.transposed()).to_quaternion()   # rig rest frame -> m2m rest frame
        aligned = align @ REST_Q[n]
        offset[n] = m_rest[m].decompose()[1].inverted() @ aligned
    # hip height ratio for the root translation
    ratio = r_head['Bip01 Pelvis'].z / m_head['pelvis'].z
    act = arm.animation_data.action if arm.animation_data else None
    if act is None and arm.animation_data and arm.animation_data.nla_tracks:
        act = arm.animation_data.nla_tracks[0].strips[0].action
        arm.animation_data.action = act
    f0, f1 = act.frame_range
    sc = bpy.context.scene
    src_fps = sc.render.fps / sc.render.fps_base
    dur = (f1 - f0) / src_fps
    n_out = max(2, int(round(dur * FPS)) + 1)
    frames = []
    pelvis_rest_q = REST_Q['Bip01 Pelvis']
    root_rest_q = REST_Q[C.ROOT]
    pel_in_root = root_rest_q.inverted() @ pelvis_rest_q
    for i in range(n_out):
        t = f0 + (f1 - f0) * (i / (n_out - 1))
        fi = int(math.floor(t))
        sc.frame_set(fi, subframe=t - fi)
        mwp = arm.matrix_world
        pose = {pb.name: mwp @ pb.matrix for pb in arm.pose.bones}
        rot = {}
        for n in ORDER[1:]:
            if n in offset:
                rot[n] = pose[BIP2M2M[n]].decompose()[1] @ offset[n]
        # Biped: pelvis orientation is carried by Bip01; Bip01 Pelvis keeps its rest offset
        root_q = rot['Bip01 Pelvis'] @ pel_in_root.inverted()
        rot[C.ROOT] = root_q
        p = pose['pelvis'].to_translation()
        root = Matrix.Translation(Vector((p.x * ratio, p.y * ratio, p.z * ratio))) @ root_q.to_matrix().to_4x4()
        # unmapped bones (face) follow their parent rigidly: keep their rest local rotation
        for n in ORDER[1:]:
            if n not in rot:
                pnt = PARENT[n]
                rot[n] = rot[pnt] @ REST_Q[pnt].inverted() @ REST_Q[n]
        frames.append({'root': root, 'rot': rot, 'ground': CANON.copy()})
    C.remove_objects(new)
    for a in list(bpy.data.actions):
        if a.users == 0:
            bpy.data.actions.remove(a)
    C.purge()
    return frames, {'srcSeconds': round(dur, 3), 'ratio': round(ratio, 4)}


def add_breathing(Q, L, seconds=4.8, breaths=1, spine_deg=1.2, head_deg=0.8, clav_deg=0.8):
    """Synthesize slow breathing on top of a held pose (two Mesh2Motion clips are a
    single held pose). Rotations are about each bone's lateral (rest +X = left) axis."""
    n = int(round(seconds * FPS)) + 1
    base = {b: Q[b][0].copy() for b in ORDER}
    lat = {b: REST_Q[b].inverted() @ Vector((1, 0, 0)) for b in ORDER}
    fwd = {b: REST_Q[b].inverted() @ Vector((0, -1, 0)) for b in ORDER}
    amount = {'Bip01 Spine1': spine_deg, 'Bip01 Spine2': spine_deg, 'Bip01 Head': -head_deg}
    Q2 = {b: [] for b in ORDER}
    L2 = []
    for i in range(n):
        ph = 2 * math.pi * breaths * i / (n - 1)
        s = 0.5 - 0.5 * math.cos(ph)  # 0 -> 1 -> 0, smooth at the loop point
        for b in ORDER:
            q = base[b].copy()
            if b in amount:
                q = q @ Quaternion(lat[b], math.radians(amount[b]) * s)
            elif b in ('Bip01 L Clavicle', 'Bip01 R Clavicle'):
                q = q @ Quaternion(fwd[b], math.radians(clav_deg if ' L ' in b else -clav_deg) * s)
            Q2[b].append(q)
        L2.append(L[0].copy())
    return Q2, L2


# ---------------------------------------------------------------- FK, contact, alignment
REL = {n: sk['rest'][PARENT[n]].inverted() @ sk['rest'][n] for n in ORDER[1:]}


def fk(Q, L, i):
    W = {C.ROOT: REST_ROOT @ (Matrix.Translation(L[i]) @ Q[C.ROOT][i].to_matrix().to_4x4())}
    for n in ORDER[1:]:
        W[n] = W[PARENT[n]] @ REL[n] @ Q[n][i].to_matrix().to_4x4()
    return W


def feet_center(Q, L, i):
    W = fk(Q, L, i)
    pts = [W[f'Bip01 {s} {b}'].to_translation() for s in 'LR' for b in ('Foot', 'Toe0')]
    c = sum(pts, Vector()) / len(pts)
    return Vector((c.x, c.y, 0))


REF_MESH = None


def attach_reference_mesh(fbx):
    """Bind one avatar mesh of this gender to the rig (used for ground contact)."""
    global REF_MESH
    arm, meshes, new = C.import_fbx(fbx)
    src = meshes[0]
    mw = src.matrix_world.copy()
    src.parent = None
    src.data.transform(mw)
    src.matrix_world = Matrix.Identity(4)
    src.parent = rig
    for m in src.modifiers:
        if m.type == 'ARMATURE':
            m.object = rig
    C.remove_objects([o for o in new if o is not src])
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    REF_MESH = src


def pose_rig(Q, L, i):
    for n in ORDER:
        pb = rig.pose.bones[n]
        pb.rotation_quaternion = Q[n][i]
        pb.location = L[i] if n == C.ROOT else (0, 0, 0)


def mesh_min_z():
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    e = REF_MESH.evaluated_get(dg)
    me = e.to_mesh()
    z = min(v.co.z for v in me.vertices)
    e.to_mesh_clear()
    return z


def ground_contact(Q, L, smooth=2):
    """Lift/lower the root per frame so the reference body rests on the floor (z = 0)."""
    zs = []
    for i in range(len(L)):
        pose_rig(Q, L, i)
        zs.append(mesh_min_z())
    for pb in rig.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    sm = []
    for i in range(len(zs)):
        win = zs[max(0, i - smooth): i + smooth + 1]
        sm.append(sum(win) / len(win))
    # root location is in the Bip01 rest frame: convert a world Z offset into it
    inv = REST_ROOT.to_3x3().inverted()
    for i in range(len(L)):
        L[i] = L[i] + inv @ Vector((0, 0, -sm[i]))
    return round(min(zs), 4), round(max(zs), 4)


def shift_world(Q, L, delta):
    inv = REST_ROOT.to_3x3().inverted()
    d = inv @ delta
    for i in range(len(L)):
        L[i] = L[i] + d


IDLE_FEET = None


def foot_slide(Q, L, speed):
    """Horizontal drift of each planted foot when the root moves at `speed` along the
    facing direction (-Y in Blender). Planted = toe within 2 cm of its lowest point."""
    n = len(L)
    out = {}
    for side in 'LR':
        pts = []
        for i in range(n):
            W = fk(Q, L, i)
            p = W[f'Bip01 {side} Toe0'].to_translation()
            pts.append(Vector((p.x, p.y - speed * i / FPS, p.z)))
        zmin = min(p.z for p in pts)
        flags = [p.z < zmin + 0.02 for p in pts]
        # contiguous stance runs; a run that wraps over the loop point is split in two
        runs, cur = [], []
        for p, f in zip(pts, flags):
            if f:
                cur.append(p)
            elif cur:
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        span = max(max((a.xy - b.xy).length for a in r for b in r) for r in runs)
        out[side] = round(span * 100, 2)
    return out


# ---------------------------------------------------------------- main
info = {'gender': cfg['gender'], 'fps': FPS, 'clips': {}}
attach_reference_mesh(cfg['referenceAvatar'])
for spec in cfg['clips']:
    name = spec['name']
    meta = {'source': os.path.basename(spec['file']), 'mode': spec['mode'], 'loop': bool(spec.get('loop'))}
    if spec['kind'] == 'rb':
        frames, diag = sample_rb(spec['file'])
        meta.update(diag)
        g0 = frames[0]['ground']
        T0 = CANON @ g0.inverted()
        if spec['mode'] == 'inplace':
            frames = transform_frames(frames, [CANON @ fr['ground'].inverted() for fr in frames])
        else:
            frames = transform_frames(frames, [T0] * len(frames))
        if spec['mode'] == 'walk':
            n = len(frames)
            p0 = frames[0]['root'].to_translation()
            p1 = frames[-1]['root'].to_translation()
            travel = Vector((p1.x - p0.x, p1.y - p0.y, 0))
            secs = (n - 1) / FPS
            meta['speed'] = round(travel.length / secs, 4)
            # heading error between the travel direction and the facing (-Y)
            meta['headingErrDeg'] = round(math.degrees(math.atan2(travel.x, -travel.y)), 2)
            # rotate the clip so the travel is exactly along -Y, then remove it
            R = Matrix.Rotation(-math.atan2(travel.x, -travel.y), 4, 'Z')
            per = []
            for i in range(n):
                per.append(Matrix.Translation(-(R @ travel) * (i / (n - 1))) @ R)
            frames = transform_frames(frames, per)
    else:
        frames, diag = sample_m2m(spec['file'])
        meta.update(diag)
    Q, L = to_basis(frames)
    if spec['kind'] == 'm2m':
        if spec.get('breathe'):
            Q, L = add_breathing(Q, L, **spec['breathe'])
            meta['synthBreathing'] = True
        lo, hi = ground_contact(Q, L)
        meta['groundFixCm'] = [round(-hi * 100, 1), round(-lo * 100, 1)]
        # line the feet up with the Rocketbox idle so cross-fades do not slide
        align_at = spec.get('alignFeet')
        if align_at is not None and IDLE_FEET is not None:
            i = 0 if align_at == 'start' else len(L) - 1
            d = IDLE_FEET - feet_center(Q, L, i)
            shift_world(Q, L, d)
            meta['feetAlignCm'] = round(d.length * 100, 1)
    if name == 'idle':
        IDLE_FEET = feet_center(Q, L, 0)
    if spec['kind'] == 'rb' and spec['mode'] == 'walk':
        meta['footSlideCm'] = foot_slide(Q, L, meta['speed'])
    if spec.get('loop'):
        ang, dist, step = loop_mismatch(Q, L)
        meta['loopMismatchDeg'] = round(ang, 2)
        meta['loopMismatchCm'] = round(dist * 100, 2)
        Q, L, how = make_loop(Q, L)
        meta['loopFix'] = how
    write_action(name, Q, L)
    n = len(L)
    rw0, rw1 = root_world(Q, L, 0), root_world(Q, L, n - 1)
    g_end = frames[-1]['ground'] if spec['kind'] == 'rb' and spec['mode'] == 'root' else CANON
    meta.update({
        'frames': n,
        'duration': round((n - 1) / FPS, 4),
        'rootStart': {'bip01': to_gltf(rw0.to_translation())},
        'rootEnd': {'bip01': to_gltf(rw1.to_translation())},
        'groundEnd': {'pos': to_gltf(g_end.to_translation()),
                      'yawDeg': round(yaw_deg(g_end) - yaw_deg(CANON), 2)},
    })
    info['clips'][name] = meta
    print('CLIP', cfg['gender'], name, meta)

# export: skeleton only (no mesh), one glTF animation per action
C.remove_objects([REF_MESH])
for o in bpy.data.objects:
    o.select_set(o == rig)
bpy.context.view_layer.objects.active = rig
os.makedirs(os.path.dirname(cfg['out']), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=cfg['out'],
    export_format='GLTF_SEPARATE',
    use_selection=True,
    export_yup=True,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_force_sampling=True,
    export_frame_step=1,
    export_optimize_animation_size=False,
    export_anim_slide_to_zero=True,
    export_reset_pose_bones=True,
    export_def_bones=False,
    export_rest_position_armature=True,
    export_skins=False,
    export_materials='NONE',
    export_morph=False,
    export_extras=False,
)
C.write_json(cfg['info'], info)
