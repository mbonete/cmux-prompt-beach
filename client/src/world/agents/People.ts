import { type Camera, Frustum, Matrix4, type Scene, Sphere, Vector2, Vector3 } from 'three/webgpu';
import { askOf, laneOf, type Ask, type Lane } from '../../data/derive';
import type { Item, Tick, ToolCategory } from '../../data/types';
import { crewText, crewTitle } from '../../ui/agentView';
import { icon, type IconName } from '../../ui/icons';
import type { Overlay, Pin } from '../../ui/overlay';
import type { District, PlotKey } from '../city/District';
import type { Cast } from './cast';
import { type Mood, Person, SHADOW_DISTANCE } from './Person';
import { behindCamera } from '../engine/behind';

// Keeps one Person per live agent, at its plot and spot, with a badge saying
// how they need you and small pop-ups for each tool call.

interface Entry {
  person: Person;
  plot: PlotKey;
  spot: number;
  /** Badge (needs you) and name label, pinned above the head. */
  badge: Pin;
  ask: Ask | null;
  lane: Lane;
  title: string;
  named: boolean;
  /** Helpers running inside this session: shown as one "Crew N" badge. */
  crew: number;
  /** The tool-call icon over their head, if one is up (never more than one each). */
  pop: Pin | null;
}

/** Names show up close; further out only the needs-you badges remain. */
const NAME_DISTANCE = 58;
/** Tool-call icons on screen at once, across everyone: a swarm can't fill the sky with them. */
const MAX_POPS = 12;
/**
 * Skinned people can't use three's own culling (their bounds are the bind pose),
 * so they're culled here: a sphere round the body, wide enough for a long
 * golden-hour shadow while their shadow is drawn. Out of view, no draw calls and
 * no animation: what a crowd costs follows what's on screen, not its size.
 */
const BODY_RADIUS = 1.6;
const SHADOW_REACH = 6;
const frustum = new Frustum();
const viewProj = new Matrix4();
const bounds = new Sphere();
const POP_MS = 1700;
const tmp = new Vector3();
const ndcV = new Vector3();

const ASK_ICON: Record<Ask, IconName> = { permission: 'permission', question: 'question', plan: 'plan', terminal: 'terminal', result: 'result' };
const ASK_LABEL: Record<Ask, string> = { permission: 'Wants permission', question: 'Has a question', plan: 'Plan to approve', terminal: 'Waiting in the terminal', result: 'Finished' };
const TOOL_ICON: Record<ToolCategory, IconName> = { edit: 'edit', command: 'command', search: 'search', web: 'web', read: 'read', other: 'other' };

export class People {
  private readonly entries = new Map<string, Entry>();
  private reducedMotion = false;
  private readonly head = new Vector3();
  private hovered: string | null = null;
  private selected: string | null = null;
  private pops = 0;

