import { MathUtils, Vector3 } from 'three/webgpu';
import type { CameraRig, View } from './camera/rig';

// The idle camera: after two minutes without input, slow drifting shots of the
// city that cut to whoever needs you, every other shot when anyone does. Any
// input hands the camera straight back to where you left it. Off with reduced
// motion or in Settings.

const IDLE_MS = 120_000;
const SHOT_S = 11;
const deg = MathUtils.degToRad;

interface Shot {
  view: Partial<View> & { target: Vector3 };
  /** Radians per second of slow orbit, and distance creep per second (fraction). */
  yawRate: number;
  creep: number;
}

export class Director {
  enabled = true;
  private active = false;
  private saved: View | null = null;
  /** Whoever the camera followed before the tour: the shots must not drift toward them. */
  private savedFollow: (() => Vector3 | null) | null = null;
  private shot: Shot | null = null;
  private t = 0;
  private turn = 0;
  /** Called halfway through a cut so the page can dip to black around it. */
  onCut: ((phase: 'out' | 'in') => void) | null = null;
  onChange: ((active: boolean) => void) | null = null;
  private pendingCut: { shot: Shot; at: number } | null = null;

  constructor(
    private readonly rig: CameraRig,
    /** Where the people who need you are, nearest first. */
    private readonly needs: () => Vector3[],
  ) {}

  get running() {
    return this.active;
  }

  update(dt: number) {
    if (!this.active) {
      if (this.enabled && !this.rig.reducedMotion && this.rig.idleMs > IDLE_MS) this.begin();
      return;
    }
    if (this.pendingCut) {
      this.pendingCut.at -= dt;
      if (this.pendingCut.at <= 0) {
        this.apply(this.pendingCut.shot);
        this.pendingCut = null;
        this.onCut?.('in');
      }
      return;
    }
    this.t += dt;
    const s = this.shot;
    if (s) {
      const d = this.rig.desired;
      d.yaw += s.yawRate * dt;
      d.distance *= 1 - s.creep * dt;
      this.rig.current.yaw = d.yaw;
      this.rig.current.distance = d.distance;
    }
    if (this.t > SHOT_S) this.cut();
  }

  /** Start the tour now (the Tour button), without waiting to be idle. */
  start() {
    if (!this.active && !this.rig.reducedMotion) this.begin();
  }

  /** Any input: give the camera back. */
  stop() {
    if (!this.active) return;
    // Stopping is activity: without this the idle timer was still past two
    // minutes and the tour began again on the very next frame.
    this.rig.poke();
    this.active = false;
    this.pendingCut = null;
    this.onChange?.(false);
    this.onCut?.('in');
    if (this.saved) this.rig.flyTo(this.saved, 1.1);
    this.saved = null;
    this.rig.setFollow(this.savedFollow);
    this.savedFollow = null;
  }

  private begin() {
    this.active = true;
    this.turn = 0;
    const d = this.rig.desired;
    this.saved = { target: d.target.clone(), distance: d.distance, yaw: d.yaw, pitch: d.pitch };
    this.savedFollow = this.rig.following;
    this.rig.setFollow(null);
    this.onChange?.(true);
    this.cut();
  }

  private cut() {
    const shot = this.next();
    this.t = 0;
    this.onCut?.('out');
    this.pendingCut = { shot, at: 0.45 };
  }

  private apply(s: Shot) {
    this.shot = s;
    this.rig.flyTo(s.view, 0.01);
  }

  private next(): Shot {
    const needs = this.needs();
    const i = this.turn++;
    if (needs.length && i % 2 === 0) {
      const p = needs[Math.floor(i / 2) % needs.length];
      return {
        view: { target: p.clone(), distance: 30, pitch: deg(31), yaw: deg(-25 + Math.random() * 50) },
        yawRate: 0.022 * (Math.random() < 0.5 ? -1 : 1),
        creep: 0.012,
      };
    }
    const wide: Shot[] = [
      { view: { target: new Vector3(0, 0, 44), distance: 205, pitch: deg(33), yaw: deg(-8) }, yawRate: 0.012, creep: 0.004 },
      { view: { target: new Vector3(-24, 0, -30), distance: 96, pitch: deg(27), yaw: deg(28) }, yawRate: -0.018, creep: 0.006 },
      { view: { target: new Vector3(30, 0, 20), distance: 150, pitch: deg(29), yaw: deg(-62) }, yawRate: 0.014, creep: 0.005 },
      { view: { target: new Vector3(-10, 0, 60), distance: 120, pitch: deg(48), yaw: deg(160) }, yawRate: -0.012, creep: 0.004 },
    ];
    return wide[Math.floor(i / (needs.length ? 2 : 1)) % wide.length];
  }
}
