// Rocketbox TGA textures -> glTF-ready WebP (sharp; ImageMagick only decodes the TGA).
//  color    -> baseColor (sRGB)
//  normal   -> tangent-space normal, glTF convention (+Y up); the source convention is
//              detected with a curl test (a height field's gradient is curl-free only in
//              the right convention) and the green channel flipped if needed
//  specular -> ORM: R = 255 (no AO; the colour maps already carry baked occlusion),
//              G = roughness (perceptual mapping below), B = 0 (no metal)
//  opacity  -> RGBA hair / eyelash cards, colour dilated under transparent texels
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);

export const SIZE = 1024;
// Roughness carries no visible detail above 512 at character scale, and its pore-level
// noise triples the file size at 1024, so the ORM map ships at 512.
export const ORM_SIZE = 512;
export const QUALITY = { color: 88, normal: 92, orm: 88, alpha: 85, alphaChannel: 80 };
// fallback steps used by build.mjs when an avatar is over its byte budget
export const QUALITY_STEPS = [
  QUALITY,
  { ...QUALITY, normal: 90, alpha: 80, alphaChannel: 70 },
  { ...QUALITY, color: 85, normal: 90, alpha: 75, alphaChannel: 60 },
];

// Rocketbox "specular level" (0-255) -> roughness. The source spec maps vary a lot per
// avatar (face means from 13 to 47), so the skin range is compressed: any face lands
// at roughly 0.5-0.65 (never wet or plastic), denim/cotton at 0.8-0.9, and only the
// brightest texels (cornea, teeth) go below 0.3. Validated in the close-up renders.
const SPEC_ANCHORS = [
  [0, 0.9], [6, 0.85], [10, 0.74], [14, 0.64], [20, 0.58], [35, 0.53],
  [60, 0.47], [100, 0.4], [160, 0.3], [255, 0.2],
];
export function roughnessFromSpec(v) {
  for (let i = 1; i < SPEC_ANCHORS.length; i++) {
    const [x1, y1] = SPEC_ANCHORS[i];
    const [x0, y0] = SPEC_ANCHORS[i - 1];
    if (v <= x1) return y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
  }
  return SPEC_ANCHORS.at(-1)[1];
}

export async function readTGA(file) {
  const { stdout } = await run('magick', [file, '-depth', '8', 'RGBA:-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const { stdout: dims } = await run('magick', ['identify', '-format', '%w %h', file]);
  const [w, h] = dims.trim().split(' ').map(Number);
  if (stdout.length !== w * h * 4) throw new Error(`${file}: unexpected decode size`);
  return { data: new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length), w, h };
}

async function resize(img, channels, size = SIZE) {
  const buf = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.w, height: img.h, channels },
  })
    .resize(size, size, { kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  return { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length), w: size, h: size };
}

function pick(img, channels) {
  const n = img.w * img.h;
  const out = new Uint8Array(n * channels);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = img.data[i * 4 + c];
  return { data: out, w: img.w, h: img.h };
}

async function webp(img, channels, quality, extra = {}) {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.w, height: img.h, channels },
  })
    .webp({ quality, effort: 6, smartSubsample: true, ...extra })
    .toBuffer();
}

/** Curl test. Returns +1 for OpenGL (+Y up, glTF) and -1 for DirectX (+Y down). */
export function normalConvention(img) {
  const { w, h, data } = img;
  const g = (x, y) => {
    const i = (y * w + x) * 4;
    const nx = data[i] / 127.5 - 1, ny = data[i + 1] / 127.5 - 1, nz = Math.max(0.2, data[i + 2] / 127.5 - 1);
    return [-nx / nz, -ny / nz]; // dh/du, dh/dup (if +Y is up in image space)
  };
  let sab = 0, saa = 0, sbb = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const c = g(x, y), up = g(x, y - 1), right = g(x + 1, y);
      const a = up[0] - c[0]; // d(gx)/d(up): image rows grow downwards, so "up" is y - 1
      const b = right[1] - c[1]; // d(gy)/du
      if (Math.abs(a) > 2 || Math.abs(b) > 2) continue;
      sab += a * b; saa += a * a; sbb += b * b;
    }
  }
  const corr = sab / Math.sqrt(saa * sbb);
  return { sign: corr >= 0 ? 1 : -1, corr };
}

function padded(img, uv) {
  if (!uv) return img;
  return pushPull(img, uvMask(uv, img.w, img.h));
}

export async function convertColor(file, uv, q = QUALITY) {
  const img = padded(await readTGA(file), uv);
  const small = await resize(pick(img, 3), 3);
  return { buffer: await webp(small, 3, q.color), stats: { src: `${img.w}x${img.h}` } };
}

export async function convertNormal(file, uv, q = QUALITY) {
  const raw = await readTGA(file);
  const conv = normalConvention(raw);
  const img = padded(raw, uv);
  const rgb = pick(img, 3);
  if (conv.sign < 0) for (let i = 1; i < rgb.data.length; i += 3) rgb.data[i] = 255 - rgb.data[i];
  const small = await resize(rgb, 3);
  // renormalize after filtering
  const d = small.data;
  for (let i = 0; i < d.length; i += 3) {
    let x = d[i] / 127.5 - 1, y = d[i + 1] / 127.5 - 1, z = d[i + 2] / 127.5 - 1;
    z = Math.max(z, 0.05);
    const l = Math.hypot(x, y, z) || 1;
    d[i] = Math.round((x / l + 1) * 127.5);
    d[i + 1] = Math.round((y / l + 1) * 127.5);
    d[i + 2] = Math.round((z / l + 1) * 127.5);
  }
  return {
    buffer: await webp(small, 3, q.normal),
    stats: { convention: conv.sign > 0 ? 'OpenGL (+Y up), kept' : 'DirectX (+Y down), green flipped', curl: +conv.corr.toFixed(3) },
  };
}

