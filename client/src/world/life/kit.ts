import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  Matrix4,
  type Mesh,
  type MeshStandardMaterial,
  MeshStandardNodeMaterial,
  type Object3D,
  type UniformNode,
} from 'three/webgpu';
import { attribute, color, float, instancedBufferAttribute, mix, texture, uniform, uv, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadGLTF, loadJSON } from '../engine/assets';
import { toNodeMaterial } from '../engine/materials';

// The street kit (tools/assets/street → public/assets/street). Each asset is
// merged into as few draw calls as possible: every untextured surface goes
// into one "uber" geometry that carries its PBR values per vertex (base
// colour, roughness, metalness, emission and whether the instance tint
// applies), so a car or a lamp is one instanced draw. Textured surfaces
// (wood, towels) keep their own material and draw.

const BASE = '/assets/street/';

export interface StreetAsset {
  kind: string;
  tris: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  materials: string[];
  tintable: string[];
  emissive: string[];
  nodes: { name: string; pivot: [number, number, number] }[];
  empties: { name: string; position: [number, number, number]; radius?: number }[];
  extras: Record<string, number>;
}

/** Shared emission levels: street lamps, headlights, tail lights (0 = off). */
export interface Levels {
  lamp: UniformNode<'float', number>;
  head: UniformNode<'float', number>;
  tail: UniformNode<'float', number>;
}

export interface KitPart {
  geometry: BufferGeometry;
  /** null: the per-vertex uber material; otherwise the textured source material. */
  source: MeshStandardMaterial | null;
  tintable: boolean;
  double: boolean;
}

export interface KitModel {
  id: string;
  info: StreetAsset;
  parts: KitPart[];
  /** Child nodes (helicopter rotors): parts in node space and the node's rest transform. */
  nodes: { name: string; parts: KitPart[]; rest: Matrix4 }[];
}

const EMIT_SLOT: Record<string, number> = { bulb: 0, headlight: 1, taillight: 2 };

export class StreetKit {
  assets: Record<string, StreetAsset> = {};
  readonly levels: Levels = { lamp: uniform(0), head: uniform(0.15), tail: uniform(0.25) };
  private readonly models = new Map<string, Promise<KitModel>>();

  async load() {
    const m = await loadJSON<{ assets: Record<string, StreetAsset> }>(`${BASE}manifest.json`);
    this.assets = m.assets;
  }

  has(id: string) {
    return !!this.assets[id];
  }

  model(id: string): Promise<KitModel> {
    let p = this.models.get(id);
    if (!p) {
      p = loadGLTF(`${BASE}${id}.gltf`).then((g) => build(id, this.assets[id], g.scene));
      this.models.set(id, p);
    }
    return p;
  }
}

function build(id: string, info: StreetAsset, scene: Object3D): KitModel {
  scene.updateMatrixWorld(true);
  const root = scene.children.length === 1 && !(scene.children[0] as Mesh).isMesh ? scene.children[0] : scene;
  const nodeNames = new Set(info.nodes.map((n) => n.name));
  const rootInv = root.matrixWorld.clone().invert();
  const main: Mesh[] = [];
  const nodes: { name: string; obj: Object3D; meshes: Mesh[] }[] = [];
  const walk = (o: Object3D, bucket: Mesh[], inNode: boolean) => {
    for (const c of o.children) {
      if (!inNode && nodeNames.has(c.name)) {
        const entry = { name: c.name, obj: c, meshes: [] as Mesh[] };
        nodes.push(entry);
        if ((c as Mesh).isMesh) entry.meshes.push(c as Mesh);
        walk(c, entry.meshes, true);
        continue;
      }
      if ((c as Mesh).isMesh) bucket.push(c as Mesh);
      walk(c, bucket, inNode);
    }
  };
  walk(root, main, false);
  const tintable = new Set(info.tintable);
  return {
    id,
    info,
    parts: merge(main, rootInv, tintable),
    nodes: nodes.map((n) => {
      const rest = rootInv.clone().multiply(n.obj.matrixWorld);
      const inv = n.obj.matrixWorld.clone().invert();
      return { name: n.name, parts: merge(n.meshes, inv, tintable), rest };
    }),
  };
}

