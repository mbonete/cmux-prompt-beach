#!/usr/bin/env node
// Validates public/assets/env/ against the asset format rules in docs/world-v2/BRIEF.md:
//   - every .gltf loads with @gltf-transform/core
//   - no embedded images (no data: URIs, no bufferView images) and external .bin buffers only
//   - no forbidden extensions (Draco, meshopt, KTX2/Basis); only the allowed list is used
//   - every texture is WebP (by mimeType and by file magic) and power-of-two in both dimensions
//   - every other .webp under the folder is power-of-two; every .hdr has a Radiance header
//   - every file listed in manifest.json exists with the recorded size; no unlisted files
//
//   node tools/assets/env/check.mjs [dir]     (default: public/assets/env)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageUtils, NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { abs, exists, fileBytes, isPow2, listFiles, ROOT } from './lib/util.mjs';

export const ALLOWED = new Set([
  'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength',
  'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_ior', 'EXT_texture_webp',
]);
const FORBIDDEN = /draco|meshopt|basisu|ktx/i;

const isWebp = (buf) => buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';

export async function checkEnv(dir) {
  const errors = [], warnings = [];
  const all = await listFiles(dir);
  const gltfs = all.filter((f) => f.endsWith('.gltf'));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const referenced = new Set();

  for (const file of gltfs) {
    const name = path.relative(dir, file);
    const json = JSON.parse(await readFile(file, 'utf8'));
    const base = path.dirname(file);
    for (const ext of [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]) {
      if (FORBIDDEN.test(ext)) errors.push(`${name}: forbidden extension ${ext}`);
      else if (!ALLOWED.has(ext)) errors.push(`${name}: extension not on the allowed list: ${ext}`);
    }
    for (const [i, buf] of (json.buffers ?? []).entries()) {
      if (!buf.uri || buf.uri.startsWith('data:')) errors.push(`${name}: buffer ${i} is embedded`);
      else if (!(await exists(path.join(base, buf.uri)))) errors.push(`${name}: missing buffer ${buf.uri}`);
      else referenced.add(path.join(base, buf.uri));
    }
    for (const [i, img] of (json.images ?? []).entries()) {
      if (img.bufferView !== undefined) { errors.push(`${name}: image ${i} is embedded in a bufferView`); continue; }
      if (!img.uri || img.uri.startsWith('data:')) { errors.push(`${name}: image ${i} is a data URI`); continue; }
      const p = path.join(base, decodeURIComponent(img.uri));
      if (!(await exists(p))) { errors.push(`${name}: missing image ${img.uri}`); continue; }
      referenced.add(p);
      const bytes = await readFile(p);
      if (img.mimeType && img.mimeType !== 'image/webp') errors.push(`${name}: image ${img.uri} has mimeType ${img.mimeType}`);
      if (!isWebp(bytes)) errors.push(`${name}: image ${img.uri} is not a WebP file`);
      const size = ImageUtils.getSize(new Uint8Array(bytes), 'image/webp');
      if (!size || !isPow2(size[0]) || !isPow2(size[1])) errors.push(`${name}: image ${img.uri} is not power-of-two (${size})`);
    }
    for (const [i, tex] of (json.textures ?? []).entries()) {
      const webpSrc = tex.extensions?.EXT_texture_webp?.source;
      if (tex.source !== undefined && webpSrc === undefined) errors.push(`${name}: texture ${i} references an image without EXT_texture_webp`);
    }
    try {
      const doc = await io.read(file);
      doc.setLogger(new Logger(Logger.Verbosity.ERROR));
      for (const t of doc.getRoot().listTextures()) {
        if (t.getMimeType() !== 'image/webp') errors.push(`${name}: texture ${t.getURI()} loads as ${t.getMimeType()}`);
      }
    } catch (err) {
      errors.push(`${name}: @gltf-transform/core failed to load it: ${err.message}`);
    }
  }

  for (const f of all.filter((x) => x.endsWith('.webp'))) {
    const buf = await readFile(f);
    if (!isWebp(buf)) { errors.push(`${path.relative(dir, f)} is not a WebP file`); continue; }
    const size = ImageUtils.getSize(new Uint8Array(buf), 'image/webp');
    if (!size || !isPow2(size[0]) || !isPow2(size[1])) errors.push(`${path.relative(dir, f)} is not power-of-two (${size})`);
  }
  for (const f of all.filter((x) => x.endsWith('.hdr'))) {
    const head = (await readFile(f)).subarray(0, 64).toString('latin1');
    if (!head.startsWith('#?RADIANCE') || !head.includes('FORMAT=32-bit_rle_rgbe')) errors.push(`${path.relative(dir, f)}: not a Radiance RGBE file`);
  }

  // sky sun data against three.js r187 maths (EquirectUV.js formula; backgroundRotation /
  // environmentRotation are applied as the transposed rotation to the lookup direction)
  if (await exists(path.join(dir, 'manifest.json'))) {
    const { Euler, Matrix4, Vector3 } = await import('three');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    for (const [id, sky] of Object.entries(manifest.sky ?? {})) {
      const sun = sky.sun;
      if (!sun?.visible) continue;
      const d = new Vector3(...sun.directionThree);
      const u = Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5;
      const vTex = Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5;     // texture v, 0 at the bottom (flipY)
      if (Math.abs(u - sun.u) > 1e-3 || Math.abs(vTex - (1 - sun.v)) > 1e-3) errors.push(`sky ${id}: directionThree does not map back to the measured u/v`);
      const el = (sun.elevationDeg * Math.PI) / 180;
      const world = new Vector3(0, Math.sin(el), -Math.cos(el));
      const lookup = world.clone().applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(0, sun.rotationYToPutSunAtNegZ, 0)).transpose());
      if (lookup.distanceTo(d) > 1e-3) errors.push(`sky ${id}: rotationYToPutSunAtNegZ does not bring the sun to -Z`);
    }
  }

  // manifest consistency
  const mf = path.join(dir, 'manifest.json');
  if (await exists(mf)) {
    const manifest = JSON.parse(await readFile(mf, 'utf8'));
    const listed = new Map();
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        if (typeof o.file === 'string' && typeof o.bytes === 'number') listed.set(path.join(dir, o.file), o.bytes);
        Object.values(o).forEach(walk);
      }
    };
    walk(manifest);
    for (const [f, b] of listed) {
      if (!(await exists(f))) errors.push(`manifest lists a missing file: ${path.relative(dir, f)}`);
      else if ((await fileBytes(f)) !== b) errors.push(`manifest size mismatch: ${path.relative(dir, f)}`);
    }
    for (const f of all) {
      if (f.endsWith('manifest.json') || f.endsWith('credits.json')) continue;
      if (!listed.has(f)) warnings.push(`not listed in manifest.json: ${path.relative(dir, f)}`);
    }
  } else {
    errors.push('manifest.json is missing');
  }
  if (!(await exists(path.join(dir, 'credits.json')))) errors.push('credits.json is missing');
  return { errors, warnings, checked: gltfs.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : abs('public/assets/env');
  const { errors, warnings, checked } = await checkEnv(dir);
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const e of errors) console.error(`ERROR: ${e}`);
  console.log(`${checked} glTF files checked in ${path.relative(ROOT, dir)}: ${errors.length} errors, ${warnings.length} warnings`);
  process.exitCode = errors.length ? 1 : 0;
}
