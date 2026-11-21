"""Eevee look-dev previews of the final glTF files (not the Blender build
scene), so what we judge is what ships.

    blender -b --factory-startup --python tools/assets/deco/build_kit.py -- --preview-only [--only name,...]

Golden hour: qwantani_sunset HDRI (sun clamped) rotated so its sun sits with
a 12 degree sun lamp behind-left of a camera on the +Z side. Night: the
qwantani night HDRI, interiors and neon at full strength, compositor bloom.
Grey stand-in figures sit at every spot so furniture heights can be judged.
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from kit.config import OUT, PREVIEWS, SRC  # noqa: E402

HDRI_DAY = SRC / "polyhaven/hdri/qwantani_sunset_puresky_4k.hdr"
HDRI_NIGHT = SRC / "polyhaven/hdri/qwantani_night_puresky_4k.hdr"
SUN_TOWARD = Vector((-0.55, 0.0, -0.83))  # glTF: behind-left of a +Z camera
SUN_ELEV = 12.0


def gl(v):
    """glTF vector -> Blender."""
    return Vector((v[0], -v[2], v[1]))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def _hdri_sun_alpha(img):
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(h, w, 4)
    L = a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722
    iy, ix = np.unravel_index(np.argmax(L), L.shape)
    u = (ix + 0.5) / w
    az = 2 * math.pi * (u - 0.5)  # Blender equirect: atan2(dy, -dx)
    dx, dy = -math.cos(az), math.sin(az)
    return math.atan2(dy, dx)


def world(night=False, strength=1.0):
    sc = bpy.context.scene
    w = bpy.data.worlds.new("w")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    img = bpy.data.images.load(str(HDRI_NIGHT if night else HDRI_DAY))
    env.image = img
    mp = nt.nodes.new("ShaderNodeMapping")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
    if not night:
        want = gl(SUN_TOWARD)
        a_want = math.atan2(want.y, want.x)
        mp.inputs["Rotation"].default_value[2] = _hdri_sun_alpha(img) - a_want
    # clamp the sun disc so the lamp alone casts the key light
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    comb = nt.nodes.new("ShaderNodeCombineColor")
    nt.links.new(env.outputs["Color"], sep.inputs["Color"])
    for i, ch in enumerate(("Red", "Green", "Blue")):
        m = nt.nodes.new("ShaderNodeMath")
        m.operation = "MINIMUM"
        m.inputs[1].default_value = 6.0
        nt.links.new(sep.outputs[ch], m.inputs[0])
        nt.links.new(m.outputs[0], comb.inputs[ch])
    nt.links.new(comb.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def sun(energy=7.0, color=(1.0, 0.64, 0.38), elev=SUN_ELEV, toward=SUN_TOWARD):
    d = gl(toward).normalized()
    d.z = 0
    d.normalize()
    e = math.radians(elev)
    to_sun = Vector((d.x * math.cos(e), d.y * math.cos(e), math.sin(e)))
    li = bpy.data.lights.new("sun", "SUN")
    li.energy = energy
    li.color = color
    li.angle = math.radians(1.2)
    ob = bpy.data.objects.new("sun", li)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
    return ob


def ground(size=600.0, color=(0.2, 0.18, 0.16)):
    me = bpy.data.meshes.new("ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size / 2)
    bm.to_mesh(me)
    ob = bpy.data.objects.new("ground", me)
    ob.location.z = -0.003
    bpy.context.scene.collection.objects.link(ob)
    m = bpy.data.materials.new("ground")
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = 0.9
    me.materials.append(m)
    return ob


def render_settings(res=(1600, 900), samples=64):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.eevee.taa_render_samples = samples
    sc.eevee.use_raytracing = True
    sc.eevee.use_shadows = True
    sc.eevee.shadow_resolution_scale = 1.0
    try:
        sc.eevee.use_fast_gi = True
        sc.eevee.fast_gi_distance = 6.0
    except Exception:
        pass
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    sc.view_settings.exposure = 0.0
    sc.render.image_settings.file_format = "PNG"


def bloom(on=True, strength=0.6):
    sc = bpy.context.scene
    if not on:
        sc.compositing_node_group = None if hasattr(sc, "compositing_node_group") else None
        return
    try:
        ng = bpy.data.node_groups.new("comp", "CompositorNodeTree")
        rl = ng.nodes.new("CompositorNodeRLayers")
        gl_ = ng.nodes.new("CompositorNodeGlare")
        out = ng.nodes.new("NodeGroupOutput")
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        gl_.inputs["Type"].default_value = "Bloom"
        for key, val in (("Threshold", 0.9), ("Strength", strength), ("Size", 0.7)):
            if key in gl_.inputs:
                try:
                    gl_.inputs[key].default_value = val
                except Exception:
                    pass
        ng.links.new(rl.outputs["Image"], gl_.inputs["Image"])
        ng.links.new(gl_.outputs["Image"], out.inputs[0])
        sc.compositing_node_group = ng
        sc.render.use_compositing = True
    except Exception as e:  # compositor API differences are not fatal for a preview
        print("[previews] bloom disabled:", e)


def camera(name, pos_gl, target_gl, fov=30.0):
    cam = bpy.data.cameras.new(name)
    cam.sensor_fit = "VERTICAL"
    cam.angle = math.radians(fov)
    cam.clip_start = 0.5
    cam.clip_end = 3000
    ob = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(ob)
    p, t = gl(pos_gl), gl(target_gl)
    ob.location = p
    ob.rotation_euler = (t - p).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = ob
    return ob


def game_camera(target=(0, 1.5, 0), dist=45.0, tilt=40.0, yaw=0.0, fov=30.0):
    t, y = math.radians(tilt), math.radians(yaw)
    off = (dist * math.cos(t) * math.sin(y), dist * math.sin(t), dist * math.cos(t) * math.cos(y))
    return camera("game", (target[0] + off[0], target[1] + off[1], target[2] + off[2]), target, fov)


def import_gltf(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(OUT / f"{name}.gltf"))
    return [o for o in bpy.data.objects if o not in before]


def emission(scale_interior, scale_neon, scale_bulb=0.0):
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        for n in m.node_tree.nodes:
            if n.type != "BSDF_PRINCIPLED":
                continue
            if m.name.startswith("interior"):
                n.inputs["Emission Strength"].default_value = scale_interior
            elif m.name.startswith("neon_accent"):
                n.inputs["Emission Strength"].default_value = scale_neon
            elif m.name.startswith("bulb"):
                n.inputs["Emission Strength"].default_value = scale_bulb


def light_pools(power=22.0):
    """Stand-ins for the client's fake light pools: a soft point light at each
    light_<n> empty, its reach limited to light_radius."""
    for ob in list(bpy.data.objects):
        if ob.type != "EMPTY" or not ob.name.startswith("light_"):
            continue
        r = float(ob.get("light_radius", 3.0))
        h = ob.get("light_color", "#FFC680").lstrip("#")
        col = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
        li = bpy.data.lights.new(ob.name + "_pool", "POINT")
        li.color = [c ** 2.2 for c in col]
        li.energy = power * r * r
        li.shadow_soft_size = 0.4
        try:
            li.use_custom_distance = True
            li.cutoff_distance = r * 1.8
        except Exception:
            pass
        lo = bpy.data.objects.new(ob.name + "_pool", li)
        bpy.context.scene.collection.objects.link(lo)
        lo.matrix_world = ob.matrix_world.copy()


# ---------------------------------------------------------------------------
# stand-in people
# ---------------------------------------------------------------------------
def _capsule(bm, a, b, r, seg=10):
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    if L < 1e-4:
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2 + 1, radius=r,
                                  matrix=Matrix.Translation(a))
        return
    q = d.to_track_quat("Z", "Y")
    M = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=seg, radius1=r, radius2=r, depth=L, matrix=M)
    for p in (a, b):
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2 + 1, radius=r, matrix=Matrix.Translation(p))


def mannequin(empty, mat):
    """Figure in the empty's local frame (Blender: forward -Y, up +Z)."""
    kind = empty.get("spot_kind", "standing")
    sh = float(empty.get("seat_h", 0.46) or 0.46)
    th = empty.get("table_h")
    bm = bmesh.new()
    if kind in ("desk", "stool", "bench", "steps"):
        hip = (0, 0.03, sh + 0.1)
        neck = (0, 0.06, sh + 0.58)
        _capsule(bm, hip, neck, 0.15)
        _capsule(bm, (0, 0.05, sh + 0.74), (0, 0.05, sh + 0.76), 0.105)
        for x in (-0.1, 0.1):
            _capsule(bm, (x, 0.02, sh + 0.08), (x, -0.42, sh + 0.08), 0.075)
            _capsule(bm, (x, -0.42, sh + 0.06), (x, -0.47, 0.06), 0.06)
            _capsule(bm, (x, -0.47, 0.04), (x, -0.6, 0.04), 0.045)
        for x in (-0.2, 0.2):
            sx = (x, 0.05, sh + 0.53)
            if th is not None:
                el = (x * 1.1, -0.1, sh + 0.28)
                ha = (x * 0.7, -0.42, float(th) + 0.04)
            else:
                el = (x * 1.2, -0.05, sh + 0.25)
                ha = (x * 0.8, -0.3, sh + 0.14)
            _capsule(bm, sx, el, 0.05)
            _capsule(bm, el, ha, 0.045)
    elif kind == "lounger":
        hip = (0, 0.0, sh + 0.1)
        _capsule(bm, hip, (0, 0.42, sh + 0.42), 0.15)
        _capsule(bm, (0, 0.56, sh + 0.55), (0, 0.57, sh + 0.56), 0.105)
        for x in (-0.1, 0.1):
            _capsule(bm, (x, -0.02, sh + 0.09), (x, -0.45, sh + 0.16), 0.075)
            _capsule(bm, (x, -0.45, sh + 0.14), (x, -0.9, sh + 0.08), 0.06)
        for x in (-0.22, 0.22):
            _capsule(bm, (x, 0.38, sh + 0.38), (x * 1.1, 0.12, sh + 0.2), 0.05)
            _capsule(bm, (x * 1.1, 0.12, sh + 0.2), (x * 0.8, -0.1, sh + 0.16), 0.045)
    else:
        _capsule(bm, (0, 0, 0.98), (0, 0, 1.45), 0.15)
        _capsule(bm, (0, 0, 1.64), (0, 0, 1.66), 0.105)
        for x in (-0.1, 0.1):
            _capsule(bm, (x, 0, 0.95), (x, 0, 0.08), 0.07)
        for x in (-0.22, 0.22):
            _capsule(bm, (x, 0, 1.42), (x * 1.1, 0, 0.85), 0.045)
    me = bpy.data.meshes.new("figure")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("figure", me)
    me.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = empty.matrix_world.copy()
    return ob


