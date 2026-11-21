// Validate public/assets/buildings/ against the world v2 building contract.
//
//   node tools/assets/deco/check.mjs
//
// Checks: required empties, spot kinds, material names, triangle budgets,
// no embedded images or buffers, no forbidden extensions, textures are
// external power-of-two WebP files, night lights (bulb material, light_<n>
// and palm_<n> empties) and the district layout in manifest.json. Exits
// non-zero on any failure.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const DIR = path.join(process.cwd(), 'public/assets/buildings');
const MATERIALS = new Set(['stucco', 'trim', 'glass', 'glass_block', 'metal', 'terrazzo', 'wood', 'awning', 'roof',
  'concrete', 'planter', 'water', 'neon_accent', 'interior', 'bulb']);
const SPOT_KINDS = new Set(['desk', 'lounger', 'stool', 'bench', 'steps', 'standing']);
const ALLOWED_EXT = new Set(['KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength',
  'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_ior',
  'EXT_texture_webp' /* required to reference WebP images at all */]);
const FORBIDDEN_EXT = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression',
  'KHR_texture_basisu']);
const BUDGET = { plot: 25000, bg: 6000, tower: 3000 };
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const TABLE_H = manifest.constants?.desk_h ?? 0.72;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);
const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
const checkedImages = new Map();

async function checkImage(file, uri) {
  if (checkedImages.has(uri)) return;
  checkedImages.set(uri, true);
  const p = path.join(DIR, uri);
  if (!fs.existsSync(p)) return fail(file, `missing texture ${uri}`);
  const head = fs.readFileSync(p).subarray(0, 12);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') fail(file, `${uri} is not WebP`);
  const meta = await sharp(p).metadata();
  if (!isPow2(meta.width) || !isPow2(meta.height)) fail(file, `${uri} is ${meta.width}x${meta.height}, not power of two`);
  if (meta.width > 2048 || meta.height > 2048) fail(file, `${uri} larger than 2048`);
}

