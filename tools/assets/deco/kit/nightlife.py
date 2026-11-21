"""Night life on the terraces: festoon string lights, poles, sconces, lantern
posts and marquee bulbs, all glowing through the `bulb` material.

Light sources are geometry only; the client adds no real lights. Each builder
also records a few light_<n> empties (Building.light) where the terrace most
needs a pool of light, which the client draws as a soft fake pool at night.
"""
import math

from .config import LIGHT

WIRE_R = 0.006
# The festoon cable is "wood" with its UV pinned into a plank gap of the
# shared wood texture, which is near black: a thin dark cable without a new
# material name. (textures.bake_wood: 14 planks over 1024 px, gaps at k * 73 px.)
CABLE_UV = (0.5, 1.0 - (3 * 1024 / 14 + 0.5) / 1024)


def _bulb(mb, x, y, z, r=0.035, seg=5):
    """Rounded festoon bulb, about 7 cm across, its neck at (x, y, z) on the
    cable (30 tris, smooth shaded)."""
    with mb.soft():
        mb.lathe([(0, -2.05 * r), (0.9 * r, -1.55 * r), (r, -0.85 * r), (0.45 * r, -0.15 * r), (0, 0.0)], x, z, "bulb",
                 seg=seg, y0=y)


def globe(mb, x, y, z, r=0.16, seg=10):
    """Frosted globe centred at (x, y, z)."""
    prof = [(r * math.sin(math.pi * k / 6), -r * math.cos(math.pi * k / 6)) for k in range(7)]
    prof[0] = (0, -r)
    prof[-1] = (0, r)
    with mb.soft():
        mb.lathe(prof, x, z, "bulb", seg=seg, y0=y)


def catenary(p0, p1, sag, n):
    """n+1 points from p0 to p1 sagging by `sag` in the middle (parabola)."""
    out = []
    for k in range(n + 1):
        t = k / n
        out.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t - 4 * sag * t * (1 - t),
                    p0[2] + (p1[2] - p0[2]) * t))
    return out


def string_lights(mb, anchors, sag=None, spacing=0.5, drop=0.004, bulb_r=0.035):
    """Festoon run through 3D anchor points (glTF space). Each span sags by
    `sag` (default 5 % of its length, at least 0.12 m); bulbs hang every
    `spacing` metres. Returns the number of bulbs."""
    nb = 0
    for a, b in zip(anchors[:-1], anchors[1:]):
        L = math.dist(a, b)
        s = sag if sag is not None else max(0.12, 0.05 * L)
        n = max(4, int(round(L / 0.45)))
        pts = catenary(a, b, s, n)
        with mb.soft(CABLE_UV):
            mb.tube(pts, WIRE_R, "wood", seg=3)
        m = max(1, int(L / spacing))
        for k in range(m):
            t = (k + 0.5) / m
            x = a[0] + (b[0] - a[0]) * t
            z = a[2] + (b[2] - a[2]) * t
            y = a[1] + (b[1] - a[1]) * t - 4 * s * t * (1 - t)
            _bulb(mb, x, y - drop, z, bulb_r)
            nb += 1
    return nb


def pole(mb, x, z, h, y0=0.0, mat="metal", r=0.045, foot=True, hook=True):
    """Slim pole for string lights; returns its top anchor point."""
    if foot:
        mb.cylinder(x, z, r * 2.6, y0, y0 + 0.06, "concrete", seg=10, bevel=0.015)
    mb.cylinder(x, z, r, y0, y0 + h, mat, seg=8, caps=False)
    mb.lathe([(0, y0 + h), (r * 1.4, y0 + h), (r * 1.4, y0 + h + 0.05), (r * 0.6, y0 + h + 0.1), (0, y0 + h + 0.12)],
             x, z, mat, seg=8)
    if hook:
        return (x, y0 + h - 0.06, z)
    return (x, y0 + h, z)


def timber_post(mb, x, z, h, y0=0.0, w=0.11, cap=True):
    """Square timber post (decks, pergolas); returns its top anchor point."""
    mb.box(x - w / 2, x + w / 2, y0, y0 + h, z - w / 2, z + w / 2, "wood", bevel=0.012, segs=1)
    if cap:
        mb.box(x - w / 2 - 0.02, x + w / 2 + 0.02, y0 + h, y0 + h + 0.04, z - w / 2 - 0.02, z + w / 2 + 0.02, "trim",
               bevel=0.01, segs=1)
    return (x, y0 + h - 0.08, z)


