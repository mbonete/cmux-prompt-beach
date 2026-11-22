"""Custom terrace furniture, modelled into the building files.

Spot-bearing pieces are built in a local frame whose origin is the person's
root (on the floor, or on the footrest for stools) and whose +Z is the
direction the person faces. Each returns the spot and prop empties it implies,
already transformed to plot space.
"""
import math

from .config import SEAT_H, DESK_H, STOOL_RAISE, LOUNGER_SEAT_H, AWNING_STRIPE_PERIOD

DESK_EDGE = 0.30   # root to the near edge of the desk/counter, along the facing axis
SWATCH_COLOUR = (0.25, 0.5)  # awning texture: coloured stripe
SWATCH_WHITE = (0.75, 0.5)


def spot(mb, kind, local=(0, 0, 0), yaw=0.0, **extra):
    d = {"kind": kind, "pos": mb.tp(local), "yaw": mb.tyaw(yaw), "seat_h": None, "table_h": None}
    d.update(extra)
    return d


def prop(mb, pid, local, yaw=0.0):
    return {"id": pid, "pos": mb.tp(local), "yaw": mb.tyaw(yaw)}


# ---------------------------------------------------------------------------
# generic helpers
# ---------------------------------------------------------------------------
def extrude_x(mb, prof, x0, x1, mat, pin=None, stripes=False, caps=True):
    """Extrude a closed (z, y) profile along X from x0 to x1."""
    n = len(prof)
    area = 0.0
    for i in range(n):
        z0, y0 = prof[i]
        z1, y1 = prof[(i + 1) % n]
        area += z0 * y1 - z1 * y0
    sgn = 1.0 if area > 0 else -1.0
    acc = 0.0
    for i in range(n):
        (z0, y0), (z1, y1) = prof[i], prof[(i + 1) % n]
        dz, dy = z1 - z0, y1 - y0
        L = math.hypot(dz, dy)
        if L < 1e-7:
            continue
        # outward normal: right-perp for CCW (area>0) in (z right, y up)
        nz_, ny_ = dy * sgn, -dz * sgn
        pts = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z1), (x0, y1, z1)]
        if pin is not None:
            uvs = [pin] * 4
        elif stripes:
            uvs = [(x0 / AWNING_STRIPE_PERIOD, acc / 2.0), (x1 / AWNING_STRIPE_PERIOD, acc / 2.0),
                   (x1 / AWNING_STRIPE_PERIOD, (acc + L) / 2.0), (x0 / AWNING_STRIPE_PERIOD, (acc + L) / 2.0)]
        else:
            uvs = None
        mb.poly_n(pts, mat, (0, ny_, nz_), uvs)
        acc += L
    if caps:
        uv0 = [pin] * n if pin is not None else None
        mb.poly_n([(x0, y, z) for z, y in prof], mat, (-1, 0, 0), uv0)
        mb.poly_n([(x1, y, z) for z, y in prof], mat, (1, 0, 0), uv0)


def pinned_box(mb, x0, x1, y0, y1, z0, z1, mat, pin, bevel=0.0, segs=2):
    mb.box(x0, x1, y0, y1, z0, z1, mat, bevel=bevel, segs=segs)
    _pin_region(mb, (x0, x1, y0, y1, z0, z1), pin)