function kindOf(name) {
  if (name.startsWith('plot_')) return 'plot';
  if (name.startsWith('bg_')) return 'bg';
  if (name.startsWith('tower_')) return 'tower';
  return null;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.gltf')).sort();
if (!files.length) errors.push('no .gltf files found');
const summary = [];
for (const file of files) {
  const name = file.replace(/\.gltf$/, '');
  const kind = kindOf(name);
  if (!kind) fail(file, 'name must be plot_<type>, bg_<n> or tower_<n>');
  const json = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  // raw JSON checks: embedding and extensions
  for (const ext of json.extensionsUsed ?? []) {
    if (FORBIDDEN_EXT.has(ext)) fail(file, `forbidden extension ${ext}`);
    else if (!ALLOWED_EXT.has(ext)) fail(file, `extension not on the allowed list: ${ext}`);
  }
  for (const [i, b] of (json.buffers ?? []).entries()) {
    if (!b.uri || b.uri.startsWith('data:')) fail(file, `buffer ${i} is embedded`);
    else if (!fs.existsSync(path.join(DIR, b.uri))) fail(file, `missing buffer ${b.uri}`);
  }
  for (const [i, img] of (json.images ?? []).entries()) {
    if (img.bufferView !== undefined) fail(file, `image ${i} is embedded in a bufferView`);
    if (!img.uri || img.uri.startsWith('data:')) { fail(file, `image ${i} has no external uri`); continue; }
    if (!img.uri.endsWith('.webp')) fail(file, `image ${img.uri} is not .webp`);
    await checkImage(file, img.uri);
  }
  for (const [i, t] of (json.textures ?? []).entries()) {
    if (t.source !== undefined) fail(file, `texture ${i} uses a core (PNG/JPEG) source`);
    if (t.extensions?.EXT_texture_webp?.source === undefined) fail(file, `texture ${i} lacks EXT_texture_webp`);
  }
  // document checks
  const doc = await io.read(path.join(DIR, file));
  const root = doc.getRoot();
  for (const m of root.listMaterials()) if (!MATERIALS.has(m.getName())) fail(file, `material name "${m.getName()}" not allowed`);
  let tris = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    tris += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
    if (!p.getAttribute('NORMAL')) fail(file, `mesh ${mesh.getName()} has no normals`);
    const mat = p.getMaterial();
    if (mat?.getBaseColorTexture() && !p.getAttribute('TEXCOORD_0')) fail(file, `mesh ${mesh.getName()} textured without UVs`);
    // every texture slot's texCoord must exist on the primitive (WebGPU pipelines need the attribute)
    for (const info of [mat?.getBaseColorTextureInfo(), mat?.getMetallicRoughnessTextureInfo(), mat?.getNormalTextureInfo(),
      mat?.getOcclusionTextureInfo(), mat?.getEmissiveTextureInfo()]) {
      if (!info) continue;
      const slotTex = info === mat.getOcclusionTextureInfo() ? mat.getOcclusionTexture() : true;
      if (!slotTex) continue;
      if (!p.getAttribute(`TEXCOORD_${info.getTexCoord()}`)) fail(file, `${mesh.getName()}/${mat.getName()} samples TEXCOORD_${info.getTexCoord()} which the primitive lacks`);
    }
  }
  if (kind && tris > BUDGET[kind]) fail(file, `${tris} tris over the ${kind} budget of ${BUDGET[kind]}`);
  const nodes = new Map();
  for (const n of root.listNodes()) {
    const list = nodes.get(n.getName()) ?? [];
    list.push(n);
    nodes.set(n.getName(), list);
  }
  const scene = root.listScenes()[0];
  if (!scene || scene.listChildren().length !== 1 || scene.listChildren()[0].getName() !== name) {
    fail(file, `scene must have a single root node named ${name}`);
  }
  if (!nodes.has('tag_anchor')) fail(file, 'missing tag_anchor');
  if (kind === 'plot') {
    if (!nodes.has('beam_anchor')) fail(file, 'missing beam_anchor');
    for (let i = 0; i < 6; i++) {
      const n = nodes.get(`spot_${i}`)?.[0];
      if (!n) { fail(file, `missing spot_${i}`); continue; }
      const k = n.getExtras().spot_kind;
      if (!SPOT_KINDS.has(k)) fail(file, `spot_${i} has spot_kind "${k}"`);
      const [x, y, z] = n.getTranslation();
      if (Math.abs(x) > 10 || Math.abs(z) > 8) fail(file, `spot_${i} outside the plot`);
      if (y < -0.01 || y > 2) fail(file, `spot_${i} height ${y}`);
    }
    if (nodes.has('spot_6')) fail(file, 'more than 6 spots');
    // facing: each desk/stool spot should have its laptop within 1.2 m, in front of it (+Z local)
    const laptops = (nodes.get('prop:classic_laptop') ?? []).map((n) => n.getTranslation());
    for (let i = 0; i < 6; i++) {
      const n = nodes.get(`spot_${i}`)?.[0];
      if (!n || !['desk', 'stool'].includes(n.getExtras().spot_kind)) continue;
      const [qx, qy, qz, qw] = n.getRotation();
      const fwd = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
      const p0 = n.getTranslation();
      const ok = laptops.some((l) => {
        const d = [l[0] - p0[0], l[2] - p0[2]];
        const dist = Math.hypot(d[0], d[1]);
        return dist < 1.2 && (d[0] * fwd[0] + d[1] * fwd[2]) / dist > 0.7;
      });
      if (!ok) fail(file, `spot_${i} (${n.getExtras().spot_kind}) has no laptop in front of it; facing convention broken?`);
    }
    const seated = [0, 1, 2, 3, 4, 5].filter((i) => ['desk', 'stool'].includes(nodes.get(`spot_${i}`)?.[0]?.getExtras().spot_kind)).length;
    if (seated < 4) fail(file, `only ${seated} desk/stool spots (most agents are working: at least 4 of 6)`);
    // seated table spots must match the clips' table height
    for (let i = 0; i < 6; i++) {
      const e = nodes.get(`spot_${i}`)?.[0]?.getExtras();
      if (e && ['desk', 'stool'].includes(e.spot_kind) && Math.abs((e.table_h ?? 0) - TABLE_H) > 0.005) {
        fail(file, `spot_${i} table_h ${e.table_h}, expected ${TABLE_H}`);
      }
    }
    // night life: bulb material, 2-4 light pools, palms
    if (!root.listMaterials().some((m) => m.getName() === 'bulb')) fail(file, 'no bulb material (string lights, sconces, lanterns)');
    let lights = 0;
    for (let i = 0; nodes.has(`light_${i}`); i++) {
      lights++;
      const n = nodes.get(`light_${i}`)[0];
      const e = n.getExtras();
      if (!(e.light_radius >= 2 && e.light_radius <= 6)) fail(file, `light_${i} light_radius ${e.light_radius} outside 2-6 m`);
      if (!/^#[0-9A-Fa-f]{6}$/.test(e.light_color ?? '')) fail(file, `light_${i} light_color "${e.light_color}" is not a hex colour`);
      if (typeof e.floor_y !== 'number') fail(file, `light_${i} has no floor_y`);
      const [x, y, z] = n.getTranslation();
      if (Math.abs(x) > 10.5 || Math.abs(z) > 8.5 || y < 0 || y > 8) fail(file, `light_${i} at ${[x, y, z].map((v) => v.toFixed(2))} outside the plot`);
    }
    if (lights < 2 || lights > 4) fail(file, `${lights} light_<n> empties (want 2-4)`);
    for (const k of nodes.keys()) {
      if (/^light_/.test(k) && !/^light_\d+$/.test(k)) fail(file, `odd light empty name ${k}`);
      if (/^palm_/.test(k) && !/^palm_\d+$/.test(k)) fail(file, `odd palm empty name ${k}`);
    }
    for (let i = 0; nodes.has(`palm_${i}`); i++) {
      const n = nodes.get(`palm_${i}`)[0];
      const h = n.getExtras().palm_height;
      if (!(h >= 5 && h <= 11)) fail(file, `palm_${i} palm_height ${h} outside 5-11 m`);
      const [x, , z] = n.getTranslation();
      if (Math.abs(x) > 10.5 || Math.abs(z) > 8.5) fail(file, `palm_${i} outside the plot`);
    }
    for (const [n, list] of nodes) {
      if (!n.startsWith('prop:')) continue;
      for (const node of list) if (node.getExtras().prop_id !== n.slice(5)) fail(file, `${n} extras.prop_id mismatch`);
    }
  }
  const props = [...nodes.keys()].filter((n) => n.startsWith('prop:')).map((n) => `${n.slice(5)}x${nodes.get(n).length}`);
  summary.push(`${name.padEnd(18)} ${String(tris).padStart(6)} tris  ${root.listMaterials().length} materials${props.length ? '  props: ' + props.join(' ') : ''}`);
}
// district layout: 32 plots by index (with their grid cells), the hangout and the overflow
const lay = manifest.layout;
if (!lay) errors.push('manifest.json: no layout');
else {
  const plots = new Set(files.map((f) => f.replace(/\.gltf$/, '')).filter((n) => n.startsWith('plot_')));
  if (!Array.isArray(lay.plots) || lay.plots.length !== 32) errors.push('layout.plots must list 32 plot types');
  if (!Array.isArray(lay.cells) || lay.cells.length !== (lay.plots?.length ?? 0)) errors.push('layout.cells must give a [column, row] per plot');
  const at = new Map((lay.cells ?? []).map(([c, r], i) => [`${c},${r}`, lay.plots?.[i]]));
  const count = {};
  (lay.plots ?? []).forEach((t, i) => {
    if (!plots.has(t)) errors.push(`layout.plots[${i}] = ${t} is not a plot building`);
    count[t] = (count[t] ?? 0) + 1;
    const r = Math.floor(i / 4);
    const c = i % 4;
    const [cc, rr] = lay.cells?.[i] ?? [c, r];
    if (at.get(`${cc + 1},${rr}`) === t) errors.push(`layout: plot ${i} and its right-hand neighbour are both ${t}`);
    if (at.get(`${cc},${rr + 1}`) === t) errors.push(`layout: plot ${i} and the one behind it are both ${t}`);
  });
  for (const [t, n] of Object.entries(count)) if (n > 4) errors.push(`layout: ${t} used ${n} times (max 4)`);
  if (!['plot_deco_hotel'].includes(lay.plots?.[1]) && lay.plots?.[2] !== 'plot_deco_hotel') errors.push('layout: the hero plot_deco_hotel belongs on plot 1 or 2');
  for (const k of ['hangout', 'overflow']) if (!plots.has(lay[k])) errors.push(`layout.${k} = ${lay[k]} is not a plot building`);
  summary.push(`layout: ${Object.entries(count).map(([t, n]) => `${t.slice(5)}x${n}`).join(' ')}; hangout ${lay.hangout}, overflow ${lay.overflow}`);
}
console.log(summary.join('\n'));
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`\ncheck: ${files.length} buildings OK`);
