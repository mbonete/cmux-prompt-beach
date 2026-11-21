"""Background vehicles: four generic cars, three boats, a helicopter and a blimp.

All original, contemporary and generic (no brands, badges or liveries).
Front is +Z, pivot at the base centre (the ground under a car, the keel
under a boat, the skids under the helicopter, the gondola under the blimp).

Cars are lofted from cross-sections: each station is (z, sill, belt, roof
edge, roof, body half-width, roof half-width) and the interval to the next
station carries a tag that says which parts of the ring are glass.
"""
import math

from .mesh import MB, interp, lerp, rrect, offset_outline
from .props import Asset, plate

# ---------------------------------------------------------------------------
# cars
# ---------------------------------------------------------------------------
# Half ring segments: 0 bottom, 1-4 body side, 5 side window, 6 window frame,
# 7 pillar strip on the top edge, 8-9 top surface (roof / hood / glass).
_P, _G, _T, _L = "carpaint", "glass", "trim", "leather"
TAGS = {
    "hood":       [_T, _P, _P, _P, _P, _P, _P, _P, _P, _P],
    "trunk":      [_T, _P, _P, _P, _P, _P, _P, _P, _P, _P],
    "pillar":     [_T, _P, _P, _P, _P, _P, _P, _P, _P, _P],
    "side":       [_T, _P, _P, _P, _P, _G, _P, _P, _P, _P],
    "bpillar":    [_T, _P, _P, _P, _P, _T, _P, _P, _P, _P],
    "windshield": [_T, _P, _P, _P, _P, _G, _P, _P, _G, _G],
    "rearglass":  [_T, _P, _P, _P, _P, _P, _P, _P, _G, _G],
    "tubwall":    [_T, _P, _P, _P, _P, _P, _T, _L, _L, _L],
    "cabin":      [_T, _P, _P, _P, _P, _P, _T, _L, _T, _T],
}


def _ring(st, open_cabin, wf):
    z, yb, belt, yE, yTop, wB, wT = st
    wS = wB - 0.05
    y2 = yb + min(0.12, 0.3 * (belt - yb))
    y3 = (y2 + belt) / 2
    half = [(0.0, yb), (wB - 0.1, yb), (wB - 0.005, y2), (wB + 0.012, y3), (wB, belt), (wS, belt + 0.03)]
    if open_cabin:
        fl = belt - 0.34
        half += [(wS - 0.06, belt + 0.035), (wS - 0.09, belt - 0.05), (wS - 0.11, fl + 0.02), (0.45, fl), (0.0, fl)]
    else:
        crown = lambda x: yTop - (yTop - yE) * (x / wT) ** 2
        half += [(lerp(wS, wT, wf), lerp(belt + 0.03, yE, wf)), (wT, yE), (wT - 0.08, crown(wT - 0.08)),
                 (wT * 0.5, crown(wT * 0.5)), (0.0, yTop)]
    ring = [(x, y, z) for (x, y) in half] + [(-x, y, z) for (x, y) in reversed(half[1:-1])]
    return ring