export async function convertORM(file, uv, q = QUALITY) {
  const img = padded(await readTGA(file), uv);
  const n = img.w * img.h;
  const orm = new Uint8Array(n * 3);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(roughnessFromSpec(v) * 255);
  for (let i = 0; i < n; i++) {
    orm[i * 3] = 255;
    orm[i * 3 + 1] = lut[img.data[i * 4]];
    orm[i * 3 + 2] = 0;
  }
  const small = await resize({ data: orm, w: img.w, h: img.h }, 3, ORM_SIZE);
  return { buffer: await webp(small, 3, q.orm) };
}

// Push-pull fill: texels with weight 0 get the colour of the nearest covered texels,
// coarse to fine. Used to pad UV islands (black gutters otherwise bleed into the
// mip levels and show as dark seams) and to colour hair cards under alpha = 0.
export function pushPull(img, weight) {
  const ch = img.data.length / (img.w * img.h);
  const levels = [];
  let w = img.w, h = img.h;
  let col = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = weight[i] ? 1 : 0;
    wt[i] = a;
    for (let c = 0; c < 3; c++) col[i * 3 + c] = img.data[i * ch + c] * a;
  }
  levels.push({ w, h, col, wt });
  while (w > 1) {
    const nw = w >> 1, nh = h >> 1;
    const ncol = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let s2 = 0; const acc = [0, 0, 0];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const j = (2 * y + dy) * w + 2 * x + dx;
        s2 += wt[j];
        for (let c = 0; c < 3; c++) acc[c] += col[j * 3 + c];
      }
      const k = y * nw + x;
      nwt[k] = s2;
      for (let c = 0; c < 3; c++) ncol[k * 3 + c] = acc[c];
    }
    w = nw; h = nh; col = ncol; wt = nwt;
    levels.push({ w, h, col, wt });
  }
  const avg = levels.map((L) => {
    const out = new Float32Array(L.w * L.h * 3);
    for (let i = 0; i < L.w * L.h; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = L.wt[i] > 0 ? L.col[i * 3 + c] / L.wt[i] : -1;
    return out;
  });
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], up = levels[l + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x;
      if (avg[l][i * 3] >= 0) continue;
      const j = Math.min(up.h - 1, y >> 1) * up.w + Math.min(up.w - 1, x >> 1);
      for (let c = 0; c < 3; c++) avg[l][i * 3 + c] = avg[l + 1][j * 3 + c];
    }
  }
  const out = new Uint8Array(img.data);
  for (let i = 0; i < img.w * img.h; i++) {
    if (weight[i]) continue;
    for (let c = 0; c < 3; c++) out[i * ch + c] = Math.max(0, Math.min(255, Math.round(avg[0][i * 3 + c])));
  }
  return { data: out, w: img.w, h: img.h };
}

/** Rasterize UV triangles ([u0,v0,u1,v1,u2,v2,...], v up) into a coverage mask. */
export function uvMask(tris, w, h, grow = 4) {
  const m = new Uint8Array(w * h);
  for (let t = 0; t < tris.length; t += 6) {
    const P = [0, 1, 2].map((k) => [tris[t + 2 * k] * w - 0.5, (1 - tris[t + 2 * k + 1]) * h - 0.5]);
    const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const e0 = ((P[1][0] - x) * (P[2][1] - y) - (P[2][0] - x) * (P[1][1] - y)) / area;
      const e1 = ((P[2][0] - x) * (P[0][1] - y) - (P[0][0] - x) * (P[2][1] - y)) / area;
      const e2 = 1 - e0 - e1;
      if (e0 >= 0 && e1 >= 0 && e2 >= 0) m[y * w + x] = 1;
    }
  }
  // grow islands by a few texels so bilinear filtering at the edges stays inside
  let cur = m;
  for (let g = 0; g < grow; g++) {
    const nx = new Uint8Array(cur);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!cur[i] && (cur[i - 1] || cur[i + 1] || cur[i - w] || cur[i + w])) nx[i] = 1;
    }
    cur = nx;
  }
  return cur;
}

export async function convertAlpha(file, q = QUALITY) {
  const img = await readTGA(file);
  const weight = new Uint8Array(img.w * img.h);
  for (let i = 0; i < weight.length; i++) weight[i] = img.data[i * 4 + 3] > 8 ? 1 : 0;
  const filled = pushPull(img, weight);
  const small = await resize(filled, 4);
  let cover = 0;
  for (let i = 3; i < small.data.length; i += 4) cover += small.data[i] > 127 ? 1 : 0;
  return {
    buffer: await webp(small, 4, q.alpha, { alphaQuality: q.alphaChannel, exact: true }),
    stats: { coverage: +(cover / (small.w * small.h)).toFixed(3) },
  };
}
