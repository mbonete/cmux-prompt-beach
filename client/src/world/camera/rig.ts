import { MathUtils, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three/webgpu';

// A damped three-quarter camera around a target on the ground.
//   left drag: pan · right drag / two fingers / shift-drag: rotate and tilt
//   wheel / pinch: zoom toward the cursor · double click: focus (handled by the world)
// Tilt is limited to 25°–65° so the city always reads as a city, never a map
// or a street view. Flights start at once and glide to a stop; reduced motion cuts instead.

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
/** How steep the camera may rise to see over a building behind it. */
const RISE_MAX_PITCH = MathUtils.degToRad(78);
/** The close-up distance the card's room (cardPx) is given for (World.FOCUS_DISTANCE). */
const CARD_DISTANCE = 17;
/** Metres beyond the zoom's destination checked for buildings, so rising starts early. */
const RISE_LOOKAHEAD = 4;
/**
 * Metres in front of the camera that still count: only what the camera itself
 * would hit (or have pressed against its lens). Anything further in front is
 * just in view, as with any camera (the building lookup adds a few metres of
 * slack around every footprint on top of this).
 */
const RISE_NEAR = 1.5;
/** Fastest the camera tilts up over a building (radians a second). */
const RISE_SPEED = MathUtils.degToRad(110);
/** The rise acts fully closer than this (metres from what the camera looks at)... */
const RISE_FULL = 25;
/** ...and not at all beyond this. */
const RISE_NONE = 40;
const MIN_DIST = 7;
/** Anything taller than this (metres) is building mass the camera must not pass through. */
const SOLID = 5;
const MAX_DIST = 270;
const BOUNDS = { x0: -130, x1: 135, z0: -90, z1: 118 };
/** Scratch for the zoom's collision check. */
const zoomTarget = new Vector3();

export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly current: View;
  readonly desired: View;
  reducedMotion = false;
  /** Set while a flight is running; cleared by any manual input. */
  private flight: { from: View; to: View; t: number; dur: number; shiftFrom: number; cardFrom: number } | null = null;
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
  /**
   * Room for an open card beside the person (px, at the close-up distance). It
   * is held constant in the world, not on screen: zooming out with a card open
   * then pulls straight back (a fixed pixel offset grows in metres as the camera
   * backs away, which slid the camera sideways), and the person drifts gently
   * toward the centre with their card.
   */
  cardPx = 0;
  private cardCur = 0;
  /** Canvas height in CSS pixels, for converting the shift to metres. */
  viewHeight = 1;
  private readonly right = new Vector3();
  private readonly look = new Vector3();
  /** Eased camera collision: how much of the distance is kept, and how far it is lifted. */
  private keep = 1;
  /** Extra pitch (radians) that lifts the camera over a building behind it. */
  private raise = 0;
  /** The part of it applied at the current distance (it fades out as you zoom out). */
  private raiseShown = 0;
  private lift = 0;
  /**
   * Collision corrections run only while the user steers the camera; a flight
   * lands on a destination already checked clear, so nothing moves after it.
   */
  private steering = false;
  private dt = 1 / 60;

  constructor(
    private readonly dom: HTMLElement,
    aspect: number,
  ) {
    this.camera = new PerspectiveCamera(32, aspect, 1, 6000);
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
    // Land somewhere clear: work out now how close the camera may come to what
    // it looks at, so nothing has to correct it after it arrives.
    this.clearDestination(to);
    // Start from where the camera visibly is: fold the collision corrections into
    // the view before dropping them, or the camera would jump as the flight begins.
    if (this.steering) {
      // The corrections only move the camera within its vertical plane, so the
      // visible camera is fully described by its distance and pitch from `look`.
      const dx = this.camera.position.x - this.look.x;
      const dy = this.camera.position.y - this.look.y;
      const dz = this.camera.position.z - this.look.z;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-3) {
        this.current.distance = len;
        this.current.pitch = Math.min(RISE_MAX_PITCH, Math.asin(MathUtils.clamp(dy / len, -1, 1)));
      }
    }
    this.keep = 1;
    this.lift = 0;
    this.raise = 0;
    this.raiseShown = 0;
    this.steering = false;
    if (this.reducedMotion) {
      copyView(this.desired, to);
      copyView(this.current, to);
      this.shiftCur = this.shiftPx;
      this.cardCur = this.cardPx;
      this.flight = null;
      return;
    }
    this.flight = { from: cloneView(this.current), to, t: 0, dur: seconds, shiftFrom: this.shiftCur, cardFrom: this.cardCur };
  }

  /** Keep the target on a moving point (e.g. a selected agent) until the user pans. */
  setFollow(fn: (() => Vector3 | null) | null) {
    this.follow = fn;
  }

  /** What the camera currently follows (the idle tour sets it aside and puts it back). */
  get following() {
    return this.follow;
  }

  update(dt: number) {
    this.dt = dt;
    if (this.flight) {
      // One smooth move: target, distance, angles and the card's framing shift all
      // ride the same curve and arrive together; nothing settles afterwards.
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = flightEase(f.t);
      this.shiftCur = MathUtils.lerp(f.shiftFrom, this.shiftPx, k);
      this.cardCur = MathUtils.lerp(f.cardFrom, this.cardPx, k);
      this.current.target.lerpVectors(f.from.target, f.to.target, k);
      // Distance moves in log space, so zooming in from far feels even, not a rush at the end.
      this.current.distance = Math.exp(MathUtils.lerp(Math.log(f.from.distance), Math.log(f.to.distance), k));
      this.current.yaw = lerpAngle(f.from.yaw, f.to.yaw, k);
      this.current.pitch = MathUtils.lerp(f.from.pitch, f.to.pitch, k);
      if (f.t >= 1) {
        copyView(this.desired, f.to);
        this.flight = null;
      }
    } else {
      this.shiftCur += (this.shiftPx - this.shiftCur) * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7));
      this.cardCur += (this.cardPx - this.cardCur) * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7));
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
    if (Math.abs(this.shiftPx - this.shiftCur) > 0.5 || Math.abs(this.cardPx - this.cardCur) > 0.5) return true;
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
    this.right.set(Math.cos(v.yaw), 0, -Math.sin(v.yaw)).multiplyScalar((this.shiftCur + this.cardShown(v.distance)) * perPx);
    this.look.copy(v.target).add(this.right);
    this.camera.position.set(
      this.look.x + Math.sin(v.yaw) * cp * v.distance,
      this.look.y + Math.sin(v.pitch) * v.distance,
      this.look.z + Math.cos(v.yaw) * cp * v.distance,
    );
    // In flight the destination is already clear; correcting on the way made the camera bob.
    if (this.obstacle && !this.flight && this.steering) this.avoidObstacles();
    if (this.camera.position.y < 1.5) this.camera.position.y = 1.5;
    this.camera.lookAt(this.look);
  }

  /**
   * Makes a destination view clear of buildings before flying there: shorter if
   * a building stands between the target and the camera, steeper if the camera
   * would end up too low over one.
   */
  private clearDestination(v: View) {
    if (!this.obstacle) return;
    const solid = (x: number, z: number) => {
      const h = this.obstacle!(x, z);
      return h > SOLID ? h : 0;
    };
    const from = v.target;
    if (v.distance <= 28) {
      const cp = Math.cos(v.pitch);
      const dx = Math.sin(v.yaw) * cp;
      const dy = Math.sin(v.pitch);
      const dz = Math.cos(v.yaw) * cp;
      for (let i = 1; i <= 40; i++) {
        const d = (i / 40) * v.distance;
        if (d < 4.5) continue;
        if (from.y + dy * d < solid(from.x + dx * d, from.z + dz * d) + 0.6) {
          v.distance = Math.max(MIN_DIST, d - 1.5);
          break;
        }
      }
    }
    for (let i = 0; i < 12; i++) {
      const cp = Math.cos(v.pitch);
      const x = from.x + Math.sin(v.yaw) * cp * v.distance;
      const z = from.z + Math.cos(v.yaw) * cp * v.distance;
      const y = from.y + Math.sin(v.pitch) * v.distance;
      const floor = solid(x, z) + roofGap(v.distance);
      if (y >= floor || v.pitch >= MAX_PITCH) break;
      v.pitch = Math.min(MAX_PITCH, v.pitch + MathUtils.degToRad(3));
    }
  }

  /** Building mass under a ground point (terrace clutter, umbrellas and string lights, is seen through). */
  private solid(x: number, z: number) {
    const h = this.obstacle!(x, z);
    return h > SOLID ? h : 0;
  }

  /**
   * The least pitch from which the camera clears the roofs at it: under it, just
   * in front of it, and as far behind it as the zoom is heading (the camera eases
   * toward that, so the rise starts before the camera reaches a wall, not after
   * it's inside).
   */
  private riseNeed(from: Vector3, distance: number, heading: number, pitch: number, yaw: number) {
    const sx = Math.sin(yaw);
    const sz = Math.cos(yaw);
    const horiz = (Math.max(distance, heading) + RISE_LOOKAHEAD) * Math.cos(pitch);
    const near = Math.max(4.5, distance * Math.cos(pitch) - RISE_NEAR);
    let need = pitch;
    const steps = Math.min(64, Math.ceil(horiz / 1.25));
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * horiz;
      if (d < near) continue;
      const h = this.solid(from.x + sx * d, from.z + sz * d);
      if (h) need = Math.max(need, Math.atan2(h + 0.8 - from.y, d));
    }
    return need;
  }

  /**
   * How much the collision would have to correct the camera at this view: the
   * extra tilt (radians) and the lift (metres). Both 0 when it sits clear.
   */
  private correctionAt(target: Vector3, distance: number, pitch: number, yaw: number) {
    zoomTarget.copy(target).add(this.right);
    const tilt = distance < RISE_NONE ? Math.max(0, this.riseNeed(zoomTarget, distance, distance, pitch, yaw) - pitch) : 0;
    const cp = Math.cos(pitch);
    const x = zoomTarget.x + Math.sin(yaw) * cp * distance;
    const z = zoomTarget.z + Math.cos(yaw) * cp * distance;
    const lift = Math.max(0, this.solid(x, z) + roofGap(distance) - (zoomTarget.y + Math.sin(pitch) * distance));
    return { tilt, lift };
  }

  /**
   * How far in a zoom may go: it stops just short of a roof rather than tilting
   * over it. Zooming toward something tall aims at the ground behind it, so the
   * camera's straight path runs into its roof; climbing over it instead made a
   * steady zoom tilt the view on its own.
   */
  private zoomStop(toward: Vector3 | null, next: number) {
    const v = this.desired;
    const target = v.target.clone();
    // Each step in may not need more correcting than where the zoom starts (none,
    // usually; if the camera is already hemmed in, zooming in may still free it).
    const start = this.correctionAt(target, v.distance, v.pitch, v.yaw);
    const clear = (d: number) => {
      if (toward) target.copy(v.target).lerp(toward, 1 - d / v.distance);
      const c = this.correctionAt(target, d, v.pitch, v.yaw);
      return c.tilt <= start.tilt + 1e-3 && c.lift <= start.lift + 0.01;
    };
    let ok = v.distance;
    for (let d = v.distance; d > next; ) {
      d = Math.max(next, d - Math.max(0.25, d * 0.02));
      if (!clear(d)) break;
      ok = d;
    }
    return ok;
  }

  /**
   * Camera collision, while you steer. A building behind the camera lifts it:
   * the camera keeps the distance you asked for and rises just enough to clear
   * the roof, so zooming out next to a building backs away and up in one move.
   * (Pulling the camera in front of the wall instead undid every scroll, then
   * let go all at once.) Only a tower too tall to rise over pulls the camera in.
   *
   * Only buildings at the camera count, not everything between it and what it
   * looks at: zooming toward a kiosk aims at the ground behind its roof, and
   * clearing the whole line made the camera climb over the very kiosk you were
   * zooming toward (tilting it on its own as you zoomed).
   */
  private avoidObstacles() {
    const cam = this.camera.position;
    const from = this.look;
    const v = this.current;
    const solid = (x: number, z: number) => this.solid(x, z);
    // In quickly, out slowly: the camera glides over a building and settles back after it.
    const ease = (cur: number, target: number, fast: boolean) =>
      this.reducedMotion ? target : cur + (target - cur) * (1 - Math.exp(-this.dt * (fast ? 14 : 2.5)));

    const sx = Math.sin(v.yaw);
    const sz = Math.cos(v.yaw);
    const need = this.riseNeed(from, v.distance, this.desired.distance, v.pitch, v.yaw);
    // Only close in: up close a building behind would put the camera inside it or
    // fill the view with a wall. Further out the camera is above the roofs anyway,
    // and tilting it as buildings pass behind while you pan feels like the camera
    // has a will of its own. Full within 25 m, fading out by 40 m.
    // The fade follows the distance directly (not a timer), so the camera settles
    // exactly as you zoom and is still the moment you stop.
    const reach = 1 - MathUtils.smoothstep(v.distance, RISE_FULL, RISE_NONE);
    const raiseTarget = Math.max(0, Math.min(RISE_MAX_PITCH, need) - v.pitch);
    // Rising is also capped in speed: a wall entering the view tilts the camera up
    // gently instead of lurching it up in one frame.
    const eased = ease(this.raise, raiseTarget, raiseTarget > this.raise);
    this.raise = this.reducedMotion ? eased : Math.min(eased, this.raise + RISE_SPEED * this.dt);
    this.raiseShown = this.raise * reach;
    const pitch = v.pitch + this.raiseShown;
    const cp = Math.cos(pitch);
    const dx = sx * cp * v.distance;
    const dy = Math.sin(pitch) * v.distance;
    const dz = sz * cp * v.distance;

    // Too tall to rise over (a tower right behind): come in front of it instead.
    let keepTarget = 1;
    if (need > RISE_MAX_PITCH && v.distance <= 28) {
      const len = v.distance;
      const n = Math.min(48, Math.ceil(len / 1.25));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const d = t * len;
        if (d < 4.5) continue;
        if (from.y + dy * t < solid(from.x + dx * t, from.z + dz * t) + 0.6) {
          keepTarget = Math.max((d - 1.5) / len, MIN_DIST / len);
          break;
        }
      }
    }
    this.keep = ease(this.keep, keepTarget, keepTarget < this.keep);
    cam.set(from.x + dx * this.keep, from.y + dy * this.keep, from.z + dz * this.keep);

    // Never inside a roof.
    const floor = solid(cam.x, cam.z) + roofGap(v.distance);
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
    // Taking over mid-flight: carry on from where the camera is. (`desired` still
    // held the view from before the flight, so a scroll or a drag sent the camera
    // back there, and could close the card that had just opened.)
    if (this.flight) copyView(this.desired, this.current);
    this.flight = null;
    this.steering = true;
    this.onInput?.();
  }

  private bind() {
    const el = this.dom;
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('pointerdown', (e) => {
      // Two pointers at most: a third finger made pinch-zoom jump and panning run triple speed.
      if (this.pointers.size >= 2) return;
      // Clicking the map puts away any text selection (the canvas doesn't by itself).
      if (!document.getSelection()?.isCollapsed) document.getSelection()?.removeAllRanges();
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

  /**
   * Zoom by a factor. Zooming in heads for the point under the cursor; zooming
   * out pulls straight back (anchoring it to the cursor slid the view sideways,
   * away from wherever the pointer happened to rest).
   */
  zoomBy(factor: number, ndc: Vector2 | null) {
    const before = ndc && factor < 1 ? this.groundAt(ndc) : null;
    let next = MathUtils.clamp(this.desired.distance * factor, MIN_DIST, MAX_DIST);
    if (next < this.desired.distance && this.obstacle) next = this.zoomStop(before, next);
    const applied = next / this.desired.distance;
    this.desired.distance = next;
    if (before) {
      // Move the target toward the cursor point by the same proportion.
      this.desired.target.lerp(before, 1 - applied);
      clampView(this.desired);
    }
  }

  /** The card's room in px at this distance: constant in metres, so it shrinks on screen as you back away. */
  private cardShown(distance: number) {
    return this.cardCur * Math.min(1, CARD_DISTANCE / Math.max(1, distance));
  }

  /**
   * The card is closing (you moved away): take its room into where the camera
   * points, so nothing on screen moves.
   */
  foldCard() {
    const px = this.cardShown(this.current.distance);
    this.cardCur = 0;
    this.cardPx = 0;
    if (!px) return;
    const perPx = (2 * this.current.distance * Math.tan(MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, this.viewHeight);
    const yaw = this.current.yaw;
    const dx = Math.cos(yaw) * px * perPx;
    const dz = -Math.sin(yaw) * px * perPx;
    for (const v of [this.current, this.desired]) {
      v.target.x += dx;
      v.target.z += dz;
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

/** How far above a roof the camera keeps (more from further out, where it moves faster). */
function roofGap(distance: number) {
  return distance > 28 ? 2.5 : 1.2;
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
  // Aim at the ground or a little above it (a person is framed at the waist).
  v.target.y = MathUtils.clamp(v.target.y, 0, 3);
  v.distance = MathUtils.clamp(v.distance, MIN_DIST, MAX_DIST);
  v.pitch = MathUtils.clamp(v.pitch, MIN_PITCH, MAX_PITCH);
}

function lerpAngle(a: number, b: number, t: number) {
  const d = ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

/**
 * Flights answer the click at once and glide to a soft stop: cubic-bezier(0.2,
 * 0.25, 0.25, 1). The ease-in-out used before stood almost still for the first
 * third (3% of the way after 0.3 s), so a flight seemed to start by itself a
 * moment after the click.
 */
function flightEase(t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = [0.2, 0.25, 0.25, 1];
  const bx = (u: number) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = (u: number) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  // Solve bx(u) = t (it is monotonic), then read y.
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 24; i++) {
    const x = bx(u);
    if (Math.abs(x - t) < 1e-5) break;
    if (x < t) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return by(u);
}
