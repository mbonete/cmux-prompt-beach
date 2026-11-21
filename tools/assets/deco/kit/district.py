"""District plot types beyond the look-dev three: the beach bar (hangout), the
co-working overflow and the street's other characters, plus the district
layout written to manifest.json.

Same conventions as buildings.py: glTF space, metres, plots 20 x 16 m centred
on the origin, terrace toward +Z. Every plot also carries its night life
(bulb geometry, light_<n> and palm_<n> empties).
"""
import math

import numpy as np

from . import deco as D
from . import furniture as F
from . import nightlife as N
from .buildings import Building, _o, _sign_face
from .config import SEAT_H, DESK_H, STOOL_RAISE, TERRACE_Y, AWNING_STRIPE_PERIOD
from .geo import MB, Path, rrect, circle_path, stadium

PLANTS = ["anthurium_botany_01", "calathea_orbifolia_01"]


# ---------------------------------------------------------------------------
# helpers shared by the district plots
# ---------------------------------------------------------------------------
def street_lamps(b):
    b.prop("street_lamp_02", (-9.7, 0.0, 7.7), 0.0)
    b.prop("street_lamp_02", (9.7, 0.0, 7.7), 0.0)


def plant(b, soils):
    for k, sp in enumerate(soils):
        b.prop(PLANTS[k % 2], sp, 0.0)


def seat_stool(b, mb, x, floor, z, yaw, ctop, spot=True, laptop=True):
    """Bar stool at plot point (x, z) facing yaw, counter top at ctop (plot y)."""
    with mb.at(x, floor, z, yaw):
        F.stool(mb)
        if spot:
            b.spots.append(F.spot(mb, "stool", (0, STOOL_RAISE, 0), 0.0, seat_h=SEAT_H, table_h=DESK_H,
                                  table_edge=F.DESK_EDGE))
        if laptop:
            b.props.append(F.prop(mb, "classic_laptop", (0, ctop - floor, F.DESK_EDGE + 0.2), 180.0))


def path_counter(b, mb, path, floor, n_stools, spot_ids, body="stucco", top="wood", depth=0.48, over=0.14,
                 lines=True, rail=True, fracs=None):
    """Counter swept along an open path whose normal points at the customers.
    Stools stand on the normal side; spot_ids pick which carry a spot (and a
    laptop). Returns the counter-top height."""
    ctop = floor + STOOL_RAISE + DESK_H
    smp = path.sample(0.0, path.L)
    mb.sweep(smp, [(-depth, floor), (0.0, floor), (0.0, ctop - 0.05), (-depth, ctop - 0.05)], body,
             closed_section=True, cap=(True, True))
    if lines:
        for k in range(3):
            y = floor + 0.32 + k * 0.13
            mb.sweep(smp, [(0, y), (0.022, y + 0.004), (0.022, y + 0.036), (0, y + 0.04)], "trim", cap=(True, True))
    mb.sweep(smp, [(-depth - 0.08, ctop - 0.05), (over, ctop - 0.05), (over + 0.018, ctop - 0.025), (over, ctop),
                   (-depth - 0.08, ctop)], top, closed_section=True, cap=(True, True))
    if rail:
        pts = [(x + nx * 0.16, floor + 0.2, z + nz * 0.16) for (x, z, nx, nz, s) in smp]
        mb.tube(pts, 0.016, "metal", seg=6)
        for f in (0.03, 0.5, 0.97):
            x, z, nx, nz, _, _ = path.point(path.L * f)
            mb.tube([(x, floor + 0.2, z), (x + nx * 0.16, floor + 0.2, z + nz * 0.16)], 0.011, "metal", seg=5)
    fr = fracs or [(k + 0.5) / n_stools for k in range(n_stools)]
    for k, f in enumerate(fr):
        x, z, nx, nz, _, _ = path.point(path.L * f)
        yaw = math.degrees(math.atan2(-nx, -nz))
        d = over + F.DESK_EDGE
        seat_stool(b, mb, x + nx * d, floor, z + nz * d, yaw, ctop, spot=k in spot_ids, laptop=k in spot_ids)
    return ctop


def tent_canopy(mb, x0, x1, z0, z1, y_eave, y_ridge, valance=0.22):
    """Striped hip-roof canopy (fabric, double sided) with a scalloped valance.
    Stripes run down each slope."""
    P = AWNING_STRIPE_PERIOD
    zm = (z0 + z1) / 2
    hw = (z1 - z0) / 2
    xr0, xr1 = x0 + hw, x1 - hw
    rise = y_ridge - y_eave
    slope = math.hypot(hw, rise)
    up = (0, 1, 0)
    # front and back slopes: u = x / P, v = distance down the slope / 2
    for zz, sgn in ((z1, 1), (z0, -1)):
        pts = [(x0, y_eave, zz), (x1, y_eave, zz), (xr1, y_ridge, zm), (xr0, y_ridge, zm)]
        uvs = [(p[0] / P, -abs(p[2] - zm) / hw * slope / 2.0) for p in pts]
        mb.poly_n(pts, "awning", (0, hw, sgn * rise), uvs)
    for xx, sgn, xr in ((x0, -1, xr0), (x1, 1, xr1)):
        pts = [(xx, y_eave, z0), (xx, y_eave, z1), (xr, y_ridge, zm)]
        uvs = [(p[2] / P, -abs(p[0] - xr) / hw * slope / 2.0) for p in pts]
        mb.poly_n(pts, "awning", (sgn * rise, hw, 0), uvs)
    # scalloped valance on all four eaves
    half = P / 2
    for (a, b_, fixed, along_x, out) in ((x0, x1, z1, True, (0, 0, 1)), (x0, x1, z0, True, (0, 0, -1)),
                                         (z0, z1, x0, False, (-1, 0, 0)), (z0, z1, x1, False, (1, 0, 0))):
        k0, k1 = math.floor(a / half), math.ceil(b_ / half)
        for k in range(k0, k1):
            ua, ub = max(a, k * half), min(b_, (k + 1) * half)
            if ub - ua < 1e-3:
                continue
            m = 4
            line = [(ua, y_eave), (ub, y_eave)]
            for j in range(m + 1):
                t = 1 - j / m
                u = ua + (ub - ua) * t
                dip = math.sin(math.pi * (u - k * half) / half)
                line.append((u, y_eave - valance + 0.05 - 0.05 * dip))
            pts = [(u, y, fixed) if along_x else (fixed, y, u) for (u, y) in line]
            uvs = [(u / P, -(y_eave - y) / 2.0) for (u, y) in line]
            mb.poly_n(pts, "awning", out, uvs)
    return zm, xr0, xr1