def car(spec):
    a = Asset("car", spec["notes"])
    mb = a.mb
    L, r = spec["L"], spec["r"]
    keys = spec["keys"]
    zs_key = [k[0] for k in keys]
    Ra = r + 0.075
    axles = spec["axles"]
    wf = spec.get("wf", 0.88)
    opn = spec.get("open")

    def field(i, z):
        return interp([(k[0], k[i]) for k in keys], z)

    def tag_at(z):
        for k0, k1 in zip(keys, keys[1:]):
            if k0[0] <= z <= k1[0]:
                return k0[7]
        return keys[-2][7]

    zs = set(round(z, 4) for z in zs_key)
    for zA in axles:
        for f in (-1.0, -0.8, -0.45, 0.0, 0.45, 0.8, 1.0):
            zs.add(round(zA + f * Ra, 4))
    zs = sorted(zs)
    clean = [zs[0]]
    for z in zs[1:]:
        if z - clean[-1] > 0.025:
            clean.append(z)
    zs = clean

    def arch(z):
        h = -1.0
        for zA in axles:
            d = z - zA
            if abs(d) < Ra:
                h = max(h, r + math.sqrt(Ra * Ra - d * d))
        return h

    stations = []
    for z in zs:
        yb = max(field(1, z), arch(z))
        stations.append((z, yb, field(2, z), field(3, z), field(4, z), field(5, z), field(6, z)))
    rings = [_ring(s, bool(opn) and opn[0] - 1e-4 <= s[0] <= opn[1] + 1e-4, wf) for s in stations]
    n = len(rings[0])
    tags = [tag_at((zs[i] + zs[i + 1]) / 2) for i in range(len(zs) - 1)]

    def matfn(i, k):
        seg = k if k < 10 else n - 1 - k
        return TAGS[tags[i]][seg]
    mb.loft(rings, matfn, closed=True, cap0=_P, cap1=_P, outward=(0, 0.75, 0))

    wB = spec["W"] / 2
    zF, zR = L / 2, -L / 2
    # underbody and wheel wells
    mb.box(-(wB - 0.3), wB - 0.3, 0.14, 0.78, zR + 0.3, zF - 0.3, _T)
    # wheels: tyre and a dished alloy rim
    tw = 0.22
    for zA in axles:
        for s in (-1, 1):
            x = s * (wB - 0.16)
            with mb.at(x=x, y=r, z=zA, roll=90):
                mb.lathe([(r * 0.66, -tw / 2), (r, -tw / 2 + 0.04), (r, tw / 2 - 0.04), (r * 0.66, tw / 2)], 10, _T)
                mb.cyl(r * 0.66, -tw / 2 + 0.025, tw / 2 - 0.025, 10, "chrome")
    # bumpers, grille, lights
    lo = spec["lights"]
    yN = stations[-1][1]
    mb.box(-wB + 0.12, wB - 0.12, yN - 0.02, yN + 0.1, zF - 0.25, zF + 0.025, _T, bevel=0.03)
    gy = spec.get("grille", (0.42, 0.6))
    mb.box(-0.46, 0.46, gy[0], gy[1], zF - 0.08, zF + 0.012, _T)
    hx0, hx1, hy0, hy1 = lo["head"]
    for s in (-1, 1):
        mb.box(s * hx0, s * hx1, hy0, hy1, zF - 0.16, zF + 0.012, "headlight")
    yR = stations[0][1]
    mb.box(-wB + 0.12, wB - 0.12, yR - 0.02, yR + 0.1, zR - 0.025, zR + 0.25, _T, bevel=0.03)
    tx0, tx1, ty0, ty1 = lo["tail"]
    for s in (-1, 1):
        mb.box(s * tx0, s * tx1, ty0, ty1, zR - 0.014, zR + 0.12, "taillight")
    if lo.get("bar"):
        by0, by1 = lo["bar"]
        mb.box(-tx0, tx0, by0, by1, zR - 0.01, zR + 0.05, "taillight")
    if lo.get("rear_window"):
        x0, y0, y1 = lo["rear_window"]
        mb.box(-x0, x0, y0, y1, zR - 0.012, zR + 0.05, _G)
    # mirrors at the base of the A pillar
    mz, my = spec["mirror"]
    for s in (-1, 1):
        mb.box(s * (wB - 0.02), s * (wB + 0.14), my, my + 0.11, mz - 0.07, mz + 0.06, _P)
    if spec.get("extra"):
        spec["extra"](mb)
    return a


def _convertible_extra(mb):
    # windscreen in a thin frame
    p0, p1 = (0.72, 0.93, 0.6), (0.66, 1.27, 0.31)
    mb.poly([(-p0[0], p0[1], p0[2]), (p0[0], p0[1], p0[2]), (p1[0], p1[1], p1[2]), (-p1[0], p1[1], p1[2])],
            "glass", facing=(0, 0.6, 1))
    mb.tube([(-p0[0], p0[1], p0[2]), (-p1[0], p1[1], p1[2]), (p1[0], p1[1], p1[2]), (p0[0], p0[1], p0[2])],
            0.022, 6, "chrome")
    # seats
    fl = 0.55
    for x in (-0.38, 0.38):
        mb.box(x - 0.24, x + 0.24, fl, fl + 0.13, -0.32, 0.18, "leather", bevel=0.04, segs=1)
        with mb.at(x=x, y=fl + 0.1, z=-0.33, pitch=-14):
            mb.box(-0.23, 0.23, 0.0, 0.58, -0.12, 0.0, "leather", bevel=0.04, segs=1)
            mb.box(-0.13, 0.13, 0.6, 0.78, -0.1, 0.0, "leather", bevel=0.03, segs=1)
    mb.box(-0.68, 0.68, fl, fl + 0.12, -0.98, -0.62, "leather", bevel=0.04, segs=1)
    with mb.at(y=fl + 0.08, z=-0.98, pitch=-10):
        mb.box(-0.68, 0.68, 0.0, 0.42, -0.08, 0.04, "leather", bevel=0.04, segs=1)
    # steering wheel
    with mb.at(x=-0.38, y=0.98, z=0.33, pitch=-60):
        mb.lathe([(0.17, -0.015), (0.19, 0.0), (0.17, 0.015), (0.15, 0.0), (0.17, -0.015)], 12, _T)


