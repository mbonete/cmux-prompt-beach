"""Eevee previews of the final street-kit glTF files (what ships, not the
build scene), at golden hour and at night, into assets-src/_previews/street/.

    blender -b --factory-startup --python tools/assets/street/build_street.py -- --preview-only [--only a,b]

Tintable materials get a sample tint; emissive ones are off by day and on at
night. A contact sheet (sheet_day.png, sheet_night.png) is assembled with
ImageMagick when it is available.
"""
import json
import math
import shutil
import subprocess
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = REPO / "public" / "assets" / "street"
PREV = REPO / "assets-src" / "_previews" / "street"
HDRI_DAY = REPO / "assets-src/polyhaven/hdri/qwantani_sunset_puresky_4k.hdr"
HDRI_NIGHT = REPO / "assets-src/polyhaven/hdri/qwantani_night_puresky_4k.hdr"

TINTS = {"carpaint": (0.85, 0.32, 0.24), "paint": (0.55, 0.85, 0.72), "canvas": (0.9, 0.35, 0.3),
         "cushion": (0.25, 0.62, 0.66), "towel": (0.95, 0.55, 0.25)}
PER_ASSET_TINT = {"car_compact": (0.62, 0.8, 0.86), "car_van": (0.9, 0.9, 0.88), "car_convertible": (0.92, 0.62, 0.66),
                  "lifeguard_tower": (0.96, 0.66, 0.6), "boat_cruiser": (0.08, 0.16, 0.3), "boat_sail": (0.1, 0.45, 0.5),
                  "blimp": (0.2, 0.55, 0.62), "helicopter": (0.85, 0.3, 0.2)}


def gl(v):
    return Vector((v[0], -v[2], v[1]))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def world(night):
    sc = bpy.context.scene
    w = bpy.data.worlds.new("w")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    hd = HDRI_NIGHT if night else HDRI_DAY
    if hd.exists():
        env.image = bpy.data.images.load(str(hd))
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    else:
        bg.inputs["Color"].default_value = (0.05, 0.06, 0.1, 1) if night else (0.8, 0.6, 0.5, 1)
    bg.inputs["Strength"].default_value = 0.9 if night else 0.6
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def sun(night):
    li = bpy.data.lights.new("sun", "SUN")
    li.energy = 0.15 if night else 5.5
    li.color = (0.6, 0.7, 1.0) if night else (1.0, 0.66, 0.42)
    li.angle = math.radians(1.5)
    ob = bpy.data.objects.new("sun", li)
    bpy.context.scene.collection.objects.link(ob)
    to_sun = gl((-0.6, 0.32, -0.73)).normalized()
    ob.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()


def ground(color):
    me = bpy.data.meshes.new("ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=400)
    bm.to_mesh(me)
    ob = bpy.data.objects.new("ground", me)
    bpy.context.scene.collection.objects.link(ob)
    m = bpy.data.materials.new("ground")
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = 0.9
    me.materials.append(m)


def settings(res=(800, 600), samples=48):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.eevee.taa_render_samples = samples
    try:
        sc.eevee.use_raytracing = True
        sc.eevee.use_shadows = True
    except Exception:
        pass
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    sc.render.image_settings.file_format = "PNG"


def camera(bmin, bmax, yaw=35.0, tilt=22.0, fov=28.0, pad=1.18):
    c = [(a + b) / 2 for a, b in zip(bmin, bmax)]
    ext = Vector([b - a for a, b in zip(bmin, bmax)])
    rad = ext.length / 2 * pad
    d = rad / math.tan(math.radians(fov) / 2)
    t, y = math.radians(tilt), math.radians(yaw)
    pos = (c[0] + d * math.cos(t) * math.sin(y), c[1] + d * math.sin(t), c[2] + d * math.cos(t) * math.cos(y))
    cam = bpy.data.cameras.new("cam")
    cam.sensor_fit = "VERTICAL"
    cam.angle = math.radians(fov)
    cam.clip_start = 0.05
    cam.clip_end = 2000
    ob = bpy.data.objects.new("cam", cam)
    bpy.context.scene.collection.objects.link(ob)
    p, tt = gl(pos), gl(c)
    ob.location = p
    ob.rotation_euler = (tt - p).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = ob


def dress(name, night):
    for m in bpy.data.materials:
        if not m.use_nodes:
            continue
        base = m.name.split(".")[0]
        for n in m.node_tree.nodes:
            if n.type != "BSDF_PRINCIPLED":
                continue
            if base in TINTS:
                col = PER_ASSET_TINT.get(name, TINTS[base]) if base in ("carpaint", "paint") else TINTS[base]
                if not n.inputs["Base Color"].is_linked:
                    n.inputs["Base Color"].default_value = (*col, 1)
                else:
                    # textured (towel): multiply through a mix node
                    link = n.inputs["Base Color"].links[0]
                    mix = m.node_tree.nodes.new("ShaderNodeMix")
                    mix.data_type = "RGBA"
                    mix.blend_type = "MULTIPLY"
                    mix.inputs[0].default_value = 1.0
                    m.node_tree.links.new(link.from_socket, mix.inputs[6])
                    mix.inputs[7].default_value = (*col, 1)
                    m.node_tree.links.new(mix.outputs[2], n.inputs["Base Color"])
            if base in ("bulb", "headlight", "taillight"):
                n.inputs["Emission Strength"].default_value = (n.inputs["Emission Strength"].default_value if night else 0.0)


def render_asset(name, info, night):
    reset()
    world(night)
    sun(night)
    ground((0.55, 0.47, 0.38) if info["kind"] in ("beach",) else (0.12, 0.2, 0.24) if info["kind"] == "boat" else (0.2, 0.2, 0.21))
    settings()
    bpy.ops.import_scene.gltf(filepath=str(OUT / f"{name}.gltf"))
    dress(name, night)
    if info["kind"] == "boat":
        wl = (info.get("extras") or {}).get("waterline", 0)
        for ob in bpy.data.objects:
            if ob.parent is None and ob.type != "LIGHT" and ob.name not in ("ground",):
                ob.location.z -= wl
        bmin = list(info["bounds"]["min"])
        bmax = list(info["bounds"]["max"])
        bmin[1] -= wl
        bmax[1] -= wl
    else:
        bmin, bmax = info["bounds"]["min"], info["bounds"]["max"]
    camera(bmin, bmax)
    path = PREV / f"{name}_{'night' if night else 'day'}.png"
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return path


def run(names):
    PREV.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((OUT / "manifest.json").read_text())
    days, nights = [], []
    for n in names:
        info = manifest["assets"].get(n)
        if not info:
            continue
        days.append(render_asset(n, info, False))
        if info["emissive"]:
            nights.append(render_asset(n, info, True))
        print(f"[previews] {n}")
    magick = shutil.which("magick")
    if magick:
        for label, files in (("day", days), ("night", nights)):
            if files:
                subprocess.run([magick, "montage", *map(str, files), "-tile", "5x", "-geometry", "400x300+4+4",
                                "-background", "#111", str(PREV / f"sheet_{label}.png")], check=False)
