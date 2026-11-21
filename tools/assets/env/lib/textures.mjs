// Tiling PBR texture sets: albedo (sRGB), normal (OpenGL +Y), ORM (R occlusion,
// G roughness, B metalness), each at every size in config.textures.sizes.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { abs, cleanDir, rel, round } from './util.mjs';

const toLin = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb8 = (v) => {
  v = Math.min(1, Math.max(0, v));
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
};

export async function readRaw(file, channels) {
  let img = sharp(abs(file));
  img = channels === 1 ? img.greyscale().toColourspace('b-w') : img.removeAlpha().toColourspace('srgb');
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== channels) throw new Error(`${file}: expected ${channels} channels, got ${info.channels}`);
  return { data, width: info.width, height: info.height, channels };
}

export function encodeWebp(img, opts) {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } })
    .webp({ effort: 6, smartSubsample: true, ...opts })
    .toBuffer();
}

async function resizeRaw(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const { data, info } = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Halves a normal map repeatedly with a 2x2 box filter on unit vectors (renormalised). */
export function downsampleNormal(img, width) {
  let cur = img;
  while (cur.width > width) {
    const w = cur.width >> 1, h = cur.height >> 1;
    const out = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let nx = 0, ny = 0, nz = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const i = ((y * 2 + dy) * cur.width + x * 2 + dx) * 3;
          nx += cur.data[i] / 127.5 - 1; ny += cur.data[i + 1] / 127.5 - 1; nz += cur.data[i + 2] / 127.5 - 1;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        const o = (y * w + x) * 3;
        out[o] = Math.round((nx / len + 1) * 127.5);
        out[o + 1] = Math.round((ny / len + 1) * 127.5);
        out[o + 2] = Math.round((nz / len + 1) * 127.5);
      }
    }
    cur = { data: out, width: w, height: h, channels: 3 };
  }
  return cur;
}

/**
 * Scales albedo in linear light, keeping its variation:
 *   { meanLinear, neutral }  mean luminance -> meanLinear (and channel means equal if neutral)
 *   { meanLinearRGB }        per-channel means -> the given linear colour
 */
function calibrate(img, { meanLinear, neutral, meanLinearRGB }) {
  const n = img.width * img.height;
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sum[c] += toLin[img.data[i * 3 + c]];
  const mean = sum.map((s) => s / n);
  const lum = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
  const gain = meanLinearRGB ? mean.map((m, c) => meanLinearRGB[c] / m)
    : neutral ? mean.map((m) => meanLinear / m) : mean.map(() => meanLinear / lum);
  let clipped = 0;
  const out = Buffer.alloc(img.data.length);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = toLin[img.data[i * 3 + c]] * gain[c];
      if (v > 1) clipped++;
      out[i * 3 + c] = toSrgb8(v);
    }
  }
  return { img: { ...img, data: out }, before: mean.map((m) => round(m, 4)), gain: gain.map((g) => round(g, 4)), clippedFraction: round(clipped / (n * 3), 5) };
}

/**
 * Wrap-around seam check. For each axis, the mean absolute difference between
 * the last and first column (row) is compared with the same measure between
 * every pair of neighbouring interior columns (rows):
 *   ratio  = seam / mean(interior)   ~1 for seamless noise-like textures
 *   vsMax  = seam / max(interior)    <= ~1 when the seam is no worse than the
 *            strongest interior line (grid textures whose joints sit on the edge)
 * pass = ratio <= 1.5 || vsMax <= 1.1
 */
export function seamCheck(img) {
  const { data, width: W, height: H, channels: C } = img;
  const colD = new Float64Array(W), rowD = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      const r = (y * W + ((x + 1) % W)) * C;
      const d = (((y + 1) % H) * W + x) * C;
      let dx = 0, dy = 0;
      for (let c = 0; c < C; c++) { dx += Math.abs(data[i + c] - data[r + c]); dy += Math.abs(data[i + c] - data[d + c]); }
      colD[x] += dx; rowD[y] += dy;
    }
  }
  const axis = (arr) => {
    const n = arr.length, seam = arr[n - 1];
    let sum = 0, max = 0;
    for (let k = 0; k < n - 1; k++) { sum += arr[k]; max = Math.max(max, arr[k]); }
    const ratio = seam / (sum / (n - 1)), vsMax = seam / max;
    return { ratio: round(ratio, 3), vsMax: round(vsMax, 3), pass: ratio <= 1.5 || vsMax <= 1.1 };
  };
  return { x: axis(colD), y: axis(rowD) };
}

