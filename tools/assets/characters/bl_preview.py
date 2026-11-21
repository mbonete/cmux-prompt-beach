"""Blender step 4: verification renders and sit/table measurements from the exported glTFs.

usage: blender -b --python bl_preview.py -- <config.json>
config: {"out": previews dir, "avatars": {id: gltf}, "anims": {"m": gltf, "f": gltf},
         "jobs": ["sheet", "poses:<id>", "closeup:<id>", "measure"], "measureOut": json,
         "size": [w, h]}
Renders with Eevee under a neutral daylight sky plus a warm key light (AgX).
"""
import math
import os
import sys

sys.dont_write_bytecode = True  # keep tools/ free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import bl_common as C  # noqa: E402

cfg = C.read_json(C.args()[0])
OUT = cfg['out']
os.makedirs(OUT, exist_ok=True)


def setup_scene(ground=True):
    C.reset()
    sc = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in engines else 'BLENDER_EEVEE'
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'None'
    sc.render.film_transparent = False
    try:
        sc.eevee.taa_render_samples = 32
        sc.eevee.use_shadows = True
    except AttributeError:
        pass
    world = bpy.data.worlds.new('sky')
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.62, 0.72, 1)  # neutral daylight sky
    bg.inputs['Strength'].default_value = 0.9
    sun = bpy.data.lights.new('key', 'SUN')
    sun.energy = 3.2
    sun.color = (1.0, 0.82, 0.62)  # warm golden-hour key
    sun.angle = math.radians(3)
    so = bpy.data.objects.new('key', sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(55), 0, math.radians(-35))
    if ground:
        bpy.ops.mesh.primitive_plane_add(size=40)
        g = bpy.context.active_object
        m = bpy.data.materials.new('ground')
        m.use_nodes = True
        p = m.node_tree.nodes['Principled BSDF']
        p.inputs['Base Color'].default_value = (0.32, 0.31, 0.3, 1)
        p.inputs['Roughness'].default_value = 0.9
        g.data.materials.append(m)
    cam = bpy.data.cameras.new('cam')
    co = bpy.data.objects.new('cam', cam)
    sc.collection.objects.link(co)
    sc.camera = co
    return sc, co


def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    # the importer adds a bone-shape helper mesh (Icosphere): hide it
    out = []
    for o in new:
        if o.type == 'MESH' and not any(m.type == 'ARMATURE' for m in o.modifiers):
            o.hide_render = True
            o.hide_viewport = True
            continue
        out.append(o)
    return out


def eval_bbox(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = -lo
    for o in objs:
        if o.type != 'MESH' or o.hide_render:
            continue
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        for v in me.vertices:
            w = e.matrix_world @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        e.to_mesh_clear()
    return lo, hi


def aim(cam_obj, target, yaw_deg, pitch_deg, dist, lens=50):
    cam_obj.data.lens = lens
    cam_obj.data.sensor_width = 36
    cam_obj.data.sensor_height = 36
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    # yaw 0 = camera in front of the character (character faces -Y in Blender)
    d = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    cam_obj.location = target + d * dist
    cam_obj.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()


def frame_box(cam_obj, lo, hi, yaw=30, pitch=8, lens=50, margin=1.15, aspect=0.5):
    c = (lo + hi) / 2
    h = max(hi.z - lo.z, (max(hi.x - lo.x, hi.y - lo.y)) / aspect)
    fov = 2 * math.atan(36 / 2 / lens)  # sensor 36 mm along the long side (height when portrait)
    dist = (h * margin / 2) / math.tan(fov / 2) + max(hi.x - lo.x, hi.y - lo.y) / 2
    aim(cam_obj, c, yaw, pitch, dist, lens)


def render(path, w, h):
    sc = bpy.context.scene
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    sc.camera.data.sensor_fit = 'VERTICAL' if h >= w else 'HORIZONTAL'
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)


def avatar_mesh_objs(objs):
    return [o for o in objs if o.type == 'MESH']