CARS = {
    "car_compact": dict(
        notes="Compact five-door hatchback, 3.95 m. carpaint is tinted per instance; headlight and taillight are emissive.",
        L=3.95, W=1.74, r=0.31, axles=(-1.33, 1.17),
        keys=[
            (-1.975, 0.36, 0.90, 0.98, 1.00, 0.80, 0.68, "rearglass"),
            (-1.80, 0.31, 0.98, 1.38, 1.42, 0.86, 0.66, "side"),
            (-0.30, 0.30, 0.97, 1.42, 1.47, 0.87, 0.67, "bpillar"),
            (-0.18, 0.30, 0.97, 1.42, 1.47, 0.87, 0.67, "side"),
            (0.22, 0.30, 0.96, 1.41, 1.46, 0.87, 0.68, "windshield"),
            (1.00, 0.30, 0.92, 0.97, 1.00, 0.87, 0.80, "hood"),
            (1.60, 0.30, 0.88, 0.92, 0.95, 0.86, 0.78, "hood"),
            (1.90, 0.33, 0.80, 0.84, 0.86, 0.82, 0.72, "hood"),
            (1.975, 0.37, 0.72, 0.76, 0.78, 0.76, 0.64, None),
        ],
        lights=dict(head=(0.42, 0.76, 0.66, 0.75), tail=(0.5, 0.8, 0.78, 0.92)),
        grille=(0.4, 0.56), mirror=(0.95, 0.9),
    ),
    "car_sedan": dict(
        notes="Mid-size sedan, 4.75 m. carpaint is tinted per instance; headlight and taillight are emissive.",
        L=4.75, W=1.82, r=0.33, axles=(-1.36, 1.42),
        keys=[
            (-2.375, 0.34, 0.84, 0.90, 0.92, 0.80, 0.70, "trunk"),
            (-2.30, 0.31, 0.93, 0.98, 1.00, 0.88, 0.80, "trunk"),
            (-1.70, 0.30, 0.95, 1.00, 1.03, 0.91, 0.82, "trunk"),
            (-1.30, 0.30, 0.96, 1.01, 1.05, 0.91, 0.80, "rearglass"),
            (-0.60, 0.30, 0.96, 1.37, 1.42, 0.91, 0.70, "side"),
            (-0.08, 0.30, 0.955, 1.39, 1.44, 0.91, 0.70, "bpillar"),
            (0.04, 0.30, 0.95, 1.39, 1.44, 0.91, 0.70, "side"),
            (0.38, 0.30, 0.95, 1.38, 1.43, 0.91, 0.71, "windshield"),
            (1.12, 0.30, 0.93, 0.98, 1.01, 0.91, 0.84, "hood"),
            (1.85, 0.30, 0.89, 0.93, 0.96, 0.90, 0.83, "hood"),
            (2.28, 0.32, 0.81, 0.85, 0.88, 0.86, 0.76, "hood"),
            (2.375, 0.36, 0.73, 0.77, 0.79, 0.79, 0.68, None),
        ],
        lights=dict(head=(0.48, 0.8, 0.66, 0.74), tail=(0.55, 0.84, 0.8, 0.9), bar=(0.83, 0.87)),
        grille=(0.42, 0.6), mirror=(1.05, 0.9),
    ),
    "car_convertible": dict(
        notes="Two-door convertible with the top down, 4.45 m: open cabin with leather seats. carpaint is tinted "
              "per instance; headlight and taillight are emissive.",
        L=4.45, W=1.80, r=0.33, axles=(-1.30, 1.30), open=(-0.98, 0.52),
        keys=[
            (-2.225, 0.36, 0.80, 0.84, 0.86, 0.80, 0.70, "hood"),
            (-2.15, 0.31, 0.88, 0.91, 0.93, 0.87, 0.78, "hood"),
            (-1.05, 0.30, 0.90, 0.935, 0.96, 0.90, 0.82, "tubwall"),
            (-0.98, 0.30, 0.90, 0.935, 0.96, 0.90, 0.82, "cabin"),
            (0.52, 0.30, 0.89, 0.93, 0.96, 0.90, 0.84, "tubwall"),
            (0.60, 0.30, 0.89, 0.93, 0.96, 0.90, 0.84, "hood"),
            (1.60, 0.30, 0.86, 0.90, 0.93, 0.89, 0.82, "hood"),
            (2.13, 0.32, 0.79, 0.83, 0.85, 0.85, 0.74, "hood"),
            (2.225, 0.36, 0.71, 0.75, 0.77, 0.78, 0.66, None),
        ],
        lights=dict(head=(0.46, 0.79, 0.63, 0.71), tail=(0.5, 0.82, 0.74, 0.84)),
        grille=(0.4, 0.58), mirror=(0.62, 0.9), extra=_convertible_extra,
    ),
    "car_van": dict(
        notes="People carrier / small van, 4.95 m. carpaint is tinted per instance; headlight and taillight are emissive.",
        L=4.95, W=1.92, r=0.34, axles=(-1.60, 1.40), wf=0.68,
        keys=[
            (-2.475, 0.40, 1.02, 1.82, 1.87, 0.92, 0.85, "pillar"),
            (-2.40, 0.33, 1.04, 1.86, 1.92, 0.95, 0.87, "side"),
            (-0.35, 0.32, 1.04, 1.86, 1.92, 0.96, 0.87, "bpillar"),
            (-0.22, 0.32, 1.04, 1.86, 1.92, 0.96, 0.87, "side"),
            (0.95, 0.32, 1.03, 1.85, 1.91, 0.96, 0.88, "windshield"),
            (1.75, 0.32, 1.00, 1.08, 1.12, 0.96, 0.90, "hood"),
            (2.30, 0.34, 0.93, 0.98, 1.01, 0.93, 0.86, "hood"),
            (2.475, 0.38, 0.84, 0.88, 0.90, 0.86, 0.78, None),
        ],
        lights=dict(head=(0.5, 0.84, 0.74, 0.84), tail=(0.72, 0.9, 0.62, 1.2), rear_window=(0.72, 1.18, 1.72)),
        grille=(0.45, 0.66), mirror=(1.7, 1.02),
    ),
}

