#!/usr/bin/env node
// Downloads the raw third-party assets listed in sources.json into assets-src/
// (git-ignored). Idempotent: files already on disk are skipped.
//
//   node tools/assets/fetch.mjs            # everything
//   node tools/assets/fetch.mjs polyhaven  # one source
//
// The Quaternius kit is an itch.io download and is fetched by hand into
// assets-src/quaternius/ (see sources.json).

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'assets-src');
const UA = { 'User-Agent': 'prompt-beach-asset-fetch' };
const sources = JSON.parse(await readFile(path.join(ROOT, 'tools/assets/sources.json'), 'utf8'));
const only = process.argv[2];

const exists = (p) => stat(p).then(() => true, () => false);

async function download(url, dest) {
  if (await exists(dest)) return false;
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function json(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function polyhaven() {
  const { hdri, textures, models } = sources.polyhaven;
  for (const { id, res } of hdri) {
    const files = await json(`https://api.polyhaven.com/files/${id}`);
    const file = files.hdri[res].hdr;
    if (await download(file.url, path.join(OUT, 'polyhaven/hdri', `${id}_${res}.hdr`))) console.log('hdri', id);
  }
  for (const [kind, list] of [['textures', textures], ['models', models]]) {
    for (const { id, res } of list) {
      const files = await json(`https://api.polyhaven.com/files/${id}`);
      const gltf = files.gltf[res].gltf;
      const dir = path.join(OUT, 'polyhaven', kind, id);
      let fresh = await download(gltf.url, path.join(dir, path.basename(new URL(gltf.url).pathname)));
      for (const [rel, inc] of Object.entries(gltf.include ?? {})) {
        fresh = (await download(inc.url, path.join(dir, rel))) || fresh;
      }
      if (fresh) console.log(kind, id);
    }
  }
}

async function ambientcg() {
  for (const { id, res } of sources.ambientcg.materials) {
    const dir = path.join(OUT, 'ambientcg', id);
    const zip = path.join(OUT, 'ambientcg', `${id}_${res}.zip`);
    if (await download(`https://ambientcg.com/get?file=${id}_${res}.zip`, zip)) {
      await mkdir(dir, { recursive: true });
      await run('unzip', ['-oq', zip, '-d', dir]);
      console.log('ambientcg', id);
    }
  }
}

async function mesh2motion() {
  const { base, files } = sources.mesh2motion;
  for (const rel of files) {
    if (await download(base + rel.split('/').map(encodeURIComponent).join('/'), path.join(OUT, 'mesh2motion', rel))) {
      console.log('mesh2motion', rel);
    }
  }
}

async function rocketbox() {
  const dir = path.join(OUT, 'rocketbox');
  if (await exists(path.join(dir, '.git'))) {
    console.log('rocketbox: already cloned (git -C assets-src/rocketbox checkout to resume)');
    return;
  }
  await run('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', '--depth', '1', sources.rocketbox.repo, dir]);
  const list = await readFile(path.join(ROOT, sources.rocketbox.sparse), 'utf8');
  const child = execFile('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', '--stdin']);
  child.stdin.end(list);
  await new Promise((ok, fail) => child.on('exit', (code) => (code ? fail(new Error('sparse-checkout')) : ok())));
  await run('git', ['-C', dir, 'checkout', '-q', 'master'], { maxBuffer: 1 << 24 });
  console.log('rocketbox: done');
}

const steps = { polyhaven, ambientcg, mesh2motion, rocketbox };
for (const [name, step] of Object.entries(steps)) {
  if (only && only !== name) continue;
  await step();
}