def hide_lod1(objs):
    for o in objs:
        if o.type == 'MESH' and o.name.startswith('lod1'):
            o.hide_render = True
            o.hide_viewport = True


def load_avatar_with_anims(av_path, anim_path):
    anim_objs = import_gltf(anim_path)
    anim_arm = next(o for o in anim_objs if o.type == 'ARMATURE')
    av_objs = import_gltf(av_path)
    av_arm = next(o for o in av_objs if o.type == 'ARMATURE')
    for o in av_objs:
        if o.type == 'MESH':
            for m in o.modifiers:
                if m.type == 'ARMATURE':
                    m.object = anim_arm
    av_arm.hide_render = True
    hide_lod1(av_objs)
    return anim_arm, [o for o in av_objs if o.type == 'MESH' and not o.name.startswith('lod1')]


def clip_actions(anim_arm):
    acts = {}
    for a in bpy.data.actions:
        acts[a.name.split('_Rig')[0] if a.name.endswith('_Rig') else a.name] = a
    return acts


def set_clip(anim_arm, act, t_norm):
    ad = anim_arm.animation_data or anim_arm.animation_data_create()
    for tr in ad.nla_tracks:
        tr.mute = True
    ad.action = act
    if len(act.slots):
        ad.action_slot = act.slots[0]
    f0, f1 = act.frame_range
    f = f0 + (f1 - f0) * t_norm
    fi = int(math.floor(f))
    bpy.context.scene.frame_set(fi, subframe=f - fi)


def job_sheet():
    w, h = 360, 640
    tiles = []
    for aid, path in cfg['avatars'].items():
        sc, cam = setup_scene()
        if cfg.get('anims'):
            # shown in the idle clip: proves every avatar binds to its skeleton's clips
            anim_arm, meshes = load_avatar_with_anims(path, cfg['anims'][cfg['avatarGender'][aid]])
            set_clip(anim_arm, clip_actions(anim_arm)['idle'], 0.25)
        else:
            objs = import_gltf(path)
            hide_lod1(objs)
            meshes = [o for o in objs if o.type == 'MESH' and not o.hide_render]
        lo, hi = eval_bbox(meshes)
        lo.z = min(lo.z, 0.0)
        frame_box(cam, lo, hi, yaw=32, pitch=6, lens=60, margin=1.08)
        p = os.path.join(OUT, '_tiles', f'sheet_{aid}.png')
        render(p, w, h)
        tiles.append(p)
    C.write_json(os.path.join(OUT, '_tiles', 'sheet.json'), tiles)


def job_poses(aid):
    av = cfg['avatars'][aid]
    g = cfg['avatarGender'][aid]
    sc, cam = setup_scene()
    anim_arm, meshes = load_avatar_with_anims(av, cfg['anims'][g])
    acts = clip_actions(anim_arm)
    tiles = []
    w, h = 300, 400
    for name in cfg['clipOrder']:
        act = acts.get(name)
        if act is None:
            print('MISSING CLIP', name)
            continue
        for t in (0.3, 0.7):
            set_clip(anim_arm, act, t)
            lo, hi = eval_bbox(meshes)
            lo.z = min(lo.z, 0.0)
            frame_box(cam, lo, hi, yaw=30, pitch=10, lens=50, margin=1.1, aspect=0.75)
            p = os.path.join(OUT, '_tiles', f'pose_{aid}_{name}_{int(t * 100)}.png')
            render(p, w, h)
            tiles.append([name, t, p])
    C.write_json(os.path.join(OUT, '_tiles', f'poses_{aid}.json'), tiles)


def job_closeup(aid):
    sc, cam = setup_scene(ground=False)
    objs = import_gltf(cfg['avatars'][aid])
    hide_lod1(objs)
    meshes = [o for o in objs if o.type == 'MESH' and not o.hide_render]
    lo, hi = eval_bbox(meshes)
    head = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, hi.z - 0.13))
    for yaw, tag in ((25, 'a'), (115, 'b')):
        aim(cam, head, yaw, 4, 0.75, lens=85)
        render(os.path.join(OUT, '_tiles', f'closeup_{aid}_{tag}.png'), 800, 800)