def sconce(mb, x, y, z, n=(0, 1)):
    """Deco wall sconce on a wall at (x, y, z) whose outward plan normal is n:
    a stepped trim back plate and a frosted half-drum glowing in front."""
    nx, nz = n
    tx, tz = -nz, nx

    def P(a, b, d):
        return (x + tx * a + nx * d, y + b, z + tz * a + nz * d)
    # back plate (two steps)
    for (hw, hh, d0, d1) in ((0.1, 0.24, 0.0, 0.025), (0.075, 0.2, 0.025, 0.045)):
        c = P(0, 0, (d0 + d1) / 2)
        mb.obox(c, (tx, tz), (nx, nz), hw, hh, (d1 - d0) / 2, "trim")
    # frosted half drum
    seg = 6
    r = 0.065
    ring_lo, ring_hi = [], []
    for k in range(seg + 1):
        a = math.pi * k / seg
        ring_lo.append(P(r * math.cos(a), -0.16, 0.045 + r * math.sin(a)))
        ring_hi.append(P(r * math.cos(a), 0.16, 0.045 + r * math.sin(a)))
    with mb.soft():
        for k in range(seg):
            am = math.pi * (k + 0.5) / seg
            out = (tx * math.cos(am) + nx * math.sin(am), 0, tz * math.cos(am) + nz * math.sin(am))
            mb.poly_n([ring_lo[k], ring_lo[k + 1], ring_hi[k + 1], ring_hi[k]], "bulb", out)
    # metal caps
    for yy, sgn in ((-0.16, -1), (0.16, 1)):
        cap = [P(1.15 * r * math.cos(math.pi * k / seg), yy + sgn * 0.02, 0.045 + 1.15 * r * math.sin(math.pi * k / seg))
               for k in range(seg + 1)]
        base = [P(1.15 * r * math.cos(math.pi * k / seg), yy, 0.045 + 1.15 * r * math.sin(math.pi * k / seg))
                for k in range(seg + 1)]
        mb.poly_n(cap, "metal", (0, sgn, 0))
        for k in range(seg):
            am = math.pi * (k + 0.5) / seg
            out = (tx * math.cos(am) + nx * math.sin(am), 0, tz * math.cos(am) + nz * math.sin(am))
            mb.poly_n([base[k], base[k + 1], cap[k + 1], cap[k]], "metal", out)


def lantern_post(mb, x, z, h=2.6, y0=0.0, globe_r=0.17):
    """Deco lamp post: fluted foot, slim shaft, a ring and a frosted globe."""
    mb.lathe([(0, y0), (0.16, y0), (0.16, y0 + 0.08), (0.1, y0 + 0.16), (0.07, y0 + 0.5), (0.05, y0 + 0.58), (0, y0 + 0.58)],
             x, z, "metal", seg=10)
    mb.cylinder(x, z, 0.035, y0 + 0.58, y0 + h - 0.1, "metal", seg=8, caps=False)
    mb.lathe([(0, y0 + h - 0.12), (0.09, y0 + h - 0.12), (0.1, y0 + h - 0.06), (0.06, y0 + h - 0.02), (0, y0 + h - 0.02)],
             x, z, "metal", seg=10)
    globe(mb, x, y0 + h - 0.02 + globe_r * 0.92, z, globe_r)
    return (x, y0 + h + globe_r, z)


def marquee_bulbs(mb, x0, x1, y0, y1, z, step=0.2, r=0.035, seg=8):
    """Theatre-style bulbs around a rectangle on a +Z facing sign at depth z."""
    pts = []
    w, h = x1 - x0, y1 - y0
    nx_, ny_ = max(2, int(round(w / step))), max(1, int(round(h / step)))
    for k in range(nx_):
        pts.append((x0 + w * k / nx_, y0))
        pts.append((x0 + w * (k + 1) / nx_, y1))
    for k in range(ny_):
        pts.append((x1, y0 + h * k / ny_))
        pts.append((x0, y0 + h * (k + 1) / ny_))
    for (x, y) in pts:
        # low dome facing +Z (18 tris)
        prof = [(r, 0.0), (r * 0.7, r * 0.6), (0, r * 0.85)]
        with mb.at(x, y, z, 0, pitch=90), mb.soft():
            mb.lathe(prof, 0, 0, "bulb", seg=seg)
    return len(pts)


def downlight_row(mb, x0, x1, y, z, n, r=0.05):
    """Row of recessed-look glowing discs on a soffit (facing down)."""
    for k in range(n):
        x = x0 + (x1 - x0) * (k + 0.5) / n
        with mb.soft():
            mb.lathe([(0, -0.012), (r, -0.012), (r * 1.15, 0.0)], x, z, "bulb", seg=8, y0=y)


def warm(kind="warm"):
    return LIGHT[kind]


def dot(mb, x, y, z, r=0.04):
    """Round sign bulb (a small smooth ball) for outlines on signs."""
    with mb.soft():
        mb.lathe([(0, -r), (0.8 * r, -0.55 * r), (0.8 * r, 0.55 * r), (0, r)], x, z, "bulb", seg=8, y0=y)
