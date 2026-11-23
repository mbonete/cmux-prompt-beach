#!/usr/bin/env node
// Environment asset pipeline: regenerates public/assets/env/ from assets-src/.
//
//   node tools/assets/env/build.mjs                  # every step
//   node tools/assets/env/build.mjs props            # one or more steps
//   node tools/assets/env/build.mjs props --only anthurium_botany_01,classic_laptop
//
// Steps: sky, textures, water, props, manifest, previews, check.
// manifest.json and credits.json are merged, so a partial run keeps the other
// sections. Previews go to assets-src/_previews/env/ (never into public/).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { abs, blender, ENV_DIR, exists, fileBytes, loadConfig, readJson, rel, ROOT, writeJson, ensureDir, run } from './lib/util.mjs';
import { buildTextures, encodeWebp } from './lib/textures.mjs';
import { buildProps } from './lib/props.mjs';
import { checkEnv } from './check.mjs';

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1].split(',') : null;
const ALL = ['sky', 'textures', 'water', 'props', 'manifest', 'previews', 'check'];
const steps = argv.filter((a, i) => !a.startsWith('--') && (onlyIdx < 0 || i !== onlyIdx + 1));
const todo = steps.length ? steps : ALL;
for (const s of todo) if (!ALL.includes(s)) throw new Error(`unknown step ${s} (steps: ${ALL.join(', ')})`);

const cfg = await loadConfig();
const OUT = abs(cfg.out);
const BUILD = abs(cfg.build);
const PREV = abs(cfg.previews);
const SECTIONS = path.join(BUILD, 'sections');
const envRel = (p) => path.relative(OUT, p).split(path.sep).join('/');

async function saveSection(name, data) {
  const file = path.join(SECTIONS, `${name}.json`);
  const prev = (await exists(file)) ? await readJson(file) : {};
  await writeJson(file, { ...prev, ...data });
}

// --------------------------------------------------------------------------- sky
async function stepSky() {
  const ids = cfg.sky.hdri.map((h) => h.id).filter((id) => !only || only.includes(id));
  if (!ids.length) return;
  await blender(path.join(ENV_DIR, 'blender', 'sky.py'), [ROOT, ...ids], { quiet: false });
  const section = {};
  for (const id of ids) {
    const m = await readJson(path.join(BUILD, 'sky', `${id}.json`));
    const item = cfg.sky.hdri.find((h) => h.id === id);
    const files = {};
    for (const [k, f] of Object.entries(m.files)) {
      const p = path.join(OUT, 'sky', f);
      files[k] = { file: envRel(p), bytes: await fileBytes(p) };
    }
    if (m.clouds?.viable) {
      const raw = await readFile(path.join(BUILD, 'sky', `${id}_clouds.rgba`));
      const p = path.join(OUT, 'sky', `${id}_clouds.webp`);
      await writeFile(p, await sharp(raw, { raw: { width: m.clouds.width, height: m.clouds.height, channels: 4 } })
        .webp({ quality: 88, alphaQuality: 100, smartSubsample: true, effort: 6 }).toBuffer());
      files.clouds = { file: envRel(p), bytes: await fileBytes(p), width: m.clouds.width, height: m.clouds.height };
    }
    if (m.stars) {
      const raw = await readFile(path.join(BUILD, 'sky', `${id}_stars.rgb`));
      const p = path.join(OUT, 'sky', `${id}_stars.webp`);
      await writeFile(p, await sharp(raw, { raw: { width: m.stars.width, height: m.stars.height, channels: 3 } })
        .webp({ quality: 90, smartSubsample: true, effort: 6 }).toBuffer());
      files.stars = { file: envRel(p), bytes: await fileBytes(p), width: m.stars.width, height: m.stars.height };
    }
    delete m.files;
    delete m.bytes;
    section[id] = { mood: m.mood, source: item.src, sourceSize: m.source, files, sun: m.sun, clouds: m.clouds ?? { viable: false, reason: 'not requested' }, stars: m.stars, notes: m.notes, credit: item.credit };
  }
  await saveSection('sky', section);
}

// --------------------------------------------------------------------------- textures
async function stepTextures() {
  const r = await buildTextures(cfg, { only });
  const section = {};
  for (const [id, v] of Object.entries(r)) {
    section[id] = { ...v, files: Object.fromEntries(Object.entries(v.files).map(([k, f]) => [k, { ...f, file: envRel(abs(f.file)) }])) };
  }
  await saveSection('textures', section);
}