# ---------------------------------------------------------------------------
# boats
# ---------------------------------------------------------------------------


def hull(mb, L, beam, free, deck_mat, keel=0.0, sheer=0.25, deadrise=0.28, side_mat=None, stations=26):
    """V hull lofted from the transom (z = -L/2) to the bow (+L/2). Keel at y = 0."""
    rings, zs = [], []
    for i in range(stations + 1):
        u = i / stations
        u = 1 - (1 - u) ** 1.25  # denser toward the bow
        z = -L / 2 + L * u
        if u < 0.55:
            wg = beam / 2 * (0.9 + 0.1 * math.sin(math.pi * u / 1.1))
        else:
            t = (u - 0.55) / 0.45
            wg = beam / 2 * math.sqrt(max(0.0, 1 - t ** 1.9))
        wg = max(wg, 0.015)
        yG = free + sheer * u ** 2.2
        yK = 0.06 * (1 - u) ** 3 + (max(0.0, u - 0.6) / 0.4) ** 1.7 * (yG - 0.25)
        yC = yK + deadrise * (1 - max(0.0, u - 0.6) / 0.4 * 0.5)
        wc = wg * 0.88
        ySt = yG - min(0.16, (yG - yC) * 0.25)
        yD = yG + 0.05 + 0.04 * (1 - u)
        half = [(0.0, yK), (wc * 0.5, yK + (yC - yK) * 0.42), (wc, yC), (wg * 0.99, ySt), (wg, yG),
                (wg - 0.05 * min(1, wg * 8), yG + 0.05), (wg * 0.5, yD - 0.01), (0.0, yD)]
        ring = [(x, y, z) for (x, y) in half] + [(-x, y, z) for (x, y) in reversed(half[1:-1])]
        rings.append(ring)
        zs.append(z)
    n = len(rings[0])
    segs = ["paint", "paint", "hull", "paint", "hull", deck_mat, deck_mat]

    def matfn(i, k):
        seg = k if k < 7 else n - 1 - k
        m = segs[seg]
        if callable(deck_mat) and seg >= 5:
            m = deck_mat((zs[i] + zs[i + 1]) / 2)
        if side_mat and seg == 3:
            m = side_mat((zs[i] + zs[i + 1]) / 2) or m
        return m
    mb.loft(rings, matfn, closed=True, cap0="hull", outward=(0, free * 0.6, 0))
    return rings


