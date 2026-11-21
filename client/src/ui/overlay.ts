import { type PerspectiveCamera, Vector3 } from 'three/webgpu';

// HTML pinned to points in the 3D world: plot name tags, agent badges and the
// small tool-call pop-ups. Positions are written through CSSOM each frame
// (the CSP forbids inline style attributes, not style properties set from JS).

export interface Pin {
  el: HTMLElement;
  world: Vector3;
  /** Pixels to lift the element above its point. */
  lift: number;
  /** Hidden when the point is behind the camera or off screen. */
  visible: boolean;
  /** Elements further than this (metres) fade out. */
  maxDistance: number;
}

const v = new Vector3();

export class Overlay {
  readonly root: HTMLElement;
  private readonly pins = new Set<Pin>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'overlay';
    parent.appendChild(this.root);
  }

  add(el: HTMLElement, world: Vector3, opts: { lift?: number; maxDistance?: number } = {}): Pin {
    this.root.appendChild(el);
    const pin: Pin = { el, world, lift: opts.lift ?? 0, visible: true, maxDistance: opts.maxDistance ?? 400 };
    this.pins.add(pin);
    return pin;
  }

  remove(pin: Pin) {
    pin.el.remove();
    this.pins.delete(pin);
  }

  update(camera: PerspectiveCamera, width: number, height: number) {
    for (const p of this.pins) {
      v.copy(p.world).project(camera);
      const dist = camera.position.distanceTo(p.world);
      const onScreen = v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15;
      const show = p.visible && onScreen && dist < p.maxDistance;
      p.el.classList.toggle('pin--hidden', !show);
      if (!show) continue;
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height - p.lift;
      p.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      // Nearer pins stack above farther ones.
      p.el.style.zIndex = String(10000 - Math.round(dist));
    }
  }
}
