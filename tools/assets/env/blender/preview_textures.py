"""Each texture set on a 4 m x 4 m plane at an oblique angle, under golden-hour light.

    blender -b --factory-startup --python preview_textures.py -- <repo root> <out dir>

Reads public/assets/env/manifest.json; UVs repeat every `sizeM` metres, so the
render shows real-world scale (a 1.75 m capsule stands at the back corner) and
any seam between repeats. Writes <out dir>/<set>.png.
"""
import json
import math
import os
import sys

import bpy
import mathutils

args = sys.argv[sys.argv.index("--") + 1:]
root, out_dir = os.path.abspath(args[0]), os.path.abspath(args[1])
env = os.path.join(root, "public/assets/env")
manifest = json.load(open(os.path.join(env, "manifest.json")))
HDR = os.path.join(env, "sky/qwantani_sunset_puresky_1k.hdr")
os.makedirs(out_dir, exist_ok=True)


def scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.eevee.taa_render_samples = 48
    sc.render.resolution_x = sc.render.resolution_y = 800
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_settings.exposure = -0.8
    w = bpy.data.worlds.new("w")
    sc.world = w
    nt = w.node_tree
    e = nt.nodes.new("ShaderNodeTexEnvironment")
    e.image = bpy.data.images.load(HDR)
    nt.links.new(e.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 0.55
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 5.5
    sun.data.color = (1.0, 0.66, 0.38)
    sun.data.angle = math.radians(1.5)
    sun.rotation_euler = (math.radians(90 - 15), 0, math.radians(125))
    sc.collection.objects.link(sun)
    return sc


def image(path, color):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "sRGB" if color else "Non-Color"
    return img


for sid, t in manifest["textures"].items():
    sc = scene()
    bpy.ops.mesh.primitive_plane_add(size=4.0)
    plane = bpy.context.object
    m = bpy.data.materials.new(sid)
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (4.0 / t["sizeM"][0], 4.0 / t["sizeM"][1], 1)
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
    alb = nt.nodes.new("ShaderNodeTexImage")
    alb.image = image(os.path.join(env, t["files"]["albedo_2k"]["file"]), True)
    orm = nt.nodes.new("ShaderNodeTexImage")
    orm.image = image(os.path.join(env, t["files"]["orm_2k"]["file"]), False)
    nor = nt.nodes.new("ShaderNodeTexImage")
    nor.image = image(os.path.join(env, t["files"]["normal_2k"]["file"]), False)
    for n in (alb, orm, nor):
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(alb.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(orm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    plane.data.materials.append(m)

    # surrounding dark ground and a 1.75 m scale reference at the back-left corner
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, -0.005))
    g = bpy.context.object
    gm = bpy.data.materials.new("g")
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.05, 0.055, 1)
    g.data.materials.append(gm)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.2, depth=1.35, location=(-1.6, 1.6, 0.2 + 0.675))
    c1 = bpy.context.object
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.2, location=(-1.6, 1.6, 1.55))
    c2 = bpy.context.object
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.2, location=(-1.6, 1.6, 0.2))
    c3 = bpy.context.object
    cm = bpy.data.materials.new("c")
    cm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.5, 0.52, 1)
    for o in (c1, c2, c3):
        o.data.materials.append(cm)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 30
    target = mathutils.Vector((0, 0.45, 0.0))
    cam.location = mathutils.Vector((0.0, -3.9, 2.55))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(out_dir, f"{sid}.png")
    bpy.ops.render.render(write_still=True)
    print("TEXTURE", sid)
