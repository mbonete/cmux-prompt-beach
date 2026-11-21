import { Color, Group, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { BAY_EDGE_X, BEACH_ROAD, STREETS_EW, STREETS_NS, CAUSEWAY_END, STREET_WEST } from '../city/layout';
import { Fleet, type StreetKit } from './kit';
import { Pools } from './pools';
import { pick, rng, shuffle, type Rand } from './util';

// Background traffic. The streets form a lane graph: right-hand lanes
// between intersections, and curved connectors through each intersection
// (straight on, right or left; no U-turns). Cars follow the car ahead with a
// simple gap rule, slow for turns, and take a short reservation on an
// intersection so crossing movements never share it. Traffic enters and
// leaves at the far west end of each street and the far north end of each
// avenue. The dead-end stubs toward the bay hold parked cars instead.

const ROAD_Y = 0.02;
// Cars come and go out of sight: at the far west end of the streets, and across
// the causeways at the far end of each avenue.
const WEST = STREET_WEST + 6;
const NORTH = CAUSEWAY_END - 8;
const DX = [1, 0, -1, 0];
const DZ = [0, 1, 0, -1];

const TYPES = ['car_compact', 'car_sedan', 'car_convertible', 'car_van'] as const;
const TYPE_WEIGHT = [0.3, 0.36, 0.14, 0.2];
const COLORS = [
  [0xf2f2f0, 3], [0xbfc4c9, 3], [0x6b7075, 2], [0x1d1f22, 2], [0xb3261e, 1], [0x1f3557, 1], [0x2a8c8c, 1],
  [0x9fd8c2, 1], [0xef8a70, 1], [0xf0d58a, 1], [0x9cc2e6, 1], [0xf2a7b4, 1], [0xd8c8a8, 1],
] as const;
const PASTELS = [0xf2a7b4, 0x9fd8c2, 0xf0d58a, 0x9cc2e6, 0xf6f3ee, 0xef8a70].map((h) => new Color(h));

class Path {
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly cum: number[] = [0];
  readonly length: number;
  constructor(pts: [number, number][]) {
    for (const [x, z] of pts) {
      this.x.push(x);
      this.z.push(z);
    }
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]));
    this.length = this.cum[this.cum.length - 1];
  }
  /** Position and unit heading at arc length s. */
  at(s: number, out: { x: number; z: number; hx: number; hz: number }) {
    const c = this.cum;
    let i = 1;
    while (i < c.length - 1 && c[i] < s) i++;
    const seg = c[i] - c[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (s - c[i - 1]) / seg));
    const dx = this.x[i] - this.x[i - 1];
    const dz = this.z[i] - this.z[i - 1];
    out.x = this.x[i - 1] + dx * t;
    out.z = this.z[i - 1] + dz * t;
    const l = Math.hypot(dx, dz) || 1;
    out.hx = dx / l;
    out.hz = dz / l;
  }
}

interface Node {
  x: number;
  z: number;
  hx: number;
  hz: number;
  portal: boolean;
  occupants: Set<Car>;
}

interface Lane {
  from: Node;
  to: Node;
  dir: number;
  path: Path;
  moves: Move[];
}

interface Move {
  /** 0 straight, 1 right, 2 left */
  turn: number;
  inDir: number;
  out: Lane;
  path: Path;
  weight: number;
}

class Car {
  slot = -1;
  active = true;
  pending = false;
  lane!: Lane;
  move: Move | null = null;
  inBox = false;
  reserved = false;
  s = 0;
  v = 0;
  gap = Infinity;
  waited = 0;
  x = 0;
  z = 0;
  hx = 1;
  hz = 0;
  constructor(
    readonly type: number,
    readonly tint: Color,
    readonly len: number,
    readonly vmax: number,
  ) {}
}

interface Parked {
  type: number;
  m: Matrix4;
  tint: Color;
}

