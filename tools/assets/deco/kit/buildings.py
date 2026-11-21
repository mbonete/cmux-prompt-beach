"""The buildings. Each builder returns a Building describing its meshes,
empties and material choices; build_kit.py turns it into a glTF.

Coordinates: glTF space, metres. Plots are 20 x 16 m centred on the origin
with the street/terrace toward +Z; others sit on their base centre.
"""
import math

import numpy as np

from . import deco as D
from . import furniture as F
from .config import SEAT_H, DESK_H, STOOL_RAISE, TERRACE_Y
from .geo import MB, Path, rrect, circle_path, stadium, round_edge_section


class Building:
    def __init__(self, name, kind):
        self.name = name
        self.kind = kind  # plot | bg | tower
        self.mb = MB()
        self.extra = []    # (node name, MB)
        self.spots = []
        self.props = []
        self.anchors = {}
        self.look = {}     # material overrides for materials.resolve
        self.notes = ""

    def add(self, piece):
        if piece is None:
            return
        if piece.get("spot"):
            self.spots.append(piece["spot"])
        self.props.extend(piece.get("props", []))

    def prop(self, pid, pos, yaw=0.0):
        self.props.append({"id": pid, "pos": pos, "yaw": yaw})


def _o(path, p0, p1, **kw):
    a, b = path.s_of(p0), path.s_of(p1)
    return D.Opening(min(a, b), max(a, b), **kw)