def speedboat():
    a = Asset("boat", "Sport speedboat, 7.2 m, twin outboards and a wraparound windscreen. Pivot at the keel; "
                      "extras.waterline is the float height. paint (boot and sheer stripe) is tinted per instance.")
    mb = a.mb
    L, beam, free = 7.2, 2.45, 1.0
    hull(mb, L, beam, free, lambda z: "hull" if z > 0.9 else "teak", sheer=0.22, deadrise=0.32)
    dy = free + 0.06
    # windscreen: three panes wrapping round the cockpit
    pts = [(-1.05, 0.35), (-0.75, 0.9), (0.0, 1.05), (0.75, 0.9), (1.05, 0.35)]
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        mb.poly([(x0, dy, z0), (x1, dy, z1), (x1 * 0.96, dy + 0.42, z1 - 0.22), (x0 * 0.96, dy + 0.42, z0 - 0.22)],
                "glass", facing=((x0 + x1) / 2, 0.4, 1.0))
    mb.tube([(x * 0.96, dy + 0.42, z - 0.22) for (x, z) in pts], 0.02, 5, "chrome", cap=False)
    # console, seats, rear bench, sun pad
    mb.box(0.15, 0.85, dy, dy + 0.72, -0.15, 0.55, "hull", bevel=0.05)
    for x in (-0.5, 0.5):
        mb.box(x - 0.27, x + 0.27, dy, dy + 0.45, -0.85, -0.35, "leather", bevel=0.05, segs=2)
        mb.box(x - 0.27, x + 0.27, dy + 0.45, dy + 0.95, -0.9, -0.74, "leather", bevel=0.05, segs=2)
    mb.box(-1.0, 1.0, dy, dy + 0.4, -2.75, -2.2, "leather", bevel=0.05, segs=2)
    mb.box(-1.0, 1.0, dy + 0.4, dy + 0.85, -2.95, -2.72, "leather", bevel=0.05, segs=2)
    mb.box(-0.8, 0.8, dy, dy + 0.12, 1.4, 2.6, "leather", bevel=0.05, segs=2)
    # twin outboards on the transom
    for x in (-0.42, 0.42):
        mb.box(x - 0.24, x + 0.24, 0.75, 1.45, -L / 2 - 0.55, -L / 2 - 0.05, "trim", bevel=0.09, segs=2)
        mb.box(x - 0.07, x + 0.07, 0.05, 0.78, -L / 2 - 0.42, -L / 2 - 0.2, "trim")
    # stern light
    mb.cyl(0.035, dy + 0.42, dy + 0.55, 6, "chrome")
    mb.sphere(0.05, 8, 4, "headlight", cy=dy + 0.58)
    a.extras["waterline"] = 0.42
    return a


