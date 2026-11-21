// Characters pipeline: assets-src/ -> public/assets/characters/
//
//   node tools/assets/characters/build.mjs [--steps=avatars,anims,previews,manifest,check]
//                                         [--avatars=Female_Adult_01,Male_Adult_01]
//
// Steps (all by default, in this order):
//   avatars   Blender: FBX -> rebuilt Biped rig + skinned mesh (bl_avatars.py), then
//             Node: textures -> WebP, PBR materials, LOD1, quantization (avatar_post.mjs)
//   anims     Mesh2Motion decode, Blender bake/retarget per gender (bl_anims.py),
//             keyframe reduction + quantization (anims_post.mjs)
//   previews  Blender/Eevee verification renders + seat/table measurement (bl_preview.py)
//   manifest  manifest.json, credits.json, licence files
//   check     check.mjs (bone names, no embedded images, allowed extensions, WebP)
// Needs: Blender 5.2 on PATH, ImageMagick (`magick`), the repo's node_modules.
// Intermediate files go to assets-src/_cache/characters (git-ignored).
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { postAnims } from './anims_post.mjs';
import { postAvatar } from './avatar_post.mjs';
import { decodeM2M } from './m2m_decode.mjs';
import { QUALITY_STEPS, convertAlpha, convertColor, convertNormal, convertORM } from './textures.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const SRC = path.join(REPO, 'assets-src');
const RB = path.join(SRC, 'rocketbox/Assets');
const M2M = path.join(SRC, 'mesh2motion/static/assets/human');
const CACHE = path.join(SRC, '_cache/characters');
const OUT = path.join(REPO, 'public/assets/characters');
const PREV = path.join(SRC, '_previews/characters');

export const AVATARS = [
  ['Female_Adult_01', 'Adults'], ['Female_Adult_03', 'Adults'], ['Female_Adult_06', 'Adults'],
  ['Female_Adult_08', 'Adults'], ['Female_Adult_11', 'Adults'], ['Female_Adult_12', 'Adults'],
  ['Female_Adult_17', 'Adults'], ['Female_Party_02', 'Adults'], ['Sports_Female_02', 'Professions'],
  ['Business_Female_01', 'Professions'],
  ['Male_Adult_01', 'Adults'], ['Male_Adult_04', 'Adults'], ['Male_Adult_06', 'Adults'],
  ['Male_Adult_08', 'Adults'], ['Male_Adult_09', 'Adults'], ['Male_Adult_10', 'Adults'],
  ['Male_Adult_12', 'Adults'], ['Male_Adult_16', 'Adults'], ['Male_Adult_17', 'Adults'],
  ['Sports_Male_04', 'Professions'],
];

