"""Mesh construction helpers on top of bmesh.

All inputs are in glTF space (X right, Y up, Z front); the builder converts to
Blender space (x, -z, y) when it creates vertices, which is a pure rotation, so
counter-clockwise winding in glTF space stays counter-clockwise.

Conventions used throughout:
* Plan paths live in the (x, z) plane. Closed paths are normalised to positive
  signed area (x0*z1 - x1*z0 summed), for which the outward normal of a segment
  with direction (tx, tz) is (tz, -tx). A rounded rectangle therefore runs
  +x along the back, +z up the right side, -x along the front, -z down the left.
* A sweep extrudes a cross-section given as (n, y) pairs, n being the offset
  along the path's outward normal. Sections listed counter-clockwise in an
  (n right, y up) plot produce outward-facing surfaces.
* Every UV is in texture repeats: world metres / config.TILE[material].
"""
import math
from contextlib import contextmanager

import bmesh

from .config import TILE

EPS = 1e-6


def B(p):
    """glTF (x, y, z) -> Blender (x, -z, y)."""
    return (p[0], -p[2], p[1])


def _len2(a):
    return math.hypot(a[0], a[1])


def signed_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        a += x0 * z1 - x1 * z0
    return a * 0.5


# ---------------------------------------------------------------------------
# Plan paths
# ---------------------------------------------------------------------------
class Path:
    """A polyline in the (x, z) plane with arc length and mitred normals."""

    def __init__(self, pts, closed=True):
        pts = [tuple(map(float, p)) for p in pts]
        # drop duplicate consecutive points
        clean = [pts[0]]
        for p in pts[1:]:
            if _len2((p[0] - clean[-1][0], p[1] - clean[-1][1])) > 1e-5:
                clean.append(p)
        if closed and _len2((clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1])) < 1e-5:
            clean.pop()
        pts = clean
        if closed and signed_area(pts) < 0:
            pts = pts[::-1]
        self.pts = pts
        self.closed = closed
        n = len(pts)
        nseg = n if closed else n - 1
        self.seg_t, self.seg_n, self.s = [], [], [0.0]
        for i in range(nseg):
            a, b = pts[i], pts[(i + 1) % n]
            d = (b[0] - a[0], b[1] - a[1])
            L = _len2(d)
            t = (d[0] / L, d[1] / L)
            self.seg_t.append(t)
            self.seg_n.append((t[1], -t[0]))
            self.s.append(self.s[-1] + L)
        self.L = self.s[-1]
        self.vn = []
        for i in range(n):
            if closed:
                n1, n2 = self.seg_n[i - 1], self.seg_n[i % nseg]
            else:
                n1, n2 = self.seg_n[max(i - 1, 0)], self.seg_n[min(i, nseg - 1)]
            f = 1.0 + n1[0] * n2[0] + n1[1] * n2[1]
            if f < 1e-4:
                self.vn.append(n1)
            else:
                self.vn.append(((n1[0] + n2[0]) / f, (n1[1] + n2[1]) / f))

    # -- queries -----------------------------------------------------------
    def _seg_at(self, s):
        if self.closed:
            s = s % self.L
        nseg = len(self.seg_t)
        for i in range(nseg):
            if s <= self.s[i + 1] + 1e-9:
                return i, s
        return nseg - 1, s

    def point(self, s):
        """(x, z, nx, nz, tx, tz) at arc length s (segment normal, not mitred)."""
        i, s = self._seg_at(s)
        a = self.pts[i]
        t = self.seg_t[i]
        u = s - self.s[i]
        nrm = self.seg_n[i]
        return (a[0] + t[0] * u, a[1] + t[1] * u, nrm[0], nrm[1], t[0], t[1])

    def s_of(self, p):
        """Arc length of the point on the path nearest to plan point p."""
        best = (1e18, 0.0)
        n = len(self.pts)
        for i in range(len(self.seg_t)):
            a = self.pts[i]
            b = self.pts[(i + 1) % n]
            d = (b[0] - a[0], b[1] - a[1])
            L2 = d[0] * d[0] + d[1] * d[1]
            u = max(0.0, min(1.0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2))
            q = (a[0] + d[0] * u, a[1] + d[1] * u)
            dist = _len2((p[0] - q[0], p[1] - q[1]))
            if dist < best[0] - 1e-9:
                best = (dist, self.s[i] + u * math.sqrt(L2))
        return best[1]

    def sample(self, s0, s1):
        """Points from s0 to s1 (s1 may exceed L on closed paths): list of
        (x, z, nx, nz, s) with mitred normals at interior vertices."""
        out = []
        n = len(self.pts)
        x, z, nx, nz, _, _ = self.point(s0)
        vi = self._vertex_at(s0)
        if vi is not None:
            nx, nz = self.vn[vi]
        out.append((x, z, nx, nz, s0))
        laps = [0.0, self.L] if self.closed else [0.0]
        for lap in laps:
            for i in range(n):
                sv = self.s[i] + lap
                if s0 + 1e-6 < sv < s1 - 1e-6:
                    p = self.pts[i]
                    out.append((p[0], p[1], self.vn[i][0], self.vn[i][1], sv))
        x, z, nx, nz, _, _ = self.point(s1)
        vi = self._vertex_at(s1)
        if vi is not None:
            nx, nz = self.vn[vi]
        out.append((x, z, nx, nz, s1))
        return out

    def _vertex_at(self, s):
        if self.closed:
            s = s % self.L
            if abs(s - self.L) < 1e-6:
                s = 0.0
        for i in range(len(self.pts)):
            if abs(self.s[i] - s) < 1e-6:
                return i
        return None

    def full(self):
        """All vertices of a closed path, for full-loop sweeps."""
        return [(p[0], p[1], self.vn[i][0], self.vn[i][1], self.s[i]) for i, p in enumerate(self.pts)]

    def offset(self, d):
        """New closed/open path offset outward by d (mitred)."""
        pts = [(p[0] + self.vn[i][0] * d, p[1] + self.vn[i][1] * d) for i, p in enumerate(self.pts)]
        return Path(pts, self.closed)


