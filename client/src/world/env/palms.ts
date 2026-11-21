import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn,
  abs,
  attribute,
  color,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  positionLocal,
  pow,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  vec3,
} from 'three/tsl';

// Procedural coconut palms: a tapered, gently curved trunk with growth rings,
// and a crown of drooping fronds whose leaflets are cut out in the shader.
// A few variants are generated once and instanced everywhere; wind sways the
// trunk from the base and flutters the fronds toward their tips.

export const wind = uniform(1);

interface Variant {
  trunk: BufferGeometry;
  fronds: BufferGeometry;
  height: number;
}

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** Trunk: rings of vertices along a curved spine, radius tapering upward. */
function trunkGeometry(height: number, lean: number, curve: number, rnd: () => number) {
  const rings = 22;
  const sides = 9;
  const pos: number[] = [];
  const uvs: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  const spine = (t: number) => new Vector3(lean * t * t * height + curve * Math.sin(t * Math.PI) * 0.6, t * height, 0);
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const c = spine(t);
    const radius = (0.26 - 0.1 * t) * (1 + (r % 2 === 0 ? 0.04 : 0)) + (t < 0.06 ? (0.06 - t) * 2.2 : 0);
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      pos.push(c.x + Math.cos(a) * radius, c.y, c.z + Math.sin(a) * radius);
      uvs.push(s / sides, t * height);
      sway.push(t);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < sides; s++) {
      const a = r * (sides + 1) + s;
      const b = a + sides + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('aSway', new BufferAttribute(new Float32Array(sway), 1));
  g.setAttribute('aTip', new BufferAttribute(new Float32Array(sway.length), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  void rnd;
  return { geo: g, top: spine(1) };
}

/** One frond: a strip arching out and drooping, u along it, v across (−1..1). */
function frondGeometry(top: Vector3, yaw: number, rise: number, length: number, droop: number) {
  const segs = 14;
  const pos: number[] = [];
  const uvs: number[] = [];
  const tip: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  const dir = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const side = new Vector3(-dir.z, 0, dir.x);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const s = t * length;
    const out = Math.cos(rise) * s;
    const y = Math.sin(rise) * s - droop * s * s;
    const center = new Vector3().copy(top).addScaledVector(dir, out).setY(top.y + y);
    // Width: narrow at the base, widest a third along, pointed at the tip.
    const w = 1.15 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (1 - Math.pow(t, 2.2)) + 0.05;
    // Leaflets fold up in a shallow V along the rachis.
    for (const v of [-1, 0, 1]) {
      const p = center.clone().addScaledVector(side, v * w);
      p.y += Math.abs(v) * w * 0.28;
      pos.push(p.x, p.y, p.z);
      uvs.push(t, v);
      tip.push(t);
      sway.push(1);
    }
  }
  for (let i = 0; i < segs; i++)
    for (let k = 0; k < 2; k++) {
      const a = i * 3 + k;
      const b = a + 3;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('aTip', new BufferAttribute(new Float32Array(tip), 1));
  g.setAttribute('aSway', new BufferAttribute(new Float32Array(sway), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function variant(seed: number): Variant {
  const rnd = rng(seed);
  const height = 7.5 + rnd() * 5;
  const { geo: trunk, top } = trunkGeometry(height, (rnd() - 0.3) * 0.18, (rnd() - 0.5) * 0.9, rnd);
  const fronds: BufferGeometry[] = [];
  const count = 13 + Math.floor(rnd() * 5);
  for (let i = 0; i < count; i++) {
    const yaw = (i / count) * Math.PI * 2 + rnd() * 0.4;
    const young = i % 4 === 0;
    const rise = young ? 0.9 + rnd() * 0.4 : 0.15 + rnd() * 0.45;
    const length = (young ? 3.2 : 4.2) + rnd() * 1.2;
    fronds.push(frondGeometry(top, yaw, rise, length, young ? 0.06 : 0.12 + rnd() * 0.06));
  }
  return { trunk, fronds: mergeGeometries(fronds), height };
}

/** The shared sway: trunk bends from the base, fronds flutter toward their tips. */
const swayNode = Fn(() => {
  const p = positionLocal.toVar();
  const phase = hash(instanceIndex).mul(6.283);
  const t = time.mul(wind);
  const bend = pow(attribute('aSway', 'float'), float(2)).mul(0.22);
  const gust = sin(t.mul(0.9).add(phase)).mul(0.6).add(sin(t.mul(2.1).add(phase.mul(1.7))).mul(0.25));
  p.x.addAssign(bend.mul(gust));
  p.z.addAssign(bend.mul(gust).mul(0.4));
  const tip = attribute('aTip', 'float');
  const flutter = sin(t.mul(4.5).add(phase).add(tip.mul(6))).mul(tip.mul(tip)).mul(0.12);
  p.y.addAssign(flutter);
  return p;
});

function trunkMaterial() {
  const m = new MeshStandardNodeMaterial({ roughness: 0.95 });
  const v = uv().y;
  const rings = smoothstep(0.35, 0.5, abs(fract(v.mul(2.6)).sub(0.5)));
  const n = mx_noise_float(vec3(uv().x.mul(6), v.mul(3), 0)).mul(0.5).add(0.5);
  const base = mix(vec3(0.36, 0.29, 0.21), vec3(0.55, 0.47, 0.37), n.mul(0.6).add(0.2));
  m.colorNode = base.mul(mix(float(1), float(0.62), rings));
  m.positionNode = swayNode();
  return m;
}

function frondMaterial() {
  const m = new MeshStandardNodeMaterial({ roughness: 0.7, side: DoubleSide, alphaTest: 0.5 });
  const u = uv().x;
  const v = uv().y;
  // Leaflets: slanted stripes off the rachis, cut out with alpha.
  const slant = fract(u.mul(34).add(abs(v).mul(1.6)));
  const leaflet = step(0.28, slant).mul(step(abs(v), float(0.97)));
  const rachis = step(abs(v), float(0.06));
  const ragged = mx_noise_float(vec3(u.mul(40), v.mul(3), 1)).mul(0.5).add(0.5);
  const edge = step(abs(v), float(0.78).add(ragged.mul(0.22)).mul(float(1).sub(pow(u, float(4)).mul(0.6))));
  m.opacityNode = leaflet.mul(edge).max(rachis);
  const green = mix(color(0x2f6b22), color(0x7ea83a), u.mul(0.7).add(abs(v).mul(0.25)));
  const dry = mix(green, vec3(0.62, 0.55, 0.27), smoothstep(0.85, 1, u).mul(0.6));
  m.colorNode = dry.mul(ragged.mul(0.2).add(0.88));
  m.positionNode = swayNode();
  return m;
}

export class Palms {
  readonly group = new Group();
  private readonly variants: Variant[];
  private readonly trunkMat = trunkMaterial();
  private readonly frondMat = frondMaterial();

  constructor(seed = 3) {
    this.group.name = 'palms';
    this.variants = [0, 1, 2, 3].map((i) => variant(seed * 101 + i * 7));
  }

  /** Places palms at the given ground points (variant and turn picked per point; optional heights in metres). */
  plant(points: Vector3[], heights?: number[]) {
    const r = rng(17);
    const byVariant: Matrix4[][] = this.variants.map(() => []);
    points.forEach((p, i) => {
      const v = Math.floor(r() * this.variants.length);
      const jitter = 0.85 + r() * 0.35;
      const s = heights?.[i] ? heights[i] / this.variants[v].height : jitter;
      byVariant[v].push(new Matrix4().compose(p, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), r() * Math.PI * 2), new Vector3(s, s, s)));
    });
    byVariant.forEach((mats, i) => {
      if (!mats.length) return;
      const v = this.variants[i];
      for (const [geo, mat, shadow] of [
        [v.trunk, this.trunkMat, true],
        [v.fronds, this.frondMat, true],
      ] as const) {
        const im = new InstancedMesh(geo, mat, mats.length);
        mats.forEach((m, k) => im.setMatrixAt(k, m));
        im.castShadow = shadow;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    });
  }
}
