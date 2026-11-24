import type { Item } from './types';

// The four states the whole UI speaks in, plus terminals without an agent.
export type Lane = 'needs' | 'working' | 'move' | 'stale' | 'shells';
/** How someone who needs you is asking: drives the badge and the card. */
export type Ask = 'permission' | 'question' | 'plan' | 'terminal' | 'result';

export const DEFAULT_STALE_MS = 2 * 24 * 3600 * 1000;

export const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

export function laneOf(item: Item, now: number, staleMs: number): Lane {
  if (item.phase === 'shell') return 'shells';
  if (item.phase === 'blocked') return 'needs';
  if (item.phase === 'working') return 'working';
  if (now - ts(item.lastActivityAt) > staleMs) return 'stale';
  // Finished, even with a reply you haven't read (or one ending in a question): it isn't stuck on
  // you, so it's Your move (unread first, with the check badge). Needs you is for agents that
  // can't go on without you: a permission, a question or plan prompt, a terminal prompt.
  return 'move';
}

export function askOf(item: Item, lane: Lane): Ask | null {
  if (lane === 'needs') {
    const k = item.blocked?.kind;
    return k === 'permission' || k === 'question' || k === 'plan' ? k : 'terminal';
  }
  // A finished reply you haven't read: the check badge, until you read it.
  if (lane === 'move' && item.unread > 0) return 'result';
  return null;
}

export const SORTS: Record<Lane, (a: Item, b: Item) => number> = {
  needs: (a, b) =>
    Number(b.phase === 'blocked') - Number(a.phase === 'blocked') ||
    ts(a.blocked?.since || a.lastActivityAt) - ts(b.blocked?.since || b.lastActivityAt),
  working: (a, b) => a.order - b.order,
  move: (a, b) => Number(b.unread > 0) - Number(a.unread > 0) || ts(b.lastActivityAt) - ts(a.lastActivityAt),
  stale: (a, b) => ts(b.lastActivityAt) - ts(a.lastActivityAt),
  shells: (a, b) => a.order - b.order,
};

export function ago(iso: string | null | undefined, now = Date.now()) {
  const t = ts(iso);
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