def figures():
    mat = bpy.data.materials.new("figure")
    mat.use_nodes = True
    p = mat.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0.55, 0.6, 0.68, 1)
    p.inputs["Roughness"].default_value = 0.6
    for ob in list(bpy.data.objects):
        if ob.type == "EMPTY" and ob.name.startswith("spot_"):
            mannequin(ob, mat)


PROP_SRC = SRC / "polyhaven/models"
_prop_cache = {}


def _prop_collection(pid):
    if pid in _prop_cache:
        return _prop_cache[pid]
    f = PROP_SRC / pid / f"{pid}_1k.gltf"
    if not f.exists():
        _prop_cache[pid] = None
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(f))
    new = [o for o in bpy.data.objects if o not in before]
    coll = bpy.data.collections.new(f"prop_{pid}")
    for o in new:
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)
    _prop_cache[pid] = coll
    return coll


def place_props():
    """Instance the Poly Haven source props at prop:<id> empties so the
    preview shows the dressed plot (the client does this at runtime)."""
    _prop_cache.clear()
    for ob in list(bpy.data.objects):
        if ob.type != "EMPTY" or not ob.name.startswith("prop:"):
            continue
        pid = ob.get("prop_id") or ob.name[5:].split(".")[0]
        coll = _prop_collection(pid)
        if coll is None:
            continue
        inst = bpy.data.objects.new(f"inst_{pid}", None)
        inst.instance_type = "COLLECTION"
        inst.instance_collection = coll
        bpy.context.scene.collection.objects.link(inst)
        inst.matrix_world = ob.matrix_world.copy()


