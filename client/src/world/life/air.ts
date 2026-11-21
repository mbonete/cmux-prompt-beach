import { Color, Euler, Group, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { Fleet, type KitModel, type StreetKit } from './kit';

// Aircraft: a helicopter circling over the bay and the skyline, banking into
// its turn with spinning rotors, and a plain blimp drifting slowly along the
// coast on a long racetrack, out over the sea.

const e = new Euler(0, 0, 0, 'YXZ');
const q = new Quaternion();
const m = new Matrix4();
const n = new Matrix4();
const s = new Matrix4();
const p = new Vector3();
const one = new Vector3(1, 1, 1);

// The loop's west side crosses the east edge of the district, so it passes through the default view once a lap.
const HELI = { cx: 150, cz: 45, r: 90, alt: 55, speed: 24 };
// Blimp racetrack: two straights along the coast joined by half circles.
const BLIMP = { x0: -480, x1: 400, zNear: -125, zFar: -205, alt: 78, speed: 4.2 };

export class Air {
  readonly group = new Group();
  private heli: { body: Fleet; rotor: Fleet | null; tail: Fleet | null; model: KitModel } | null = null;
  private blimp: Fleet | null = null;
  private theta = 0.6;
  private rotor = 0;
  private tailSpin = 0;
  private blimpS = 380;
  private t = 0;
  private heliOn = true;

  constructor(private readonly kit: StreetKit) {
    this.group.name = 'life/air';
  }

  async build() {
    const [heli, blimp] = await Promise.all([this.kit.model('helicopter'), this.kit.model('blimp')]);
    const body = new Fleet(heli.parts, 1, this.kit.levels, { castShadow: false, name: 'life/helicopter' });
    const node = (name: string) => {
      const nd = heli.nodes.find((x) => x.name === name);
      if (!nd) return null;
      const f = new Fleet(nd.parts, 1, this.kit.levels, { castShadow: false, name: `life/helicopter/${name}` });
      f.addTo(this.group);
      f.count = 1;
      return f;
    };
    body.addTo(this.group);
    body.count = 1;
    body.setTint(0, new Color(0xe8553f));
    this.heli = { body, rotor: node('rotor'), tail: node('tail_rotor'), model: heli };
    this.blimp = new Fleet(blimp.parts, 1, this.kit.levels, { castShadow: false, name: 'life/blimp' });
    this.blimp.addTo(this.group);
    this.blimp.count = 1;
    this.blimp.setTint(0, new Color(0x2a9d8f));
    this.update(0);
  }

  setDensity(d: number) {
    this.heliOn = d > 0.5;
    if (!this.heli) return;
    for (const f of [this.heli.body, this.heli.rotor, this.heli.tail]) if (f) f.visible = this.heliOn;
  }

  update(dt: number) {
    this.t += dt;
    if (this.heli && this.heliOn) this.flyHeli(dt);
    if (this.blimp) this.driftBlimp(dt);
  }

  private flyHeli(dt: number) {
    const h = this.heli!;
    const c = HELI;
    this.theta += (c.speed / c.r) * dt;
    const th = this.theta;
    const x = c.cx + c.r * Math.cos(th);
    const z = c.cz + c.r * Math.sin(th);
    const hx = -Math.sin(th);
    const hz = Math.cos(th);
    const yaw = Math.atan2(hx, hz);
    // The centre of the loop is on the heading's right: bank right (negative roll).
    const bank = -0.3;
    e.set(0.09, yaw, bank);
    q.setFromEuler(e);
    const alt = c.alt + 5 * Math.sin(th * 2);
    m.compose(p.set(x, alt, z), q, one);
    h.body.setMatrix(0, m);
    h.body.commit();
    this.rotor += dt * Math.PI * 2 * 3.3;
    this.tailSpin += dt * Math.PI * 2 * 7.5;
    const rot = h.model.nodes.find((nd) => nd.name === 'rotor');
    const tail = h.model.nodes.find((nd) => nd.name === 'tail_rotor');
    if (h.rotor && rot) {
      n.multiplyMatrices(m, rot.rest).multiply(s.makeRotationY(this.rotor));
      h.rotor.setMatrix(0, n);
      h.rotor.commit();
    }
    if (h.tail && tail) {
      n.multiplyMatrices(m, tail.rest).multiply(s.makeRotationX(this.tailSpin));
      h.tail.setMatrix(0, n);
      h.tail.commit();
    }
  }

  private driftBlimp(dt: number) {
    const b = BLIMP;
    const straight = b.x1 - b.x0;
    const rad = (b.zNear - b.zFar) / 2;
    const arc = Math.PI * rad;
    const total = 2 * straight + 2 * arc;
    this.blimpS = (this.blimpS + b.speed * dt) % total;
    let s0 = this.blimpS;
    let x: number;
    let z: number;
    let yaw: number;
    const cz = (b.zNear + b.zFar) / 2;
    if (s0 < straight) {
      x = b.x0 + s0;
      z = b.zNear;
      yaw = Math.PI / 2;
    } else if ((s0 -= straight) < arc) {
      const a = s0 / rad;
      x = b.x1 + rad * Math.sin(a);
      z = cz + rad * Math.cos(a);
      yaw = Math.PI / 2 + a;
    } else if ((s0 -= arc) < straight) {
      x = b.x1 - s0;
      z = b.zFar;
      yaw = -Math.PI / 2;
    } else {
      s0 -= straight;
      const a = s0 / rad;
      x = b.x0 - rad * Math.sin(a);
      z = cz - rad * Math.cos(a);
      yaw = -Math.PI / 2 + a;
    }
    const t = this.t;
    e.set(0.015 * Math.sin(t * 0.21), yaw, 0.01 * Math.sin(t * 0.17));
    q.setFromEuler(e);
    this.blimp!.setMatrix(0, m.compose(p.set(x, b.alt + 0.8 * Math.sin(t * 0.13), z), q, one));
    this.blimp!.commit();
  }
}