// canonical clips: [name, source (prefix-less, or {m, f}), mode, loop, extra]
// source folders: s = static (in place), xy = horizontal root motion, xyz = full root motion
export const CLIPS = [
  ['idle', 's/idle_neutral_01', 'static', true],
  ['idle_look', 's/idle_look_around_01', 'static', true],
  ['walk', 'xy/walk_neutral_01', 'walk', true],
  ['sit_down_table', 'xyz/sit_down_table_left', 'root', false],
  ['work_table', 's/work_table', 'static', true],
  ['sit_table_idle', 's/sit_table_idle_neutral_01', 'static', true],
  ['sit_table_relaxed', 's/sit_table_idle_relaxed_01', 'static', true],
  ['sit_table_yawn', 's/sit_table_idle_yawn', 'static', false],
  ['stand_up_table', 'xyz/sit_stand_up_table_left', 'root', false],
  ['sit_down_chair', 'xyz/sit_down_chair_01', 'root', false],
  ['sit_chair_relaxed', 's/sit_chair_idle_relaxed_01', 'static', true],
  ['sit_chair_yawn', 's/sit_chair_idle_yawn', 'static', false],
  ['stand_up_chair', 'xyz/sit_stand_up_chair_01', 'root', false],
  ['wave', 's/wave_01', 'static', true],
  ['phone_talk', { m: 's/cell_phone_talk_01', f: 'xyz/cell_phone_talk_01' }, { m: 'static', f: 'inplace' }, true],
  ['phone_text', 's/cell_phone_textmessage', 'static', true],
  ['cheer', { m: 's/cheer_01', f: 's/cheer_01' }, 'static', false],
  ['cheer_alt', { m: 's/cheer_03', f: 's/cheer_02' }, 'static', false],
  ['drink', 's/drink_drinking', 'static', true],
  ['headphones', 's/headphones_idle', 'static', true],
  ['stretch', 's/idle_stretch_arms_01', 'static', false],
  ['fist_pump', 'm2m/victory-fist-pump', 'm2m', false, { alignFeet: 'start' }],
  ['sleep', 'm2m/sleeping', 'm2m', true, { breathe: { seconds: 4.8 } }],
  ['lay_to_idle', 'm2m/laytoidle', 'm2m', false, { alignFeet: 'end' }],
  ['sitting_writing', 'm2m/sitting-writing', 'm2m', true, { breathe: { seconds: 4.8 } }],
];
const CLIP_NOTES = {
  work_table: 'Standing at a table and leaning over it (hands at about 0.70 m); not a seated typing clip.',
  sit_down_table: 'Ends seated, turned 90 degrees (see groundEnd).',
  stand_up_table: 'Starts seated; pairs with sit_down_table.',
  sit_down_chair: 'Backs 0.45 m onto the chair behind the start position.',
  sleep: 'Lying flat on the floor, root at floor level. Not shaped for a reclined lounger.',
  lay_to_idle: 'From lying on the floor (sleep) to standing; ends at the idle stance.',
  sitting_writing: 'Seated (seat about 0.41 m), hands on a raised writing surface.',
  fist_pump: 'Retargeted from Mesh2Motion; starts and ends in a neutral stance.',
};
const FOLDER = { s: 'all_animations_max_motextr_static', xy: 'all_animations_max_motextr_xy', xyz: 'all_animations_max_motextr_xyz' };
const REFERENCE = { m: 'Male_Adult_04', f: 'Female_Adult_01' };
const POSE_SHEETS = ['Male_Adult_08', 'Female_Adult_11'];
const AVATAR_BUDGET = 1.2 * 1024 * 1024;
const CLOSEUPS = ['Female_Adult_01', 'Male_Adult_08', 'Female_Party_02', 'Male_Adult_04'];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const STEPS = (args.steps ?? 'avatars,anims,previews,manifest,check').split(',');
const ONLY = args.avatars ? args.avatars.split(',') : null;
const avatars = AVATARS.filter(([id]) => !ONLY || ONLY.includes(id)).map(([id, group]) => ({ id, dir: path.join(RB, 'Avatars', group, id) }));
const genderOf = (id) => (/Female/.test(id) ? 'f' : 'm');

async function blender(script, cfg, tag) {
  const cfgPath = path.join(CACHE, `cfg_${tag}.json`);
  await writeFile(cfgPath, JSON.stringify(cfg, null, 1));
  await new Promise((ok, fail) => {
    const p = spawn('blender', ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(HERE, script), '--', cfgPath]);
    let log = '';
    const onData = (d) => {
      log += d;
      for (const line of String(d).split('\n')) if (/^(AVATAR|CLIP|MEASURE|MISSING)|Error|Traceback/.test(line)) console.log(`  [${tag}] ${line.slice(0, 300)}`);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => (code ? fail(new Error(`${script} failed (${code})\n${log.slice(-3000)}`)) : ok()));
  });
}

async function dirBytes(dir) {
  let total = 0;
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath ?? e.path, e.name);
    const s = await stat(p);
    total += s.size;
    files.push({ file: path.relative(OUT, p), bytes: s.size });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { total, files };
}

