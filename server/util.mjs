// Small helpers shared by the server and its sources.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An error whose message is safe to show to the person using the page.
export function fail(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

export function requireUuid(value, label) {
  if (!UUID_RE.test(String(value || ''))) throw fail(400, `Invalid ${label}`);
  return value;
}

export function clip(text, max) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function parseLooseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function latestIso(...values) {
  let best = null;
  for (const v of values) if (v && (!best || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

// Resolves with the promise's value, or with `fallback` once `ms` have passed.
export function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]);
}