const up = new Vector3(0, 1, 0);
const q = new Quaternion();
const mtx = new Matrix4();
const pos = new Vector3();
const one = new Vector3(1, 1, 1);
const pt = { x: 0, z: 0, hx: 0, hz: 0 };

export class Traffic {
  readonly group = new Group();
  private readonly lanes: Lane[] = [];
  private readonly spawnLanes: Lane[] = [];
  private readonly cars: Car[] = [];
  private readonly parked: Parked[] = [];
  private fleets: Fleet[] = [];
  private beams!: Pools;
  private readonly r: Rand = rng(97);
  private density = 1;

  constructor(private readonly kit: StreetKit) {
    this.group.name = 'life/traffic';
    this.buildGraph();
  }

  async build(maxCars: number) {
    const models = await Promise.all(TYPES.map((t) => this.kit.model(t)));
    const r = this.r;
    for (let i = 0; i < maxCars; i++) {
      let u = r();
      let type = 0;
      while (type < TYPES.length - 1 && u > TYPE_WEIGHT[type]) u -= TYPE_WEIGHT[type++];
      const info = models[type].info;
      const len = info.bounds.max[2] - info.bounds.min[2];
      const tint = type === 2 ? pick(r, PASTELS) : this.color(r);
      this.cars.push(new Car(type, tint, len, (type === 3 ? 7.6 : 8.6) + (r() - 0.5) * 2.4));
    }
    this.parkedSites(models.map((m) => m.info.bounds.max[2] - m.info.bounds.min[2]));
    this.fleets = models.map((m, type) => {
      const cap = this.cars.filter((c) => c.type === type).length + this.parked.filter((p) => p.type === type).length;
      const f = new Fleet(m.parts, Math.max(1, cap), this.kit.levels, { castShadow: true, name: `life/${m.id}` });
      f.addTo(this.group);
      return f;
    });
    this.beams = new Pools(maxCars, 'beam', new Color(1.0, 0.8, 0.58).multiplyScalar(0.32));
    this.group.add(this.beams.mesh);
    for (const c of this.cars) this.place(c, true);
    this.setDensity(this.density);
    // Let traffic settle into a natural pattern before anyone sees it.
    for (let i = 0; i < 120; i++) this.step(0.1);
    this.write();
  }

  private color(r: Rand) {
    const total = COLORS.reduce((a, c) => a + c[1], 0);
    let u = r() * total;
    for (const [hex, w] of COLORS) {
      if ((u -= w) <= 0) return new Color(hex);
    }
    return new Color(COLORS[0][0]);
  }

