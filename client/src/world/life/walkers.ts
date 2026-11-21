import {
  type AnimationAction,
  AnimationMixer,
  type BufferAttribute,
  type Camera,
  Group,
  LoopRepeat,
  Matrix3,
  Matrix4,
  Mesh,
  type Object3D,
  type SkinnedMesh,
  Vector3,
} from 'three/webgpu';
import type { Cast, Skeleton } from '../agents/cast';
import { BAY_EDGE_X, PROMENADE } from '../city/layout';
import { beachHeight } from '../env/ground';
import type { Towel } from './dressing';
import { angleDiff, inHangout, rng, shuffle, type Spots } from './util';

// People out for a walk on the promenade and along the wet sand, plus a few
// sunbathers on towels. They are scenery, not agents: no tags, never on a
// plot, never clickable. Cast avatars at their light LOD only, the in-place
// walk clip moved along a closed loop at the clip's own speed so the feet
// stay planted; animation updates thin out with distance.

const PROM_Y = 0.16;

class Loop {
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly cum: number[] = [0];
  readonly length: number;
  constructor(
    pts: [number, number][],
    readonly ground: (x: number, z: number) => number,
  ) {
    for (const [x, z] of pts) {
      this.x.push(x);
      this.z.push(z);
    }
    this.x.push(pts[0][0]);
    this.z.push(pts[0][1]);
    for (let i = 1; i < this.x.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]));
    this.length = this.cum[this.cum.length - 1];
  }
  at(s: number, out: { x: number; z: number; yaw: number }) {
    s = ((s % this.length) + this.length) % this.length;
    const c = this.cum;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = (s - c[lo]) / (c[hi] - c[lo] || 1);
    const dx = this.x[hi] - this.x[lo];
    const dz = this.z[hi] - this.z[lo];
    out.x = this.x[lo] + dx * t;
    out.z = this.z[lo] + dz * t;
    out.yaw = Math.atan2(dx, dz);
  }
}

/** A stadium-shaped loop: out along lane a, back along lane b, half circles at the ends. */
function stadium(x0: number, x1: number, za: number, zb: number, ground: Loop['ground']) {
  const pts: [number, number][] = [];
  const r = Math.abs(za - zb) / 2;
  const cz = (za + zb) / 2;
  const sgn = za > zb ? 1 : -1;
  const step = 3;
  for (let x = x0; x < x1; x += step) pts.push([x, za]);
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI;
    pts.push([x1 + r * Math.sin(a), cz + sgn * r * Math.cos(a)]);
  }
  for (let x = x1 - step; x > x0; x -= step) pts.push([x, zb]);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI;
    pts.push([x0 - r * Math.sin(a), cz - sgn * r * Math.cos(a)]);
  }
  return new Loop(pts, ground);
}

interface Person {
  avatar: string;
  root: Group;
  meshes: (SkinnedMesh | Mesh)[];
  shadows: boolean;
  mixer: AnimationMixer | null;
  action: AnimationAction | null;
  ready: boolean;
  loading: boolean;
  active: boolean;
  acc: number;
  frame: number;
}

interface Walker extends Person {
  loop: Loop;
  s: number;
  speed: number;
  yaw: number;
}

interface Bather extends Person {
  towel: Towel;
}

const at = { x: 0, z: 0, yaw: 0 };

export class Walkers {
  readonly group = new Group();
  private walkers: Walker[] = [];
  private bathers: Bather[] = [];
  private density = 1;
  private reduced = false;

  constructor(
    private readonly cast: Cast,
    private readonly obstacles: Spots,
    private readonly towels: () => Towel[],
  ) {
    this.group.name = 'life/people';
  }

