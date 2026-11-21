// Z-fighting in 3D assets: overlapping triangles of different parts that lie
// in the same plane and face the same way. However precise the depth buffer,
// two surfaces at exactly the same depth can't be told apart: which one wins
// flips from pixel to pixel as the camera moves (a parasol base on a terrace, a
// kerb flush with the floor, trim flush with a wall). Temporal AA used to blend
// the fight into a steady mix; without it, it flickers.
//
// findCoplanar(doc) lists the fighting pairs; separateCoplanar(doc) lifts the
// smaller part of each pair (the cap, the trim, the kerb, the pane) LIFT metres
// off the surface under it. Every asset pipeline runs it before writing.

export const PLANE_EPS = 0.0002; // 0.2 mm: closer than this along the normal fights
const OVERLAP_EPS = 0.002; // 2 mm of real overlap (edge contacts aren't fights)
export const LIFT = 0.003; // 3 mm: well beyond what a reversed float depth buffer resolves
/** Triangles of every primitive in the document, in world space. */
function collect(doc) {
  const tris = [];
  const prims = [];
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue;
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const idx = prim.getIndices();
        const id = prims.length;
        prims.push({ prim, node, part: `${node.getName() || mesh.getName()}`, mat: prim.getMaterial()?.getName() || '?', area: 0 });
        const n = idx ? idx.getCount() : pos.getCount();
        const v = [0, 0, 0];
        const at = (i) => {
          pos.getElement(i, v);
          return [
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
          ];
        };
        for (let i = 0; i + 2 < n; i += 3) {
          const ia = idx ? idx.getScalar(i) : i;
          const ib = idx ? idx.getScalar(i + 1) : i + 1;
          const ic = idx ? idx.getScalar(i + 2) : i + 2;
          const a = at(ia);
          const b = at(ib);
          const c = at(ic);
          const cr = cross(sub(b, a), sub(c, a));
          const len = Math.hypot(...cr);
          if (len < 1e-10) continue;
          const nrm = cr.map((x) => x / len);
          prims[id].area += len / 2;
          tris.push({ prim: id, a, b, c, n: nrm, d: dot(nrm, a), verts: [ia, ib, ic] });
        }
      }
    });
  }
  return { tris, prims };
}

/** The fighting pairs: { tris, prims, pairs: [i, j][] }. */
export function findCoplanar(doc) {
  const { tris, prims } = collect(doc);
  const buckets = new Map();
  const keyOf = (t) => {
    const s = t.n[0] < -1e-6 || (Math.abs(t.n[0]) <= 1e-6 && (t.n[1] < -1e-6 || (Math.abs(t.n[1]) <= 1e-6 && t.n[2] < 0))) ? -1 : 1;
    const q = t.n.map((x) => Math.round(x * s * 200));
    return `${q.join(',')}|${Math.round((t.d * s) / PLANE_EPS)}`;
  };
  tris.forEach((t, i) => {
    const k = keyOf(t);
    (buckets.get(k) || buckets.set(k, []).get(k)).push(i);
  });
  const pairs = [];
  const seen = new Set();
  for (const [k, list] of buckets) {
    const [nq, dq] = k.split('|');
    const near = [...list, ...(buckets.get(`${nq}|${Number(dq) + 1}`) || [])];
    for (let x = 0; x < list.length; x++) {
      for (let y = 0; y < near.length; y++) {
        const i = list[x];
        const j = near[y];
        if (i >= j && y < list.length) continue;
        const A = tris[i];
        const B = tris[j];
        if (A.prim === B.prim) continue;
        // Two levels of detail of one object coincide by design; only one is ever drawn.
        const la = /^lod(\d)$/.exec(prims[A.prim].part);
        const lb = /^lod(\d)$/.exec(prims[B.prim].part);
        if (la && lb && la[1] !== lb[1]) continue;
        // Facing opposite ways (a base's underside on a floor) can't fight: one is seen from behind.
        if (dot(A.n, B.n) < 0.99) continue;
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (overlap2D(A, B) > OVERLAP_EPS) pairs.push([i, j]);
      }
    }
  }
  return { tris, prims, pairs };
}

/**
 * Lifts the smaller part of each fighting pair off the other, repeating until
 * none are left (a lift can land a surface on another one). Returns the first
 * pass's findings and how many passes it took.
 */
export function separateCoplanar(doc, maxPasses = 4) {
  let first = null;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const r = separateOnce(doc);
    first ??= r;
    if (!r.pairs.length) return { ...first, passes: pass };
  }
  return { ...first, passes: maxPasses };
}

function separateOnce(doc) {
  const found = findCoplanar(doc);
  const { tris, prims, pairs } = found;
  const lift = new Map(); // prim -> Map(vertex -> world normal)
  for (const [i, j] of pairs) {
    const A = tris[i];
    const B = tris[j];
    const top = prims[A.prim].area <= prims[B.prim].area ? A : B;
    const e = lift.get(top.prim) || lift.set(top.prim, new Map()).get(top.prim);
    for (const vi of top.verts) e.set(vi, top.n);
  }
  for (const [pid, verts] of lift) {
    const { prim, node } = prims[pid];
    const pos = prim.getAttribute('POSITION');
    const inv = invert3(node.getWorldMatrix());
    const v = [0, 0, 0];
    for (const [vi, n] of verts) {
      pos.getElement(vi, v);
      const ln = mul3(inv, n);
      const l = Math.hypot(...ln) || 1;
      pos.setElement(vi, [v[0] + (ln[0] / l) * LIFT, v[1] + (ln[1] / l) * LIFT, v[2] + (ln[2] / l) * LIFT]);
    }
  }
  return { ...found, lifted: lift.size };
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Overlap depth (metres) of two coplanar triangles, by separating axes in their plane; <= 0 if apart. */
function overlap2D(A, B) {
  const n = A.n;
  const u0 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(n, u0);
  const ul = Math.hypot(...u);
  const U = u.map((x) => x / ul);
  const V = cross(n, U);
  const p = (q) => [dot(q, U), dot(q, V)];
  const ta = [p(A.a), p(A.b), p(A.c)];
  const tb = [p(B.a), p(B.b), p(B.c)];
  let depth = Infinity;
  for (const t of [ta, tb]) {
    for (let k = 0; k < 3; k++) {
      const [x1, y1] = t[k];
      const [x2, y2] = t[(k + 1) % 3];
      const ax = [y1 - y2, x2 - x1];
      const al = Math.hypot(...ax);
      if (al < 1e-12) continue;
      const proj = (tri) => tri.map(([x, y]) => (x * ax[0] + y * ax[1]) / al);
      const pa = proj(ta);
      const pb = proj(tb);
      const o = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
      if (o <= 0) return o;
      depth = Math.min(depth, o);
    }
  }
  return depth;
}

function invert3(m) {
  // Upper 3x3 of a column-major 4x4, inverted (for carrying normals into local space).
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
function mul3(M, v) {
  // M (row-major 3x3) times v: carries a world-space displacement into the node's local space.
  return [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
}