  // -------------------------------------------------------------------------
  // graph
  // -------------------------------------------------------------------------
  private buildGraph() {
    const nodes = new Map<string, Node>();
    const node = (x: number, z: number, hx: number, hz: number, portal = false) => {
      const k = `${x},${z}`;
      let n = nodes.get(k);
      if (!n) nodes.set(k, (n = { x, z, hx, hz, portal, occupants: new Set() }));
      return n;
    };
    const roads = [{ z: (BEACH_ROAD.z0 + BEACH_ROAD.z1) / 2, width: BEACH_ROAD.z1 - BEACH_ROAD.z0 }, ...STREETS_EW.filter((s) => s.z < NORTH - 20)];
    const off = (w: number) => (w >= 11 ? 2.6 : 2.05);
    const lane = (from: Node, to: Node, dir: number, pts: [number, number][]) => {
      const l: Lane = { from, to, dir, path: new Path(pts), moves: [] };
      this.lanes.push(l);
      if (from.portal) this.spawnLanes.push(l);
    };
    for (const rd of roads) {
      const stops = [node(WEST, rd.z, 0, 0, true), ...STREETS_NS.map((a) => node(a.x, rd.z, a.width / 2, rd.width / 2))];
      const o = off(rd.width);
      for (let i = 0; i + 1 < stops.length; i++) {
        const A = stops[i];
        const B = stops[i + 1];
        lane(A, B, 0, [[A.x + A.hx, rd.z + o], [B.x - B.hx, rd.z + o]]);
        lane(B, A, 2, [[B.x - B.hx, rd.z - o], [A.x + A.hx, rd.z - o]]);
      }
    }
    for (const a of STREETS_NS) {
      const stops = [...roads.map((rd) => node(a.x, rd.z, a.width / 2, rd.width / 2)), node(a.x, NORTH, 0, 0, true)];
      const o = off(a.width);
      for (let i = 0; i + 1 < stops.length; i++) {
        const A = stops[i];
        const B = stops[i + 1];
        lane(A, B, 1, [[a.x - o, A.z + A.hz], [a.x - o, B.z - B.hz]]);
        lane(B, A, 3, [[a.x + o, B.z - B.hz], [a.x + o, A.z + A.hz]]);
      }
    }
    // Movements through each intersection.
    for (const L of this.lanes) {
      if (L.to.portal) continue;
      for (const O of this.lanes) {
        if (O.from !== L.to || O.dir === (L.dir + 2) % 4) continue;
        const turn = O.dir === L.dir ? 0 : O.dir === (L.dir + 1) % 4 ? 1 : 2;
        const p0x = L.path.x[1];
        const p0z = L.path.z[1];
        const p3x = O.path.x[0];
        const p3z = O.path.z[0];
        let pts: [number, number][];
        if (turn === 0) pts = [[p0x, p0z], [p3x, p3z]];
        else {
          const chord = Math.hypot(p3x - p0x, p3z - p0z);
          const k = 0.39 * chord;
          const c1x = p0x + DX[L.dir] * k;
          const c1z = p0z + DZ[L.dir] * k;
          const c2x = p3x - DX[O.dir] * k;
          const c2z = p3z - DZ[O.dir] * k;
          pts = [];
          for (let i = 0; i <= 10; i++) {
            const t = i / 10;
            const a = (1 - t) ** 3;
            const b = 3 * (1 - t) ** 2 * t;
            const c = 3 * (1 - t) * t * t;
            const d = t ** 3;
            pts.push([a * p0x + b * c1x + c * c2x + d * p3x, a * p0z + b * c1z + c * c2z + d * p3z]);
          }
        }
        L.moves.push({ turn, inDir: L.dir, out: O, path: new Path(pts), weight: turn === 0 ? 0.5 : turn === 1 ? 0.27 : 0.23 });
      }
    }
  }

  private parkedSites(lens: number[]) {
    const r = rng(31);
    const roads = [{ z: (BEACH_ROAD.z0 + BEACH_ROAD.z1) / 2, width: BEACH_ROAD.z1 - BEACH_ROAD.z0 }, ...STREETS_EW.filter((s) => s.z < 140)];
    const east = STREETS_NS[STREETS_NS.length - 1];
    const x0 = east.x + east.width / 2 + 4;
    for (const rd of roads) {
      for (const side of [-1, 1]) {
        let x = x0 + r() * 3;
        while (x < BAY_EDGE_X - 7) {
          let u = r();
          let type = 0;
          while (type < TYPES.length - 1 && u > TYPE_WEIGHT[type]) u -= TYPE_WEIGHT[type++];
          const len = lens[type];
          if (r() < 0.5) {
            const z = rd.z + side * (rd.width / 2 - 1.15);
            q.setFromAxisAngle(up, side > 0 ? Math.PI / 2 : -Math.PI / 2);
            const m = new Matrix4().compose(pos.set(x + len / 2, ROAD_Y, z), q, one);
            this.parked.push({ type, m, tint: type === 2 ? pick(r, PASTELS) : this.color(r) });
          }
          x += len + 1.4 + r() * 1.5;
        }
      }
    }
    shuffle(r, this.parked);
  }

