// Finalize the street kit: generate the procedural WebP textures, apply the
// PBR materials to the glTF files staged by build_street.py, and write
// public/assets/street/ with manifest.json and credits.json.
//
//   node tools/assets/street/finalize.mjs [name ...]
//
// The material table below is the single source of truth for factors,
// textures and alpha/double-sided flags; build_street.py only names them.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { separateCoplanar } from '../coplanar.mjs';

const REPO = process.cwd();
const STAGE = path.join(REPO, 'assets-src/_build/street');
const OUT = path.join(REPO, 'public/assets/street');
const TEX = path.join(OUT, 'textures');
const spec = JSON.parse(fs.readFileSync(path.join(STAGE, 'spec.json'), 'utf8'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const KEEP_EXT = new Set(['EXT_texture_webp', 'KHR_materials_emissive_strength', 'KHR_materials_clearcoat']);

const lin = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 1e5) / 1e5;
  });
};

/** Materials by name. Tintable ones are white so the client's instance colour is the final colour. */
const MATERIALS = {
  pole: { base: '#2f5c57', rough: 0.42, metal: 0.35 },
  bulb: { base: '#f7efe2', rough: 0.25, metal: 0, emissive: '#ffd49a', strength: 3 },
  white: { base: '#f2eee6', rough: 0.55, metal: 0 },
  paint: { base: '#ffffff', rough: 0.6, metal: 0, tint: true },
  wood: { base: '#ffffff', rough: 1, metal: 0, albedo: 'wood_albedo', orm: 'wood_orm', normal: 'wood_normal' },
  teak: { base: '#a07a55', rough: 0.62, metal: 0 },
  glass: { base: '#141d22', rough: 0.05, metal: 0.3 },
  metal: { base: '#c9ccce', rough: 0.32, metal: 1 },
  chrome: { base: '#e4e6e8', rough: 0.14, metal: 1 },
  accent: { base: '#e8553f', rough: 0.55, metal: 0, double: true },
  canvas: { base: '#ffffff', rough: 0.85, metal: 0, double: true, tint: true },
  canvas_white: { base: '#f6f1e7', rough: 0.85, metal: 0, double: true },
  cushion: { base: '#ffffff', rough: 0.9, metal: 0, tint: true },
  towel: { base: '#ffffff', rough: 0.95, metal: 0, albedo: 'towel_albedo', tint: true },
  carpaint: { base: '#ffffff', rough: 0.3, metal: 0.05, clearcoat: 1, clearcoatRough: 0.07, tint: true },
  trim: { base: '#1c1d1f', rough: 0.62, metal: 0 },
  headlight: { base: '#f0eee8', rough: 0.08, metal: 0, emissive: '#fff0d8', strength: 4 },
  taillight: { base: '#7a0d0b', rough: 0.15, metal: 0, emissive: '#ff2414', strength: 3 },
  leather: { base: '#c8b293', rough: 0.55, metal: 0 },
  hull: { base: '#f4f3ef', rough: 0.22, metal: 0 },
  sail: { base: '#f5f2ea', rough: 0.85, metal: 0, double: true },
  envelope: { base: '#d6dadd', rough: 0.38, metal: 0.45 },
};

