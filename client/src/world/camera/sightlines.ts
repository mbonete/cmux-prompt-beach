import { type InstancedMesh, Matrix4, type Mesh, type Object3D, Sphere, Vector3 } from 'three/webgpu';

// Can the camera see someone from here? The close-up camera asks before it
// flies: a parasol, an awning or a palm crown between it and the person means
// another angle. The district is merged into a few huge meshes, so their
// triangles are binned once into a 2 m grid on the ground plane; a sightline
// then only tests the triangles in the cells it crosses (well under a
// millisecond), and palm crowns are tested as spheres.

const CELL = 2;
/** Triangles entirely below this (floors, decks, kerbs) can't hide anyone. */
const MIN_Y = 0.5;

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const e1 = new Vector3();
const e2 = new Vector3();
const pv = new Vector3();
const tv = new Vector3();
const qv = new Vector3();
const dir = new Vector3();
const m4 = new Matrix4();
const sphere = new Sphere();

export class Sightlines {
  private tri = new Float32Array(0);
  private start = new Uint32Array(0);
  private items = new Uint32Array(0);
  private stamp = new Uint32Array(0);
  private visit = 0;
  private crowns: number[] = [];
  private near = 0;
  private nearY = 0;
  private x0 = 0;
  private z0 = 0;
  private nx = 0;
  private nz = 0;

  /** `meshes`: merged static geometry that can block a view. `palms`: groups holding `palms/fronds`. */
  build(meshes: Mesh[], palms: Object3D[]) {
    const tris: number[] = [];
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      const pos = mesh.geometry.attributes.position;
      const idx = mesh.geometry.index;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        const ia = idx ? idx.getX(i) : i;
        const ib = idx ? idx.getX(i + 1) : i + 1;
        const ic = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
        if (Math.max(a.y, b.y, c.y) < MIN_Y) continue;
        tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    }
    this.tri = new Float32Array(tris);
    const count = this.tri.length / 9;

    // Grid over the triangles' footprint.
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < this.tri.length; i += 3) {
      x0 = Math.min(x0, this.tri[i]);
      x1 = Math.max(x1, this.tri[i]);
      z0 = Math.min(z0, this.tri[i + 2]);
      z1 = Math.max(z1, this.tri[i + 2]);
    }
    if (!count) return;
    this.x0 = x0;
    this.z0 = z0;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / CELL) + 1);
    this.nz = Math.max(1, Math.ceil((z1 - z0) / CELL) + 1);
    const cellsOf = (t: number, fn: (cell: number) => void) => {
      const o = t * 9;
      const tx0 = Math.min(this.tri[o], this.tri[o + 3], this.tri[o + 6]);
      const tx1 = Math.max(this.tri[o], this.tri[o + 3], this.tri[o + 6]);
      const tz0 = Math.min(this.tri[o + 2], this.tri[o + 5], this.tri[o + 8]);
      const tz1 = Math.max(this.tri[o + 2], this.tri[o + 5], this.tri[o + 8]);
      for (let cz = Math.floor((tz0 - z0) / CELL); cz <= Math.floor((tz1 - z0) / CELL); cz++)
        for (let cx = Math.floor((tx0 - x0) / CELL); cx <= Math.floor((tx1 - x0) / CELL); cx++) fn(cz * this.nx + cx);
    };
    const counts = new Uint32Array(this.nx * this.nz + 1);
    for (let t = 0; t < count; t++) cellsOf(t, (k) => counts[k + 1]++);
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
    this.start = counts;
    this.items = new Uint32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, -1);
    for (let t = 0; t < count; t++) cellsOf(t, (k) => (this.items[fill[k]++] = t));
    this.stamp = new Uint32Array(count);

    // Palm crowns, as spheres (fronds have gaps; a sightline through the middle is blocked).
    this.crowns = [];
    for (const group of palms) {
      group.traverse((o) => {
        const im = o as InstancedMesh;
        if (!im.isInstancedMesh || im.name !== 'palms/fronds') return;
        if (!im.geometry.boundingSphere) im.geometry.computeBoundingSphere();
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m4);
          sphere.copy(im.geometry.boundingSphere!).applyMatrix4(m4.premultiply(im.matrixWorld));
          this.crowns.push(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius * 0.6);
        }
      });
    }
  }

  get triangles() {
    return this.tri.length / 9;
  }

  /**
   * Is anything between `from` and `to`? Within `spare` metres of `to`, only
   * what is above `to` counts (a parasol over the head does; the person's own
   * chair and table, lower down, don't).
   */
  blocked(from: Vector3, to: Vector3, spare = 0.9): boolean {
    dir.subVectors(to, from);
    const len = dir.length();
    if (len < 1e-3) return false;
    const tMax = len - 0.05;
    this.near = len - spare;
    this.nearY = to.y;
    dir.divideScalar(len);
    for (let i = 0; i < this.crowns.length; i += 4) {
      tv.set(this.crowns[i], this.crowns[i + 1], this.crowns[i + 2]).sub(from);
      const t = tv.dot(dir);
      if (t <= 0 || t >= this.near) continue;
      if (tv.lengthSq() - t * t < this.crowns[i + 3] * this.crowns[i + 3]) return true;
    }
    if (!this.items.length) return false;
    this.visit++;
    // Walk the grid cells under the segment (a little wider than the line itself).
    const steps = Math.ceil(tMax / (CELL * 0.5)) + 1;
    let last = -1;
    for (let s = 0; s <= steps; s++) {
      const t = (tMax * s) / steps;
      const px = from.x + dir.x * t;
      const pz = from.z + dir.z * t;
      const cx = Math.floor((px - this.x0) / CELL);
      const cz = Math.floor((pz - this.z0) / CELL);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= this.nx || z >= this.nz) continue;
          const k = z * this.nx + x;
          if (k === last) continue;
          for (let j = this.start[k]; j < this.start[k + 1]; j++) {
            const tri = this.items[j];
            if (this.stamp[tri] === this.visit) continue;
            this.stamp[tri] = this.visit;
            if (this.hit(tri, from, tMax)) return true;
          }
        }
      last = cz * this.nx + cx;
    }
    return false;
  }

  /** Möller–Trumbore against one triangle, for 0 < t < tMax along `dir`. */
  private hit(tri: number, from: Vector3, tMax: number): boolean {
    const o = tri * 9;
    const T = this.tri;
    a.set(T[o], T[o + 1], T[o + 2]);
    e1.set(T[o + 3] - a.x, T[o + 4] - a.y, T[o + 5] - a.z);
    e2.set(T[o + 6] - a.x, T[o + 7] - a.y, T[o + 8] - a.z);
    pv.crossVectors(dir, e2);
    const det = e1.dot(pv);
    if (Math.abs(det) < 1e-9) return false;
    const inv = 1 / det;
    tv.subVectors(from, a);
    const u = tv.dot(pv) * inv;
    if (u < 0 || u > 1) return false;
    qv.crossVectors(tv, e1);
    const v = dir.dot(qv) * inv;
    if (v < 0 || u + v > 1) return false;
    const t = e2.dot(qv) * inv;
    if (t <= 0.05 || t >= tMax) return false;
    // Close to the person: only what is above them hides them.
    return t < this.near || from.y + dir.y * t > this.nearY;
  }
}
