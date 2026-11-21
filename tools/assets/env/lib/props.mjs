// Props: source models -> .gltf + .bin + external WebP, quantized, pivoted,
// with LODs. Driven entirely by config.props (see README.md for the fields).
import path from 'node:path';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, getBounds, joinPrimitives, prune, quantize, transformPrimitive, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { abs, blender, cleanDir, ENV_DIR, ensureDir, fileBytes, rel, round } from './util.mjs';
import { downsampleNormal } from './textures.mjs';

export const ALLOWED_EXTENSIONS = new Set([
  'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength',
  'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_ior',
  'EXT_texture_webp', // needed to reference WebP images at all (glTF core allows only PNG/JPEG)
]);

const DEFAULTS = { texture: 1024, pivot: 'base', lod0MaxTris: 15000, lod1Above: 10000, lod1Ratio: 0.3 };
const QUALITY = { baseColor: 85, normal: 90, orm: 85, emissive: 85 };

// --------------------------------------------------------------------------- math (column-major 4x4)
const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const translation = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scaling = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
function rotationY(deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

// --------------------------------------------------------------------------- helpers
const triCount = (prim) => (prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount()) / 3;
const meshTris = (mesh) => mesh.listPrimitives().reduce((a, p) => a + triCount(p), 0);

function primBounds(prims) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (const p of prims) {
    const pos = p.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[k]); max[k] = Math.max(max[k], v[k]); }
    }
  }
  return { min, max };
}

function pivotOf(b, mode) {
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  if (mode === 'origin-y') return [cx, 0, cz];
  if (mode === 'wall') return [cx, b.min[1], b.min[2]];
  return [cx, b.min[1], cz];
}

/** Deep-copies a primitive including its accessors so it can be transformed on its own. */
function clonePrim(doc, prim) {
  const out = prim.clone();
  for (const sem of prim.listSemantics()) out.setAttribute(sem, prim.getAttribute(sem).clone());
  if (prim.getIndices()) out.setIndices(prim.getIndices().clone());
  for (const t of out.listTargets()) out.removeTarget(t);
  return out;
}

function ensureIndices(doc, prim) {
  if (prim.getIndices()) return;
  const n = prim.getAttribute('POSITION').getCount();
  const idx = new Uint32Array(n).map((_, i) => i);
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(doc.getRoot().listBuffers()[0]));
}

/**
 * Simplifies a primitive in place to `ratio` of its triangles with
 * meshoptimizer's attribute-aware simplifier (normals and UVs weigh in, so UV
 * seams and shading are kept). The error bound is relaxed step by step until
 * the target is met; `prune` lets small disconnected parts disappear (LOD1).
 */
function simplifyPrim(doc, prim, ratio, { prune: pruneParts = false, maxError = 0.05 } = {}) {
  ensureIndices(doc, prim);
  weldPrimitive(prim);
  const pos = new Float32Array(prim.getAttribute('POSITION').getArray());
  const n = pos.length / 3;
  const nor = prim.getAttribute('NORMAL')?.getArray();
  const uv = prim.getAttribute('TEXCOORD_0')?.getArray();
  const stride = 5;
  const attrs = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    if (nor) { attrs[i * 5] = nor[i * 3]; attrs[i * 5 + 1] = nor[i * 3 + 1]; attrs[i * 5 + 2] = nor[i * 3 + 2]; }
    if (uv) { attrs[i * 5 + 3] = uv[i * 2]; attrs[i * 5 + 4] = uv[i * 2 + 1]; }
  }
  const weights = [nor ? 0.5 : 0, nor ? 0.5 : 0, nor ? 0.5 : 0, uv ? 1 : 0, uv ? 1 : 0];
  const src = new Uint32Array(prim.getIndices().getArray());
  const target = Math.max(3, Math.floor((src.length * ratio) / 3) * 3);
  const flags = pruneParts ? ['Prune'] : [];
  let best = src, err = 0;
  for (const e of [0.002, 0.005, 0.01, 0.02, 0.035, maxError]) {
    if (e > maxError) break;
    const [dst, de] = MeshoptSimplifier.simplifyWithAttributes(src, pos, 3, attrs, stride, weights, null, target, e, flags);
    best = dst; err = de;
    if (dst.length <= target * 1.05) break;
  }
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(best)).setBuffer(prim.getAttribute('POSITION').getBuffer()));
  compactPrimitive(prim);
  return err;
}

function attrSignature(prim) {
  return prim.listSemantics().sort().join(',') + '|' + prim.getMode();
}

