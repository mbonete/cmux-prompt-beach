import { InstancedMesh, type Object3D, Vector3 } from 'three/webgpu';
import { HANGOUT, OVERFLOW, OVERFLOW_HALF, PLOTS, PLOT_D, PLOT_W } from '../city/layout';

// Shared helpers for background life: a seeded random source, the places
// nothing may stand (plots, the beach bar), and the palms already planted.

export function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export type Rand = ReturnType<typeof rng>;

export function pick<T>(r: Rand, list: readonly T[]): T {
  return list[Math.floor(r() * list.length) % list.length];
}

export function shuffle<T>(r: Rand, list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** True on any plot's 20 x 16 m footprint grown by `margin` (or on the overflow plot). */
export function onPlot(x: number, z: number, margin = 1.5): boolean {
  for (const p of PLOTS) {
    const turned = Math.abs(Math.sin(p.rot)) > 0.5;
    const hx = (turned ? PLOT_D : PLOT_W) / 2 + margin;
    const hz = (turned ? PLOT_W : PLOT_D) / 2 + margin;
    if (Math.abs(x - p.x) < hx && Math.abs(z - p.z) < hz) return true;
  }
  if (Math.abs(x - OVERFLOW.x) < OVERFLOW_HALF.x + margin && Math.abs(z - OVERFLOW.z) < OVERFLOW_HALF.z + margin) return true;
  return false;
}

/** The beach bar and its surroundings (x 4, z -44, about 14 x 12 each way). */
export function inHangout(x: number, z: number, margin = 0): boolean {
  return Math.abs(x - HANGOUT.x) < 14 + margin && Math.abs(z - HANGOUT.z) < 12 + margin;
}

/** Ground positions of the palms World planted (read back from their instances). */
export function palmPositions(scene: Object3D): Vector3[] {
  const group = scene.getObjectByName('palms');
  const out: Vector3[] = [];
  if (!group) return out;
  const seen = new Set<string>();
  const m = new Vector3();
  group.traverse((o) => {
    const im = o as InstancedMesh;
    if (!(im instanceof InstancedMesh)) return;
    const arr = im.instanceMatrix.array as Float32Array;
    for (let i = 0; i < im.count; i++) {
      m.set(arr[i * 16 + 12], arr[i * 16 + 13], arr[i * 16 + 14]);
      const key = `${Math.round(m.x * 4)},${Math.round(m.z * 4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m.clone());
    }
  });
  return out;
}

/** A coarse spatial hash for "is anything within r of here" tests. */
export class Spots {
  private readonly cells = new Map<string, Vector3[]>();
  constructor(private readonly cell = 8) {}
  add(p: Vector3) {
    const k = this.key(p.x, p.z);
    let a = this.cells.get(k);
    if (!a) this.cells.set(k, (a = []));
    a.push(p);
  }
  near(x: number, z: number, r: number): boolean {
    const c = this.cell;
    const n = Math.ceil(r / c);
    const cx = Math.floor(x / c);
    const cz = Math.floor(z / c);
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++) {
        const a = this.cells.get(`${cx + i},${cz + j}`);
        if (!a) continue;
        for (const p of a) if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) return true;
      }
    return false;
  }
  private key(x: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }
}

export function angleDiff(a: number, b: number) {
  return ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}