  constructor(
    private readonly scene: Scene,
    private readonly cast: Cast,
    private readonly district: District,
    private readonly overlay: Overlay,
  ) {}

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
    for (const e of this.entries.values()) e.person.reducedMotion = on;
  }

  /**
   * Someone in view is mid sit-down or stand-up. (Off screen nobody is
   * animated, so a clip started there waits for its next visible frame and
   * would have held the city awake forever.)
   */
  get transitioning() {
    for (const e of this.entries.values()) if (e.person.transitioning && e.person.root.visible) return true;
    return false;
  }

  sync(items: Item[], staleMs: number) {
    const now = Date.now();
    const live = new Set<string>();
    const taken = new Set([...this.entries.values()].map((e) => e.person.avatarId));

    for (const item of items) {
      if (!item.agent || item.phase === 'shell' || item.archived || item.plot === null || item.spot === null) continue;
      const spot = this.district.spot(item.plot, item.spot);
      if (!spot) continue;
      live.add(item.surfaceId);
      const lane = laneOf(item, now, staleMs);
      const ask = askOf(item, lane);

      let e = this.entries.get(item.surfaceId);
      // Moving to another seat or plot rebuilds the person: they keep their look
      // (picking again counted their own avatar as taken and gave them another).
      let keepAvatar: string | null = null;
      if (e && (e.plot !== item.plot || e.spot !== item.spot)) {
        keepAvatar = e.person.avatarId;
        this.remove(item.surfaceId);
        e = undefined;
      }
      if (!e) {
        const avatarId = keepAvatar ?? this.cast.pick(item.agent.sessionId, taken);
        taken.add(avatarId);
        const person = new Person(item.surfaceId, avatarId, spot, this.cast);
        person.reducedMotion = this.reducedMotion;
        const standAt = person.standPoint(new Vector3());
        if (standAt) person.roomToStand = this.district.roomToStand(item.plot, standAt.x, standAt.z, spot.position.y);
        this.district.setDeskItem(item.plot, item.spot, true);
        this.scene.add(person.root);
        const el = document.createElement('div');
        el.className = 'agent';
        el.innerHTML = '<span class="badge"></span><span class="agent__name"></span><span class="agent__crew" hidden></span>';
        el.dataset.id = item.surfaceId;
        const badge = this.overlay.add(el, new Vector3(), { lift: 4, maxDistance: 320, kind: 'badge' });
        e = { person, plot: item.plot, spot: item.spot, badge, ask: null, lane, title: '', named: false, crew: 0, pop: null };
        this.entries.set(item.surfaceId, e);
        person.setMood(moodFor(lane, ask, null), true);
      } else {
        const justFinished = e.lane === 'working' && ask === 'result';
        e.person.setMood(moodFor(lane, ask, justFinished ? 'celebrate' : null));
      }
      if (e.lane !== lane) {
        e.badge.el.classList.remove(`agent--${e.lane}`);
        e.lane = lane;
      }
      e.badge.el.classList.add(`agent--${lane}`);
      if (e.ask !== ask) {
        e.ask = ask;
        const b = e.badge.el.querySelector<HTMLElement>('.badge')!;
        b.className = `badge${ask ? ` badge--${ask}` : ''}`;
        b.innerHTML = ask ? `${icon(ASK_ICON[ask], 'i badge__icon')}<span class="sr">${ASK_LABEL[ask]}</span>` : '';
        e.badge.el.classList.toggle('agent--asking', ask !== null);
        e.badge.size = null; // re-measure for label spacing
      }
      if (e.title !== item.title) {
        e.title = item.title;
        e.badge.el.querySelector('.agent__name')!.textContent = item.title;
        e.badge.size = null;
      }
      const crew = item.crew ?? 0;
      if (e.crew !== crew) {
        e.crew = crew;
        const c = e.badge.el.querySelector<HTMLElement>('.agent__crew')!;
        c.hidden = crew === 0;
        c.textContent = crew ? crewText(crew) : '';
        c.title = crew ? crewTitle(crew) : '';
        e.badge.size = null;
      }
      this.paintPin(e);
    }
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.remove(id);
  }

  /**
   * A small icon pops above someone at work on a tool call: one at a time per
   * person and MAX_POPS in all, so a session with a big crew (all of whose tool
   * calls arrive as its own) shows the same as any busy one.
   */
  tick(t: Tick, camera: Camera) {
    const e = this.entries.get(t.surfaceId);
    if (!e || !t.tool || this.reducedMotion || e.pop || this.pops >= MAX_POPS) return;
    if (camera.position.distanceTo(e.person.root.position) > 150) return;
    const el = document.createElement('div');
    el.className = `pop pop--${t.tool.category}`;
    el.innerHTML = icon(TOOL_ICON[t.tool.category], 'i');
    const pin = this.overlay.add(el, e.person.headPosition(new Vector3()), { lift: 10, maxDistance: 150 });
    e.pop = pin;
    this.pops += 1;
    setTimeout(() => this.dropPop(e, pin), POP_MS);
  }

  private dropPop(e: Entry, pin: Pin) {
    if (e.pop !== pin) return;
    this.overlay.remove(pin);
    e.pop = null;
    this.pops -= 1;
  }

  update(dt: number, camera: Camera) {
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const e of this.entries.values()) {
      const at = e.person.root.position;
      const dist = camera.position.distanceTo(at);
      bounds.center.set(at.x, at.y + 0.9, at.z);
      bounds.radius = dist < SHADOW_DISTANCE ? SHADOW_REACH : BODY_RADIUS;
      e.person.update(dt, camera, frustum.intersectsSphere(bounds));
      const near = dist < NAME_DISTANCE;
      if (near !== e.named) {
        e.named = near;
        this.paintPin(e);
      }
      if (e.badge.visible) e.person.headPosition(e.badge.world);
    }
  }

  /** Badge when they need you; the name when close, hovered or selected. */
  private paintPin(e: Entry) {
    const id = e.person.id;
    const name = e.named || id === this.hovered || id === this.selected;
    if (e.badge.el.classList.contains('agent--named') !== name) e.badge.size = null;
    e.badge.el.classList.toggle('agent--named', name);
    e.badge.el.classList.toggle('agent--selected', id === this.selected);
    e.badge.visible = e.ask !== null || name || e.crew > 0;
  }

  setHover(id: string | null) {
    if (id === this.hovered) return;
    const prev = this.hovered;
    this.hovered = id;
    for (const k of [prev, id]) {
      const e = k ? this.entries.get(k) : null;
      if (e) this.paintPin(e);
    }
  }

  setSelected(id: string | null) {
    if (id === this.selected) return;
    const prev = this.selected;
    this.selected = id;
    for (const k of [prev, id]) {
      const e = k ? this.entries.get(k) : null;
      if (e) this.paintPin(e);
    }
  }

  /** The person nearest the pointer on screen, if close enough to mean them. */
  pick(camera: Camera, ndc: Vector2, w: number, h: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, e] of this.entries) {
      tmp.copy(e.person.root.position);
      tmp.y += 0.95;
      const dist = camera.position.distanceTo(tmp);
      ndcV.copy(tmp).project(camera);
      if (behindCamera(camera, tmp)) continue;
      const dx = ((ndcV.x - ndc.x) * w) / 2;
      const dy = ((ndcV.y - ndc.y) * h) / 2;
      const px = Math.hypot(dx, dy);
      // About a metre around the body, never less than 18 px.
      const reach = Math.max(18, (h / (2 * Math.tan(0.28) * dist)) * 0.9);
      if (px < reach && px < bestD) {
        bestD = px;
        best = id;
      }
    }
    return best;
  }

  /** Every person's ground position, for the minimap. */
  positions(): { id: string; x: number; z: number }[] {
    return [...this.entries].map(([id, e]) => ({ id, x: e.person.root.position.x, z: e.person.root.position.z }));
  }

  /** The tag element for an agent (the card and hover use it). */
  pinOf(id: string) {
    return this.entries.get(id)?.badge ?? null;
  }

  private remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.person.dispose();
    if (e.plot !== null && e.spot !== null) this.district.setDeskItem(e.plot, e.spot, false);
    if (e.pop) this.dropPop(e, e.pop);
    this.overlay.remove(e.badge);
    this.entries.delete(id);
  }

  get size() {
    return this.entries.size;
  }

  personFor(surfaceId: string) {
    return this.entries.get(surfaceId)?.person ?? null;
  }

  positionOf(surfaceId: string, out: Vector3): Vector3 | null {
    const e = this.entries.get(surfaceId);
    return e ? out.copy(e.person.root.position) : null;
  }

  /**
   * A steady point above someone (their spot, not their head bone), for HTML that
   * should follow them without picking up every breath and gesture.
   */
  anchorOf(surfaceId: string, out: Vector3): Vector3 | null {
    const e = this.entries.get(surfaceId);
    return e ? out.copy(e.person.root.position).setY(e.person.root.position.y + 1.7) : null;
  }

  headOf(surfaceId: string): Vector3 | null {
    const e = this.entries.get(surfaceId);
    return e ? e.person.headPosition(this.head) : null;
  }
}

function moodFor(lane: Lane, ask: Ask | null, override: Mood | null): Mood {
  if (override) return override;
  if (lane === 'working') return 'work';
  if (lane === 'needs') return ask === 'result' ? 'relax' : 'ask';
  if (lane === 'stale') return 'doze';
  return 'relax';
}
