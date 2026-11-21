// Sanity check for public/assets/characters (run by build.mjs, or standalone:
//   node tools/assets/characters/check.mjs [dir]).
// Asserts: avatar bone names identical per skeleton and identical to the animation file
// (same rest transforms too), no embedded images or data URIs, only allowed extensions,
// every texture a power-of-two WebP file, LOD nodes present and sharing one skin.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([
  'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength',
  'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_ior',
  'EXT_texture_webp', // the only way to reference WebP images in spec-valid glTF
]);
const FORBIDDEN = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];
const CLIPS = ['idle', 'idle_look', 'walk', 'sit_down_table', 'work_table', 'sit_table_idle', 'sit_table_relaxed',
  'sit_table_yawn', 'stand_up_table', 'sit_down_chair', 'sit_chair_relaxed', 'sit_chair_yawn', 'stand_up_chair',
  'wave', 'phone_talk', 'phone_text', 'cheer', 'cheer_alt', 'drink', 'headphones', 'stretch', 'fist_pump',
  'sleep', 'lay_to_idle', 'sitting_writing'];

function webpSize(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1];
  }
  if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  return null;
}
const pow2 = (n) => n > 0 && (n & (n - 1)) === 0;

function boneTable(doc) {
  const out = new Map();
  for (const skin of doc.getRoot().listSkins()) {
    for (const j of skin.listJoints()) out.set(j.getName(), { t: j.getTranslation(), r: j.getRotation() });
  }
  return out;
}

export async function check(dir) {
  const errors = [];
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const err = (m) => errors.push(m);

  async function rawChecks(file) {
    const json = JSON.parse(await readFile(file, 'utf8'));
    const used = json.extensionsUsed ?? [];
    for (const e of used) {
      if (FORBIDDEN.includes(e)) err(`${file}: forbidden extension ${e}`);
      else if (!ALLOWED.has(e)) err(`${file}: extension ${e} not in the allowed list`);
    }
    for (const b of json.buffers ?? []) if (!b.uri || b.uri.startsWith('data:')) err(`${file}: embedded buffer`);
    for (const img of json.images ?? []) {
      if (img.bufferView !== undefined || !img.uri || img.uri.startsWith('data:')) { err(`${file}: embedded image ${img.name}`); continue; }
      if (img.mimeType !== 'image/webp' || !img.uri.endsWith('.webp')) err(`${file}: image ${img.uri} is not WebP`);
      const buf = await readFile(path.join(path.dirname(file), decodeURIComponent(img.uri)));
      const size = webpSize(buf);
      if (!size) err(`${file}: ${img.uri} is not a WebP file`);
      else if (!pow2(size[0]) || !pow2(size[1])) err(`${file}: ${img.uri} is ${size.join('x')}, not a power of two`);
    }
    for (const t of json.textures ?? []) if (t.source !== undefined) err(`${file}: texture uses core source (expected EXT_texture_webp)`);
    return json;
  }

  const anims = {};
  for (const g of ['m', 'f']) {
    const file = path.join(dir, 'anims', `${g}.gltf`);
    await rawChecks(file);
    const doc = await io.read(file);
    const root = doc.getRoot();
    if (root.listMeshes().length) err(`${file}: animation file should not contain meshes`);
    const names = root.listAnimations().map((a) => a.getName());
    for (const c of CLIPS) if (!names.includes(c)) err(`${file}: missing clip ${c}`);
    for (const n of names) if (!CLIPS.includes(n)) err(`${file}: unexpected clip ${n}`);
    for (const a of root.listAnimations()) {
      for (const ch of a.listChannels()) {
        const node = ch.getTargetNode();
        if (!node) err(`${file}: ${a.getName()} has a channel without target`);
        else if (ch.getTargetPath() === 'scale') err(`${file}: ${a.getName()} animates scale on ${node.getName()}`);
        else if (ch.getTargetPath() === 'translation' && node.getName() !== 'Bip01') err(`${file}: ${a.getName()} translates ${node.getName()}`);
      }
    }
    anims[g] = boneTable(doc);
    if (anims[g].size === 0) err(`${file}: no skin / joints`);
  }

  const perGender = { m: null, f: null };
  let avatars = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'anims') continue;
    const file = path.join(dir, e.name, `${e.name}.gltf`);
    await rawChecks(file);
    const doc = await io.read(file);
    const root = doc.getRoot();
    avatars++;
    const lod0 = root.listNodes().find((n) => n.getName() === 'lod0');
    const lod1 = root.listNodes().find((n) => n.getName() === 'lod1');
    if (!lod0 || !lod1) { err(`${file}: lod0/lod1 nodes missing`); continue; }
    if (!lod0.getSkin() || lod0.getSkin() !== lod1.getSkin()) err(`${file}: lod0 and lod1 must share one skin`);
    const tris = (n) => n.getMesh().listPrimitives().reduce((s, p) => s + p.getIndices().getCount() / 3, 0);
    if (tris(lod0) > 10000) err(`${file}: lod0 has ${tris(lod0)} tris (> 10k)`);
    if (tris(lod1) > 3000) err(`${file}: lod1 has ${tris(lod1)} tris`);
    const bones = boneTable(doc);
    const g = /Female/.test(e.name) ? 'f' : 'm';
    const ref = anims[g];
    const names = [...bones.keys()].sort().join('|');
    if (perGender[g] === null) perGender[g] = names;
    else if (perGender[g] !== names) err(`${file}: bone names differ from the other ${g} avatars`);
    if ([...ref.keys()].sort().join('|') !== names) err(`${file}: bone names differ from anims/${g}.gltf`);
    for (const [n, b] of bones) {
      const a = ref.get(n);
      if (!a) continue;
      const dt = Math.hypot(...b.t.map((v, i) => v - a.t[i]));
      const dq = Math.abs(b.r.reduce((s, v, i) => s + v * a.r[i], 0));
      if (dt > 1e-3 || dq < 0.99999) err(`${file}: rest transform of ${n} differs from anims/${g}.gltf (${dt.toFixed(4)} m)`);
    }
    for (const n of bones.keys()) if (/[.:/\[\]]/.test(n)) err(`${file}: bone name ${n} has characters three.js strips`);
  }
  if (avatars === 0) err('no avatars found');
  return { ok: errors.length === 0, errors, summary: `${avatars} avatars, 2 animation files` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/assets/characters');
  const r = await check(dir);
  if (!r.ok) { console.error(r.errors.join('\n')); process.exit(1); }
  console.log(`check ok: ${r.summary}`);
}