// ------------------------------------------------------------------ avatars
async function stepAvatars() {
  console.log(`avatars: Blender export (${avatars.length})`);
  await blender('bl_avatars.py', { out: path.join(CACHE, 'avatars'), avatars }, 'avatars');
  const results = {};
  for (const av of avatars) {
    const info = JSON.parse(await readFile(path.join(CACHE, 'avatars', av.id, 'info.json'), 'utf8'));
    const uv = JSON.parse(await readFile(path.join(CACHE, 'avatars', av.id, 'uv.json'), 'utf8'));
    // encode, and step the WebP quality down until the avatar fits its byte budget
    let res, bytes, texStats, step = 0;
    for (; step < QUALITY_STEPS.length; step++) {
      const q = QUALITY_STEPS[step];
      const tex = {};
      texStats = {};
      for (const { role, prefix } of info.materials) {
        const T = (k) => path.join(av.dir, 'Textures', `${prefix}_${k}.tga`);
        if (role === 'alpha') {
          const a = await convertAlpha(T('opacity_color'), q);
          tex.alpha = { color: a.buffer };
          texStats.alpha = a.stats;
        } else {
          const [c, n, o] = await Promise.all([convertColor(T(`${role}_color`), uv[role], q), convertNormal(T(`${role}_normal`), uv[role], q), convertORM(T(`${role}_specular`), uv[role], q)]);
          tex[role] = { color: c.buffer, normal: n.buffer, orm: o.buffer };
          texStats[role] = n.stats;
        }
      }
      res = await postAvatar(av.id, path.join(CACHE, 'avatars', av.id, `${av.id}.gltf`), path.join(OUT, av.id), tex);
      bytes = await dirBytes(path.join(OUT, av.id));
      if (bytes.total <= AVATAR_BUDGET) break;
    }
    step = Math.min(step, QUALITY_STEPS.length - 1);
    results[av.id] = { ...res, info, texStats, bytes: bytes.total, quality: QUALITY_STEPS[step] };
    console.log(`  ${av.id}: lod0 ${res.tris.lod0} / lod1 ${res.tris.lod1} tris, ${(bytes.total / 1024).toFixed(0)} KB (quality step ${step}), normals ${Object.values(texStats).map((s) => s.convention ?? '').filter(Boolean).join(' / ')}`);
  }
  // merge with results of earlier partial runs
  const file = path.join(CACHE, 'avatars.json');
  let prev = {};
  try { prev = JSON.parse(await readFile(file, 'utf8')); } catch {}
  await writeFile(file, JSON.stringify({ ...prev, ...results }, null, 1));
}

// ------------------------------------------------------------------ animations
function clipSpecs(g, m2m) {
  return CLIPS.map(([name, src, mode, loop, extra = {}]) => {
    const s = typeof src === 'string' ? src : src[g];
    const md = typeof mode === 'string' ? mode : mode[g];
    const [folder, base] = s.split('/');
    if (folder === 'm2m') return { name, kind: 'm2m', file: m2m[base], mode: md, loop, ...extra };
    return { name, kind: 'rb', file: path.join(RB, 'Animations', FOLDER[folder], `${g}_${base}.max.fbx`), mode: md, loop, ...extra };
  });
}

async function stepAnims() {
  const m2m = await decodeM2M(
    ['sleeping', 'laytoidle', 'victory-fist-pump', 'sitting-writing'].map((n) => path.join(M2M, 'animations', `${n}.glb`)),
    path.join(CACHE, 'm2m'),
  );
  const out = {};
  for (const g of ['m', 'f']) {
    console.log(`anims: bake ${g}`);
    const ref = AVATARS.find(([id]) => id === REFERENCE[g]);
    await blender('bl_anims.py', {
      gender: g,
      skeleton: path.join(CACHE, `skeleton_${g}.json`),
      out: path.join(CACHE, 'anims_raw', `${g}.gltf`),
      info: path.join(CACHE, 'anims_raw', `${g}.json`),
      referenceAvatar: path.join(RB, 'Avatars', ref[1], ref[0], 'Export', `${ref[0]}.fbx`),
      clips: clipSpecs(g, m2m),
    }, `anims_${g}`);
    await mkdir(path.join(OUT, 'anims'), { recursive: true });
    const r = await postAnims(path.join(CACHE, 'anims_raw', `${g}.gltf`), path.join(OUT, 'anims', `${g}.gltf`), { clipOrder: CLIPS.map((c) => c[0]) });
    out[g] = r;
    const worst = Math.max(...Object.values(r.report).map((c) => c.maxErrDeg));
    console.log(`  ${g}: ${Object.keys(r.report).length} clips, worst reduction error ${worst} deg`);
  }
  await writeFile(path.join(CACHE, 'anims_post.json'), JSON.stringify(out, null, 1));
}