export async function buildTextures(cfg, { only } = {}) {
  const outRoot = abs(path.join(cfg.out, 'textures'));
  const q = cfg.textures.quality;
  const result = {};
  for (const set of cfg.textures.sets) {
    if (only?.length && !only.includes(set.id)) continue;
    console.log(`[textures] ${set.id}`);
    const dir = await cleanDir(path.join(outRoot, set.id));
    const m = set.maps;
    let albedo = await readRaw(m.albedo, 3);
    const W = albedo.width, H = albedo.height;
    let calib = null;
    if (set.calibrate) {
      const c = calibrate(albedo, set.calibrate);
      albedo = c.img;
      calib = { ...set.calibrate, sourceMeanLinear: c.before, gain: c.gain, clippedFraction: c.clippedFraction };
    }
    let normal = await readRaw(m.normal, 3);
    if (normal.width !== W) normal = await resizeRaw(normal, W, H);

    // ORM
    const orm = { data: Buffer.alloc(W * H * 3), width: W, height: H, channels: 3 };
    const ormSource = {};
    if (m.arm) {
      let arm = await readRaw(m.arm, 3);
      if (arm.width !== W) arm = await resizeRaw(arm, W, H);
      for (let i = 0; i < W * H; i++) {
        orm.data[i * 3] = arm.data[i * 3];
        orm.data[i * 3 + 1] = arm.data[i * 3 + 1];
        orm.data[i * 3 + 2] = 0;
      }
      Object.assign(ormSource, { occlusion: 'arm.R', roughness: 'arm.G', metalness: 'forced 0 (dielectric)' });
    } else {
      let ao = m.ao ? await readRaw(m.ao, 1) : null;
      let rough = await readRaw(m.roughness, 1);
      if (ao && ao.width !== W) ao = await resizeRaw(ao, W, H);
      if (rough.width !== W) rough = await resizeRaw(rough, W, H);
      for (let i = 0; i < W * H; i++) {
        orm.data[i * 3] = ao ? ao.data[i] : 255;
        orm.data[i * 3 + 1] = rough.data[i];
        orm.data[i * 3 + 2] = 0;
      }
      Object.assign(ormSource, { occlusion: ao ? 'AO map' : 'none in source (1.0)', roughness: 'roughness map', metalness: '0' });
    }

    // seam check on the full-resolution maps
    const seams = { albedo: seamCheck(albedo), normal: seamCheck(normal), orm: seamCheck(orm) };

    const files = {};
    let bytes = 0;
    for (const size of set.sizes ?? cfg.textures.sizes) {
      const w = Math.min(size, W), h = Math.round((w * H) / W);
      const tag = w >= 2048 ? '2k' : w >= 1024 ? '1k' : `${w}`;
      const outs = {
        albedo: await encodeWebp(await resizeRaw(albedo, w, h), { quality: q.albedo }),
        normal: await encodeWebp(downsampleNormal(normal, w), { quality: q.normal }),
        orm: await encodeWebp(await resizeRaw(orm, w, h), { quality: q.orm }),
      };
      for (const [name, buf] of Object.entries(outs)) {
        const file = path.join(dir, `${name}_${tag}.webp`);
        await writeFile(file, buf);
        files[`${name}_${tag}`] = { file: rel(file), bytes: buf.length, width: w, height: h };
        bytes += buf.length;
      }
    }
    result[set.id] = {
      source: set.source,
      sourceFiles: Object.values(m),
      sizeM: set.sizeM,
      sizeSource: set.sizeSource,
      why: set.why,
      notes: set.notes,
      colorSpace: { albedo: 'sRGB', normal: 'linear, OpenGL (+Y up)', orm: 'linear; R occlusion, G roughness, B metalness' },
      orm: ormSource,
      calibration: calib,
      seams,
      seamless: Object.values(seams).every((s) => s.x.pass && s.y.pass),
      files,
      bytes,
    };
  }
  return result;
}
