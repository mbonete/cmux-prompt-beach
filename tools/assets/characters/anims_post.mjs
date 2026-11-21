// Post-process the Blender-baked animation glTF of one gender:
//  - keep rotation tracks for every bone, translation only on the root (Bip01), no scale
//  - drop tracks that never leave the rest pose (three.js blends missing tracks to rest)
//  - error-bounded keyframe reduction (Ramer-Douglas-Peucker on slerp / lerp)
//  - rotations stored as normalized int16 (core glTF), translations float32
//  - add a skin listing the joints, so loaders create real bones (no mesh is shipped)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'Bip01';
const DEG = Math.PI / 180;

// angular tolerance per bone family (radians); translation tolerance in metres
export const TOL = {
  root: 0.08 * DEG,
  spine: 0.15 * DEG,
  limb: 0.2 * DEG,
  finger: 0.6 * DEG,
  face: 0.6 * DEG,
  rootPos: 0.0015,
};

function family(name) {
  if (name === ROOT || name === 'Bip01 Pelvis') return 'root';
  if (/Finger/.test(name)) return 'finger';
  if (/Spine|Neck|Head$|Clavicle/.test(name)) return 'spine';
  if (/Thigh|Calf|Foot|Toe|UpperArm|Forearm|Hand/.test(name)) return 'limb';
  return 'face';
}

function quatAngle(a, ai, b, bi) {
  const d = Math.abs(a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3]);
  return 2 * Math.acos(Math.min(1, d));
}

function slerp(a, ai, b, bi, t, out) {
  let ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0 = 1 - t, s1 = t;
  if (cos < 0.9995) {
    const th = Math.acos(cos), sn = Math.sin(th);
    s0 = Math.sin((1 - t) * th) / sn;
    s1 = Math.sin(t * th) / sn;
  }
  out[0] = s0 * ax + s1 * bx; out[1] = s0 * ay + s1 * by;
  out[2] = s0 * az + s1 * bz; out[3] = s0 * aw + s1 * bw;
  const l = Math.hypot(out[0], out[1], out[2], out[3]);
  for (let k = 0; k < 4; k++) out[k] /= l;
  return out;
}

// RDP: keep the sample with the largest interpolation error until all are within tol
function reduce(times, vals, size, tol) {
  const n = times.length;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tmp = new Float64Array(4);
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (times[i] - times[a]) / (times[b] - times[a]);
      let err;
      if (size === 4) {
        slerp(vals, a * 4, vals, b * 4, t, tmp);
        err = quatAngle(tmp, 0, vals, i * 4);
      } else {
        err = 0;
        for (let k = 0; k < size; k++) {
          const v = vals[a * size + k] + (vals[b * size + k] - vals[a * size + k]) * t;
          err += (v - vals[i * size + k]) ** 2;
        }
        err = Math.sqrt(err);
      }
      if (err > worst) { worst = err; wi = i; }
    }
    if (worst > tol) {
      keep[wi] = 1;
      stack.push([a, wi], [wi, b]);
    }
  }
  const idx = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

function worldMatrices(doc) {
  // column-major 4x4 world rest matrices for every node under the scene
  const out = new Map();
  const mul = (a, b) => {
    const r = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k];
    return r;
  };
  const visit = (node, parent) => {
    const m = mul(parent, node.getMatrix());
    out.set(node, m);
    for (const c of node.listChildren()) visit(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const s of doc.getRoot().listScenes()) for (const c of s.listChildren()) visit(c, I);
  return out;
}

function invertAffine(m) {
  // inverse of a rigid (rotation + translation) column-major matrix
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const t = [m[12], m[13], m[14]];
  r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
  r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
  r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return r;
}

export function cleanNodeTransforms(doc) {
  for (const node of doc.getRoot().listNodes()) {
    const s = node.getScale();
    if (s.every((v) => Math.abs(v - 1) < 1e-4)) node.setScale([1, 1, 1]);
    const r = node.getRotation();
    const l = Math.hypot(...r);
    node.setRotation(r.map((v) => v / l));
  }
}

