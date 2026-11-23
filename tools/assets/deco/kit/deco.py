"""Architectural vocabulary: walls with recessed windows, eyebrows, parapets,
speed lines, fins, portholes, glass block, neon tubes.

Walls are built as horizontal bands swept along a closed plan path. Window
bands alternate piers (wall) and openings (recessed panes), which works the
same on straight runs and on rounded corners, so ribbon windows wrap corners
the way Streamline Moderne buildings do.
"""
import math

from .config import TILE
from .geo import Path, round_edge_section

INTERIOR_GRID = 4
_ATLAS_M = 3.0 / 1024.0


def atlas_rect(cell, grid=INTERIOR_GRID):
    """UV rect (Blender convention, v up) of an atlas cell; row 0 is the top."""
    r, c = divmod(cell, grid)
    return (c / grid + _ATLAS_M, 1 - (r + 1) / grid + _ATLAS_M, (c + 1) / grid - _ATLAS_M, 1 - r / grid - _ATLAS_M)


GLASS_BLOCK_CELL = 15
LIGHT_PANEL_CELL = 14


def room_cell(rng):
    """Random room cell from the interior atlas (cells 0-13)."""
    return int(rng.integers(LIGHT_PANEL_CELL))


def panel_uv():
    u0, v0, u1, v1 = atlas_rect(LIGHT_PANEL_CELL)
    return ((u0 + u1) / 2, (v0 + v1) / 2)


def solid_band(mb, path, y0, y1, mat="stucco"):
    if y1 - y0 > 1e-4:
        mb.ring_sweep(path, [(0, y0), (0, y1)], mat)


def _complement(intervals, L):
    out = []
    cur = 0.0
    for a, b in sorted(intervals):
        if a > cur + 1e-4:
            out.append((cur, a))
        cur = max(cur, b)
    if L > cur + 1e-4:
        out.append((cur, L))
    return out


class Opening:
    def __init__(self, sa, sb, depth=0.18, back="interior", pane_w=1.25, mullion="metal",
                 transom=None, sill=True, rng=None, cells=None, frame=0.05, vpanes=1):
        self.sa, self.sb = min(sa, sb), max(sa, sb)
        self.depth = depth
        self.back = back
        self.pane_w = pane_w
        self.mullion = mullion
        self.transom = transom
        self.sill = sill
        self.rng = rng
        self.cells = cells
        self.frame = frame
        self.vpanes = vpanes


def window_band(mb, path, ya, yb, openings, wall="stucco", rng=None):
    """Piers plus recessed openings between heights ya and yb."""
    L = path.L
    for a, b in _complement([(o.sa, o.sb) for o in openings], L):
        mb.sweep(path.sample(a, b), [(0, ya), (0, yb)], wall)
    for o in openings:
        _opening(mb, path, ya, yb, o, wall, rng)


def _opening(mb, path, ya, yb, o, wall, rng):
    d = o.depth
    samples = path.sample(o.sa, o.sb)
    # reveals: sill (faces up), head (faces down)
    mb.sweep(samples, [(0, ya), (-d, ya)], wall)
    mb.sweep(samples, [(-d, yb), (0, yb)], wall)
    # jambs
    for s, sign in ((o.sa, 1), (o.sb, -1)):
        x, z, nx, nz, tx, tz = path.point(s)
        p = lambda n, y: (x + nx * n, y, z + nz * n)
        mb.poly_n([p(0, ya), p(0, yb), p(-d, yb), p(-d, ya)], wall, (tx * sign, 0, tz * sign))
    # back panes
    span = o.sb - o.sa
    npanes = max(1, int(round(span / o.pane_w)))
    edges = [o.sa + span * k / npanes for k in range(npanes + 1)]
    back_pts = [(x, z, nx, nz, s) for (x, z, nx, nz, s) in samples]
    for k in range(npanes):
        pa, pb = edges[k], edges[k + 1]
        sub = path.sample(pa, pb)
        if o.back == "interior":
            if o.cells is not None:
                cell = o.cells[k % len(o.cells)]
            else:
                cell = room_cell(rng or o.rng)
            u0, v0, u1, v1 = atlas_rect(cell)

            def uvf(sa, sb, k1, k2, pa=pa, pb=pb, u0=u0, v0=v0, u1=u1, v1=v1):
                fa = (sa - pa) / (pb - pa)
                fb = (sb - pa) / (pb - pa)
                ua, ub = u0 + (u1 - u0) * fa, u0 + (u1 - u0) * fb
                return [(ua, v0), (ua, v1), (ub, v1), (ub, v0)]
            nv = max(1, o.vpanes)
            for j in range(nv):
                y0j = ya + (yb - ya) * j / nv
                y1j = ya + (yb - ya) * (j + 1) / nv
                mb.sweep(sub, [(-d, y0j), (-d, y1j)], "interior", uv_fn=uvf)
        else:
            mb.sweep(sub, [(-d, ya), (-d, yb)], o.back)
    # mullions between panes and a frame line against the jambs
    if o.mullion and o.back in ("interior", "glass"):
        fw = 0.045
        for k in range(1, npanes):
            _mullion(mb, path, edges[k], ya, yb, d, fw, o.mullion)
        if o.transom:
            yt = ya + (yb - ya) * o.transom
            sec = [(-d + 0.005, yt - 0.025), (-d + 0.055, yt - 0.025), (-d + 0.055, yt + 0.025), (-d + 0.005, yt + 0.025)]
            mb.sweep(samples, sec, o.mullion, closed_section=False)
    if o.sill:
        sill(mb, path, o.sa - 0.05, o.sb + 0.05, ya)