// ---------------------------------------------------------------------------
// procedural textures (tileable, deterministic)
// ---------------------------------------------------------------------------
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, px, py, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (a, p) => ((a % p) + p) % p;
  const a = hash(w(xi, px), w(yi, py), s), b = hash(w(xi + 1, px), w(yi, py), s);
  const c = hash(w(xi, px), w(yi + 1, py), s), d = hash(w(xi + 1, px), w(yi + 1, py), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, px, py, s, oct = 4) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(x * f, y * f, px * f, py * f, s + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

async function writeWebp(name, w, h, data, channels, quality) {
  fs.mkdirSync(TEX, { recursive: true });
  await sharp(Buffer.from(data), { raw: { width: w, height: h, channels } }).webp({ quality, effort: 6 }).toFile(path.join(TEX, `${name}.webp`));
}

async function woodTextures() {
  const N = 512;
  const planks = 8;
  const alb = new Uint8Array(N * N * 3);
  const orm = new Uint8Array(N * N * 3);
  const hgt = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const pv = (y / N) * planks;
    const p = Math.floor(pv);
    const fv = pv - p;
    const seam = hash(p, 3, 9); // one butt joint per plank
    const tone = 0.86 + 0.22 * hash(p, 1, 5);
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const du = Math.abs(((u - seam + 1.5) % 1) - 0.5);
      const gap = Math.min(fv, 1 - fv) * (N / planks) < 1.6 || du * N < 1.2;
      const grain = fbm(u * 6, pv * 1 + p * 3.1, 6, planks, 11, 4);
      const fine = fbm(u * 64, pv * 12, 64, planks * 12, 21, 2);
      const streak = 0.5 + 0.5 * Math.sin((u * 40 + grain * 6 + p * 1.7) * Math.PI);
      const g = 0.82 + 0.12 * grain + 0.05 * fine + 0.05 * streak;
      const weather = 0.92 + 0.1 * fbm(u * 3, pv * 0.6, 3, planks * 0.6, 31, 3);
      const k = gap ? 0.32 : tone * g * weather;
      const i = (y * N + x) * 3;
      alb[i] = Math.min(255, 178 * k);
      alb[i + 1] = Math.min(255, 152 * k);
      alb[i + 2] = Math.min(255, 121 * k);
      orm[i] = gap ? 90 : 255;
      orm[i + 1] = Math.min(255, (0.7 + 0.18 * (1 - fine) + (gap ? 0.15 : 0)) * 255);
      orm[i + 2] = 0;
      hgt[y * N + x] = gap ? -1 : 0.12 * grain + 0.06 * fine + 0.04 * streak - 0.25 * Math.pow(Math.max(0, 1 - Math.min(fv, 1 - fv) * 12), 3);
    }
  }
  const nrm = new Uint8Array(N * N * 3);
  const H = (x, y) => hgt[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2;
      const dy = (H(x, y + 1) - H(x, y - 1)) * 2.2;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 3;
      nrm[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      nrm[i + 1] = ((dy / l) * 0.5 + 0.5) * 255; // OpenGL (+Y up) convention, as glTF expects
      nrm[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
    }
  await writeWebp('wood_albedo', N, N, alb, 3, 88);
  await writeWebp('wood_orm', N, N, orm, 3, 88);
  await writeWebp('wood_normal', N, N, nrm, 3, 92);
}

async function towelTexture() {
  // u across the towel, v along it: a darker stripe pattern of the tinted hue and pale hems.
  const W = 128, Hh = 256;
  const px = new Uint8Array(W * Hh * 3);
  const bands = [
    [0.0, 0.05, 1.0], [0.05, 0.07, 0.62], [0.07, 0.16, 1.0], [0.16, 0.3, 0.66], [0.3, 0.33, 1.0],
    [0.33, 0.67, 0.84], [0.67, 0.7, 1.0], [0.7, 0.84, 0.66], [0.84, 0.93, 1.0], [0.93, 0.95, 0.62], [0.95, 1.0, 1.0],
  ];
  for (let y = 0; y < Hh; y++) {
    const v = y / Hh;
    const b = bands.find((q) => v >= q[0] && v < q[1]) ?? bands[0];
    for (let x = 0; x < W; x++) {
      const weave = 0.96 + 0.04 * hash(x, y, 3) + 0.02 * Math.sin(x * 1.3);
      const k = Math.min(1, b[2] * weave);
      const i = (y * W + x) * 3;
      px[i] = px[i + 1] = px[i + 2] = 255 * k;
    }
  }
  await writeWebp('towel_albedo', W, Hh, px, 3, 90);
}

// ---------------------------------------------------------------------------
// glTF
// ---------------------------------------------------------------------------
function round(v, d = 3) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

async function finalize(name) {
  const s = spec.assets[name];
  const doc = await io.read(path.join(STAGE, name, `${name}.gltf`));
  const root = doc.getRoot();
  for (const t of root.listTextures()) t.dispose();
  for (const ext of root.listExtensionsUsed()) if (!KEEP_EXT.has(ext.extensionName)) ext.dispose();
  const webp = doc.createExtension(EXTTextureWebP).setRequired(true);
  const strength = doc.createExtension(KHRMaterialsEmissiveStrength);
  const clearcoat = doc.createExtension(KHRMaterialsClearcoat);
  const cache = new Map();
  const tex = (n) => {
    if (!n) return null;
    if (!cache.has(n)) {
      const file = path.join(TEX, `${n}.webp`);
      cache.set(n, doc.createTexture(n).setImage(fs.readFileSync(file)).setMimeType('image/webp').setURI(`textures/${n}.webp`));
    }
    return cache.get(n);
  };
  const used = [];
  for (const mat of root.listMaterials()) {
    const mname = mat.getName();
    const m = MATERIALS[mname];
    if (!m) throw new Error(`${name}: no material definition for ${mname}`);
    used.push(mname);
    for (const e of mat.listExtensions()) mat.setExtension(e.extensionName, null);
    mat.setBaseColorFactor([...lin(m.base), 1]);
    mat.setMetallicFactor(m.metal ?? 0).setRoughnessFactor(m.rough ?? 1);
    mat.setBaseColorTexture(tex(m.albedo));
    mat.setMetallicRoughnessTexture(tex(m.orm));
    mat.setOcclusionTexture(tex(m.orm));
    mat.setNormalTexture(tex(m.normal));
    if (m.normal) mat.setNormalScale(1);
    mat.setEmissiveFactor(m.emissive ? lin(m.emissive) : [0, 0, 0]);
    mat.setEmissiveTexture(null);
    if (m.emissive && m.strength && m.strength !== 1) {
      mat.setExtension('KHR_materials_emissive_strength', strength.createEmissiveStrength().setEmissiveStrength(m.strength));
    }
    if (m.clearcoat) {
      mat.setExtension('KHR_materials_clearcoat', clearcoat.createClearcoat().setClearcoatFactor(m.clearcoat).setClearcoatRoughnessFactor(m.clearcoatRough ?? 0.05));
    }
    mat.setAlphaMode('OPAQUE');
    mat.setDoubleSided(!!m.double);
    mat.setExtras({});
  }
  if (!root.listTextures().length) webp.dispose();
  if (!root.listMaterials().some((m) => m.getExtension('KHR_materials_emissive_strength'))) strength.dispose();
  if (!root.listMaterials().some((m) => m.getExtension('KHR_materials_clearcoat'))) clearcoat.dispose();
  for (const b of root.listBuffers()) b.setURI(`${name}.bin`);
  root.getAsset().generator = 'Switchboard street kit (Blender 5.2 + glTF-Transform 4.5)';
  root.getAsset().copyright = 'Switchboard world v2, original work';
  // No two surfaces may lie in the same plane (z-fighting flicker).
  separateCoplanar(doc);
  await io.write(path.join(OUT, `${name}.gltf`), doc);

  let tris = 0;
  for (const mesh of root.listMeshes())
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices();
      tris += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
    }
  const b = getBounds(root.listScenes()[0]);
  const textures = root.listTextures().map((t) => t.getURI());
  const bytes = ['gltf', 'bin'].reduce((a, ext) => a + fs.statSync(path.join(OUT, `${name}.${ext}`)).size, 0);
  return {
    kind: s.kind,
    files: [`${name}.gltf`, `${name}.bin`, ...textures],
    bytes,
    textureBytes: textures.reduce((a, t) => a + fs.statSync(path.join(OUT, t)).size, 0),
    tris,
    bounds: { min: b.min.map((v) => round(v)), max: b.max.map((v) => round(v)) },
    materials: used,
    tintable: used.filter((n) => MATERIALS[n].tint),
    emissive: used.filter((n) => MATERIALS[n].emissive),
    nodes: s.nodes,
    empties: s.empties,
    extras: s.extras,
    notes: s.notes,
  };
}

