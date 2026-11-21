import { Color, Group, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { BAY_EDGE_X, BEACH_ROAD, STREETS_EW, STREETS_NS, CITY } from '../city/layout';
import { beachHeight } from '../env/ground';
import { type KitModel, StaticBatch, type StreetKit } from './kit';
import { Pools } from './pools';
import { inHangout, onPlot, pick, rng, Spots } from './util';

// Static street furniture: Deco lamps (with a soft pool of light under each
// at night) along the promenade, the beach road and the streets, and on the
// sand lifeguard towers and groups of umbrellas, loungers and towels.
// Lamps are structure and stay at every quality; beach groups thin out.

const up = new Vector3(0, 1, 0);
const q = new Quaternion();
const m = new Matrix4();
const one = new Vector3(1, 1, 1);
const p = new Vector3();

const PASTEL = [0xf6b8b0, 0xa9e0cf, 0xf8d79a, 0xa8c9ec, 0xd2bdf0, 0xf7c19a, 0xb8e3a2].map((h) => new Color(h));
const CANVAS = [0xe8553f, 0x2a9d8f, 0xf2a541, 0x3d7cc9, 0xef7b98, 0x58b368, 0xf4d35e, 0x7b5ea7].map((h) => new Color(h));

export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  tint?: Color;
  /** Beach group (umbrella index) used to thin furniture together. */
  group?: number;
}

/** A towel on the sand, offered to the walkers module for sunbathers. */
export interface Towel extends Placement {
  taken?: boolean;
}

export class Dressing {
  readonly group = new Group();
  readonly lampPools: Pools;
  /** Every lamp, tower, umbrella, lounger and towel, merged: a few draws in all. */
  private readonly batch = new StaticBatch();
  private groups = 1;
  /** Everything placed so far, for the walkers and the beach groups to keep clear of. */
  readonly obstacles = new Spots(8);
  readonly towels: Towel[] = [];
  private lampCount = 0;

  constructor(
    private readonly kit: StreetKit,
    private readonly palms: Vector3[],
  ) {
    this.group.name = 'life/dressing';
    this.lampPools = new Pools(420, 'round', new Color(1.0, 0.62, 0.32).multiplyScalar(0.3));
    this.group.add(this.lampPools.mesh);
    for (const pt of palms) this.obstacles.add(pt);
  }

  async build() {
    await Promise.all([this.lamps(), this.beach()]);
    const fleet = this.batch.build(this.kit.levels, { castShadow: true, name: 'life/dressing' });
    fleet?.addTo(this.group);
  }

  /** Lamp positions: promenade (twin globes) and streets (single globe). */
  private lampSites() {
    const r = rng(53);
    const prom: Placement[] = [];
    const street: Placement[] = [];
    const palmSpots = new Spots(8);
    for (const pt of this.palms) palmSpots.add(pt);

    // Promenade: midway between promenade palms, every other gap.
    const promZ = -15.5;
    const promPalms = this.palms.filter((pt) => Math.abs(pt.z - promZ) < 1.5 && pt.x > CITY.x0 - 40 && pt.x < BAY_EDGE_X - 4).sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < promPalms.length; i += 2) {
      const a = promPalms[i];
      const b = promPalms[i + 1];
      if (b.x - a.x < 5) continue;
      prom.push({ x: (a.x + b.x) / 2, y: 0.16, z: promZ + (r() - 0.5) * 0.3, yaw: r() * Math.PI * 2 });
    }

    const avenueCut = (x: number) => STREETS_NS.some((a) => Math.abs(x - a.x) < a.width / 2 + 2.2 + 2.5);
    const streetCut = (z: number) =>
      STREETS_EW.some((s) => Math.abs(z - s.z) < s.width / 2 + 2.2 + 2.5) || (z > BEACH_ROAD.z0 - 2 && z < BEACH_ROAD.z1 + 2.2 + 2.5);
    const ok = (x: number, z: number) => !onPlot(x, z, 1.5) && !palmSpots.near(x, z, 2.2);