def _pin_region(mb, bounds, pin):
    """Pin UVs of all faces whose vertices lie in the (local) box bounds."""
    x0, x1, y0, y1, z0, z1 = bounds
    corners = [mb.tp((x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    zs = [c[2] for c in corners]
    e = 1e-4
    lo = (min(xs) - e, min(ys) - e, min(zs) - e)
    hi = (max(xs) + e, max(ys) + e, max(zs) + e)
    mb.bm.faces.ensure_lookup_table()
    nf = len(mb.bm.faces)
    for i in range(max(0, nf - 400), nf):
        f = mb.bm.faces[i]
        ok = True
        for v in f.verts:
            x, y, z = v.co.x, v.co.z, -v.co.y
            if not (lo[0] <= x <= hi[0] and lo[1] <= y <= hi[1] and lo[2] <= z <= hi[2]):
                ok = False
                break
        if ok:
            for l in f.loops:
                l[mb.uv].uv = pin
            f[mb.lock] = 1


def tube_path(points, r=0.03, seg=4):
    """Round the corners of a polyline (3D) with small arcs."""
    out = [points[0]]
    for i in range(1, len(points) - 1):
        a, b, c = points[i - 1], points[i], points[i + 1]
        da = [b[k] - a[k] for k in range(3)]
        dc = [c[k] - b[k] for k in range(3)]
        la = math.sqrt(sum(x * x for x in da))
        lc = math.sqrt(sum(x * x for x in dc))
        rr = min(r, la * 0.45, lc * 0.45)
        p0 = [b[k] - da[k] / la * rr for k in range(3)]
        p1 = [b[k] + dc[k] / lc * rr for k in range(3)]
        for j in range(seg + 1):
            t = j / seg
            # quadratic bezier p0 -> b -> p1
            q = [(1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * b[k] + t * t * p1[k] for k in range(3)]
            out.append(tuple(q))
    out.append(points[-1])
    return out


# ---------------------------------------------------------------------------
# seating and work
# ---------------------------------------------------------------------------
def chair(mb, cushion=SWATCH_COLOUR):
    """Tubular steel cantilever chair centred on the local origin, facing +Z."""
    s = SEAT_H
    pinned_box(mb, -0.215, 0.215, s - 0.065, s, -0.22, 0.19, "awning", cushion, bevel=0.025)
    # backrest: tilted cushion
    back = [(-0.23, s + 0.02), (-0.19, s + 0.02), (-0.24, s + 0.40), (-0.28, s + 0.40)]
    extrude_x(mb, back, -0.205, 0.205, "awning", pin=cushion)
    for x in (-0.2, 0.2):
        pts = tube_path([(x, s + 0.38, -0.27), (x, s - 0.05, -0.215), (x, s - 0.075, 0.17),
                         (x, 0.02, 0.24), (x, 0.012, -0.24)], r=0.07, seg=4)
        mb.tube(pts, 0.011, "metal", seg=6)
    mb.tube([(-0.2, 0.012, -0.24), (0.2, 0.012, -0.24)], 0.011, "metal", seg=6)


def desk_set(mb, width=1.2, depth=0.62, laptop=True, chair_on=True):
    """Desk in front of the local origin (the seated person's root)."""
    z0 = DESK_EDGE
    z1 = z0 + depth
    t = 0.035
    from .geo import rrect
    top = rrect(-width / 2, width / 2, z0, z1, (0.05, 0.05, 0.05, 0.05), seg=3)
    # rrect works in plot space, so build the slab via a tiny local path
    mb.slab(top, DESK_H - t, DESK_H, "trim", bevel=0.012, segs=2)
    for x in (-width / 2 + 0.06, width / 2 - 0.06):
        pts = tube_path([(x, 0.012, z0 + 0.06), (x, DESK_H - t, z0 + 0.06), (x, DESK_H - t, z1 - 0.06),
                         (x, 0.012, z1 - 0.06)], r=0.06, seg=3)
        mb.tube(pts, 0.014, "metal", seg=6)
        mb.tube([(x, 0.012, z0 + 0.06), (x, 0.012, z1 - 0.06)], 0.014, "metal", seg=6)
    # a slim drawer box under the top, Deco rounded
    mb.box(width / 2 - 0.42, width / 2 - 0.08, DESK_H - t - 0.12, DESK_H - t, z0 + 0.08, z1 - 0.05, "wood",
           bevel=0.015, segs=2)
    if chair_on:
        chair(mb)
    out = {"spot": spot(mb, "desk", seat_h=SEAT_H, table_h=DESK_H, table_edge=DESK_EDGE), "props": []}
    if laptop:
        out["props"].append(prop(mb, "classic_laptop", (0, DESK_H, z0 + 0.25), 180))
    return out


def stool(mb, cushion=SWATCH_COLOUR):
    """Chrome bar stool centred on the local origin (floor level)."""
    seat = STOOL_RAISE + SEAT_H
    mb.cylinder(0, 0, 0.2, 0.0, 0.025, "metal", seg=16, bevel=0.01)
    mb.cylinder(0, 0, 0.028, 0.025, seat - 0.06, "metal", seg=8, caps=False)
    ring = [(0.19 * math.cos(2 * math.pi * k / 16), STOOL_RAISE, 0.19 * math.sin(2 * math.pi * k / 16)) for k in range(16)]
    mb.tube(ring, 0.011, "metal", seg=6, closed=True)
    mb.tube([(-0.19, STOOL_RAISE, 0), (0.19, STOOL_RAISE, 0)], 0.009, "metal", seg=5)
    mb.tube([(0, STOOL_RAISE, -0.19), (0, STOOL_RAISE, 0.19)], 0.009, "metal", seg=5)
    mb.lathe([(0, seat - 0.07), (0.17, seat - 0.07), (0.19, seat - 0.05), (0.195, seat - 0.025),
              (0.18, seat - 0.004), (0.15, seat), (0, seat)], 0, 0, "awning", seg=16)
    _pin_last_lathe(mb, 16 * 6, cushion)


def _pin_last_lathe(mb, nfaces, pin):
    mb.bm.faces.ensure_lookup_table()
    nf = len(mb.bm.faces)
    for i in range(max(0, nf - nfaces), nf):
        f = mb.bm.faces[i]
        for l in f.loops:
            l[mb.uv].uv = pin
        f[mb.lock] = 1


def lounger(mb, cushion="stripes"):
    """Sun lounger. Local origin = root under the hips; +Z toward the feet."""
    h = LOUNGER_SEAT_H
    w = 0.33
    # frame rails (wood) and legs
    for x in (-w, w):
        mb.box(x - 0.025, x + 0.025, h - 0.15, h - 0.08, -0.95, 1.15, "wood", bevel=0.01, segs=1)
        for z in (-0.85, 1.05):
            mb.box(x - 0.025, x + 0.025, 0.0, h - 0.12, z - 0.025, z + 0.025, "wood", bevel=0.008, segs=1)
    mb.box(-w, w, h - 0.15, h - 0.09, 1.10, 1.15, "wood", bevel=0.008, segs=1)
    # cushion: flat seat part then the raised backrest at 38 degrees
    a = math.radians(38)
    L_back = 0.78
    zb, yb = -0.12, h
    ztop, ytop = zb - L_back * math.cos(a), yb + L_back * math.sin(a)
    t = 0.07
    prof = [(1.12, h - t), (1.14, h - t * 0.5), (1.12, h), (zb, yb),
            (ztop, ytop), (ztop - 0.03, ytop - 0.03), (ztop + t * math.sin(a) - 0.0, ytop - t * math.cos(a) - 0.02),
            (zb + 0.04, h - t)]
    extrude_x(mb, prof, -w + 0.02, w - 0.02, "awning", stripes=(cushion == "stripes"),
              pin=None if cushion == "stripes" else cushion)
    # backrest support strut
    mb.box(-w + 0.04, w - 0.04, h - 0.12, h - 0.08, ztop + 0.05, zb, "wood", bevel=0.005, segs=1)
    return {"spot": spot(mb, "lounger", seat_h=h), "props": []}


def bench(mb, length=1.7, slats=True):
    """Backless Deco bench: two rounded stucco plinths and teak slats."""
    s = SEAT_H
    for x in (-length / 2 + 0.18, length / 2 - 0.18):
        mb.box(x - 0.09, x + 0.09, 0.0, s - 0.045, -0.2, 0.2, "trim", bevel=0.03, segs=2)
    for k in range(4):
        z = -0.19 + k * 0.1
        mb.box(-length / 2, length / 2, s - 0.045, s, z, z + 0.085, "wood", bevel=0.008, segs=1)
    return {"spot": spot(mb, "bench", seat_h=s), "props": []}


def bench_back(mb, length=1.8):
    """Bench with a backrest; local origin is the root of the middle sitter."""
    s = SEAT_H
    out = bench(mb, length)
    for k in range(3):
        y = s + 0.12 + k * 0.13
        mb.box(-length / 2, length / 2, y, y + 0.09, -0.27 - k * 0.025, -0.24 - k * 0.025, "wood", bevel=0.008, segs=1)
    for x in (-length / 2 + 0.18, length / 2 - 0.18):
        mb.box(x - 0.03, x + 0.03, s - 0.05, s + 0.48, -0.28, -0.22, "metal", bevel=0.008, segs=1)
    return out


def umbrella(mb, r=1.3, h=2.5, gores=10, base=True):
    """Beach/patio umbrella with alternating gores; local origin at the pole foot."""
    if base:
        mb.cylinder(0, 0, 0.24, 0.0, 0.07, "concrete", seg=16, bevel=0.02)
    mb.cylinder(0, 0, 0.022, 0.07, h + 0.12, "metal", seg=8, caps=False)
    rim_y = h - 0.32
    mid_r, mid_y = r * 0.55, h - 0.1
    apex = (0, h + 0.02, 0)
    for k in range(gores):
        a0 = 2 * math.pi * k / gores
        a1 = 2 * math.pi * (k + 1) / gores
        pin = SWATCH_COLOUR if k % 2 == 0 else SWATCH_WHITE
        p = lambda rad, y, a: (rad * math.cos(a), y, rad * math.sin(a))
        am = (a0 + a1) / 2
        up = (0, 1, 0)
        mb.poly_n([apex, p(mid_r, mid_y, a0), p(mid_r, mid_y, a1)], "awning", up, [pin] * 3)
        mb.poly_n([p(mid_r, mid_y, a0), p(r, rim_y, a0), p(r, rim_y, a1), p(mid_r, mid_y, a1)], "awning", up, [pin] * 4)
        # valance flap
        out = (math.cos(am), 0, math.sin(am))
        mb.poly_n([p(r, rim_y, a0), p(r, rim_y - 0.14, a0), p(r, rim_y - 0.14, a1), p(r, rim_y, a1)], "awning", out,
                  [pin] * 4)
    mb.cylinder(0, 0, 0.035, h + 0.02, h + 0.16, "metal", seg=8, bevel=0.01)


def planter(mb, x0, x1, z0, z1, h=0.55, mat="planter", rim="trim", r=0.12, soil_drop=0.08):
    """Rounded box planter (plot space). Returns the soil centre."""
    from .geo import rrect
    p = rrect(x0, x1, z0, z1, (r, r, r, r), seg=3)
    mb.slab(p, 0.0, h - 0.06, mat, bevel=0.02, segs=1, top=False, bottom=False)
    # rim coping
    sec = [(0.0, h - 0.06), (0.03, h - 0.06), (0.03, h - 0.01), (0.015, h), (-0.09, h), (-0.09, h - 0.06 - soil_drop)]
    mb.ring_sweep(p, sec, rim)
    inner = p.offset(-0.09)
    mb.poly([(q[0], h - 0.06 - soil_drop, q[1]) for q in reversed(inner.pts)], "soil")
    return ((x0 + x1) / 2, h - 0.06 - soil_drop, (z0 + z1) / 2)


def round_planter(mb, cx, cz, r=0.4, h=0.6, mat="planter", rim="trim"):
    """Round pot filled with soil a few centimetres below its rim. Returns the soil centre."""
    mb.lathe([(0, 0.0), (r * 0.82, 0.0), (r * 0.86, 0.04), (r, h - 0.06), (r + 0.03, h - 0.05),
              (r + 0.03, h - 0.01), (r + 0.01, h), (r - 0.05, h), (r - 0.06, h - 0.1)], cx, cz, mat, seg=16)
    # soil, slightly domed, meeting the inner wall
    mb.lathe([(r - 0.055, h - 0.075), (r * 0.5, h - 0.065), (0, h - 0.06)], cx, cz, "soil", seg=16)
    return (cx, h - 0.06, cz)


def sign_board(mb, x0, x1, y0, y1, z, depth=0.12, face="trim", frame="metal", neon=True):
    """Blank sign board facing +Z with a metal frame and a neon outline.
    Returns the face rectangle (for an optional separate 0-1 UV node)."""
    mb.box(x0, x1, y0, y1, z - depth, z, frame, bevel=0.02, segs=2)
    if neon:
        inset = 0.07
        pts = [(x0 + inset, y0 + inset, z + 0.035), (x1 - inset, y0 + inset, z + 0.035),
               (x1 - inset, y1 - inset, z + 0.035), (x0 + inset, y1 - inset, z + 0.035)]
        mb.tube(tube_path(pts + [pts[0], pts[1]], r=0.06, seg=3)[1:-1], 0.018, "neon_accent", seg=6, closed=True)
    return (x0 + 0.04, x1 - 0.04, y0 + 0.04, y1 - 0.04, z + 0.004)


def cafe_table_set(mb, r=0.36, laptop=True, top="wood", cushion=SWATCH_COLOUR, umbrella_h=None):
    """Round pedestal table in front of a seated person (local origin)."""
    zc = DESK_EDGE + r
    mb.lathe([(0, DESK_H - 0.035), (r - 0.012, DESK_H - 0.035), (r, DESK_H - 0.018), (r - 0.012, DESK_H),
              (0, DESK_H)], 0, zc, top, seg=20)
    mb.cylinder(0, zc, 0.032, 0.04, DESK_H - 0.035, "metal", seg=8, caps=False)
    mb.lathe([(0, 0), (0.26, 0), (0.26, 0.018), (0.06, 0.05), (0, 0.05)], 0, zc, "metal", seg=16)
    chair(mb, cushion)
    if umbrella_h:
        with mb.at(0, 0, zc):
            umbrella(mb, r=1.25, h=umbrella_h, base=False)
    out = {"spot": spot(mb, "desk", seat_h=SEAT_H, table_h=DESK_H, table_edge=DESK_EDGE), "props": []}
    if laptop:
        out["props"].append(prop(mb, "classic_laptop", (0, DESK_H, DESK_EDGE + 0.24), 180))
    return out


def poseur_table(mb, h=1.05, r=0.32, top="terrazzo"):
    """Standing table in front of a standing person (local origin)."""
    zc = 0.28 + r
    mb.lathe([(0, h - 0.04), (r - 0.012, h - 0.04), (r, h - 0.02), (r - 0.012, h), (0, h)], 0, zc, top, seg=20)
    mb.cylinder(0, zc, 0.035, 0.04, h - 0.04, "metal", seg=8, caps=False)
    mb.lathe([(0, 0), (0.24, 0), (0.24, 0.018), (0.06, 0.05), (0, 0.05)], 0, zc, "metal", seg=16)
    return {"spot": spot(mb, "standing", table_h=h, table_edge=0.28), "props": []}


def surfboard(mb, length=2.3, width=0.52, thick=0.06, pin=SWATCH_COLOUR):
    """Board lying in the local XZ plane, nose toward +Z, centred on the origin."""
    n = 14
    outline = []
    for k in range(n + 1):
        t = k / n
        z = -length / 2 + length * t
        w = width / 2 * math.sin(math.pi * (0.06 + 0.94 * t)) ** 0.7
        outline.append((w, z))
    left = [(-w, z) for (w, z) in outline]
    right = [(w, z) for (w, z) in reversed(outline)]
    ring = left + right[1:-1]
    top = [(x, thick / 2, z) for (x, z) in ring]
    bot = [(x, -thick / 2, z) for (x, z) in ring]
    mb.poly_n(top, "awning", (0, 1, 0), [pin] * len(top))
    mb.poly_n(bot, "awning", (0, -1, 0), [pin] * len(bot))
    m = len(ring)
    for i in range(m):
        j = (i + 1) % m
        a, b = ring[i], ring[j]
        nx, nz = (b[1] - a[1]), -(b[0] - a[0])
        mb.poly_n([bot[i], bot[j], top[j], top[i]], "trim", (-nx, 0, -nz) if _ccw(ring) < 0 else (nx, 0, nz))


def _ccw(pts):
    a = 0.0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        a += x0 * z1 - x1 * z0
    return a
