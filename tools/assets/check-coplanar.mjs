// Checks the 3D assets for z-fighting surfaces (see coplanar.mjs). Prints every
// case and exits 1 if any remain; --fix separates them and writes the files.
//
//   node tools/assets/check-coplanar.mjs [--fix] [files…]

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { LIFT, findCoplanar, separateCoplanar } from './coplanar.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../public/assets');
const args = process.argv.slice(2);
const fix = args.includes('--fix');
let files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === 'characters' ? [] : walk(path.join(dir, e.name))) : /\.(gltf|glb)$/.test(e.name) ? [path.join(dir, e.name)] : [],
    );
  files = walk(ROOT);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
let total = 0;
for (const file of files) {
  const doc = await io.read(file);
  const { tris, prims, pairs, lifted } = fix ? separateCoplanar(doc) : findCoplanar(doc);
  const rel = path.relative(ROOT, file);
  if (!pairs.length) {
    console.log(`ok   ${rel}`);
    continue;
  }
  total += pairs.length;
  console.log(`${fix ? 'FIX ' : 'FAIL'} ${rel}: ${pairs.length} overlapping coplanar triangle pairs`);
  const byParts = new Map();
  for (const [i, j] of pairs) {
    const pa = prims[tris[i].prim];
    const pb = prims[tris[j].prim];
    const label = [`${pa.part} (${pa.mat})`, `${pb.part} (${pb.mat})`].sort().join('  x  ');
    const e = byParts.get(label) || byParts.set(label, { count: 0, at: tris[i].a }).get(label);
    e.count++;
  }
  for (const [label, e] of [...byParts].sort((p, q) => q[1].count - p[1].count).slice(0, 12)) {
    console.log(`     ${String(e.count).padStart(5)}  ${label}  near (${e.at.map((x) => x.toFixed(2)).join(', ')})`);
  }
  if (fix) {
    await io.write(file, doc);
    console.log(`     lifted ${lifted} part(s) by ${LIFT * 1000} mm`);
  }
}
console.log(total ? `\n${total} overlapping coplanar pairs${fix ? ' (separated)' : ''}` : '\nno z-fighting surfaces');
process.exit(total && !fix ? 1 : 0);