def sailboat():
    a = Asset("boat", "Small sloop, 6.6 m, mast 9 m, mainsail and jib set to starboard. Pivot at the bottom of "
                      "the keel fin; extras.waterline is the float height. paint is tinted per instance.")
    mb = a.mb
    L, beam, free = 6.6, 2.3, 0.85
    fin = 0.9  # keel fin below the hull
    with mb.at(y=fin):
        hull(mb, L, beam, free, lambda z: "teak" if z < -0.9 else "hull", sheer=0.18, deadrise=0.2)
        dy = free + 0.06
        # cabin trunk with ports
        out = rrect(-0.85, 0.85, -0.9, 1.4, rb=0.15, rf=0.7, seg=5)
        mb.prism(out, [(dy, dy + 0.18, "hull"), (dy + 0.18, dy + 0.34, "glass"), (dy + 0.34, dy + 0.48, "hull")],
                 lambda mid, bi, m: "hull" if (bi == 1 and mid[1] < -0.8) else m, top="hull")
        # keel fin and rudder
        with mb.at(yaw=90):
            plate(mb, [(-0.55, 0.15), (0.45, 0.15), (0.25, -fin), (-0.35, -fin)], 0.12, "trim")
            plate(mb, [(-3.2, 0.3), (-2.9, 0.3), (-2.95, -0.55), (-3.15, -0.55)], 0.06, "trim")
        # mast, boom, rigging
        mz = 0.9
        top = dy + 0.48 + 8.4
        mb.cyl(0.06, dy + 0.48, top, 8, "metal", r1=0.045)
        bz = -2.55
        boom_y = dy + 0.48 + 0.95
        ang = math.radians(12)
        bx = (mz - bz) * math.sin(ang)
        bzz = mz - (mz - bz) * math.cos(ang)
        mb.tube([(0, boom_y, mz), (bx, boom_y, bzz)], 0.045, 6, "metal")
        for p in ((0.0, dy + 0.1, L / 2 - 0.05), (0.0, dy + 0.1, -L / 2 + 0.1)):
            mb.tube([p, (0, top - 0.3, mz)], 0.008, 4, "metal", cap=False)
        # mainsail: camber across the chord, roach at the leech
        rows, cols = 6, 4
        luff0, luff1 = boom_y + 0.04, top - 0.25

        def main(t, s):
            y = lerp(luff0, luff1, t)
            chord = (1 - t) ** 0.92
            cz = mz - (mz - bz) * math.cos(ang) * chord * s
            cx = (mz - bz) * math.sin(ang) * chord * s
            camber = 0.22 * (1 - t * 0.6) * math.sin(math.pi * s) * chord
            return (cx + camber * math.cos(ang), y, cz + camber * math.sin(ang) * 0.3)
        for i in range(rows):
            for j in range(cols):
                t0, t1 = i / rows, (i + 1) / rows
                s0, s1 = j / cols, (j + 1) / cols
                mb.poly([main(t0, s0), main(t0, s1), main(t1, s1), main(t1, s0)], "sail", facing=(1, 0, 0))
        # jib: head near the masthead, tack at the bow, clew aft to starboard
        head = (0.0, top - 1.3, mz + 0.05)
        tack = (0.0, dy + 0.25, L / 2 - 0.25)
        clew = (0.55, dy + 0.55, mz - 0.6)

        def jib(t, s):
            # t: foot (0) to head (1); s: luff (0) to leech (1)
            lu = [lerp(tack[k], head[k], t) for k in range(3)]
            le = [lerp(clew[k], head[k], t) for k in range(3)]
            p = [lerp(lu[k], le[k], s) for k in range(3)]
            p[0] += 0.2 * math.sin(math.pi * s) * (1 - t)
            return tuple(p)
        for i in range(4):
            for j in range(3):
                t0, t1 = i / 4, (i + 1) / 4
                s0, s1 = j / 3, (j + 1) / 3
                mb.poly([jib(t0, s0), jib(t0, s1), jib(t1, s1), jib(t1, s0)], "sail", facing=(1, 0, 0))
        mb.sphere(0.06, 8, 4, "headlight", cy=top + 0.05)
    a.extras["waterline"] = fin + 0.36
    return a