// --------------------------------------------------------------------------- water
async function stepWater() {
  await blender(path.join(ENV_DIR, 'blender', 'procedural.py'), [ROOT]);
  const meta = await readJson(path.join(BUILD, 'procedural', 'procedural.json'));
  const dir = await ensureDir(path.join(OUT, 'textures', 'water'));
  const section = {};
  const spec = {
    ocean_normal: { raw: 'ocean_normal.rgb', quality: 90, use: 'Tangent-space normal map, OpenGL (+Y up). Sample it twice at different scales and scroll directions and blend (or use partial derivative blending) to hide repetition.' },
    foam: { raw: 'foam.grey', quality: 90, use: 'Foam lace, histogram-equalised: foam = step(1 - coverage, texel). Drive coverage from distance to shore (shoreline band), wave height (crests) or a wake mask; sample at two scales for breakup.' },
    caustics: { raw: 'caustics.grey', quality: 90, use: 'Caustic light pattern for shallow sea floor: multiply into direct light, fade with depth. Animate by sampling twice with different scroll directions and taking the min (or average).' },
  };
  for (const [name, s] of Object.entries(spec)) {
    const m = meta[name];
    const raw = await readFile(path.join(BUILD, 'procedural', s.raw));
    const img = { data: raw, width: m.width, height: m.height, channels: m.channels };
    const p = path.join(dir, `${name}.webp`);
    await writeFile(p, await encodeWebp(img, { quality: s.quality }));
    section[name] = { file: envRel(p), bytes: await fileBytes(p), width: m.width, height: m.height, tileM: m.tileM, use: s.use, ...Object.fromEntries(Object.entries(m).filter(([k]) => !['width', 'height', 'channels', 'tileM'].includes(k))) };
  }
  await saveSection('water', section);
}

// --------------------------------------------------------------------------- props
async function stepProps() {
  const r = await buildProps(cfg, { only });
  const section = {};
  for (const [id, v] of Object.entries(r)) {
    section[id] = { ...v, gltf: envRel(abs(v.gltf)), files: v.files.map((f) => ({ ...f, file: envRel(abs(f.file)) })) };
  }
  await saveSection('props', section);
}