# ===========================================================================
# Hero: the Deco hotel turned studio
# ===========================================================================
def plot_deco_hotel():
    b = Building("plot_deco_hotel", "plot")
    b.look = dict(stucco="flamingo", trim="warm_white", neon="violet", awning="teal")
    mb = b.mb
    rng = np.random.default_rng(101)
    T = TERRACE_Y

    # ---- main mass --------------------------------------------------------
    X0, X1, Z0, Z1 = -8.6, 8.6, -7.9, -1.4
    R = 1.6
    main = rrect(X0, X1, Z0, Z1, (0, 0, R, R), seg=8)
    y_gf0, y_f1, y_f2, y_roof, y_par = 0.55, 4.2, 7.4, 10.6, 11.45
    # band heights
    gf_a, gf_b = 0.95, 3.55
    f1_a, f1_b = 4.75, 6.55
    f2_a, f2_b = 7.95, 9.75

    def sx(x):  # point on the front run of the main mass
        return (x, Z1)

    def side(xs, z):
        return (xs, z)

    # ground floor: big studio windows on the wings, side and back windows
    gf_open = []
    for sgn in (-1, 1):
        gf_open.append(_o(main, sx(sgn * 3.15), sx(sgn * 6.75), depth=0.22, pane_w=1.2, transom=0.78, rng=rng))
        gf_open.append(_o(main, (sgn * X1, -4.1), (sgn * X1, -6.9), depth=0.22, pane_w=1.4, transom=0.78, rng=rng))
    for x in (-6.4, -2.0, 2.0, 6.4):
        gf_open.append(_o(main, (x - 0.9, Z0), (x + 0.9, Z0), depth=0.2, pane_w=0.9, transom=0.75, rng=rng))
    # upper floors: punched window + ribbon wrapping the rounded corner
    def upper(ya, yb):
        ops = []
        for sgn in (-1, 1):
            ops.append(_o(main, sx(sgn * 3.25), sx(sgn * 4.75), depth=0.2, pane_w=0.75, transom=0.72, rng=rng))
            # ribbon: from x=5.55 on the front, around the corner, to z=-4.7 on the side
            a = main.s_of(sx(sgn * 5.55))
            c = main.s_of((sgn * X1, -4.7))
            ops.append(D.Opening(min(a, c), max(a, c), depth=0.2, pane_w=1.05, transom=0.72, rng=rng))
            ops.append(_o(main, (sgn * X1, -5.6), (sgn * X1, -7.0), depth=0.2, pane_w=0.7, transom=0.72, rng=rng))
        for x in (-6.9, -4.6, -2.3, 0.0, 2.3, 4.6, 6.9):
            ops.append(_o(main, (x - 0.65, Z0), (x + 0.65, Z0), depth=0.2, pane_w=0.65, transom=0.72, rng=rng))
        return ops

    # plinth in terrazzo, then wall bands
    mb.ring_sweep(main, [(0.0, 0.0), (0.045, 0.0), (0.045, 0.5), (0.025, 0.55), (0.0, 0.55)], "terrazzo")
    D.solid_band(mb, main, 0.55, gf_a)
    D.window_band(mb, main, gf_a, gf_b, gf_open, rng=rng)
    D.solid_band(mb, main, gf_b, f1_a)
    up1 = upper(f1_a, f1_b)
    D.window_band(mb, main, f1_a, f1_b, up1, rng=rng)
    D.solid_band(mb, main, f1_b, f2_a)
    up2 = upper(f2_a, f2_b)
    D.window_band(mb, main, f2_a, f2_b, up2, rng=rng)
    D.solid_band(mb, main, f2_b, y_par)
    D.parapet(mb, main, y_roof, y_par, th=0.28)

    # continuous eyebrows over the upper floors: wings, wrapping both corners
    for yb in (f1_b, f2_b):
        for sgn in (-1, 1):
            a = main.s_of(sx(sgn * 3.05))
            c = main.s_of((sgn * X1, -4.9))
            D.eyebrow(mb, main, min(a, c), max(a, c), yb + 0.1, depth=0.5, thick=0.12, ext=0.0)
            a2 = main.s_of((sgn * X1, -5.45))
            c2 = main.s_of((sgn * X1, -7.15))
            D.eyebrow(mb, main, min(a2, c2), max(a2, c2), yb + 0.1, depth=0.38, thick=0.12, ext=0.0)
        for x in (-6.9, -4.6, -2.3, 0.0, 2.3, 4.6, 6.9):
            a, c = main.s_of((x - 0.8, Z0)), main.s_of((x + 0.8, Z0))
            D.eyebrow(mb, main, min(a, c), max(a, c), yb + 0.1, depth=0.34, thick=0.11, ext=0.0)
    # ground-floor canopy eyebrow, deeper, across the wings
    for sgn in (-1, 1):
        a = main.s_of(sx(sgn * 2.6))
        c = main.s_of((sgn * X1, -3.6))
        D.eyebrow(mb, main, min(a, c), max(a, c), gf_b + 0.18, depth=0.85, thick=0.14, ext=0.0)
    # speed lines across the parapet band, wrapping the corners
    for sgn in (-1, 1):
        a = main.s_of(sx(sgn * 2.6))
        c = main.s_of((sgn * X1, -6.2))
        D.speed_lines(mb, main, min(a, c), max(a, c), y_roof + 0.08, n=1)
        D.speed_lines(mb, main, min(a, c), max(a, c), y_roof + 0.42, n=1)
        D.neon_on_path(mb, main, min(a, c), max(a, c), y_roof + 0.29, off=0.035, r=0.024)
    # belt course between the plinth and ground floor glazing
    D.band_ledge(mb, main, None, None, 0.82, out=0.05, h=0.1)

    # ---- centre bay -------------------------------------------------------
    BX, BZ0, BZ1 = 2.6, -2.1, -0.75
    bay = rrect(-BX, BX, BZ0, BZ1, (0, 0, 0.18, 0.18), seg=3)
    y_bay = 13.6
    door = _o(bay, (-1.1, BZ1), (1.1, BZ1), depth=0.5, pane_w=1.1, transom=0.8, rng=rng, cells=[9, 9], sill=False)
    gb = _o(bay, (-0.55, BZ1), (0.55, BZ1), depth=0.16, mullion=None, sill=False, cells=[D.GLASS_BLOCK_CELL], vpanes=9)
    D.window_band(mb, bay, 0.5, 3.15, [door], rng=rng)
    D.solid_band(mb, bay, 0.0, 0.5)
    D.solid_band(mb, bay, 3.15, 4.35)
    D.window_band(mb, bay, 4.35, 12.85, [gb], rng=rng)
    D.solid_band(mb, bay, 12.85, y_bay)
    D.parapet(mb, bay, y_bay - 0.5, y_bay, th=0.22)
    # fins flanking the glass block, rising into the crown
    for x in (-0.82, 0.82):
        D.fin(mb, x, BZ1, 4.0, 16.0, 0.42, 0.2, n=(0, 1))
        D.neon_tube(mb, [(x, 4.25, BZ1 + 0.445), (x, 15.55, BZ1 + 0.445)], r=0.022)
    for x in (-2.2, 2.2):
        D.fin(mb, x, BZ1, 3.9, 13.3, 0.22, 0.24, n=(0, 1))
    # portholes on the bay at the upper floors
    for x in (-1.55, 1.55):
        for y in (5.65, 8.85):
            D.porthole(mb, (x, y, BZ1), (0, 1), 0.33, cell=D.room_cell(rng))
    # stepped crown
    tiers = [(1.75, y_bay - 0.5, 14.5), (1.2, 14.5, 15.5), (0.62, 15.5, 16.4)]
    for (hw, ya, yb) in tiers:
        p = rrect(-hw, hw, BZ0 + 0.15, BZ1 - 0.15, (0.08, 0.08, 0.08, 0.08), seg=2)
        D.solid_band(mb, p, ya, yb - 0.08)
        D.cornice_cap(mb, p, yb - 0.08, over=0.05, h=0.08)
        D.roof_fill(mb, p, yb, mat="trim")
    # finial and neon crown ring
    mb.lathe([(0, 16.4), (0.16, 16.4), (0.16, 16.65), (0.07, 16.75), (0.035, 18.4), (0, 18.6)], 0, -1.4, "metal", seg=12)
    mb.lathe([(0.0, 17.0), (0.13, 17.07), (0.15, 17.2), (0.13, 17.33), (0.0, 17.4)], 0, -1.4, "metal", seg=12)
    for (hw, ya, yb) in tiers:
        zf = BZ1 - 0.15 + 0.08
        D.neon_tube(mb, [(-hw - 0.02, yb - 0.11, zf), (hw + 0.02, yb - 0.11, zf)], r=0.02)

    # entrance marquee canopy with neon underline and the blank sign on top
    can = rrect(-1.65, 1.65, BZ1 - 0.1, BZ1 + 1.55, (0, 0, 0.55, 0.55), seg=5)
    mb.slab(can, 3.3, 3.52, "trim", bevel=0.05, segs=2)
    D.neon_on_path(mb, can, can.s_of((1.65, BZ1 + 0.2)), can.s_of((-1.65, BZ1 + 0.2)), 3.41, off=0.03, r=0.02)
    face = F.sign_board(mb, -1.25, 1.25, 3.62, 4.18, BZ1 + 0.95, depth=0.1)
    for x in (-1.0, 1.0):
        mb.box(x - 0.025, x + 0.025, 3.52, 3.62, BZ1 + 0.8, BZ1 + 0.86, "metal")
    b.extra.append(("sign_face", _sign_face(*face)))

    # ---- stoop: entrance steps flanked by seating ledges ------------------
    ledge_y = T + SEAT_H
    zf = 0.12
    mb.box(-BX, BX, 0.0, ledge_y - 0.05, BZ1 - 0.05, zf - 0.04, "terrazzo")
    mb.box(-BX - 0.02, BX + 0.02, ledge_y - 0.05, ledge_y, BZ1 - 0.05, zf + 0.02, "terrazzo", bevel=0.02, segs=2)
    rise = (ledge_y - T) / 3
    for k, (za, zb) in enumerate(((zf, zf + 0.3), (zf + 0.3, zf + 0.6))):
        y = ledge_y - rise * (k + 1)
        mb.box(-1.05, 1.05, 0.0, y, za - 0.02, zb, "terrazzo", bevel=0.015, segs=1, edges="top")
    # cheek walls ending the steps
    for x in (-1.15, 1.15):
        mb.box(x - 0.1, x + 0.1, 0.0, ledge_y + 0.32, BZ1, zf + 0.62, "stucco", bevel=0.04, segs=2, edges="topvert")
    # steps spot: sitting on the ledge edge, feet on the terrace
    b.spots.append({"kind": "steps", "pos": (1.85, T, zf - 0.2), "yaw": 0.0, "seat_h": SEAT_H, "table_h": None})

    # ---- terrace ----------------------------------------------------------
    terr = rrect(-9.7, 9.7, -1.5, 7.0, (0, 0, 1.2, 1.2), seg=6)
    mb.slab(terr, 0.0, T, "terrazzo", bevel=0.012, segs=1, bottom=False)
    D.floor_fan(mb, 0.0, zf + 0.62, 1.15, 3.6, T + 0.006, rays=13)
    # low wall with planters at the front corners and an entrance gap
    wall_h = 0.62
    wall_sec = [(-0.24, 0.0), (0.0, 0.0), (0.0, wall_h - 0.07)]
    lw = rrect(-9.55, 9.55, -1.4, 6.85, (0, 0, 1.05, 1.05), seg=6)
    coping = [(0.0, wall_h - 0.07), (0.03, wall_h - 0.07), (0.03, wall_h - 0.015), (0.015, wall_h), (-0.255, wall_h),
              (-0.27, wall_h - 0.015), (-0.27, wall_h - 0.07), (-0.24, wall_h - 0.07)]
    for (pa, pb) in (((-9.55, 0.4), (-1.9, 6.85)), ((1.9, 6.85), (9.55, 0.4))):
        sa, sb = lw.s_of(pa), lw.s_of(pb)
        sa, sb = min(sa, sb), max(sa, sb)
        samples = lw.sample(sa, sb)
        mb.sweep(samples, [(-0.24, wall_h - 0.07), (-0.24, 0.0)], "stucco", cap=(False, False))
        mb.sweep(samples, [(0.0, 0.0), (0.0, wall_h - 0.07)], "stucco")
        mb.sweep(samples, coping, "trim", cap=(True, True))
        # end caps of the wall body
        for s, sg in ((sa, -1), (sb, 1)):
            x, z, nx, nz, tx, tz = lw.point(s)
            q = [(x, 0, z), (x, wall_h - 0.07, z), (x - nx * 0.24, wall_h - 0.07, z - nz * 0.24), (x - nx * 0.24, 0, z - nz * 0.24)]
            mb.poly_n(q, "stucco", (tx * sg, 0, tz * sg))
    # entrance pylons
    for sgn in (-1, 1):
        x = sgn * 2.15
        p = rrect(x - 0.28, x + 0.28, 6.45, 7.0, (0.12, 0.12, 0.12, 0.12), seg=3)
        D.solid_band(mb, p, 0.0, 1.55)
        D.cornice_cap(mb, p, 1.55, over=0.04, h=0.09)
        D.roof_fill(mb, p, 1.64, mat="trim")
        D.speed_lines(mb, p, None, None, 1.12, n=3, gap=0.11, h=0.04, out=0.03)
        mb.lathe([(0, 1.64), (0.13, 1.64), (0.15, 1.7), (0.15, 1.78), (0.1, 1.86), (0, 1.88)], x, 6.72, "metal", seg=12)
        mb.lathe([(0, 1.86), (0.12, 1.9), (0.15, 2.02), (0.12, 2.14), (0, 2.18)], x, 6.72, "neon_accent", seg=12)
    # planters at the inside front corners and along the facade
    soils = []
    for sgn in (-1, 1):
        soils.append(F.round_planter(mb, sgn * 8.45, 5.75, r=0.6, h=0.66))
    soils.append(F.round_planter(mb, -2.95, 0.15, r=0.36, h=0.62))
    soils.append(F.round_planter(mb, 2.95, 0.15, r=0.36, h=0.62))
    soils.append(F.planter(mb, -8.3, -6.9, -1.25, -0.75, h=0.5))
    plants = ["anthurium_botany_01", "calathea_orbifolia_01"]
    for k, sp in enumerate(soils):
        b.prop(plants[k % 2], sp, 0.0)

    # ---- furniture: desks on the left, bar on the right ---------------------
    with mb.at(-6.2, T, 1.25, 0):
        b.add(F.desk_set(mb))
    with mb.at(-4.35, T, 3.05, 18):
        b.add(F.desk_set(mb))
    # bar counter against the right wing (service hatch in the facade)
    bx0, bx1 = 4.55, 5.2
    ctop = T + STOOL_RAISE + DESK_H
    cz0, cz1 = -1.35, 2.3
    body = rrect(bx0, bx1 - 0.22, cz0, cz1, (0, 0, 0.3, 0.3), seg=5)
    D.solid_band(mb, body, 0.0, ctop - 0.06, mat="stucco")
    D.speed_lines(mb, body, body.s_of((bx1 - 0.22, 0.0)), body.s_of((bx0, cz1)), 0.42, n=3, gap=0.13, h=0.04, out=0.025)
    top = rrect(bx0 - 0.08, bx1, cz0, cz1 + 0.12, (0, 0, 0.42, 0.3), seg=5)
    mb.slab(top, ctop - 0.06, ctop, "terrazzo", bevel=0.02, segs=2)
    rail = [(bx1 - 0.12, T + 0.2, cz0 + 0.1), (bx1 - 0.12, T + 0.2, cz1 - 0.15)]
    mb.tube(rail, 0.018, "metal", seg=6)
    for z in (cz0 + 0.3, cz1 - 0.4):
        mb.tube([(bx1 - 0.22, T + 0.2, z), (bx1 - 0.12, T + 0.2, z)], 0.012, "metal", seg=5)
    for k, z in enumerate((-0.3, 0.75, 1.75)):
        with mb.at(bx1 + 0.3, T, z, -90):
            F.stool(mb)
            if k == 1:
                b.spots.append(F.spot(mb, "stool", (0, STOOL_RAISE, 0), 0.0, seat_h=SEAT_H, table_h=DESK_H,
                                      table_edge=F.DESK_EDGE))
    b.prop("classic_laptop", (bx1 - 0.15, ctop, 0.75), 90.0)
    # lounger under a striped umbrella, front right
    with mb.at(7.75, T, 3.55, 0):
        b.add(F.lounger(mb))
    with mb.at(6.55, T, 4.65, 0):
        F.umbrella(mb, r=1.35, h=2.45)
    # bench against the left side wall, facing into the terrace
    with mb.at(-8.85, T, 4.4, 90):
        b.add(F.bench_back(mb, 1.8))
    # props
    b.prop("outdoor_table_chair_set_01", (-5.6, T, 5.1), 90.0)
    b.prop("mid_century_lounge_chair", (7.05, T, 0.95), -110.0)
    b.prop("painted_wooden_bench", (-4.6, T, -1.15), 0.0)
    b.prop("street_lamp_02", (-9.7, 0.0, 7.7), 0.0)
    b.prop("street_lamp_02", (9.7, 0.0, 7.7), 0.0)
    # roof: stair bulkhead and aircon pads
    bh = rrect(-5.6, -3.0, -7.35, -5.0, (0, 0, 0.3, 0.3), seg=3)
    D.solid_band(mb, bh, y_roof, y_roof + 2.3)
    D.cornice_cap(mb, bh, y_roof + 2.3, over=0.06, h=0.12)
    D.roof_fill(mb, bh, y_roof + 2.42)
    door_c = (-4.3, y_roof + 1.05, -5.0)
    mb.box(-4.75, -3.85, y_roof, y_roof + 2.05, -5.03, -4.98, "metal")
    for x in (3.4, 5.6):
        mb.box(x - 0.75, x + 0.75, y_roof, y_roof + 0.12, -7.2, -6.2, "concrete", bevel=0.02, segs=1)
        b.prop("exterior_aircon_unit", (x, y_roof + 0.12, -6.65), 0.0)
    b.prop("exterior_aircon_unit", (X1, 3.95, -7.35), 90.0)
    # roof skylight and vents
    mb.box(1.4, 3.4, y_roof, y_roof + 0.35, -6.6, -4.4, "trim", bevel=0.04, segs=2)
    mb.box(1.55, 3.25, y_roof + 0.35, y_roof + 0.42, -6.45, -4.55, "glass_block")
    for (vx, vz) in ((-7.2, -6.8), (-6.4, -6.8), (6.9, -3.6)):
        mb.cylinder(vx, vz, 0.14, y_roof, y_roof + 0.55, "metal", seg=10, bevel=0.02)
        mb.cylinder(vx, vz, 0.22, y_roof + 0.55, y_roof + 0.62, "metal", seg=10, bevel=0.02)
    b.anchors = {"tag_anchor": (0.0, 19.4, -1.4), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Hero plot: 3-storey Deco hotel turned studio, centre bay with glass-block spine, fins and a stepped "
               "crown; terrace with two desks, bar with stools, lounger, bench and a seating stoop.")
    return b


