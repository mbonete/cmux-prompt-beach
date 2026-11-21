// Finalize the Deco building kit: apply materials and external WebP textures
// to the glTF files staged by build_kit.py, then write public/assets/buildings/
// with manifest.json and credits.json.
//
//   node tools/assets/deco/finalize.mjs [name ...]
//
// The material definitions come from assets-src/_build/deco/spec.json, which
// build_kit.py writes from tools/assets/deco/kit/materials.py.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';

const REPO = process.cwd();
const STAGE = path.join(REPO, 'assets-src/_build/deco');
const OUT = path.join(REPO, 'public/assets/buildings');
const TEX = path.join(OUT, 'textures');
const spec = JSON.parse(fs.readFileSync(path.join(STAGE, 'spec.json'), 'utf8'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const KEEP_EXT = new Set(['EXT_texture_webp', 'KHR_materials_emissive_strength']);
// emissive and transparent surfaces skip the baked AO
const NO_AO = new Set(['neon_accent', 'glass', 'interior', 'bulb']);

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(spec.buildings);

function round(v, d = 3) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

async function finalize(name) {
  const s = spec.buildings[name];
  const doc = await io.read(path.join(STAGE, name, `${name}.gltf`));
  const root = doc.getRoot();
  for (const t of root.listTextures()) t.dispose();
  for (const ext of root.listExtensionsUsed()) if (!KEEP_EXT.has(ext.extensionName)) ext.dispose();
  const webp = doc.createExtension(EXTTextureWebP).setRequired(true);
  const strength = doc.createExtension(KHRMaterialsEmissiveStrength);
  const cache = new Map();
  const tex = (n) => {
    if (!n) return null;
    if (!cache.has(n)) {
      const file = path.join(TEX, `${n}.webp`);
      cache.set(n, doc.createTexture(n).setImage(fs.readFileSync(file)).setMimeType('image/webp').setURI(`textures/${n}.webp`));
    }
    return cache.get(n);
  };
  for (const mat of root.listMaterials()) {
    const m = s.materials[mat.getName()];
    if (!m) throw new Error(`${name}: no spec for material ${mat.getName()}`);
    for (const e of mat.listExtensions()) mat.setExtension(e.extensionName, null);
    mat.setBaseColorFactor(m.base.length === 4 ? m.base : [...m.base, 1]);
    mat.setMetallicFactor(m.metal ?? 0).setRoughnessFactor(m.rough ?? 1);
    mat.setBaseColorTexture(tex(m.albedo));
    mat.setMetallicRoughnessTexture(tex(m.orm));
    if (s.ao && !NO_AO.has(mat.getName())) {
      mat.setOcclusionTexture(tex(s.ao));
      mat.getOcclusionTextureInfo().setTexCoord(1);
    } else {
      mat.setOcclusionTexture(tex(m.orm));
    }
    mat.setNormalTexture(tex(m.normal));
    if (m.normal) mat.setNormalScale(m.normalScale ?? 1);
    mat.setEmissiveFactor(m.emissive ?? [0, 0, 0]);
    mat.setEmissiveTexture(tex(m.emissiveTex));
    if (m.emissiveStrength && m.emissiveStrength !== 1) {
      mat.setExtension('KHR_materials_emissive_strength', strength.createEmissiveStrength().setEmissiveStrength(m.emissiveStrength));
    }
    mat.setAlphaMode(m.alphaMode ?? 'OPAQUE');
    mat.setDoubleSided(!!m.doubleSided);
    mat.setExtras({});
  }
  if (!root.listTextures().length) webp.dispose();
  // surfaces that skip the baked AO do not need its UV set either
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    if (!NO_AO.has(prim.getMaterial()?.getName())) continue;
    const uv1 = prim.getAttribute('TEXCOORD_1');
    if (uv1) {
      prim.setAttribute('TEXCOORD_1', null);
      if (!uv1.listParents().some((p) => p !== root)) uv1.dispose();
    }
  }
  // Blender suffixes duplicate object names (.001); restore the contract names.
  for (const node of root.listNodes()) {
    const n = node.getName();
    const m = n.match(/^(prop:.*)\.\d{3}$/);
    if (m) node.setName(m[1]);
  }
  for (const b of root.listBuffers()) b.setURI(`${name}.bin`);
  root.getAsset().generator = 'Switchboard deco kit (Blender 5.2 + glTF-Transform 4.5)';
  root.getAsset().copyright = 'Switchboard world v2, original work';
  await io.write(path.join(OUT, `${name}.gltf`), doc);

  // manifest entry
  let tris = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    tris += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  const b = getBounds(root.listScenes()[0]);
  const textures = root.listTextures().map((t) => t.getURI());
  const bytes = ['gltf', 'bin'].reduce((a, ext) => a + fs.statSync(path.join(OUT, `${name}.${ext}`)).size, 0);
  const empties = {};
  for (const node of root.listNodes()) {
    if (node.getMesh()) continue;
    const n = node.getName();
    if (n === name) continue;
    const e = node.getExtras();
    const entry = { position: node.getTranslation().map((v) => round(v)), rotation: node.getRotation().map((v) => round(v, 5)) };
    if (Object.keys(e).length) entry.extras = e;
    (empties[n] ??= []).push(entry);
  }
  return {
    kind: s.kind,
    files: [`${name}.gltf`, `${name}.bin`, ...textures],
    bytes,
    textureBytes: textures.reduce((a, t) => a + fs.statSync(path.join(OUT, t)).size, 0),
    tris,
    bounds: { min: b.min.map((v) => round(v)), max: b.max.map((v) => round(v)) },
    materials: root.listMaterials().map((m) => m.getName()),
    look: s.look,
    empties,
    notes: s.notes,
  };
}

const manifestPath = path.join(OUT, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
manifest.assets ??= {};
for (const n of names) {
  manifest.assets[n] = await finalize(n);
  console.log(`[finalize] ${n}: ${manifest.assets[n].tris} tris, ${(manifest.assets[n].bytes / 1024).toFixed(0)} KB`);
}
for (const k of Object.keys(manifest.assets)) if (!spec.buildings[k]) delete manifest.assets[k];
manifest.generator = 'tools/assets/deco/build_kit.py';
manifest.conventions = {
  units: 'metres, glTF Y-up; plots are 20 x 16 m centred on the origin, front (terrace) toward +Z; other buildings sit on their base centre',
  spots: 'spot_0..spot_5: local +Z is the facing direction; extras.spot_kind, seat_h and table_h are heights above the empty; table_edge is the distance from the root to the near edge of the desk or counter along +Z',
  stool: `stool spots sit ${spec.constants.stool_raise} m up on the footrest so seat and counter keep seat_h and table_h above the root`,
  props: 'prop:<id> empties: local +Z is the front of the prop (Poly Haven models face +Z); extras.prop_id repeats the id because three.js strips ":" from node names (the original name is in userData.name)',
  anchors: 'tag_anchor above the roof for the name tag; beam_anchor on the ground at the plot centre',
  materials: 'stucco base colour is the pastel tint (override per plot); interior, neon_accent and bulb are emissive and meant to be scaled by time of day (bulb: festoon bulbs, sconce and lantern glass, marquee bulbs; warm white, emissiveStrength 6; drive it with a night level and switch it off on vacant plots)',
  lights: 'light_0..light_n (2-4 per plot): the main night light sources. The empty sits at the source; extras.light_radius (metres, 2-6) is the radius of the soft pool to draw on the floor below, extras.light_color a warm hex colour, extras.floor_y the local height of that floor (terrace or deck top). No real lights are intended.',
  palms: 'palm_0..palm_n: base of a palm trunk (soil in a planter, the ground or the sand); extras.palm_height in metres (5-11). The empty yaw is a free per-palm turn. The beach bar palms stand on the sand at origin height: drop them onto the dune surface.',
  layout: 'layout.plots[i] is the building type for plot index i (0-15: the core, row * 4 + col, row 0 nearest the beach; 16-31: the outer columns); layout.cells[i] is its [column, row] on the eight-column grid; layout.hangout and layout.overflow name the shared beach bar and co-working types',
  textures: 'shared WebP files in textures/, EXT_texture_webp; ORM packed (R occlusion, G roughness, B metalness)',
};
manifest.constants = spec.constants;
if (spec.layout) manifest.layout = spec.layout;
manifest.textures = Object.fromEntries(fs.readdirSync(TEX).filter((f) => f.endsWith('.webp')).sort()
  .map((f) => [f, fs.statSync(path.join(TEX, f)).size]));
const ordered = Object.fromEntries(Object.keys(manifest.assets).sort().map((k) => [k, manifest.assets[k]]));
manifest.assets = ordered;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const credits = [
  {
    asset: 'textures/stucco_albedo.webp, stucco_normal.webp, stucco_orm.webp, concrete_albedo.webp, concrete_orm.webp',
    author: 'Amal Kumar (Poly Haven)',
    source: 'Poly Haven: Painted Plaster Wall',
    licence: 'CC0 1.0',
    url: 'https://polyhaven.com/a/painted_plaster_wall',
    changes: 'Resized to 1024, desaturated and normalised into a neutral tintable base, concrete variant with pores and staining, ORM repacked, WebP encoded',
  },
  {
    asset: 'all buildings (*.gltf, *.bin) and the remaining textures (terrazzo, wood, roof, glass block, awnings, interiors, tower windows, baked ao_*)',
    author: 'Switchboard world v2 (procedurally generated by tools/assets/deco)',
    source: 'original',
    licence: 'MIT (repository licence)',
    url: '',
    changes: 'n/a',
  },
];
fs.writeFileSync(path.join(OUT, 'credits.json'), JSON.stringify(credits, null, 2) + '\n');
