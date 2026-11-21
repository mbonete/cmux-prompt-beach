import type { SwitchboardClient } from '../data/client';
import type { Item } from '../data/types';
import { ASK_ICON, ASK_TEXT } from '../ui/agentView';
import { AgentCard, type Insets } from '../ui/card';
import { EdgeArrows, type EdgeTarget } from '../ui/edges';
import { Hud, RAIL } from '../ui/hud';
import { Inspector } from '../ui/inspector';
import { Minimap } from '../ui/minimap';
import { Panels } from '../ui/panels';
import { Sound } from '../ui/sound';
import { Toasts } from '../ui/toasts';
import type { World } from '../world/World';
import { refreshTimes } from './format';
import { Actions } from './actions';
import { AppState, type PanelId, type Settings } from './state';

// Puts the page together: one state, the city (when 3D is available), and the
// HUD, panels, card, side panel, edge arrows, minimap, toasts and sound around
// it. Every view repaints from state; the city reports clicks and frames back.

const PANEL_GAP = 12;

export class App {
  readonly state = new AppState();
  private readonly root: HTMLElement;
  private readonly toasts: Toasts;
  private readonly actions: Actions;
  private readonly hud: Hud;
  private readonly panels: Panels;
  private readonly card: AgentCard;
  private readonly inspector: Inspector;
  private readonly edges: EdgeArrows | null;
  private readonly minimap: Minimap | null;
  private readonly sound = new Sound();
  private readonly cut: HTMLElement;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private applied: Partial<Settings> = {};
  private insets: Insets = { left: 96, top: 72, right: 16, bottom: 16 };
  private readonly scratch = { x: 0, y: 0, behind: false };
  /** Where the card is anchored on screen, eased so it never trembles. */
  private cardAnchor: { x: number; y: number; id: string; at: number } | null = null;
  private needsIds: string[] = [];
  /** Screen areas edge arrows keep off: the minimap and the controls hint. */
  private avoid: DOMRect[] = [];
  private lastSelected: string | null = null;