export async function postAnims(rawPath, outPath, { clipOrder } = {}) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(rawPath);
  const root = doc.getRoot();
  cleanNodeTransforms(doc);
  const buffer = root.listBuffers()[0];
  const report = {};
  for (const anim of root.listAnimations()) {
    const name = anim.getName();
    let keysBefore = 0, keysAfter = 0, maxErr = 0;
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      const pathName = ch.getTargetPath();
      const sampler = ch.getSampler();
      if (pathName === 'scale' || (pathName === 'translation' && node.getName() !== ROOT)) {
        ch.dispose();
        sampler.dispose();
        continue;
      }
      const input = sampler.getInput();
      const output = sampler.getOutput();
      const times = input.getArray();
      const size = pathName === 'rotation' ? 4 : 3;
      const vals = Float64Array.from(output.getArray());
      if (size === 4) {
        // sign continuity
        for (let i = 1; i < times.length; i++) {
          const d = vals[i * 4] * vals[i * 4 - 4] + vals[i * 4 + 1] * vals[i * 4 - 3] + vals[i * 4 + 2] * vals[i * 4 - 2] + vals[i * 4 + 3] * vals[i * 4 - 1];
          if (d < 0) for (let k = 0; k < 4; k++) vals[i * 4 + k] = -vals[i * 4 + k];
        }
      }
      keysBefore += times.length;
      const fam = family(node.getName());
      const tol = size === 4 ? TOL[fam] : TOL.rootPos;
      // drop tracks that stay at the rest value for the whole clip
      if (size === 4 && node.getName() !== ROOT) {
        const rest = node.getRotation();
        let dev = 0;
        for (let i = 0; i < times.length; i++) dev = Math.max(dev, quatAngle(rest, 0, vals, i * 4));
        if (dev <= tol) {
          ch.dispose();
          sampler.dispose();
          continue;
        }
      }
      let idx = reduce(times, vals, size, tol);
      keysAfter += idx.length;
      const t2 = new Float32Array(idx.map((i) => times[i]));
      let out2;
      if (size === 4) {
        out2 = new Int16Array(idx.length * 4);
        idx.forEach((i, j) => {
          const l = Math.hypot(vals[i * 4], vals[i * 4 + 1], vals[i * 4 + 2], vals[i * 4 + 3]);
          for (let k = 0; k < 4; k++) out2[j * 4 + k] = Math.round((vals[i * 4 + k] / l) * 32767);
        });
      } else {
        out2 = new Float32Array(idx.length * 3);
        idx.forEach((i, j) => { for (let k = 0; k < 3; k++) out2[j * 3 + k] = vals[i * 3 + k]; });
      }
      const inAcc = doc.createAccessor().setType('SCALAR').setArray(t2).setBuffer(buffer);
      const outAcc = doc.createAccessor().setType(size === 4 ? 'VEC4' : 'VEC3').setArray(out2).setBuffer(buffer);
      if (size === 4) outAcc.setNormalized(true);
      sampler.setInput(inAcc).setOutput(outAcc).setInterpolation('LINEAR');
      // measured worst error after quantization, against every original frame
      const q = new Float64Array(4);
      let j = 0;
      for (let i = 0; i < times.length; i++) {
        while (j < idx.length - 2 && times[idx[j + 1]] < times[i]) j++;
        const a = idx[j], b = idx[j + 1] ?? idx[j];
        const t = b === a ? 0 : (times[i] - times[a]) / (times[b] - times[a]);
        if (size === 4) {
          const qa = Float64Array.from(out2.slice(j * 4, j * 4 + 4), (v) => v / 32767);
          const qb = Float64Array.from(out2.slice((j + 1 < idx.length ? j + 1 : j) * 4, (j + 1 < idx.length ? j + 1 : j) * 4 + 4), (v) => v / 32767);
          slerp(qa, 0, qb, 0, t, q);
          maxErr = Math.max(maxErr, quatAngle(q, 0, vals, i * 4) / DEG);
        }
      }
    }
    report[name] = { keysBefore, keysAfter, maxErrDeg: +maxErr.toFixed(3), channels: anim.listChannels().length };
  }
  // order animations like the canonical clip table
  if (clipOrder) {
    const anims = root.listAnimations();
    for (const a of anims) if (!clipOrder.includes(a.getName())) throw new Error(`unexpected clip ${a.getName()}`);
  }
  // skin: every bone under the rig, inverse bind = inverse world rest
  const rig = root.listNodes().find((n) => n.getName() === 'Rig');
  const bones = [];
  const collect = (n) => { bones.push(n); n.listChildren().forEach(collect); };
  collect(root.listNodes().find((n) => n.getName() === ROOT));
  const world = worldMatrices(doc);
  const ibm = new Float32Array(bones.length * 16);
  bones.forEach((b, i) => ibm.set(invertAffine(world.get(b)), i * 16));
  const skin = doc.createSkin('skeleton').setSkeleton(rig)
    .setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
  bones.forEach((b) => skin.addJoint(b));
  await doc.transform(
    prune({ keepLeaves: true, keepAttributes: true, propertyTypes: ['Accessor', 'AnimationSampler', 'AnimationChannel', 'Material', 'Texture', 'Mesh', 'Camera'] }),
    dedup({ propertyTypes: ['Accessor'] }),
  );
  // the .bin is named after the gltf
  const base = outPath.split('/').pop().replace(/\.gltf$/, '');
  root.listBuffers()[0].setURI(base + '.bin');
  await writeGltf(io, doc, outPath);
  return { report, joints: bones.map((b) => b.getName()) };
}

/** Write .gltf (minified JSON) + resources next to it. */
export async function writeGltf(io, doc, outPath) {
  const { json, resources } = await io.writeJSON(doc, { basename: path.basename(outPath, '.gltf') });
  const dir = path.dirname(outPath);
  await mkdir(dir, { recursive: true });
  await writeFile(outPath, JSON.stringify(json));
  for (const [uri, data] of Object.entries(resources)) {
    await mkdir(path.dirname(path.join(dir, uri)), { recursive: true });
    await writeFile(path.join(dir, uri), data);
  }
}

// allow `node anims_post.mjs raw.gltf out.gltf`
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await postAnims(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(r.report, null, 1));
}

