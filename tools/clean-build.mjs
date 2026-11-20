// Removes the previous client bundle before `vite build`, so stale hashed files
// never pile up in the committed public/ folder. Assets and fonts are untouched.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'public/build'), { recursive: true, force: true });
await rm(path.join(root, 'public/index.html'), { force: true });
