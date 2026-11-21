"""Converts a non-glTF source (FBX, OBJ, DAE, .blend, USD) into a GLB the Node
prop pipeline can read. Transforms are kept as authored; units are metres.

    blender -b --factory-startup --python convert.py -- <src> <out.glb>
"""
import os
import sys

import bpy

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
ext = os.path.splitext(src)[1].lower()
if ext == ".blend":
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    elif ext == ".dae":
        bpy.ops.wm.collada_import(filepath=src)
    elif ext in (".usd", ".usda", ".usdc", ".usdz"):
        bpy.ops.wm.usd_import(filepath=src)
    else:
        raise SystemExit(f"unsupported source format: {ext}")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_image_format="AUTO",
                          export_apply=True, export_yup=True, export_cameras=False, export_lights=False)
print("converted", src, "->", out)