def _mullion(mb, path, s, ya, yb, d, w, mat):
    x, z, nx, nz, tx, tz = path.point(s)
    c = (x + nx * (-d + 0.035), (ya + yb) / 2, z + nz * (-d + 0.035))
    mb.obox(c, (tx, tz), (nx, nz), w / 2, (yb - ya) / 2, 0.03, mat)


def sill(mb, path, sa, sb, y, mat="trim", out=0.07, h=0.07):
    sec = [(0, y - h), (out, y - h), (out + 0.012, y - h * 0.4), (out, y), (0, y)]
    mb.sweep(path.sample(sa, sb), sec, mat, cap=(True, True))


def eyebrow(mb, path, sa, sb, y, depth=0.6, mat="trim", thick=0.14, ext=0.12):
    """Thin cantilevered sunshade with a rounded nose, top sloping outward."""
    t = thick
    sa, sb = min(sa, sb), max(sa, sb)
    sec = [(0, y), (depth - 0.05, y + 0.02), (depth - 0.01, y + 0.035), (depth, y + t * 0.5),
           (depth - 0.01, y + t * 0.75), (depth - 0.05, y + t * 0.85), (0, y + t)]
    mb.sweep(path.sample(sa - ext, sb + ext), sec, mat, cap=(True, True))


def band_ledge(mb, path, sa, sb, y, out=0.08, h=0.12, mat="trim", cap=True):
    """Horizontal string course / belt with a soft top edge."""
    sec = [(0, y), (out, y), (out, y + h - 0.02), (out - 0.02, y + h), (0, y + h)]
    if sa is not None:
        sa, sb = min(sa, sb), max(sa, sb)
    if sa is None:
        mb.ring_sweep(path, sec, mat)
    else:
        mb.sweep(path.sample(sa, sb), sec, mat, cap=(cap, cap))


def speed_lines(mb, path, sa, sb, y0, n=3, gap=0.16, h=0.055, out=0.04, mat="trim"):
    if sa is not None:
        sa, sb = min(sa, sb), max(sa, sb)
    for k in range(n):
        y = y0 + k * gap
        sec = [(0, y), (out, y + 0.006), (out, y + h - 0.006), (0, y + h)]
        if sa is None:
            mb.ring_sweep(path, sec, mat)
        else:
            mb.sweep(path.sample(sa, sb), sec, mat, cap=(True, True))


def parapet(mb, path, y_roof, y_top, th=0.25, wall="stucco", coping="trim", roof="roof", fill_roof=True,
            over=0.04):
    """Outer wall already reaches y_top; add a coping and the inner face, and fill the roof."""
    ct = 0.08
    sec = [(0, y_top), (over, y_top), (over, y_top + ct - 0.02), (over - 0.02, y_top + ct),
           (-th - over + 0.02, y_top + ct), (-th - over, y_top + ct - 0.02), (-th - over, y_top), (-th, y_top)]
    mb.ring_sweep(path, sec, coping)
    mb.ring_sweep(path, [(-th, y_top), (-th, y_roof)], wall)
    if fill_roof:
        inner = path.offset(-th)
        mb.poly([(p[0], y_roof, p[1]) for p in reversed(inner.pts)], roof)