def arc_pts(cx, cz, r, a0, a1, seg):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / seg)),
             cz + r * math.sin(math.radians(a0 + (a1 - a0) * k / seg))) for k in range(seg + 1)]


def rrect(x0, x1, z0, z1, r=(0, 0, 0, 0), seg=8):
    """Rounded rectangle. r = (back_left, back_right, front_right, front_left).
    The path starts on the back edge so front intervals never wrap."""
    bl, br, fr, fl = r
    pts = []

    def corner(cx, cz, rad, a0, a1, px, pz):
        if rad <= 1e-6:
            pts.append((px, pz))
        else:
            pts.extend(arc_pts(cx, cz, rad, a0, a1, seg))
    pts.append((x0 + bl, z0))
    corner(x1 - br, z0 + br, br, -90, 0, x1, z0)
    corner(x1 - fr, z1 - fr, fr, 0, 90, x1, z1)
    corner(x0 + fl, z1 - fl, fl, 90, 180, x0, z1)
    corner(x0 + bl, z0 + bl, bl, 180, 270, x0, z0)
    return Path(pts, closed=True)


def circle_path(cx, cz, r, seg=24):
    return Path([(cx + r * math.cos(2 * math.pi * k / seg), cz + r * math.sin(2 * math.pi * k / seg))
                 for k in range(seg)], closed=True)


def stadium(x0, x1, z0, z1, seg=10):
    """Pill shape: semicircular ends along X."""
    r = (z1 - z0) / 2
    return rrect(x0, x1, z0, z1, (r, r, r, r), seg)


