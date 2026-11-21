"""Golden-hour turntable-style stills of converted props, for the contact sheet.

    blender -b --factory-startup --python preview_props.py -- <repo root> <out dir> <prop.gltf> [...]

For each prop it renders <out dir>/<id>_lod0.png and, when the asset has a
`lod1` node, <id>_lod1.png from the same camera. Lighting: the sunset IBL
(sun removed) plus a low warm sun lamp; ground with a 0.5 m checker; a 1.75 m
grey capsule stands beside props taller than 0.6 m for scale.
"""
import math
import os
import sys

import bpy
import mathutils

args = sys.argv[sys.argv.index("--") + 1:]
root, out_dir, files = os.path.abspath(args[0]), os.path.abspath(args[1]), args[2:]
os.makedirs(out_dir, exist_ok=True)
HDR = os.path.join(root, "public/assets/env/sky/qwantani_sunset_puresky_1k.hdr")


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.eevee.taa_render_samples = 48
    sc.render.resolution_x = sc.render.resolution_y = 640
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_settings.exposure = -0.8
    world = bpy.data.worlds.new("w")
    sc.world = world
    nt = world.node_tree
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(HDR)
    nt.links.new(env.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 0.55
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 5.5
    sun.data.color = (1.0, 0.66, 0.38)
    sun.data.angle = math.radians(1.5)
    sun.rotation_euler = (math.radians(90 - 16), 0, math.radians(-35))   # 16 deg above the horizon, front-left
    sc.collection.objects.link(sun)
    return sc


def ground(sc, size):
    bpy.ops.mesh.primitive_plane_add(size=size)
    g = bpy.context.object
    m = bpy.data.materials.new("ground")
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    ck = nt.nodes.new("ShaderNodeTexChecker")
    ck.inputs["Scale"].default_value = 1.0
    ck.inputs["Color1"].default_value = (0.30, 0.27, 0.23, 1)
    ck.inputs["Color2"].default_value = (0.24, 0.22, 0.19, 1)
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (2, 2, 2)                     # 0.5 m squares
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], ck.inputs["Vector"])
    nt.links.new(ck.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    g.data.materials.append(m)
    return g


def capsule(sc, x, y):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.2, depth=1.35, location=(x, y, 0.2 + 1.35 / 2))
    body = bpy.context.object
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.2, location=(x, y, 0.2 + 1.35))
    top = bpy.context.object
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.2, location=(x, y, 0.2))
    bot = bpy.context.object
    m = bpy.data.materials.new("ref")
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.5, 0.52, 1)
    for o in (body, top, bot):
        o.data.materials.append(m)


def bounds(objs):
    mn = mathutils.Vector((1e9,) * 3)
    mx = -mn
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            mn = mathutils.Vector(map(min, mn, w))
            mx = mathutils.Vector(map(max, mx, w))
    return mn, mx


def in_lod(obj, name):
    p = obj
    while p:
        if p.name.split(".")[0] == name:
            return True
        p = p.parent
    return False


for f in files:
    pid = os.path.splitext(os.path.basename(f))[0]
    sc = setup_scene()
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(f))
    meshes = [o for o in sc.objects if o.type == "MESH"]
    lod0 = [o for o in meshes if not in_lod(o, "lod1")]
    lod1 = [o for o in meshes if in_lod(o, "lod1")]
    mn, mx = bounds(lod0)
    size = mx - mn
    ctr = (mn + mx) / 2
    ground(sc, max(40.0, size.length * 4)).location.z = min(0.0, mn.z) if mn.z > -0.05 else 0.0
    if size.z > 0.6:
        capsule(sc, mx.x + 0.45, ctr.y)
        mx.x += 0.7
        mx.z = max(mx.z, 1.75)
    mn2, mx2 = mn.copy(), mx.copy()
    ctr = (mn2 + mx2) / 2
    radius = (mx2 - mn2).length / 2
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 50
    cam.data.clip_start = 0.01
    cam.data.clip_end = 500
    d = mathutils.Vector((0.55, -1.0, 0.42)).normalized()     # glTF +Z (front) is Blender -Y
    fov = 2 * math.atan(18 / 50)
    cam.location = ctr + d * radius / math.sin(fov / 2) * 1.02
    cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
    for which, show in (("lod0", lod0), ("lod1", lod1)):
        if not show:
            continue
        for o in meshes:
            o.hide_render = o not in show
        sc.render.filepath = os.path.join(out_dir, f"{pid}_{which}.png")
        bpy.ops.render.render(write_still=True)
    print("PREVIEW", pid, "lod1" if lod1 else "", tuple(round(v, 3) for v in size))