  build(maxWalkers: number, maxBathers: number) {
    const r = rng(211);
    const ids = this.cast.ids.filter((id) => !/Business/.test(id));
    const prefer = shuffle(r, ids.filter((id) => /Sports|Party/.test(id))).concat(shuffle(r, ids.filter((id) => !/Sports|Party/.test(id))));
    const avatars = prefer.slice(0, Math.min(7, prefer.length));
    if (!avatars.length) return;

    // A loop end must not swing round a palm or a lamp on the promenade's middle line.
    const clearEnd = (x: number, za: number, zb: number, outward: number) => {
      const rad = Math.abs(za - zb) / 2;
      const cz = (za + zb) / 2;
      for (let i = 0; i <= 12; i++) {
        const a = (i / 12) * Math.PI;
        if (this.obstacles.near(x + outward * rad * Math.sin(a), cz + rad * Math.cos(a), 1.3)) return false;
      }
      return true;
    };
    const promA = PROMENADE.z1 - 1.3;
    const promB = PROMENADE.z0 + 2.6;
    const beachA = -57.6;
    const beachB = -60.8;
    const groundProm = () => PROM_Y;
    const groundBeach = (x: number, z: number) => beachHeight(z, x);
    for (let i = 0; i < maxWalkers; i++) {
      const beach = i % 3 === 2;
      let x0 = 0;
      let x1 = 0;
      for (let tries = 0; tries < 40; tries++) {
        const len = 40 + r() * 80;
        x0 = -170 + r() * (BAY_EDGE_X - 50 + 170 - len);
        x1 = x0 + len;
        const za = beach ? beachA : promA;
        const zb = beach ? beachB : promB;
        if (beach && (inHangout(x0, beachA, 1.5) || inHangout(x1, beachA, 1.5))) continue;
        if (clearEnd(x0, za, zb, -1) && clearEnd(x1, za, zb, 1)) break;
      }
      const loop = beach ? stadium(x0, x1, beachA, beachB, groundBeach) : stadium(x0, x1, promA, promB, groundProm);
      const avatar = avatars[i % avatars.length];
      const root = new Group();
      root.name = 'life/walker';
      this.group.add(root);
      this.walkers.push({ avatar, root, meshes: [], shadows: true, mixer: null, action: null, ready: false, loading: false, active: false, acc: 0, frame: i, loop, s: r() * loop.length, speed: 1, yaw: 0 });
    }

    const pool = this.towels();
    const picks = shuffle(r, pool.slice()).slice(0, maxBathers);
    picks.forEach((towel, i) => {
      towel.taken = true;
      const root = new Group();
      root.name = 'life/sunbather';
      this.group.add(root);
      this.bathers.push({ avatar: avatars[(i + 3) % avatars.length], root, meshes: [], shadows: true, mixer: null, action: null, ready: false, loading: false, active: false, acc: 0, frame: i, towel });
    });
    this.setDensity(this.density);
  }

  private async load(p: Person, clip: 'walk' | 'sleep') {
    if (p.loading || p.ready) return;
    p.loading = true;
    try {
      const skeleton = this.cast.info(p.avatar).skeleton as Skeleton;
      const [model, clips] = await Promise.all([this.cast.avatar(p.avatar), this.cast.clips(skeleton)]);
      const lod0 = model.getObjectByName('lod0');
      lod0?.removeFromParent();
      model.traverse((o: Object3D) => {
        const sm = o as SkinnedMesh;
        if (!sm.isSkinnedMesh) return;
        sm.castShadow = true;
        sm.receiveShadow = true;
        p.meshes.push(sm);
      });
      p.root.add(model);
      p.mixer = new AnimationMixer(model);
      const c = clips.get(clip) ?? clips.get('idle');
      if (c) {
        p.action = p.mixer.clipAction(c);
        p.action.setLoop(LoopRepeat, Infinity);
        p.action.play();
        p.action.time = Math.random() * c.duration;
      }
      if ('loop' in p) {
        const w = p as Walker;
        const base = this.cast.clipInfo(skeleton, 'walk')?.speed ?? 1.1;
        const k = 0.92 + ((w.frame * 37) % 17) / 100;
        w.speed = base * k;
        p.action?.setEffectiveTimeScale(k);
      }
      p.mixer.update(0);
      if (clip === 'sleep') {
        // Someone asleep in the sun never moves: freeze the pose into plain meshes (no skinning per frame).
        p.mixer.update(1.3);
        model.updateMatrixWorld(true);
        p.meshes = p.meshes.map((sm) => freeze(sm as SkinnedMesh));
        p.mixer.stopAllAction();
        p.mixer = null;
        p.action = null;
      }
      p.ready = true;
    } catch (err) {
      console.warn('Background walker failed to load:', err);
    } finally {
      p.loading = false;
    }
  }