    // Beach road, city side, at the kerb.
    for (let x = -235; x < BAY_EDGE_X - 6; x += 26) {
      const lx = x + (r() - 0.5) * 2;
      const z = BEACH_ROAD.z1 + 0.45;
      if (!avenueCut(lx) && ok(lx, z)) street.push({ x: lx, y: 0.14, z, yaw: 0 });
    }
    // East-west streets: both kerbs, staggered.
    for (const s of STREETS_EW) {
      if (s.z > 140) continue;
      for (const side of [-1, 1]) {
        const z = s.z + side * (s.width / 2 + 0.45);
        for (let x = -230 + (side > 0 ? 13 : 0); x < BAY_EDGE_X - 6; x += 26) {
          const lx = x + (r() - 0.5) * 2;
          if (avenueCut(lx) || !ok(lx, z)) continue;
          street.push({ x: lx, y: 0.14, z, yaw: 0 });
        }
      }
    }
    // Avenues: both kerbs.
    for (const a of STREETS_NS) {
      for (const side of [-1, 1]) {
        const x = a.x + side * (a.width / 2 + 0.45);
        for (let z = 6 + (side > 0 ? 12 : 0); z < 145; z += 24) {
          const lz = z + (r() - 0.5) * 2;
          if (streetCut(lz) || !ok(x, lz)) continue;
          street.push({ x, y: 0.14, z: lz, yaw: 0 });
        }
      }
    }
    return { prom, street };
  }

  private async lamps() {
    const { prom, street } = this.lampSites();
    const [promModel, streetModel] = await Promise.all([this.kit.model('lamp_promenade'), this.kit.model('lamp_deco')]);
    const pools = this.lampPools;
    let k = 0;
    const place = (model: KitModel, sites: Placement[], radius: number) => {
      const bulbs = model.info.empties.filter((e) => e.name.startsWith('bulb'));
      for (const s of sites) {
        q.setFromAxisAngle(up, s.yaw);
        this.batch.add(model.parts, m.compose(p.set(s.x, s.y, s.z), q, one), null, -2);
        this.obstacles.add(new Vector3(s.x, s.y, s.z));
        const h = bulbs[0]?.position[1] ?? 4.4;
        pools.set(k++, s.x, s.y + 0.05, s.z, radius * 2, radius * 2, 0, Math.min(1.2, 0.7 + h / 12));
      }
    };
    place(promModel, prom, 5.5);
    place(streetModel, street, 6.5);
    this.lampCount = k;
    pools.count = k;
    pools.commit();
  }

  private async beach() {
    const r = rng(71);
    const towers: Placement[] = [];
    const umbrellas: Placement[] = [];
    const loungers: Placement[] = [];
    const towels: Placement[] = [];
    const taken = new Spots(8);
    const clear = (x: number, z: number, rad: number) => !inHangout(x, z, 2) && !this.obstacles.near(x, z, rad) && !taken.near(x, z, rad);

    // Lifeguard towers facing the sea, spaced along the beach.
    for (const x of [-196, -118, -52, 58, 112]) {
      const z = -41;
      if (!clear(x, z, 4)) continue;
      towers.push({ x, y: beachHeight(z, x), z, yaw: Math.PI, tint: PASTEL[towers.length % PASTEL.length] });
      for (let dz = -8; dz <= 4; dz += 2) taken.add(new Vector3(x, 0, z + dz));
    }

    // Umbrella groups on the dry sand, more of them near the district.
    for (let i = 0; i < 400 && umbrellas.length < 46; i++) {
      const spread = r() < 0.65 ? 150 : 260;
      const x = -40 + (r() - 0.5) * 2 * spread;
      const z = -26.5 - r() * 20;
      if (x > BAY_EDGE_X - 20 || x < CITY.x0 - 30) continue;
      if (!clear(x, z, 4.2)) continue;
      const canvas = pick(r, CANVAS);
      const yaw = Math.PI + (r() - 0.5) * 0.5;
      const group = umbrellas.length;
      umbrellas.push({ x, y: beachHeight(z, x), z, yaw: r() * Math.PI * 2, tint: canvas, group });
      taken.add(new Vector3(x, 0, z));
      const kind = r();
      const cushion = r() < 0.5 ? canvas : pick(r, CANVAS);
      for (const dx of [-0.85, 0.85]) {
        const lx = x + Math.cos(yaw) * dx;
        const lz = z - Math.sin(yaw) * dx - 0.4;
        if (kind < 0.55) loungers.push({ x: lx, y: beachHeight(lz, lx), z: lz, yaw, tint: cushion, group });
        else towels.push({ x: lx, y: beachHeight(lz, lx) + 0.035, z: lz, yaw: yaw + (r() - 0.5) * 0.3, tint: pick(r, CANVAS), group });
      }
    }
    // A few towels on their own, nearer the water.
    for (let i = 0; i < 200 && towels.length < 40; i++) {
      const x = -40 + (r() - 0.5) * 300;
      const z = -44 - r() * 7;
      if (!clear(x, z, 3)) continue;
      taken.add(new Vector3(x, 0, z));
      towels.push({ x, y: beachHeight(z, x) + 0.035, z, yaw: Math.PI + (r() - 0.5) * 0.6, tint: pick(r, CANVAS), group: r() * umbrellas.length });
    }
    towels.sort((a, b) => (a.group ?? 0) - (b.group ?? 0));
    this.groups = Math.max(1, umbrellas.length);
    for (const t of towels) this.towels.push(t);
    for (const list of [towers, umbrellas, loungers, towels]) for (const s of list) this.obstacles.add(new Vector3(s.x, 0, s.z));

    const specs: [string, Placement[]][] = [
      ['lifeguard_tower', towers],
      ['umbrella', umbrellas],
      ['lounger', loungers],
      ['towel', towels],
    ];
    const models = await Promise.all(specs.map(([id]) => (this.kit.has(id) ? this.kit.model(id) : null)));
    specs.forEach(([, items], j) => {
      const model = models[j];
      if (!model) return;
      for (const s of items) {
        q.setFromAxisAngle(up, s.yaw);
        this.batch.add(model.parts, m.compose(p.set(s.x, s.y, s.z), q, one), s.tint, s.group ?? -1);
      }
    });
  }

  /** Beach furniture thins out with density (towers always stay). Loungers and towels follow their umbrella. */
  setDensity(d: number) {
    this.batch.limit(Math.max(1, Math.round(this.groups * (0.3 + 0.7 * d))));
  }

  /** Towels that stay at every density (sunbathers lie on these). */
  steadyTowels(): Towel[] {
    const lim = this.groups * 0.5;
    return this.towels.filter((t) => (t.group ?? 0) < lim);
  }

  setLamps(level: number) {
    this.lampPools.level.value = level * level;
    this.lampPools.mesh.visible = level > 0.01 && this.lampCount > 0;
  }
}
