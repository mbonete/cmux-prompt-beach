"""Small mesh builder for the street kit, on top of bmesh.

Every coordinate is written in glTF space (X right, Y up, Z forward: the
front of a prop or vehicle faces +Z). Vertices are converted to Blender
space (x, -z, y) on creation, a pure rotation, so winding is preserved and
the glTF exporter (+Y up) gives the glTF coordinates back.

Faces are oriented explicitly: every primitive builds its faces in one
consistent order and then checks one reference face against a known outward
direction, flipping the whole primitive if needed.
"""
import math
from contextlib import contextmanager

import bmesh
import bpy
from mathutils import Matrix, Vector

# Metres covered by one texture repeat, per material (box-projected UVs).
TILE = {"wood": 1.6, "towel": 1.0}


def B(p):
    return Vector((p[0], -p[2], p[1]))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def interp(keys, x):
    """Piecewise-linear interpolation over sorted (x, value) keys."""
    if x <= keys[0][0]:
        return keys[0][1]
    for (x0, v0), (x1, v1) in zip(keys, keys[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0) if x1 > x0 else 0.0
            return v0 + (v1 - v0) * t
    return keys[-1][1]


def _newell(cos):
    n = Vector((0.0, 0.0, 0.0))
    k = len(cos)
    for i in range(k):
        a, b = cos[i], cos[(i + 1) % k]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n


class MB:
    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.lock = self.bm.faces.layers.int.new("uvlock")
        self.mats = []
        self.stack = [Matrix.Identity(4)]

    # -- frames -------------------------------------------------------------
    @contextmanager
    def at(self, x=0.0, y=0.0, z=0.0, yaw=0.0, pitch=0.0, roll=0.0, s=1.0):
        """Local frame: scale, roll about Z, pitch about X, yaw about Y (deg),
        then translate. yaw turns local +Z toward (sin yaw, 0, cos yaw)."""
        sc = s if isinstance(s, (tuple, list)) else (s, s, s)
        m = (Matrix.Translation((x, y, z))
             @ Matrix.Rotation(math.radians(yaw), 4, "Y")
             @ Matrix.Rotation(math.radians(pitch), 4, "X")
             @ Matrix.Rotation(math.radians(roll), 4, "Z")
             @ Matrix.Diagonal((sc[0], sc[1], sc[2], 1.0)))
        self.stack.append(self.stack[-1] @ m)
        try:
            yield
        finally:
            self.stack.pop()

    def tp(self, p):
        return self.stack[-1] @ Vector(p)

    def tdir(self, d):
        return (self.stack[-1].to_3x3() @ Vector(d))

    def mi(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    # -- raw ----------------------------------------------------------------
    def vert(self, p):
        return self.bm.verts.new(B(self.tp(p)))

    def face(self, vs, mat, uvs=None):
        if len({id(v) for v in vs}) < 3:
            return None
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        f.material_index = self.mi(mat)
        f.smooth = True
        if uvs is not None:
            for l, uv in zip(f.loops, uvs):
                l[self.uv].uv = uv
            f[self.lock] = 1
        return f

    def orient(self, faces, ref, outward_gl):
        """Flip every face in `faces` if face `ref` does not face outward_gl
        (a direction in the current local frame)."""
        if ref is None:
            return
        n = _newell([v.co for v in ref.verts])
        if n.dot(B(self.tdir(outward_gl))) < 0:
            for f in faces:
                if f is not None:
                    f.normal_flip()

    def poly(self, pts, mat, facing=None, uvs=None):
        """Polygon from local points; facing (local dir) fixes the winding."""
        f = self.face([self.vert(p) for p in pts], mat, uvs)
        if f is not None and facing is not None:
            self.orient([f], f, facing)
        return f

    def quad2(self, pts, mat, facing=None, uvs=None):
        """Double-sided-looking card: one face (use a doubleSided material)."""
        return self.poly(pts, mat, facing, uvs)

    # -- primitives ---------------------------------------------------------
    def box(self, x0, x1, y0, y1, z0, z1, mat, bevel=0.0, segs=1, bottom=True, mats=None):
        """Axis-aligned box in the local frame. mats: optional dict of
        per-side materials (top, bottom, front(+z), back, left(-x), right)."""
        x0, x1 = min(x0, x1), max(x0, x1)
        y0, y1 = min(y0, y1), max(y0, y1)
        z0, z1 = min(z0, z1), max(z0, z1)
        P = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1),
             (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
        v = [self.vert(p) for p in P]
        sides = {
            "bottom": ((0, 1, 2, 3), (0, -1, 0)),
            "top": ((4, 7, 6, 5), (0, 1, 0)),
            "front": ((3, 2, 6, 7), (0, 0, 1)),
            "back": ((0, 4, 5, 1), (0, 0, -1)),
            "right": ((1, 5, 6, 2), (1, 0, 0)),
            "left": ((0, 3, 7, 4), (-1, 0, 0)),
        }
        faces = []
        for name, (idx, out) in sides.items():
            if name == "bottom" and not bottom:
                continue
            m = (mats or {}).get(name, mat)
            f = self.face([v[i] for i in idx], m)
            if f is not None:
                self.orient([f], f, out)
                faces.append(f)
        if bevel > 0:
            edges = {e for f in faces for e in f.edges}
            bmesh.ops.bevel(self.bm, geom=list(edges), offset=bevel, offset_type="OFFSET", segments=segs,
                            profile=0.5, affect="EDGES", clamp_overlap=True, material=self.mi(mat))
        return faces

    def beam(self, p0, p1, w, h, mat, up=(0, 1, 0), bevel=0.0):
        """Box of width w (side) and height h (along `up`) between two points."""
        a, b = Vector(p0), Vector(p1)
        d = b - a
        L = d.length
        if L < 1e-6:
            return []
        f = d / L
        u = Vector(up)
        side = f.cross(u)
        if side.length < 1e-6:
            side = f.cross(Vector((1, 0, 0)))
        side.normalize()
        u = side.cross(f).normalized()
        M = Matrix((
            (side.x, u.x, f.x, a.x),
            (side.y, u.y, f.y, a.y),
            (side.z, u.z, f.z, a.z),
            (0, 0, 0, 1),
        ))
        self.stack.append(self.stack[-1] @ M)
        try:
            return self.box(-w / 2, w / 2, -h / 2, h / 2, 0, L, mat, bevel=bevel)
        finally:
            self.stack.pop()

    def lathe(self, prof, segs, mat, mats=None, a0=0.0, a1=360.0, smooth_shade=True):
        """Revolve a profile [(r, y)] about local +Y. r == 0 ends become fans.
        mats: optional per-segment list. Partial sweeps (a0..a1) stay open."""
        full = abs((a1 - a0) - 360.0) < 1e-6
        n = segs if full else segs + 1
        angs = [math.radians(a0 + (a1 - a0) * k / segs) for k in range(n)]
        rings = []
        for (r, y) in prof:
            if r <= 1e-6:
                rings.append([self.vert((0, y, 0))])
            else:
                rings.append([self.vert((r * math.sin(a), y, r * math.cos(a))) for a in angs])
        faces = []
        ref, ref_out = None, None
        for i in range(len(prof) - 1):
            A, Bv = rings[i], rings[i + 1]
            m = mats[i] if mats else mat
            (r0, y0), (r1, y1) = prof[i], prof[i + 1]
            for k in range(segs):
                k2 = (k + 1) % n
                if len(A) == 1 and len(Bv) == 1:
                    continue
                if len(A) == 1:
                    vs = [A[0], Bv[k], Bv[k2]]
                elif len(Bv) == 1:
                    vs = [A[k], A[k2], Bv[0]]
                else:
                    vs = [A[k], A[k2], Bv[k2], Bv[k]]
                f = self.face(vs, m)
                if f is not None:
                    f.smooth = smooth_shade
                    faces.append(f)
                    if ref is None and (abs(y1 - y0) > 1e-5 or abs(r1 - r0) > 1e-5):
                        am = (angs[k] + (angs[k2] if k2 != 0 else angs[0] + 2 * math.pi)) / 2
                        dy, dr = y1 - y0, r1 - r0
                        ln = math.hypot(dy, dr)
                        nr, ny = dy / ln, -dr / ln
                        ref, ref_out = f, (nr * math.sin(am), ny, nr * math.cos(am))
        if ref is not None:
            self.orient(faces, ref, ref_out)
        return faces

    def cyl(self, r, y0, y1, segs, mat, cap0=True, cap1=True, r1=None, smooth_shade=True):
        r1 = r if r1 is None else r1
        prof = []
        if cap0:
            prof.append((0, y0))
        prof += [(r, y0), (r1, y1)]
        if cap1:
            prof.append((0, y1))
        faces = self.lathe(prof, segs, mat, smooth_shade=smooth_shade)
        return faces

    def sphere(self, r, segs, rings, mat, cy=0.0, squash=1.0, a_lo=-90.0, a_hi=90.0):
        prof = []
        for i in range(rings + 1):
            a = math.radians(a_lo + (a_hi - a_lo) * i / rings)
            rr = r * math.cos(a)
            prof.append((0.0 if abs(rr) < 1e-6 else rr, cy + r * math.sin(a) * squash))
        return self.lathe(prof, segs, mat)

    def loft(self, rings, matfn, closed=True, cap0=None, cap1=None, outward=None):
        """Connect rings (lists of local points, same length) with quads.
        matfn(i, k) -> material of the quad between ring i..i+1 and point
        k..k+1. cap0/cap1: material of an end cap (or None). outward: local
        point the surface faces away from (defaults to the centroid)."""
        V = [[self.vert(p) for p in ring] for ring in rings]
        m = len(rings[0])
        faces = []
        best, best_d, best_out = None, -1.0, None
        cen = Vector((0, 0, 0))
        cnt = 0
        for ring in rings:
            for p in ring:
                cen += Vector(p)
                cnt += 1
        cen /= max(1, cnt)
        if outward is not None:
            cen = Vector(outward)
        for i in range(len(rings) - 1):
            kmax = m if closed else m - 1
            for k in range(kmax):
                k2 = (k + 1) % m
                mat = matfn(i, k)
                if mat is None:
                    continue
                f = self.face([V[i][k], V[i][k2], V[i + 1][k2], V[i + 1][k]], mat)
                if f is None:
                    continue
                faces.append(f)
                c = (Vector(rings[i][k]) + Vector(rings[i][k2]) + Vector(rings[i + 1][k2]) + Vector(rings[i + 1][k])) / 4
                d = (c - cen).length
                if d > best_d:
                    best, best_d, best_out = f, d, (c - cen)
        if best is not None:
            self.orient(faces, best, best_out)
        cs = []
        if cap0:
            f = self.face(list(V[0]), cap0)
            if f is not None:
                self.orient([f], f, tuple(-self._ring_dir(rings, 0)))
                cs.append(f)
        if cap1:
            f = self.face(list(V[-1]), cap1)
            if f is not None:
                self.orient([f], f, tuple(self._ring_dir(rings, -1)))
                cs.append(f)
        return faces + cs

    @staticmethod
    def _ring_dir(rings, idx):
        c0 = sum((Vector(p) for p in rings[0]), Vector()) / len(rings[0])
        c1 = sum((Vector(p) for p in rings[-1]), Vector()) / len(rings[-1])
        return (c1 - c0).normalized()

    def tube(self, pts, r, segs, mat, cap=True):
        """Round tube along a polyline of local points."""
        P = [Vector(p) for p in pts]
        rings = []
        for i, p in enumerate(P):
            if i == 0:
                t = P[1] - P[0]
            elif i == len(P) - 1:
                t = P[-1] - P[-2]
            else:
                t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
            t.normalize()
            ref = Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))
            u = t.cross(ref).normalized()
            w = t.cross(u).normalized()
            rings.append([tuple(p + (u * math.cos(2 * math.pi * k / segs) + w * math.sin(2 * math.pi * k / segs)) * r)
                          for k in range(segs)])
        faces = []
        V = [[self.vert(p) for p in ring] for ring in rings]
        for i in range(len(rings) - 1):
            for k in range(segs):
                k2 = (k + 1) % segs
                f = self.face([V[i][k], V[i][k2], V[i + 1][k2], V[i + 1][k]], mat)
                if f is not None:
                    faces.append(f)
        if faces:
            c = (Vector(rings[0][0]) + Vector(rings[0][1]) + Vector(rings[1][1]) + Vector(rings[1][0])) / 4
            self.orient(faces, faces[0], tuple(c - P[0] - (P[1] - P[0]) * 0.5))
        if cap:
            for idx, sgn in ((0, -1), (-1, 1)):
                f = self.face(list(V[idx]), mat)
                if f is not None:
                    d = (P[-1] - P[-2]) if idx == -1 else (P[0] - P[1])
                    self.orient([f], f, tuple(d))
        return faces

    def prism(self, outline, bands, mat_fn=None, top=None, bottom=None):
        """Extrude a closed (x, z) outline through height bands [(y0, y1, mat)].
        mat_fn(seg_mid_xz, band_index, mat) may override a face's material.
        top/bottom: cap materials."""
        cx = sum(p[0] for p in outline) / len(outline)
        cz = sum(p[1] for p in outline) / len(outline)
        ys = [bands[0][0]] + [b[1] for b in bands]
        V = [[self.vert((x, y, z)) for (x, z) in outline] for y in ys]
        n = len(outline)
        faces = []
        for bi, (y0, y1, mat) in enumerate(bands):
            for k in range(n):
                k2 = (k + 1) % n
                mid = ((outline[k][0] + outline[k2][0]) / 2, (outline[k][1] + outline[k2][1]) / 2)
                m = mat_fn(mid, bi, mat) if mat_fn else mat
                f = self.face([V[bi][k], V[bi][k2], V[bi + 1][k2], V[bi + 1][k]], m)
                if f is not None:
                    self.orient([f], f, (mid[0] - cx, 0, mid[1] - cz))
                    faces.append(f)
        if top:
            f = self.face(list(V[-1]), top)
            if f is not None:
                self.orient([f], f, (0, 1, 0))
                faces.append(f)
        if bottom:
            f = self.face(list(V[0]), bottom)
            if f is not None:
                self.orient([f], f, (0, -1, 0))
                faces.append(f)
        return faces

    def slab(self, outline, y0, y1, mat, top_mat=None):
        return self.prism(outline, [(y0, y1, mat)], top=top_mat or mat, bottom=mat)


