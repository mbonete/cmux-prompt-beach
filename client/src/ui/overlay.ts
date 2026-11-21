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
  /** Tags give way (dim) when they collide with a nearer tag or any badge. */
  kind?: 'tag' | 'badge';
  /** Cached element size; set to null when the content changes. */
  size?: { w: number; h: number } | null;
  /** Last screen position (CSS px), for decluttering. */
  sx?: number;
  sy?: number;
  dist?: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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

  add(el: HTMLElement, world: Vector3, opts: { lift?: number; maxDistance?: number; kind?: 'tag' | 'badge' } = {}): Pin {
    this.root.appendChild(el);
    const pin: Pin = { el, world, lift: opts.lift ?? 0, visible: true, maxDistance: opts.maxDistance ?? 400, kind: opts.kind, size: null };
    this.pins.add(pin);
    return pin;
  }

  remove(pin: Pin) {
    pin.el.remove();
    this.pins.delete(pin);
  }

  update(camera: PerspectiveCamera, width: number, height: number) {
    const shown: Pin[] = [];
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
      if (p.kind) {
        p.sx = x;
        p.sy = y;
        p.dist = dist;
        shown.push(p);
      }
    }
    this.declutter(shown);
  }

  /** Tags that collide with a badge or a nearer tag dim, so the nearest and the urgent stay readable. */
  private declutter(pins: Pin[]) {
    const boxes: Box[] = [];
    const box = (p: Pin): Box => {
      if (!p.size) p.size = { w: p.el.offsetWidth, h: p.el.offsetHeight };
      const { w, h } = p.size;
      return { x0: p.sx! - w / 2, y0: p.sy! - h, x1: p.sx! + w / 2, y1: p.sy! };
    };
    const hit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    for (const p of pins) if (p.kind === 'badge' && p.el.classList.contains('agent--asking')) boxes.push(box(p));
    const tags = pins.filter((p) => p.kind === 'tag').sort((a, b) => a.dist! - b.dist!);
    for (const t of tags) {
      const b = box(t);
      const crowded = boxes.some((o) => hit(b, o));
      t.el.classList.toggle('pin--crowded', crowded);
      if (!crowded) boxes.push(b);
    }
  }
}