def cornice_cap(mb, path, y, over=0.06, h=0.1, mat="trim"):
    """Flat roof edge with an overhanging slab (no parapet)."""
    sec = [(0, y), (over, y), (over, y + h - 0.02), (over - 0.02, y + h), (0, y + h)]
    mb.ring_sweep(path, sec, mat)


def roof_fill(mb, path, y, mat="roof", inset=0.0):
    p = path.offset(-inset) if inset else path
    mb.poly([(q[0], y, q[1]) for q in reversed(p.pts)], mat)


def fin(mb, x, z, y0, y1, depth, width, n=(0, 1), mat="trim", round_top=True, bevel=0.03):
    """Vertical fin standing out of a wall at plan point (x, z) along normal n."""
    nx, nz = n
    tx, tz = (-nz, nx)
    if round_top:
        r = min(depth * 0.9, (y1 - y0) * 0.3)
        prof = [(0, y0), (depth, y0)]
        for k in range(0, 7):
            a = math.radians(90 * k / 6)
            prof.append((depth - r + r * math.cos(a), y1 - r + r * math.sin(a)))
        prof.append((0, y1))
        P = lambda a, y, side: (x + nx * a + tx * side * width / 2, y, z + nz * a + tz * side * width / 2)
        m = len(prof)
        for k in range(m - 1):
            (a0, b0), (a1, b1) = prof[k], prof[k + 1]
            dn, dy = a1 - a0, b1 - b0
            out = (dy * nx - dn * 0, -dn, dy * nz)
            mb.poly_n([P(a0, b0, -1), P(a1, b1, -1), P(a1, b1, 1), P(a0, b0, 1)], mat, out)
        mb.poly_n([P(a, y, -1) for a, y in prof], mat, (-tx, 0, -tz))
        mb.poly_n([P(a, y, 1) for a, y in prof], mat, (tx, 0, tz))
    else:
        c = (x + nx * depth / 2, (y0 + y1) / 2, z + nz * depth / 2)
        mb.obox(c, (tx, tz), (nx, nz), width / 2, (y1 - y0) / 2, depth / 2, mat, bevel=bevel, segs=2)


def porthole(mb, c, n, r, ring_w=0.09, ring_out=0.09, mat_ring="trim", seg=20, back="interior", cell=5):
    """Round window applied on a wall: a proud ring and a glossy recessed disc.
    c = centre on the wall surface (x, y, z); n = outward plan normal."""
    nx, nz = n
    tx, tz = (-nz, nx)
    N = (nx, 0, nz)

    def P(a, b, off):
        return (c[0] + tx * a + nx * off, c[1] + b, c[2] + tz * a + nz * off)
    outer, inner = r + ring_w, r
    dback = ring_out - 0.07
    for k in range(seg):
        a0 = 2 * math.pi * k / seg
        a1 = 2 * math.pi * (k + 1) / seg
        am = (a0 + a1) / 2
        rad = (tx * math.cos(am), math.sin(am), tz * math.cos(am))
        c0, s0, c1, s1 = math.cos(a0), math.sin(a0), math.cos(a1), math.sin(a1)
        mb.poly_n([P(outer * c0, outer * s0, ring_out), P(outer * c1, outer * s1, ring_out),
                   P(inner * c1, inner * s1, ring_out), P(inner * c0, inner * s0, ring_out)], mat_ring, N)
        mb.poly_n([P(outer * c0, outer * s0, 0), P(outer * c1, outer * s1, 0),
                   P(outer * c1, outer * s1, ring_out), P(outer * c0, outer * s0, ring_out)], mat_ring, rad)
        mb.poly_n([P(inner * c0, inner * s0, ring_out), P(inner * c1, inner * s1, ring_out),
                   P(inner * c1, inner * s1, dback), P(inner * c0, inner * s0, dback)], mat_ring,
                  (-rad[0], -rad[1], -rad[2]))
    disc = [P(inner * math.cos(2 * math.pi * k / seg), inner * math.sin(2 * math.pi * k / seg), dback) for k in range(seg)]
    if back == "interior":
        u0, v0, u1, v1 = atlas_rect(cell)
        uvs = [(u0 + (u1 - u0) * (0.5 + 0.5 * math.cos(2 * math.pi * k / seg)),
                v0 + (v1 - v0) * (0.5 + 0.5 * math.sin(2 * math.pi * k / seg))) for k in range(seg)]
        mb.poly_n(disc, "interior", N, uvs)
    else:
        mb.poly_n(disc, back, N)
    # A pane of glass set into the ring: seen at an angle, the recessed room
    # picture alone read as an open hole.
    pane = [P(inner * math.cos(2 * math.pi * k / seg), inner * math.sin(2 * math.pi * k / seg), dback + 0.035)
            for k in range(seg)]
    mb.poly_n(pane, "glass", N)