def rrect(x0, x1, z0, z1, rb=0.0, rf=0.0, seg=6):
    """Rounded rectangle outline in (x, z); rb = back corners (z0), rf = front (z1)."""
    pts = []

    def arc(cx, cz, r, a0, a1):
        if r <= 1e-6:
            pts.append((cx, cz))
            return
        for k in range(seg + 1):
            a = math.radians(a0 + (a1 - a0) * k / seg)
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    arc(x1 - rb, z0 + rb, rb, -90, 0) if rb > 0 else pts.append((x1, z0))
    arc(x1 - rf, z1 - rf, rf, 0, 90) if rf > 0 else pts.append((x1, z1))
    arc(x0 + rf, z1 - rf, rf, 90, 180) if rf > 0 else pts.append((x0, z1))
    arc(x0 + rb, z0 + rb, rb, 180, 270) if rb > 0 else pts.append((x0, z0))
    clean = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 1e-5:
            clean.append(p)
    if math.hypot(clean[0][0] - clean[-1][0], clean[0][1] - clean[-1][1]) < 1e-5:
        clean.pop()
    return clean


def offset_outline(pts, d):
    """Offset a convex closed outline outward by d (mitred)."""
    n = len(pts)
    out = []
    # orientation
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    s = 1.0 if area > 0 else -1.0
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        def nrm(a, b):
            dx, dz = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dz) or 1.0
            return (s * dz / L, -s * dx / L)
        n1, n2 = nrm(p0, p1), nrm(p1, p2)
        f = 1.0 + n1[0] * n2[0] + n1[1] * n2[1]
        m = ((n1[0] + n2[0]) / f, (n1[1] + n2[1]) / f) if f > 1e-4 else n1
        out.append((p1[0] + m[0] * d, p1[1] + m[1] * d))
    return out