// ------------------------------------------------------------------ previews + measurement
async function stepPreviews() {
  const all = Object.fromEntries(AVATARS.map(([id]) => [id, path.join(OUT, id, `${id}.gltf`)]));
  const cfg = {
    out: PREV,
    avatars: all,
    avatarGender: Object.fromEntries(AVATARS.map(([id]) => [id, genderOf(id)])),
    anims: { m: path.join(OUT, 'anims/m.gltf'), f: path.join(OUT, 'anims/f.gltf') },
    clipOrder: CLIPS.map((c) => c[0]),
    sitClips: ['work_table', 'sit_table_idle', 'sit_table_relaxed', 'sit_chair_relaxed', 'sitting_writing'],
    measureAvatars: REFERENCE,
    measureOut: path.join(CACHE, 'measure.json'),
    jobs: args.jobs ? args.jobs.split('+') : ['measure', 'sheet', ...POSE_SHEETS.map((a) => `poses:${a}`), ...CLOSEUPS.map((a) => `closeup:${a}`)],
  };
  if (args.compose !== 'only') {
    console.log('previews: render');
    await blender('bl_preview.py', cfg, 'previews');
  }
  const T = path.join(PREV, '_tiles');
  const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';
  const magick = (a) => run('magick', a, { maxBuffer: 1 << 26 });
  // labelled copies go to _tiles/l_*.png so re-composing never stacks labels
  const label = async (file, text, size = 18) => {
    const out = path.join(path.dirname(file), 'l_' + path.basename(file));
    await magick([file, '-gravity', 'North', '-background', '#202020', '-fill', '#f0f0f0', '-font', FONT, '-pointsize', String(size), '-splice', '0x30', '-annotate', '+0+6', text, out]);
    return out;
  };
  const montage = (files, tile, out) => magick(['montage', ...files, '-font', FONT, '-tile', tile, '-geometry', '+3+3', '-background', '#202020', '-quality', '90', out]);
  if (cfg.jobs.includes('sheet')) {
    const tiles = [];
    for (const [id] of AVATARS) tiles.push(await label(path.join(T, `sheet_${id}.png`), `${id} (${genderOf(id)})`));
    await montage(tiles, '5x4', path.join(PREV, 'contact_sheet.jpg'));
  }
  for (const id of POSE_SHEETS) {
    if (!cfg.jobs.includes(`poses:${id}`)) continue;
    const list = JSON.parse(await readFile(path.join(T, `poses_${id}.json`), 'utf8'));
    const tiles = [];
    for (const [name, t, f] of list) tiles.push(await label(f, `${name} @${Math.round(t * 100)}%`, 16));
    await montage(tiles, '10x', path.join(PREV, `poses_${id}.jpg`));
  }
  for (const id of CLOSEUPS) {
    if (!cfg.jobs.includes(`closeup:${id}`)) continue;
    await magick([path.join(T, `closeup_${id}_a.png`), path.join(T, `closeup_${id}_b.png`), '+append', '-quality', '92', path.join(PREV, `closeup_${id}.jpg`)]);
  }
}