  // -------------------------------------------------------------------------
  // simulation
  // -------------------------------------------------------------------------
  private chooseMove(c: Car) {
    const moves = c.lane.moves;
    if (!moves.length) {
      c.move = null;
      return;
    }
    let u = this.r() * moves.reduce((a, m) => a + m.weight, 0);
    for (const m of moves) {
      if ((u -= m.weight) <= 0) {
        c.move = m;
        return;
      }
    }
    c.move = moves[moves.length - 1];
  }

  /** Drops a car on a random lane (initial) or at a traffic entry point (respawn). */
  private place(c: Car, anywhere: boolean): boolean {
    const r = this.r;
    for (let tries = 0; tries < 24; tries++) {
      const lane = anywhere ? pick(r, this.lanes) : pick(r, this.spawnLanes);
      const s = anywhere ? r() * Math.max(0, lane.path.length - 8) : 0;
      if (this.cars.some((o) => o !== c && o.active && !o.pending && !o.inBox && o.lane === lane && Math.abs(o.s - s) < 14)) continue;
      c.lane = lane;
      c.s = s;
      c.inBox = false;
      c.reserved = false;
      c.pending = false;
      c.v = c.vmax * 0.7;
      this.chooseMove(c);
      lane.path.at(s, pt);
      c.x = pt.x;
      c.z = pt.z;
      c.hx = pt.hx;
      c.hz = pt.hz;
      return true;
    }
    c.pending = true;
    return false;
  }

  private conflicts(a: Move, b: Move) {
    if (a.inDir === b.inDir) return false;
    if ((a.inDir + 2) % 4 === b.inDir && a.turn !== 2 && b.turn !== 2) return false;
    return true;
  }

  private tryReserve(c: Car): boolean {
    const n = c.lane.to;
    const mv = c.move!;
    for (const o of n.occupants) if (o.move && this.conflicts(o.move, mv)) return false;
    for (const o of this.cars) {
      if (o === c || !o.active || o.pending || o.inBox) continue;
      if (o.lane === mv.out && o.s < o.len / 2 + c.len + 2.5) return false;
    }
    n.occupants.add(c);
    c.reserved = true;
    return true;
  }

  private sense(c: Car) {
    let gap = Infinity;
    for (const o of this.cars) {
      if (o === c || !o.active || o.pending) continue;
      const dx = o.x - c.x;
      const dz = o.z - c.z;
      const fwd = dx * c.hx + dz * c.hz;
      if (fwd <= 0 || fwd > 45) continue;
      if (Math.abs(dx * c.hz - dz * c.hx) > 1.5) continue;
      if (c.hx * o.hx + c.hz * o.hz < 0.3) continue;
      gap = Math.min(gap, fwd - (c.len + o.len) / 2);
    }
    return gap;
  }