# ---------------------------------------------------------------------------
# finishing
# ---------------------------------------------------------------------------
def _box_uv(mb):
    bm, uv, lock = mb.bm, mb.uv, mb.lock
    for f in bm.faces:
        if f[lock]:
            continue
        t = TILE.get(mb.mats[f.material_index], 1.0)
        n = f.normal
        gx, gy, gz = n.x, n.z, -n.y
        ax, ay, az = abs(gx), abs(gy), abs(gz)
        for l in f.loops:
            co = l.vert.co
            x, y, z = co.x, co.z, -co.y
            if ay >= ax and ay >= az:
                u, v = x, -z
            elif ax >= az:
                u, v = (-z if gx > 0 else z), y
            else:
                u, v = (x if gz > 0 else -x), y
            l[uv].uv = (u / t, v / t)


def finish(mb, name, sharp_deg=40.0, merge=True):
    """bmesh -> mesh object: weld, UV, triangulate, sharp edges by angle."""
    bm = mb.bm
    if merge:
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bad = [f for f in bm.faces if f.calc_area() < 1e-10]
    if bad:
        bmesh.ops.delete(bm, geom=bad, context="FACES")
    bm.normal_update()
    _box_uv(mb)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="BEAUTY")
    lim = math.radians(sharp_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            a = e.calc_face_angle(0.0)
            f0, f1 = e.link_faces
            if a > lim or not (f0.smooth and f1.smooth):
                e.smooth = False
            elif f0.material_index != f1.material_index and a > math.radians(15):
                e.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mb.mats:
        mat = bpy.data.materials.get(m) or bpy.data.materials.new(m)
        me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)
