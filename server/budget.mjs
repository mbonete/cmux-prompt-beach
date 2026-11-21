// Budgets: however many agents and helpers are running, what the server reads and
// sends stays bounded. A swarm (one session running hundreds of helpers, or
// hundreds of sessions) must cost the page the same as a busy afternoon.

/**
 * Tool-call ticks are decoration (an icon over someone's head), so under load
 * they're dropped, never queued: at most one per session every `perSessionMs`
 * and `perSecond` in all. A session running 500 helpers reports every one of
 * their tool calls as its own; this keeps that to a few a second.
 */
export function createTickGate({ perSessionMs = 350, perSecond = 20, now = Date.now } = {}) {
  const last = new Map();
  let windowStart = 0;
  let inWindow = 0;
  return function allow(event) {
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      inWindow = 0;
    }
    if (inWindow >= perSecond) return false;
    const key = event?.surfaceId;
    if (key) {
      const prev = last.get(key);
      if (prev !== undefined && t - prev < perSessionMs) return false;
      last.set(key, t);
      if (last.size > 5000) {
        for (const [k, at] of last) if (t - at > 60_000) last.delete(k);
      }
    }
    inWindow += 1;
    return true;
  };
}

/** Like Promise.all over `items.map(fn)`, with at most `limit` calls in flight. Keeps order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