  private step(dt: number) {
    const cars = this.cars;
    for (const c of cars) if (c.active && !c.pending) c.gap = this.sense(c);
    for (const c of cars) {
      if (!c.active) continue;
      if (c.pending) {
        this.place(c, false);
        continue;
      }
      const path = c.inBox ? c.move!.path : c.lane.path;
      const remain = path.length - c.s;
      let vDes = c.vmax;
      let gap = c.gap;
      const portal = c.lane.to.portal;
      if (!c.inBox && !portal && c.move) {
        const mv = c.move;
        const vTurn = mv.turn === 0 ? c.vmax * 0.74 : mv.turn === 1 ? 4.0 : 5.0;
        vDes = Math.min(vDes, Math.sqrt(vTurn * vTurn + 2 * 2.0 * Math.max(0, remain - 1.5)));
        if (!c.reserved && remain < 20) {
          if (!this.tryReserve(c)) {
            c.waited += dt;
            // A stuck car eventually goes (never seen in practice; avoids gridlock forever).
            if (c.waited > 25) {
              c.lane.to.occupants.add(c);
              c.reserved = true;
            }
          }
        }
        if (!c.reserved) gap = Math.min(gap, remain - 0.6);
      } else if (c.inBox && c.move) {
        const vTurn = c.move.turn === 0 ? c.vmax * 0.74 : c.move.turn === 1 ? 4.0 : 5.0;
        vDes = Math.min(vDes, vTurn + Math.max(0, c.s) * 0.35);
      }
      vDes = Math.min(vDes, Math.sqrt(Math.max(0, 2 * 3.2 * (gap - 1.6))));
      const dv = vDes - c.v;
      c.v = Math.max(0, c.v + Math.max(-7 * dt, Math.min(2.2 * dt, dv)));
      c.s += c.v * dt;
      if (!c.inBox && !portal && !c.reserved) c.s = Math.min(c.s, c.lane.path.length - 0.3);
      // Segment changes.
      for (let guard = 0; guard < 3; guard++) {
        const len = c.inBox ? c.move!.path.length : c.lane.path.length;
        if (c.s < len) break;
        c.s -= len;
        if (!c.inBox) {
          if (portal || !c.move) {
            c.pending = true;
            break;
          }
          c.inBox = true;
          c.waited = 0;
        } else {
          c.lane.to.occupants.delete(c);
          c.reserved = false;
          c.inBox = false;
          c.lane = c.move!.out;
          this.chooseMove(c);
        }
      }
      if (c.pending) {
        this.place(c, false);
        continue;
      }
      (c.inBox ? c.move!.path : c.lane.path).at(c.s, pt);
      c.x = pt.x;
      c.z = pt.z;
      // Ease the heading so polyline corners never snap.
      c.hx = pt.hx;
      c.hz = pt.hz;
    }
  }

  // -------------------------------------------------------------------------
  // output
  // -------------------------------------------------------------------------
  private write() {
    let beam = 0;
    for (const c of this.cars) {
      if (!c.active || c.slot < 0) continue;
      const f = this.fleets[c.type];
      if (c.pending) {
        f.hide(c.slot);
        continue;
      }
      const yaw = Math.atan2(c.hx, c.hz);
      q.setFromAxisAngle(up, yaw);
      f.setMatrix(c.slot, mtx.compose(pos.set(c.x, ROAD_Y, c.z), q, one));
      this.beams.set(beam++, c.x + c.hx * c.len * 0.48, ROAD_Y + 0.04, c.z + c.hz * c.len * 0.48, 3.4, 13, yaw, 0.55);
    }
    this.beams.count = beam;
    for (const f of this.fleets) f.commit();
    this.beams.commit();
  }

  update(dt: number) {
    if (!this.fleets.length) return;
    // Two half steps keep following distances stable at low frame rates.
    const h = Math.min(dt, 0.1) / 2;
    this.step(h);
    this.step(h);
    this.write();
  }

  /** Moving cars and parked cars both thin with density. */
  setDensity(d: number) {
    this.density = d;
    if (!this.fleets.length) return;
    const n = Math.round(this.cars.length * d);
    this.cars.forEach((c, i) => {
      const was = c.active;
      c.active = i < n;
      if (was && !c.active) {
        if (c.reserved) c.lane.to.occupants.delete(c);
        c.reserved = false;
      }
      if (!was && c.active) this.place(c, true);
    });
    const slots = this.fleets.map(() => 0);
    for (const c of this.cars) {
      c.slot = -1;
      if (!c.active) continue;
      c.slot = slots[c.type]++;
      this.fleets[c.type].setTint(c.slot, c.tint);
      this.fleets[c.type].setLit(c.slot, 1);
    }
    const keepParked = Math.round(this.parked.length * (0.35 + 0.65 * d));
    this.parked.slice(0, keepParked).forEach((p) => {
      const f = this.fleets[p.type];
      const s = slots[p.type]++;
      f.setMatrix(s, p.m);
      f.setTint(s, p.tint);
      f.setLit(s, 0);
    });
    this.fleets.forEach((f, i) => (f.count = slots[i]));
    this.write();
  }

  setLamps(level: number) {
    this.beams.level.value = level * level;
    this.beams.mesh.visible = level > 0.02;
  }
}
