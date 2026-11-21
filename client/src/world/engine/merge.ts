import {
  BufferAttribute,
  type BufferGeometry,
  CanvasTexture,
  type Color,
  LinearMipmapLinearFilter,
  type Material,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  NoColorSpace,
  type Object3D,
  type Texture,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toNodeMaterial } from './materials';

// Static merging for the district. A plot building is used once or twice, so
// instancing it saves nothing, while each of its ~13 materials still costs a
// draw (twice, with shadows). Here every building is baked into world space and
// merged across buildings by material, so the whole district draws once per
// material. The per-building baked AO maps go into one atlas.

export interface Placement {
  matrix: Matrix4;
  /** Pastel for tintable materials (vertex colour). */
  tint?: Color;
  /** Slot index written to `aSlot`, for per-plot lookups in shaders. */
  slot?: number;
}

export interface MergeSource {
  /** glTF scene of one building type. */
  template: Object3D;
  placements: Placement[];
}

export interface MergedPart {
  mesh: Mesh;
  /** Material name from the kit (stucco, interior, bulb…). */
  name: string;
}

interface Bucket {
  name: string;
  source: MeshStandardMaterial;
  geos: BufferGeometry[];
}

/** Material identity, ignoring the AO map (which goes into the atlas). */
function signature(m: MeshStandardMaterial): string {
  // glTF textures are named after their image (stucco_albedo, awning_teal_albedo…),
  // which is the same across files while the Texture objects are not.
  const t = (x: Texture | null) => (x ? x.name || x.uuid : '-');
  return [
    m.name,
    t(m.map),
    t(m.normalMap),
    t(m.emissiveMap),
    t(m.roughnessMap),
    m.color.getHexString(),
    m.emissive.getHexString(),
    m.roughness.toFixed(3),
    m.metalness.toFixed(3),
    m.transparent ? `t${m.opacity}` : 'o',
    m.side,
    m.aoMap ? 'ao' : 'noao',
  ].join('|');
}

/**
 * Packs each source's AO map (glTF occlusion, on UV set 1) into one atlas.
 * Returns the atlas and, per source, the cell it went into.
 */
export function aoAtlas(sources: MergeSource[], cell = 512, size = 2048): { texture: CanvasTexture | null; cells: Map<MergeSource, { u: number; v: number; s: number }> } {
  const cells = new Map<MergeSource, { u: number; v: number; s: number }>();
  const per = Math.floor(size / cell);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { texture: null, cells };
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  let i = 0;
  for (const src of sources) {
    let ao: Texture | null = null;
    src.template.traverse((o) => {
      const m = (o as Mesh).material as MeshStandardMaterial | undefined;
      if (!ao && m?.aoMap?.image) ao = m.aoMap;
    });
    if (!ao || i >= per * per) continue;
    const cx = (i % per) * cell;
    const cy = Math.floor(i / per) * cell;
    ctx.drawImage((ao as Texture).image as CanvasImageSource, cx, cy, cell, cell);
    cells.set(src, { u: cx / size, v: cy / size, s: cell / size });
    i++;
  }
  const texture = new CanvasTexture(canvas);
  texture.flipY = false; // glTF convention: UV (0,0) is the image's top left
  texture.colorSpace = NoColorSpace;
  texture.channel = 1;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return { texture, cells };
}

const KEEP = ['position', 'normal', 'uv', 'uv1'];

/** Bakes every placement of every source into world space and merges by material. */
export function mergeStatic(
  sources: MergeSource[],
  opts: { tintable: Set<string>; atlas: ReturnType<typeof aoAtlas> },
): { parts: MergedPart[]; materials: Map<string, Material[]> } {
  const buckets = new Map<string, Bucket>();
  const world = new Matrix4();
  for (const src of sources) {
    src.template.updateMatrixWorld(true);
    const cell = opts.atlas.cells.get(src);
    src.template.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as MeshStandardMaterial;
      const key = signature(mat);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { name: mat.name, source: mat, geos: [] }));
      for (const p of src.placements) {
        world.multiplyMatrices(p.matrix, mesh.matrixWorld);
        const g = mesh.geometry.clone();
        for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name);
        g.morphAttributes = {};
        g.applyMatrix4(world);
        const n = g.attributes.position.count;
        if (g.attributes.uv1 && cell) {
          // Into this building's cell of the AO atlas.
          const uv1 = g.attributes.uv1;
          const out = new Float32Array(n * 2);
          for (let k = 0; k < n; k++) {
            out[k * 2] = cell.u + uv1.getX(k) * cell.s;
            out[k * 2 + 1] = cell.v + uv1.getY(k) * cell.s;
          }
          g.setAttribute('uv1', new BufferAttribute(out, 2));
        }
        if (opts.tintable.has(mat.name)) {
          const c = new Float32Array(n * 3);
          const tint = p.tint;
          for (let k = 0; k < n; k++) {
            c[k * 3] = tint?.r ?? 1;
            c[k * 3 + 1] = tint?.g ?? 1;
            c[k * 3 + 2] = tint?.b ?? 1;
          }
          g.setAttribute('color', new BufferAttribute(c, 3));
        }
        g.setAttribute('aSlot', new BufferAttribute(new Float32Array(n).fill(p.slot ?? 0), 1));
        b.geos.push(g);
      }
    });
  }

  const parts: MergedPart[] = [];
  const materials = new Map<string, Material[]>();
  for (const b of buckets.values()) {
    // Every geometry in a bucket must carry the same attributes.
    const names = new Set(b.geos.flatMap((g) => Object.keys(g.attributes)));
    for (const g of b.geos) {
      for (const name of names) {
        if (g.attributes[name]) continue;
        const size = name === 'color' || name === 'normal' || name === 'position' ? 3 : name === 'aSlot' ? 1 : 2;
        g.setAttribute(name, new BufferAttribute(new Float32Array(g.attributes.position.count * size).fill(name === 'color' ? 1 : 0), size));
      }
    }
    const indexed = b.geos.every((g) => g.index);
    const geos = indexed ? b.geos : b.geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(geos, false);
    for (const g of b.geos) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const mat = toNodeMaterial(b.source);
    if (b.source.aoMap && opts.atlas.texture) mat.aoMap = opts.atlas.texture;
    if (opts.tintable.has(b.name)) {
      mat.vertexColors = true;
      mat.color.set(0xffffff);
    }
    const mesh = new Mesh(merged, mat);
    mesh.name = `merged/${b.name}`;
    mesh.matrixAutoUpdate = false;
    parts.push({ mesh, name: b.name });
    if (!materials.has(b.name)) materials.set(b.name, []);
    materials.get(b.name)!.push(mat);
  }
  return { parts, materials };
}
