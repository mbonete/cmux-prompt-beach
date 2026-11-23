"""Street and beach props: Deco lamps, a lifeguard tower, umbrella, lounger, towel.

Every builder returns an Asset: the main mesh builder, optional extra mesh
nodes, empties (name, position, extras) and notes for the manifest.
Coordinates are glTF space, metres, pivot at the base centre, front +Z.
"""
import math

from .mesh import MB, lerp, offset_outline, rrect


class Asset:
    def __init__(self, kind, notes=""):
        self.kind = kind
        self.mb = MB()
        self.nodes = []      # (name, MB, pivot) extra mesh nodes
        self.empties = []    # (name, (x, y, z), extras)
        self.notes = notes
        self.extras = {}


def plate(mb, pts, t, mat):
    """Flat plate: polygon pts [(u, y)] in the local XY plane, thickness t along Z."""
    rings = [[(u, y, -t / 2) for (u, y) in pts], [(u, y, t / 2) for (u, y) in pts]]
    return mb.loft(rings, lambda i, k: mat, closed=True, cap0=mat, cap1=mat)


def star(r_out, r_in, n, y):
    pts = []
    for k in range(n * 2):
        a = math.pi * k / n
        r = r_out if k % 2 == 0 else r_in
        pts.append((r * math.sin(a), y, r * math.cos(a)))
    return pts


def _plinth(mb, r=0.30, h=0.60):
    """Stepped octagonal Deco plinth with four tapering fins."""
    mb.lathe([(r, 0.0), (r, 0.10), (r - 0.05, 0.14), (r - 0.05, h - 0.18), (r - 0.10, h - 0.13),
              (r - 0.10, h - 0.04), (r - 0.15, h), (0.0, h)], 8, "pole", smooth_shade=False)
    for k in range(4):
        with mb.at(yaw=45 + 90 * k):
            with mb.at(yaw=-90):
                plate(mb, [(r - 0.10, 0.10), (r + 0.02, 0.10), (r + 0.02, 0.2), (r - 0.06, h + 0.22),
                           (r - 0.10, h + 0.22)], 0.03, "pole")


def _collar(mb, y, r=0.105):
    mb.lathe([(r, y - 0.035), (r + 0.025, y - 0.01), (r, y + 0.035)], 10, "pole")


def lamp_deco():
    a = Asset("street", "Deco street lamp, 5 m: stepped octagonal plinth with fins, fluted shaft, "
                        "opal globe (material bulb, emissive). Empty bulb_0 marks the light centre.")
    mb = a.mb
    _plinth(mb)
    y0, y1 = 0.60, 3.92
    mb.loft([star(0.092, 0.078, 12, y0), star(0.072, 0.061, 12, y1)], lambda i, k: "pole", closed=True)
    for y in (0.62, 2.35):
        _collar(mb, y, 0.095)
    mb.lathe([(0.07, 3.9), (0.13, 3.98), (0.13, 4.04), (0.175, 4.065), (0.175, 4.12), (0.0, 4.16)], 10, "pole")
    mb.sphere(0.28, 12, 7, "bulb", cy=4.42)
    mb.lathe([(0.0, 4.64), (0.13, 4.70), (0.10, 4.755), (0.03, 4.8), (0.0, 4.98)], 10, "pole")
    a.empties.append(("bulb_0", (0.0, 4.42, 0.0), {"radius": 0.28}))
    return a


