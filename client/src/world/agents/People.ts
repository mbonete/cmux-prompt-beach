import { type Camera, type Scene, Vector3 } from 'three/webgpu';
import { askOf, laneOf, type Ask, type Lane } from '../../data/derive';
import type { Item, Tick, ToolCategory } from '../../data/types';
import { icon, type IconName } from '../../ui/icons';
import type { Overlay, Pin } from '../../ui/overlay';
import type { District, PlotKey } from '../city/District';
import type { Cast } from './cast';
import { type Mood, Person } from './Person';

// Keeps one Person per live agent, at its plot and spot, with a badge saying
// how they need you and small pop-ups for each tool call.

interface Entry {
  person: Person;
  plot: PlotKey;
  spot: number;
  badge: Pin;
  ask: Ask | null;
  lane: Lane;
}

const ASK_ICON: Record<Ask, IconName> = { permission: 'permission', question: 'question', plan: 'plan', terminal: 'terminal', result: 'result' };
const ASK_LABEL: Record<Ask, string> = { permission: 'Wants permission', question: 'Has a question', plan: 'Plan to approve', terminal: 'Waiting in the terminal', result: 'Finished' };
const TOOL_ICON: Record<ToolCategory, IconName> = { edit: 'edit', command: 'command', search: 'search', web: 'web', read: 'read', other: 'other' };

export class People {
  private readonly entries = new Map<string, Entry>();
  private reducedMotion = false;
  private readonly head = new Vector3();

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
      if (e && (e.plot !== item.plot || e.spot !== item.spot)) {
        this.remove(item.surfaceId);
        e = undefined;
      }
      if (!e) {
        const avatarId = this.cast.pick(item.agent.sessionId, taken);
        taken.add(avatarId);
        const person = new Person(item.surfaceId, avatarId, spot, this.cast);
        person.reducedMotion = this.reducedMotion;
        this.scene.add(person.root);
        const el = document.createElement('div');
        el.className = 'badge';
        const badge = this.overlay.add(el, new Vector3(), { lift: 4, maxDistance: 320 });
        e = { person, plot: item.plot, spot: item.spot, badge, ask: null, lane };
        this.entries.set(item.surfaceId, e);
        person.setMood(moodFor(lane, ask, null), true);
      } else {
        const justFinished = e.lane === 'working' && ask === 'result';
        e.person.setMood(moodFor(lane, ask, justFinished ? 'celebrate' : null));
      }
      e.lane = lane;
      if (e.ask !== ask) {
        e.ask = ask;
        e.badge.el.className = `badge${ask ? ` badge--${ask}` : ''}`;
        e.badge.el.innerHTML = ask ? `${icon(ASK_ICON[ask], 'i badge__icon')}<span class="sr">${ASK_LABEL[ask]}</span>` : '';
      }
      e.badge.visible = ask !== null;
      e.badge.el.title = item.title;
    }
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.remove(id);
  }

  /** A small icon pops above someone at work on each tool call. */
  tick(t: Tick, camera: Camera) {
    const e = this.entries.get(t.surfaceId);
    if (!e || !t.tool || this.reducedMotion) return;
    if (camera.position.distanceTo(e.person.root.position) > 150) return;
    const el = document.createElement('div');
    el.className = `pop pop--${t.tool.category}`;
    el.innerHTML = icon(TOOL_ICON[t.tool.category], 'i');
    const pin = this.overlay.add(el, e.person.headPosition(new Vector3()), { lift: 10, maxDistance: 150 });
    setTimeout(() => this.overlay.remove(pin), 1700);
  }

  update(dt: number, camera: Camera) {
    for (const e of this.entries.values()) {
      e.person.update(dt, camera);
      if (e.badge.visible) e.person.headPosition(e.badge.world);
    }
  }

  private remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.person.dispose();
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