def mesh_points(meshes, groups):
    """World positions of evaluated vertices whose dominant group is in `groups`."""
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in meshes:
        idx = {vg.index: vg.name for vg in o.vertex_groups}
        dom = []
        for v in o.data.vertices:
            best = max(v.groups, key=lambda g: g.weight, default=None)
            dom.append(idx.get(best.group) if best else None)
        e = o.evaluated_get(dg)
        me = e.to_mesh()
        for i, v in enumerate(me.vertices):
            if dom[i] in groups:
                pts.append(e.matrix_world @ v.co)
        e.to_mesh_clear()
    return pts


def to_gltf(v):
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]


def job_measure():
    """Seat and table heights the sitting clips assume (glTF coords, metres)."""
    res = {}
    for g, aid in cfg['measureAvatars'].items():
        sc, cam = setup_scene(ground=False)
        anim_arm, meshes = load_avatar_with_anims(cfg['avatars'][aid], cfg['anims'][g])
        acts = clip_actions(anim_arm)
        out = {}
        seat_groups = {'Bip01 Pelvis', 'Bip01 L Thigh', 'Bip01 R Thigh'}
        hand_groups = {f'Bip01 {s} {b}' for s in 'LR' for b in
                       ('Hand', 'Finger0', 'Finger01', 'Finger02', 'Finger1', 'Finger11', 'Finger12',
                        'Finger2', 'Finger21', 'Finger22', 'Finger3', 'Finger31', 'Finger32',
                        'Finger4', 'Finger41', 'Finger42')}
        arm_groups = hand_groups | {'Bip01 L Forearm', 'Bip01 R Forearm'}
        for clip in cfg['sitClips']:
            act = acts.get(clip)
            if not act:
                continue
            seat, hands, fore, pelvis = [], [], [], []
            for t in [i / 10 for i in range(11)]:
                set_clip(anim_arm, act, t)
                pb = anim_arm.pose.bones['Bip01 Pelvis']
                pw = anim_arm.matrix_world @ pb.head
                sp = mesh_points(meshes, seat_groups)
                # seat contact: lowest buttock / upper-thigh points, i.e. within 22 cm of
                # the pelvis horizontally (excludes the knees, which hang lower)
                near = [p for p in sp if (p.xy - pw.xy).length < 0.22]
                pz = sorted(p.z for p in near)
                seat.append(pz[max(0, len(pz) // 100)])
                hp = mesh_points(meshes, hand_groups)
                hands.append(min(p.z for p in hp))
                ap = mesh_points(meshes, arm_groups)
                fore.append(min(p.z for p in ap))
                pelvis.append(pw)
            # horizontal extent of the hands (towards the table) at mid clip
            set_clip(anim_arm, act, 0.5)
            hp = mesh_points(meshes, hand_groups)
            sp = mesh_points(meshes, seat_groups)
            out[clip] = {
                'seatContactZ': round(sorted(seat)[len(seat) // 2], 4),
                'handsMinZ': round(min(hands), 4),
                'handsMedianMinZ': round(sorted(hands)[len(hands) // 2], 4),
                'forearmsMinZ': round(min(fore), 4),
                'pelvis': to_gltf(sum(pelvis, Vector()) / len(pelvis)),
                'handsNearestZ': round(min(-p.y for p in hp), 4),
                'handsFarthestZ': round(max(-p.y for p in hp), 4),
                'seatBackZ': round(min(-p.y for p in sp), 4),
                'seatFrontZ': round(max(-p.y for p in sp), 4),
            }
            print('MEASURE', g, clip, out[clip])
        res[g] = out
    C.write_json(cfg['measureOut'], res)


for job in cfg['jobs']:
    kind, _, arg = job.partition(':')
    if kind == 'sheet':
        job_sheet()
    elif kind == 'poses':
        job_poses(arg)
    elif kind == 'closeup':
        job_closeup(arg)
    elif kind == 'measure':
        job_measure()