await woodTextures();
await towelTexture();
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(spec.assets);
const manifestPath = path.join(OUT, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
manifest.assets ??= {};
for (const n of names) {
  manifest.assets[n] = await finalize(n);
  console.log(`[street] ${n}: ${manifest.assets[n].tris} tris, ${(manifest.assets[n].bytes / 1024).toFixed(0)} KB`);
}
for (const k of Object.keys(manifest.assets)) if (!spec.assets[k]) delete manifest.assets[k];
manifest.generator = 'tools/assets/street/build_street.py';
manifest.conventions = {
  units: 'metres, glTF Y-up; front of every asset is +Z; pivot at the base centre (ground under props and cars, keel under boats, skids under the helicopter, gondola under the blimp)',
  materials: 'one material per surface kind, shared names across assets; tintable ones (white base) are meant to be tinted per instance; emissive ones (bulb, headlight, taillight) are authored at night strength and meant to be scaled by time of day',
  nodes: 'helicopter: child nodes rotor (spin about local +Y) and tail_rotor (spin about local +X) at their pivots',
  empties: 'lamps: bulb_<n> at the centre of each globe (extras.radius)',
  boats: 'extras.waterline on the root node: height above the pivot at which the boat floats',
  textures: 'shared WebP files in textures/, EXT_texture_webp; ORM packed (R occlusion, G roughness, B metalness); normals OpenGL convention',
};
manifest.textures = Object.fromEntries(fs.readdirSync(TEX).filter((f) => f.endsWith('.webp')).sort().map((f) => [f, fs.statSync(path.join(TEX, f)).size]));
manifest.assets = Object.fromEntries(Object.keys(manifest.assets).sort().map((k) => [k, manifest.assets[k]]));
manifest.totalBytes = Object.values(manifest.assets).reduce((a, x) => a + x.bytes, 0) + Object.values(manifest.textures).reduce((a, x) => a + x, 0);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const credits = [
  {
    asset: 'all street kit assets (*.gltf, *.bin) and textures (wood_*, towel_albedo)',
    author: 'Switchboard world v2 (procedurally generated by tools/assets/street)',
    source: 'original',
    licence: 'MIT (repository licence)',
    url: '',
    changes: 'n/a',
  },
];
fs.writeFileSync(path.join(OUT, 'credits.json'), JSON.stringify(credits, null, 2) + '\n');
console.log(`[street] total ${(manifest.totalBytes / 1024).toFixed(0)} KB`);
