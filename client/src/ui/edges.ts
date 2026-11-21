import type { Row } from '../app/state';
import type { Ask } from '../data/derive';
import { ASK_ICON } from './agentView';
import { icon } from './icons';
import type { Insets } from './card';

// Arrows at the screen edge for people who need you but are off screen. Each
// sits where the line from the screen centre toward them leaves the view, points
// at them and carries their badge; clicking one flies there. Arrows that would
// overlap merge into one with a count, and past MAX_ARROWS they merge by
// direction (eight of them), so a swarm needing you can't line the screen.

export interface EdgeTarget {
  row: Row;
  /** Projected position in CSS pixels; `behind` when the point is behind the camera. */
  x: number;
  y: number;
  behind: boolean;
}

interface Arrow {
  el: HTMLButtonElement;
  ids: string[];
}

const SIZE = 44;
const MERGE = 56;
const MAX_ARROWS = 8;
const SECTOR = Math.PI / 4;

export class EdgeArrows {
  readonly root: HTMLElement;
  private pool: Arrow[] = [];

  constructor(
    parent: HTMLElement,
    private readonly onPick: (id: string) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'edges';
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.edge');
      const id = b?.dataset.id;
      if (id) this.onPick(id);
    });
  }

  /** `avoid`: screen rectangles (the minimap, the hint) an arrow must not sit on. */
  update(targets: EdgeTarget[], view: { w: number; h: number }, insets: Insets, avoid: DOMRect[] = []) {
    const cx = view.w / 2;
    const cy = view.h / 2;
    const x0 = insets.left + SIZE / 2 + 8;
    const x1 = view.w - insets.right - SIZE / 2 - 8;
    const y0 = insets.top + SIZE / 2 + 8;
    const y1 = view.h - insets.bottom - SIZE / 2 - 8;
    const placed: { x: number; y: number; angle: number; ids: string[]; ask: Ask | null; title: string }[] = [];

    for (const t of targets) {
      let dx = t.x - cx;
      let dy = t.y - cy;
      if (t.behind) {
        dx = -dx;
        dy = -dy;
        if (Math.abs(dy) < 1 && Math.abs(dx) < 1) dy = 1;
      }
      const inside = !t.behind && t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1;
      if (inside) continue;
      // Intersect the ray from the centre with the inset rectangle.
      const sx = dx > 0 ? (x1 - cx) / dx : dx < 0 ? (x0 - cx) / dx : Infinity;
      const sy = dy > 0 ? (y1 - cy) / dy : dy < 0 ? (y0 - cy) / dy : Infinity;
      const s = Math.min(sx, sy);
      let x = cx + dx * s;
      let y = cy + dy * s;
      for (const r of avoid) {
        const pad = SIZE / 2 + 6;
        if (x < r.left - pad || x > r.right + pad || y < r.top - pad || y > r.bottom + pad) continue;
        // Slide along the edge it sits on until it clears the obstacle.
        if (sy <= sx) x = r.left + r.width / 2 < cx ? r.right + pad : r.left - pad;
        else y = r.top - pad;
      }
      const angle = Math.atan2(dy, dx);
      const near = placed.find((p) => Math.hypot(p.x - x, p.y - y) < MERGE);
      if (near) near.ids.push(t.row.item.surfaceId);
      else placed.push({ x, y, angle, ids: [t.row.item.surfaceId], ask: t.row.ask, title: t.row.item.title });
    }
    if (placed.length > MAX_ARROWS) {
      // One arrow per direction; it keeps the place of the first (nearest) one there.
      const bySector = new Map<number, (typeof placed)[number]>();
      for (const p of placed) {
        const k = ((Math.round(p.angle / SECTOR) % 8) + 8) % 8;
        const kept = bySector.get(k);
        if (kept) kept.ids.push(...p.ids);
        else bySector.set(k, p);
      }
      placed.length = 0;
      placed.push(...bySector.values());
    }

    while (this.pool.length < placed.length) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'edge';
      this.root.appendChild(el);
      this.pool.push({ el, ids: [] });
    }
    this.pool.forEach((a, i) => {
      const p = placed[i];
      if (!p) {
        a.el.hidden = true;
        a.ids = [];
        return;
      }
      a.el.hidden = false;
      const key = `${p.ids.join(',')}|${p.ask}`;
      if (a.el.dataset.key !== key) {
        a.el.dataset.key = key;
        a.el.dataset.id = p.ids[0];
        const more = p.ids.length > 1 ? `<span class="edge__more">${p.ids.length}</span>` : '';
        a.el.innerHTML = `<span class="edge__arrow" aria-hidden="true"></span><span class="edge__badge${p.ask === 'result' ? ' edge__badge--done' : ''}">${icon(
          p.ask ? ASK_ICON[p.ask] : 'warning',
          'i',
        )}</span>${more}`;
        a.el.setAttribute('aria-label', p.ids.length > 1 ? `${p.ids.length} people need you this way` : `${p.title} needs you: go there`);
        a.el.title = p.ids.length > 1 ? `${p.ids.length} need you this way` : p.title;
      }
      a.el.style.transform = `translate3d(${(p.x - SIZE / 2).toFixed(1)}px, ${(p.y - SIZE / 2).toFixed(1)}px, 0)`;
      a.el.style.setProperty('--angle', `${p.angle}rad`);
    });
  }
}