// ------------------------------------------------------------------ manifest, credits, licences
async function stepManifest() {
  const av = JSON.parse(await readFile(path.join(CACHE, 'avatars.json'), 'utf8'));
  const an = JSON.parse(await readFile(path.join(CACHE, 'anims_post.json'), 'utf8'));
  let measure = {};
  try { measure = JSON.parse(await readFile(path.join(CACHE, 'measure.json'), 'utf8')); } catch { console.log('manifest: no measure.json yet (run the previews step); furniture heights left null'); }
  const manifest = {
    _about: 'Rocketbox people for world v2. Units metres, Y up, characters face +Z, feet at the origin. Bone names are the original Biped names; three.js sanitizes node names (spaces become underscores) identically in avatar and animation files, so AnimationMixer binds clips from anims/<skeleton>.gltf to any avatar of that skeleton.',
    conventions: {
      lods: 'Each avatar has two SkinnedMesh nodes, lod0 and lod1, bound to one skeleton. Show one at a time.',
      rootMotion: 'Only Bip01 has translation tracks. Clips with mode "root" move Bip01 away from the origin: when such a clip ends, move the character root by groundEnd (pos in the character\'s start frame, yaw about +Y) and continue with an in-place clip, which will then line up.',
      walk: 'walk is in place: move the character forward (+Z local) at clips.walk.speed m/s to keep the feet planted.',
      blending: 'Tracks that never leave the bind pose are omitted; three.js blends missing tracks to the bind pose, which is what they would contain.',
      alpha: 'Materials named "alpha" (hair cards, eyelashes) are alphaMode MASK, double-sided. Enable material.alphaToCoverage with MSAA for softer hair edges.',
    },
    avatars: {},
    anims: {},
    furniture: {},
    totalBytes: 0,
  };
  const listing = await dirBytes(OUT);
  for (const [id] of AVATARS) {
    const a = av[id];
    if (!a) continue;
    const files = listing.files.filter((f) => f.file.startsWith(id + '/'));
    const bytes = files.reduce((s, f) => s + f.bytes, 0);
    manifest.avatars[id] = {
      files: files.map((f) => f.file),
      gltf: `${id}/${id}.gltf`,
      skeleton: a.info.skeleton,
      height: a.info.height,
      bounds: { min: a.info.boundsMin, max: a.info.boundsMax },
      tris: a.tris,
      bytes,
      alphaMaterials: a.alphaMaterials,
      notes: a.info.trisByMaterial.alpha ? 'hair/eyelash cards in material "alpha"' : 'no alpha material (short hair painted on the head)',
    };
  }
  for (const g of ['m', 'f']) {
    const info = JSON.parse(await readFile(path.join(CACHE, 'anims_raw', `${g}.json`), 'utf8'));
    const files = listing.files.filter((f) => f.file.startsWith(`anims/${g}.`));
    manifest.anims[g] = {
      gltf: `anims/${g}.gltf`,
      files: files.map((f) => f.file),
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      joints: an[g].joints.length,
      clips: Object.fromEntries(CLIPS.map(([name]) => {
        const c = info.clips[name];
        const r = an[g].report[name];
        return [name, {
          duration: c.duration,
          loop: c.loop,
          mode: c.mode,
          source: c.source,
          ...(c.speed ? { speed: c.speed } : {}),
          rootStart: c.rootStart,
          rootEnd: c.rootEnd,
          groundEnd: c.groundEnd,
          ...(c.loopFix ? { loopFix: c.loopFix } : {}),
          ...(CLIP_NOTES[name] || c.synthBreathing ? { note: [CLIP_NOTES[name], c.synthBreathing ? 'source is a single held pose; breathing added procedurally' : null].filter(Boolean).join(' ') } : {}),
          ...(c.footSlideCm ? { footSlideCm: c.footSlideCm } : {}),
          keys: r.keysAfter,
          maxReductionErrDeg: r.maxErrDeg,
        }];
      })),
    };
  }
  manifest.furniture = summarizeFurniture(measure);
  manifest.furniture.measured = measure;
  manifest.totalBytes = listing.total;
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

  const credits = [
    ...AVATARS.map(([id]) => ({
      asset: id,
      author: 'Microsoft Rocketbox Avatar Library (Microsoft, original creation by Rocketbox Studios)',
      source: 'https://github.com/microsoft/Microsoft-Rocketbox',
      licence: 'MIT',
      url: `https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars`,
      changes: 'Converted from FBX to glTF in metres; Biped root made a bone; added a simplified LOD1; textures resized to 1024 and converted to WebP; specular map converted to roughness (ORM); geometry quantized.',
    })),
    {
      asset: 'anims/m.gltf, anims/f.gltf (Rocketbox clips)',
      author: 'Microsoft Rocketbox Avatar Library (animations)',
      source: 'https://github.com/microsoft/Microsoft-Rocketbox',
      licence: 'MIT',
      url: 'https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Animations',
      changes: 'Baked onto the avatar skeleton, renamed to canonical clip names, walk made in place, loops made seamless, keyframes reduced, rotations quantized.',
    },
    {
      asset: 'anims/m.gltf, anims/f.gltf (fist_pump, sleep, lay_to_idle, sitting_writing)',
      author: 'Mesh2Motion',
      source: 'https://github.com/Mesh2Motion/mesh2motion-app',
      licence: 'CC0-1.0',
      url: 'https://github.com/Mesh2Motion/mesh2motion-app/blob/main/LICENSE-CC0.MD',
      changes: 'Retargeted from the Mesh2Motion human skeleton onto the Rocketbox Biped skeletons; ground contact fixed; procedural breathing added to the two held poses (sleep, sitting_writing).',
    },
  ];
  await writeFile(path.join(OUT, 'credits.json'), JSON.stringify(credits, null, 1) + '\n');
  await copyFile(path.join(SRC, 'rocketbox/LICENSE.md'), path.join(OUT, 'LICENSE-rocketbox.txt'));
  await writeFile(path.join(OUT, 'LICENSE-mesh2motion-CC0.txt'),
    'Animations fist_pump, sleep, lay_to_idle and sitting_writing in anims/m.gltf and anims/f.gltf are\n' +
    'retargeted from Mesh2Motion (https://github.com/Mesh2Motion/mesh2motion-app), whose art assets are\n' +
    'dedicated to the public domain:\n\n' + (await readFile(path.join(SRC, 'mesh2motion/LICENSE-CC0.MD'), 'utf8')).trim() + '\n');
  console.log(`manifest: ${(listing.total / 1048576).toFixed(2)} MB total`);
}

