import { Color, Euler, Group, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { SEA_Y } from '../city/layout';
import { Fleet, type StreetKit } from './kit';
import { Pools } from './pools';

// Boats on the open sea (toward -Z) and in the bay (toward +X): each follows
// a slow closed loop, bobbing, pitching and rolling on the swell, with a
// foam wake behind it while it moves. One cruiser lies at anchor.

const TYPES = ['boat_speed', 'boat_sail', 'boat_cruiser'] as const;

interface Route {
  cx: number;
  cz: number;
  a: number;
  b: number;
  speed: number;
  dir: 1 | -1;
}

/** type, route, hull tint; earlier entries stay at lower densities. */
const BOATS: [number, Route, number][] = [
  [0, { cx: -60, cz: -190, a: 170, b: 70, speed: 11, dir: 1 }, 0x1f3557],
  [1, { cx: -120, cz: -150, a: 90, b: 30, speed: 2.6, dir: -1 }, 0x2a8c8c],
  [2, { cx: 185, cz: -40, a: 24, b: 130, speed: 4, dir: 1 }, 0x1d1f22],
  [1, { cx: 195, cz: 190, a: 18, b: 60, speed: 2.2, dir: 1 }, 0xb3261e],
  [0, { cx: 188, cz: 70, a: 22, b: 160, speed: 10, dir: -1 }, 0xef8a70],
  [2, { cx: -30, cz: -136, a: 0, b: 0, speed: 0, dir: 1 }, 0x1f3557],
  [1, { cx: 60, cz: -175, a: 70, b: 25, speed: 2.8, dir: 1 }, 0x1f3557],
  [0, { cx: 150, cz: -260, a: 120, b: 60, speed: 12, dir: -1 }, 0xb3261e],
  [1, { cx: -260, cz: -210, a: 110, b: 40, speed: 3, dir: 1 }, 0x9cc2e6],
  [2, { cx: 20, cz: -310, a: 220, b: 80, speed: 4.5, dir: -1 }, 0x2a8c8c],
  [0, { cx: -300, cz: -330, a: 200, b: 90, speed: 13, dir: 1 }, 0x2a8c8c],
  [1, { cx: 200, cz: -120, a: 40, b: 22, speed: 2.4, dir: -1 }, 0xf0d58a],
];

interface Boat {
  type: number;
  slot: number;
  route: Route;
  theta: number;
  phase: number;
  active: boolean;
  tint: Color;
}

const e = new Euler(0, 0, 0, 'YXZ');
const q = new Quaternion();
const m = new Matrix4();
const p = new Vector3();
const one = new Vector3(1, 1, 1);

export class Marine {
  readonly group = new Group();
  private fleets: Fleet[] = [];
  private boats: Boat[] = [];
  private wakes!: Pools;
  private waterline: number[] = [];
  private lengths: number[] = [];
  private t = 0;

  constructor(private readonly kit: StreetKit) {
    this.group.name = 'life/marine';
  }

  async build() {
    const models = await Promise.all(TYPES.map((t) => this.kit.model(t)));
    this.waterline = models.map((mo) => mo.info.extras?.waterline ?? 0.4);
    this.lengths = models.map((mo) => mo.info.bounds.max[2] - mo.info.bounds.min[2]);
    this.boats = BOATS.map(([type, route, tint], i) => ({
      type,
      slot: -1,
      route,
      theta: (i * 2.399) % (Math.PI * 2),
      phase: i * 1.7,
      active: true,
      tint: new Color(tint),
    }));
    this.fleets = models.map((mo, type) => {
      const f = new Fleet(mo.parts, this.boats.filter((b) => b.type === type).length, this.kit.levels, { castShadow: false, name: `life/${mo.id}` });
      f.addTo(this.group);
      return f;
    });
    this.wakes = new Pools(this.boats.length, 'wake', new Color(1, 1, 1));
    this.wakes.level.value = 0.5;
    this.group.add(this.wakes.mesh);
    this.setDensity(1);
  }

  setDensity(d: number) {
    if (!this.fleets.length) return;
    const n = Math.max(3, Math.round(this.boats.length * d));
    const slots = this.fleets.map(() => 0);
    this.boats.forEach((b, i) => {
      b.active = i < n;
      b.slot = b.active ? slots[b.type]++ : -1;
      if (b.active) this.fleets[b.type].setTint(b.slot, b.tint);
    });
    this.fleets.forEach((f, i) => (f.count = slots[i]));
    this.update(0);
  }

  update(dt: number) {
    if (!this.fleets.length) return;
    this.t += dt;
    const t = this.t;
    let w = 0;
    for (const b of this.boats) {
      if (!b.active) continue;
      const r = b.route;
      let x = r.cx;
      let z = r.cz;
      let yaw = Math.PI / 2;
      let speed = 0;
      if (r.speed > 0) {
        // Arc length on an ellipse ~ speed; dtheta = speed / |dP/dtheta|.
        const st = Math.sin(b.theta);
        const ct = Math.cos(b.theta);
        const rate = Math.hypot(r.a * st, r.b * ct) || 1;
        b.theta += (r.dir * r.speed * dt) / rate;
        x = r.cx + r.a * Math.cos(b.theta);
        z = r.cz + r.b * Math.sin(b.theta);
        const tx = -r.a * Math.sin(b.theta) * r.dir;
        const tz = r.b * Math.cos(b.theta) * r.dir;
        yaw = Math.atan2(tx, tz);
        speed = r.speed;
      } else {
        yaw = Math.PI / 2 + 0.2 * Math.sin(t * 0.05 + b.phase);
      }
      const ph = b.phase;
      const bob = 0.1 * Math.sin(t * 1.1 + ph) + 0.05 * Math.sin(t * 1.9 + ph * 2);
      const big = b.type === 2 ? 0.5 : 1;
      const planing = b.type === 0 ? Math.min(1, speed / 10) * 0.06 : 0;
      e.set(
        -planing + 0.035 * big * Math.sin(t * 0.9 + ph),
        yaw,
        (b.type === 1 ? -0.14 : 0) + 0.045 * big * Math.sin(t * 0.7 + ph * 1.3),
      );
      q.setFromEuler(e);
      p.set(x, SEA_Y - this.waterline[b.type] + bob, z);
      this.fleets[b.type].setMatrix(b.slot, m.compose(p, q, one));
      if (speed > 0.5) {
        const len = this.lengths[b.type];
        const hx = Math.sin(yaw);
        const hz = Math.cos(yaw);
        const fast = Math.min(1, speed / 11);
        this.wakes.set(w++, x - hx * len * 0.45, SEA_Y + 0.22, z - hz * len * 0.45, 4 + 9 * fast, 14 + 30 * fast, yaw + Math.PI, 0.35 + 0.65 * fast);
      }
    }
    this.wakes.count = w;
    this.wakes.commit();
    for (const f of this.fleets) f.commit();
  }

  setLamps(level: number) {
    if (this.wakes) this.wakes.level.value = 0.5 - 0.32 * level;
  }
}
