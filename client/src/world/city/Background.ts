import { Color, Group, Matrix4, Quaternion, type Scene, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { loadGLTF, loadJSON } from '../engine/assets';
import { InstancedModel } from '../engine/instancer';
import { perInstanceEmission } from '../engine/materials';
import { INLAND_SKYLINE, SKYLINE, STREETS_NS } from './layout';

// The city around the district: rows of low Deco/MiMo street buildings on the
// blocks beside and behind the plots, and a skyline of towers across the bay.
// Everything is instanced and tinted from the kit's pastel palette; windows
// light up at dusk, a different share per building.

const BASE = '/assets/buildings/';
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

    // No filler blocks: the island is the 32 plots. Only the skylines across the bays remain.
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

    await this.spread(ids('tower'), towerSpots, TOWER_TINTS, r, false);
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
