// Post-process one Blender-exported avatar into the shipped glTF:
//  PBR materials with WebP textures (EXT_texture_webp), LOD1 via meshoptimizer
//  simplification (no new vertices, so skin weights and UVs stay exact), mesh
//  quantization (KHR_mesh_quantization) and vertex-cache reordering.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder, simplifyPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { cleanNodeTransforms, writeGltf } from './anims_post.mjs';

export const LOD1_TARGET = 2500;

// material look per role (validated in the preview renders)
export const MATERIAL = {
  body: { roughness: 1, alpha: 'OPAQUE' },
  head: { roughness: 1, alpha: 'OPAQUE' },
  // hair cards + eyelashes: alpha-tested, two-sided, mostly matte (isotropic GGX on
  // cards reads as grey plastic sheets below ~0.75)
  alpha: { roughness: 0.8, alpha: 'MASK', cutoff: 0.4, doubleSided: true },
};

function triCount(prim) {
  const idx = prim.getIndices();
  return idx ? idx.getCount() / 3 : prim.getAttribute('POSITION').getCount() / 3;
}

/**
 * @param {string} rawGltf   Blender export (geometry + skin + named placeholder materials)
 * @param {string} outDir    public/assets/characters/<Id>
 * @param {Record<string, Record<string, Buffer>>} tex  role -> { color, normal, orm } WebP buffers
 */
export async function postAvatar(id, rawGltf, outDir, tex) {
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(rawGltf);
  const root = doc.getRoot();
  cleanNodeTransforms(doc);
  const webpExt = doc.createExtension(EXTTextureWebP).setRequired(true);
  void webpExt;

  // ---- materials + textures
  const makeTex = (role, kind, buffer) =>
    doc.createTexture(`${role}_${kind}`)
      .setImage(buffer)
      .setMimeType('image/webp')
      .setURI(`textures/${role}_${kind}.webp`);
  const alphaMaterials = [];
  for (const mat of root.listMaterials()) {
    const role = mat.getName();
    const spec = MATERIAL[role];
    const t = tex[role];
    if (!spec || !t) throw new Error(`${id}: no textures for material ${role}`);
    mat.setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(spec.roughness)
      .setEmissiveFactor([0, 0, 0]).setDoubleSided(!!spec.doubleSided);
    mat.setBaseColorTexture(makeTex(role, 'color', t.color));
    mat.getBaseColorTextureInfo().setMinFilter(9987).setMagFilter(9729);
    if (t.normal) mat.setNormalTexture(makeTex(role, 'normal', t.normal)).setNormalScale(1);
    else mat.setNormalTexture(null);
    if (t.orm) mat.setMetallicRoughnessTexture(makeTex(role, 'orm', t.orm));
    else mat.setMetallicRoughnessTexture(null);
    mat.setOcclusionTexture(null);
    mat.setAlphaMode(spec.alpha);
    if (spec.alpha === 'MASK') {
      mat.setAlphaCutoff(spec.cutoff);
      alphaMaterials.push({ name: role, mode: 'MASK', cutoff: spec.cutoff });
    }
  }

  // ---- LOD1: same skin, simplified primitives
  await doc.transform(weld({}));
  const lod0Node = root.listNodes().find((n) => n.getName() === 'lod0');
  const lod0 = lod0Node.getMesh();
  lod0.setName('lod0');
  const tris0 = lod0.listPrimitives().reduce((s, p) => s + triCount(p), 0);
  // deep copy: Mesh.clone() shares primitives and accessors with lod0
  const lod1 = doc.createMesh('lod1');
  for (const p of lod0.listPrimitives()) {
    const q = doc.createPrimitive().setMaterial(p.getMaterial()).setMode(p.getMode());
    for (const sem of p.listSemantics()) q.setAttribute(sem, p.getAttribute(sem).clone());
    if (p.getIndices()) q.setIndices(p.getIndices().clone());
    lod1.addPrimitive(q);
  }
  const prims = lod1.listPrimitives();
  const alphaPrims = prims.filter((p) => p.getMaterial()?.getAlphaMode() === 'MASK');
  const solidPrims = prims.filter((p) => !alphaPrims.includes(p));
  // cards keep their silhouettes: simplify them lightly with locked borders
  for (const p of alphaPrims) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0.6, error: 0.01, lockBorder: true });
  const alphaTris = alphaPrims.reduce((s, p) => s + triCount(p), 0);
  const solidTris = solidPrims.reduce((s, p) => s + triCount(p), 0);
  const ratio = Math.min(1, Math.max(0.05, (LOD1_TARGET - alphaTris) / solidTris));
  for (const p of solidPrims) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error: 0.05, lockBorder: false });
  const lod1Node = doc.createNode('lod1').setMesh(lod1).setSkin(lod0Node.getSkin());
  lod0Node.getParentNode()?.addChild(lod1Node) ?? root.listScenes()[0].addChild(lod1Node);
  const tris1 = lod1.listPrimitives().reduce((s, p) => s + triCount(p), 0);

  // ---- compress geometry (allowed: KHR_mesh_quantization only)
  // Positions stay float32: quantizing them moves the skin's dequantization into the
  // inverse bind matrices, and the Blender re-import used for verification then showed
  // a black card on one avatar. Float positions cost about 30 KB per avatar.
  await doc.transform(
    quantize({ pattern: /^(NORMAL|TEXCOORD_\d+|WEIGHTS_\d+)$/, quantizationVolume: 'scene', quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12, quantizeWeight: 8 }),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    prune({ keepLeaves: true }),
    dedup(),
  );

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'textures'), { recursive: true });
  root.listBuffers()[0].setURI(`${id}.bin`);
  await writeGltf(io, doc, path.join(outDir, `${id}.gltf`));
  return { tris: { lod0: tris0, lod1: tris1 }, alphaMaterials };
}