// --------------------------------------------------------------------------- manifest + credits
async function stepManifest() {
  const load = async (n) => ((await exists(path.join(SECTIONS, `${n}.json`))) ? readJson(path.join(SECTIONS, `${n}.json`)) : {});
  const sky = await load('sky'), textures = await load('textures'), water = await load('water'), props = await load('props');
  // keep only entries still in the config
  const keep = (obj, ids) => Object.fromEntries(Object.entries(obj).filter(([k]) => ids.includes(k)));
  const skyK = keep(sky, cfg.sky.hdri.map((h) => h.id));
  const texK = keep(textures, cfg.textures.sets.map((s) => s.id));
  const propK = keep(props, cfg.props.map((p) => p.id));
  const waterK = keep(water, Object.keys(cfg.procedural).filter((k) => k !== 'seed'));
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const totals = {
    sky: sum(Object.values(skyK).flatMap((s) => Object.values(s.files).map((f) => f.bytes))),
    textures: sum(Object.values(texK).map((t) => t.bytes)),
    water: sum(Object.values(waterK).map((w) => w.bytes)),
    props: sum(Object.values(propK).map((p) => p.bytes)),
  };
  totals.all = totals.sky + totals.textures + totals.water + totals.props;
  totals.texturesBySize = {
    '1k': sum(Object.values(texK).flatMap((t) => Object.entries(t.files).filter(([k]) => k.endsWith('_1k')).map(([, f]) => f.bytes))),
    '2k': sum(Object.values(texK).flatMap((t) => Object.entries(t.files).filter(([k]) => k.endsWith('_2k')).map(([, f]) => f.bytes))),
  };
  // Flat index the client reads: assets[id] = { kind, files: [paths], ...key data }
  const assets = {};
  for (const [id, p] of Object.entries(propK)) {
    assets[id] = {
      kind: 'prop', gltf: p.gltf, files: p.files.map((f) => f.file), bytes: p.bytes,
      tris: Object.fromEntries(Object.entries(p.variants).map(([v, x]) => [v, { lod0: x.lod0Tris, ...(x.lod1Tris ? { lod1: x.lod1Tris } : {}) }])),
      bounds: p.bounds, pivot: p.pivot, front: p.front, structure: p.structure,
      materials: p.materials.map((m) => m.name),
    };
  }
  for (const [id, s] of Object.entries(skyK)) {
    assets[id] = {
      kind: 'sky', mood: s.mood, files: Object.values(s.files).map((f) => f.file), bytes: Object.values(s.files).reduce((a, f) => a + f.bytes, 0),
      background: s.files.background.file, ibl: s.files.ibl.file,
      ...(s.files.clouds ? { clouds: s.files.clouds.file } : {}), ...(s.files.stars ? { stars: s.files.stars.file } : {}),
      sun: s.sun,
    };
  }
  for (const [id, t] of Object.entries(texK)) {
    const byMap = {};
    for (const [k, f] of Object.entries(t.files)) {
      const [map, size] = k.split('_');
      (byMap[size] ??= {})[map] = f.file;
    }
    assets[`texture:${id}`] = { kind: 'texture', set: id, sizeM: t.sizeM, files: Object.values(t.files).map((f) => f.file), bytes: t.bytes, maps: byMap };
  }
  for (const [id, w] of Object.entries(waterK)) {
    assets[`water:${id}`] = { kind: 'water', files: [w.file], bytes: w.bytes, tileM: w.tileM, use: w.use };
  }
  const manifest = {
    generator: 'tools/assets/env/build.mjs (config: tools/assets/env/config.json)',
    conventions: {
      paths: 'Relative to public/assets/env/ (served at /assets/env/).',
      index: 'assets[id] is a flat index (props by id, skies by id, texture sets as texture:<set>, water textures as water:<name>) with files[] and the key data; the sky, textures, water and props sections hold the full detail.',
      units: 'Metres; glTF Y-up. Props face +Z where they have a front; pivot at the base centre unless the entry says otherwise.',
      props: 'Each prop file: root node <id> > [variant nodes] > lod0 [, lod1]. Show one LOD at a time. lod0/lod1 nodes (or their part children) carry the KHR_mesh_quantization dequantisation transform (a scale and offset): move, clone or hide them, but do not reset their local transforms. Variant nodes keep the source layout; to place one variant on its own, clone it and zero its position.',
      equirect: 'u = x / width from the left edge, v = y / height from the top. azimuthDeg = u * 360. elevationDeg = 90 - v * 180. three.js r187 (EquirectUV.js, HDRLoader flipY) maps world direction d to u = atan2(d.z, d.x) / 2pi + 0.5, so with no rotation d = (cos el cos t, sin el, cos el sin t), t = (u - 0.5) * 2pi: u = 0.25 is -Z, 0.5 is +X, 0.75 is +Z. sun.directionThree is that vector. To put the sun over the sea (-Z), set scene.backgroundRotation.y = scene.environmentRotation.y = sun.rotationYToPutSunAtNegZ and place the DirectionalLight at (0, sin el, -cos el) * distance. Derived from the three.js r187 source (backgroundRotation and environmentRotation are applied as the transposed rotation to the lookup direction; check.mjs verifies the numbers with three\'s own Matrix4/Euler). Caveat from the same source: with WebGPURenderer an equirect scene.background is sampled through PMREMNode, which also multiplies by materialEnvRotation, and for the background mesh that resolves to scene.environmentRotation whenever scene.environment is set. So with both set, the visible sky may turn twice; if it does, set only environmentRotation.y. Confirm once at look-dev.',
      skyIntensity: 'HDR values are as shipped by Poly Haven (relative, not absolute: the night HDRI is exposed up). sun.intensity is the irradiance of the removed sun disc in the same units, so with environmentIntensity = k use DirectionalLight intensity = k * sun.intensity and colour sun.colorLinear. Pick per-mood intensities at look-dev.',
      layers: 'Cloud and star layers cover the upper hemisphere only: 4096 x 1024, row 0 = zenith, last row = horizon, same u as their HDRI. sRGB WebP; linear HDR radiance = srgbToLinear(texel.rgb) * hdrScale. Clouds: straight (not premultiplied) alpha.',
      textures: 'albedo sRGB; normal OpenGL (+Y up); orm linear R occlusion, G roughness, B metalness. sizeM is the real-world size one texture repeat covers: UV scale = metres / sizeM.',
    },
    totals,
    assets,
    sky: skyK,
    textures: texK,
    water: waterK,
    props: propK,
  };
  await writeJson(path.join(OUT, 'manifest.json'), manifest);

  const credits = [];
  for (const [id, s] of Object.entries(skyK)) {
    credits.push({ asset: `sky/${id}`, author: s.credit.author, source: 'Poly Haven', licence: 'CC0 1.0', url: s.credit.url,
      changes: `4K HDR downsampled to a 2K background (lower hemisphere flattened below ${cfg.sky.flattenBelowDeg[0]} deg) and a 1K IBL${s.sun.visible ? ' with the sun disc removed and in-painted' : ''}; sun/glow direction measured${s.files.clouds ? '; cloud layer extracted' : ''}${s.files.stars ? '; star layer extracted' : ''}.` });
  }
  for (const [id, t] of Object.entries(texK)) {
    const c = cfg.textures.sets.find((s) => s.id === id);
    credits.push({ asset: `textures/${id}`, author: c.credit.author, source: t.source, licence: 'CC0 1.0', url: c.credit.url,
      changes: `Resized to ${Object.keys(t.files).filter((k) => k.startsWith('albedo')).map((k) => k.split('_')[1]).join(' and ')}; ORM packed (metalness 0)${t.orm.occlusion.startsWith('none') ? ', no AO in source (1.0)' : ''}; WebP${t.calibration?.meanLinear !== undefined ? `; albedo calibrated to a neutral mean of ${t.calibration.meanLinear} linear` : ''}.` });
  }
  for (const name of Object.keys(waterK)) {
    credits.push({ asset: `textures/water/${name}`, author: 'Prompt Beach (generated)', source: 'tools/assets/env/blender/procedural.py', licence: 'Original work, same licence as this repository (MIT)', url: null, changes: 'Generated procedurally.' });
  }
  for (const [id, p] of Object.entries(propK)) {
    const c = cfg.props.find((x) => x.id === id);
    const lodTxt = Object.values(p.variants).some((v) => v.lod1Tris) ? '; LOD1 (meshoptimizer)' : '';
    const simp = Object.values(p.variants).some((v) => v.lod0Error !== undefined) ? '; LOD0 simplified to the triangle budget' : '';
    credits.push({ asset: `props/${id}`, author: c.credit.author, source: 'Poly Haven', licence: 'CC0 1.0', url: c.credit.url,
      changes: `Converted to glTF + WebP (${p.textureSize}), quantized, ORM packed, pivot ${p.pivot}${p.scale !== 1 ? `, scaled x${p.scale}` : ''}${simp}${lodTxt}; ${p.notes.filter((n) => !n.startsWith(c.notes ?? '\u0000')).join('; ') || 'no other changes'}.` });
  }
  await writeJson(path.join(OUT, 'credits.json'), credits);
  const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
  console.log(`[manifest] sky ${mb(totals.sky)}, textures ${mb(totals.textures)} (1k ${mb(totals.texturesBySize['1k'])}, 2k ${mb(totals.texturesBySize['2k'])}), water ${mb(totals.water)}, props ${mb(totals.props)}, total ${mb(totals.all)}`);
}