def lamp_promenade():
    a = Asset("street", "Short twin-globe Deco lamp for the promenade, 3.5 m. Two opal globes (bulb); "
                        "empties bulb_0 and bulb_1 mark the light centres.")
    mb = a.mb
    _plinth(mb, r=0.26, h=0.5)
    y0, y1 = 0.5, 2.72
    mb.loft([star(0.082, 0.07, 12, y0), star(0.066, 0.056, 12, y1)], lambda i, k: "pole", closed=True)
    for y in (0.52, 1.75):
        _collar(mb, y, 0.08)
    # crossbar with Deco scroll arms
    for s in (-1, 1):
        pts = [(0.0, 2.72, 0), (s * 0.18, 2.74, 0), (s * 0.36, 2.82, 0), (s * 0.47, 2.95, 0), (s * 0.5, 3.04, 0)]
        mb.tube(pts, 0.03, 6, "pole")
        with mb.at(x=s * 0.5):
            mb.lathe([(0.05, 3.02), (0.1, 3.06), (0.1, 3.1), (0.0, 3.11)], 8, "pole")
            mb.sphere(0.2, 12, 7, "bulb", cy=3.28)
            mb.lathe([(0.0, 3.45), (0.07, 3.46), (0.0, 3.54)], 8, "pole")
        a.empties.append((f"bulb_{0 if s < 0 else 1}", (s * 0.5, 3.28, 0.0), {"radius": 0.2}))
    mb.lathe([(0.07, 2.72), (0.1, 2.76), (0.06, 2.84), (0.025, 3.1), (0.0, 3.18)], 8, "pole")
    return a