  constructor(
    root: HTMLElement,
    private readonly client: SwitchboardClient,
    private readonly world: World | null,
  ) {
    this.root = root;
    root.classList.add('app');
    root.classList.toggle('app--flat', !world);
    this.toasts = new Toasts(root);
    this.actions = new Actions(client, this.toasts);
    const hooks = {
      close: () => this.deselect(),
      collapse: () => this.state.select(this.state.selected, false),
      expand: (id: string, focusReply?: boolean) => {
        if (focusReply) this.inspector.wantReply();
        this.state.select(id, true);
      },
      focus: (id: string) => this.world?.focusAgent(id),
    };
    this.hud = new Hud(root, this.state, {
      onRail: (id) => this.rail(id),
      onCount: (lane) => {
        this.state.panel = 'agents';
        this.state.emit();
        requestAnimationFrame(() => this.panels.el.querySelector(`.group--${lane}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      },
      onTimeOfDay: (t) => this.state.setSettings({ timeOfDay: t }),
      onSound: () => {
        const on = !this.state.settings.sound;
        this.state.setSettings({ sound: on, chime: on ? true : this.state.settings.chime });
      },
      onHelp: () => this.state.openPanel('help'),
    });
    this.panels = new Panels(root, this.state, this.actions, {
      focusAgent: (id) => this.selectAgent(id),
      focusPlot: (key) => this.world?.focusPlot(key),
      status: () => {
        if (!this.world) return 'The 3D view is off on this device; the lists work as usual.';
        const s = this.world.status;
        return `${s.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · running ${s.quality} · ${Math.round(s.fps)} fps`;
      },
    });
    this.card = new AgentCard(root, this.state, this.actions, hooks);
    this.inspector = new Inspector(root, this.state, this.actions, hooks);
    this.edges = world ? new EdgeArrows(root, (id) => this.selectAgent(id)) : null;
    this.minimap = world ? new Minimap(root, this.state, (x, z) => world.flyToGround(x, z)) : null;
    this.cut = document.createElement('div');
    this.cut.className = 'cut';
    root.appendChild(this.cut);

    this.state.subscribe(() => this.render());
    this.state.onEvent((e) => {
      const it = e.row.item;
      if (e.type === 'needs') {
        const ask = e.row.ask ?? 'question';
        this.toasts.show({ tone: 'needs', icon: ASK_ICON[ask], text: `${it.title}: ${ASK_TEXT[ask].toLowerCase()}`, onClick: () => this.selectAgent(it.surfaceId) });
        this.sound.chime();
      } else {
        this.toasts.show({ tone: 'done', icon: 'result', text: `${it.title}: finished`, onClick: () => this.selectAgent(it.surfaceId) });
      }
    });
    this.reduced.addEventListener('change', () => this.applySettings(true));
    this.bindWorld();
    this.bindKeys();
    this.bindOverlay();
    window.addEventListener('resize', () => this.measure());
    // Browsers start audio only after a gesture; a saved "sound on" waits for the first one.
    window.addEventListener('pointerdown', () => this.sound.set(this.state.settings.sound, this.state.settings.chime), { once: true });
    window.setInterval(() => refreshTimes(root), 1000);
    this.applySettings(true);
    if (!world) this.state.openPanel('agents');
    this.render();
  }

  /** Opens the live link to the server. */
  connect() {
    if (!this.client.connected) {
      this.state.setConnection('offline');
      return;
    }
    this.client.connect({
      onSnapshot: (snap) => {
        this.world?.sync(snap);
        this.state.setSnapshot(snap);
      },
      onTick: (t) => this.world?.tick(t),
      onStatus: (st) => {
        if (st === 'restarted') location.reload();
        else this.state.setConnection(st);
      },
    });
  }

  // ------------------------------------------------------------ selection

  selectAgent(id: string) {
    const row = this.state.row(id);
    if (!row) return;
    const inWorld = this.inWorld(row.item);
    // Someone with no place in the city (a terminal, the 7th on a plot) opens straight in the side panel.
    const expanded = this.state.selected && this.state.expanded ? true : !inWorld;
    this.state.select(id, expanded);
    if (inWorld) this.world?.focusAgent(id);
  }

  private deselect() {
    this.state.select(null);
  }

  private inWorld(it: Item) {
    return Boolean(this.world && it.agent && it.phase !== 'shell' && !it.archived && it.plot !== null && it.spot !== null);
  }

  private rail(id: PanelId | null) {
    if (id === null) {
      if (this.state.panel === null) this.world?.overview();
      this.state.openPanel(null);
      return;
    }
    this.state.openPanel(id);
    if (this.state.panel) requestAnimationFrame(() => this.panels.focusFirst());
  }

  // ------------------------------------------------------------ render

  private render() {
    const s = this.state;
    this.hud.render();
    this.panels.render();
    this.card.render();
    this.inspector.render();
    this.root.classList.toggle('app--panel', s.panel !== null);
    this.root.classList.toggle('app--expanded', s.expanded);
    this.root.classList.toggle('app--card', this.card.open);
    this.applySettings(false);
    this.needsIds = s.lane('needs').map((r) => r.item.surfaceId);
    this.minimap?.invalidate();
    if (this.world) {
      const sel = s.selectedRow;
      if (s.selected !== this.lastSelected || sel) this.world.select(sel && this.inWorld(sel.item) ? s.selected : null, sel?.lane ?? null);
      this.lastSelected = s.selected;
      this.world.setNeeds(this.needsIds);
    }
    this.measure();
  }

  /** What the panels cover, so the card, arrows and camera framing avoid it. */
  private measure() {
    const rail = this.root.querySelector<HTMLElement>('.rail')?.getBoundingClientRect();
    const top = this.root.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect();
    const panelOpen = !this.panels.el.hidden;
    const insp = !this.inspector.el.hidden ? this.inspector.el.getBoundingClientRect() : null;
    const left = panelOpen ? this.panels.el.getBoundingClientRect().right + PANEL_GAP : (rail?.right ?? 80) + PANEL_GAP;
    const right = insp ? window.innerWidth - insp.left + PANEL_GAP : PANEL_GAP;
    this.insets = { left, top: (top?.bottom ?? 60) + PANEL_GAP, right, bottom: PANEL_GAP };
    this.avoid = [...this.root.querySelectorAll<HTMLElement>('.minimap, .hint:not(.hint--done)')]
      .filter((el) => el.offsetParent !== null && getComputedStyle(el).opacity !== '0')
      .map((el) => el.getBoundingClientRect());
    if (this.world) {
      // Keep what the camera looks at centred in the space the panels leave free.
      const base = (rail?.right ?? 80) + PANEL_GAP;
      // With the card open, the person sits a little left of centre so the card fits beside them.
      const card = this.card.open ? 150 : 0;
      this.world.rig.shiftPx = (right - PANEL_GAP - (left - base)) / 2 + card;
    }
  }

  // ------------------------------------------------------------ settings

  private applySettings(force: boolean) {
    const s = this.state.settings;
    const prev = this.applied;
    const reduced = s.motion === 'reduce' || (s.motion === 'system' && this.reduced.matches);
    this.root.classList.toggle('reduce-motion', reduced);
    const w = this.world;
    if (w) {
      if (force || prev.quality !== s.quality) w.setQuality(s.quality);
      if (force || prev.timeOfDay !== s.timeOfDay) w.setTimeOfDay(s.timeOfDay, force);
      if (force || prev.staleAfterMs !== s.staleAfterMs) w.setStaleAfter(s.staleAfterMs);
      if (force || prev.motion !== s.motion) w.setReducedMotion(reduced);
      if (force || prev.idleCamera !== s.idleCamera || prev.motion !== s.motion) w.setIdleCamera(s.idleCamera);
    }
    // Sound can only start inside a click; a saved "on" waits for the first pointerdown.
    if (!force && (prev.sound !== s.sound || prev.chime !== s.chime)) this.sound.set(s.sound, s.chime);
    this.applied = { ...s };
  }

  // ------------------------------------------------------------ world

  private bindWorld() {
    const w = this.world;
    if (!w) return;
    w.onPick = (p) => {
      this.hud.used_('pick');
      if (p.kind === 'agent') this.selectAgent(p.id);
      else if (p.kind === 'plot') {
        if (this.state.selected) this.deselect();
        w.focusPlot(p.key);
      } else if (this.state.selected && !this.state.expanded) this.deselect();
    };
    w.rig.onUse = (k) => this.hud.used_(k);
    w.director.onChange = (on) => this.root.classList.toggle('app--idle', on);
    w.director.onCut = (phase) => this.cut.classList.toggle('cut--dark', phase === 'out');
    const stop = () => w.director.stop();
    for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const) window.addEventListener(ev, stop, { passive: true, capture: true });

    w.onFrame = (_cam, width, height, now) => {
      const view = { w: width, h: height };
      const sel = this.state.selected;
      if (this.card.open && sel) {
        const ok = w.screenOf(sel, this.scratch) && !this.scratch.behind;
        if (!ok) this.cardAnchor = null;
        else {
          const a = this.cardAnchor;
          const dt = a ? Math.min(0.1, (now - a.at) / 1000) : 0;
          if (!a || a.id !== sel) this.cardAnchor = { x: this.scratch.x, y: this.scratch.y, id: sel, at: now };
          else {
            // Follow the camera's moves smoothly; ignore sub-pixel wobble.
            const dx = this.scratch.x - a.x;
            const dy = this.scratch.y - a.y;
            const k = 1 - Math.exp(-dt * 14);
            if (Math.abs(dx) > 0.75) a.x += dx * k;
            if (Math.abs(dy) > 0.75) a.y += dy * k;
            a.at = now;
          }
        }
        this.card.place(this.cardAnchor, view, this.insets);
      }
      if (this.edges) {
        const targets: EdgeTarget[] = [];
        for (const id of this.needsIds) {
          const row = this.state.row(id);
          if (!row || !w.screenOf(id, this.scratch)) continue;
          targets.push({ row, x: this.scratch.x, y: this.scratch.y, behind: this.scratch.behind });
        }
        this.edges.update(targets, view, { ...this.insets, bottom: this.insets.bottom + 4 }, this.avoid);
      }
      this.minimap?.draw(w.view, w.peoplePositions, now);
    };
  }

  /**
   * The page itself never zooms: a trackpad pinch arrives as ctrl+wheel, and over
   * a label or panel the browser would zoom the whole page (leaving the HUD off
   * screen with no way back). Over the city's labels and arrows, wheel and pinch
   * drive the camera instead; over panels they do nothing.
   */
  private bindZoomGuard() {
    const canvas = this.world?.renderer.domElement as HTMLCanvasElement | undefined;
    window.addEventListener(
      'wheel',
      (e) => {
        const t = e.target as HTMLElement;
        if (canvas && t !== canvas && t.closest('.overlay, .edges')) {
          e.preventDefault();
          canvas.dispatchEvent(
            new WheelEvent('wheel', { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, bubbles: true, cancelable: true }),
          );
        } else if (e.ctrlKey) e.preventDefault();
      },
      { passive: false },
    );
    // Safari's pinch.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  /** People's name tags and badges, and plot tags, are clickable too. */
  private bindOverlay() {
    this.bindZoomGuard();
    const root = this.world?.overlay.root;
    if (!root) return;
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const agent = t.closest<HTMLElement>('.agent[data-id]');
      if (agent) return this.selectAgent(agent.dataset.id!);
      const tag = t.closest<HTMLElement>('.tag[data-plot]');
      if (tag) {
        const k = tag.dataset.plot!;
        this.world?.focusPlot(k === 'hangout' || k === 'overflow' ? k : Number(k));
      }
    });
  }

  // ------------------------------------------------------------ keyboard

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      const typing = t.matches('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        if (typing) return;
        if (this.state.panel && this.panels.el.contains(t)) {
          const id = this.state.panel;
          this.state.openPanel(null);
          this.hud.railButton(id)?.focus();
        } else if (this.state.selected) this.deselect();
        else if (this.state.panel) this.state.openPanel(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const rig = this.world?.rig;
      const k = e.key;
      const rail = RAIL.find((r) => r.key === k);
      if (rail) {
        e.preventDefault();
        return this.rail(rail.id);
      }
      switch (k) {
        case '/':
          e.preventDefault();
          if (this.state.panel !== 'agents') this.state.openPanel('agents');
          requestAnimationFrame(() => this.panels.focusFirst());
          return;
        case '?':
          return this.state.openPanel('help');
        case 'n':
        case 'N': {
          const ids = this.needsIds;
          if (!ids.length) {
            this.toasts.show({ tone: 'info', icon: 'check', text: 'Nobody needs you right now.' });
            return;
          }
          const i = ids.indexOf(this.state.selected ?? '');
          return this.selectAgent(ids[(i + 1) % ids.length]);
        }
        case 'f':
        case 'F':
          if (this.state.selected && this.world?.focusAgent(this.state.selected)) return;
          return this.world?.overview();
      }
      if (!rig || t.closest('.panel, .inspector, .card')) return;
      const step: Record<string, [number, number]> = { w: [1, 0], ArrowUp: [1, 0], s: [-1, 0], ArrowDown: [-1, 0], a: [0, -1], ArrowLeft: [0, -1], d: [0, 1], ArrowRight: [0, 1] };
      const mv = step[k] ?? step[k.toLowerCase()];
      if (mv) {
        e.preventDefault();
        rig.setFollow(null);
        rig.nudge(mv[0], mv[1]);
        this.hud.used_('pan');
      } else if (k === 'q' || k === 'Q' || k === 'e' || k === 'E') {
        rig.turn(k.toLowerCase() === 'q' ? 0.12 : -0.12);
        this.hud.used_('rotate');
      } else if (k === '+' || k === '=' || k === '-' || k === '_') {
        rig.zoom(k === '-' || k === '_' ? 1.2 : 1 / 1.2);
        this.hud.used_('zoom');
      }
    });
  }
}
