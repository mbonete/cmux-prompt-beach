"""Deco/MiMo building kit: deterministic headless build.

    blender -b --factory-startup --python tools/assets/deco/build_kit.py
    blender -b --factory-startup --python tools/assets/deco/build_kit.py -- --only plot_deco_hotel --previews

Steps: bake textures -> build each building in a fresh scene -> export glTF
(geometry, UVs, normals, material names, empties with extras) to the stage
folder -> finalize.mjs applies materials and WebP textures and writes
public/assets/buildings/ with manifest.json and credits.json -> check.mjs
validates the output. --previews then renders Eevee previews of the final
files into assets-src/_previews/buildings/.
"""
import argparse
import json

import bpy
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # keep __pycache__ out of the repo

from kit import buildings as BLD  # noqa: E402
from kit import export as X  # noqa: E402
from kit import materials as M  # noqa: E402
from kit import textures as TX  # noqa: E402
from kit.config import STAGE, OUT, REPO, SEAT_H, DESK_H, STOOL_RAISE, LOUNGER_SEAT_H  # noqa: E402


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--no-textures", action="store_true")
    ap.add_argument("--no-finalize", action="store_true")
    ap.add_argument("--previews", action="store_true")
    ap.add_argument("--preview-only", action="store_true")
    return ap.parse_args(argv)


AO_DIST = {"plot": 2.5, "bg": 2.5, "tower": 4.0}
AO_SAMPLES = 64


def build_one(name):
    b = BLD.BUILDERS[name]()
    X.reset()
    rt = X.root(name)
    ob = X.finish_mesh(b.mb, f"{name}_mesh")
    ob.parent = rt
    tris = X.tri_count(ob)
    mats = list(b.mb.mats)
    for node, mbx in b.extra:
        o2 = X.finish_mesh(mbx, node, weighted=False)
        o2.parent = rt
        tris += X.tri_count(o2)
        for m in mbx.mats:
            if m not in mats:
                mats.append(m)
    meshes = [ob] + [o for o in bpy.data.objects if o.type == "MESH" and o is not ob]
    ao_png = STAGE / "ao" / f"ao_{name}.png"
    size = 1024 if b.kind == "plot" else 512
    t_ao = time.time()
    X.bake_ao(meshes, name, size, ao_png, distance=AO_DIST[b.kind], samples=AO_SAMPLES)
    TX.ao_to_webp(ao_png, f"ao_{name}")
    print(f"[deco] {name}: AO baked in {time.time() - t_ao:.1f}s")
    spots = []
    if b.kind == "plot":
        if len(b.spots) != 6:
            raise RuntimeError(f"{name}: expected 6 spots, got {len(b.spots)}")
        # agents fill spots from spot_0: desks first, the stoop/steps last
        order = {"desk": 0, "stool": 1, "bench": 2, "lounger": 3, "standing": 4, "steps": 5}
        b.spots.sort(key=lambda s: order[s["kind"]])
        for i, s in enumerate(b.spots):
            props = {"spot_kind": s["kind"], "spot_index": i}
            for k in ("seat_h", "table_h", "table_edge"):
                if s.get(k) is not None:
                    props[k] = round(float(s[k]), 4)
            X.empty(f"spot_{i}", s["pos"], s["yaw"], rt, props)
            spots.append({"name": f"spot_{i}", "kind": s["kind"], "pos": [round(v, 3) for v in s["pos"]],
                          "yaw": round(s["yaw"], 2)})
        for p in b.props:
            X.empty(f"prop:{p['id']}", p["pos"], p["yaw"], rt, {"prop_id": p["id"]})
    for k, pos in b.anchors.items():
        X.empty(k, pos, 0.0, rt)
    path = STAGE / name / f"{name}.gltf"
    X.export(path)
    spec = {
        "kind": b.kind,
        "ao": f"ao_{name}",
        "tris": tris,
        "notes": b.notes,
        "look": b.look,
        "materials": M.resolve(mats, **{k: v for k, v in b.look.items() if k in ("stucco", "trim", "neon", "awning", "interior")}),
        "spots": spots,
        "props": [{"id": p["id"], "pos": [round(v, 3) for v in p["pos"]], "yaw": round(p["yaw"], 2)} for p in b.props],
    }
    return spec


def main():
    args = parse()
    t0 = time.time()
    names = [n for n in BLD.BUILDERS if not args.only or n in args.only.split(",")]
    if not args.preview_only:
        if not args.no_textures:
            TX.bake_all()
            print(f"[deco] textures baked in {time.time() - t0:.1f}s")
        spec_path = STAGE / "spec.json"
        spec = json.loads(spec_path.read_text()) if spec_path.exists() else {}
        spec.setdefault("buildings", {})
        spec["constants"] = {"seat_h": SEAT_H, "desk_h": DESK_H, "stool_raise": STOOL_RAISE,
                             "lounger_seat_h": LOUNGER_SEAT_H}
        for n in names:
            t1 = time.time()
            spec["buildings"][n] = build_one(n)
            print(f"[deco] {n}: {spec['buildings'][n]['tris']} tris ({time.time() - t1:.1f}s)")
        # keep only buildings that still exist
        spec["buildings"] = {k: v for k, v in spec["buildings"].items() if k in BLD.BUILDERS}
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(json.dumps(spec, indent=1, sort_keys=True))
        if not args.no_finalize:
            subprocess.run(["node", str(HERE / "finalize.mjs"), *names], check=True, cwd=str(REPO))
            subprocess.run(["node", str(HERE / "check.mjs")], check=True, cwd=str(REPO))
    if args.previews or args.preview_only:
        sys.path.insert(0, str(HERE))
        import render_previews
        render_previews.run(names)
    print(f"[deco] done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