def _sign_face(x0, x1, y0, y1, z):
    m = MB()
    m.poly([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], "trim", [(0, 0), (1, 0), (1, 1), (0, 1)])
    return m


# ===========================================================================
# Beach cafe: single-storey streamline pavilion with a deep striped awning
# ===========================================================================
def plot_beach_cafe():
    b = Building("plot_beach_cafe", "plot")
    b.look = dict(stucco="mint", trim="warm_white", neon="amber", awning="coral")
    mb = b.mb
    rng = np.random.default_rng(202)
    T = 0.06
    X0, X1, Z0, Z1 = -7.6, 5.4, -7.6, -2.4
    pav = rrect(X0, X1, Z0, Z1, (0.4, 0.4, 2.4, 0.5), seg=10)
    y_top = 4.3
    wa, wb = 1.15, 2.95

    def fr(x):
        return (x, Z1)

    ops = [
        _o(pav, fr(-5.15), fr(-0.55), depth=0.3, pane_w=1.15, transom=None, rng=rng, sill=False,
           cells=[D.LIGHT_PANEL_CELL, 3, D.LIGHT_PANEL_CELL, 7]),
    ]
    a = pav.s_of(fr(2.4))
    c = pav.s_of((X1, -4.9))
    ops.append(D.Opening(min(a, c), max(a, c), depth=0.2, pane_w=0.95, transom=0.7, rng=rng))
    ops.append(_o(pav, (X1, -5.6), (X1, -7.0), depth=0.2, pane_w=0.7, transom=0.7, rng=rng))
    ops.append(_o(pav, (X0, -3.4), (X0, -4.8), depth=0.2, pane_w=0.7, transom=0.7, rng=rng))
    mb.ring_sweep(pav, [(0.0, 0.0), (0.04, 0.0), (0.04, 0.42), (0.02, 0.46), (0.0, 0.46)], "terrazzo")
    D.solid_band(mb, pav, 0.46, wa)
    D.window_band(mb, pav, wa, wb, ops, rng=rng)
    D.solid_band(mb, pav, wb, y_top)
    # speed lines wrapping the big curve
    a, c = pav.s_of(fr(0.2)), pav.s_of((X1, -6.4))
    D.speed_lines(mb, pav, min(a, c), max(a, c), 3.25, n=3, gap=0.15, h=0.05)
    # floating roof slab with a set-back parapet
    roof = pav.offset(0.45)
    mb.slab(roof, y_top, y_top + 0.24, "trim", bevel=0.06, segs=2, top=False)
    mb.ring_sweep(roof, [(-0.0, y_top + 0.24), (-0.16, y_top + 0.24)], "trim")
    upst = pav.offset(0.29)
    D.solid_band(mb, upst, y_top + 0.24, y_top + 0.78)
    D.parapet(mb, upst, y_top + 0.24, y_top + 0.78, th=0.2)
    D.neon_on_path(mb, roof, roof.s_of((-2.0, Z1 + 0.45)), roof.s_of((X1 + 0.45, -5.5)), y_top + 0.12, off=0.07, r=0.024)
    # rooftop sign pylon: a blade with a blank board and neon outline
    px = -5.6
    blade = rrect(px - 0.18, px + 0.18, -3.9, -2.55, (0.12, 0.12, 0.12, 0.12), seg=3)
    D.solid_band(mb, blade, y_top + 0.24, 8.2)
    D.cornice_cap(mb, blade, 8.2, over=0.05, h=0.1)
    D.roof_fill(mb, blade, 8.3, mat="trim")
    for k in range(4):
        y = 5.0 + k * 0.75
        mb.box(px - 0.24, px + 0.24, y, y + 0.08, -3.95, -2.5, "trim", bevel=0.02, segs=1)
    face = F.sign_board(mb, px - 1.25, px + 1.25, 5.55, 6.75, -2.4, depth=0.14)
    b.extra.append(("sign_face", _sign_face(*face)))
    # door to the right of the hatch
    D.applied_door(mb, 0.15, 1.55, T, 2.7, Z1, panes=2)
    # deep striped awning across the front, on chrome posts
    D.striped_awning(mb, -7.35, 1.95, Z1, 3.7, 3.3, 1.05, valance=0.26, posts=(-7.2, -4.1, -1.0, 1.8))
    # serving counter under the hatch with stools
    ctop = T + STOOL_RAISE + DESK_H
    cz1 = Z1 + 0.5
    base = rrect(-5.25, -0.45, Z1 - 0.05, cz1 - 0.12, (0, 0, 0.1, 0.1), seg=2)
    D.solid_band(mb, base, 0.0, ctop - 0.05, mat="stucco")
    D.speed_lines(mb, base, base.s_of((-0.45, cz1 - 0.12)), base.s_of((-5.25, cz1 - 0.12)), 0.35, n=3, gap=0.12,
                  h=0.04, out=0.025)
    top = rrect(-5.35, -0.35, Z1 - 0.1, cz1, (0, 0, 0.08, 0.08), seg=2)
    mb.slab(top, ctop - 0.05, ctop, "wood", bevel=0.015, segs=2)
    mb.tube([(-5.15, T + 0.2, cz1 + 0.02), (-0.55, T + 0.2, cz1 + 0.02)], 0.018, "metal", seg=6)
    for k, x in enumerate((-4.3, -2.85, -1.4)):
        with mb.at(x, T, cz1 + F.DESK_EDGE, 180):
            F.stool(mb, cushion=F.SWATCH_COLOUR)
            if k == 1:
                b.spots.append(F.spot(mb, "stool", (0, STOOL_RAISE, 0), 0.0, seat_h=SEAT_H, table_h=DESK_H,
                                      table_edge=F.DESK_EDGE))
    b.prop("classic_laptop", (-2.85, ctop, cz1 - 0.22), 0.0)
    # deck over the plot front
    deck = rrect(-9.7, 9.7, -2.5, 7.1, (0, 0, 0.8, 0.8), seg=5)
    mb.slab(deck, 0.0, T, "wood", bevel=0.015, segs=1, bottom=False)
    # tables with umbrellas (desk spots), lounger, bench, standing table
    with mb.at(-6.0, T, 1.55, 25):
        b.add(F.cafe_table_set(mb, umbrella_h=2.45))
    with mb.at(-2.3, T, 3.0, -15):
        b.add(F.cafe_table_set(mb, umbrella_h=2.45))
    with mb.at(-7.0, T, Z1 + 0.32, 0):
        b.add(F.bench_back(mb, 1.5))
    with mb.at(7.2, T, 2.4, -20):
        b.add(F.lounger(mb, cushion="stripes"))
    with mb.at(8.7, T, 3.0, -20):
        F.lounger(mb, cushion="stripes")
    with mb.at(7.6, T, 4.6, 0):
        F.umbrella(mb, r=1.4, h=2.5)
    with mb.at(1.4, T, 4.4, 0):
        b.add(F.poseur_table(mb))
    # surfboards leaning on the right wall of the pavilion
    for k, (z, pin) in enumerate(((-6.9, F.SWATCH_COLOUR), (-6.25, F.SWATCH_WHITE), (-5.6, F.SWATCH_COLOUR))):
        with mb.at(X1 + 0.32, 1.12, z, 90, pitch=-78):
            F.surfboard(mb, pin=pin)
    # planters along the front edge of the deck
    soils = [F.round_planter(mb, -9.0, 6.4, r=0.42, h=0.55), F.round_planter(mb, 9.0, 6.4, r=0.42, h=0.55),
             F.planter(mb, 3.0, 4.4, 6.35, 6.85, h=0.5), F.planter(mb, -4.4, -3.0, 6.35, 6.85, h=0.5)]
    for k, sp in enumerate(soils):
        b.prop(["calathea_orbifolia_01", "anthurium_botany_01"][k % 2], sp, 0.0)
    b.prop("CoffeeCart_01", (4.0, T, 0.2), -30.0)
    b.prop("outdoor_table_chair_set_01", (1.6, T, 1.1), 90.0)
    b.prop("outdoor_table_chair_set_01", (-6.2, T, 5.3), 70.0)
    b.prop("mid_century_lounge_chair", (4.6, T, 5.4), 200.0)
    b.prop("street_lamp_02", (-9.7, 0.0, 7.7), 0.0)
    b.prop("street_lamp_02", (9.7, 0.0, 7.7), 0.0)
    b.prop("exterior_aircon_unit", (-1.0, y_top + 0.24, -6.6), 0.0)
    b.anchors = {"tag_anchor": (-1.0, 9.6, -4.6), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("Single-storey streamline beach cafe: rounded pavilion with a wrap-around ribbon window, floating "
               "roof slab, rooftop sign blade, deep coral striped awning over a serving counter, timber deck.")
    return b


# ===========================================================================
# Diner: MiMo, upswept boomerang roof, chrome, booths behind glass
# ===========================================================================
def plot_diner():
    b = Building("plot_diner", "plot")
    b.look = dict(stucco="aqua", trim="warm_white", neon="red", awning="cherry")
    mb = b.mb
    rng = np.random.default_rng(303)
    T = TERRACE_Y
    X0, X1, Z0, Z1 = -8.2, 6.0, -7.6, -2.2
    dn = rrect(X0, X1, Z0, Z1, (0, 0.6, 1.6, 0), seg=8)
    ga, gb = 0.78, 3.25

    def roof_y(x, z=None):
        # roof underside rises toward the left (the prow)
        t = (X1 + 1.4 - x) / (X1 - X0 + 2.6)
        return 3.95 + 2.1 * max(0.0, min(1.05, t)) ** 1.3

    def fr(x):
        return (x, Z1)
    glass = _o(dn, fr(-5.9), fr(4.2), depth=0.09, back="glass", pane_w=1.25, transom=None, sill=False)
    a, c = dn.s_of(fr(4.6)), dn.s_of((X1, -4.2))
    walkup = D.Opening(min(a, c), max(a, c), depth=0.3, pane_w=0.9, rng=rng, cells=[D.LIGHT_PANEL_CELL], sill=False)
    side = _o(dn, (X0, -3.6), (X0, -6.2), depth=0.2, pane_w=0.85, transom=0.7, rng=rng)
    back = [_o(dn, (x - 0.7, Z0), (x + 0.7, Z0), depth=0.2, pane_w=0.7, rng=rng) for x in (-5.0, -1.0, 3.0)]
    D.solid_band(mb, dn, 0.0, ga)
    D.window_band(mb, dn, ga, gb, [glass, walkup, side] + back, rng=rng)
    D.solid_band(mb, dn, gb, 3.95)
    D.slope_band(mb, dn, 0.0, dn.L, 3.95, roof_y)
    # chrome speed lines across the enamel base and the band above the glass
    for y in (0.22, 0.38, 0.54):
        D.band_ledge(mb, dn, None, None, y, out=0.035, h=0.05, mat="metal")
    D.band_ledge(mb, dn, None, None, gb + 0.12, out=0.05, h=0.07, mat="metal")
    # interior behind the glass: floor, ceiling, back wall, ends, booths, counter
    iz0, iz1 = -5.2, Z1 - 0.1
    ix0, ix1 = -6.1, 4.4
    yc = 3.35
    mb.poly_n([(ix0, 0.06, iz0), (ix1, 0.06, iz0), (ix1, 0.06, iz1), (ix0, 0.06, iz1)], "terrazzo", (0, 1, 0))
    mb.poly_n([(ix0, yc, iz0), (ix1, yc, iz0), (ix1, yc, iz1), (ix0, yc, iz1)], "trim", (0, -1, 0))
    mb.poly_n([(ix0, 0.0, iz0), (ix1, 0.0, iz0), (ix1, yc, iz0), (ix0, yc, iz0)], "stucco", (0, 0, 1))
    mb.poly_n([(ix0, 0.0, iz0), (ix0, 0.0, iz1), (ix0, yc, iz1), (ix0, yc, iz0)], "stucco", (1, 0, 0))
    mb.poly_n([(ix1, 0.0, iz0), (ix1, 0.0, iz1), (ix1, yc, iz1), (ix1, yc, iz0)], "stucco", (-1, 0, 0))
    pu = D.panel_uv()
    for x in (-4.8, -2.4, 0.0, 2.4):
        mb.poly_n([(x - 0.9, yc - 0.01, -3.6), (x + 0.9, yc - 0.01, -3.6), (x + 0.9, yc - 0.01, -3.1),
                   (x - 0.9, yc - 0.01, -3.1)], "interior", (0, -1, 0), [pu] * 4)
    # back bar: counter, stools, shelf with a light strip
    mb.box(ix0 + 0.2, ix1 - 0.2, 0.0, 1.05, iz0 + 0.05, iz0 + 0.65, "stucco", bevel=0.03, segs=1)
    mb.box(ix0 + 0.15, ix1 - 0.15, 1.05, 1.1, iz0 + 0.02, iz0 + 0.75, "metal", bevel=0.015, segs=1)
    mb.poly_n([(ix0 + 0.3, 1.45, iz0 + 0.01), (ix1 - 0.3, 1.45, iz0 + 0.01), (ix1 - 0.3, 3.1, iz0 + 0.01),
               (ix0 + 0.3, 3.1, iz0 + 0.01)], "interior", (0, 0, 1), [pu] * 4)
    for x in np.linspace(ix0 + 0.8, ix1 - 0.8, 7):
        with mb.at(float(x), 0.06, iz0 + 1.0, 180):
            F.stool(mb, cushion=F.SWATCH_COLOUR)
    # booths along the window, cherry vinyl, white tables
    for x in (-4.9, -2.9, -0.9, 1.1, 3.1):
        for sz, flip in ((-0.55, 1), (0.55, -1)):
            zc = Z1 - 0.65 + sz * 0.0
            zb = Z1 - 0.62 + sz
            seat = [(zb - 0.25 * flip, 0.06), (zb + 0.25 * flip, 0.06), (zb + 0.25 * flip, 0.47),
                    (zb - 0.16 * flip, 0.47), (zb - 0.18 * flip, 0.9), (zb - 0.24 * flip, 0.97),
                    (zb - 0.3 * flip, 0.92)]
            F.extrude_x(mb, seat, x - 0.55, x + 0.55, "awning", pin=F.SWATCH_COLOUR)
        mb.box(x - 0.45, x + 0.45, 0.72, 0.76, Z1 - 0.98, Z1 - 0.3, "trim", bevel=0.015, segs=1)
        mb.cylinder(x, Z1 - 0.64, 0.04, 0.06, 0.72, "metal", seg=8, caps=False)
    # upswept roof slab (the boomerang prow) with a chrome fascia and neon
    from .geo import arc_pts
    rr = 1.6
    opts = [(X0 - 0.4, Z0 - 0.4)]
    opts += arc_pts(X1 + 0.5 - rr, Z0 - 0.4 + rr, rr, -90, 0, 6)
    opts += arc_pts(X1 + 0.5 - rr, Z1 + 0.9 - rr, rr, 0, 90, 6)
    opts += [(X0 + 1.0, Z1 + 1.6), (X0 - 1.5, Z1 + 2.7), (X0 - 0.55, Z1 - 0.3)]
    outline = Path(opts, True)
    th = 0.26
    pts = outline.pts
    bot = [(x, roof_y(x), z) for (x, z) in pts]
    top = [(x, roof_y(x) + th, z) for (x, z) in pts]
    mb.poly_n(bot, "trim", (0, -1, 0))
    mb.poly_n(top, "stucco", (0, 1, 0))
    m = len(pts)
    for i in range(m):
        j = (i + 1) % m
        nx, nz = outline.seg_n[i]
        mb.poly_n([bot[i], bot[j], top[j], top[i]], "metal", (nx, 0, nz))
    fs = [(x + nx * 0.03, roof_y(x) - 0.03, z + nz * 0.03) for (x, z, nx, nz, s) in
          outline.sample(outline.s_of((X1 + 0.5, -3.2)), outline.s_of((X0 - 1.45, Z1 + 2.65)))]
    mb.tube(fs, 0.022, "neon_accent", seg=6)
    # prow support: a raked steel column under the cantilevered tip
    mb.tube([(X0 + 0.2, 0.0, Z1 + 1.2), (X0 - 0.9, roof_y(X0 - 0.9) - 0.01, Z1 + 2.15)], 0.075, "metal", seg=10)
    # entrance door at the left end, under the prow
    D.applied_door(mb, -7.75, -6.45, 0.06, 2.6, Z1, panes=2)
    mb.box(-8.1, -6.1, 0.0, 0.06, Z1, Z1 + 1.0, "terrazzo", bevel=0.01, segs=1)
    # walk-up counter outside the window at the right end, stools
    ctop = T + STOOL_RAISE + DESK_H
    a, c = dn.s_of(fr(4.5)), dn.s_of((X1, -4.3))
    sec = [(0.0, ctop - 0.06), (0.42, ctop - 0.06), (0.45, ctop - 0.03), (0.42, ctop), (0.0, ctop)]
    mb.sweep(dn.sample(min(a, c), max(a, c)), sec, "metal", cap=(True, True))
    stool_pts = []
    for k, f in enumerate((0.2, 0.5, 0.8)):
        s = min(a, c) + (max(a, c) - min(a, c)) * f
        x, z, nx, nz, tx, tz = dn.point(s)
        yaw = math.degrees(math.atan2(-nx, -nz))
        rx, rz = x + nx * (0.42 + F.DESK_EDGE), z + nz * (0.42 + F.DESK_EDGE)
        with mb.at(rx, T, rz, yaw):
            F.stool(mb, cushion=F.SWATCH_COLOUR)
            if k < 2:
                b.spots.append(F.spot(mb, "stool", (0, STOOL_RAISE, 0), 0.0, seat_h=SEAT_H, table_h=DESK_H,
                                      table_edge=F.DESK_EDGE))
                b.props.append(F.prop(mb, "classic_laptop", (0, ctop - T, F.DESK_EDGE + 0.2), 180.0))
    # patio: paving slab, tables with umbrellas, bench, standing table
    pat = rrect(-9.7, 9.7, -2.3, 7.0, (0, 0, 0.6, 0.6), seg=4)
    mb.slab(pat, 0.0, T, "terrazzo", bevel=0.012, segs=1, bottom=False)
    D.floor_fan(mb, -7.1, Z1 + 0.05, 0.6, 1.6, T + 0.006, rays=9, ray_mat="stucco")
    with mb.at(-3.6, T, 1.4, 20):
        b.add(F.cafe_table_set(mb, umbrella_h=2.4, top="trim"))
    with mb.at(0.4, T, 2.6, -25):
        b.add(F.cafe_table_set(mb, umbrella_h=2.4, top="trim"))
    with mb.at(4.4, T, 5.9, 180):
        b.add(F.bench_back(mb, 1.8))
    with mb.at(-1.0, T, 5.3, 0):
        b.add(F.poseur_table(mb, top="trim"))
    # MiMo sign pylon with a starburst, front left
    sx, sz = -8.4, 4.6
    pyl = rrect(sx - 0.3, sx + 0.3, sz - 0.22, sz + 0.22, (0.1, 0.1, 0.1, 0.1), seg=3)
    D.solid_band(mb, pyl, 0.0, 6.6)
    D.cornice_cap(mb, pyl, 6.6, over=0.04, h=0.1)
    D.roof_fill(mb, pyl, 6.7, mat="trim")
    for k in range(5):
        y = 0.6 + k * 0.35
        mb.box(sx - 0.34, sx + 0.34, y, y + 0.06, sz - 0.26, sz + 0.26, "metal", bevel=0.01, segs=1)
    face = F.sign_board(mb, sx + 0.3, sx + 3.0, 4.1, 5.5, sz + 0.12, depth=0.24)
    b.extra.append(("sign_face", _sign_face(*face)))
    star_c = (sx, 7.35, sz)
    mb.lathe([(0, 6.7), (0.04, 6.7), (0.04, 7.2), (0, 7.2)], sx, sz, "metal", seg=8)
    for k in range(12):
        ang = 2 * math.pi * k / 12
        ln = 0.55 if k % 2 == 0 else 0.35
        tip = (star_c[0] + math.cos(ang) * ln, star_c[1] + math.sin(ang) * ln, star_c[2])
        mb.tube([star_c, tip], 0.018, "metal", seg=5)
        mb.lathe([(0, -0.035), (0.035, 0), (0, 0.035)], tip[0], tip[2], "neon_accent", seg=6, y0=tip[1])
    mb.lathe([(0, -0.12), (0.09, -0.08), (0.12, 0), (0.09, 0.08), (0, 0.12)], star_c[0], star_c[2], "metal", seg=12,
             y0=star_c[1])
    # planters and props
    soils = [F.planter(mb, 6.6, 9.4, 6.4, 6.9, h=0.5), F.round_planter(mb, -9.1, 6.5, r=0.4, h=0.55),
             F.round_planter(mb, 7.4, -1.4, r=0.38, h=0.55)]
    for k, sp in enumerate(soils):
        b.prop(["anthurium_botany_01", "calathea_orbifolia_01"][k % 2], sp, 0.0)
    b.prop("outdoor_table_chair_set_01", (4.6, T, 2.0), 90.0)
    b.prop("outdoor_table_chair_set_01", (7.6, T, 3.6), 60.0)
    b.prop("street_lamp_02", (-9.7, 0.0, 7.7), 0.0)
    b.prop("street_lamp_02", (9.7, 0.0, 7.7), 0.0)
    b.prop("exterior_aircon_unit", (-2.0, roof_y(-2.0) + th, -6.4), 0.0)
    b.prop("exterior_aircon_unit", (2.5, roof_y(2.5) + th, -6.4), 0.0)
    b.anchors = {"tag_anchor": (-1.0, 8.6, -4.4), "beam_anchor": (0.0, 0.0, 0.0)}
    b.notes = ("MiMo diner: long glazed front with cherry booths inside, chrome bands, an upswept roof that "
               "cantilevers into a prow over the entrance, walk-up counter, starburst sign pylon.")
    return b


# ===========================================================================
# Background street buildings (<= 6k tris): origin at the base centre
# ===========================================================================
def _upper_floors(mb, path, floors, rng, ops_fn, wall="stucco"):
    """Stack of storeys: floors = [(y0, y1, ya, yb)]; ops_fn(ya, yb) -> openings."""
    for (y0, y1, ya, yb) in floors:
        D.solid_band(mb, path, y0, ya, wall)
        D.window_band(mb, path, ya, yb, ops_fn(ya, yb), wall=wall, rng=rng)
        D.solid_band(mb, path, yb, y1, wall)


def bg_1():
    """Apricot corner block: streamline corner with wrap-around ribbons."""
    b = Building("bg_1", "bg")
    b.look = dict(stucco="peach", trim="warm_white", neon="aqua")
    mb, rng = b.mb, np.random.default_rng(401)
    X0, X1, Z0, Z1 = -7.0, 7.0, -5.0, 5.0
    p = rrect(X0, X1, Z0, Z1, (0, 0, 2.4, 0), seg=6)
    fl = [(0.0, 4.0, 0.9, 3.4), (4.0, 7.1, 4.6, 6.3), (7.1, 10.2, 7.7, 9.4)]

    def ops(ya, yb):
        o = []
        if ya < 1:
            o.append(_o(p, (-6.2, Z1), (-1.2, Z1), depth=0.25, pane_w=1.25, transom=0.8, rng=rng))
            o.append(_o(p, (-0.2, Z1), (3.8, Z1), depth=0.25, pane_w=1.3, transom=0.8, rng=rng))
            return o
        for x in (-5.6, -3.4):
            o.append(_o(p, (x - 0.6, Z1), (x + 0.6, Z1), depth=0.18, pane_w=0.6, transom=0.7, rng=rng))
        a, c = p.s_of((-0.6, Z1)), p.s_of((X1, 1.2))
        o.append(D.Opening(min(a, c), max(a, c), depth=0.18, pane_w=1.1, transom=0.7, rng=rng))
        o.append(_o(p, (X1, -1.0), (X1, -3.6), depth=0.18, pane_w=0.85, transom=0.7, rng=rng))
        for x in (-4.5, 0.0, 4.5):
            o.append(_o(p, (x - 0.7, Z0), (x + 0.7, Z0), depth=0.18, pane_w=0.7, rng=rng))
        return o
    _upper_floors(mb, p, fl, rng, ops)
    D.solid_band(mb, p, 10.2, 11.0)
    D.parapet(mb, p, 10.2, 11.0, th=0.25)
    for yb in (6.3, 9.4):
        a, c = p.s_of((-1.0, Z1)), p.s_of((X1, 0.8))
        D.eyebrow(mb, p, min(a, c), max(a, c), yb + 0.08, depth=0.48, thick=0.11, ext=0.0)
        for x in (-5.6, -3.4):
            a2, c2 = p.s_of((x - 0.75, Z1)), p.s_of((x + 0.75, Z1))
            D.eyebrow(mb, p, min(a2, c2), max(a2, c2), yb + 0.08, depth=0.36, thick=0.1, ext=0.0)
    a, c = p.s_of((-7.0, Z1)), p.s_of((X1, -1.0))
    D.eyebrow(mb, p, min(a, c), max(a, c), 3.62, depth=0.9, thick=0.14, ext=0.0)
    D.speed_lines(mb, p, min(a, c), max(a, c), 10.35, n=3, gap=0.16, h=0.05)
    # fin trio over the left bay, rising into a stepped parapet
    for x in (-5.9, -4.5, -3.1):
        D.fin(mb, x, Z1, 4.0, 11.9 if x == -4.5 else 11.5, 0.3, 0.16)
    step = rrect(-6.4, -2.6, Z1 - 1.2, Z1 - 0.05, (0, 0, 0, 0), seg=1)
    D.solid_band(mb, step, 10.2, 11.6)
    D.cornice_cap(mb, step, 11.6, over=0.04, h=0.08)
    D.roof_fill(mb, step, 11.68, mat="trim")
    b.anchors = {"tag_anchor": (0.0, 12.5, 0.0)}
    b.notes = "3-storey apricot corner block with a streamline corner, wrap-around ribbons and a fin trio."
    return b


def bg_2():
    """Powder-blue MiMo two-storey: cantilevered walkway, thin roof slab, sign blade."""
    b = Building("bg_2", "bg")
    b.look = dict(stucco="powder", trim="warm_white", neon="warm_white", awning="teal")
    mb, rng = b.mb, np.random.default_rng(402)
    X0, X1, Z0, Z1 = -9.0, 9.0, -4.0, 4.0
    p = rrect(X0, X1, Z0, Z1, (0, 0, 0, 0), seg=1)
    fl = [(0.0, 3.3, 0.95, 2.45), (3.3, 6.4, 4.25, 5.75)]

    def ops(ya, yb):
        o = []
        for k in range(6):
            x = -7.5 + k * 3.0
            o.append(_o(p, (x - 0.65, Z1), (x + 0.65, Z1), depth=0.15, pane_w=0.65, rng=rng, sill=False))
        for x in (-6.0, 0.0, 6.0):
            o.append(_o(p, (x - 1.0, Z0), (x + 1.0, Z0), depth=0.15, pane_w=1.0, rng=rng))
        return o
    _upper_floors(mb, p, fl, rng, ops)
    # doors between the windows on both levels
    for lvl, y0 in ((0, 0.0), (1, 3.3)):
        for k in range(6):
            x = -6.25 + k * 3.0
            D.applied_door(mb, x - 0.45, x + 0.45, y0, y0 + 2.2, Z1, panes=1, cell=D.room_cell(rng))
    # cantilevered walkway slab with pipe railing
    w = rrect(X0 - 0.2, X1 + 0.2, Z1 - 0.05, Z1 + 1.6, (0, 0, 0.2, 0.2), seg=2)
    mb.slab(w, 3.12, 3.3, "trim", bevel=0.03, segs=1)
    for y in (3.75, 4.2):
        mb.tube([(X0 - 0.1, y, Z1 + 1.52), (X1 + 0.1, y, Z1 + 1.52)], 0.025, "metal", seg=6)
    for k in range(13):
        x = X0 - 0.05 + k * (X1 - X0 + 0.1) / 12
        mb.cylinder(x, Z1 + 1.52, 0.022, 3.3, 4.2, "metal", seg=6, caps=False)
    # V columns under the walkway (MiMo)
    for k in range(4):
        x = -6.75 + k * 4.5
        mb.tube([(x - 0.5, 3.12, Z1 + 1.3), (x, 0.0, Z1 + 1.3)], 0.06, "metal", seg=8)
        mb.tube([(x + 0.5, 3.12, Z1 + 1.3), (x, 0.0, Z1 + 1.3)], 0.06, "metal", seg=8)
    # thin floating roof slab and a folded fascia
    r = rrect(X0 - 0.6, X1 + 0.6, Z0 - 0.4, Z1 + 1.9, (0, 0, 0, 0), seg=1)
    mb.slab(r, 6.4, 6.62, "trim", bevel=0.04, segs=1)
    D.roof_fill(mb, p, 6.4 + 0.0, mat="roof")
    mb.poly_n([(q[0], 6.63, q[1]) for q in r.pts], "roof", (0, 1, 0))
    # breeze-block screen at the left end, stair
    mb.box(X0 - 0.25, X0 + 0.05, 0.0, 6.4, -3.6, 3.6, "glass_block")
    # angled sign blade
    with mb.at(X1 + 0.9, 0.0, Z1 + 0.2, -20):
        mb.box(-0.12, 0.12, 0.0, 8.6, -0.9, 0.9, "stucco", bevel=0.05, segs=2)
        mb.box(-0.16, 0.16, 5.2, 7.8, -0.75, 0.75, "trim", bevel=0.03, segs=1)
        D.neon_tube(mb, [(0.18, 5.35, -0.6), (0.18, 7.65, -0.6), (0.18, 7.65, 0.6), (0.18, 5.35, 0.6)], r=0.02,
                    closed=True)
    b.anchors = {"tag_anchor": (0.0, 9.5, 0.0)}
    b.notes = "2-storey powder-blue MiMo motel/office: cantilevered walkway on V columns, floating roof, sign blade."
    return b


def bg_3():
    """Mint symmetric Deco: tall central glass-block bay, ziggurat crown."""
    b = Building("bg_3", "bg")
    b.look = dict(stucco="mint", trim="warm_white", neon="violet")
    mb, rng = b.mb, np.random.default_rng(403)
    X0, X1, Z0, Z1 = -6.5, 6.5, -5.0, 5.0
    p = rrect(X0, X1, Z0, Z1, (0, 0, 0.9, 0.9), seg=4)
    fl = [(0.0, 3.8, 0.9, 3.2), (3.8, 6.9, 4.4, 6.1), (6.9, 10.0, 7.5, 9.2), (10.0, 13.1, 10.6, 12.3)]

    def ops(ya, yb):
        o = []
        for sgn in (-1, 1):
            for x in (3.0, 4.8):
                o.append(_o(p, (sgn * (x - 0.6), Z1), (sgn * (x + 0.6), Z1), depth=0.18, pane_w=0.6, transom=0.7,
                            rng=rng))
            o.append(_o(p, (sgn * X1, 2.6), (sgn * X1, -2.6), depth=0.18, pane_w=1.3, transom=0.7, rng=rng))
        for x in (-4.0, -1.3, 1.3, 4.0):
            o.append(_o(p, (x - 0.6, Z0), (x + 0.6, Z0), depth=0.18, pane_w=0.6, rng=rng))
        return o
    _upper_floors(mb, p, fl, rng, ops)
    D.solid_band(mb, p, 13.1, 13.9)
    D.parapet(mb, p, 13.1, 13.9, th=0.25)
    for (y0, y1, ya, yb) in fl[1:]:
        for sgn in (-1, 1):
            a, c = p.s_of((sgn * 2.2, Z1)), p.s_of((sgn * 5.6, Z1))
            D.eyebrow(mb, p, min(a, c), max(a, c), yb + 0.08, depth=0.42, thick=0.1, ext=0.0)
    # centre bay
    bay = rrect(-1.9, 1.9, Z1 - 1.0, Z1 + 0.5, (0, 0, 0.15, 0.15), seg=2)
    gb = _o(bay, (-0.6, Z1 + 0.5), (0.6, Z1 + 0.5), depth=0.14, mullion=None, sill=False,
            cells=[D.GLASS_BLOCK_CELL], vpanes=10)
    door = _o(bay, (-0.8, Z1 + 0.5), (0.8, Z1 + 0.5), depth=0.4, pane_w=0.8, rng=rng, cells=[9], sill=False)
    D.window_band(mb, bay, 0.0, 2.9, [door], rng=rng)
    D.solid_band(mb, bay, 2.9, 3.9)
    D.window_band(mb, bay, 3.9, 13.4, [gb], rng=rng)
    D.solid_band(mb, bay, 13.4, 15.2)
    D.parapet(mb, bay, 14.6, 15.2, th=0.2)
    for x in (-1.05, 1.05):
        D.fin(mb, x, Z1 + 0.5, 3.6, 16.2, 0.32, 0.18)
    for (hw, ya, yb) in ((1.3, 14.6, 15.8), (0.8, 15.8, 16.7)):
        q = rrect(-hw, hw, Z1 - 0.9, Z1 + 0.35, (0, 0, 0, 0), seg=1)
        D.solid_band(mb, q, ya, yb - 0.07)
        D.cornice_cap(mb, q, yb - 0.07, over=0.04, h=0.07)
        D.roof_fill(mb, q, yb, mat="trim")
    mb.lathe([(0, 16.7), (0.1, 16.7), (0.04, 18.2), (0, 18.3)], 0, Z1 - 0.28, "metal", seg=8)
    for sgn in (-1, 1):
        for y in (5.2, 8.3, 11.4):
            D.porthole(mb, (sgn * X1, y, 3.6), (sgn, 0), 0.3, cell=D.room_cell(rng), seg=14)
    can = rrect(-1.5, 1.5, Z1 + 0.4, Z1 + 1.6, (0, 0, 0.4, 0.4), seg=3)
    mb.slab(can, 2.95, 3.12, "trim", bevel=0.04, segs=1)
    D.neon_on_path(mb, can, can.s_of((1.5, Z1 + 0.6)), can.s_of((-1.5, Z1 + 0.6)), 3.05, off=0.03, r=0.018)
    for x in (-1.05, 1.05):
        D.neon_tube(mb, [(x, 3.9, Z1 + 0.84), (x, 15.8, Z1 + 0.84)], r=0.02)
    b.anchors = {"tag_anchor": (0.0, 19.0, 0.0)}
    b.notes = "4-storey mint Deco with a glass-block spine between fins, ziggurat crown, finial and portholes."
    return b


def bg_4():
    """Butter-yellow streamline apartments: stacked round-ended balconies."""
    b = Building("bg_4", "bg")
    b.look = dict(stucco="butter", trim="warm_white", neon="amber")
    mb, rng = b.mb, np.random.default_rng(404)
    X0, X1, Z0, Z1 = -8.0, 8.0, -5.0, 5.0
    p = rrect(X0, X1, Z0, Z1, (0, 0, 0, 0), seg=1)
    fl = [(0.0, 3.6, 0.9, 3.0), (3.6, 6.7, 4.2, 6.0), (6.7, 9.8, 7.3, 9.1)]

    def ops(ya, yb):
        o = [_o(p, (-3.4, Z1), (6.6, Z1), depth=0.18, pane_w=1.25, transom=0.72, rng=rng)]
        for x in (-4.0, 0.0, 4.0):
            o.append(_o(p, (x - 0.8, Z0), (x + 0.8, Z0), depth=0.18, pane_w=0.8, rng=rng))
        o.append(_o(p, (X1, 3.0), (X1, -3.0), depth=0.18, pane_w=1.2, transom=0.72, rng=rng))
        return o
    _upper_floors(mb, p, fl, rng, ops)
    D.solid_band(mb, p, 9.8, 10.5)
    D.parapet(mb, p, 9.8, 10.5, th=0.25)
    # stacked balconies with half-round right ends and pipe railings
    for (y0, y1, ya, yb) in fl[1:]:
        bal = rrect(-3.6, 8.0 + 1.3, Z1 - 0.05, Z1 + 1.45, (0, 0, 0.75, 0), seg=6)
        mb.slab(bal, y0 - 0.2, y0, "trim", bevel=0.04, segs=1)
        a, c = bal.s_of((-3.6, Z1 + 1.45)), bal.s_of((X1 + 1.3, Z1 + 0.2))
        for y in (y0 + 0.5, y0 + 0.75, y0 + 1.0):
            pts = [(x + nx * -0.05, y, z + nz * -0.05) for (x, z, nx, nz, s) in bal.sample(min(a, c), max(a, c))]
            mb.tube(pts, 0.022, "metal", seg=6)
        D.solid_band(mb, rrect(-3.6, -3.4, Z1, Z1 + 1.45, (0, 0, 0, 0), seg=1), y0, y0 + 1.0)
    # rounded stair tower with portholes on the left
    st = rrect(-7.4, -4.2, Z1 - 0.8, Z1 + 1.0, (0, 0, 1.5, 1.5), seg=6)
    D.solid_band(mb, st, 0.0, 11.4)
    D.parapet(mb, st, 10.8, 11.4, th=0.2)
    for y in (2.0, 5.1, 8.2):
        D.porthole(mb, (-5.8, y, Z1 + 1.0), (0, 1), 0.38, cell=D.room_cell(rng), seg=16)
    a, c = st.s_of((-4.2, Z1)), st.s_of((-7.4, Z1))
    D.speed_lines(mb, st, min(a, c), max(a, c), 10.1, n=3, gap=0.16, h=0.05)
    a, c = p.s_of((-4.2, Z1)), p.s_of((X1, 3.5))
    D.eyebrow(mb, p, min(a, c), max(a, c), 3.25, depth=0.7, thick=0.12, ext=0.0)
    b.anchors = {"tag_anchor": (0.0, 12.2, 0.0)}
    b.notes = "3-storey butter-yellow streamline apartments: stacked round-ended balconies, stair drum with portholes."
    return b


# ===========================================================================
# Skyline towers (<= 3k tris): window pattern from the tower atlas
# ===========================================================================
def _tower_core(mb, path, y0, y1, fh, u_off=0.0):
    """Glazed core: one quad per path segment, UV rows = floors."""
    bay = 1.6
    pts = path.full() + [path.full()[0]]
    for i in range(len(pts) - 1):
        (xa, za, _, _, sa), (xb, zb, _, _, sb) = pts[i], pts[i + 1]
        if i == len(pts) - 2:
            sb = path.L
        nx, nz = path.point((sa + sb) / 2)[2:4]
        ua, ub = (sa + u_off) / (bay * 16), (sb + u_off) / (bay * 16)
        va, vb = y0 / (fh * 16), y1 / (fh * 16)
        mb.poly_n([(xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za)], "interior", (nx, 0, nz),
                  [(ua, va), (ub, va), (ub, vb), (ua, vb)])


def _floor_slabs(mb, path, y0, n, fh, out=0.25, h=0.22, mat="trim", every=1):
    for k in range(1, n + 1, every):
        y = y0 + k * fh - h / 2
        mb.ring_sweep(path, [(0, y), (out, y + 0.01), (out, y + h - 0.01), (0, y + h)], mat)


def _spandrels(mb, path, y_base, n, fh, h=1.0, out=0.15, mat="stucco", start=1):
    """Solid band at the foot of every floor (ribbon-window towers)."""
    for k in range(start, n):
        y = y_base + k * fh - 0.05
        mb.ring_sweep(path, [(0, y), (out, y + 0.02), (out, y + h), (0.0, y + h + 0.03)], mat)


def tower_1():
    """White condo slab: deep continuous balconies with solid parapets."""
    b = Building("tower_1", "tower")
    b.look = dict(stucco="tower_white", trim="warm_white", interior="tower", neon="aqua")
    mb = b.mb
    fh, n = 3.1, 21
    core = stadium(-15.0, 15.0, -6.5, 6.5, seg=3)
    H = n * fh
    mb.prism(core, 0.0, 4.6, "stucco", top=False)
    _tower_core(mb, core, 4.6, H, fh)
    bal = core.offset(0.05)
    for k in range(2, n + 1):
        y = (k - 1) * fh + 0.05
        mb.ring_sweep(bal, [(0, y), (1.15, y), (1.15, y + 1.1), (0.98, y + 1.12)], "trim")
    for sgn in (-1, 1):
        mb.box(sgn * 15.5 - 0.5, sgn * 15.5 + 0.5, 0.0, H + 1.8, -0.4, 0.4, "stucco")
    top = core.offset(0.2)
    mb.slab(top, H, H + 1.3, "stucco", bevel=0.0, segs=1, top=False)
    D.roof_fill(mb, top, H + 1.3, mat="roof")
    mb.box(-4.0, 4.0, H + 1.3, H + 4.2, -3.0, 3.0, "stucco")
    D.neon_tube(mb, [(x, H + 0.65, z) for (x, z, nx, nz, s) in top.offset(0.04).full()], r=0.07, closed=True)
    b.anchors = {"tag_anchor": (0.0, H + 6.0, 0.0)}
    b.notes = f"{n}-storey white condo slab with continuous balconies; window pattern via the tower atlas."
    return b


def tower_2():
    """Coral stepped tower: solid corner piers, coral spandrels, spire."""
    b = Building("tower_2", "tower")
    b.look = dict(stucco="coral", trim="warm_white", interior="tower", neon="red")
    mb = b.mb
    fh = 3.2
    tiers = [(0, 20, 9.0, 2.0), (20, 26, 7.0, 1.6), (26, 30, 4.8, 1.2)]
    for ti, (f0, f1, hw, ch) in enumerate(tiers):
        p = rrect(-hw, hw, -hw, hw, (ch, ch, ch, ch), seg=1)
        y0, y1 = f0 * fh, f1 * fh
        if ti == 0:
            mb.prism(p.offset(0.15), 0.0, 4.4, "stucco", top=False)
            _tower_core(mb, p, 4.4, y1, fh)
        else:
            _tower_core(mb, p, y0, y1, fh, u_off=f0 * 3.3)
        _spandrels(mb, p, y0, f1 - f0, fh, h=1.05, out=0.12, start=2 if ti == 0 else 1)
        mb.slab(p.offset(0.35), y1, y1 + 0.7, "trim", bevel=0.0, segs=1, top=False)
        D.roof_fill(mb, p.offset(0.35), y1 + 0.7, mat="roof")
        # corner piers (the chamfers) run full height of the tier, a shade proud
        pts = p.pts
        for i in range(0, len(pts), 2):
            (xa, za), (xb, zb) = pts[i - 1], pts[i]
            cx, cz = (xa + xb) / 2, (za + zb) / 2
            L = math.hypot(xb - xa, zb - za)
            tx, tz = (xb - xa) / L, (zb - za) / L
            nx, nz = tz, -tx
            mb.obox((cx + nx * 0.12, (y0 + y1) / 2 + 0.2, cz + nz * 0.12), (tx, tz), (nx, nz), L / 2 + 0.15,
                    (y1 - y0) / 2 + 0.2, 0.3, "stucco")
        # central fin on each face
        for (nx, nz) in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            D.fin(mb, nx * hw, nz * hw, y0 + (4.4 if ti == 0 else 0.3), y1 + 1.2, 0.55, 0.5, n=(nx, nz), mat="trim",
                  round_top=False, bevel=0.0)
    H = 30 * fh + 0.7
    mb.lathe([(0, H), (0.7, H), (0.3, H + 4.0), (0.09, H + 11.0), (0, H + 11.5)], 0, 0, "metal", seg=8)
    D.neon_tube(mb, [(x, 26 * fh + 0.35, z) for (x, z, nx, nz, s) in
                     rrect(-7.4, 7.4, -7.4, 7.4, (1.9,) * 4, 1).full()], r=0.08, closed=True)
    b.anchors = {"tag_anchor": (0.0, H + 13.0, 0.0)}
    b.notes = "30-storey coral stepped tower: solid chamfered corner piers, coral spandrels, white fins, spire."
    return b


def tower_3():
    """Powder-blue rounded tower: ribbon glass between white bands, crown ring."""
    b = Building("tower_3", "tower")
    b.look = dict(stucco="powder", trim="warm_white", interior="tower", neon="violet")
    mb = b.mb
    fh, n = 3.2, 17
    core = rrect(-10.0, 10.0, -8.0, 8.0, (5.0, 5.0, 5.0, 5.0), seg=3)
    H = n * fh
    mb.prism(core.offset(0.15), 0.0, 5.0, "stucco", top=False)
    _tower_core(mb, core, 5.0, H, fh)
    for k in range(2, n + 1):
        y = (k - 1) * fh
        thick = 1.25 if k % 4 == 0 else 0.85
        mat = "stucco" if k % 4 == 0 else "trim"
        mb.ring_sweep(core, [(0, y - 0.05), (0.4, y), (0.4, y + thick), (0.0, y + thick + 0.03)], mat)
    crown = core.offset(0.4)
    mb.ring_sweep(crown, [(0, H), (0, H + 3.2), (-0.3, H + 3.2), (-0.3, H + 0.5)], "trim")
    D.roof_fill(mb, core, H + 0.5, mat="roof")
    mb.box(-3.0, 3.0, H + 0.5, H + 3.6, -2.0, 2.0, "stucco")
    D.neon_tube(mb, [(x, H + 1.6, z) for (x, z, nx, nz, s) in crown.offset(0.05).full()], r=0.08, closed=True)
    b.anchors = {"tag_anchor": (0.0, H + 6.0, 0.0)}
    b.notes = "17-storey rounded tower: ribbon glass between white bands, powder-blue band every fourth floor, neon crown."
    return b


BUILDERS = {
    "plot_deco_hotel": plot_deco_hotel,
    "plot_beach_cafe": plot_beach_cafe,
    "plot_diner": plot_diner,
    "bg_1": bg_1,
    "bg_2": bg_2,
    "bg_3": bg_3,
    "bg_4": bg_4,
    "tower_1": tower_1,
    "tower_2": tower_2,
    "tower_3": tower_3,
}