def lifeguard_tower():
    a = Asset("beach", "Lifeguard tower, original design: a pastel hut with rounded Deco front corners, "
                       "speed lines and an eyebrow roof on white stilts, a front deck and a ramp down the back. "
                       "Material paint is the pastel (tint per instance); front +Z faces the sea.")
    mb = a.mb
    deck_y = 1.95
    # stilts and braces
    for x in (-1.3, 1.3):
        for z in (-1.15, 1.05):
            mb.box(x - 0.08, x + 0.08, 0.0, deck_y - 0.1, z - 0.08, z + 0.08, "white")
        mb.beam((x, 0.25, -1.1), (x, deck_y - 0.2, 1.0), 0.06, 0.08, "white")
        mb.beam((x, 0.25, 1.0), (x, deck_y - 0.2, -1.1), 0.06, 0.08, "white")
    for z in (-1.15, 1.05):
        mb.beam((-1.25, 0.3, z), (1.25, deck_y - 0.25, z), 0.06, 0.08, "white")
    # deck with a front porch and a back landing
    mb.box(-1.75, 1.75, deck_y - 0.12, deck_y, -1.95, 2.0, "wood")
    mb.box(-1.78, 1.78, deck_y - 0.26, deck_y - 0.12, -1.98, 2.03, "white", bottom=True)
    # porch railing
    rail_y = deck_y + 0.95
    posts = [(-1.68, 1.94), (-0.6, 1.94), (0.6, 1.94), (1.68, 1.94), (-1.68, 1.1), (1.68, 1.1), (-1.68, -1.88),
             (1.68, -1.88), (-1.68, -1.35), (0.55, -1.88)]
    for (x, z) in posts:
        mb.box(x - 0.035, x + 0.035, deck_y, rail_y, z - 0.035, z + 0.035, "white")
    for y, r in ((rail_y, 0.035), (deck_y + 0.5, 0.022)):
        mb.tube([(-1.68, y, 1.1), (-1.68, y, 1.94), (1.68, y, 1.94), (1.68, y, 1.1)], r, 6, "white")
        mb.tube([(-1.68, y, -1.35), (-1.68, y, -1.88), (0.55, y, -1.88)], r, 6, "white")
    # cabin: rounded front corners, speed lines, a glass band round the front
    out = rrect(-1.25, 1.25, -1.3, 1.0, rb=0.0, rf=0.62, seg=6)
    glass_band = 4

    def cabin_mat(mid, bi, mat):
        if bi == glass_band:
            return "glass" if mid[1] > -0.75 else "paint"
        return mat
    bands = [(deck_y, deck_y + 0.62, "paint"), (deck_y + 0.62, deck_y + 0.69, "white"),
             (deck_y + 0.69, deck_y + 0.76, "paint"), (deck_y + 0.76, deck_y + 0.83, "white"),
             (deck_y + 0.83, deck_y + 1.62, "glass"), (deck_y + 1.62, deck_y + 1.86, "paint")]
    mb.prism(out, bands, cabin_mat)
    # mullions in the glass band
    for (x, z) in ((-1.25, 0.2), (1.25, 0.2), (-0.9, 0.86), (0.9, 0.86), (0.0, 1.0)):
        mb.box(x - 0.04, x + 0.04, deck_y + 0.83, deck_y + 1.62, z - 0.04, z + 0.04, "white")
    # speed lines stand proud of the wall
    for y in (deck_y + 0.62, deck_y + 0.76):
        mb.prism(offset_outline(out, 0.025), [(y, y + 0.07, "white")], top="white", bottom="white")
    # door on the back wall, above the ramp: a plain painted leaf in a white frame, with a handle
    # (in "wood", the deck planks' texture, it read as a door made of floorboards)
    mb.box(0.25, 1.05, deck_y, deck_y + 1.55, -1.33, -1.29, "accent")
    for x in (0.2, 1.05):
        mb.box(x, x + 0.05, deck_y, deck_y + 1.55, -1.35, -1.29, "white")
    mb.box(0.2, 1.1, deck_y + 1.55, deck_y + 1.62, -1.35, -1.29, "white")
    mb.box(0.86, 0.94, deck_y + 0.74, deck_y + 0.79, -1.37, -1.33, "metal")
    # eyebrow roof and a stepped crown
    roof_y = deck_y + 1.86
    mb.slab(offset_outline(out, 0.34), roof_y, roof_y + 0.12, "white")
    crown = rrect(-0.85, 0.85, -0.9, 0.55, rf=0.4, seg=5)
    mb.slab(crown, roof_y + 0.12, roof_y + 0.32, "paint", top_mat="white")
    mb.slab(offset_outline(crown, 0.08), roof_y + 0.32, roof_y + 0.38, "white")
    # flag mast and pennant
    mb.cyl(0.03, roof_y + 0.38, roof_y + 2.0, 8, "metal")
    with mb.at(z=0.0):
        mb.poly([(0, roof_y + 1.97, 0.0), (0, roof_y + 1.57, 0.0), (0, roof_y + 1.77, 0.62)], "accent", facing=(1, 0, 0))
    # lifebuoy on the porch rail
    with mb.at(x=-0.95, y=deck_y + 0.55, z=1.98, pitch=90):
        mb.lathe([(0.22, 0.0), (0.26, 0.04), (0.3, 0.0), (0.26, -0.04), (0.22, 0.0)], 14, "accent")
    # ramp down the back
    top = (1.1, deck_y - 0.02, -1.95)
    bot = (1.1, 0.02, -6.4)
    mb.beam((top[0], top[1] - 0.05, top[2]), (bot[0], bot[1] - 0.05, bot[2]), 1.0, 0.1, "wood")
    for s in (-1, 1):
        x = 1.1 + s * 0.52
        n = 5
        for i in range(n):
            t = i / (n - 1)
            y = lerp(top[1], bot[1], t)
            z = lerp(top[2], bot[2], t)
            mb.box(x - 0.03, x + 0.03, y, y + 0.92, z - 0.03, z + 0.03, "white")
        mb.tube([(x, top[1] + 0.92, top[2]), (x, bot[1] + 0.92, bot[2])], 0.03, 6, "white")
    for t in (0.33, 0.66):
        y = lerp(top[1], bot[1], t)
        z = lerp(top[2], bot[2], t)
        for s in (-1, 1):
            mb.box(1.1 + s * 0.42 - 0.06, 1.1 + s * 0.42 + 0.06, 0.0, y - 0.1, z - 0.06, z + 0.06, "white")
    return a


