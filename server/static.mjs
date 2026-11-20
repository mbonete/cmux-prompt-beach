// Safe static file serving from public/.
//
// Served: files under public/build/, public/assets/ and public/fonts/ with an allowed
// extension, plus a few icon files sitting directly in public/ (a favicon, say).
// Everything else is a 404: index.html (only served at "/", with the token filled in),
// dotfiles, directories, unknown extensions, and any path that is not plainly spelled.

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const STATIC_ROOTS = ['build', 'assets', 'fonts'];

export const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

// Files directly in public/ (outside the three folders) are served only if they are icons.
const TOP_LEVEL_EXT = new Set(['.svg', '.png', '.webp', '.jpg', '.jpeg']);

export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_HOUR = 'public, max-age=3600';
export const CACHE_REVALIDATE = 'no-cache';

// Turns a raw request path ("/build/app-1a2b.js?x") into safe path segments, or null.
// Works on the raw URL rather than the WHATWG-normalised one so that "/a/../b" and its
// encoded spellings are refused instead of silently resolved.
export function staticSegments(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.length > 1024) return null;
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  if (rawPath.includes('\\') || rawPath.includes('\0') || rawPath.includes('//')) return null;
  // Encoded separators, dots, nulls and backslashes have no business in an asset URL.
  if (/%(?:2f|5c|00|2e)/i.test(rawPath)) return null;
  const parts = rawPath.slice(1).split('/');
  const segments = [];
  for (const part of parts) {
    let seg;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!seg || seg.startsWith('.') || seg.length > 255) return null; // also rejects "." and ".."
    // Control characters, separators, and "%" (which would only come from double encoding).
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f/\\:%]/.test(seg)) return null;
    segments.push(seg);
  }
  return segments.length ? segments : null;
}

// Where a request may be served from, or null. Pure: does not touch the disk.
export function staticTarget(rawUrl) {
  const segments = staticSegments(rawUrl);
  if (!segments) return null;
  const ext = path.extname(segments[segments.length - 1]).toLowerCase();
  const type = MIME[ext];
  if (!type) return null;
  if (segments.length === 1) {
    if (!TOP_LEVEL_EXT.has(ext)) return null;
    return { segments, type, cache: CACHE_REVALIDATE };
  }
  if (!STATIC_ROOTS.includes(segments[0])) return null;
  return { segments, type, cache: segments[0] === 'build' ? CACHE_IMMUTABLE : CACHE_HOUR };
}

// Resolves a request to a real file inside publicDir, or null for a 404.
export async function resolveStatic(publicDir, rawUrl) {
  const target = staticTarget(rawUrl);
  if (!target) return null;
  const base = path.resolve(publicDir);
  const full = path.resolve(base, ...target.segments);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let real;
  let realBase;
  try {
    [real, realBase] = await Promise.all([realpath(full), realpath(base)]);
  } catch {
    return null;
  }
  // No symlink may lead outside public/, nor to a dotfile inside it.
  const realRel = path.relative(realBase, real);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
  if (realRel.split(path.sep).some((s) => s.startsWith('.'))) return null;
  let st;
  try {
    st = await stat(real);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { file: real, type: target.type, cache: target.cache, size: st.size, etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"` };
}

// True when an If-None-Match header matches the ETag (weak comparison, as RFC 9110 asks for GET/HEAD).
export function etagMatches(header, etag) {
  if (!header) return false;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return String(header)
    .split(',')
    .some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

// Sends a resolved static file (or a 304), honouring HEAD.
export function sendStatic(req, res, found, securityHeaders) {
  const headers = {
    'Content-Type': found.type,
    'Cache-Control': found.cache,
    ETag: found.etag,
    ...securityHeaders,
  };
  if (etagMatches(req.headers['if-none-match'], found.etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': found.size });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(found.file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
