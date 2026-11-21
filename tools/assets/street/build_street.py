"""Street kit: deterministic headless build of the background-life assets.

    blender -b --factory-startup --python tools/assets/street/build_street.py
    blender -b --factory-startup --python tools/assets/street/build_street.py -- --only car_sedan,lamp_deco --previews
    blender -b --factory-startup --python tools/assets/street/build_street.py -- --preview-only

Steps: build each asset in a fresh scene from the recipes in kit/ -> export
glTF (geometry, normals, UVs, material names, child nodes and empties) to
assets-src/_build/street/ -> finalize.mjs applies the PBR materials and
WebP textures and writes public/assets/street/ with manifest.json and
credits.json. --previews renders Eevee previews of the final files into
assets-src/_previews/street/.

Everything is original and procedural: no downloads, no third-party meshes.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
STAGE = REPO / "assets-src" / "_build" / "street"
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True

from kit import props as P  # noqa: E402
from kit import vehicles as V  # noqa: E402
from kit.mesh import B, finish, tri_count  # noqa: E402

BUILDERS = {
    "lamp_deco": P.lamp_deco,
    "lamp_promenade": P.lamp_promenade,
    "lifeguard_tower": P.lifeguard_tower,
    "umbrella": P.umbrella,
    "lounger": P.lounger,
    "towel": P.towel,
    **{k: (lambda k=k: V.car(V.CARS[k])) for k in V.CARS},
    "boat_speed": V.speedboat,
    "boat_sail": V.sailboat,
    "boat_cruiser": V.cruiser,
    "helicopter": V.helicopter,
    "blimp": V.blimp,
}

BUDGET = {"street": 4000, "beach": 6000, "car": 4000, "boat": 5000, "air": 4000}
BUDGET_ID = {"blimp": 3000, "helicopter": 4000}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--no-finalize", action="store_true")
    ap.add_argument("--previews", action="store_true")
    ap.add_argument("--preview-only", action="store_true")
    return ap.parse_args(argv)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects, bpy.data.images):
        for item in list(coll):
            coll.remove(item)


def export(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLTF_SEPARATE", export_image_format="NONE",
        export_materials="EXPORT", export_extras=True, export_apply=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=False, export_vertex_color="NONE",
        export_cameras=False, export_lights=False, export_animations=False, export_skins=False,
        export_morph=False, use_selection=False,
    )


def build_one(name):
    a = BUILDERS[name]()
    reset()
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    for k, v in a.extras.items():
        root[k] = v
    ob = finish(a.mb, f"{name}_body")
    ob.parent = root
    tris = tri_count(ob)
    mats = list(a.mb.mats)
    nodes = []
    for (node, mb, pivot) in a.nodes:
        o2 = finish(mb, node)
        o2.parent = root
        o2.location = B(pivot)
        tris += tri_count(o2)
        nodes.append({"name": node, "pivot": [round(v, 3) for v in pivot]})
        for m in mb.mats:
            if m not in mats:
                mats.append(m)
    empties = []
    for (en, pos, extras) in a.empties:
        e = bpy.data.objects.new(en, None)
        e.empty_display_type = "PLAIN_AXES"
        e.location = B(pos)
        for k, v in (extras or {}).items():
            e[k] = v
        bpy.context.scene.collection.objects.link(e)
        e.parent = root
        empties.append({"name": en, "position": [round(v, 3) for v in pos], **(extras or {})})
    export(STAGE / name / f"{name}.gltf")
    budget = BUDGET_ID.get(name, BUDGET[a.kind])
    if tris > budget:
        raise RuntimeError(f"{name}: {tris} tris over the {budget} budget")
    return {"kind": a.kind, "tris": tris, "notes": a.notes, "materials": mats, "nodes": nodes,
            "empties": empties, "extras": a.extras}


def main():
    args = parse()
    t0 = time.time()
    names = [n for n in BUILDERS if not args.only or n in args.only.split(",")]
    if not args.preview_only:
        spec_path = STAGE / "spec.json"
        spec = json.loads(spec_path.read_text()) if spec_path.exists() else {}
        spec.setdefault("assets", {})
        for n in names:
            t1 = time.time()
            spec["assets"][n] = build_one(n)
            print(f"[street] {n}: {spec['assets'][n]['tris']} tris ({time.time() - t1:.1f}s)")
        spec["assets"] = {k: v for k, v in spec["assets"].items() if k in BUILDERS}
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(json.dumps(spec, indent=1, sort_keys=True))
        if not args.no_finalize:
            subprocess.run(["node", str(HERE / "finalize.mjs"), *names], check=True, cwd=str(REPO))
    if args.previews or args.preview_only:
        import render_previews
        render_previews.run(names)
    print(f"[street] done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