def neon_tube(mb, pts3, r=0.022, mat="neon_accent", seg=6, closed=False):
    mb.tube(pts3, r, mat, seg=seg, closed=closed)


def neon_on_path(mb, path, sa, sb, y, off=0.06, r=0.022, mat="neon_accent"):
    sa, sb = min(sa, sb), max(sa, sb)
    pts = [(x + nx * off, y, z + nz * off) for (x, z, nx, nz, s) in path.sample(sa, sb)]
    mb.tube(pts, r, mat, seg=6)


def flat_rect_path(x0, x1, z0, z1):
    return Path([(x0, z0), (x1, z0), (x1, z1), (x0, z1)], True)


def floor_fan(mb, cx, cz, r0, r1, y, rays=11, a0=0.0, a1=180.0, ray_mat="stucco", ring_mat="trim",
              ring_w=0.1, seg_per_ray=2):
    """Sunburst inlay on a floor: alternating rays between r0 and r1 (plan
    angles measured from +X toward +Z), framed by a thin ring. Inlays sit a
    few millimetres proud of the floor so they never z-fight."""
    def P(r, a, yy=y):
        return (cx + r * math.cos(math.radians(a)), yy, cz + r * math.sin(math.radians(a)))
    up = (0, 1, 0)
    step = (a1 - a0) / rays
    for k in range(rays):
        if k % 2:
            continue
        aa, ab = a0 + k * step, a0 + (k + 1) * step
        pts = [P(r0, aa)]
        for j in range(seg_per_ray + 1):
            pts.append(P(r1, aa + (ab - aa) * j / seg_per_ray))
        pts.append(P(r0, ab))
        mb.poly_n(pts, ray_mat, up)
    n = rays * seg_per_ray
    for rr, w in ((r1, ring_w), (r0, ring_w * 0.8)):
        for j in range(n):
            aa = a0 + (a1 - a0) * j / n
            ab = a0 + (a1 - a0) * (j + 1) / n
            mb.poly_n([P(rr, aa, y + 0.001), P(rr + w, aa, y + 0.001), P(rr + w, ab, y + 0.001), P(rr, ab, y + 0.001)],
                      ring_mat, up)


def striped_awning(mb, x0, x1, z_wall, y_wall, depth, drop, valance=0.24, segs=4, sag=0.07,
                   posts=(), pole_mat="metal", sides=True):
    """Fabric awning on a wall facing +Z: from y_wall at the wall down to
    y_wall - drop at z_wall + depth, gently convex, with a scalloped valance.
    Stripes run down the slope (U = x / stripe period)."""
    from .config import AWNING_STRIPE_PERIOD as P
    prof = []
    for k in range(segs + 1):
        t = k / segs
        prof.append((z_wall + depth * t, y_wall - drop * t + sag * math.sin(math.pi * t)))
    acc = 0.0
    for k in range(segs):
        (za, ya), (zb, yb) = prof[k], prof[k + 1]
        L = math.hypot(zb - za, yb - ya)
        n = (0, (zb - za) / L, -(yb - ya) / L)
        uv = [(x0 / P, -acc / 2.0), (x1 / P, -acc / 2.0), (x1 / P, -(acc + L) / 2.0), (x0 / P, -(acc + L) / 2.0)]
        mb.poly_n([(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)], "awning", n, uv)
        acc += L
    zf, yf = prof[-1]
    # scalloped valance, one scallop per stripe
    half = P / 2
    k0 = math.floor(x0 / half)
    k1 = math.ceil(x1 / half)
    for k in range(k0, k1):
        xa, xb = max(x0, k * half), min(x1, (k + 1) * half)
        if xb - xa < 1e-4:
            continue
        pts = [(xa, yf, zf), (xb, yf, zf)]
        m = 5
        for j in range(m + 1):
            t = 1 - j / m
            x = xa + (xb - xa) * t
            dip = math.sin(math.pi * (x - k * half) / half)
            pts.append((x, yf - valance + 0.05 - 0.05 * dip, zf))
        uvs = [(p[0] / P, -(acc + (yf - p[1])) / 2.0) for p in pts]
        mb.poly_n(pts, "awning", (0, 0, 1), uvs)
    if sides:
        for x, sx in ((x0, -1), (x1, 1)):
            pts = [(x, y, z) for (z, y) in prof] + [(x, yf - valance + 0.05, zf), (x, y_wall - 0.05, z_wall)]
            uvs = [(0.25, -(p[2] - z_wall) / 2.0) for p in pts]
            mb.poly_n(pts, "awning", (sx, 0, 0), uvs)
    # frame: front bar and posts
    mb.tube([(x0, yf - 0.01, zf - 0.01), (x1, yf - 0.01, zf - 0.01)], 0.022, pole_mat, seg=6)
    for x in posts:
        mb.cylinder(x, zf - 0.03, 0.03, 0.0, yf, pole_mat, seg=8, caps=False)
        mb.cylinder(x, zf - 0.03, 0.06, 0.0, 0.04, pole_mat, seg=10, bevel=0.01)
    return zf, yf


