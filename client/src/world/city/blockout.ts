import { BoxGeometry, BufferGeometry, Color, Group, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn,
  float,
  floor,
  fract,
  hash,
  mix,
  normalWorld,
  abs,
  positionWorld,
  step,
  uniform,
  vec3,
} from 'three/tsl';
import { SKYLINE } from './layout';

// Stand-ins used until the buildings kit arrives: background blocks around the
// district and a skyline across the bay. Window grids are procedural, lit at
// random at dusk and night.

export const windowsLevel = uniform(0);

function towerMaterial(tint: Color, floorH: number, bayW: number) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.05 });
  const p = positionWorld;
  const side = step(abs(normalWorld.y), float(0.5));
  const u = mix(p.x, p.z, step(0.5, abs(normalWorld.x)));
  const cellU = u.div(bayW);
  const cellV = p.y.div(floorH);
  const f = vec3(fract(cellU), fract(cellV), 0);
  const isWindow = step(0.18, f.x).mul(step(f.x, 0.82)).mul(step(0.25, f.y)).mul(step(f.y, 0.85));
  const id = hash(floor(cellU).mul(31.7).add(floor(cellV).mul(7.3)).add(floor(p.x.add(p.z).mul(0.01)).mul(13.1)));
  const lit = step(0.55, id).mul(windowsLevel);
  const base = vec3(tint.r, tint.g, tint.b);
  const glass = vec3(0.12, 0.16, 0.22);
  const win = isWindow.mul(side);
  m.colorNode = mix(base, glass, win.mul(0.85));
  m.roughnessNode = mix(float(0.7), float(0.12), win);
  m.emissiveNode = Fn(() => vec3(1.0, 0.78, 0.5).mul(win.mul(lit).mul(2.2)))();
  return m;
}

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

export function buildSkyline(): Group {
  const g = new Group();
  g.name = 'skyline';
  const rnd = seeded(11);
  const tints = [0xf3efe6, 0xe9f0f2, 0xf5e2d6, 0xdfeaf0, 0xf2e8d0];
  const parts: Record<number, BufferGeometry[]> = {};
  for (let i = 0; i < 70; i++) {
    const x = SKYLINE.x0 + 30 + rnd() * 380;
    const z = SKYLINE.z0 + 40 + rnd() * (SKYLINE.z1 - SKYLINE.z0 - 80);
    const near = 1 - (x - SKYLINE.x0) / 420;
    const h = 30 + rnd() * 90 + near * 40;
    const w = 14 + rnd() * 16;
    const d = 14 + rnd() * 16;
    const box = new BoxGeometry(w, h, d);
    box.translate(x, h / 2, z);
    const t = Math.floor(rnd() * tints.length);
    (parts[t] ??= []).push(box);
  }
  for (const [t, geos] of Object.entries(parts)) {
    const mesh = new Mesh(mergeGeometries(geos), towerMaterial(new Color(tints[Number(t)]), 3.4, 3.2));
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

/** Low pastel blocks around the district so it sits in a city. */
export function buildBackgroundBlocks(): Group {
  const g = new Group();
  g.name = 'blocks';
  const rnd = seeded(5);
  const tints = [0xf7c8c0, 0xbfe8dc, 0xf9e2a6, 0xc6dcf5, 0xe1cdf2, 0xf6d3b0];
  const parts: Record<number, BufferGeometry[]> = {};
  const add = (x: number, z: number, w: number, d: number, h: number) => {
    const b = new BoxGeometry(w, h, d);
    b.translate(x, h / 2, z);
    const t = Math.floor(rnd() * tints.length);
    (parts[t] ??= []).push(b);
  };
  // West and east of the district, and inland behind it.
  for (const side of [-1, 1]) {
    for (let z = 6; z < 220; z += 26) {
      for (let k = 0; k < 3; k++) {
        const x = side * (78 + k * 26) + (rnd() - 0.5) * 3;
        if (side > 0 && x > 118) continue;
        add(x, z + (rnd() - 0.5) * 3, 18 + rnd() * 4, 14 + rnd() * 3, 7 + rnd() * 10);
      }
    }
  }
  for (let z = 118; z < 240; z += 26) for (let x = -42; x <= 42; x += 26) add(x + (rnd() - 0.5) * 3, z, 18 + rnd() * 4, 14 + rnd() * 3, 8 + rnd() * 12);
  for (const [t, geos] of Object.entries(parts)) {
    const mesh = new Mesh(mergeGeometries(geos), towerMaterial(new Color(tints[Number(t)]), 3.2, 2.8));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}