function merge(meshes: Mesh[], toLocal: Matrix4, tintable: Set<string>): KitPart[] {
  const uber: BufferGeometry[] = [];
  let uberDouble = false;
  const textured = new Map<MeshStandardMaterial, BufferGeometry[]>();
  const m4 = new Matrix4();
  for (const mesh of meshes) {
    const mat = mesh.material as MeshStandardMaterial;
    const g = mesh.geometry.clone();
    g.applyMatrix4(m4.multiplyMatrices(toLocal, mesh.matrixWorld));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2));
    if (!g.index) {
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new BufferAttribute(idx, 1));
    }
    if (mat.map) {
      const list = textured.get(mat) ?? [];
      list.push(g);
      textured.set(mat, list);
      continue;
    }
    const base = mat.color;
    const emit = mat.emissive.clone().multiplyScalar(mat.emissiveIntensity ?? 1);
    const slot = EMIT_SLOT[mat.name] ?? -1;
    const fill = (size: number, v: number[]) => {
      const a = new Float32Array(n * size);
      for (let i = 0; i < n; i++) a.set(v, i * size);
      return new BufferAttribute(a, size);
    };
    g.setAttribute('aBase', fill(3, [base.r, base.g, base.b]));
    g.setAttribute('aPbr', fill(2, [mat.roughness, mat.metalness]));
    g.setAttribute('aEmit', fill(3, slot >= 0 ? [emit.r, emit.g, emit.b] : [0, 0, 0]));
    g.setAttribute('aEmitW', fill(3, [slot === 0 ? 1 : 0, slot === 1 ? 1 : 0, slot === 2 ? 1 : 0]));
    g.setAttribute('aTint', fill(1, [tintable.has(mat.name) ? 1 : 0]));
    if (mat.side === DoubleSide) uberDouble = true;
    uber.push(g);
  }
  const parts: KitPart[] = [];
  if (uber.length) parts.push({ geometry: mergeGeometries(uber, false)!, source: null, tintable: true, double: uberDouble });
  for (const [mat, list] of textured) {
    parts.push({ geometry: mergeGeometries(list, false)!, source: mat, tintable: tintable.has(mat.name), double: mat.side === DoubleSide });
  }
  return parts;
}

/**
 * WebGPU allows 8 vertex buffers per pipeline: pack the per-vertex material
 * values into one interleaved buffer (base rgb, tint flag, roughness,
 * metalness, emission rgb, emission slot weights).
 */
const LAYOUT: [string, number, number][] = [
  ['aBase', 3, 0],
  ['aTint', 1, 3],
  ['aPbr', 2, 4],
  ['aEmit', 3, 6],
  ['aEmitW', 3, 9],
];
const STRIDE = 12;

function interleave(g: BufferGeometry): BufferGeometry {
  const n = g.attributes.position.count;
  const data = new Float32Array(n * STRIDE);
  for (const [name, size, off] of LAYOUT) {
    const a = g.getAttribute(name) as BufferAttribute;
    for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) data[i * STRIDE + off + c] = a.array[i * size + c];
    g.deleteAttribute(name);
  }
  const buf = new InterleavedBuffer(data, STRIDE);
  for (const [name, size, off] of LAYOUT) g.setAttribute(name, new InterleavedBufferAttribute(buf, size, off));
  return g;
}

type AnyNode = ReturnType<typeof float>;

function uberMaterial(levels: Levels, tint: InterleavedBufferAttribute, lit: InterleavedBufferAttribute, double: boolean) {
  const m = new MeshStandardNodeMaterial({ side: double ? DoubleSide : FrontSide });
  const base = attribute('aBase', 'vec3') as unknown as AnyNode;
  const iTint = instancedBufferAttribute(tint, 'vec3') as unknown as AnyNode;
  const iLit = instancedBufferAttribute(lit, 'float') as unknown as AnyNode;
  m.colorNode = mix(base, base.mul(iTint), attribute('aTint', 'float') as unknown as AnyNode);
  const pbr = attribute('aPbr', 'vec2') as unknown as { x: AnyNode; y: AnyNode };
  m.roughnessNode = pbr.x;
  m.metalnessNode = pbr.y;
  const w = attribute('aEmitW', 'vec3') as unknown as { x: AnyNode; y: AnyNode; z: AnyNode };
  const level = w.x.mul(levels.lamp).add(w.y.mul(levels.head)).add(w.z.mul(levels.tail));
  m.emissiveNode = (attribute('aEmit', 'vec3') as unknown as AnyNode).mul(level).mul(iLit);
  return m;
}

function texturedMaterial(src: MeshStandardMaterial, tint: InterleavedBufferAttribute, tintable: boolean, double: boolean, baked: boolean) {
  const m = toNodeMaterial(src);
  m.side = double ? DoubleSide : FrontSide;
  if (baked) {
    // Static batches carry their tint per vertex.
    m.vertexColors = true;
  } else if (tintable && src.map) {
    const iTint = instancedBufferAttribute(tint, 'vec3') as unknown as AnyNode;
    m.colorNode = vec3(texture(src.map, uv()).rgb).mul(color(src.color)).mul(iTint);
  }
  return m;
}

const white = new Color(1, 1, 1);
const zero = new Matrix4().makeScale(0, 0, 0);

/**
 * Instances of one kit model: one InstancedMesh per part, all sharing one
 * instance-matrix buffer, plus a per-instance tint and light switch.
 */
export class Fleet {
  readonly meshes: InstancedMesh[] = [];
  readonly matrices: InstancedBufferAttribute;
  /** Per instance: tint rgb and a light switch, interleaved in one buffer. */
  private readonly inst: InstancedInterleavedBuffer;
  private readonly tints: InterleavedBufferAttribute;
  private readonly lits: InterleavedBufferAttribute;
  private dirtyTint = false;