/** Joins primitives that share a material and attribute layout into one each. */
function joinByMaterial(prims) {
  const groups = new Map();
  for (const p of prims) {
    const key = (p.getMaterial()?.getName() ?? '') + '#' + attrSignature(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const joined = joinPrimitives(list);
    for (const p of list) p.dispose();
    out.push(joined);
  }
  return out;
}

function imageKind(texture, doc) {
  const kinds = new Set();
  for (const mat of doc.getRoot().listMaterials()) {
    if (mat.getBaseColorTexture() === texture) kinds.add('baseColor');
    if (mat.getNormalTexture() === texture) kinds.add('normal');
    if (mat.getMetallicRoughnessTexture() === texture || mat.getOcclusionTexture() === texture) kinds.add('orm');
    if (mat.getEmissiveTexture() === texture) kinds.add('emissive');
  }
  return kinds;
}

function outImageName(id, uri, fallback, used) {
  let base = path.basename(uri || fallback).replace(/\.(jpe?g|png|webp)$/i, '').replace(/_(1|2|4|8)k$/i, '');
  base = base.replace(/_nor_gl$/, '_normal').replace(/_arm$/, '_orm').replace(/_diff$/, '_albedo')
    .replace(/_emission$/, '_emissive').replace(/_opacity$/, '_albedo_alpha');
  if (!base.startsWith(id)) base = `${id}_${base}`;
  let name = base, k = 2;
  while (used.has(name)) name = `${base}_${k++}`;
  used.add(name);
  return `${name}.webp`;
}

// --------------------------------------------------------------------------- non-glTF sources
async function toGltfSource(prop, buildDir) {
  const src = abs(prop.src);
  if (/\.(gltf|glb)$/i.test(src)) return src;
  const out = path.join(buildDir, 'converted', `${prop.id}.glb`);
  await ensureDir(path.dirname(out));
  await blender(path.join(ENV_DIR, 'blender', 'convert.py'), [src, out]);
  return out;
}

// --------------------------------------------------------------------------- main
export async function buildProps(cfg, { only } = {}) {
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const outRoot = abs(path.join(cfg.out, 'props'));
  const buildDir = abs(cfg.build);
  const results = {};
  for (const propCfg of cfg.props) {
    if (only?.length && !only.includes(propCfg.id)) continue;
    const prop = { ...DEFAULTS, ...propCfg };
    console.log(`[props] ${prop.id}`);
    const doc = await io.read(await toGltfSource(prop, buildDir));
    doc.setLogger(new Logger(Logger.Verbosity.WARN));
    const root = doc.getRoot();
    const notes = [];
    const buffer = root.listBuffers()[0];

    // 1. materials: drop disallowed extensions, apply config fixes, ORM, screen
    for (const ext of root.listExtensionsUsed()) {
      if (!ALLOWED_EXTENSIONS.has(ext.extensionName)) {
        notes.push(`removed ${ext.extensionName}`);
        ext.dispose();
      }
    }
    const matCfg = prop.materials ?? {};
    for (const mat of root.listMaterials()) {
      const src = mat.getName();
      const mc = matCfg[src] ?? {};
      const mr = mat.getMetallicRoughnessTexture();
      if (mr && !mat.getOcclusionTexture() && /_arm[_.]/i.test(mr.getURI())) {
        mat.setOcclusionTexture(mr);
        mat.getOcclusionTextureInfo().setTexCoord(0);
      }
      if (mc.alphaFromBaseColorTexture) {
        const tex = mat.getBaseColorTexture();
        const { data, info } = await sharp(Buffer.from(tex.getImage())).greyscale().raw().toBuffer({ resolveWithObject: true });
        const rgba = Buffer.alloc(info.width * info.height * 4, 255);
        for (let i = 0; i < info.width * info.height; i++) rgba[i * 4 + 3] = data[i * info.channels];
        const png = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
        tex.setImage(new Uint8Array(png)).setMimeType('image/png');
        mat.setAlphaCutoff(0.5);
      }
      if (mc.dropTextures) {
        for (const slot of mc.dropTextures) {
          if (slot === 'baseColor') mat.setBaseColorTexture(null);
          if (slot === 'metallicRoughness') { mat.setMetallicRoughnessTexture(null); mat.setOcclusionTexture(null); }
          if (slot === 'normal') mat.setNormalTexture(null);
        }
      }
      if (mc.baseColor) mat.setBaseColorFactor(mc.baseColor);
      if (mc.roughness !== undefined) mat.setRoughnessFactor(mc.roughness);
      if (mc.metallic !== undefined) mat.setMetallicFactor(mc.metallic);
      if (mc.alphaMode) mat.setAlphaMode(mc.alphaMode);
      // MASK/BLEND without any alpha source (JPEG base colour, opaque factor) is opaque: avoid alpha-test cost
      const bc = mat.getBaseColorTexture();
      const hasAlpha = (bc && bc.getMimeType() !== 'image/jpeg') || mat.getBaseColorFactor()[3] < 1;
      if (mat.getAlphaMode() !== 'OPAQUE' && !hasAlpha) {
        notes.push(`${src}: alphaMode ${mat.getAlphaMode()} -> OPAQUE (no alpha in the source)`);
        mat.setAlphaMode('OPAQUE');
      }
      if (mc.rename) mat.setName(mc.rename);
    }

    // 2. bake every mesh instance into world space (with the prop's global transform)
    const G = mul(rotationY(prop.rotateY ?? 0), scaling(prop.scale ?? 1));
    const scene = root.listScenes()[0];
    const items = []; // { prim, names: [node and ancestor names] }
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const names = [];
      for (let n = node; n; n = n.getParentNode()) names.push(n.getName());
      const M = mul(G, node.getWorldMatrix());
      for (const prim of mesh.listPrimitives()) {
        const p = clonePrim(doc, prim);
        transformPrimitive(p, M);
        for (const sem of prop.dropAttributes ?? []) p.setAttribute(sem, null);
        items.push({ prim: p, names });
      }
    });
    for (const n of root.listNodes()) n.dispose();
    for (const m of root.listMeshes()) {
      for (const p of m.listPrimitives()) p.dispose();
      m.dispose();
    }
    for (const s of root.listScenes()) s.dispose();

    // laptop-style screens: planar UVs 0..1 facing +Z (u -> +X, v = 0 at the top)
    if (prop.screen) {
      const target = matCfg[prop.screen.material]?.rename ?? prop.screen.material;
      const scr = items.filter((it) => it.prim.getMaterial()?.getName() === target).map((it) => it.prim);
      if (!scr.length) throw new Error(`${prop.id}: screen material ${target} not found`);
      if (prop.screen.planarUV) {
        const b = primBounds(scr);
        for (const p of scr) {
          const pos = p.getAttribute('POSITION');
          const uv = new Float32Array(pos.getCount() * 2);
          const v = [0, 0, 0];
          for (let i = 0; i < pos.getCount(); i++) {
            pos.getElement(i, v);
            uv[i * 2] = (v[0] - b.min[0]) / (b.max[0] - b.min[0]);
            uv[i * 2 + 1] = (b.max[1] - v[1]) / (b.max[1] - b.min[1]);
          }
          p.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
        }
      }
    }

    // 3. group into variants and parts
    const match = (it, list) => list.some((name) => it.names.includes(name));
    const variantDefs = prop.variants ? Object.entries(prop.variants) : [[null, null]];
    const groups = variantDefs.map(([vname, list]) => ({ name: vname, items: list ? items.filter((it) => match(it, list)) : items }));
    const assigned = new Set(groups.flatMap((g) => g.items));
    const orphans = items.filter((it) => !assigned.has(it));
    if (orphans.length) throw new Error(`${prop.id}: ${orphans.length} primitives belong to no variant (${[...new Set(orphans.map((o) => o.names[0]))].join(', ')})`);

    const allPrims = items.map((it) => it.prim);
    const pivotItems = (list) => (prop.pivotFrom ? list.filter((it) => match(it, prop.pivotFrom)) : list);
    const globalPivot = pivotOf(primBounds(pivotItems(items).map((it) => it.prim)), prop.pivot);

    const outScene = doc.createScene(prop.id);
    const rootNode = doc.createNode(prop.id);
    outScene.addChild(rootNode);
    const report = { variants: {} };

    for (const g of groups) {
      const gp = g.name ? pivotOf(primBounds(pivotItems(g.items).map((it) => it.prim)), prop.pivot) : globalPivot;
      const T = translation(gp.map((v) => -v));
      for (const it of g.items) transformPrimitive(it.prim, T);
      const holder = g.name ? doc.createNode(g.name).setTranslation(gp.map((v, k) => round(v - globalPivot[k], 5))) : rootNode;
      if (g.name) rootNode.addChild(holder);

      // parts (lod0 children) or one merged mesh
      const partDefs = prop.parts ? Object.entries(prop.parts) : [[null, null]];
      const parts = partDefs.map(([pname, list]) => ({ name: pname, prims: (list ? g.items.filter((it) => match(it, list)) : g.items).map((it) => it.prim) }));
      const srcTris = parts.reduce((a, p) => a + p.prims.reduce((b, q) => b + triCount(q), 0), 0);

      // LOD0 budget
      let lod0Err = null;
      if (srcTris > prop.lod0MaxTris) {
        const ratio = (prop.lod0MaxTris * 0.97) / srcTris;
        lod0Err = 0;
        for (const part of parts) for (const p of part.prims) lod0Err = Math.max(lod0Err, simplifyPrim(doc, p, ratio, { maxError: 0.01 }));
        notes.push(`${g.name ?? prop.id}: LOD0 simplified ${srcTris} -> ${parts.reduce((a, p) => a + p.prims.reduce((b, q) => b + triCount(q), 0), 0)} tris (max error ${round(lod0Err * 100, 2)}% of radius)`);
      }

      const lodNodes = {};
      const makeLod = (lodName, partPrims) => {
        const node = doc.createNode(lodName);
        holder.addChild(node);
        const named = partPrims.filter((p) => p.name);
        if (named.length) {
          for (const part of partPrims) {
            const mesh = doc.createMesh(`${lodName}_${part.name}`);
            for (const p of joinByMaterial(part.prims)) mesh.addPrimitive(p);
            node.addChild(doc.createNode(part.name).setMesh(mesh));
          }
        } else {
          const mesh = doc.createMesh(lodName);
          for (const p of joinByMaterial(partPrims.flatMap((pp) => pp.prims))) mesh.addPrimitive(p);
          node.setMesh(mesh);
        }
        lodNodes[lodName] = node;
        return node;
      };
      const lod0Tris = parts.reduce((a, p) => a + p.prims.reduce((b, q) => b + triCount(q), 0), 0);
      let lod1Parts = null;
      if (prop.lod1 === true || (prop.lod1 !== false && lod0Tris > prop.lod1Above)) {
        let lod1Err = 0;
        lod1Parts = parts.map((part) => ({
          name: part.name,
          prims: part.prims.map((p) => {
            const c = clonePrim(doc, p);
            lod1Err = Math.max(lod1Err, simplifyPrim(doc, c, prop.lod1Ratio, { prune: true, maxError: 0.05 }));
            return c;
          }),
        }));
        report.variants[g.name ?? prop.id] = { lod1Error: round(lod1Err, 5) };
      }
      makeLod('lod0', parts);
      if (lod1Parts) makeLod('lod1', lod1Parts);
      const vr = (report.variants[g.name ?? prop.id] ??= {});
      vr.sourceTris = srcTris;
      for (const [ln, node] of Object.entries(lodNodes)) {
        let t = 0;
        node.traverse((n) => { if (n.getMesh()) t += meshTris(n.getMesh()); });
        vr[`${ln}Tris`] = t;
      }
      if (lod0Err !== null) vr.lod0Error = round(lod0Err, 5);
      if (g.name) vr.offset = holder.getTranslation();
    }
    for (const p of allPrims) if (!p.isDisposed() && !p.listParents().some((x) => x.propertyType === 'Mesh')) p.dispose();
    root.setDefaultScene(outScene);

    // 4. textures -> WebP at the prop's size
    const webp = doc.createExtension(EXTTextureWebP).setRequired(true);
    void webp;
    const used = new Set();
    for (const tex of root.listTextures()) {
      const kinds = imageKind(tex, doc);
      if (!kinds.size) continue;
      const kind = kinds.has('normal') ? 'normal' : kinds.has('orm') ? 'orm' : kinds.has('emissive') ? 'emissive' : 'baseColor';
      const meta = await sharp(Buffer.from(tex.getImage())).metadata();
      const size = Math.min(prop.texture, meta.width);
      let pipeline;
      if (kind === 'normal' && meta.width > size) {
        const { data, info } = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const small = downsampleNormal({ data, width: info.width, height: info.height, channels: 3 }, size);
        pipeline = sharp(small.data, { raw: { width: small.width, height: small.height, channels: 3 } });
      } else {
        pipeline = sharp(Buffer.from(tex.getImage()));
        if (meta.width > size) pipeline = pipeline.resize(size, Math.round((size * meta.height) / meta.width), { kernel: 'lanczos3' });
        const keepAlpha = kind === 'baseColor' && meta.hasAlpha;
        if (!keepAlpha) pipeline = pipeline.removeAlpha();
      }
      const buf = await pipeline.webp({ quality: QUALITY[kind], alphaQuality: 90, effort: 6, smartSubsample: true }).toBuffer();
      const owner = root.listMaterials().find((m) => [m.getBaseColorTexture(), m.getNormalTexture(), m.getMetallicRoughnessTexture(), m.getEmissiveTexture()].includes(tex));
      const fallback = `${owner?.getName() ?? 'texture'}_${{ baseColor: 'albedo', normal: 'normal', orm: 'orm', emissive: 'emissive' }[kind]}`;
      tex.setImage(new Uint8Array(buf)).setMimeType('image/webp').setURI(outImageName(prop.id, tex.getURI(), fallback, used));
    }

    // 5. cleanup, quantize, single external buffer
    await doc.transform(prune({ keepLeaves: false }), dedup());
    await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8 }));
    const buffers = root.listBuffers();
    const main = buffers[0] ?? doc.createBuffer();
    for (const acc of root.listAccessors()) acc.setBuffer(main);
    for (const b of buffers.slice(1)) b.dispose();
    main.setURI(`${prop.id}.bin`);

    const outDir = await cleanDir(path.join(outRoot, prop.id));
    const gltfPath = path.join(outDir, `${prop.id}.gltf`);
    await io.write(gltfPath, doc);

    // 6. report
    const files = [{ file: rel(gltfPath), bytes: await fileBytes(gltfPath) }, { file: rel(path.join(outDir, `${prop.id}.bin`)), bytes: await fileBytes(path.join(outDir, `${prop.id}.bin`)) }];
    for (const tex of root.listTextures()) {
      const f = path.join(outDir, tex.getURI());
      const meta = await sharp(f).metadata();
      files.push({ file: rel(f), bytes: await fileBytes(f), width: meta.width, height: meta.height });
    }
    const variantBounds = {};
    for (const child of rootNode.listChildren()) {
      if (child.getName() === 'lod0' || child.getName() === 'lod1') continue;
      const lod0 = child.listChildren().find((c) => c.getName() === 'lod0');
      const saved = child.getTranslation();
      child.setTranslation([0, 0, 0]);
      const b = getBounds(lod0 ?? child);
      child.setTranslation(saved);
      variantBounds[child.getName()] = { min: b.min.map((v) => round(v, 3)), max: b.max.map((v) => round(v, 3)) };
    }
    const lod0Root = rootNode.listChildren().find((c) => c.getName() === 'lod0');
    const whole = getBounds(outScene);
    for (const [vn, b] of Object.entries(variantBounds)) report.variants[vn].bounds = b;
    if (lod0Root) report.variants[prop.id].bounds = (() => { const b = getBounds(lod0Root); return { min: b.min.map((v) => round(v, 3)), max: b.max.map((v) => round(v, 3)) }; })();
    results[prop.id] = {
      source: prop.src,
      credit: prop.credit,
      gltf: rel(gltfPath),
      files,
      bytes: files.reduce((a, f) => a + f.bytes, 0),
      textureSize: prop.texture,
      pivot: prop.pivot,
      scale: prop.scale ?? 1,
      rotateY: prop.rotateY ?? 0,
      front: '+Z',
      bounds: { min: whole.min.map((v) => round(v, 3)), max: whole.max.map((v) => round(v, 3)) },
      structure: prop.variants
        ? `${prop.id} > {${Object.keys(prop.variants).join(', ')}} > lod0 [, lod1]`
        : prop.parts ? `${prop.id} > lod0 > {${Object.keys(prop.parts).join(', ')}} [, lod1 > ...]` : `${prop.id} > lod0 [, lod1]`,
      variants: report.variants,
      materials: root.listMaterials().map((m) => ({
        name: m.getName(), alphaMode: m.getAlphaMode(), doubleSided: m.getDoubleSided(),
        textures: Object.fromEntries([['baseColor', m.getBaseColorTexture()], ['normal', m.getNormalTexture()], ['orm', m.getMetallicRoughnessTexture()], ['emissive', m.getEmissiveTexture()]].filter(([, t]) => t).map(([k, t]) => [k, t.getURI()])),
        extensions: m.listExtensions().map((e) => e.extensionName),
      })),
      extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName),
      notes: [prop.notes, ...notes].filter(Boolean),
    };
  }
  return results;
}