def applied_door(mb, x0, x1, y0, y1, z, mat_frame="trim", panes=2, cell=None, glass_mat="interior", depth=0.12):
    """Door set on a +Z facing wall: proud frame, metal leaves, glass panes."""
    from .deco import panel_uv
    fw = 0.12
    mb.box(x0 - fw, x0, y0, y1 + fw, z, z + depth, mat_frame, bevel=0.02, segs=1)
    mb.box(x1, x1 + fw, y0, y1 + fw, z, z + depth, mat_frame, bevel=0.02, segs=1)
    mb.box(x0 - fw, x1 + fw, y1, y1 + fw, z, z + depth, mat_frame, bevel=0.02, segs=1)
    w = (x1 - x0) / panes
    # A room's door (a room picture, not the lit panel of a shop door) is painted, with a small
    # square window: as a full-height pane, the stretched room picture read as a door of floorboards.
    room = cell is not None and cell < LIGHT_PANEL_CELL
    for k in range(panes):
        a, b = x0 + k * w, x0 + (k + 1) * w
        if room:
            mb.box(a + 0.005, b - 0.005, y0, y1, z + 0.01, z + 0.05, "door", bevel=0.01, segs=1)
            side = min(0.34, (b - a) - 0.36)
            cx, top = (a + b) / 2, y1 - 0.3
            border = 0.035
            mb.poly([(cx - side / 2 - border, top - side - border, z + 0.051), (cx + side / 2 + border, top - side - border, z + 0.051),
                     (cx + side / 2 + border, top + border, z + 0.051), (cx - side / 2 - border, top + border, z + 0.051)], mat_frame)
            u0, v0, u1, v1 = atlas_rect(cell)
            mb.poly([(cx - side / 2, top - side, z + 0.053), (cx + side / 2, top - side, z + 0.053), (cx + side / 2, top, z + 0.053),
                     (cx - side / 2, top, z + 0.053)], glass_mat, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
            hx = b - 0.13 if k == panes - 1 else a + 0.13
            mb.box(hx - 0.018, hx + 0.018, y0 + 0.98, y0 + 1.05, z + 0.05, z + 0.1, "metal", bevel=0.008, segs=1)
            continue
        mb.box(a + 0.005, b - 0.005, y0, y1, z + 0.01, z + 0.05, "metal")
        if cell is None:
            uv = [panel_uv()] * 4
        else:
            u0, v0, u1, v1 = atlas_rect(cell)
            uv = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        mb.poly([(a + 0.06, y0 + 0.12, z + 0.052), (b - 0.06, y0 + 0.12, z + 0.052), (b - 0.06, y1 - 0.08, z + 0.052),
                 (a + 0.06, y1 - 0.08, z + 0.052)], glass_mat, uv)


def slope_band(mb, path, sa, sb, y0, ytop, mat="stucco"):
    """Wall strip from y0 up to ytop(x, z) along a path interval."""
    sa, sb = min(sa, sb), max(sa, sb)
    pts = path.sample(sa, sb)
    for i in range(len(pts) - 1):
        (xa, za, _, _, s0), (xb, zb, _, _, s1) = pts[i], pts[i + 1]
        quad = [(xa, y0, za), (xa, ytop(xa, za), za), (xb, ytop(xb, za), zb), (xb, y0, zb)]
        nx, nz = path.point((s0 + s1) / 2)[2:4]
        t = TILE[mat]
        uvs = [(s0 / t, y0 / t), (s0 / t, ytop(xa, za) / t), (s1 / t, ytop(xb, zb) / t), (s1 / t, y0 / t)]
        mb.poly_n(quad, mat, (nx, 0, nz), uvs)
