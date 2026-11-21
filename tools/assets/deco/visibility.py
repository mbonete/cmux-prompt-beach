"""Spot visibility check on the final glTF files (run inside Blender).

Every agent spot must stay visible from the cameras the client uses: the
three-quarter overview (about 40-50 degrees tilt) and the close-up that frames
one agent (about 27-35 degrees tilt, 14-16 m away), both from the +Z side of
the plot (the co-working building is turned 90 degrees, so its "+Z side" is
local -X). For each spot we cast rays from points on a stand-in person (head,
upper chest, and the head of the same person standing up to wave) toward those
cameras and fail if the building blocks them: an umbrella, awning, canopy or
roof over a spot shows up here.

It also checks that a straight-down ray from every light_<n> empty lands on the
floor it declares (extras.floor_y), the way the client places its light pools.

    blender -b --factory-startup --python tools/assets/deco/build_kit.py -- --visibility-only
"""
import math
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from kit.config import OUT  # noqa: E402

TILTS = (27.0, 35.0, 45.0)
YAWS = (-25.0, 0.0, 25.0)
CAM_YAW = {"plot_coworking": -90.0}
MAX_BLOCKED = 0.25  # share of (point, direction) rays a spot may lose


def _gl(v):
    return Vector((v[0], -v[2], v[1]))


def _points(kind, seat_h):
    """Sample points in the spot's glTF frame (+Z forward, +Y up)."""
    sh = seat_h or 0.46
    if kind == "lounger":
        pts = [(0, sh + 0.55, -0.56), (0.1, sh + 0.5, -0.5), (0, sh + 0.35, -0.3), (0, sh + 0.18, 0.3)]
    elif kind == "standing":
        pts = [(0, 1.62, 0), (0.12, 1.5, 0), (-0.12, 1.5, 0), (0, 1.3, 0)]
    else:
        pts = [(0, sh + 0.76, -0.04), (0.1, sh + 0.7, -0.04), (-0.1, sh + 0.7, -0.04), (0, sh + 0.5, 0.0)]
    stand = [(0, 1.62, 0.0)]  # the same person standing to wave ("needs you")
    return pts, stand


MIN_EDGE = 0.03  # thinner parts (festoon wires, tube frames, bevel strips) never hide a person


def _bvh(objs):
    """Occluders: every triangle except bulbs and very thin ones."""
    verts, tris = [], []
    for ob in objs:
        if ob.type != "MESH":
            continue
        me = ob.data
        me.calc_loop_triangles()
        M = ob.matrix_world
        base = len(verts)
        verts.extend(M @ v.co for v in me.vertices)
        mats = [m.name if m else "" for m in me.materials]
        for lt in me.loop_triangles:
            if mats[lt.material_index].startswith("bulb"):
                continue
            a, b, c = (verts[base + i] for i in lt.vertices)
            if min((a - b).length, (b - c).length, (c - a).length) < MIN_EDGE:
                continue
            tris.append(tuple(base + i for i in lt.vertices))
    return BVHTree.FromPolygons(verts, tris)


def check_plot(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(OUT / f"{name}.gltf"))
    objs = list(bpy.data.objects)
    tree = _bvh(objs)
    base = CAM_YAW.get(name, 0.0)
    report = []
    for ob in sorted((o for o in objs if o.type == "EMPTY" and o.name.startswith("spot_")), key=lambda o: o.name):
        kind = ob.get("spot_kind", "standing")
        pts, stand = _points(kind, ob.get("seat_h"))
        M = ob.matrix_world
        # standing-up point: the root of a stool spot is on the footrest
        root_y = M.translation.z
        blocked = total = 0
        worst = []
        for t in TILTS:
            for yw in YAWS:
                a = math.radians(base + yw)
                tt = math.radians(t)
                d = _gl((math.sin(a) * math.cos(tt), math.sin(tt), math.cos(a) * math.cos(tt))).normalized()
                for p in pts + stand:
                    w = M @ _gl(p)
                    if p in stand and kind == "stool":
                        w.z -= 0.29  # stands on the floor, not the footrest
                    hit = tree.ray_cast(w + d * 0.06, d, 60.0)
                    total += 1
                    if hit[0] is not None:
                        blocked += 1
                        if yw == 0.0 and p == pts[0]:
                            worst.append(t)
        share = blocked / total
        ok = share <= MAX_BLOCKED and not worst
        report.append((ob.name, kind, share, worst, ok))
    return report


def light_floors(tree, objs, tol=0.1):
    """The client finds each light pool's floor with a downward ray (first
    upward-facing hit more than 0.6 m below the light). It must land on the
    floor the building declares (extras.floor_y), not on a table, umbrella
    or pool. Returns the problems."""
    bad = []
    down = Vector((0, 0, -1))
    for ob in sorted((o for o in objs if o.type == "EMPTY" and o.name.startswith("light_")), key=lambda o: o.name):
        start = ob.matrix_world.translation.copy()
        fy = float(ob.get("floor_y", 0.0))
        travelled, hit = 0.0, None
        for _ in range(32):
            loc, nrm, _i, dist = tree.ray_cast(start, down, 50.0)
            if loc is None:
                break
            travelled += dist
            if travelled > 0.6 and nrm.z > 0.7:
                hit = loc.z
                break
            start = loc + down * 0.001
            travelled += 0.001
        if hit is None or abs(hit - fy) > tol:
            bad.append(f"{ob.name} floor_y {fy:.2f} but the floor below is at "
                       + ("nothing" if hit is None else f"{hit:.2f}"))
    return bad


def _all_tris(objs):
    verts, tris = [], []
    for ob in objs:
        if ob.type != "MESH":
            continue
        me = ob.data
        me.calc_loop_triangles()
        base = len(verts)
        verts.extend(ob.matrix_world @ v.co for v in me.vertices)
        tris.extend(tuple(base + i for i in lt.vertices) for lt in me.loop_triangles)
    return BVHTree.FromPolygons(verts, tris)


def run(names):
    bad = []
    for n in names:
        if not n.startswith("plot_"):
            continue
        rep = check_plot(n)
        objs = list(bpy.data.objects)
        for msg in light_floors(_all_tris(objs), objs):
            bad.append(f"{n} {msg}")
        line = "  ".join(f"{s}:{k[:5]}{'' if ok else '!'}{round(sh * 100)}%" for (s, k, sh, w, ok) in rep)
        print(f"[visibility] {n:20s} {line}")
        for (s, k, sh, w, ok) in rep:
            if not ok:
                bad.append(f"{n} {s} ({k}): {round(sh * 100)}% of rays blocked"
                           + (f", head hidden at {w} deg" if w else ""))
    if bad:
        print("[visibility] problems:\n  " + "\n  ".join(bad))
    else:
        print("[visibility] all spots visible from the +Z cameras; every light pool lands on its floor")
    return bad
