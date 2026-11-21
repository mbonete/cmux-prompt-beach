import { Color, Group, Matrix4, Quaternion, type Scene, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { loadGLTF, loadJSON } from '../engine/assets';
import { InstancedModel } from '../engine/instancer';
import { perInstanceEmission } from '../engine/materials';
import { BAY_EDGE_X, CITY, INLAND_SKYLINE, OVERFLOW, PLOT_Z, SKYLINE, STREETS_NS } from './layout';

// The city around the district: rows of low Deco/MiMo street buildings on the
// blocks beside and behind the plots, and a skyline of towers across the bay.
// Everything is instanced and tinted from the kit's pastel palette; windows
// light up at dusk, a different share per building.

const BASE = '/assets/buildings/';
const PASTELS = [0xeea8a2, 0xa6dac4, 0xf4c39c, 0xf1db98, 0xa9c8e2, 0x8fd0cb, 0xee9a84, 0xf4efe6].map((h) => new Color(h));
const TOWER_TINTS = [0xf4efe6, 0xffffff, 0xe9f0f2, 0xf3e3d3, 0xdfeaf0].map((h) => new Color(h));

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

export class Background {
  readonly group = new Group();
  readonly windowsLevel = uniform(1);
  readonly neonLevel = uniform(1);

  constructor(scene: Scene) {
    this.group.name = 'background';
    scene.add(this.group);
  }

  async load() {
    const manifest = await loadJSON<{ assets: Record<string, { kind: string }> }>(`${BASE}manifest.json`);
    const ids = (kind: string) => Object.entries(manifest.assets).filter(([, a]) => a.kind === kind).map(([id]) => id).sort();
    const r = rng(41);

    // Street buildings: one row per block, facing +Z (toward the usual camera).
    const lowSpots: Matrix4[] = [];
    // One ring of blocks around the district; the island ends soon after.
    const rows = [...PLOT_Z, 112, 138, 164].filter((z) => z < CITY.z1 - 14);
    const westAvenue = STREETS_NS[0];
    const eastAvenue = STREETS_NS[STREETS_NS.length - 1];
    const westStart = westAvenue.x - westAvenue.width / 2 - 2.2 - 11;
    const eastStart = eastAvenue.x + eastAvenue.width / 2 + 2.2 + 11;
    const place = (x: number, z: number) => {
      if (Math.abs(x - OVERFLOW.x) < 22 && Math.abs(z - OVERFLOW.z) < 16) return;
      const m = new Matrix4().compose(new Vector3(x + (r() - 0.5) * 1.5, 0, z + (r() - 0.5) * 1.2), new Quaternion(), new Vector3(1, 1, 1));
      lowSpots.push(m);
    };
    for (const z of rows) {
      for (let x = westStart; x > CITY.x0 + 10; x -= 22 + r() * 3) place(x, z);
      for (let x = eastStart; x < BAY_EDGE_X - 10; x += 22 + r() * 3) place(x, z);
      if (z > 100) for (let x = -42; x <= 42; x += 26) place(x, z);
    }

    // Skyline across the bay: taller toward the water's edge, spaced so no two touch.
    const towerSpots: Matrix4[] = [];
    const taken: Vector3[] = [];
    // And a second one across the inland bay, beyond the causeways.
    for (let i = 0; i < 300 && taken.length < 30; i++) {
      const p = new Vector3(INLAND_SKYLINE.x0 + 30 + r() * (INLAND_SKYLINE.x1 - INLAND_SKYLINE.x0 - 60), 0.4, INLAND_SKYLINE.z0 + 25 + r() * (INLAND_SKYLINE.z1 - INLAND_SKYLINE.z0 - 50));
      if (taken.some((q) => q.distanceTo(p) < 36)) continue;
      // Leave the causeway landings clear.
      if (STREETS_NS.some((a) => Math.abs(p.x - a.x) < 22) && p.z < INLAND_SKYLINE.z0 + 60) continue;
      taken.push(p);
      const near = 1 - (p.z - INLAND_SKYLINE.z0) / (INLAND_SKYLINE.z1 - INLAND_SKYLINE.z0);
      const s = 0.7 + r() * 0.35 + near * 0.2;
      towerSpots.push(new Matrix4().compose(p, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.floor(r() * 4) * (Math.PI / 2)), new Vector3(1, s, 1)));
    }
    for (let i = 0; i < 400 && towerSpots.length < 76; i++) {
      const p = new Vector3(SKYLINE.x0 + 25 + r() * 340, 0.4, SKYLINE.z0 + 40 + r() * (SKYLINE.z1 - SKYLINE.z0 - 80));
      if (taken.some((q) => q.distanceTo(p) < 34)) continue;
      taken.push(p);
      const near = 1 - (p.x - SKYLINE.x0) / 365;
      const s = 0.75 + r() * 0.35 + near * 0.25;
      towerSpots.push(new Matrix4().compose(p, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.floor(r() * 4) * (Math.PI / 2)), new Vector3(1, s, 1)));
    }

    // Only blocks beside the district cast shadows; further out they'd cost more than they show.
    const near = (m: Matrix4) => Math.abs(m.elements[12]) < 130 && m.elements[14] < 115;
    await Promise.all([
      this.spread(ids('bg'), lowSpots.filter(near), PASTELS, r),
      this.spread(ids('bg'), lowSpots.filter((m) => !near(m)), PASTELS, r, false),
      this.spread(ids('tower'), towerSpots, TOWER_TINTS, r, false),
    ]);
  }

  /** Splits placements across the building variants and instances each. */
  private async spread(variants: string[], spots: Matrix4[], tints: Color[], r: () => number, shadows = true) {
    if (!variants.length) return;
    const buckets = variants.map(() => [] as Matrix4[]);
    for (const m of spots) buckets[Math.floor(r() * variants.length)].push(m);
    await Promise.all(
      variants.map(async (id, i) => {
        const mats = buckets[i];
        if (!mats.length) return;
        const gltf = await loadGLTF(`${BASE}${id}.gltf`);
        const model = new InstancedModel(gltf.scene, mats.length, { tintable: ['stucco'], castShadow: shadows });
        for (const mesh of model.meshes) {
          const name = (mesh.material as { name?: string }).name;
          if (name === 'stucco') (mesh.material as unknown as { color: Color }).color.set(0xffffff);
        }
        mats.forEach((m) => model.add(m, tints[Math.floor(r() * tints.length)]));
        for (const mesh of model.meshes) {
          const name = (mesh.material as { name?: string }).name;
          if (name === 'interior' || name === 'neon_accent') {
            const attr = perInstanceEmission(mesh, name === 'interior' ? this.windowsLevel : this.neonLevel);
            for (let k = 0; k < mats.length; k++) attr.setX(k, 0.35 + r() * 0.65);
            attr.needsUpdate = true;
          }
        }
        model.addTo(this.group);
      }),
    );
  }
}