// --------------------------------------------------------------------------- previews
async function stepPreviews() {
  const manifest = await readJson(path.join(OUT, 'manifest.json'));
  await ensureDir(PREV);
  const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';
  // props: render in three parallel Blender processes
  const ids = Object.keys(manifest.props).filter((id) => !only || only.includes(id));
  const dir = await ensureDir(path.join(BUILD, 'previews', 'props'));
  const chunks = [[], [], []];
  ids.forEach((id, i) => chunks[i % 3].push(path.join(OUT, manifest.props[id].gltf)));
  await Promise.all(chunks.filter((c) => c.length).map((c) => blender(path.join(ENV_DIR, 'blender', 'preview_props.py'), [ROOT, dir, ...c])));
  const tiles = [];
  for (const id of Object.keys(manifest.props)) {
    const p = manifest.props[id];
    const v = Object.values(p.variants);
    const t0 = v.reduce((a, x) => a + x.lod0Tris, 0), t1 = v.reduce((a, x) => a + (x.lod1Tris ?? 0), 0);
    const size = p.bounds.max.map((m, k) => (m - p.bounds.min[k]).toFixed(2)).join(' x ');
    for (const lod of ['lod0', 'lod1']) {
      const img = path.join(dir, `${id}_${lod}.png`);
      if (!(await exists(img))) continue;
      const label = lod === 'lod0'
        ? `${id}  lod0 ${t0} tris${v.length > 1 ? ` (${v.length} variants)` : ''}\n${size} m  ${(p.bytes / 1e3).toFixed(0)} KB  tex ${p.textureSize}`
        : `${id}  lod1 ${t1} tris`;
      const out = path.join(dir, `${id}_${lod}_lab.png`);
      await run('magick', [img, '-font', FONT, '-gravity', 'south', '-background', '#1b1b1f', '-fill', '#e8e4dc', '-pointsize', '17', '-splice', '0x52', '-annotate', '+0+6', label, out]);
      tiles.push(out);
    }
  }
  await run('magick', ['montage', '-font', FONT, ...tiles, '-tile', '5x', '-geometry', '+4+4', '-background', '#111114', path.join(PREV, 'props_sheet.png')]);
  console.log(`[previews] ${rel(path.join(PREV, 'props_sheet.png'))}`);

  // textures: 4 m x 4 m plane at an oblique angle + 2x2 tiled albedo/normal crops
  const tdir = await ensureDir(path.join(BUILD, 'previews', 'textures'));
  await blender(path.join(ENV_DIR, 'blender', 'preview_textures.py'), [ROOT, tdir]);
  const ttiles = [];
  for (const [id, t] of Object.entries(manifest.textures)) {
    const render = path.join(tdir, `${id}.png`);
    const alb = path.join(OUT, t.files.albedo_1k.file), nor = path.join(OUT, t.files.normal_1k.file);
    const tile2 = (src, out) => run('magick', [src, '(', '+clone', ')', '+append', '(', '+clone', ')', '-append', '-resize', '320x320', out]);
    await tile2(alb, path.join(tdir, `${id}_alb2.png`));
    await tile2(nor, path.join(tdir, `${id}_nor2.png`));
    const seam = Object.entries(t.seams).map(([k, s]) => `${k} ${s.x.ratio}/${s.y.ratio}`).join('  ');
    const out = path.join(tdir, `${id}_panel.png`);
    await run('magick', [
      '(', render, '-resize', '640x640', ')',
      '(', path.join(tdir, `${id}_alb2.png`), path.join(tdir, `${id}_nor2.png`), '-append', ')', '+append',
      '-font', FONT, '-gravity', 'southwest', '-background', '#1b1b1f', '-fill', '#e8e4dc', '-pointsize', '15', '-splice', '0x52',
      '-annotate', '+10+6', `${id} (${t.source}), repeat ${t.sizeM[0]} x ${t.sizeM[1]} m; left 4 x 4 m plane, right 2 x 2 repeats\nseam ratio x/y: ${seam}: ${t.seamless ? 'seamless' : 'CHECK SEAM'}`, out]);
    ttiles.push(out);
  }
  await run('magick', ['montage', '-font', FONT, ...ttiles, '-tile', '2x', '-geometry', '+4+4', '-background', '#111114', path.join(PREV, 'textures_sheet.png')]);
  console.log(`[previews] ${rel(path.join(PREV, 'textures_sheet.png'))}`);
}

// --------------------------------------------------------------------------- run
const t0 = Date.now();
for (const step of ALL.filter((s) => todo.includes(s))) {
  const t = Date.now();
  if (step === 'sky') await stepSky();
  if (step === 'textures') await stepTextures();
  if (step === 'water') await stepWater();
  if (step === 'props') await stepProps();
  if (step === 'manifest') await stepManifest();
  if (step === 'previews') await stepPreviews();
  if (step === 'check') {
    const { errors, warnings, checked } = await checkEnv(OUT);
    for (const w of warnings) console.warn(`[check] warning: ${w}`);
    for (const e of errors) console.error(`[check] ERROR: ${e}`);
    console.log(`[check] ${checked} glTF files, ${errors.length} errors, ${warnings.length} warnings`);
    if (errors.length) process.exitCode = 1;
  }
  console.log(`[${step}] ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