# ---------------------------------------------------------------------------
# Mesh builder
# ---------------------------------------------------------------------------
class MB:
    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.lock = self.bm.faces.layers.int.new("uvlock")
        # "soft" faces (bulbs, festoon wires) are smooth shaded with one pinned
        # UV, so their vertices are shared: tiny parts stay cheap in bytes
        self.soft_layer = self.bm.faces.layers.int.new("soft")
        self._soft = 0
        self.mats = []
        self._xf = []

    @contextmanager
    def soft(self, pin=(0.5, 0.5)):
        """Faces made inside are smooth shaded with one pinned UV (bulbs,
        cables): shared vertices, no seams."""
        self._soft += 1
        prev, self._pin = getattr(self, "_pin", (0.5, 0.5)), pin
        try:
            yield
        finally:
            self._soft -= 1
            self._pin = prev

    @contextmanager
    def at(self, x=0.0, y=0.0, z=0.0, yaw=0.0, pitch=0.0):
        """Local frame: pitch about local +X, then yaw degrees about +Y (local
        +Z maps to (sin yaw, 0, cos yaw)), then translate."""
        self._xf.append((x, y, z, math.radians(yaw), math.radians(pitch)))
        try:
            yield
        finally:
            self._xf.pop()

    def tp(self, p):
        x, y, z = p
        for (ox, oy, oz, a, pt) in reversed(self._xf):
            if pt:
                cp, sp = math.cos(pt), math.sin(pt)
                y, z = y * cp - z * sp, y * sp + z * cp
            c, s = math.cos(a), math.sin(a)
            x, z = x * c + z * s, -x * s + z * c
            x, y, z = x + ox, y + oy, z + oz
        return (x, y, z)

    def tyaw(self, yaw=0.0):
        return yaw + sum(math.degrees(a) for (_, _, _, a, _) in self._xf)

    def mi(self, name):
        if name not in TILE:
            raise ValueError(f"unknown material {name}")
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    # -- raw ------------------------------------------------------------------
    def verts(self, pts):
        if self._xf:
            return [self.bm.verts.new(B(self.tp(p))) for p in pts]
        return [self.bm.verts.new(B(p)) for p in pts]

    def face(self, vs, mat, uvs=None):
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        f.material_index = self.mi(mat)
        f.smooth = True
        if self._soft:
            f[self.soft_layer] = 1
            uvs = [self._pin] * len(vs)
        if uvs is not None:
            for l, uv in zip(f.loops, uvs):
                l[self.uv].uv = uv
            f[self.lock] = 1
        return f

    def poly(self, pts, mat, uvs=None):
        return self.face(self.verts(pts), mat, uvs)

    def poly_n(self, pts, mat, nrm, uvs=None):
        """Polygon whose winding is flipped if needed so it faces nrm (glTF space)."""
        n = newell(pts)
        if n[0] * nrm[0] + n[1] * nrm[1] + n[2] * nrm[2] < 0:
            pts = list(reversed(pts))
            if uvs is not None:
                uvs = list(reversed(uvs))
        return self.poly(pts, mat, uvs)

    def quad_uv(self, p0, p1, p2, p3, mat, rect):
        """Quad with a UV rectangle (u0, v0, u1, v1); p0 = bottom-left as seen
        from the front, counter-clockwise."""
        u0, v0, u1, v1 = rect
        return self.poly([p0, p1, p2, p3], mat, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])

    # -- boxes ----------------------------------------------------------------
    def box(self, x0, x1, y0, y1, z0, z1, mat, bevel=0.0, segs=2, edges="all", profile=0.5):
        x0, x1 = min(x0, x1), max(x0, x1)
        y0, y1 = min(y0, y1), max(y0, y1)
        z0, z1 = min(z0, z1), max(z0, z1)
        v = self.verts([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1),
                        (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)])
        faces = []
        on_floor = abs(y0) < 5e-4  # bottoms resting on the local floor are never seen
        for k, idx in enumerate(((0, 1, 2, 3), (4, 7, 6, 5), (3, 2, 6, 7), (0, 4, 5, 1), (1, 5, 6, 2), (0, 3, 7, 4))):
            if k == 0 and on_floor:
                continue
            f = self.face([v[i] for i in idx], mat)
            faces.append(f)
        if bevel > 0:
            self._bevel(faces, bevel, segs, edges, profile, mat)
        return faces

    def obox(self, c, t, n, ht, hy, hn, mat, bevel=0.0, segs=1, edges="all"):
        """Oriented box: centre c (x,y,z), plan tangent t=(tx,tz), plan normal
        n=(nx,nz), half extents along t, y, n."""
        tx, tz = t
        nx, nz = n
        pts = []
        for (a, b, cc) in ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1),
                           (-1, 1, -1), (1, 1, -1), (1, 1, 1), (-1, 1, 1)):
            pts.append((c[0] + a * ht * tx + cc * hn * nx, c[1] + b * hy, c[2] + a * ht * tz + cc * hn * nz))
        v = self.verts(pts)
        det = (tx * nz - tz * nx)
        order = ((0, 1, 2, 3), (4, 7, 6, 5), (3, 2, 6, 7), (0, 4, 5, 1), (1, 5, 6, 2), (0, 3, 7, 4))
        faces = []
        for idx in order:
            if det < 0:
                idx = idx[::-1]
            faces.append(self.face([v[i] for i in idx], mat))
        if bevel > 0:
            self._bevel(faces, bevel, segs, edges, 0.5, mat)
        return faces

    def _bevel(self, faces, width, segs, edges, profile, mat):
        es = set()
        for f in faces:
            if f is None:
                continue
            for e in f.edges:
                es.add(e)
        sel = []
        for e in es:
            a, b = e.verts[0].co, e.verts[1].co
            d = (b - a)
            vertical = abs(d.z) > 1e-6  # Blender z == glTF y
            if edges == "all":
                sel.append(e)
            elif edges == "vert" and vertical:
                sel.append(e)
            elif edges == "hor" and not vertical:
                sel.append(e)
            elif edges == "top":
                top = max(a.z, b.z)
                zs = [v.co.z for f in faces if f for v in f.verts]
                if not vertical and abs(top - max(zs)) < 1e-6:
                    sel.append(e)
            elif edges == "topvert":
                zs = [v.co.z for f in faces if f for v in f.verts]
                if vertical or abs(max(a.z, b.z) - max(zs)) < 1e-6:
                    sel.append(e)
        if sel:
            bmesh.ops.bevel(self.bm, geom=sel, offset=width, offset_type='OFFSET', segments=segs,
                            profile=profile, affect='EDGES', clamp_overlap=True,
                            material=self.mi(mat))

    # -- sweeps ---------------------------------------------------------------
    def sweep(self, samples, section, mat, closed_path=False, closed_section=False,
              cap=(False, False), u_scale=None, v_mode="y", u_offset=0.0, uv_fn=None):
        """Extrude a (n, y) section along path samples [(x, z, nx, nz, s)]."""
        tile = TILE[mat] if u_scale is None else u_scale
        rings = []
        for (px, pz, nx, nz, s) in samples:
            rings.append(self.verts([(px + n * nx, y, pz + n * nz) for (n, y) in section]))
        # section V coordinates
        vs = []
        acc = 0.0
        for k, (n, y) in enumerate(section):
            if k > 0:
                acc += abs(n - section[k - 1][0])
            vs.append((y + acc) / TILE[mat])
        npath, nsec = len(rings), len(section)
        imax = npath if closed_path else npath - 1
        kmax = nsec if closed_section else nsec - 1
        L_end = None
        faces = []
        for i in range(imax):
            i2 = (i + 1) % npath
            sa = samples[i][4]
            sb = samples[i2][4] if i2 != 0 else samples[-1][4] + _len2(
                (samples[0][0] - samples[-1][0], samples[0][1] - samples[-1][1]))
            if abs(sb - sa) < 1e-7:
                continue
            ua, ub = (sa + u_offset) / tile, (sb + u_offset) / tile
            for k in range(kmax):
                k2 = (k + 1) % nsec
                if abs(section[k][0] - section[k2][0]) < 1e-7 and abs(section[k][1] - section[k2][1]) < 1e-7:
                    continue
                quad = [rings[i][k], rings[i][k2], rings[i2][k2], rings[i2][k]]
                if uv_fn is not None:
                    uvs = uv_fn(sa, sb, k, k2)
                else:
                    vk, vk2 = vs[k], vs[k2] if k2 != 0 else vs[k] + abs(section[k][1] - section[0][1]) / TILE[mat]
                    uvs = [(ua, vk), (ua, vk2), (ub, vk2), (ub, vk)]
                faces.append(self.face(quad, mat, uvs))
        if cap[0]:
            faces.append(self.face(list(reversed(rings[0])), mat))
        if cap[1]:
            faces.append(self.face(list(rings[-1]), mat))
        return rings, faces

    def ring_sweep(self, path, section, mat, **kw):
        """Sweep along a full closed path."""
        return self.sweep(path.full(), section, mat, closed_path=True, **kw)

    def slab(self, path, y0, y1, mat, bevel=0.03, segs=2, top=True, bottom=True, top_mat=None):
        """Extruded closed outline with rounded top/bottom edges and flat caps."""
        sec = _round_edge_section(y0, y1, bevel, segs)
        rings, _ = self.ring_sweep(path, sec, mat)
        if bottom:
            self.face([r[0] for r in rings], mat)
        if top:
            self.face([r[-1] for r in reversed(rings)], top_mat or mat)
        return rings

    def prism(self, path, y0, y1, mat, top=True, bottom=False, top_mat=None):
        rings, _ = self.ring_sweep(path, [(0, y0), (0, y1)], mat)
        if bottom:
            self.face([r[0] for r in rings], mat)
        if top:
            self.face([r[-1] for r in reversed(rings)], top_mat or mat)
        return rings

    # -- lathes ---------------------------------------------------------------
    def lathe(self, profile, cx, cz, mat, seg=16, y0=0.0, phase=0.0, uv=True):
        """Revolve (r, y) points (listed counter-clockwise in an r-right/y-up
        plot for outward normals) around the vertical axis at (cx, cz)."""
        rings = []
        for (r, y) in profile:
            if r < 1e-6:
                rings.append(self.verts([(cx, y + y0, cz)]))
            else:
                rings.append(self.verts([(cx + r * math.cos(phase + 2 * math.pi * j / seg), y + y0,
                                          cz + r * math.sin(phase + 2 * math.pi * j / seg)) for j in range(seg)]))
        rmax = max(r for r, _ in profile) or 1.0
        circ = 2 * math.pi * rmax / TILE[mat]
        acc = [0.0]
        for k in range(1, len(profile)):
            acc.append(acc[-1] + math.hypot(profile[k][0] - profile[k - 1][0], profile[k][1] - profile[k - 1][1]))
        for k in range(len(profile) - 1):
            ra, rb = rings[k], rings[k + 1]
            va, vb = acc[k] / TILE[mat], acc[k + 1] / TILE[mat]
            for j in range(seg):
                j2 = (j + 1) % seg
                ua, ub = circ * j / seg, circ * (j + 1) / seg
                if len(ra) == 1 and len(rb) == 1:
                    continue
                if len(ra) == 1:
                    self.face([ra[0], rb[j2], rb[j]], mat, [(ua, va), (ub, vb), (ua, vb)])
                elif len(rb) == 1:
                    self.face([ra[j], ra[j2], rb[0]], mat, [(ua, va), (ub, va), (ua, vb)])
                else:
                    self.face([ra[j], rb[j], rb[j2], ra[j2]], mat, [(ua, va), (ua, vb), (ub, vb), (ub, va)])
        return rings

    def cylinder(self, cx, cz, r, y0, y1, mat, seg=12, caps=True, bevel=0.0):
        if bevel > 0:
            b = min(bevel, r * 0.4, (y1 - y0) * 0.4)
            prof = [(0, y0), (r - b, y0), (r - b * 0.3, y0 + b * 0.3), (r, y0 + b), (r, y1 - b),
                    (r - b * 0.3, y1 - b * 0.3), (r - b, y1), (0, y1)]
        else:
            prof = [(0, y0), (r, y0), (r, y1), (0, y1)]
        if not caps:
            prof = prof[1:-1]
        return self.lathe(prof, cx, cz, mat, seg)

    def tube(self, pts3, r, mat, seg=8, closed=False):
        """Round tube through 3D points (glTF space)."""
        n = len(pts3)
        if n < 2:
            return
        frames = []
        for i in range(n):
            if closed:
                a, b = pts3[i - 1], pts3[(i + 1) % n]
            else:
                a, b = pts3[max(i - 1, 0)], pts3[min(i + 1, n - 1)]
            t = _norm3((b[0] - a[0], b[1] - a[1], b[2] - a[2]))
            ref = (0, 1, 0) if abs(t[1]) < 0.9 else (1, 0, 0)
            u = _norm3(_cross(t, ref))
            w = _cross(t, u)
            frames.append((t, u, w))
        rings = []
        for i, p in enumerate(pts3):
            t, u, w = frames[i]
            rings.append(self.verts([(p[0] + r * (math.cos(2 * math.pi * j / seg) * u[0] + math.sin(2 * math.pi * j / seg) * w[0]),
                                      p[1] + r * (math.cos(2 * math.pi * j / seg) * u[1] + math.sin(2 * math.pi * j / seg) * w[1]),
                                      p[2] + r * (math.cos(2 * math.pi * j / seg) * u[2] + math.sin(2 * math.pi * j / seg) * w[2]))
                                     for j in range(seg)]))
        imax = n if closed else n - 1
        acc = 0.0
        for i in range(imax):
            i2 = (i + 1) % n
            L = math.dist(pts3[i], pts3[i2])
            for j in range(seg):
                j2 = (j + 1) % seg
                self.face([rings[i][j], rings[i][j2], rings[i2][j2], rings[i2][j]], mat,
                          [(j / seg, acc), (j2 / seg if j2 else 1.0, acc), (j2 / seg if j2 else 1.0, acc + L),
                           (j / seg, acc + L)])
            acc += L
        if not closed:
            self.face(list(reversed(rings[0])), mat)
            self.face(list(rings[-1]), mat)


def newell(pts):
    nx = ny = nz = 0.0
    m = len(pts)
    for i in range(m):
        x0, y0, z0 = pts[i]
        x1, y1, z1 = pts[(i + 1) % m]
        nx += (y0 - y1) * (z0 + z1)
        ny += (z0 - z1) * (x0 + x1)
        nz += (x0 - x1) * (y0 + y1)
    return (nx, ny, nz)


def _round_edge_section(y0, y1, b, segs):
    """Edge profile (n <= 0 inward) for a slab: bottom inner -> rounded nose -> top inner."""
    b = min(b, (y1 - y0) * 0.49)
    if b <= 1e-6:
        return [(0, y0), (0, y1)]
    sec = []
    for k in range(segs + 1):
        a = math.radians(-90 + 90 * k / segs)
        sec.append((-b + b * math.cos(a), y0 + b + b * math.sin(a)))
    for k in range(segs + 1):
        a = math.radians(90 * k / segs)
        sec.append((-b + b * math.cos(a), y1 - b + b * math.sin(a)))
    return sec


def round_edge_section(y0, y1, b, segs=2):
    return _round_edge_section(y0, y1, b, segs)


def _norm3(v):
    L = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1.0
    return (v[0] / L, v[1] / L, v[2] / L)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