function summarizeFurniture(m) {
  const pick = (clip, k) => ['m', 'f'].map((g) => m[g]?.[clip]?.[k]).filter((x) => typeof x === 'number');
  const avg = (...lists) => {
    const n = lists.flat();
    return n.length ? +(n.reduce((s, x) => s + x, 0) / n.length).toFixed(3) : null;
  };
  return {
    _about: 'What the clips assume, measured on the posed reference meshes (Male_Adult_04, Female_Adult_01), metres, glTF space, character root at the origin facing +Z. Seat height = underside of buttocks/thighs (top of the seat). Table top = lowest forearm/hand point while the forearms rest on the table. seatBackZ = back of the buttocks, kneesZ = front of the knees, tableNearEdgeZ = nearest hand point (the table edge must not be closer). Static sitting clips are in place, so positions are relative to the character root, which is then the seat spot. Per-gender values are in "measured".',
    seatHeightTable: avg(pick('sit_table_idle', 'seatContactZ'), pick('sit_table_relaxed', 'seatContactZ')),
    seatHeightChair: avg(pick('sit_chair_relaxed', 'seatContactZ')),
    tableTop: avg(pick('sit_table_idle', 'forearmsMinZ'), pick('sit_table_relaxed', 'forearmsMinZ')),
    tableNearEdgeZ: avg(pick('sit_table_idle', 'handsNearestZ'), pick('sit_table_relaxed', 'handsNearestZ')),
    seatBackZ: avg(pick('sit_table_idle', 'seatBackZ'), pick('sit_chair_relaxed', 'seatBackZ')),
    kneesZ: avg(pick('sit_table_idle', 'seatFrontZ'), pick('sit_chair_relaxed', 'seatFrontZ')),
    workTableStanding: {
      note: 'work_table is a STANDING clip (leaning over a table), not seated typing.',
      handsLowestZ: avg(pick('work_table', 'handsMinZ')),
    },
    sittingWriting: {
      note: 'Mesh2Motion sitting_writing: seated, hands on a writing surface in front.',
      seatHeight: avg(pick('sitting_writing', 'seatContactZ')),
      handsLowestZ: avg(pick('sitting_writing', 'handsMinZ')),
    },
  };
}

const steps = { avatars: stepAvatars, anims: stepAnims, previews: stepPreviews, manifest: stepManifest, check: async () => {
  const { check } = await import('./check.mjs');
  const r = await check(OUT);
  if (!r.ok) { console.error(r.errors.join('\n')); process.exitCode = 1; } else console.log(`check: ok (${r.summary})`);
} };
await mkdir(CACHE, { recursive: true });
for (const s of STEPS) {
  const t = Date.now();
  await steps[s]();
  console.log(`-- ${s} done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
}
