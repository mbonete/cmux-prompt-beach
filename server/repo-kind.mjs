// What kind of project a repository is, for the icon on its plot's name tag:
// web, mobile, docs, data or other. Looks only at a handful of entries directly in
// the repo root (never follows symlinks, never descends into folders), caps every
// read, and gives up after a short timeout.

import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { withTimeout } from './util.mjs';

export const REPO_KINDS = ['web', 'mobile', 'docs', 'data', 'other'];

const CACHE_TTL_MS = 10 * 60 * 1000;
const RETRY_TTL_MS = 60 * 1000; // after a timeout or error, try again sooner
const DETECT_TIMEOUT_MS = 1500;
const MAX_ENTRIES = 1000;
const MAX_MANIFEST_BYTES = 512 * 1024;

const MOBILE_DEPS = ['expo', 'react-native', '@capacitor/core', '@nativescript/core'];
const DOCS_DEPS = ['@docusaurus/core', 'vitepress', 'nextra', 'nextra-theme-docs', '@astrojs/starlight', 'docsify', 'docsify-cli', 'vuepress', '@vuepress/core', 'mintlify'];
const WEB_DEPS = [
  'react', 'react-dom', 'next', 'vite', 'svelte', '@sveltejs/kit', 'vue', 'nuxt', 'astro', '@angular/core',
  'solid-js', 'preact', '@remix-run/react', 'gatsby', 'lit', 'ember-source', '@builder.io/qwik',
];
const DOCS_FILES = ['mkdocs.yml', 'mkdocs.yaml', 'docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docusaurus.config.cjs', 'book.toml', 'antora.yml', 'summary.md', '_quarto.yml'];
const DATA_FILES = ['dbt_project.yml'];
const DATA_DIRS = ['notebooks', 'dags'];
const PY_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'environment.yml', 'environment.yaml', 'pipfile', 'setup.cfg', 'setup.py'];
const DATA_PY = /(?:^|[^a-z0-9_.-])(pandas|polars|dbt-[a-z]+|dbt|apache-airflow|airflow|dagster|prefect|pyspark|duckdb|scikit-learn|sklearn|jupyter|jupyterlab|notebook|great[-_]expectations|mlflow|sqlmesh|meltano|kedro|luigi)(?:[^a-z0-9_-]|$)/m;
const ANDROID_GRADLE = /com\.android\.(?:application|library)|org\.jetbrains\.kotlin\.android|plugins\.android\.application/;
const WEB_PY =/(?:^|[^a-z0-9_.-])(django|flask|fastapi|starlette)(?:[^a-z0-9_-]|$)/m;
const CODE_MANIFESTS = ['package.json', 'go.mod', 'cargo.toml', 'gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'mix.exs', 'package.swift', ...PY_MANIFESTS];
const PROSE_EXT = new Set(['.md', '.mdx', '.markdown', '.rst', '.adoc', '.txt', '.tex']);

// Lists the root's direct children (lower-cased name -> 'file' | 'dir'), skipping symlinks.
async function listRoot(root) {
  const entries = new Map();
  const dir = await opendir(root);
  try {
    for await (const d of dir) {
      if (entries.size >= MAX_ENTRIES) break;
      if (d.isSymbolicLink()) continue;
      if (d.isFile()) entries.set(d.name.toLowerCase(), { type: 'file', name: d.name });
      else if (d.isDirectory()) entries.set(d.name.toLowerCase(), { type: 'dir', name: d.name });
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return entries;
}

// Reads a small regular file directly inside root, refusing symlinks and anything too large.
async function readSmall(root, name, max = MAX_MANIFEST_BYTES) {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return null;
  let fh;
  try {
    fh = await open(path.join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    await fh.read(buf, 0, st.size, 0);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function depsOf(pkgText) {
  if (!pkgText) return new Set();
  try {
    const pkg = JSON.parse(pkgText);
    const names = new Set();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg?.[field];
      if (deps && typeof deps === 'object') for (const k of Object.keys(deps)) names.add(k);
    }
    return names;
  } catch {
    return new Set();
  }
}

const hasAny = (set, list) => list.some((x) => set.has(x));

async function detect(rootIn) {
  const root = await realpath(rootIn);
  if (!(await stat(root)).isDirectory()) return 'other';
  const entries = await listRoot(root);
  const file = (n) => entries.get(n)?.type === 'file';
  const dir = (n) => entries.get(n)?.type === 'dir';
  const read = (n) => (file(n) ? readSmall(root, entries.get(n).name) : Promise.resolve(null));

  const deps = depsOf(await read('package.json'));

  // 1. Mobile: React Native / Expo / Capacitor, native project folders, Flutter.
  if (hasAny(deps, MOBILE_DEPS) || deps.has('@ionic/react') || deps.has('@ionic/angular')) return 'mobile';
  if (dir('ios') || dir('android') || file('pubspec.yaml')) return 'mobile';
  // A native Android app whose Gradle build sits at the root (the app module is in app/).
  for (const name of ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle']) {
    if (file(name) && ANDROID_GRADLE.test((await read(name)) || '')) return 'mobile';
  }
  if (file('app.json')) {
    const app = await read('app.json');
    try {
      const j = JSON.parse(app || 'null');
      if (j && typeof j === 'object' && (j.expo || j.displayName)) return 'mobile';
    } catch {
      // Not JSON we understand (Heroku's app.json, for example): not a signal.
    }
  }

  // 2. Docs site generators that are also React/Vue apps.
  if (hasAny(deps, DOCS_DEPS)) return 'docs';

  // 3. Web frameworks.
  if (hasAny(deps, WEB_DEPS)) return 'web';

  // 4. Data: notebooks, dbt, Airflow, Python data libraries.
  if (DATA_FILES.some(file) || DATA_DIRS.some(dir)) return 'data';
  for (const [name, entry] of entries) {
    if (entry.type === 'file' && (name.endsWith('.ipynb') || name.endsWith('.rproj'))) return 'data';
  }
  let pyText = '';
  for (const name of PY_MANIFESTS) if (file(name)) pyText += `\n${(await read(name)) || ''}`;
  pyText = pyText.toLowerCase();
  if (DATA_PY.test(pyText)) return 'data';

  // 5. Docs by config file, or a repo of prose with no code manifest.
  if (DOCS_FILES.some(file) || dir('book')) return 'docs';
  if (file('conf.py') && file('index.rst')) return 'docs';
  const hasManifest = CODE_MANIFESTS.some(file);
  if (!hasManifest) {
    let prose = 0;
    let other = 0;
    for (const [name, entry] of entries) {
      if (entry.type !== 'file' || name.startsWith('.') || name === 'license' || name.startsWith('license.')) continue;
      if (PROSE_EXT.has(path.extname(name))) prose += 1;
      else other += 1;
    }
    if (prose >= 3 && prose > other) return 'docs';
  }

  // 6. Other web signals: server-side web frameworks, a bare static site.
  if (WEB_PY.test(pyText)) return 'web';
  if (file('gemfile') && /\brails\b/.test(((await read('gemfile')) || '').toLowerCase())) return 'web';
  if (file('index.html')) return 'web';

  return 'other';
}

// Detects a repo's kind. Never throws; anything unexpected is 'other'.
export async function detectRepoKind(root, { timeoutMs = DETECT_TIMEOUT_MS } = {}) {
  if (!root || typeof root !== 'string' || !path.isAbsolute(root)) return 'other';
  return withTimeout(detect(root).catch(() => 'other'), timeoutMs, 'other');
}

// A detector with a per-root cache (10 minutes; 1 minute after a failure or timeout).
export function createRepoKindCache({ ttlMs = CACHE_TTL_MS, timeoutMs = DETECT_TIMEOUT_MS, now = Date.now } = {}) {
  const cache = new Map(); // root -> { until, promise }
  return function repoKind(root) {
    const hit = cache.get(root);
    if (hit && now() < hit.until) return hit.promise;
    const entry = { until: now() + ttlMs, promise: Promise.resolve('other') };
    if (root && typeof root === 'string' && path.isAbsolute(root)) {
      // null marks an error or timeout, which is cached for a shorter time.
      entry.promise = withTimeout(detect(root).catch(() => null), timeoutMs, null).then((kind) => {
        if (kind) return kind;
        entry.until = now() + RETRY_TTL_MS;
        return 'other';
      });
    }
    cache.set(root, entry);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return entry.promise;
  };
}