def umbrella():
    a = Asset("beach", "Open beach umbrella, 2.3 m, eight alternating gores: canvas (tint per instance) and "
                       "canvas_white, with a scalloped valance. The pole goes 0.3 m into the sand.")
    mb = a.mb
    R, apex, edge = 1.12, 2.36, 1.98
    mb.cyl(0.022, -0.3, apex + 0.05, 8, "metal", cap0=False)
    n = 8
    rings = 4
    for g in range(n):
        mat = "canvas" if g % 2 == 0 else "canvas_white"
        a0 = 2 * math.pi * g / n
        a1 = 2 * math.pi * (g + 1) / n

        def pt(t, s):
            # t: 0 apex .. 1 edge; s: 0..1 across the gore
            ang = lerp(a0, a1, s)
            sag = math.sin(math.pi * s) * 0.05 * t
            r = R * t * (1 - 0.04 * math.sin(math.pi * s))
            y = lerp(apex, edge, t ** 1.25) - sag
            return (r * math.sin(ang), y, r * math.cos(ang))
        cols = 3
        for i in range(rings):
            for j in range(cols):
                t0, t1 = i / rings, (i + 1) / rings
                s0, s1 = j / cols, (j + 1) / cols
                if i == 0:
                    mb.poly([pt(0, 0), pt(t1, s0), pt(t1, s1)], mat, facing=(0, 1, 0))
                else:
                    mb.poly([pt(t0, s0), pt(t1, s0), pt(t1, s1), pt(t0, s1)], mat, facing=(0, 1, 0))
        # valance flap with a scalloped hem
        for j in range(cols):
            s0, s1 = j / cols, (j + 1) / cols
            p0, p1 = pt(1, s0), pt(1, s1)
            d0 = 0.07 + 0.07 * math.sin(math.pi * s0)
            d1 = 0.07 + 0.07 * math.sin(math.pi * s1)
            mb.poly([p0, p1, (p1[0], p1[1] - d1, p1[2]), (p0[0], p0[1] - d0, p0[2])],
                    mat, facing=(math.sin((a0 + a1) / 2), 0, math.cos((a0 + a1) / 2)))
    mb.lathe([(0.0, apex + 0.02), (0.06, apex + 0.03), (0.04, apex + 0.1), (0.0, apex + 0.13)], 10, "canvas_white")
    return a


def lounger():
    a = Asset("beach", "Sun lounger, 1.95 m: white frame, cushion (tint per instance) with the backrest up. "
                       "Seat top 0.36 m. Front +Z is the foot end.")
    mb = a.mb
    seat_y = 0.30
    # frame: two side rails and four legs
    for x in (-0.33, 0.33):
        mb.box(x - 0.025, x + 0.025, seat_y - 0.07, seat_y - 0.01, -0.55, 0.98, "white")
        for z in (-0.5, 0.9):
            mb.box(x - 0.025, x + 0.025, 0.0, seat_y - 0.05, z - 0.025, z + 0.025, "white")
    mb.box(-0.33, 0.33, seat_y - 0.06, seat_y - 0.01, 0.94, 0.98, "white")
    # cushion: flat bed plus the raised back
    mb.box(-0.32, 0.32, seat_y - 0.01, seat_y + 0.07, -0.42, 0.96, "cushion", bevel=0.03, segs=2)
    with mb.at(y=seat_y + 0.02, z=-0.44, pitch=-50):
        mb.box(-0.32, 0.32, -0.04, 0.05, -0.68, 0.0, "cushion", bevel=0.03, segs=2)
        mb.box(-0.3, 0.3, -0.07, -0.04, -0.66, -0.02, "white")
    # back strut
    mb.beam((0.0, 0.02, -0.55), (0.0, seat_y + 0.3, -0.75), 0.5, 0.03, "white")
    return a


def towel():
    a = Asset("beach", "Beach towel, 1.7 x 0.85 m, lying on the sand with a slight ripple; striped texture, "
                       "material towel (tint per instance).")
    mb = a.mb
    nx, nz = 6, 10
    W, L = 0.85, 1.7

    def h(i, j):
        return 0.012 + 0.008 * math.sin(i * 1.7 + j * 0.9) * math.sin(j * 0.7)
    for i in range(nx):
        for j in range(nz):
            x0, x1 = -W / 2 + W * i / nx, -W / 2 + W * (i + 1) / nx
            z0, z1 = -L / 2 + L * j / nz, -L / 2 + L * (j + 1) / nz
            pts = [(x0, h(i, j), z0), (x0, h(i, j + 1), z1), (x1, h(i + 1, j + 1), z1), (x1, h(i + 1, j), z0)]
            uvs = [(i / nx, j / nz), (i / nx, (j + 1) / nz), ((i + 1) / nx, (j + 1) / nz), ((i + 1) / nx, j / nz)]
            mb.poly(pts, "towel", facing=(0, 1, 0), uvs=uvs)
    return a