def cruiser():
    a = Asset("boat", "Motor yacht, 14 m: a rounded superstructure with a wraparound glass band, flybridge and "
                      "radar arch. Pivot at the keel; extras.waterline is the float height. paint is tinted per instance.")
    mb = a.mb
    L, beam, free = 14.0, 4.3, 1.95
    hull(mb, L, beam, free, lambda z: "teak" if z < -5.6 else "hull", sheer=0.45, deadrise=0.55,
         side_mat=lambda z: "glass" if -3.4 < z < 2.6 else None, stations=30)
    dy = free + 0.06
    # swim platform
    mb.box(-1.8, 1.8, 0.62, 0.74, -L / 2 - 0.9, -L / 2 + 0.05, "teak")
    # superstructure
    out = rrect(-1.75, 1.75, -4.6, 2.6, rb=0.25, rf=1.3, seg=6)
    mb.prism(out, [(dy, dy + 0.42, "hull"), (dy + 0.42, dy + 1.38, "glass"), (dy + 1.38, dy + 1.62, "hull")],
             lambda mid, bi, m: "hull" if (bi == 1 and mid[1] < -4.4) else m, top="hull")
    mb.slab(offset_outline(out, 0.12), dy + 1.62, dy + 1.7, "hull")
    # flybridge
    fy = dy + 1.7
    fb = rrect(-1.55, 1.55, -3.9, 0.9, rb=0.2, rf=0.9, seg=5)
    mb.prism(fb, [(fy, fy + 0.62, "hull"), (fy + 0.62, fy + 0.86, "glass")],
             lambda mid, bi, m: "glass" if (bi == 1 and mid[1] > 0.1) else ("hull" if bi == 1 else m))
    mb.slab(rrect(-1.45, 1.45, -3.8, 0.8, rb=0.15, rf=0.8, seg=5), fy, fy + 0.05, "teak")
    mb.box(-1.3, 1.3, fy, fy + 0.42, -3.6, -2.9, "leather", bevel=0.06, segs=2)
    mb.box(-1.3, 1.3, fy + 0.42, fy + 0.9, -3.72, -3.5, "leather", bevel=0.06, segs=2)
    mb.box(0.1, 0.9, fy, fy + 0.9, -0.2, 0.35, "hull", bevel=0.05)
    # radar arch and mast
    for x in (-1.25, 1.25):
        mb.beam((x, fy + 0.6, -2.4), (x * 0.75, fy + 1.9, -2.75), 0.22, 0.6, "hull")
    mb.box(-1.0, 1.0, fy + 1.85, fy + 2.05, -3.05, -2.45, "hull", bevel=0.05)
    mb.cyl(0.04, fy + 2.05, fy + 2.9, 6, "metal")
    mb.cyl(0.28, fy + 2.1, fy + 2.22, 12, "white")
    mb.sphere(0.06, 8, 4, "headlight", cy=fy + 2.95)
    # bow rail
    rail = [(-0.7, dy + 0.8, 1.2), (-1.7, dy + 0.8, 2.8), (-1.35, dy + 0.85, 4.9), (-0.55, dy + 0.9, 6.3),
            (0.0, dy + 0.9, 6.6), (0.55, dy + 0.9, 6.3), (1.35, dy + 0.85, 4.9), (1.7, dy + 0.8, 2.8), (0.7, dy + 0.8, 1.2)]
    mb.tube(rail, 0.03, 5, "chrome", cap=False)
    for p in rail[1:-1:2]:
        with mb.at(x=p[0], z=p[2]):
            mb.cyl(0.02, dy - 0.02, p[1], 4, "chrome", cap0=False, cap1=False)
    a.extras["waterline"] = 0.85
    return a


# ---------------------------------------------------------------------------
# aircraft
# ---------------------------------------------------------------------------


def helicopter():
    a = Asset("air", "Light utility helicopter, 12 m rotor span. Child nodes rotor (spins about +Y at its origin) "
                     "and tail_rotor (spins about +X at its origin). Pivot under the skids. carpaint is tinted.")
    mb = a.mb
    st = [(-6.4, 2.0, 0.05, 0.07), (-5.7, 1.93, 0.11, 0.15), (-3.2, 1.78, 0.19, 0.23), (-2.1, 1.66, 0.3, 0.38),
          (-1.65, 1.58, 0.58, 0.68), (-1.0, 1.47, 0.8, 0.86), (-0.2, 1.42, 0.83, 0.88), (0.55, 1.37, 0.81, 0.85),
          (1.15, 1.3, 0.74, 0.78), (1.6, 1.2, 0.6, 0.63), (1.95, 1.11, 0.4, 0.42), (2.15, 1.05, 0.14, 0.15)]
    seg = 16
    rings = []
    for (z, cy, rx, ry) in st:
        rings.append([(rx * math.sin(2 * math.pi * k / seg), cy + ry * math.cos(2 * math.pi * k / seg), z) for k in range(seg)])

    def matfn(i, k):
        zm = (st[i][0] + st[i + 1][0]) / 2
        th = abs(((k + 0.5) / seg) * 360.0)
        th = th if th <= 180 else 360 - th  # 0 at the top, 180 underneath
        if zm > 0.55 and th < 118:
            return "glass"
        if -1.0 < zm < 0.55 and 42 < th < 98 and not (-0.45 < zm < -0.25):
            return "glass"
        return "carpaint"
    mb.loft(rings, matfn, closed=True, cap0="carpaint", cap1="glass", outward=(0, 1.45, -0.5))
    # engine cowling and mast
    mb.box(-0.48, 0.48, 2.05, 2.5, -1.75, 0.35, "carpaint", bevel=0.14, segs=2)
    mb.box(-0.16, 0.16, 2.1, 2.36, -2.05, -1.7, "trim")
    mb.cyl(0.08, 2.45, 2.95, 8, "trim")
    # skids
    for s in (-1, 1):
        x = s * 1.02
        mb.tube([(x, 0.06, -1.7), (x, 0.06, 1.45), (x, 0.14, 1.78), (x, 0.32, 1.95)], 0.045, 6, "trim")
        for z in (-0.95, 0.85):
            mb.tube([(x, 0.06, z), (x * 0.92, 0.45, z), (s * 0.5, 0.78, z)], 0.04, 6, "trim", cap=False)
    # tail: fin, stabiliser
    with mb.at(yaw=90):
        plate(mb, [(5.7, 1.9), (6.35, 3.0), (6.68, 3.0), (6.5, 1.72)], 0.07, "carpaint")
    mb.box(-0.95, 0.95, 1.83, 1.88, -5.15, -4.75, "carpaint")
    for s in (-1, 1):
        mb.box(s * 0.93, s * 0.97, 1.7, 2.06, -5.2, -4.72, "carpaint")
    # lights: anti-collision beacons and a landing light
    with mb.at(z=-6.5):
        mb.sphere(0.06, 8, 4, "taillight", cy=3.04)
    with mb.at(z=-0.6):
        mb.sphere(0.07, 8, 4, "taillight", cy=0.58)
    with mb.at(z=1.6):
        mb.sphere(0.08, 8, 4, "headlight", cy=0.72)

    # main rotor node (origin at the hub)
    rot = MB()
    rot.cyl(0.18, -0.08, 0.1, 10, "trim")
    for k in range(4):
        with rot.at(yaw=45 + 90 * k):
            rot.box(-0.14, 0.14, -0.02, 0.02, 0.15, 5.9, "trim")
    a.nodes.append(("rotor", rot, (0.0, 3.0, -0.4)))
    tr = MB()
    with tr.at(roll=90):
        tr.cyl(0.07, -0.06, 0.06, 8, "trim")
    for k in range(2):
        with tr.at(pitch=180 * k):
            tr.box(-0.015, 0.015, 0.05, 0.78, -0.06, 0.06, "trim")
    a.nodes.append(("tail_rotor", tr, (-0.12, 2.45, -6.45)))
    return a