def save(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    print("[previews] wrote", path)


# ---------------------------------------------------------------------------
# shots
# ---------------------------------------------------------------------------
VIEWS = ("game", "terrace", "back", "night", "night_terrace")
# the co-working building is turned 90 degrees by the client: its local -X
# flank faces the usual camera, so its shots look from there
CAM_YAW = {"plot_coworking": -90.0}
SAND = {"plot_beach_bar"}


def plot_shots(name, views=VIEWS):
    yaw = CAM_YAW.get(name, 0.0)
    for view in views:
        reset()
        night = view.startswith("night")
        render_settings()
        world(night=night, strength=0.05 if night else 0.55)
        if night:
            sun(energy=0.04, color=(0.6, 0.7, 1.0), elev=50)
        else:
            sun()
        ground(color=(0.55, 0.45, 0.33) if name in SAND else (0.2, 0.18, 0.16))
        import_gltf(name)
        place_props()
        figures()
        if night:
            emission(3.0, 8.0, 6.0)
            light_pools()
            bloom(True, 0.8)
        else:
            emission(0.15, 1.0, 0.0)
            bloom(True, 0.25)
        if view in ("game", "night"):
            game_camera(target=(0, 3.5, -1.0), yaw=yaw)
        elif view == "back":
            game_camera(yaw=200.0 + yaw, tilt=32.0, dist=48.0)
        elif view in ("terrace", "night_terrace"):
            c, s_ = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
            rot = lambda p: (p[0] * c + p[2] * s_, p[1], -p[0] * s_ + p[2] * c)
            camera("terrace", rot((10.5, 5.2, 15.5)), rot((-1.5, 1.6, 1.2)), fov=34)
        save(PREVIEWS / f"{name}_{view}.png")


LINEUP = {
    "bg_1": (-29.0, 0.0), "bg_2": (-10.0, 0.0), "bg_3": (8.5, 0.0), "bg_4": (26.5, 0.0),
    "tower_1": (-55.0, -75.0), "tower_2": (0.0, -85.0), "tower_3": (48.0, -75.0),
}


def lineup(names):
    names = [n for n in LINEUP if n in names or not names]
    if not names:
        return
    for night in (False, True):
        reset()
        render_settings(res=(1920, 1080))
        world(night=night, strength=0.05 if night else 0.55)
        if night:
            sun(energy=0.04, color=(0.6, 0.7, 1.0), elev=50)
        else:
            sun()
        ground(size=1200)
        for n in names:
            objs = import_gltf(n)
            root = [o for o in objs if o.parent is None][0]
            x, z = LINEUP[n]
            root.location = gl((x, 0.0, z))
        if night:
            emission(3.0, 8.0)
            bloom(True, 0.8)
        else:
            emission(0.15, 1.0)
            bloom(True, 0.25)
        camera("lineup", (6.0, 34.0, 92.0), (0.0, 22.0, -30.0), fov=42)
        save(PREVIEWS / f"lineup_{'night' if night else 'golden'}.png")


PLOT_X = (-42.0, -16.0, 16.0, 42.0)
PLOT_Z = (8.0, 34.0, 60.0, 86.0)
HANGOUT = (4.0, -0.72, -44.0, 0.0)
OVERFLOW = (-84.0, 0.0, 34.0, 90.0)


def district(night=False, cam=None, tag=""):
    """The whole district as laid out in manifest.json (no props, no people)."""
    import json
    lay = json.loads((OUT / "manifest.json").read_text()).get("layout")
    if not lay:
        return
    reset()
    render_settings(res=(1920, 1080), samples=48)
    world(night=night, strength=0.05 if night else 0.55)
    if night:
        sun(energy=0.04, color=(0.6, 0.7, 1.0), elev=50)
    else:
        sun()
    land = ground(size=1)
    land.scale = (800, 320, 1)
    land.location = (0, -(320 / 2 - 12), -0.003)
    sand = ground(size=1, color=(0.62, 0.52, 0.38))
    sand.scale = (800, 120, 1)
    sand.location = (0, 12 + 60, -0.7)
    slots = [(PLOT_X[i % 4], 0.0, PLOT_Z[i // 4], 0.0, t) for i, t in enumerate(lay["plots"])]
    slots.append((*HANGOUT, lay["hangout"]))
    slots.append((*OVERFLOW, lay["overflow"]))
    for (x, y, z, rot, t) in slots:
        objs = import_gltf(t)
        root = [o for o in objs if o.parent is None][0]
        root.location = gl((x, y, z))
        root.rotation_euler[2] += math.radians(rot)
    if night:
        emission(3.0, 8.0, 6.0)
        light_pools()
        bloom(True, 0.8)
    else:
        emission(0.15, 1.0, 0.0)
        bloom(True, 0.25)
    pos, tgt, fov = cam or ((10.0, 120.0, 215.0), (0.0, 0.0, 30.0), 38)
    camera("district", pos, tgt, fov=fov)
    save(PREVIEWS / f"district_{'night' if night else 'golden'}{tag}.png")


def run(names, views=VIEWS, with_district=False):
    for n in names:
        if n.startswith("plot_"):
            plot_shots(n, views)
    rest = [n for n in names if not n.startswith("plot_")]
    if rest:
        lineup(rest)
    if with_district:
        district(False)
        district(True)
