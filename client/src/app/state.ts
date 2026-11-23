import { DEFAULT_STALE_MS, SORTS, askOf, laneOf, type Ask, type Lane } from '../data/derive';
import type { Item, Snapshot } from '../data/types';
import type { QualitySetting } from '../world/engine/quality';

// The page's single source of truth: the latest snapshot with every session's
// lane worked out, the user's settings, and what is selected or open. Views
// subscribe and repaint; nothing else keeps its own copy of the data.

export type PanelId = 'projects' | 'agents' | 'inbox' | 'archive' | 'settings' | 'help';
export type Motion = 'system' | 'reduce' | 'full';
export type Connection = 'connecting' | 'live' | 'retrying' | 'restarted' | 'offline';

export interface Settings {
  quality: QualitySetting;
  staleAfterMs: number;
  sound: boolean;
  chime: boolean;
  idleCamera: boolean;
  /** Ambient motion even when nobody is using the city (off: it holds still after 45 s without input). */
  liveMotion: boolean;
  motion: Motion;
}

export const STALE_CHOICES: { ms: number; label: string }[] = [
  { ms: 3600e3, label: '1 hour' },
  { ms: 6 * 3600e3, label: '6 hours' },
  { ms: 24 * 3600e3, label: '1 day' },
  { ms: DEFAULT_STALE_MS, label: '2 days' },
  { ms: 7 * 24 * 3600e3, label: '1 week' },
];

const DEFAULTS: Settings = {
  quality: 'auto',
  staleAfterMs: DEFAULT_STALE_MS,
  sound: false,
  chime: false,
  idleCamera: true,
  liveMotion: false,
  motion: 'system',
};

export interface Row {
  item: Item;
  lane: Lane;
  ask: Ask | null;
}

export type WorldEvent =
  | { type: 'needs'; row: Row }
  | { type: 'finished'; row: Row };

type Listener = () => void;

const KEY = 'promptBeach.settings';
// Keys from before the project was renamed from Switchboard, read when the new ones are missing.
const OLD_KEY = 'switchboard.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    // Carry over the look-dev strip's quality key.
    const q = (localStorage.getItem('promptBeach.quality') ?? localStorage.getItem('switchboard.quality')) as QualitySetting | null;
    // (A saved time of day from before 2026-11-22 is left out: the city is always at sunset.)
    const { timeOfDay: _gone, ...rest } = saved as Partial<Settings> & { timeOfDay?: unknown };
    return { ...DEFAULTS, ...(q ? { quality: q } : {}), ...rest };
  } catch {
    return { ...DEFAULTS };
  }
}

export class AppState {
  snap: Snapshot | null = null;
  readonly rows = new Map<string, Row>();
  settings: Settings = loadSettings();
  selected: string | null = null;
  /** The side panel with the full conversation is open for the selection. */
  expanded = false;
  panel: PanelId | null = null;
  connection: Connection = 'connecting';
  /** Answers picked in a question, kept across repaints: surfaceId:requestId → per-question labels. */
  readonly selections = new Map<string, string[][]>();
  /** Reply drafts per session, kept across repaints and selections. */
  readonly drafts = new Map<string, string>();

  private listeners = new Set<Listener>();
  private eventListeners = new Set<(e: WorldEvent) => void>();
  private seen = new Map<string, { lane: Lane; ask: Ask | null }>();
  private primed = false;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEvent(fn: (e: WorldEvent) => void) {
    this.eventListeners.add(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  setSnapshot(snap: Snapshot) {
    this.snap = snap;
    this.derive();
    this.emit();
  }

  /** Recomputes lanes (after a snapshot, or when "Stale after" changes) and notices transitions. */
  derive() {
    const snap = this.snap;
    if (!snap) return;
    const now = Date.now();
    this.rows.clear();
    const events: WorldEvent[] = [];
    for (const item of snap.items) {
      const lane = laneOf(item, now, this.settings.staleAfterMs);
      const row: Row = { item, lane, ask: askOf(item, lane) };
      this.rows.set(item.surfaceId, row);
      const before = this.seen.get(item.surfaceId);
      if (this.primed && item.agent) {
        if (lane === 'needs' && row.ask !== 'result' && (before?.lane !== 'needs' || before.ask !== row.ask)) events.push({ type: 'needs', row });
        else if (row.ask === 'result' && before?.lane === 'working') events.push({ type: 'finished', row });
      }
      this.seen.set(item.surfaceId, { lane, ask: row.ask });
    }
    for (const id of [...this.seen.keys()]) if (!this.rows.has(id)) this.seen.delete(id);
    if (this.selected && !this.rows.has(this.selected)) {
      this.selected = null;
      this.expanded = false;
    }
    this.primed = true;
    for (const e of events) for (const fn of this.eventListeners) fn(e);
  }

  row(id: string | null | undefined): Row | null {
    return id ? (this.rows.get(id) ?? null) : null;
  }

  get selectedRow(): Row | null {
    return this.row(this.selected);
  }

  /** Sessions in a lane, in that lane's order. Archived sessions are left out (they live in the Archive). */
  lane(lane: Lane): Row[] {
    return [...this.rows.values()]
      .filter((r) => r.lane === lane && !r.item.archived)
      .sort((a, b) => SORTS[lane](a.item, b.item));
  }

  get counts() {
    const c = { needs: 0, working: 0, move: 0, stale: 0, shells: 0, agents: 0 };
    for (const r of this.rows.values()) {
      if (r.item.archived) continue;
      c[r.lane] += 1;
      if (r.lane !== 'shells') c.agents += 1;
    }
    return c;
  }

  get projects() {
    return Object.entries(this.snap?.world?.plots ?? {}).map(([key, p]) => ({ key, ...p }));
  }

  get archived(): Row[] {
    const ids = new Set((this.snap?.world?.archived ?? []).map((a) => a.sessionId));
    return [...this.rows.values()].filter((r) => r.item.agent && ids.has(r.item.agent.sessionId));
  }

  setSettings(patch: Partial<Settings>) {
    const staleChanged = patch.staleAfterMs !== undefined && patch.staleAfterMs !== this.settings.staleAfterMs;
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode: settings just don't persist */
    }
    if (staleChanged) {
      // Moving the threshold isn't news: don't toast everyone who changed lane.
      this.primed = false;
      this.derive();
    }
    this.emit();
  }

  select(id: string | null, expanded = this.expanded) {
    this.selected = id;
    this.expanded = id ? expanded : false;
    this.emit();
  }

  openPanel(panel: PanelId | null) {
    this.panel = this.panel === panel ? null : panel;
    this.emit();
  }

  setConnection(c: Connection) {
    if (this.connection === c) return;
    this.connection = c;
    this.emit();
  }
}
