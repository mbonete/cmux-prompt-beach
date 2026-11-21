import { MathUtils, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three/webgpu';

// A damped three-quarter camera around a target on the ground.
//   left drag: pan · right drag / two fingers / shift-drag: rotate and tilt
//   wheel / pinch: zoom toward the cursor · double click: focus (handled by the world)
// Tilt is limited to 25°–65° so the city always reads as a city, never a map
// or a street view. Flights ease in and out; reduced motion cuts instead.

export interface View {
  target: Vector3;
  distance: number;
  /** Radians; 0 looks toward the ocean (−Z). */
  yaw: number;
  /** Radians above the horizon. */
  pitch: number;
}

const MIN_PITCH = MathUtils.degToRad(25);
const MAX_PITCH = MathUtils.degToRad(65);
const MIN_DIST = 7;
/** Anything taller than this (metres) is building mass the camera must not pass through. */
const SOLID = 5;
const MAX_DIST = 270;
const BOUNDS = { x0: -130, x1: 135, z0: -90, z1: 140 };

export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly current: View;
  readonly desired: View;
  reducedMotion = false;
  /** Set while a flight is running; cleared by any manual input. */
  private flight: { from: View; to: View; t: number; dur: number } | null = null;
  private follow: (() => Vector3 | null) | null = null;
  private readonly ray = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private pointers = new Map<number, { x: number; y: number; button: number; shift: boolean }>();
  private pinchStart = 0;
  private lastInput = performance.now();
  onInput: (() => void) | null = null;
  /** Height of whatever stands at a ground point (buildings, terraces), in metres. */
  obstacle: ((x: number, z: number) => number) | null = null;
  onDoubleClick: ((ndc: Vector2) => void) | null = null;
  onClick: ((ndc: Vector2) => void) | null = null;
  /** Which control was just used (for the controls hint). */
  onUse: ((kind: 'pan' | 'rotate' | 'zoom') => void) | null = null;
  private downAt = { x: 0, y: 0, t: 0 };
  /**
   * Screen-space framing shift in CSS pixels: positive moves what the camera
   * looks at to the left, making room for a panel on the right. Eased.
   */
  shiftPx = 0;
  private shiftCur = 0;
  /** Canvas height in CSS pixels, for converting the shift to metres. */
  viewHeight = 1;
  private readonly right = new Vector3();
  private readonly look = new Vector3();
  /** Eased camera collision: how much of the distance is kept, and how far it is lifted. */
  private keep = 1;
  private lift = 0;
  private dt = 1 / 60;

  constructor(
    private readonly dom: HTMLElement,
    aspect: number,
  ) {
    this.camera = new PerspectiveCamera(32, aspect, 0.5, 6000);
    const start: View = { target: new Vector3(0, 0, 20), distance: 150, yaw: 0, pitch: MathUtils.degToRad(40) };
    this.current = cloneView(start);
    this.desired = cloneView(start);
    this.bind();
    this.apply();
  }

  get idleMs() {
    return performance.now() - this.lastInput;
  }

  /** Smoothly move to a view. */
  flyTo(view: Partial<View>, seconds = 1.4) {
    const to = cloneView(this.desired);
    if (view.target) to.target.copy(view.target);
    if (view.distance !== undefined) to.distance = view.distance;
    if (view.yaw !== undefined) to.yaw = view.yaw;
    if (view.pitch !== undefined) to.pitch = view.pitch;
    clampView(to);
    if (this.reducedMotion) {
      copyView(this.desired, to);
      copyView(this.current, to);
      this.flight = null;
      return;
    }
    this.flight = { from: cloneView(this.current), to, t: 0, dur: seconds };
  }

  /** Keep the target on a moving point (e.g. a selected agent) until the user pans. */
  setFollow(fn: (() => Vector3 | null) | null) {
    this.follow = fn;
  }

  update(dt: number) {
    this.dt = dt;
    this.shiftCur += (this.shiftPx - this.shiftCur) * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7));
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = easeInOut(f.t);
      this.current.target.lerpVectors(f.from.target, f.to.target, k);
      this.current.distance = MathUtils.lerp(f.from.distance, f.to.distance, k);
      // A flight arcs out a little in the middle, like a camera crane.
      this.current.distance *= 1 + Math.sin(k * Math.PI) * 0.12;
      this.current.yaw = lerpAngle(f.from.yaw, f.to.yaw, k);
      this.current.pitch = MathUtils.lerp(f.from.pitch, f.to.pitch, k);
      if (f.t >= 1) {
        copyView(this.desired, f.to);
        this.flight = null;
      }
    } else {
      if (this.follow) {
        const p = this.follow();
        if (p) this.desired.target.lerp(p, 1 - Math.exp(-dt * 4));
      }
      const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 9);
      this.current.target.lerp(this.desired.target, k);
      this.current.distance = MathUtils.lerp(this.current.distance, this.desired.distance, k);
      this.current.yaw = lerpAngle(this.current.yaw, this.desired.yaw, k);
      this.current.pitch = MathUtils.lerp(this.current.pitch, this.desired.pitch, k);
    }
    this.apply();
  }

  /** True while the camera is still moving noticeably. */
  get moving() {
    if (this.flight) return true;
    if (Math.abs(this.shiftPx - this.shiftCur) > 0.5) return true;
    const c = this.current;
    const d = this.desired;
    return (
      c.target.distanceToSquared(d.target) > 1e-4 ||
      Math.abs(c.distance - d.distance) > 0.01 ||
      Math.abs(c.yaw - d.yaw) > 1e-4 ||
      Math.abs(c.pitch - d.pitch) > 1e-4
    );
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Point on the ground under normalised device coordinates. */
  groundAt(ndc: Vector2, out = new Vector3()): Vector3 | null {
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray.intersectPlane(this.ground, out);
  }

  private apply() {
    const v = this.current;
    const cp = Math.cos(v.pitch);
    // Shift camera and aim sideways together so the target sits left of centre.
    const perPx = (2 * v.distance * Math.tan(MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, this.viewHeight);
    this.right.set(Math.cos(v.yaw), 0, -Math.sin(v.yaw)).multiplyScalar(this.shiftCur * perPx);
    this.look.copy(v.target).add(this.right);
    this.camera.position.set(
      this.look.x + Math.sin(v.yaw) * cp * v.distance,
      this.look.y + Math.sin(v.pitch) * v.distance,
      this.look.z + Math.cos(v.yaw) * cp * v.distance,
    );
    if (this.obstacle) this.avoidObstacles();
    if (this.camera.position.y < 1.5) this.camera.position.y = 1.5;
    this.camera.lookAt(this.look);
  }

  /**
   * Camera collision: walk the line from what we look at out to the camera; if a
   * building is in the way, bring the camera in front of it (same angle, closer).
   */
  private avoidObstacles() {
    const cam = this.camera.position;
    const from = this.look;
    const dx = cam.x - from.x;
    const dy = cam.y - from.y;
    const dz = cam.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    // Terrace clutter (umbrellas, string lights) is seen through; only building mass blocks.
    const solid = (x: number, z: number) => {
      const h = this.obstacle!(x, z);
      return h > SOLID ? h : 0;
    };
    let keepTarget = 1;
    if (len <= 28) {
      const steps = Math.min(48, Math.ceil(len / 1.25));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const d = t * len;
        if (d < 4.5) continue;
        if (from.y + dy * t < solid(from.x + dx * t, from.z + dz * t) + 0.6) {
          keepTarget = Math.max((d - 1.5) / len, 7 / len);
          break;
        }
      }
    }
    // Ease both corrections (in quickly, out slowly) so the camera glides
    // around a building instead of snapping to a new distance in one frame.
    const ease = (cur: number, target: number, fast: boolean) =>
      this.reducedMotion ? target : cur + (target - cur) * (1 - Math.exp(-this.dt * (fast ? 12 : 3)));
    this.keep = ease(this.keep, keepTarget, keepTarget < this.keep);
    if (this.keep < 0.999) cam.set(from.x + dx * this.keep, from.y + dy * this.keep, from.z + dz * this.keep);
    const floor = solid(cam.x, cam.z) + (len > 28 ? 2.5 : 1.2);
    const liftTarget = Math.max(0, floor - cam.y);
    this.lift = ease(this.lift, liftTarget, liftTarget > this.lift);
    cam.y += this.lift;
  }

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.dom.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private touched() {
    this.lastInput = performance.now();
    this.flight = null;
    this.onInput?.();
  }

  private bind() {
    const el = this.dom;
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (this.pointers.size === 2) this.pinchStart = this.pinchDistance();
      this.lastInput = performance.now();
    });

    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      // A release we never heard about (it happened over a panel, outside the
      // window, or capture was lost): no button is down, so this is no drag.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        this.release(e.pointerId);
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.abs(e.clientX - this.downAt.x) + Math.abs(e.clientY - this.downAt.y) < 4) return;
      this.touched();

      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.pinchStart > 0) this.zoomBy(this.pinchStart / d, null);
        this.pinchStart = d;
        this.onUse?.('zoom');
        this.rotateBy(dx * 0.5, dy * 0.5);
        this.onUse?.('rotate');
        return;
      }
      // Turning keeps whoever is followed in the middle; moving the map lets go of them.
      if (p.button === 2 || p.shift) {
        this.rotateBy(dx, dy);
        this.onUse?.('rotate');
      } else {
        this.follow = null;
        this.panBy(e.clientX - dx, e.clientY - dy, e.clientX, e.clientY);
        this.onUse?.('pan');
      }
    });

    const up = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchStart = 0;
      if (!p) return;
      const moved = Math.abs(e.clientX - this.downAt.x) + Math.abs(e.clientY - this.downAt.y);
      if (moved < 5 && performance.now() - this.downAt.t < 500 && p.button === 0) this.onClick?.(this.ndc(e));
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', (e) => this.release(e.pointerId));
    window.addEventListener('blur', () => {
      for (const id of [...this.pointers.keys()]) this.release(id);
    });

    el.addEventListener('dblclick', (e) => {
      this.touched();
      this.onDoubleClick?.(this.ndc(e));
    });

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.touched();
        const factor = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0012));
        this.zoomBy(factor, this.ndc(e));
        this.onUse?.('zoom');
      },
      { passive: false },
    );
  }

  private release(id: number) {
    this.pointers.delete(id);
    if (this.pointers.size < 2) this.pinchStart = 0;
  }

  private pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  panBy(x0: number, y0: number, x1: number, y1: number) {
    const a = this.groundAt(this.ndc({ clientX: x0, clientY: y0 }));
    const b = this.groundAt(this.ndc({ clientX: x1, clientY: y1 }));
    if (!a || !b) return;
    this.desired.target.add(a.sub(b));
    this.current.target.copy(this.desired.target);
    clampView(this.desired);
    clampView(this.current);
  }

  rotateBy(dx: number, dy: number) {
    this.desired.yaw -= dx * 0.005;
    this.desired.pitch = MathUtils.clamp(this.desired.pitch + dy * 0.004, MIN_PITCH, MAX_PITCH);
  }

  /** Zoom by a factor; with a cursor, keep the ground point under it fixed. */
  zoomBy(factor: number, ndc: Vector2 | null) {
    const before = ndc ? this.groundAt(ndc) : null;
    const next = MathUtils.clamp(this.desired.distance * factor, MIN_DIST, MAX_DIST);
    const applied = next / this.desired.distance;
    this.desired.distance = next;
    if (before) {
      // Move the target toward the cursor point by the same proportion.
      this.desired.target.lerp(before, 1 - applied);
      clampView(this.desired);
    }
  }

  /** Keyboard turn and zoom. */
  turn(radians: number) {
    this.touched();
    this.desired.yaw += radians;
  }

  zoom(factor: number) {
    this.touched();
    this.zoomBy(factor, null);
  }

  /** Marks programmatic-but-user-initiated moves (keyboard, lists) as input. */
  poke() {
    this.lastInput = performance.now();
  }

  /** Keyboard nudges (metres / radians per call, scaled by distance). */
  nudge(forward: number, right: number) {
    this.touched();
    this.follow = null;
    const s = this.desired.distance * 0.04;
    const yaw = this.desired.yaw;
    this.desired.target.x += (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * s;
    this.desired.target.z += (-Math.cos(yaw) * forward - Math.sin(yaw) * right) * s;
    clampView(this.desired);
  }
}

function cloneView(v: View): View {
  return { target: v.target.clone(), distance: v.distance, yaw: v.yaw, pitch: v.pitch };
}

function copyView(out: View, v: View) {
  out.target.copy(v.target);
  out.distance = v.distance;
  out.yaw = v.yaw;
  out.pitch = v.pitch;
}

function clampView(v: View) {
  v.target.x = MathUtils.clamp(v.target.x, BOUNDS.x0, BOUNDS.x1);
  v.target.z = MathUtils.clamp(v.target.z, BOUNDS.z0, BOUNDS.z1);
  v.target.y = 0;
  v.distance = MathUtils.clamp(v.distance, MIN_DIST, MAX_DIST);
  v.pitch = MathUtils.clamp(v.pitch, MIN_PITCH, MAX_PITCH);
}

function lerpAngle(a: number, b: number, t: number) {
  const d = ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
