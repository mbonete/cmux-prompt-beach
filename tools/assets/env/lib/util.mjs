// Shared helpers for the environment asset pipeline.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const run = promisify(execFile);
export const ENV_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(ENV_DIR, '../../..');

export async function loadConfig() {
  return JSON.parse(await readFile(path.join(ENV_DIR, 'config.json'), 'utf8'));
}

export const abs = (p) => path.resolve(ROOT, p);
export const rel = (p) => path.relative(ROOT, p);
export const exists = (p) => stat(p).then(() => true, () => false);

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function fileBytes(file) {
  return (await stat(file)).size;
}

export async function listFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

/** Runs a Blender script headless; args after `--` go to the script. */
export async function blender(script, args = [], { quiet = true } = {}) {
  const argv = ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', script, '--', ...args];
  try {
    const { stdout } = await run('blender', argv, { maxBuffer: 1 << 28 });
    if (!quiet) process.stdout.write(stdout);
    return stdout;
  } catch (err) {
    process.stderr.write(err.stdout ?? '');
    process.stderr.write(err.stderr ?? '');
    throw new Error(`Blender script failed: ${path.basename(script)}`);
  }
}

export const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
export const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
