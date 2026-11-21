import type { AppState } from '../app/state';
import type { Lane } from '../data/derive';
import { BAY_EDGE_X, BEACH, BEACH_ROAD, HANGOUT, OVERFLOW, PLOTS, PLOT_D, PLOT_W, PROMENADE, SKYLINE, STREETS_EW, STREETS_NS } from '../world/city/layout';
import { repoHex } from './panels';

// The round minimap, bottom left. It turns with the camera (what's ahead is
// up), shows the plots in their repo colours and every agent as a dot, and pins
// a pulsing blip to its rim for anyone who needs you beyond its edge. Clicking
// it flies the camera there.

export interface MapView {
  x: number;
  z: number;
  yaw: number;
  distance: number;
}

const LANE_COLOR: Record<Lane, string> = { needs: '#ff3f8e', working: '#2fd8ff', move: '#5dffa8', stale: '#a49dbd', shells: '#a49dbd' };

const C = {
  sea: '#0f4a5c',
  seaDeep: '#0b3546',
  sand: '#e7cfa6',
  land: '#3a3350',
  block: '#4a4262',
  road: '#6d6488',
  promenade: '#a98f88',
  vacant: 'rgba(255,255,255,0.10)',
};

export class Minimap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private size = 0;
  private dpr = 1;
  private inverse: DOMMatrix | null = null;
  private dirty = true;
  private lastKey = '';

  constructor(
    parent: HTMLElement,
    private readonly state: AppState,
    private readonly onFly: (x: number, z: number) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.innerHTML = '<canvas class="minimap__canvas" aria-hidden="true"></canvas><span class="minimap__you" aria-hidden="true"></span>';
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', 'Minimap: click to go there');
    parent.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', (e) => {
      if (!this.inverse) return;
      const r = this.canvas.getBoundingClientRect();
      const p = this.inverse.transformPoint(new DOMPoint((e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr));
      this.onFly(p.x, p.y);
    });
    new ResizeObserver(() => (this.dirty = true)).observe(this.el);
  }

  invalidate() {
    this.dirty = true;
  }

  /** Redraws when the view, the data or a pulsing blip asks for it. */
  draw(view: MapView, people: { id: string; x: number; z: number }[], now: number) {
    const anyNeeds = this.state.counts.needs > 0;
    const key = `${view.x.toFixed(1)},${view.z.toFixed(1)},${view.yaw.toFixed(3)},${view.distance.toFixed(0)}`;
    if (!this.dirty && key === this.lastKey && !anyNeeds) return;
    // Pulsing blips only need ~20 fps.
    if (!this.dirty && key === this.lastKey && anyNeeds && now % 50 > 17) return;
    this.lastKey = key;
    this.dirty = false;

    const css = this.el.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (css !== this.size || dpr !== this.dpr) {
      this.size = css;
      this.dpr = dpr;
      this.canvas.width = Math.round(css * dpr);
      this.canvas.height = Math.round(css * dpr);
    }
    const ctx = this.ctx;
    const W = this.canvas.width;
    const R = W / 2;
    const metres = Math.min(300, Math.max(95, view.distance * 0.85));
    const mpp = metres / R; // metres per device pixel
    const rx = Math.cos(view.yaw);
    const rz = -Math.sin(view.yaw);
    const fx = -Math.sin(view.yaw);
    const fz = -Math.cos(view.yaw);
    const a = rx / mpp;
    const c = rz / mpp;
    const b = -fx / mpp;
    const d = -fz / mpp;
    const e = R - (view.x * a + view.z * c);
    const f = R - (view.x * b + view.z * d);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = C.seaDeep;
    ctx.fillRect(0, 0, W, W);

    ctx.setTransform(a, b, c, d, e, f);
    this.inverse = new DOMMatrix([a, b, c, d, e, f]).inverse();
    const px = mpp; // one device pixel in metres
    const rect = (x0: number, z0: number, x1: number, z1: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
    };
    // Water, sand, land, the bay and the skyline across it.
    rect(-900, BEACH.zShore - 30, BAY_EDGE_X, BEACH.zShore, C.sea);
    rect(-900, BEACH.zShore, BAY_EDGE_X, PROMENADE.z0, C.sand);
    rect(-900, PROMENADE.z0, BAY_EDGE_X, 600, C.land);
    rect(-900, PROMENADE.z0, BAY_EDGE_X, PROMENADE.z1, C.promenade);
    rect(BAY_EDGE_X, -400, SKYLINE.x0 - 20, 700, C.sea);
    rect(SKYLINE.x0 - 20, SKYLINE.z0, SKYLINE.x1, SKYLINE.z1, C.land);
    // Streets.
    rect(-900, BEACH_ROAD.z0, BAY_EDGE_X, BEACH_ROAD.z1, C.road);
    for (const s of STREETS_EW) rect(-900, s.z - s.width / 2, BAY_EDGE_X, s.z + s.width / 2, C.road);
    for (const s of STREETS_NS) rect(s.x - s.width / 2, BEACH_ROAD.z0, s.x + s.width / 2, 600, C.road);

    // Plots: vacant ones faint, a repo's in its colour, pink while someone there needs you.
    const owner = new Map<number | string, { color: string; dormant: boolean }>();
    for (const [k, p] of Object.entries(this.state.snap?.world?.plots ?? {})) owner.set(p.plot, { color: repoHex(k), dormant: !p.active });
    const needsOn = new Set<number | string>();
    for (const r of this.state.rows.values()) if (r.lane === 'needs' && r.item.plot !== null && !r.item.archived) needsOn.add(r.item.plot);
    const plotRect = (key: number | string, x: number, z: number, w: number, dpt: number) => {
      const o = owner.get(key);
      const x0 = x - w / 2;
      const z0 = z - dpt / 2;
      ctx.fillStyle = o ? withAlpha(o.color, o.dormant ? 0.18 : 0.42) : C.vacant;
      roundRect(ctx, x0, z0, w, dpt, 2.2);
      ctx.fill();
      if (o || needsOn.has(key)) {
        ctx.lineWidth = px * (needsOn.has(key) ? 3 : 2);
        ctx.strokeStyle = needsOn.has(key) ? LANE_COLOR.needs : withAlpha(o!.color, o!.dormant ? 0.4 : 0.95);
        ctx.stroke();
      }
    };
    for (const p of PLOTS) plotRect(p.index, p.x, p.z, PLOT_W, PLOT_D);
    plotRect('hangout', HANGOUT.x, HANGOUT.z, 16, 12);
    plotRect('overflow', OVERFLOW.x, OVERFLOW.z, PLOT_D, PLOT_W);

    // People, needs-you on top.
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    const lanes = people.map((p) => ({ ...p, lane: this.state.row(p.id)?.lane ?? 'move' }));
    lanes.sort((x, y) => Number(x.lane === 'needs') - Number(y.lane === 'needs'));
    const outside: { x: number; z: number }[] = [];
    for (const p of lanes) {
      const dx = (p.x - view.x) / metres;
      const dz = (p.z - view.z) / metres;
      if (p.lane === 'needs' && dx * dx + dz * dz > 0.86) {
        outside.push(p);
        continue;
      }
      ctx.beginPath();
      const r = (p.lane === 'needs' ? 4.2 + pulse * 1.6 : 3) * px;
      ctx.arc(p.x, p.z, r, 0, Math.PI * 2);
      ctx.fillStyle = LANE_COLOR[p.lane as Lane];
      ctx.fill();
      ctx.lineWidth = px * 1.2;
      ctx.strokeStyle = 'rgba(12,8,24,0.8)';
      ctx.stroke();
    }

    // Pinned to the rim: who needs you beyond the edge.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const p of outside) {
      const dx = (p.x - view.x) * a + (p.z - view.z) * c;
      const dy = (p.x - view.x) * b + (p.z - view.z) * d;
      const len = Math.hypot(dx, dy) || 1;
      const rr = R - 9 * this.dpr;
      const x = R + (dx / len) * rr;
      const y = R + (dy / len) * rr;
      ctx.beginPath();
      ctx.arc(x, y, (5 + pulse * 1.8) * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = LANE_COLOR.needs;
      ctx.shadowColor = 'rgba(255,63,142,0.9)';
      ctx.shadowBlur = 8 * this.dpr;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
}

function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