def blimp():
    a = Asset("air", "Plain airship, 42 m, no markings: silver envelope, four tail fins (paint, tinted per instance) "
                     "and a small gondola. Pivot under the gondola.")
    mb = a.mb
    Lh = 21.0
    R = 5.0
    cy = 1.95 + R

    def prof(u):
        return u ** 0.55 * (1 - u) ** 0.8
    mx = max(prof(i / 400) for i in range(401))
    rows = 22
    pts = []
    for i in range(rows + 1):
        t = i / rows
        u = 0.5 - 0.5 * math.cos(math.pi * t)  # denser at both ends
        r = R * prof(u) / mx
        pts.append((r if 0 < i < rows else 0.0, -Lh + 2 * Lh * u))
    with mb.at(y=cy, pitch=90):
        mb.lathe(pts, 24, "envelope")

    def radius_at(z):
        u = (z + Lh) / (2 * Lh)
        return R * prof(max(0.0, min(1.0, u))) / mx
    # cruciform tail fins
    z0, z1 = -18.6, -12.6
    for k in range(4):
        with mb.at(y=cy, roll=90 * k):
            with mb.at(pitch=90):
                fin = [(radius_at(z1) - 0.3, z1), (radius_at(z0) - 0.3, z0), (radius_at(z0) + 2.9, z0 - 1.1),
                       (radius_at(-15.6) + 3.0, -15.0)]
                plate(mb, [(u, -z) for (u, z) in fin], 0.22, "paint")
    # gondola
    out = rrect(-0.95, 0.95, 0.4, 6.8, rb=0.8, rf=0.95, seg=6)
    mb.prism(out, [(0.0, 0.25, "white"), (0.25, 0.95, "glass"), (0.95, 2.1, "white")],
             lambda mid, bi, m: "white" if (bi == 1 and mid[1] < 1.4) else m, top="white", bottom="white")
    for s in (-1, 1):
        mb.beam((s * 0.9, 1.3, 3.6), (s * 1.75, 1.3, 3.6), 0.12, 0.12, "white")
        with mb.at(x=s * 1.95, y=1.3, z=3.6, pitch=90):
            mb.lathe([(0.0, -0.8), (0.28, -0.55), (0.32, 0.2), (0.22, 0.65), (0.0, 0.7)], 10, "trim")
    with mb.at(z=-Lh + 0.05):
        mb.sphere(0.16, 8, 4, "taillight", cy=cy)
    with mb.at(z=5.6):
        mb.sphere(0.1, 8, 4, "headlight", cy=-0.02)
    return a