  constructor(
    parts: KitPart[],
    readonly capacity: number,
    levels: Levels,
    opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {},
  ) {
    this.matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    this.inst = new InstancedInterleavedBuffer(new Float32Array(capacity * 4).fill(1), 4);
    this.tints = new InterleavedBufferAttribute(this.inst, 3, 0);
    this.lits = new InterleavedBufferAttribute(this.inst, 1, 3);
    for (const p of parts) {
      const mat: Material = p.source
        ? texturedMaterial(p.source, this.tints, p.tintable, p.double, !!p.geometry.getAttribute('color'))
        : uberMaterial(levels, this.tints, this.lits, p.double);
      const geo = p.source ? p.geometry : interleave(p.geometry.clone());
      const im = new InstancedMesh(geo, mat, capacity);
      im.instanceMatrix = this.matrices;
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = opts.castShadow ?? true;
      im.receiveShadow = opts.receiveShadow ?? true;
      im.name = opts.name ?? 'life';
      this.meshes.push(im);
    }
  }

  addTo(parent: Object3D) {
    for (const m of this.meshes) parent.add(m);
  }

  set count(n: number) {
    for (const m of this.meshes) m.count = Math.min(n, this.capacity);
  }

  get count() {
    return this.meshes[0]?.count ?? 0;
  }

  setMatrix(i: number, m: Matrix4) {
    m.toArray(this.matrices.array as Float32Array, i * 16);
  }

  hide(i: number) {
    zero.toArray(this.matrices.array as Float32Array, i * 16);
  }

  setTint(i: number, c: Color = white) {
    c.toArray(this.inst.array as Float32Array, i * 4);
    this.dirtyTint = true;
  }

  setLit(i: number, v: number) {
    (this.inst.array as Float32Array)[i * 4 + 3] = v;
    this.dirtyTint = true;
  }

  /** Uploads what changed this frame. */
  commit(matrices = true) {
    if (matrices) this.matrices.needsUpdate = true;
    if (this.dirtyTint) {
      this.inst.needsUpdate = true;
      this.dirtyTint = false;
    }
  }

  set visible(v: boolean) {
    for (const m of this.meshes) m.visible = v;
  }
}

/**
 * Merges many static placements of kit models into one Fleet of a single
 * instance: one draw for every untextured surface plus one per textured
 * material, whatever the number of lamps or umbrellas. Tints are baked per
 * vertex. Items are ordered by key so a density cut is just a shorter draw
 * range.
 */
export class StaticBatch {
  private readonly items: { parts: KitPart[]; m: Matrix4; tint: Color | null; key: number }[] = [];
  private ends: { key: number; counts: number[] }[] = [];
  fleet: Fleet | null = null;

  add(parts: KitPart[], m: Matrix4, tint: Color | null | undefined, key = -1) {
    this.items.push({ parts, m: m.clone(), tint: tint ?? null, key });
  }

  build(levels: Levels, opts: { castShadow?: boolean; name?: string } = {}): Fleet | null {
    if (!this.items.length) return null;
    this.items.sort((a, b) => a.key - b.key);
    const groups = new Map<string, { geos: BufferGeometry[]; part: KitPart; count: number }>();
    const order: string[] = [];
    for (const it of this.items) {
      for (const p of it.parts) {
        const id = p.source ? p.source.uuid : 'uber';
        let g = groups.get(id);
        if (!g) {
          groups.set(id, (g = { geos: [], part: p, count: 0 }));
          order.push(id);
        }
        const geo = p.geometry.clone().applyMatrix4(it.m);
        const n = geo.attributes.position.count;
        if (!p.source) {
          const base = geo.getAttribute('aBase') as BufferAttribute;
          const flag = geo.getAttribute('aTint') as BufferAttribute;
          if (it.tint) {
            for (let i = 0; i < n; i++) {
              if (flag.getX(i) < 0.5) continue;
              base.setXYZ(i, base.getX(i) * it.tint.r, base.getY(i) * it.tint.g, base.getZ(i) * it.tint.b);
            }
          }
          for (let i = 0; i < n; i++) flag.setX(i, 0);
        } else {
          const c = new Float32Array(n * 3);
          const t = p.tintable && it.tint ? it.tint : white;
          for (let i = 0; i < n; i++) c.set([t.r, t.g, t.b], i * 3);
          geo.setAttribute('color', new BufferAttribute(c, 3));
        }
        g.geos.push(geo);
        g.count += geo.index!.count;
      }
      this.ends.push({ key: it.key, counts: order.map((id) => groups.get(id)!.count) });
    }
    const parts: KitPart[] = order.map((id) => {
      const g = groups.get(id)!;
      return { geometry: mergeGeometries(g.geos, false)!, source: g.part.source, tintable: false, double: g.part.double };
    });
    const fleet = new Fleet(parts, 1, levels, opts);
    fleet.setMatrix(0, new Matrix4());
    fleet.count = 1;
    fleet.commit();
    this.fleet = fleet;
    return fleet;
  }

  /** Draws only the items whose key is below `keep`. */
  limit(keep: number) {
    if (!this.fleet) return;
    let last: number[] | null = null;
    for (const e of this.ends) {
      if (e.key >= keep) break;
      last = e.counts;
    }
    this.fleet.meshes.forEach((m, i) => m.geometry.setDrawRange(0, last ? (last[i] ?? 0) : 0));
  }
}