def lifebuoy(mb, c, n, r=0.3, rr=0.075, seg=12, mseg=6):
    """Ring buoy hung flat on a wall/post: alternating swatches in quarters."""
    nx, nz = n
    tx, tz = -nz, nx
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring = []
        for j in range(mseg):
            bb = 2 * math.pi * j / mseg
            rad = r + rr * math.cos(bb)
            off = rr * math.sin(bb) + rr
            ring.append((c[0] + tx * rad * math.cos(a) + nx * off, c[1] + rad * math.sin(a),
                         c[2] + tz * rad * math.cos(a) + nz * off))
        rings.append(mb.verts(ring))
    for i in range(seg):
        i2 = (i + 1) % seg
        pin = F.SWATCH_COLOUR if (i // (seg // 4)) % 2 == 0 else F.SWATCH_WHITE
        for j in range(mseg):
            j2 = (j + 1) % mseg
            mb.face([rings[i][j], rings[i2][j], rings[i2][j2], rings[i][j2]], "awning", [pin] * 4)


def long_table(mb, x0, x1, zc, floor, depth=1.0, top="wood"):
    """Shared work table along X centred on z = zc, top at floor + DESK_H."""
    z0, z1 = zc - depth / 2, zc + depth / 2
    yt = floor + DESK_H
    mb.slab(rrect(x0, x1, z0, z1, (0.06,) * 4, seg=2), yt - 0.04, yt, top, bevel=0.012, segs=2)
    n = max(2, int(round((x1 - x0) / 2.6)) + 1)
    for k in range(n):
        x = x0 + 0.35 + (x1 - x0 - 0.7) * k / (n - 1)
        for zz in (z0 + 0.12, z1 - 0.12):
            mb.tube([(x, floor + 0.012, zz), (x, yt - 0.04, zz)], 0.022, "metal", seg=6)
        mb.tube([(x, yt - 0.07, z0 + 0.12), (x, yt - 0.07, z1 - 0.12)], 0.018, "metal", seg=6)
        mb.tube([(x, floor + 0.012, z0 + 0.08), (x, floor + 0.012, z1 - 0.08)], 0.02, "metal", seg=6)
    mb.tube([(x0 + 0.35, yt - 0.07, zc), (x1 - 0.35, yt - 0.07, zc)], 0.02, "metal", seg=6)
    return yt


def table_chair(b, mb, x, floor, z, yaw, spot=True, laptop=True, cushion=F.SWATCH_COLOUR):
    """Chair whose sitter faces yaw, at a table edge DESK_EDGE ahead."""
    with mb.at(x, floor, z, yaw):
        F.chair(mb, cushion)
        if spot:
            b.spots.append(F.spot(mb, "desk", seat_h=SEAT_H, table_h=DESK_H, table_edge=F.DESK_EDGE))
        if laptop:
            b.props.append(F.prop(mb, "classic_laptop", (0, DESK_H, F.DESK_EDGE + 0.24), 180.0))


def umbrella_behind(mb, x, floor, z, yaw, back=0.85, side=0.45, r=1.25, h=2.45):
    """Umbrella planted behind a seated person so the camera (+Z side) still
    sees them under its rim."""
    with mb.at(x, floor, z, yaw):
        with mb.at(side, 0.0, -back):
            F.umbrella(mb, r=r, h=h)


def sign_face_node(b, face, name="sign_face", mb=None):
    """Separate 0-1 UV quad over a sign board (for a future texture). Pass mb
    when the board was built inside an mb.at() frame, so the quad follows it."""
    x0, x1, y0, y1, z = face
    if mb is None:
        b.extra.append((name, _sign_face(*face)))
        return
    m = MB()
    pts = [mb.tp(p) for p in ((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z))]
    m.poly(pts, "trim", [(0, 0), (1, 0), (1, 1), (0, 1)])
    b.extra.append((name, m))


# ===========================================================================
# Beach bar: the hangout on the sand
# ===========================================================================
def plot_beach_bar():
    b = Building("plot_beach_bar", "plot")
    b.look = dict(stucco="butter", trim="warm_white", neon="aqua", awning="teal")
    mb = b.mb
    rng = np.random.default_rng(501)
    F0 = 0.35  # deck top above the origin, which the client puts on the sand

    # ---- deck on short posts -------------------------------------------------
    DX0, DX1, DZ0, DZ1 = -8.3, 8.3, -7.3, 6.1
    deck = rrect(DX0, DX1, DZ0, DZ1, (0.3, 0.3, 1.1, 1.1), seg=5)
    mb.slab(deck, F0 - 0.06, F0, "wood", bevel=0.012, segs=1, bottom=False)
    mb.ring_sweep(deck.offset(0.02), [(0.0, 0.12), (0.02, 0.12), (0.02, F0 - 0.03), (0.0, F0 - 0.01)], "wood")
    mb.ring_sweep(deck.offset(0.02), [(0.0, F0 - 0.01), (-0.12, F0 - 0.01)], "wood")
    # posts every ~2.1 m around the edge, reaching 0.5 m under the origin
    n_posts = int(deck.L / 2.1)
    for k in range(n_posts):
        x, z, nx, nz, _, _ = deck.point(deck.L * k / n_posts)
        px, pz = x - nx * 0.16, z - nz * 0.16
        mb.box(px - 0.08, px + 0.08, -0.5, 0.13, pz - 0.08, pz + 0.08, "wood")
    for x in (-4.2, 0.0, 4.2):
        for z in (-3.6, 0.0, 3.4):
            mb.box(x - 0.08, x + 0.08, -0.5, F0 - 0.06, z - 0.08, z + 0.08, "wood")
    # steps down to the sand, front centre
    for k, (za, zb, yt) in enumerate(((DZ1 - 0.02, DZ1 + 0.36, F0 - 0.117), (DZ1 + 0.36, DZ1 + 0.72, F0 - 0.234))):
        mb.box(-1.75, 1.75, -0.5, yt, za, zb, "wood", bevel=0.012, segs=1, edges="top")

    # ---- back bar: stucco wall, shelves, bottles ------------------------------
    bw = rrect(-4.6, 4.6, -7.05, -6.45, (0, 0, 0.3, 0.3), seg=4)
    D.solid_band(mb, bw, F0, 2.75)
    D.cornice_cap(mb, bw, 2.75, over=0.05, h=0.1)
    D.roof_fill(mb, bw, 2.85, mat="trim")
    D.speed_lines(mb, bw, bw.s_of((4.6, -6.45)), bw.s_of((-4.6, -6.45)), 2.3, n=3, gap=0.11, h=0.04, out=0.025)
    mb.box(-3.7, 3.7, F0 + 0.95, F0 + 1.95, -6.47, -6.44, "metal")  # mirror
    for y in (F0 + 1.05, F0 + 1.5):
        mb.box(-3.9, 3.9, y - 0.04, y, -6.45, -6.15, "wood", bevel=0.01, segs=1)
        for k in range(16):
            x = -3.7 + 7.4 * (k + rng.uniform(0.1, 0.9)) / 16
            hgt = rng.uniform(0.2, 0.32)
            mb.cylinder(x, -6.3, 0.034, y, y + hgt, "glass", seg=5)
    mb.box(-3.9, 3.9, F0 + 1.92, F0 + 1.96, -6.45, -6.3, "neon_accent")
    # back counter with a fridge and an ice chest
    mb.box(-4.2, 4.2, F0, F0 + 0.92, -6.45, -5.8, "stucco", bevel=0.02, segs=1)
    mb.box(-4.25, 4.25, F0 + 0.92, F0 + 0.96, -6.47, -5.75, "wood", bevel=0.01, segs=1)
    mb.box(2.6, 3.8, F0 + 0.96, F0 + 1.6, -6.4, -5.85, "metal", bevel=0.03, segs=1)

    # ---- bow-front counter with stools ---------------------------------------
    pts = []
    for k in range(15):
        x = 4.1 - 8.2 * k / 14
        pts.append((x, -2.32 + 0.4 * math.cos(math.pi * x / 8.2)))
    bar = Path(pts, closed=False)
    ctop = path_counter(b, mb, bar, F0, 6, spot_ids={1, 2, 3, 4}, body="stucco", top="wood")
    # beer taps on the bar top between the sitters
    for x in (-3.55, 3.55):
        z = -2.32 + 0.4 * math.cos(math.pi * x / 8.2) - 0.25
        mb.box(x - 0.18, x + 0.18, ctop, ctop + 0.06, z - 0.08, z + 0.08, "metal", bevel=0.01, segs=1)
        mb.cylinder(x, z, 0.03, ctop + 0.06, ctop + 0.42, "metal", seg=8)
        for dx in (-0.1, 0.1):
            mb.tube([(x + dx, ctop + 0.36, z), (x + dx, ctop + 0.36, z + 0.1)], 0.01, "metal", seg=4)
            mb.cylinder(x + dx, z + 0.1, 0.018, ctop + 0.36, ctop + 0.5, "awning", seg=6)

    # ---- striped hip canopy on timber posts ----------------------------------
    cz0, cz1, ye, yr = -7.55, -1.72, 3.1, 4.55
    zm, xr0, xr1 = tent_canopy(mb, -5.3, 5.3, cz0, cz1, ye, yr)
    for x in (-5.1, 5.1):
        for z in (cz0 + 0.2, cz1 - 0.2):
            N.timber_post(mb, x, z, ye - F0 - 0.02, y0=F0, w=0.14, cap=False)
    for x in (xr0, xr1):
        N.timber_post(mb, x, zm, yr - F0 - 0.05, y0=F0, w=0.14, cap=False)
    mb.box(xr0 - 0.07, xr1 + 0.07, yr - 0.16, yr - 0.04, zm - 0.06, zm + 0.06, "wood")
    for z in (cz0 + 0.2, cz1 - 0.2):
        mb.box(-5.2, 5.2, ye - 0.12, ye - 0.01, z - 0.07, z + 0.07, "wood")
    # pennants on the ridge ends
    for x in (xr0, xr1):
        mb.cylinder(x, zm, 0.02, yr - 0.05, yr + 0.9, "metal", seg=6, caps=False)
        mb.poly_n([(x, yr + 0.88, zm), (x, yr + 0.6, zm), (x + (0.5 if x > 0 else -0.5), yr + 0.74, zm)], "awning",
                  (0, 0, 1), [F.SWATCH_COLOUR] * 3)
    # lit sign standing on the ridge: board, neon outline and marquee bulbs
    sx0, sx1, sy0, sy1 = -1.75, 1.75, yr + 0.18, yr + 1.12
    for x in (-1.2, 1.2):
        mb.box(x - 0.03, x + 0.03, yr - 0.1, sy0 + 0.05, zm - 0.03, zm + 0.03, "metal")
    face = F.sign_board(mb, sx0, sx1, sy0, sy1, zm + 0.06, depth=0.12)
    sign_face_node(b, face)
    N.marquee_bulbs(mb, sx0 + 0.04, sx1 - 0.04, sy0 + 0.04, sy1 - 0.04, zm + 0.065, step=0.22)
    lifebuoy(mb, (5.1, F0 + 1.55, cz1 - 0.13), (0, 1))

    # ---- loungers under an umbrella, front right ------------------------------
    for k, x in enumerate((5.35, 7.15)):
        with mb.at(x, F0, 2.75, 0):
            b.add(F.lounger(mb))
    with mb.at(6.25, F0, 0.95, 0):
        F.umbrella(mb, r=1.45, h=2.5)
    with mb.at(6.25, F0, 4.55, 0):
        mb.lathe([(0, 0), (0.3, 0), (0.3, 0.42), (0.27, 0.45), (0, 0.45)], 0, 0, "wood", seg=12)
    # barrel tables to lean on, potted plants by the canopy posts
    for (x, z) in ((-0.9, 2.3), (2.3, 3.3)):
        mb.lathe([(0, F0), (0.3, F0), (0.34, F0 + 0.5), (0.3, F0 + 0.98), (0, F0 + 0.98)], x, z, "wood", seg=12)
        for y in (F0 + 0.18, F0 + 0.8):
            mb.lathe([(0.315, y), (0.345, y + 0.02), (0.345, y + 0.07), (0.315, y + 0.09)], x, z, "metal", seg=12)
        mb.lathe([(0, F0 + 0.98), (0.42, F0 + 0.98), (0.42, F0 + 1.03), (0, F0 + 1.03)], x, z, "wood", seg=14)
    plant(b, [F.round_planter(mb, -6.2, -0.9, r=0.38, h=0.5), F.round_planter(mb, 6.2, -0.9, r=0.38, h=0.5)])
    b.prop("vintage_day_bed", (-5.9, F0, 0.6), 15.0)
    b.prop("outdoor_table_chair_set_01", (-3.0, F0, 3.2), 80.0)
    b.prop("outdoor_table_chair_set_01", (-6.3, F0, 4.0), 100.0)
    # surfboards leaning on the back wall's left end
    for k, (z, pin) in enumerate(((-6.92, F.SWATCH_COLOUR), (-6.5, F.SWATCH_WHITE))):
        with mb.at(-4.6 - 0.3 - 0.06 * k, F0 + 1.08, z, 90, pitch=-78):
            F.surfboard(mb, length=2.2, pin=pin)

    # ---- night life ------------------------------------------------------------
    tops = [N.timber_post(mb, x, z, 2.95, y0=F0, w=0.12) for (x, z) in ((-7.75, 5.55), (-2.3, 5.75), (2.3, 5.75),
                                                                         (7.75, 5.55))]
    eave = [(x, ye - 0.06, cz1 - 0.2) for x in (-5.1, -1.3, 1.3, 5.1)]
    N.string_lights(mb, [eave[0], tops[0], tops[1], eave[1]])
    N.string_lights(mb, [eave[2], tops[2], tops[3], eave[3]])
    N.string_lights(mb, [tops[1], tops[2]])
    for x in (-2.0, 2.0):
        N.lantern_post(mb, x, DZ1 - 0.35, h=1.15, y0=F0, globe_r=0.13)
    N.downlight_row(mb, -4.0, 4.0, ye - 0.13, cz1 - 0.2, 6)
    b.light((0.0, 3.0, -1.0), 5.5, "warm", floor_y=F0)
    b.light((-5.0, 3.1, 2.6), 4.5, "warm", floor_y=F0)
    b.light((6.25, 3.1, 2.9), 4.0, "warm", floor_y=F0)
    b.light((0.0, 1.7, 5.9), 3.0, "candle", floor_y=F0)
    b.palm((-9.3, 0.0, -6.3), 9.5, 20)
    b.palm((9.25, 0.0, -2.4), 8.0, 140)
    b.palm((-9.3, 0.0, 4.3), 7.0, 250)
    b.palm((9.3, 0.0, 5.6), 10.5, 75)

    b.anchors = {"tag_anchor": (0.0, 7.6, -4.6), "beam_anchor": (0.0, F0, 0.0)}
    b.notes = ("Hangout beach bar on the sand: timber deck on short posts (top 0.35 m above the origin, posts to "
               "-0.5 m), striped hip canopy over a bow-front bar with six stools, back bar with bottles, loungers "
               "under an umbrella, day bed, festoon lights on timber poles and a marquee sign on the ridge.")
    return b


# ===========================================================================
# Co-working: two-storey MiMo office, the overflow (client turns it 90 deg so
# the front faces world +X and the left flank faces the camera)
# ===========================================================================
def plot_coworking():
    b = Building("plot_coworking", "plot")
    b.look = dict(stucco="powder", trim="warm_white", neon="aqua", awning="butter")
    mb = b.mb
    rng = np.random.default_rng(502)
    T = TERRACE_Y
    X0, X1, Z0, Z1 = -8.4, 8.4, -7.8, -2.6
    main = rrect(X0, X1, Z0, Z1, (0, 0, 0, 1.9), seg=8)
    y_gf, y_band, y_f1, y_roof = 3.75, 4.35, 7.35, 7.35

    # ground floor: storefront glazing wrapping the rounded corner
    gf = [
        D.Opening(min(main.s_of((X0, -5.4)), main.s_of((-0.95, Z1))), max(main.s_of((X0, -5.4)), main.s_of((-0.95, Z1))),
                  depth=0.14, pane_w=1.45, transom=0.8, rng=rng, sill=False),
        _o(main, (0.95, Z1), (7.7, Z1), depth=0.14, pane_w=1.45, transom=0.8, rng=rng, sill=False),
        _o(main, (X1, -3.4), (X1, -7.0), depth=0.14, pane_w=1.4, transom=0.8, rng=rng, sill=False),
        _o(main, (X0, -6.0), (X0, -7.3), depth=0.14, pane_w=1.3, transom=0.8, rng=rng, sill=False),
    ]
    mb.ring_sweep(main, [(0.0, 0.0), (0.04, 0.0), (0.04, 0.3), (0.02, 0.34), (0.0, 0.34)], "terrazzo")
    D.window_band(mb, main, 0.34, 3.4, gf, rng=rng)
    D.solid_band(mb, main, 3.4, y_band + 0.6)
    # door in the glazing gap
    D.applied_door(mb, -0.85, 0.85, 0.0, 2.75, Z1, panes=2, cell=D.LIGHT_PANEL_CELL)
    # thick white floor-edge band all round (MiMo)
    mb.ring_sweep(main, [(0.0, y_gf), (0.36, y_gf), (0.4, y_gf + 0.04), (0.4, y_band - 0.04), (0.36, y_band),
                         (0.0, y_band)], "trim")
    mb.ring_sweep(main, [(0.0, y_gf), (0.36, y_gf)], "trim")
    # upper floor: ribbon window on the front, portholes on the left flank
    up = [
        _o(main, (-6.4, Z1), (7.7, Z1), depth=0.18, pane_w=1.15, transom=0.72, rng=rng),
        _o(main, (X1, -3.4), (X1, -7.0), depth=0.18, pane_w=1.2, transom=0.72, rng=rng),
    ]
    D.window_band(mb, main, y_band + 0.6, 6.55, up, rng=rng)
    D.solid_band(mb, main, 6.55, y_roof + 0.3)
    a, c = main.s_of((-6.4, Z1)), main.s_of((X0, -4.6))
    D.speed_lines(mb, main, min(a, c), max(a, c), 5.25, n=3, gap=0.17, h=0.06)
    # breeze-block screen in front of the right half of the upper floor
    sx0, sx1, sz = 0.7, 8.0, Z1 + 0.5
    mb.box(sx0, sx1, y_band + 0.05, y_roof - 0.05, sz - 0.06, sz + 0.06, "glass_block")
    for (a0, a1, b0, b1) in ((sx0 - 0.14, sx0, y_band, y_roof), (sx1, sx1 + 0.14, y_band, y_roof),
                             (sx0 - 0.14, sx1 + 0.14, y_roof - 0.08, y_roof + 0.06)):
        mb.box(a0, a1, b0, b1, sz - 0.1, sz + 0.1, "trim", bevel=0.02, segs=1)
    for x in (sx0 - 0.07, sx1 + 0.07):
        mb.box(x - 0.05, x + 0.05, y_band, y_band + 0.05, Z1, sz, "trim")
    # floating roof slab with a neon edge
    roof = rrect(X0 - 0.5, X1 + 0.5, Z0 - 0.3, Z1 + 1.05, (0, 0, 0, 2.4), seg=8)
    mb.slab(roof, y_roof + 0.3, y_roof + 0.56, "trim", bevel=0.05, segs=2, top=False)
    D.roof_fill(mb, roof.offset(-0.06), y_roof + 0.56, mat="roof")
    # rooftop: a rounded stair bulkhead with a porthole, skylights, vents
    yr = y_roof + 0.56
    bh = rrect(-6.2, -3.4, -7.4, -5.2, (0, 0, 0.6, 0.6), seg=4)
    D.solid_band(mb, bh, yr, yr + 2.4)
    D.cornice_cap(mb, bh, yr + 2.4, over=0.06, h=0.12)
    D.roof_fill(mb, bh, yr + 2.52)
    D.speed_lines(mb, bh, bh.s_of((-3.4, -5.6)), bh.s_of((-6.2, -5.6)), yr + 1.9, n=3, gap=0.12, h=0.04)
    for x0 in (0.2, 3.4):
        mb.box(x0, x0 + 2.2, yr, yr + 0.32, -6.9, -4.9, "trim", bevel=0.04, segs=2)
        mb.box(x0 + 0.12, x0 + 2.08, yr + 0.32, yr + 0.38, -6.78, -5.02, "glass_block")
    for (vx, vz) in ((6.8, -6.6), (7.5, -6.6), (-1.4, -3.8)):
        mb.cylinder(vx, vz, 0.14, yr, yr + 0.55, "metal", seg=10, bevel=0.02)
        mb.cylinder(vx, vz, 0.22, yr + 0.55, yr + 0.62, "metal", seg=10, bevel=0.02)
    a, c = roof.s_of((X1 + 0.5, Z1 + 1.05)), roof.s_of((X0 - 0.5, -5.0))
    D.neon_on_path(mb, roof, min(a, c), max(a, c), y_roof + 0.43, off=0.03, r=0.022)
    # sign on the left flank's upper floor, facing -X (the camera once turned)
    with mb.at(X0, 0.0, -5.6, -90):
        face = F.sign_board(mb, -1.15, 1.15, 4.75, 6.75, 0.16, depth=0.14)
        N.marquee_bulbs(mb, -1.1, 1.1, 4.8, 6.7, 0.165, step=0.22)
        sign_face_node(b, face, mb=mb)
        for x in (-0.9, 0.9):
            mb.box(x - 0.04, x + 0.04, 6.75, 7.6, 0.02, 0.1, "metal")

    # ---- terrace -----------------------------------------------------------
    terr = rrect(-9.7, 9.7, Z1 - 0.15, 7.2, (0, 0, 0.8, 0.8), seg=4)
    mb.slab(terr, 0.0, T, "terrazzo", bevel=0.012, segs=1, bottom=False)
    D.floor_fan(mb, 0.0, Z1 + 0.05, 0.7, 1.9, T + 0.006, rays=9, a0=0, a1=180)
    # long shared work table: four spots, four more chairs
    tz = 2.5
    long_table(mb, -3.3, 4.5, tz, T)
    xs = (-2.5, -0.7, 1.1, 2.9)
    for k, x in enumerate(xs):
        table_chair(b, mb, x, T, tz - 0.5 - F.DESK_EDGE, 0.0, spot=k in (0, 2), laptop=k in (0, 2, 3))
        table_chair(b, mb, x + 0.25, T, tz + 0.5 + F.DESK_EDGE, 180.0, spot=k in (1, 3), laptop=k in (1, 3))
    # a desk on the camera side and a bench against the glazing
    with mb.at(-6.7, T, 3.6, 25):
        b.add(F.desk_set(mb))
    with mb.at(4.6, T, 6.0, 0):
        b.add(F.bench_back(mb, 1.8))
    # planters along the glazing and at the corners
    soils = [F.planter(mb, -6.4, -3.2, Z1 + 0.1, Z1 + 0.6, h=0.45), F.planter(mb, 5.6, 7.6, Z1 + 0.1, Z1 + 0.6, h=0.45)]
    plant(b, soils)
    p1 = F.round_planter(mb, -8.75, 6.35, r=0.55, h=0.6)
    p2 = F.round_planter(mb, 8.75, 6.35, r=0.5, h=0.6)
    p3 = F.round_planter(mb, 9.0, -1.4, r=0.45, h=0.55)
    b.prop("mid_century_lounge_chair", (-3.6, T, 6.0), 160.0)
    with mb.at(3.9, T, Z1 + 0.45, 0):
        F.bench_back(mb, 1.8)
    b.prop("CoffeeCart_01", (7.6, T, 1.2), -90.0)
    street_lamps(b)
    b.prop("exterior_aircon_unit", (-1.6, y_roof + 0.56, -6.8), 0.0)
    b.prop("exterior_aircon_unit", (6.6, y_roof + 0.56, -3.9), 0.0)

    # ---- night life ------------------------------------------------------------
    pa = N.pole(mb, -4.3, tz, 3.25, y0=T)
    pb = N.pole(mb, 5.5, tz, 3.25, y0=T)
    pc = N.pole(mb, 0.6, 6.7, 3.25, y0=T)
    N.string_lights(mb, [pa, pb], sag=0.35)
    N.string_lights(mb, [(-5.6, y_gf - 0.08, Z1 + 0.3), pa, pc, pb, (6.6, y_gf - 0.08, Z1 + 0.3)])
    N.downlight_row(mb, -6.0, 7.5, y_gf - 0.005, Z1 + 0.2, 8)
    for x in (-1.65, 1.65):
        N.lantern_post(mb, x, Z1 + 0.75, h=2.2, y0=T)
    b.light((0.6, 3.2, tz + 1.4), 5.5, "warm")
    b.light((0.0, 3.0, Z1 + 0.9), 3.5, "candle")
    b.light((-5.6, 3.0, 2.6), 3.5, "warm")
    b.palm(p1, 9.0, 30)
    b.palm(p2, 7.5, 200)
    b.palm(p3, 10.0, 110)

    b.anchors = {"tag_anchor": (-2.0, 11.0, -5.0), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Co-working overflow: two-storey MiMo office, storefront glazing wrapping a rounded corner, thick white "
               "floor band, breeze-block screen, floating roof slab, sign pylon facing local -X (the camera once the "
               "client turns it 90 deg); long shared work table under festoon lights.")
    return b



# ---------------------------------------------------------------------------
# more helpers
# ---------------------------------------------------------------------------
def loft(mb, sections, mat, pin=None, closed=True, centre=None):
    """Quads between consecutive sections (lists of 3D points with the same
    count). With centre, faces are oriented away from it."""
    n = len(sections[0])
    kmax = n if closed else n - 1
    for i in range(len(sections) - 1):
        A, Bs = sections[i], sections[i + 1]
        for k in range(kmax):
            k2 = (k + 1) % n
            q = [A[k], A[k2], Bs[k2], Bs[k]]
            uvs = [pin] * 4 if pin is not None else None
            if centre is not None:
                cx = sum(p[0] for p in q) / 4 - centre[0]
                cy = sum(p[1] for p in q) / 4 - centre[1]
                cz = sum(p[2] for p in q) / 4 - centre[2]
                mb.poly_n(q, mat, (cx, cy, cz), uvs)
            else:
                mb.poly(q, mat, uvs)


def dinghy(mb, length=4.0, beam=1.5, depth=0.55, hull_pin=F.SWATCH_COLOUR):
    """Open rowing boat on the local origin, bow toward +X, keel at y=0."""
    secs = []
    sheers = []
    m = 11
    for i in range(m + 1):
        t = i / m
        x = -length / 2 + length * t
        bb = beam / 2 * max(0.0, math.sin(math.pi * (0.16 + 0.84 * t))) ** 0.55
        top = depth + 0.14 * t * t
        d = depth * (1 - 0.3 * t * t)
        sec = []
        for k in range(7):
            ph = math.radians(-90 + 30 * k)
            c = abs(math.cos(ph)) ** 0.75
            sec.append((x, top - d * c, bb * math.sin(ph)))
        secs.append(sec)
        sheers.append((sec[0], sec[-1]))
    loft(mb, secs, "awning", pin=hull_pin, closed=False)
    mb.poly(list(secs[0]), "awning", [F.SWATCH_WHITE] * 7)
    for side in (0, 1):
        mb.tube([sh[side] for sh in sheers], 0.03, "wood", seg=5)
    for t in (0.3, 0.62):
        i = int(round(t * m))
        a, c = secs[i][0], secs[i][-1]
        mb.box(a[0] - 0.12, a[0] + 0.12, a[1] - 0.16, a[1] - 0.12, c[2] + 0.04, a[2] - 0.04, "wood")


def cradle(mb, x, z, w=1.2, h=0.5, length=0.5):
    for dx in (-0.08, 0.08):
        mb.box(x + dx - 0.04, x + dx + 0.04, 0.0, h, z - w / 2, z + w / 2, "wood", bevel=0.01, segs=1)
    mb.box(x - 0.12, x + 0.12, 0.0, 0.08, z - w / 2 - 0.1, z + w / 2 + 0.1, "wood")


def board_rack(mb, x0, z0, z1, n=4, pins=(F.SWATCH_COLOUR, F.SWATCH_WHITE)):
    """Free-standing rack of surfboards lying flat, length along Z."""
    for z in (z0, z1):
        mb.box(x0 - 0.05, x0 + 0.05, 0.0, 0.4 + 0.3 * n, z - 0.05, z + 0.05, "wood", bevel=0.01, segs=1)
        mb.box(x0 + 0.65, x0 + 0.75, 0.0, 0.4 + 0.3 * n, z - 0.05, z + 0.05, "wood", bevel=0.01, segs=1)
        for k in range(n):
            y = 0.3 + 0.3 * k
            mb.box(x0 - 0.06, x0 + 0.76, y - 0.03, y + 0.03, z - 0.06, z + 0.06, "wood")
    for k in range(n):
        with mb.at(x0 + 0.35, 0.3 + 0.3 * k + 0.06, (z0 + z1) / 2, 0):
            F.surfboard(mb, length=2.1, width=0.5, thick=0.06, pin=pins[k % len(pins)])


def board_outline_dots(mb, length, width, z_off=0.0, step=0.32, r=0.05):
    """Bulbs around a surfboard outline (board lying in local XZ, nose +Z),
    just above its top face."""
    n = int(length / step)
    for k in range(1, n):
        t = k / n
        z = -length / 2 + length * t
        w = width / 2 * math.sin(math.pi * (0.06 + 0.94 * t)) ** 0.7 + 0.07
        for sx in (-1, 1):
            N.dot(mb, sx * w, z_off, z, r)
    N.dot(mb, 0, z_off, length / 2 + 0.08, r)


def counter_ledge(mb, x0, x1, z_wall, floor, depth=0.42, mat="wood"):
    """Ledge on a +Z facing wall at stool counter height; returns its top."""
    ctop = floor + STOOL_RAISE + DESK_H
    mb.box(x0, x1, ctop - 0.05, ctop, z_wall, z_wall + depth, mat, bevel=0.012, segs=1)
    for x in (x0 + 0.25, x1 - 0.25):
        mb.box(x - 0.03, x + 0.03, ctop - 0.35, ctop - 0.05, z_wall, z_wall + 0.05, "metal")
        mb.tube([(x, ctop - 0.33, z_wall + 0.02), (x, ctop - 0.06, z_wall + depth - 0.06)], 0.015, "metal", seg=5)
    return ctop


def pergola(mb, x0, x1, z_beams, y, col_xs, rafter_gap=0.75, mat_beam="stucco"):
    """Beams along X at each z in z_beams (bottom at y), columns under them,
    thin rafters along Z on top (seen end-on by the +Z camera)."""
    for zb in z_beams:
        mb.box(x0 - 0.2, x1 + 0.2, y, y + 0.36, zb - 0.13, zb + 0.13, mat_beam, bevel=0.03, segs=1)
        for x in col_xs:
            mb.lathe([(0, 0.0), (0.21, 0.0), (0.21, 0.08), (0.15, 0.14), (0.13, 0.3), (0.13, y - 0.22), (0.17, y - 0.12),
                      (0.19, y - 0.04), (0.19, y), (0, y)], x, zb, "trim", seg=12)
    za, zc = min(z_beams) - 0.55, max(z_beams) + 0.55
    n = int((x1 - x0) / rafter_gap)
    xs = []
    for k in range(n + 1):
        x = x0 + (x1 - x0) * k / n
        xs.append(x)
        mb.box(x - 0.03, x + 0.03, y + 0.36, y + 0.56, za, zc, "wood")
    return xs


# ===========================================================================
# Surf shop: one storey with a stepped false front and a giant lit board
# ===========================================================================
def plot_surf_shop():
    b = Building("plot_surf_shop", "plot")
    b.look = dict(stucco="aqua", trim="warm_white", neon="amber", awning="butter")
    mb = b.mb
    rng = np.random.default_rng(503)
    T = TERRACE_Y
    X0, X1, Z0, Z1 = -7.6, 4.6, -7.6, -2.2
    shop = rrect(X0, X1, Z0, Z1, (0, 0, 1.3, 0), seg=8)
    y_top = 4.0
    ops = [
        _o(shop, (-7.1, Z1), (-2.9, Z1), depth=0.22, pane_w=1.05, transom=0.78, rng=rng),
        D.Opening(min(shop.s_of((-0.5, Z1)), shop.s_of((X1, -4.0))), max(shop.s_of((-0.5, Z1)), shop.s_of((X1, -4.0))),
                  depth=0.22, pane_w=1.05, transom=0.78, rng=rng),
        _o(shop, (X1, -4.9), (X1, -6.9), depth=0.3, pane_w=1.0, rng=rng, sill=False,
           cells=[D.LIGHT_PANEL_CELL]),
        _o(shop, (X0, -3.4), (X0, -5.0), depth=0.2, pane_w=0.8, rng=rng),
    ]
    mb.ring_sweep(shop, [(0.0, 0.0), (0.04, 0.0), (0.04, 0.5), (0.02, 0.54), (0.0, 0.54)], "terrazzo")
    D.solid_band(mb, shop, 0.54, 1.05)
    D.window_band(mb, shop, 1.05, 3.05, ops, rng=rng)
    D.solid_band(mb, shop, 3.05, y_top + 0.5)
    D.parapet(mb, shop, y_top, y_top + 0.5, th=0.22)
    D.applied_door(mb, -2.2, -1.2, 0.18, 2.75, Z1, panes=1, cell=D.LIGHT_PANEL_CELL)
    mb.box(-2.9, -0.5, 0.54, 1.05, Z1, Z1 + 0.02, "stucco")
    D.eyebrow(mb, shop, shop.s_of((-0.2, Z1)), shop.s_of((X0, Z1)), 3.2, depth=0.75, thick=0.13, ext=0.0)
    a, c = shop.s_of((0.0, Z1)), shop.s_of((X1, -4.6))
    D.eyebrow(mb, shop, min(a, c), max(a, c), 3.2, depth=0.75, thick=0.13, ext=0.0)
    D.speed_lines(mb, shop, min(a, c), max(a, c), 3.55, n=3, gap=0.14, h=0.05)
    # stepped false front with fins
    for (hx0, hx1, ya, yb) in ((-6.9, 1.9, y_top + 0.5, 5.35), (-5.6, 0.6, 5.35, 6.15), (-4.2, -0.8, 6.15, 6.85)):
        p = rrect(hx0, hx1, Z1 - 0.36, Z1, (0, 0, 0.12, 0.12), seg=2)
        D.solid_band(mb, p, ya - 0.5 if ya == y_top + 0.5 else ya, yb - 0.08)
        D.cornice_cap(mb, p, yb - 0.08, over=0.05, h=0.08)
        D.roof_fill(mb, p, yb, mat="trim")
    for x in (-5.9, -2.5, 0.9):
        D.fin(mb, x, Z1, 3.5, 6.0 if x != -2.5 else 7.5, 0.32, 0.18)
    face = F.sign_board(mb, -4.1, -0.9, 5.45, 6.05, Z1 + 0.14, depth=0.1)
    sign_face_node(b, face)
    # giant surfboard sign on the roof, outlined with bulbs
    with mb.at(2.85, y_top + 0.5 + 2.75, -3.2, -8, pitch=-84):
        F.surfboard(mb, length=5.6, width=1.35, thick=0.16, pin=F.SWATCH_COLOUR)
        mb.box(-0.09, 0.09, 0.075, 0.09, -2.6, 2.6, "trim")
        board_outline_dots(mb, 5.6, 1.35, z_off=0.11)
    for dx in (-0.35, 0.35):
        mb.box(2.85 + dx - 0.05, 2.85 + dx + 0.05, y_top + 0.4, y_top + 2.4, -3.6, -3.45, "metal")
    # porch boardwalk and yard pavers
    yard = rrect(-9.7, 9.7, Z1 - 0.1, 7.2, (0, 0, 0.7, 0.7), seg=4)
    mb.slab(yard, 0.0, T, "terrazzo", bevel=0.01, segs=1, bottom=False)
    mb.slab(rrect(X1 - 0.05, 9.7, -7.9, Z1 - 0.1, (0, 0, 0, 0), seg=1), 0.0, T, "terrazzo", bevel=0.0, segs=1,
            bottom=False)
    porch = rrect(-7.8, 0.4, Z1 - 0.05, 0.4, (0, 0, 0.2, 0.2), seg=2)
    mb.slab(porch, 0.0, 0.18, "wood", bevel=0.015, segs=1, bottom=False)
    with mb.at(-5.4, 0.18, Z1 + 0.42, 0):
        b.add(F.bench_back(mb, 1.8))
    # side yard: a ledge under the hatch, and a freestanding wax bar out in the
    # open with two working stools (kept clear of the wall, which would hide
    # them from a camera turned to the left)
    with mb.at(X1, 0.0, -5.9, 90):
        counter_ledge(mb, -1.0, 1.0, 0.0, T)
    wax = Path([(9.3, -6.05), (6.3, -6.05)], closed=False)
    path_counter(b, mb, wax, T, 3, spot_ids={0, 2}, body="stucco", top="wood", depth=0.5, fracs=[0.2, 0.5, 0.78])
    # yard: two working tables, a lounger, board rack, outdoor shower
    for (x, z, yaw, umb) in ((-3.4, 3.0, 12, False), (0.9, 4.3, -15, True)):
        with mb.at(x, T, z, yaw):
            b.add(F.cafe_table_set(mb))
            if umb:
                with mb.at(0.45, 0.0, -0.9):
                    F.umbrella(mb, r=1.25, h=2.45)
    with mb.at(7.3, T, 2.9, -10):
        b.add(F.lounger(mb))
    with mb.at(-8.9, T, 0.9, 0):
        board_rack(mb, 0.0, 0.0, 1.9)
    mb.box(-9.3, -8.3, T, T + 0.06, 4.2, 5.2, "wood")
    mb.tube(F.tube_path([(-9.2, T, 4.7), (-9.2, T + 2.25, 4.7), (-8.85, T + 2.25, 4.7)], r=0.1, seg=3), 0.025,
            "metal", seg=6)
    mb.lathe([(0, -0.02), (0.1, -0.06), (0.11, 0.0), (0, 0.0)], -8.85, 4.7, "metal", seg=10, y0=T + 2.2)
    soils = [F.planter(mb, -2.6, -0.8, 6.4, 6.9, h=0.45), F.planter(mb, 3.6, 5.4, 6.4, 6.9, h=0.45)]
    plant(b, soils)
    p1 = F.round_planter(mb, -9.05, 6.45, r=0.45, h=0.55)
    p2 = F.round_planter(mb, 9.05, 6.45, r=0.42, h=0.55)
    p3 = F.round_planter(mb, 8.9, -7.2, r=0.45, h=0.55)
    b.prop("painted_wooden_bench", (3.2, T, 6.0), 180.0)
    b.prop("exterior_aircon_unit", (-5.0, y_top, -6.6), 0.0)
    street_lamps(b)
    # night life
    ye = 3.2 - 0.06
    P = [N.pole(mb, x, z, 3.2, y0=T) for (x, z) in ((-6.6, 6.2), (-1.7, 6.5), (3.0, 6.2), (8.6, 1.4))]
    N.string_lights(mb, [(-7.2, ye, Z1 + 0.68), P[0], (-4.4, ye, Z1 + 0.68), P[1], (-1.0, ye, Z1 + 0.68), P[2],
                         (3.4, ye, Z1 + 0.6)])
    N.string_lights(mb, [P[2], P[3], (X1 + 0.05, y_top + 0.45, -6.8)])
    for x in (-2.62, -0.78):
        N.sconce(mb, x, 2.3, Z1)
    b.light((-2.4, 3.0, 2.6), 5.0, "warm")
    b.light((6.0, 3.0, -3.2), 4.0, "warm")
    b.light((-4.6, 2.8, -1.2), 3.0, "amber", floor_y=0.18)
    b.light((3.6, 3.0, 3.8), 4.0, "warm")
    b.palm(p1, 10.5, 45)
    b.palm(p2, 8.0, 190)
    b.palm(p3, 9.0, 300)
    b.anchors = {"tag_anchor": (-1.5, 9.4, -4.6), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Surf shop: one storey with a stepped Deco false front, fins and a giant surfboard sign outlined in "
               "bulbs on the roof; display windows wrapping the rounded corner, a side hatch ledge with stools, porch "
               "boardwalk with a bench, board rack and outdoor shower in the yard.")
    return b


# ===========================================================================
# Juice kiosk: round kiosk with a saucer roof and a big pergola terrace
# ===========================================================================
def plot_juice_kiosk():
    b = Building("plot_juice_kiosk", "plot")
    b.look = dict(stucco="peach", trim="warm_white", neon="amber", awning="coral")
    mb = b.mb
    rng = np.random.default_rng(504)
    T = TERRACE_Y
    terr = rrect(-9.7, 9.7, -7.9, 7.2, (0.4, 0.4, 0.8, 0.8), seg=4)
    mb.slab(terr, 0.0, T, "terrazzo", bevel=0.012, segs=1, bottom=False)
    # ---- the kiosk drum ------------------------------------------------------
    cx, cz, R = -5.7, -3.4, 2.3
    drum = circle_path(cx, cz, R, seg=28)

    def ang(a):
        return (cx + R * math.cos(math.radians(a)), cz + R * math.sin(math.radians(a)))
    ctop = T + STOOL_RAISE + DESK_H
    win = D.Opening(min(drum.s_of(ang(35)), drum.s_of(ang(145))), max(drum.s_of(ang(35)), drum.s_of(ang(145))),
                    depth=0.3, pane_w=0.95, rng=rng, sill=False, cells=[D.LIGHT_PANEL_CELL, 3, D.LIGHT_PANEL_CELL, 6])
    door = D.Opening(min(drum.s_of(ang(250)), drum.s_of(ang(282))), max(drum.s_of(ang(250)), drum.s_of(ang(282))),
                     depth=0.12, pane_w=1.2, rng=rng, sill=False, cells=[9])
    D.solid_band(mb, drum, 0.0, ctop + 0.03)
    D.window_band(mb, drum, ctop + 0.03, 2.4, [win, door], rng=rng)
    D.solid_band(mb, drum, 2.4, 2.95)
    D.speed_lines(mb, drum, drum.s_of(ang(150)), drum.s_of(ang(390)) + drum.L, 0.35, n=3, gap=0.12, h=0.045)
    # ledge counter wrapping the window, stools outside
    a0, a1 = drum.s_of(ang(38)), drum.s_of(ang(142))
    mb.sweep(drum.sample(min(a0, a1), max(a0, a1)), [(0.0, ctop - 0.05), (0.42, ctop - 0.05), (0.44, ctop - 0.025),
                                                     (0.42, ctop), (0.0, ctop)], "wood", cap=(True, True))
    for k, a in enumerate((62, 90, 118)):
        nx, nz = math.cos(math.radians(a)), math.sin(math.radians(a))
        d = R + 0.42 + F.DESK_EDGE
        yaw = math.degrees(math.atan2(-nx, -nz))
        seat_stool(b, mb, cx + nx * d, T, cz + nz * d, yaw, ctop, spot=k != 1, laptop=k != 1)
    # saucer roof with a neon rim, a mast and the lit orange ball
    mb.lathe([(0, 2.92), (R + 0.95, 2.96), (R + 1.08, 3.03), (R + 0.95, 3.12), (1.2, 3.32), (0.5, 3.4), (0, 3.4)],
             cx, cz, "trim", seg=32)
    D.neon_tube(mb, [(cx + (R + 0.98) * math.cos(2 * math.pi * k / 32), 2.98, cz + (R + 0.98) * math.sin(2 * math.pi * k / 32))
                     for k in range(32)], r=0.022, closed=True)
    mb.cylinder(cx, cz, 0.07, 3.4, 4.35, "metal", seg=8, caps=False)
    ball_y, br = 5.05, 0.72
    prof = [(br * math.sin(math.pi * k / 10), -br * math.cos(math.pi * k / 10)) for k in range(11)]
    prof[0], prof[-1] = (0, -br), (0, br)
    mb.lathe(prof, cx, cz, "awning", seg=18, y0=ball_y)
    F._pin_last_lathe(mb, 18 * 10, F.SWATCH_COLOUR)
    for k in range(16):
        a = 2 * math.pi * k / 16
        N.dot(mb, cx + (br + 0.08) * math.cos(a), ball_y, cz + (br + 0.08) * math.sin(a), 0.055)
    D.neon_tube(mb, [(cx + (br + 0.02) * math.cos(2 * math.pi * k / 18), ball_y + 0.02,
                      cz + (br + 0.02) * math.sin(2 * math.pi * k / 18)) for k in range(18)], r=0.02, closed=True)
    mb.poly_n([(cx, ball_y + br - 0.02, cz), (cx + 0.18, ball_y + br + 0.32, cz + 0.05),
               (cx + 0.5, ball_y + br + 0.2, cz)], "neon_accent", (0, 0, 1))
    # fruit crates by the kiosk
    for (x, z, y) in ((-8.6, -0.6, 0.0), (-8.0, -0.4, 0.0), (-8.3, -0.5, 0.32)):
        mb.box(x - 0.28, x + 0.28, T + y, T + y + 0.3, z - 0.2, z + 0.2, "wood", bevel=0.01, segs=1)
    # ---- pergola terrace -----------------------------------------------------
    yb = 3.3
    rafters = pergola(mb, -2.4, 9.3, (-3.9, 4.7), yb, (-2.2, 1.6, 5.4, 9.1))
    # three working tables: just behind the front beam or well behind it, so
    # the beam never crosses the camera's view of a sitter
    def gap_x(x):
        best = min(rafters, key=lambda r: abs(r - x))
        return best + (0.375 if x >= best else -0.375)
    for (x, z, yaw) in ((gap_x(0.2), 3.7, 0), (gap_x(5.6), 3.6, 0), (gap_x(3.0), -0.9, 0)):
        with mb.at(x, T, z, yaw):
            b.add(F.cafe_table_set(mb))
    for (x, z) in ((gap_x(-1.2), -1.1), (gap_x(7.2), -1.0)):
        with mb.at(x, T, z, 0):
            F.cafe_table_set(mb, laptop=False)
    with mb.at(-5.8, T, 3.6, 0):
        b.add(F.lounger(mb))
    with mb.at(-7.4, T, 4.1, 0):
        F.lounger(mb)
    # back garden wall with a bench and planters
    bwall = rrect(-2.6, 9.6, -7.75, -7.45, (0, 0, 0, 0), seg=1)
    D.solid_band(mb, bwall, 0.0, 2.1)
    D.cornice_cap(mb, bwall, 2.1, over=0.04, h=0.08)
    D.roof_fill(mb, bwall, 2.18, mat="trim")
    D.speed_lines(mb, bwall, bwall.s_of((9.6, -7.45)), bwall.s_of((-2.6, -7.45)), 1.3, n=3, gap=0.12, h=0.05)
    with mb.at(3.2, T, -7.05, 0):
        F.bench_back(mb, 2.4)
    soils = [F.planter(mb, 5.4, 8.8, -7.4, -6.8, h=0.5), F.planter(mb, -2.2, 0.8, -7.4, -6.8, h=0.5)]
    plant(b, soils)
    p1 = F.round_planter(mb, -9.0, 6.4, r=0.5, h=0.6)
    p2 = F.round_planter(mb, -1.0, 6.5, r=0.42, h=0.55)
    p3 = F.round_planter(mb, -9.0, -7.1, r=0.45, h=0.55)
    p4 = F.round_planter(mb, 9.15, 6.45, r=0.42, h=0.55)
    b.prop("CoffeeCart_01", (-2.6, T, 0.9), 90.0)
    b.prop("mid_century_lounge_chair", (8.2, T, -5.6), 200.0)
    street_lamps(b)
    # ---- night life ------------------------------------------------------------
    for x in (rafters[2] + 0.375, rafters[7] + 0.375, rafters[12] + 0.375):
        N.string_lights(mb, [(x, yb - 0.02, -3.9), (x, yb - 0.02, 4.7)], sag=0.3)
    N.string_lights(mb, [(-2.3, yb - 0.02, 4.7), (9.2, yb - 0.02, 4.7)], sag=0.25)
    for x in (-3.9, 0.9):
        N.lantern_post(mb, x, 6.5, h=2.4, y0=T)
    N.sconce(mb, cx, 2.0, cz - R, n=(0, -1))
    b.light((3.4, 3.1, 3.4), 6.0, "warm")
    b.light((3.4, 3.1, -1.4), 5.0, "warm")
    b.light((-5.7, 2.8, -0.6), 3.5, "candle")
    b.light((-6.4, 2.4, 4.0), 3.0, "amber")
    b.palm(p1, 9.0, 15)
    b.palm(p2, 7.0, 130)
    b.palm(p3, 10.5, 250)
    b.palm(p4, 8.0, 80)
    b.anchors = {"tag_anchor": (0.0, 8.2, -2.0), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Juice kiosk: a round kiosk with a flying-saucer roof, neon rim and a lit orange ball on a mast, a "
               "stool ledge around its window; a big pergola terrace (rafters run front to back so the camera sees "
               "the tables between them) with festoons along the rafters.")
    return b


# ===========================================================================
# Motel court: two-storey L with an open walkway, a raised pool, googie sign
# ===========================================================================
def plot_motel_court():
    b = Building("plot_motel_court", "plot")
    b.look = dict(stucco="lilac", trim="warm_white", neon="red", awning="teal")
    mb = b.mb
    rng = np.random.default_rng(505)
    T = TERRACE_Y
    XL, XR, ZB, ZF, XW, ZL = -9.3, 6.2, -7.8, -3.8, -5.3, 2.4
    L = Path([(XL, ZB), (XR, ZB), (XR, ZF), (XW, ZF), (XW, ZL), (XL, ZL)], closed=True)
    y1, y2, yp = 3.05, 6.1, 6.6
    # rooms: a door and a window each, on both inner faces, two storeys
    rooms_back = [XW + 0.35 + 2.85 * k for k in range(4)]   # back wing, facing +Z
    rooms_left = [ZF + 0.4 + 2.9 * k for k in range(2)]     # left wing, facing +X

    def ops(ya):
        o = []
        for x in rooms_back:
            o.append(_o(L, (x + 1.25, ZF), (x + 2.45, ZF), depth=0.18, pane_w=0.6, rng=rng))
        for z in rooms_left:
            o.append(_o(L, (XW, z + 1.25), (XW, z + 2.45), depth=0.18, pane_w=0.6, rng=rng))
        o.append(_o(L, (XL + 0.6, ZL), (XW - 0.4, ZL), depth=0.2, pane_w=1.1, transom=0.8, rng=rng,
                    cells=[D.LIGHT_PANEL_CELL, 3, D.LIGHT_PANEL_CELL]) if ya < 1 else
                 _o(L, (XL + 0.9, ZL), (XW - 0.9, ZL), depth=0.18, pane_w=0.7, rng=rng))
        for x in (-6.5, -1.5, 3.5):
            o.append(_o(L, (x - 0.5, ZB), (x + 0.5, ZB), depth=0.15, pane_w=0.5, rng=rng))
        return o
    for (y0, ya, yb, yt) in ((0.0, 0.95, 2.25, y1), (y1, y1 + 0.95, y1 + 2.25, y2)):
        D.solid_band(mb, L, y0, ya)
        D.window_band(mb, L, ya, yb, ops(ya), rng=rng)
        D.solid_band(mb, L, yb, yt)
        for x in rooms_back:
            D.applied_door(mb, x, x + 0.95, y0 + 0.02, y0 + 2.2, ZF, panes=1, cell=D.room_cell(rng))
            N.sconce(mb, x + 1.1, y0 + 2.05, ZF)
        for z in rooms_left:
            with mb.at(XW, 0.0, z + 1.0, 90):
                D.applied_door(mb, -0.475, 0.475, y0 + 0.02, y0 + 2.2, 0.0, panes=1, cell=D.room_cell(rng))
            N.sconce(mb, XW, y0 + 2.05, z + 0.4, n=(1, 0))
    D.solid_band(mb, L, y2, yp)
    D.parapet(mb, L, y2, yp, th=0.24)
    D.band_ledge(mb, L, None, None, y1 - 0.12, out=0.06, h=0.12)
    # office at the front of the left wing: door, eyebrow, sign
    D.applied_door(mb, -6.4, -5.6, 0.0, 2.6, ZL, panes=1, cell=D.LIGHT_PANEL_CELL)
    D.eyebrow(mb, L, L.s_of((XL, ZL)), L.s_of((XW, ZL)), 2.75, depth=0.7, thick=0.13, ext=0.0)
    face = F.sign_board(mb, -8.9, -6.1, 3.55, 4.15, ZL + 0.12, depth=0.1)
    sign_face_node(b, face)
    # open walkway on the upper floor with pipe rails, columns, and a stair
    mb.box(XW, XR, y1 - 0.2, y1, ZF, ZF + 1.3, "trim", bevel=0.03, segs=1)
    mb.box(XW, XW + 1.3, y1 - 0.2, y1, ZF + 1.3, ZL, "trim", bevel=0.03, segs=1)
    rail = [(XW + 1.25, 0, ZL - 0.05), (XW + 1.25, 0, ZF + 1.25), (XR - 0.05, 0, ZF + 1.25)]
    for y in (y1 + 0.5, y1 + 0.98):
        mb.tube([(x, y, z) for (x, _, z) in rail], 0.025, "metal", seg=6)
    for k in range(9):
        x = XW + 1.25 + (XR - XW - 1.3) * k / 8
        mb.cylinder(x, ZF + 1.25, 0.02, y1, y1 + 0.98, "metal", seg=6, caps=False)
    for k in range(4):
        z = ZF + 1.25 + (ZL - ZF - 1.3) * (k + 1) / 4
        mb.cylinder(XW + 1.25, z, 0.02, y1, y1 + 0.98, "metal", seg=6, caps=False)
    for x in (XW + 1.15, -1.4, 2.4, XR - 0.15):
        mb.cylinder(x, ZF + 1.15, 0.06, 0.0, y1 - 0.2, "metal", seg=8, caps=False)
    mb.cylinder(XW + 1.15, ZL - 0.2, 0.06, 0.0, y1 - 0.2, "metal", seg=8, caps=False)
    nst = 16
    for k in range(nst):
        x = XR + 0.1 + 3.0 * k / nst
        yy = y1 - (k + 1) * y1 / nst
        mb.box(x, x + 3.0 / nst + 0.02, yy - 0.05, yy, ZF + 0.05, ZF + 1.2, "concrete", bevel=0.01, segs=1)
    for z in (ZF + 0.05, ZF + 1.2):
        mb.tube([(XR + 0.1, y1 - 0.05, z), (XR + 3.1, 0.05, z)], 0.04, "metal", seg=6)
        mb.tube([(XR + 0.1, y1 + 0.95, z), (XR + 3.1, 0.95, z)], 0.022, "metal", seg=6)
        mb.cylinder(XR + 3.1, z, 0.022, 0.0, 0.95, "metal", seg=6, caps=False)
    # ---- court: terrace, raised pool, loungers, tables ------------------------
    terr = rrect(-9.7, 9.7, ZF - 0.05, 7.2, (0, 0, 0.7, 0.7), seg=4)
    mb.slab(terr, 0.0, T, "terrazzo", bevel=0.012, segs=1, bottom=False)
    mb.slab(rrect(XL - 0.05, XW, ZF, ZL + 0.05, (0, 0, 0, 0), seg=1), 0.0, T, "terrazzo", bevel=0.0, segs=1,
            bottom=False, top=False)
    px0, px1, pz0, pz1 = -2.4, 4.0, -0.6, 2.4
    pool = stadium(px0, px1, pz0, pz1, seg=8)
    yc = T + SEAT_H
    mb.ring_sweep(pool, [(0.0, 0.0), (0.0, yc - 0.06)], "stucco")
    mb.ring_sweep(pool, [(0.0, yc - 0.06), (0.035, yc - 0.06), (0.035, yc - 0.02), (0.015, yc), (-0.32, yc),
                         (-0.34, yc - 0.02), (-0.34, yc - 0.16)], "trim")
    inner = pool.offset(-0.34)
    mb.poly_n([(q[0], yc - 0.14, q[1]) for q in inner.pts], "water", (0, 1, 0))
    D.speed_lines(mb, pool, pool.s_of((px1, pz1)), pool.s_of((px0, pz1)), 0.14, n=2, gap=0.12, h=0.04, out=0.02)
    mb.tube([(1.6, yc, pz1 - 0.2), (1.6, yc + 0.85, pz1 - 0.2), (1.6, yc + 0.85, pz1 - 0.45),
             (1.6, yc - 0.1, pz1 - 0.45)], 0.022, "metal", seg=6)
    b.spots.append({"kind": "steps", "pos": (0.2, T, pz1 + 0.03 - 0.2), "yaw": 0.0, "seat_h": SEAT_H,
                    "table_h": None})
    for k, x in enumerate((5.0, 6.6)):
        with mb.at(x, T, 0.9, 0):
            if k == 0:
                b.add(F.lounger(mb))
            else:
                F.lounger(mb)
    for (x, z, yaw, umb) in ((-3.8, 4.4, 15, True), (-0.6, 5.1, 0, False), (2.7, 4.9, -10, True),
                             (6.0, 4.5, -20, False)):
        with mb.at(x, T, z, yaw):
            b.add(F.cafe_table_set(mb))
            if umb:
                with mb.at(0.45, 0.0, -0.95):
                    F.umbrella(mb, r=1.2, h=2.4)
    p1 = F.round_planter(mb, -3.3, -1.6, r=0.45, h=0.55)
    p2 = F.round_planter(mb, -8.7, 6.4, r=0.5, h=0.6)
    p3 = F.round_planter(mb, 8.9, 0.2, r=0.45, h=0.55)
    soils = [F.planter(mb, XW + 1.5, XW + 3.0, ZL - 0.5, ZL, h=0.45), F.planter(mb, 4.6, 6.0, ZF + 1.5, ZF + 2.0, h=0.45)]
    plant(b, soils)
    b.prop("exterior_aircon_unit", (-7.3, y2, -6.6), 0.0)
    b.prop("exterior_aircon_unit", (1.5, y2, -6.6), 0.0)
    b.prop("exterior_aircon_unit", (-7.3, y2, 0.5), 90.0)
    street_lamps(b)
    # ---- googie sign at the front right --------------------------------------
    gx, gz = 8.4, 6.2
    for dx in (-0.45, 0.45):
        mb.cylinder(gx + dx, gz, 0.09, 0.0, 8.4, "metal", seg=10)
    face2 = F.sign_board(mb, gx - 1.35, gx + 1.35, 5.7, 7.2, gz + 0.2, depth=0.22)
    sign_face_node(b, face2, name="sign_face_2")
    arrow = [(gx + 0.9, 4.1), (gx - 1.1, 4.1), (gx - 1.1, 3.75), (gx - 1.9, 4.35), (gx - 1.1, 4.95), (gx - 1.1, 4.6),
             (gx + 0.9, 4.6)]
    mb.poly_n([(x, y, gz + 0.15) for (x, y) in arrow], "trim", (0, 0, 1))
    mb.poly_n([(x, y, gz + 0.05) for (x, y) in arrow], "trim", (0, 0, -1))
    for i in range(len(arrow)):
        (xa, ya), (xb, yb_) = arrow[i], arrow[(i + 1) % len(arrow)]
        nx, ny = yb_ - ya, -(xb - xa)
        mb.poly_n([(xa, ya, gz + 0.05), (xb, yb_, gz + 0.05), (xb, yb_, gz + 0.15), (xa, ya, gz + 0.15)], "stucco",
                  (nx, ny, 0))
        segs = max(1, int(math.hypot(xb - xa, yb_ - ya) / 0.2))
        for k in range(segs):
            t = k / segs
            N.dot(mb, xa + (xb - xa) * t, ya + (yb_ - ya) * t, gz + 0.19, 0.045)
    mb.lathe([(0, 8.4), (0.35, 8.45), (0.42, 8.6), (0.35, 8.75), (0, 8.8)], gx, gz, "neon_accent", seg=12)
    # ---- night life --------------------------------------------------------------
    P = [N.pole(mb, x, z, 3.3, y0=T) for (x, z) in ((-7.0, 6.3), (-2.2, 6.6), (2.0, 6.6), (6.4, 6.4))]
    rt = y1 + 0.98
    N.string_lights(mb, [(XW + 1.25, rt, 1.6), P[0], (XW + 1.25, rt, -1.0), P[1], (-1.0, rt, ZF + 1.25), P[2],
                         (3.0, rt, ZF + 1.25), P[3], (XR - 0.1, rt, ZF + 1.25)])
    b.light((0.8, 3.5, 3.1), 6.0, "warm")
    b.light((-2.4, 3.2, 4.8), 4.5, "warm")
    b.light((4.6, 3.2, 6.1), 4.5, "warm")
    b.light((0.4, 2.6, ZF + 0.9), 4.0, "amber")
    b.palm(p1, 9.5, 10)
    b.palm(p2, 8.0, 140)
    b.palm(p3, 10.5, 230)
    b.anchors = {"tag_anchor": (-1.0, 9.6, -5.0), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Motel court: two-storey L of rooms with a lamp by every door, an open upper walkway with pipe rails "
               "and an outside stair, office with an eyebrow, a raised pool whose coping is a seat, loungers, "
               "poolside tables and a googie sign with a bulb-lit arrow.")
    return b


# ===========================================================================
# Marina office: streamline ship-like base, bridge deck, lookout tower, boat
# ===========================================================================
def plot_marina_office():
    b = Building("plot_marina_office", "plot")
    b.look = dict(stucco="shell", trim="warm_white", neon="aqua", awning="teal")
    mb = b.mb
    rng = np.random.default_rng(506)
    T = 0.08
    X0, X1, Z0, Z1 = -8.8, 3.4, -7.6, -3.0
    base = rrect(X0, X1, Z0, Z1, (2.3, 0, 0, 2.3), seg=10)
    yb = 3.6
    ops = [
        D.Opening(min(base.s_of((-6.4, Z1)), base.s_of((X0, -5.3))), max(base.s_of((-6.4, Z1)), base.s_of((X0, -5.3))),
                  depth=0.2, pane_w=1.0, transom=0.75, rng=rng),
        _o(base, (-4.4, Z1), (-1.0, Z1), depth=0.32, pane_w=0.85, rng=rng, sill=False,
           cells=[D.LIGHT_PANEL_CELL, 3, D.LIGHT_PANEL_CELL, 6]),
        _o(base, (0.9, Z1), (X1 - 0.3, Z1), depth=0.2, pane_w=0.8, transom=0.75, rng=rng),
    ]
    ctop = T + STOOL_RAISE + DESK_H
    mb.ring_sweep(base, [(0.0, 0.0), (0.04, 0.0), (0.04, 0.55), (0.02, 0.6), (0.0, 0.6)], "concrete")
    D.solid_band(mb, base, 0.6, ctop + 0.02)
    D.window_band(mb, base, ctop + 0.02, 2.75, ops, rng=rng)
    D.solid_band(mb, base, 2.75, yb)
    D.applied_door(mb, -0.75, 0.55, T, 2.6, Z1, panes=2, cell=D.LIGHT_PANEL_CELL)
    for x in (-7.0, -5.6):
        pass
    D.speed_lines(mb, base, base.s_of((X1, Z1)), base.s_of((X0, -5.3)), 2.95, n=2, gap=0.15, h=0.05, out=0.03)
    # roof deck: railing around the edge
    mb.slab(base.offset(0.12), yb, yb + 0.16, "trim", bevel=0.04, segs=1, top=False)
    D.roof_fill(mb, base.offset(0.12), yb + 0.16, mat="wood")
    rp = base.offset(0.02)
    for y in (yb + 0.55, yb + 0.85, yb + 1.12):
        mb.tube([(x, y, z) for (x, z, *_r) in rp.full()] + [(rp.full()[0][0], y, rp.full()[0][1])], 0.022, "metal",
                seg=6)
    for k in range(18):
        x, z, *_r = rp.point(rp.L * k / 18)
        mb.cylinder(x, z, 0.022, yb + 0.16, yb + 1.12, "metal", seg=6, caps=False)
    # hire counter ledge under a shallow striped awning
    ctop = counter_ledge(mb, -4.5, -0.9, Z1, T, depth=0.45)
    D.striped_awning(mb, -4.7, -0.7, Z1, 3.15, 0.85, 0.32, valance=0.2)
    for k, x in enumerate((-3.6, -1.8)):
        with mb.at(x, T, Z1 + 0.45 + F.DESK_EDGE, 180):
            F.stool(mb)
            b.spots.append(F.spot(mb, "stool", (0, STOOL_RAISE, 0), 0.0, seat_h=SEAT_H, table_h=DESK_H,
                                  table_edge=F.DESK_EDGE))
            b.props.append(F.prop(mb, "classic_laptop", (0, ctop - T, F.DESK_EDGE + 0.2), 180.0))
    # nameboard with bulbs on the front rail
    face = F.sign_board(mb, -7.4, -4.9, yb + 0.25, yb + 1.05, Z1 + 0.2, depth=0.08, neon=False)
    sign_face_node(b, face)
    N.marquee_bulbs(mb, -7.33, -4.97, yb + 0.31, yb + 0.99, Z1 + 0.205, step=0.2)
    # bridge deck: wraparound ribbon glass, floating roof, neon edge
    br = rrect(-6.8, 0.4, -7.2, -4.0, (1.6, 0, 0, 1.6), seg=8)
    a, c = br.s_of((0.2, -4.0)), br.s_of((-6.8, -6.0))
    D.solid_band(mb, br, yb + 0.16, yb + 0.7)
    D.window_band(mb, br, yb + 0.7, yb + 2.25, [D.Opening(min(a, c), max(a, c), depth=0.15, pane_w=0.9, transom=None,
                                                         rng=rng, sill=False)], rng=rng)
    D.solid_band(mb, br, yb + 2.25, yb + 2.7)
    brr = br.offset(0.45)
    mb.slab(brr, yb + 2.7, yb + 2.92, "trim", bevel=0.05, segs=2)
    D.neon_on_path(mb, brr, brr.s_of((0.85, -3.55)), brr.s_of((-7.25, -6.0)), yb + 2.81, off=0.03, r=0.02)
    # lookout tower with portholes, a balcony and a lantern room
    tx, tz, tr = 2.0, -5.3, 1.45
    tw = circle_path(tx, tz, tr, seg=24)
    yt = 9.2
    D.solid_band(mb, tw, yb, yt)
    for y in (4.8, 7.3):
        D.porthole(mb, (tx, y, tz + tr), (0, 1), 0.36, cell=D.room_cell(rng), seg=16)
    D.speed_lines(mb, tw, 0.0, tw.L * 0.999, yt - 0.7, n=2, gap=0.15, h=0.05)
    mb.slab(circle_path(tx, tz, tr + 0.6, seg=24), yt, yt + 0.16, "trim", bevel=0.04, segs=1)
    rail = circle_path(tx, tz, tr + 0.55, seg=24)
    for y in (yt + 0.55, yt + 0.95):
        mb.tube([(x, y, z) for (x, z, *_r) in rail.full()], 0.022, "metal", seg=6, closed=True)
    lr = circle_path(tx, tz, 0.85, seg=12)
    D.window_band(mb, lr, yt + 0.16, yt + 1.3, [D.Opening(0.0, lr.L * 0.999, depth=0.05, pane_w=0.45, rng=rng,
                                                         sill=False, cells=[D.LIGHT_PANEL_CELL])], rng=rng)
    mb.lathe([(0, yt + 1.3), (1.0, yt + 1.3), (1.0, yt + 1.4), (0.4, yt + 1.8), (0.08, yt + 1.95), (0, yt + 2.0)], tx, tz,
             "metal", seg=16)
    mast_top = yt + 4.6
    mb.cylinder(tx, tz, 0.05, yt + 1.95, mast_top, "metal", seg=8, caps=False)
    mb.tube([(tx - 1.0, mast_top - 0.8, tz), (tx + 1.0, mast_top - 0.8, tz)], 0.03, "metal", seg=6)
    N.globe(mb, tx, mast_top + 0.08, tz, r=0.09, seg=8)
    lifebuoy(mb, (tx, 2.2, tz + tr), (0, 1))
    # ---- dock deck, boat on cradles, bollards, tables ---------------------------
    dock = rrect(-9.7, 9.7, Z1 - 0.1, 7.2, (0, 0, 0.6, 0.6), seg=4)
    mb.slab(dock, 0.0, T, "wood", bevel=0.012, segs=1, bottom=False)
    for x in (-8.0, -3.0, 2.0, 7.0):
        mb.lathe([(0, T), (0.16, T), (0.16, T + 0.45), (0.11, T + 0.5), (0.2, T + 0.55), (0.2, T + 0.62), (0, T + 0.62)],
                 x, 6.9, "metal", seg=10)
    with mb.at(6.0, T + 0.48, 3.4, 0):
        dinghy(mb, length=4.2, beam=1.55, depth=0.6)
    for x in (4.9, 7.1):
        cradle(mb, x, 3.4, w=1.3, h=T + 0.55)
    for (x, z, yaw, umb) in ((-6.4, 3.6, 15, True), (-2.4, 4.4, -10, False)):
        with mb.at(x, T, z, yaw):
            b.add(F.cafe_table_set(mb))
            if umb:
                with mb.at(0.45, 0.0, -0.95):
                    F.umbrella(mb, r=1.2, h=2.4)
    with mb.at(-0.6, T, 6.05, 0):
        b.add(F.bench(mb, 1.8))
    with mb.at(4.4, T, 0.7, 20):
        b.add(F.poseur_table(mb, top="wood"))
    p1 = F.round_planter(mb, -9.1, 6.4, r=0.45, h=0.55)
    p2 = F.round_planter(mb, 9.1, -1.6, r=0.45, h=0.55)
    p3 = F.round_planter(mb, 9.1, 6.4, r=0.4, h=0.55)
    soils = [F.planter(mb, -8.4, -6.8, Z1 + 0.1, Z1 + 0.55, h=0.45)]
    plant(b, soils)
    b.prop("ocean_buoy", (8.4, T + 0.8, -4.6), 0.0)
    b.prop("exterior_aircon_unit", (-2.2, yb + 0.16, -6.9), 0.0)
    street_lamps(b)
    # ---- night life: dressing lines from the mast, festoons over the tables -----
    P = [N.pole(mb, x, z, 3.3, y0=T) for (x, z) in ((-8.6, 5.6), (-4.4, 6.3), (0.0, 5.0), (8.8, 5.4))]
    top = (tx, mast_top - 0.05, tz)
    N.string_lights(mb, [P[0], top, P[3]], sag=0.5, spacing=0.6)
    N.string_lights(mb, [(-7.8, yb + 1.1, Z1 + 0.25), P[0], P[1], (-3.0, yb + 1.1, Z1 + 0.08), P[2],
                         (1.8, yb + 1.1, Z1 + 0.08)])
    for x in (-1.05, 0.85):
        N.sconce(mb, x, 2.25, Z1)
    b.light((-4.2, 3.2, 3.8), 5.0, "warm", floor_y=T)
    b.light((-2.7, 2.6, -1.8), 3.5, "candle", floor_y=T)
    b.light((4.8, 3.2, 2.2), 4.5, "warm", floor_y=T)
    b.palm(p1, 8.0, 60)
    b.palm(p2, 10.0, 170)
    b.palm(p3, 7.0, 290)
    b.anchors = {"tag_anchor": (-1.0, 15.6, -5.3), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Marina / boat-hire office: ship-like streamline base with a rounded bow, railed roof deck and a "
               "wraparound bridge, a lookout tower with portholes and a lantern room, mast with bulb dressing lines; "
               "hire counter with stools under a shallow awning, a dinghy on cradles, dock tables and bollards.")
    return b


# ===========================================================================
# Trailer: rounded aluminium trailer under palms, deck, picnic table, cabana
# ===========================================================================
def _trailer(mb, x0, x1, zc, y0, W=2.5, H=2.55, n_st=22, n_sec=18):
    L = x1 - x0
    secs = []
    for i in range(n_st):
        u = -math.cos(math.pi * i / (n_st - 1))
        x = x0 + L * (u + 1) / 2
        f_w = max(0.06, (1 - abs(u) ** 5.0) ** 0.2)
        f_h = max(0.06, (1 - abs(u) ** 4.0) ** 0.25)
        h = H * f_h
        yc = y0 + h / 2 + (H - h) * 0.28
        w = W / 2 * f_w
        sec = []
        for k in range(n_sec):
            ph = 2 * math.pi * k / n_sec
            c, s_ = math.cos(ph), math.sin(ph)
            sec.append((x, yc + h / 2 * math.copysign(abs(s_) ** (2 / 3.0), s_),
                        zc + w * math.copysign(abs(c) ** (2 / 3.0), c)))
        secs.append(sec)
    with mb.soft():
        loft(mb, secs, "metal", centre=((x0 + x1) / 2, y0 + H / 2, zc))
        for sec, sgn in ((secs[0], -1), (secs[-1], 1)):
            mb.poly_n(sec, "metal", (sgn, 0, 0))
    # white rub rails along both sides and a belt line, following the skin
    cy = y0 + H / 2
    for k in (n_sec - 2, 0, 2, n_sec // 2 - 2, n_sec // 2, n_sec // 2 + 2):
        pts = []
        for sec in secs[2:-2]:
            p = sec[k]
            d = (0.0, p[1] - cy, p[2] - zc)
            L = math.hypot(d[1], d[2]) or 1.0
            pts.append((p[0], p[1] + d[1] / L * 0.012, p[2] + d[2] / L * 0.012))
        mb.tube(pts, 0.014 if k % (n_sec // 2) else 0.022, "trim", seg=5)


def plot_trailer():
    b = Building("plot_trailer", "plot")
    b.look = dict(stucco="mint", trim="warm_white", neon="amber", awning="coral",
                  extra={"metal": {"rough": 0.34}})  # brushed aluminium rather than chrome
    mb = b.mb
    rng = np.random.default_rng(507)
    T = TERRACE_Y
    yard = rrect(-9.7, 9.7, -7.9, 7.2, (0.3, 0.3, 0.7, 0.7), seg=4)
    mb.slab(yard, 0.0, T, "concrete", bevel=0.012, segs=1, bottom=False)
    # ---- the trailer ---------------------------------------------------------
    tx0, tx1, tzc, ty0, W, H = -6.4, 2.4, -4.6, 0.5, 2.5, 2.55
    _trailer(mb, tx0, tx1, tzc, ty0, W, H)
    zs = tzc + W / 2 + 0.012
    for (wx0, wx1) in ((-5.6, -4.5), (-4.2, -3.1), (0.2, 1.3)):
        mb.poly_n([(wx0, ty0 + 1.25, zs), (wx1, ty0 + 1.25, zs), (wx1, ty0 + 1.85, zs), (wx0, ty0 + 1.85, zs)], "interior",
                  (0, 0, 1), [(lambda r: (r[0], r[1]))(p) for p in
                              [D.atlas_rect(c)[:2] for c in (5,)] * 0 + [(0.27, 0.52), (0.48, 0.52), (0.48, 0.73),
                                                                          (0.27, 0.73)]])
        mb.box(wx0 - 0.05, wx1 + 0.05, ty0 + 1.2, ty0 + 1.9, zs - 0.012, zs - 0.004, "trim")
    dx0, dx1 = -1.55, -0.8
    mb.box(dx0 - 0.05, dx1 + 0.05, ty0 + 0.08, ty0 + 2.05, zs - 0.012, zs + 0.006, "trim")
    mb.poly_n([(dx0 + 0.15, ty0 + 1.35, zs + 0.008), (dx1 - 0.15, ty0 + 1.35, zs + 0.008),
               (dx1 - 0.15, ty0 + 1.85, zs + 0.008), (dx0 + 0.15, ty0 + 1.85, zs + 0.008)], "interior", (0, 0, 1),
              [D.panel_uv()] * 4)
    # wheels, hitch, propane bottles
    for x in (-2.4, -1.6):
        for z in (tzc - W / 2 + 0.12, tzc + W / 2 - 0.12):
            with mb.at(x, 0.36, z, 0, pitch=90):
                mb.cylinder(0, 0, 0.34, -0.1, 0.1, "concrete", seg=14, bevel=0.03)
                mb.cylinder(0, 0, 0.18, -0.11, 0.11, "metal", seg=10)
    mb.tube([(tx0 + 0.3, ty0 + 0.1, tzc - 0.8), (tx0 - 1.3, 0.55, tzc), (tx0 + 0.3, ty0 + 0.1, tzc + 0.8)], 0.05,
            "metal", seg=6)
    mb.cylinder(tx0 - 1.2, tzc, 0.05, 0.0, 0.55, "metal", seg=8)
    for z in (tzc - 0.3, tzc + 0.3):
        mb.lathe([(0, 0.62), (0.17, 0.62), (0.18, 0.72), (0.18, 1.05), (0.12, 1.15), (0.04, 1.2), (0, 1.2)],
                 tx0 - 0.6, z, "trim", seg=12)
    # striped awning off the left part of the trailer (no spot under it)
    D.striped_awning(mb, -6.0, -3.2, zs - 0.02, ty0 + 2.0, 1.7, 0.45, valance=0.22, posts=(-5.9, -3.3))
    # entry step: the "steps" spot sits on it
    sy = 0.3 + SEAT_H
    mb.box(dx0 - 0.05, dx1 + 0.05, 0.0, sy, zs, zs + 0.42, "metal", bevel=0.015, segs=1)
    # ---- deck with a picnic table ----------------------------------------------
    F0 = 0.3
    deck = rrect(-7.0, 3.6, -3.0, 1.8, (0, 0, 0.3, 0.3), seg=3)
    mb.slab(deck, 0.0, F0, "wood", bevel=0.015, segs=1, bottom=False)
    for k, (za, zb, yt) in enumerate(((1.78, 2.12, 0.2), (2.12, 2.46, 0.1))):
        mb.box(-2.8, -1.0, 0.0, yt, za, zb, "wood", bevel=0.01, segs=1, edges="top")
    mb.box(dx0 - 0.05, dx1 + 0.05, 0.0, sy, -3.0, -2.95, "wood")
    b.spots.append({"kind": "steps", "pos": ((dx0 + dx1) / 2, F0, zs + 0.42 - 0.2 + 0.18), "yaw": 0.0, "seat_h": SEAT_H,
                    "table_h": None})
    pt_x, pt_z = 0.6, -0.3
    yt = F0 + DESK_H
    mb.box(pt_x - 1.0, pt_x + 1.0, yt - 0.05, yt, pt_z - 0.4, pt_z + 0.4, "wood", bevel=0.012, segs=1)
    for zz in (pt_z - 0.75, pt_z + 0.75):
        mb.box(pt_x - 1.0, pt_x + 1.0, F0 + SEAT_H - 0.045, F0 + SEAT_H, zz - 0.14, zz + 0.14, "wood", bevel=0.01, segs=1)
    for x in (pt_x - 0.75, pt_x + 0.75):
        for sgn in (-1, 1):
            mb.box(x - 0.04, x + 0.04, F0, yt - 0.05, pt_z + sgn * 0.85 - 0.04, pt_z + sgn * 0.85 + 0.04, "wood")
            mb.tube([(x, F0, pt_z + sgn * 0.85), (x, yt - 0.06, pt_z + sgn * 0.1)], 0.035, "wood", seg=4)
    for (x, zz, yaw) in ((pt_x - 0.45, pt_z - 0.4 - F.DESK_EDGE, 0.0), (pt_x + 0.45, pt_z + 0.4 + F.DESK_EDGE, 180.0)):
        with mb.at(x, F0, zz, yaw):
            b.spots.append(F.spot(mb, "desk", seat_h=SEAT_H, table_h=DESK_H, table_edge=F.DESK_EDGE))
            b.props.append(F.prop(mb, "classic_laptop", (0, DESK_H, F.DESK_EDGE + 0.24), 180.0))
    # ---- yard: folding table with two chairs, lounger, fire bowl -------------
    ftx, ftz = 4.9, 3.4
    mb.box(ftx - 0.45, ftx + 0.45, T + DESK_H - 0.03, T + DESK_H, ftz - 0.45, ftz + 0.45, "trim", bevel=0.01, segs=1)
    for sx in (-1, 1):
        mb.tube([(ftx + sx * 0.38, T, ftz - 0.4), (ftx - sx * 0.38, T + DESK_H - 0.04, ftz + 0.4)], 0.014, "metal", seg=5)
    table_chair(b, mb, ftx, T, ftz - 0.45 - F.DESK_EDGE, 0.0)
    table_chair(b, mb, ftx - 0.45 - F.DESK_EDGE, T, ftz + 0.05, 90.0)
    with mb.at(7.6, T, 1.2, -15):
        b.add(F.lounger(mb))
    mb.lathe([(0, 0.0), (0.55, 0.0), (0.62, 0.25), (0.66, 0.36), (0.5, 0.33), (0, 0.2)], -5.0, 4.6, "concrete", seg=14)
    b.prop("mid_century_lounge_chair", (-6.4, T, 5.4), 140.0)
    b.prop("mid_century_lounge_chair", (-3.7, T, 5.6), 220.0)
    # ---- cabana: a little pastel bath house -------------------------------------
    cb = rrect(4.4, 9.0, -7.7, -4.3, (0, 0, 1.0, 0), seg=6)
    D.solid_band(mb, cb, 0.0, 2.95)
    D.applied_door(mb, 5.0, 5.9, 0.0, 2.2, -4.3, panes=1, cell=D.LIGHT_PANEL_CELL)
    D.porthole(mb, (7.0, 1.7, -4.3), (0, 1), 0.34, cell=D.room_cell(rng), seg=16)
    mb.box(6.2, 6.6, 0.9, 2.4, -4.32, -4.28, "glass_block")
    cbr = cb.offset(0.35)
    mb.slab(cbr, 2.95, 3.15, "trim", bevel=0.04, segs=1)
    D.speed_lines(mb, cb, cb.s_of((9.0, -4.6)), cb.s_of((7.6, -4.3)), 2.5, n=3, gap=0.12, h=0.04)
    p = [F.round_planter(mb, -8.9, 1.1, r=0.45, h=0.55), F.round_planter(mb, 8.95, 3.9, r=0.45, h=0.55),
         F.round_planter(mb, -8.9, 6.4, r=0.4, h=0.55)]
    soils = [F.planter(mb, 0.6, 3.4, 6.4, 6.9, h=0.45)]
    plant(b, soils)
    street_lamps(b)
    # ---- camp sign: a round badge on a pole ---------------------------------
    sx, sz = 8.7, 6.4
    mb.cylinder(sx, sz, 0.07, 0.0, 4.2, "metal", seg=8)
    with mb.at(sx, 4.9, sz, 0, pitch=90):
        mb.cylinder(0, 0, 0.85, -0.08, 0.08, "stucco", seg=24, bevel=0.03)
    D.neon_tube(mb, [(sx + 0.72 * math.cos(2 * math.pi * k / 24), 4.9 + 0.72 * math.sin(2 * math.pi * k / 24), sz + 0.11)
                     for k in range(24)], r=0.02, closed=True)
    for k in range(18):
        a = 2 * math.pi * k / 18
        N.dot(mb, sx + 0.92 * math.cos(a), 4.9 + 0.92 * math.sin(a), sz + 0.06, 0.05)
    # ---- night life: festoons between timber poles near the palms -------------
    Pt = [N.timber_post(mb, x, z, 3.3, y0=T) for (x, z) in ((-7.9, 2.7), (-2.4, 5.6), (2.6, 2.3), (7.6, 5.4))]
    N.string_lights(mb, [(-6.0, ty0 + 1.5, zs + 1.68), Pt[0], Pt[1], Pt[2], (-3.2, ty0 + 1.5, zs + 1.68)])
    N.string_lights(mb, [Pt[2], Pt[3], (8.95, 3.0, -4.0)])
    N.sconce(mb, dx1 + 0.3, ty0 + 1.75, zs)
    b.light((-1.6, 3.0, 0.5), 5.0, "warm", floor_y=F0)
    b.light((5.7, 3.0, 2.4), 4.5, "warm")
    b.light((-1.2, 2.2, -2.4), 2.5, "amber", floor_y=F0)
    b.light((-5.0, 1.6, 4.6), 3.0, "amber")
    b.palm(p[0], 8.5, 20)
    b.palm(p[1], 9.5, 100)
    b.palm(p[2], 7.0, 200)
    b.palm((-8.6, T, -6.9), 10.5, 310)
    b.palm((3.4, T, -7.1), 9.0, 60)
    b.anchors = {"tag_anchor": (-2.0, 7.5, -4.6), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Rounded aluminium trailer under palms: polished bullet-ended trailer with a striped awning, timber "
               "deck with a picnic table, folding table in the yard, fire bowl, a pastel stucco cabana, a round camp "
               "sign lit with bulbs and festoons strung between timber poles.")
    return b


# ===========================================================================
# Record shop / gallery: narrow three-storey walk-up with a rooftop terrace
# ===========================================================================
def plot_record_shop():
    b = Building("plot_record_shop", "plot")
    b.look = dict(stucco="butter", trim="warm_white", neon="violet", awning="teal")
    mb = b.mb
    rng = np.random.default_rng(508)
    T = TERRACE_Y
    X0, X1, Z0, Z1 = -6.6, 3.4, -7.8, -2.2
    main = rrect(X0, X1, Z0, Z1, (0, 0, 0, 1.5), seg=8)
    y1, y2, y3, yp = 4.0, 7.0, 10.0, 10.6
    shop = [
        D.Opening(min(main.s_of((X0, -4.6)), main.s_of((-2.0, Z1))), max(main.s_of((X0, -4.6)), main.s_of((-2.0, Z1))),
                  depth=0.16, pane_w=1.15, rng=rng, sill=False, cells=[D.LIGHT_PANEL_CELL, 7, 2, D.LIGHT_PANEL_CELL]),
        _o(main, (-0.2, Z1), (3.0, Z1), depth=0.16, pane_w=1.05, rng=rng, sill=False, cells=[D.LIGHT_PANEL_CELL, 11, 4]),
    ]
    mb.ring_sweep(main, [(0.0, 0.0), (0.04, 0.0), (0.04, 0.4), (0.02, 0.44), (0.0, 0.44)], "terrazzo")
    D.solid_band(mb, main, 0.44, 1.08)
    D.window_band(mb, main, 1.08, 3.15, shop, rng=rng)
    gb = [D.Opening(min(main.s_of((X0, -4.6)), main.s_of((-2.0, Z1))), max(main.s_of((X0, -4.6)), main.s_of((-2.0, Z1))),
                    depth=0.1, mullion=None, sill=False, back="glass_block"),
          _o(main, (-0.2, Z1), (3.0, Z1), depth=0.1, mullion=None, sill=False, back="glass_block")]
    D.window_band(mb, main, 3.25, 3.6, gb, rng=rng)
    D.solid_band(mb, main, 3.15, 3.25)
    D.solid_band(mb, main, 3.6, y1 + 0.6)
    mb.box(-2.0, -0.2, 0.44, 1.08, Z1 - 0.3, Z1 - 0.29, "stucco")
    D.applied_door(mb, -1.7, -0.5, 0.0, 2.85, Z1 - 0.3, panes=1, cell=D.LIGHT_PANEL_CELL)
    mb.box(-2.0, -0.2, 0.0, T + 0.01, Z1 - 0.3, Z1, "terrazzo")
    for x in (-2.0, -0.2):
        mb.box(x - 0.01, x + 0.01, 0.0, 3.15, Z1 - 0.3, Z1, "stucco")
    mb.box(-2.0, -0.2, 3.13, 3.15, Z1 - 0.3, Z1, "stucco")
    a, c = main.s_of((3.0, Z1)), main.s_of((X0, -4.0))
    D.eyebrow(mb, main, min(a, c), max(a, c), 3.65, depth=0.85, thick=0.14, ext=0.0)

    def upper():
        o = [D.Opening(min(main.s_of((-3.6, Z1)), main.s_of((X0, -4.8))), max(main.s_of((-3.6, Z1)), main.s_of((X0, -4.8))),
                       depth=0.2, pane_w=0.95, transom=0.72, rng=rng),
             _o(main, (-2.4, Z1), (-0.9, Z1), depth=0.2, pane_w=0.75, transom=0.72, rng=rng),
             _o(main, (0.4, Z1), (2.9, Z1), depth=0.2, pane_w=0.85, transom=0.72, rng=rng),
             _o(main, (X1, -3.4), (X1, -5.0), depth=0.2, pane_w=0.8, transom=0.72, rng=rng)]
        for x in (-4.6, -1.6, 1.4):
            o.append(_o(main, (x - 0.6, Z0), (x + 0.6, Z0), depth=0.18, pane_w=0.6, rng=rng))
        return o
    for (ya, yb, yt) in ((y1 + 0.6, y1 + 2.4, y2 + 0.6), (y2 + 0.6, y2 + 2.4, yp)):
        D.window_band(mb, main, ya, yb, upper(), rng=rng)
        D.solid_band(mb, main, yb, yt)
        a, c = main.s_of((-3.5, Z1)), main.s_of((X0, -5.0))
        D.eyebrow(mb, main, min(a, c), max(a, c), yb + 0.08, depth=0.45, thick=0.11, ext=0.0)
    D.parapet(mb, main, y3, yp, th=0.25)
    a, c = main.s_of((-3.4, Z1)), main.s_of((X0, -6.0))
    D.speed_lines(mb, main, min(a, c), max(a, c), y3 + 0.05, n=2, gap=0.16, h=0.05)
    # round-ended balconies on the right of the upper floors
    for yy in (y1, y2):
        bal = rrect(0.1, X1 + 0.9, Z1 - 0.05, Z1 + 1.2, (0, 0, 0.62, 0), seg=6)
        mb.slab(bal, yy - 0.18, yy + 0.02, "trim", bevel=0.04, segs=1)
        a, c = bal.s_of((0.1, Z1 + 1.2)), bal.s_of((X1 + 0.9, Z1 + 0.1))
        for y in (yy + 0.45, yy + 0.72, yy + 0.98):
            mb.tube([(x + nx * -0.05, y, z + nz * -0.05) for (x, z, nx, nz, _s) in bal.sample(min(a, c), max(a, c))],
                    0.02, "metal", seg=6)
        mb.box(0.1, 0.3, yy, yy + 1.0, Z1, Z1 + 1.15, "stucco", bevel=0.03, segs=1)
    # central fin rising above the parapet
    D.fin(mb, -1.65, Z1, y1 + 0.3, yp + 1.4, 0.36, 0.22)
    D.neon_tube(mb, [(-1.65, y1 + 0.5, Z1 + 0.385), (-1.65, yp + 1.1, Z1 + 0.385)], r=0.02)
    # rooftop terrace: slim pergola frame and festoons (decor)
    for (x, z) in ((-5.6, -3.0), (2.4, -3.0), (-5.6, -6.8), (2.4, -6.8)):
        mb.box(x - 0.05, x + 0.05, y3, y3 + 2.4, z - 0.05, z + 0.05, "metal")
    for z in (-3.0, -6.8):
        mb.box(-5.65, 2.45, y3 + 2.35, y3 + 2.45, z - 0.05, z + 0.05, "metal")
    N.string_lights(mb, [(-5.6, y3 + 2.3, -3.0), (2.4, y3 + 2.3, -6.8)], sag=0.4)
    N.string_lights(mb, [(2.4, y3 + 2.3, -3.0), (-5.6, y3 + 2.3, -6.8)], sag=0.4)
    with mb.at(-2.0, y3, -5.6, 0):
        F.bench_back(mb, 2.0)
    soils_roof = [F.planter(mb, -5.6, -3.4, -7.3, -6.9, h=0.45)]
    for sp in soils_roof:
        sp_ = (sp[0], sp[1] + y3, sp[2])
    mb.box(-5.6, -3.4, y3, y3 + 0.45, -7.3, -6.9, "planter")
    # blade sign angled toward the street and the camera
    with mb.at(3.95, 0.0, -1.85, 50):
        face = F.sign_board(mb, -0.6, 0.6, 4.4, 10.8, 0.0, depth=0.22)
        sign_face_node(b, face, mb=mb)
        for k in range(30):
            y = 4.55 + (10.65 - 4.55) * k / 29
            for x in (-0.53, 0.53):
                N.dot(mb, x, y, 0.03, 0.04)
    for y in (5.0, 10.2):
        mb.tube([(3.4, y, -2.6), (3.75, y, -1.95)], 0.03, "metal", seg=6)
    # ---- gallery annex, single storey, roof terrace rail ---------------------
    an = rrect(X1, 9.4, -7.8, -3.6, (0, 0, 0.4, 0), seg=4)
    D.solid_band(mb, an, 0.0, 0.6)
    D.window_band(mb, an, 0.6, 2.9, [_o(an, (4.0, -3.6), (8.6, -3.6), depth=0.2, pane_w=1.15, transom=0.8, rng=rng)],
                  rng=rng)
    D.solid_band(mb, an, 2.9, 3.6)
    mb.slab(an.offset(0.25), 3.6, 3.8, "trim", bevel=0.04, segs=1, top=False)
    D.roof_fill(mb, an.offset(0.25), 3.8, mat="wood")
    for y in (4.3, 4.7):
        mb.tube([(X1 + 0.1, y, -3.45), (9.55, y, -3.45), (9.55, y, -7.9)], 0.022, "metal", seg=6)
    # ---- terrace: tables, window ledge with stools, record crates -----------
    terr = rrect(-9.7, 9.7, Z1 - 0.1, 7.2, (0, 0, 0.7, 0.7), seg=4)
    mb.slab(terr, 0.0, T, "terrazzo", bevel=0.012, segs=1, bottom=False)
    mb.slab(rrect(X1 - 0.05, 9.7, -3.6, Z1 - 0.1, (0, 0, 0, 0), seg=1), 0.0, T, "terrazzo", bevel=0.0, segs=1,
            bottom=False)
    D.floor_fan(mb, -1.1, Z1 + 0.02, 0.5, 1.5, T + 0.006, rays=9)
    ctop = counter_ledge(mb, 0.0, 2.9, Z1, T, depth=0.42)
    for k, x in enumerate((0.75, 2.15)):
        with mb.at(x, T, Z1 + 0.42 + F.DESK_EDGE, 180):
            F.stool(mb)
            b.spots.append(F.spot(mb, "stool", (0, STOOL_RAISE, 0), 0.0, seat_h=SEAT_H, table_h=DESK_H,
                                  table_edge=F.DESK_EDGE))
            b.props.append(F.prop(mb, "classic_laptop", (0, ctop - T, F.DESK_EDGE + 0.2), 180.0))
    for (x, z, yaw, umb) in ((-4.4, 3.2, 12, True), (-0.6, 4.4, -8, False)):
        with mb.at(x, T, z, yaw):
            b.add(F.cafe_table_set(mb))
            if umb:
                with mb.at(0.45, 0.0, -0.95):
                    F.umbrella(mb, r=1.2, h=2.4)
    # crate table: a standing spot flipping through records
    cx_, cz_ = 5.2, 2.6
    with mb.at(cx_, T, cz_, 0):
        b.spots.append(F.spot(mb, "standing", table_h=1.05, table_edge=0.3))
        mb.box(-0.9, 0.9, 0.74, 0.78, 0.3, 1.0, "wood", bevel=0.01, segs=1)
        for x in (-0.82, 0.82):
            for z in (0.36, 0.94):
                mb.box(x - 0.03, x + 0.03, 0.0, 0.74, z - 0.03, z + 0.03, "metal")
        for k, x in enumerate((-0.55, 0.0, 0.55)):
            mb.box(x - 0.24, x + 0.24, 0.78, 1.04, 0.38, 0.92, "wood", bevel=0.008, segs=1)
            for j in range(6):
                z = 0.45 + j * 0.075
                pin = F.SWATCH_COLOUR if (j + k) % 2 else F.SWATCH_WHITE
                F.pinned_box(mb, x - 0.2, x + 0.2, 0.86, 1.16 - 0.02 * (j % 3), z, z + 0.012, "awning", pin)
    with mb.at(6.4, T, -3.15, 0):
        b.add(F.bench_back(mb, 1.8))
    p1 = F.round_planter(mb, -9.0, 6.4, r=0.5, h=0.6)
    p2 = F.round_planter(mb, 9.05, 6.45, r=0.42, h=0.55)
    soils = [F.planter(mb, -6.4, -4.4, Z1 + 0.1, Z1 + 0.55, h=0.45), F.planter(mb, 2.2, 4.0, 6.4, 6.9, h=0.45)]
    plant(b, soils)
    b.prop("exterior_aircon_unit", (1.2, y3, -7.2), 0.0)
    b.prop("outdoor_table_chair_set_01", (-6.6, T, 5.4), 70.0)
    b.prop("outdoor_table_chair_set_01", (2.6, T, 4.4), 100.0)
    b.prop("mid_century_lounge_chair", (7.6, T, 0.6), 210.0)
    b.prop("painted_wooden_bench", (-4.6, T, 6.5), 180.0)
    with mb.at(-7.6, T, 1.4, 25):
        F.cafe_table_set(mb, laptop=False)
    street_lamps(b)
    # ---- night life ----------------------------------------------------------
    ye = 3.65 + 0.02
    P = [N.pole(mb, x, z, 3.2, y0=T) for (x, z) in ((-7.4, 6.2), (-2.4, 6.6), (3.0, 6.3), (8.4, 4.4))]
    N.string_lights(mb, [(X0 + 0.4, ye, Z1 + 0.75), P[0], (-3.4, ye, Z1 + 0.78), P[1], (1.2, ye, Z1 + 0.78), P[2],
                         (X1 - 0.3, ye, Z1 + 0.78)])
    N.string_lights(mb, [P[2], P[3], (8.9, 3.75, -3.4)])
    for x in (-2.2, 0.0):
        N.sconce(mb, x, 2.35, Z1)
    b.light((-2.6, 3.2, 3.2), 5.0, "warm")
    b.light((1.4, 3.0, -1.0), 3.5, "candle")
    b.light((5.4, 3.0, 2.4), 4.5, "warm")
    b.palm(p1, 11.0, 75)
    b.palm(p2, 8.0, 240)
    b.anchors = {"tag_anchor": (-1.6, 14.4, -5.0), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Record shop / gallery walk-up: three storeys with a curved shop window, glass-block transom, eyebrows, "
               "round-ended balconies and a fin, an angled blade sign lined with bulbs, a rooftop terrace with "
               "festoons, a single-storey gallery annex; window ledge with stools, crate table, sidewalk tables.")
    return b


BUILDERS = {
    "plot_beach_bar": plot_beach_bar,
    "plot_coworking": plot_coworking,
    "plot_surf_shop": plot_surf_shop,
    "plot_juice_kiosk": plot_juice_kiosk,
    "plot_motel_court": plot_motel_court,
    "plot_marina_office": plot_marina_office,
    "plot_trailer": plot_trailer,
    "plot_record_shop": plot_record_shop,
}

# Which building stands on which plot (index = row * 4 + col; row 0 is the
# beachfront row, col 0 the west end). Beach types on the waterfront, the hero
# hotel in the front-row centre with a low kiosk in front of it so nothing
# hides it, the tallest kept off the row nearest the camera, neighbours always
# different, nothing more than twice except the hero and the marina (once).
# Plot index -> building type. 0-15 are the first four-by-four core (index =
# row * 4 + col); 16-31 the four outer columns, nearest first (see PLOTS in
# client/src/world/city/layout.ts). CELLS gives each index its [column, row] on the
# eight-column grid so check.mjs can test neighbours.
LAYOUT = {
    "plots": [
        "plot_surf_shop", "plot_deco_hotel", "plot_beach_cafe", "plot_marina_office",
        "plot_trailer", "plot_juice_kiosk", "plot_record_shop", "plot_motel_court",
        "plot_motel_court", "plot_diner", "plot_surf_shop", "plot_record_shop",
        "plot_juice_kiosk", "plot_beach_cafe", "plot_trailer", "plot_diner",
        "plot_diner", "plot_juice_kiosk", "plot_beach_cafe", "plot_trailer",
        "plot_juice_kiosk", "plot_beach_cafe", "plot_record_shop", "plot_motel_court",
        "plot_motel_court", "plot_record_shop", "plot_surf_shop", "plot_diner",
        "plot_deco_hotel", "plot_surf_shop", "plot_trailer", "plot_marina_office",
    ],
    "cells": [[2, 0], [3, 0], [4, 0], [5, 0], [2, 1], [3, 1], [4, 1], [5, 1], [2, 2], [3, 2], [4, 2], [5, 2], [2, 3], [3, 3], [4, 3], [5, 3], [1, 0], [6, 0], [1, 1], [6, 1], [1, 2], [6, 2], [1, 3], [6, 3], [0, 0], [7, 0], [0, 1], [7, 1], [0, 2], [7, 2], [0, 3], [7, 3]],
    "hangout": "plot_beach_bar",
    "overflow": "plot_coworking",
}
