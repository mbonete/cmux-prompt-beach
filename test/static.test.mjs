import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CACHE_HOUR, CACHE_IMMUTABLE, CACHE_REVALIDATE, MIME, etagMatches, resolveStatic, staticSegments, staticTarget } from '../server/static.mjs';

describe('staticSegments: path spelling', () => {
  const refused = [
    '/build/../server.mjs',
    '/build/./app.js',
    '/../server.mjs',
    '/build/..%2f..%2fserver.mjs',
    '/build/%2e%2e/%2e%2e/server.mjs',
    '/build/%2E%2E/x.js',
    '/build/.%2e/x.js',
    '/build/%252e%252e/x.js', // double-encoded
    '/build\\..\\server.mjs',
    '/build/%5c..%5cserver.mjs',
    '/build/app.js%00.png',
    '/build/app\u0000.js',
    '/build//app.js',
    '/build/',
    '/',
    '',
    'build/app.js',
    'http://127.0.0.1:4747/build/app.js',
    '/assets/.env',
    '/assets/.hidden/x.png',
    '/.git/config',
    '/build/%ZZ.js',
    `/build/${'a'.repeat(300)}.js`,
  ];
  for (const p of refused) {
    test(`refuses ${JSON.stringify(p.slice(0, 60))}`, () => {
      assert.equal(staticSegments(p), null);
      assert.equal(staticTarget(p), null);
    });
  }

  test('accepts plain paths and ignores the query string', () => {
    assert.deepEqual(staticSegments('/build/app-1a2b3c.js?v=2'), ['build', 'app-1a2b3c.js']);
    assert.deepEqual(staticSegments('/assets/characters/Ana%20B/Ana%20B.gltf'), ['assets', 'characters', 'Ana B', 'Ana B.gltf']);
  });
});

describe('staticTarget: roots, extensions, MIME and cache', () => {
  test('only build/, assets/ and fonts/ (plus top-level icons)', () => {
    assert.ok(staticTarget('/build/app.js'));
    assert.ok(staticTarget('/assets/models/plot.gltf'));
    assert.ok(staticTarget('/fonts/anton.woff2'));
    assert.ok(staticTarget('/favicon.svg'));
    assert.equal(staticTarget('/server/static.mjs'), null);
    assert.equal(staticTarget('/client/src/main.ts'), null);
    assert.equal(staticTarget('/vendor/three.module.js'), null);
    assert.equal(staticTarget('/node_modules/three/build/three.module.js'), null);
    assert.equal(staticTarget('/app.js'), null, 'top-level scripts are not served');
    assert.equal(staticTarget('/index.html'), null, 'the page is only served at /, with its token');
  });

  test('disallowed extensions', () => {
    for (const p of ['/build/app.js.map', '/assets/x.html', '/assets/x.mjs', '/fonts/anton.LICENSE', '/assets/x', '/assets/x.glb', '/assets/x.ktx2', '/build/x.wasm', '/assets/x.JSON.bak']) {
      assert.equal(staticTarget(p), null, p);
    }
  });

  test('MIME types', () => {
    const expect = {
      js: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      woff2: 'font/woff2',
      gltf: 'model/gltf+json',
      bin: 'application/octet-stream',
      webp: 'image/webp',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      svg: 'image/svg+xml',
      hdr: 'image/vnd.radiance',
      exr: 'image/x-exr',
      json: 'application/json; charset=utf-8',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
    };
    for (const [ext, type] of Object.entries(expect)) {
      assert.equal(MIME[`.${ext}`], type);
      assert.equal(staticTarget(`/assets/x.${ext}`).type, type);
    }
    assert.equal(staticTarget('/assets/X.PNG').type, 'image/png', 'extensions are case-insensitive');
  });

  test('cache headers', () => {
    assert.equal(staticTarget('/build/app-1a2b.js').cache, CACHE_IMMUTABLE);
    assert.match(CACHE_IMMUTABLE, /max-age=31536000/);
    assert.match(CACHE_IMMUTABLE, /immutable/);
    assert.equal(staticTarget('/assets/env/sky.hdr').cache, CACHE_HOUR);
    assert.equal(staticTarget('/fonts/anton.woff2').cache, CACHE_HOUR);
    assert.match(CACHE_HOUR, /max-age=3600/);
    assert.equal(staticTarget('/favicon.svg').cache, CACHE_REVALIDATE);
  });

  test('ETag matching', () => {
    assert.ok(etagMatches('"a-1"', '"a-1"'));
    assert.ok(etagMatches('W/"a-1"', '"a-1"'));
    assert.ok(etagMatches('"x", "a-1"', '"a-1"'));
    assert.ok(etagMatches('*', '"a-1"'));
    assert.ok(!etagMatches('"a-2"', '"a-1"'));
    assert.ok(!etagMatches(undefined, '"a-1"'));
  });
});

describe('resolveStatic: the disk side', () => {
  let tmp;
  let pub;
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sb-static-'));
    pub = path.join(tmp, 'public');
    await mkdir(path.join(pub, 'build'), { recursive: true });
    await mkdir(path.join(pub, 'assets', 'models'), { recursive: true });
    await mkdir(path.join(pub, 'assets', 'dir.png'), { recursive: true });
    await mkdir(path.join(pub, 'fonts'), { recursive: true });
    await writeFile(path.join(pub, 'build', 'app-1a2b.js'), 'console.log(1)');
    await writeFile(path.join(pub, 'assets', 'models', 'plot.gltf'), '{}');
    await writeFile(path.join(pub, 'fonts', 'a.woff2'), 'w');
    await writeFile(path.join(pub, 'index.html'), '<html>');
    await writeFile(path.join(pub, '.secret.png'), 'secret');
    await writeFile(path.join(tmp, 'outside.png'), 'outside');
    await symlink(path.join(tmp, 'outside.png'), path.join(pub, 'assets', 'escape.png'));
    await symlink(tmp, path.join(pub, 'assets', 'up'));
    await symlink(path.join(pub, '.secret.png'), path.join(pub, 'assets', 'dot.png'));
    await symlink(path.join(pub, 'fonts', 'a.woff2'), path.join(pub, 'assets', 'inside.woff2'));
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  test('serves plain files with size and ETag', async () => {
    const found = await resolveStatic(pub, '/build/app-1a2b.js');
    assert.equal(found.type, 'text/javascript; charset=utf-8');
    assert.equal(found.size, 14);
    assert.match(found.etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.ok(await resolveStatic(pub, '/assets/models/plot.gltf'));
  });

  test('symlinks may not escape public/ or reach a dotfile', async () => {
    assert.equal(await resolveStatic(pub, '/assets/escape.png'), null);
    assert.equal(await resolveStatic(pub, '/assets/up/outside.png'), null);
    assert.equal(await resolveStatic(pub, '/assets/dot.png'), null);
    assert.ok(await resolveStatic(pub, '/assets/inside.woff2'), 'a link that stays inside public/ is fine');
  });

  test('directories, missing files and dotfiles are 404s', async () => {
    assert.equal(await resolveStatic(pub, '/assets/dir.png'), null);
    assert.equal(await resolveStatic(pub, '/assets/models'), null);
    assert.equal(await resolveStatic(pub, '/assets/nope.png'), null);
    assert.equal(await resolveStatic(pub, '/.secret.png'), null);
  });
});