  setDensity(d: number) {
    this.density = d;
    const nw = Math.round(this.walkers.length * Math.pow(d, 1.4));
    const nb = Math.round(this.bathers.length * d);
    this.walkers.forEach((w, i) => {
      w.active = i < nw;
      w.root.visible = w.active;
      if (w.active) void this.load(w, 'walk');
    });
    this.bathers.forEach((b, i) => {
      b.active = i < nb;
      b.root.visible = b.active;
      if (b.active) {
        void this.load(b, 'sleep');
        const t = b.towel;
        b.root.position.set(t.x, t.y + 0.03, t.z);
        b.root.rotation.y = t.yaw;
      }
    });
    this.place(0);
  }

  setReducedMotion(on: boolean) {
    this.reduced = on;
  }

  private place(dt: number) {
    for (const w of this.walkers) {
      if (!w.active) continue;
      w.s += w.speed * dt;
      w.loop.at(w.s, at);
      w.root.position.set(at.x, w.loop.ground(at.x, at.z), at.z);
      w.yaw += dt > 0 ? angleDiff(w.yaw, at.yaw) * Math.min(1, dt * 6) : angleDiff(w.yaw, at.yaw);
      w.root.rotation.y = w.yaw;
    }
  }

  update(dt: number, camera: Camera) {
    if (this.reduced) return;
    this.place(dt);
    const cam = camera.position;
    for (const p of this.walkers) {
      if (!p.active || !p.ready || !p.mixer) continue;
      p.acc += dt;
      p.frame++;
      const d = cam.distanceTo(p.root.position);
      // Shadows only where they can be seen; skinned shadow draws are not free.
      const shadows = d < 75;
      if (shadows !== p.shadows) {
        p.shadows = shadows;
        for (const m of p.meshes) m.castShadow = shadows;
      }
      const every = d < 45 ? 1 : d < 100 ? 2 : d < 220 ? 4 : 8;
      if (p.frame % every !== 0) continue;
      p.mixer.update(p.acc);
      p.acc = 0;
    }
  }
}

const bv = new Vector3();
const bn = new Vector3();
const acc = new Vector3();
const m4 = new Matrix4();
const m3 = new Matrix3();
const bind3 = new Matrix3();
const inv3 = new Matrix3();

/** Bakes a skinned mesh's current pose into a static mesh in the same place. */
function freeze(sm: SkinnedMesh): Mesh {
  const g = sm.geometry.clone();
  const pos = g.attributes.position as BufferAttribute;
  const nrm = g.attributes.normal as BufferAttribute | undefined;
  const si = g.attributes.skinIndex as BufferAttribute;
  const sw = g.attributes.skinWeight as BufferAttribute;
  const bones = sm.skeleton.bones;
  const inverses = sm.skeleton.boneInverses;
  bind3.setFromMatrix4(sm.bindMatrix);
  inv3.setFromMatrix4(sm.bindMatrixInverse);
  for (let i = 0; i < pos.count; i++) {
    sm.getVertexPosition(i, bv);
    pos.setXYZ(i, bv.x, bv.y, bv.z);
    if (!nrm) continue;
    bn.fromBufferAttribute(nrm, i).applyMatrix3(bind3);
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w === 0) continue;
      const b = si.getComponent(i, k);
      m4.multiplyMatrices(bones[b].matrixWorld, inverses[b]);
      acc.addScaledVector(bv.copy(bn).applyMatrix3(m3.setFromMatrix4(m4)), w);
    }
    acc.applyMatrix3(inv3).normalize();
    nrm.setXYZ(i, acc.x, acc.y, acc.z);
  }
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  g.computeBoundingSphere();
  const mesh = new Mesh(g, sm.material);
  mesh.name = sm.name;
  mesh.position.copy(sm.position);
  mesh.quaternion.copy(sm.quaternion);
  mesh.scale.copy(sm.scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  sm.parent?.add(mesh);
  sm.removeFromParent();
  return mesh;
}
