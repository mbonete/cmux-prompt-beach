// World state: which plot each repository owns, which spot each agent sits on,
// and which sessions are archived. Persisted (for the real source) in
// ~/.config/prompt-beach/world.json; the demo keeps it in memory.
//
// See server/SNAPSHOT.md for the fields this adds to a snapshot.

import crypto from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_KINDS } from './repo-kind.mjs';
import { fail } from './util.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const PLOT_COUNT = 32;
export const SPOTS_PER_PLOT = 6;
export const HANGOUT = 'hangout';
export const OVERFLOW = 'overflow';
export const PLOT_TTL_MS = 7 * DAY; // a repo unseen this long frees its plot
export const SPOT_GRACE_MS = 2 * MIN; // an agent missing this long frees its spot
const LAST_SEEN_SAVE_MS = 10 * MIN; // how stale the saved lastSeen of a live repo may get
const ARCHIVE_TTL_MS = 30 * DAY; // archive entries of sessions that have gone away
const MAX_ARCHIVED = 2000;
const MAX_REPOS = 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const DEFAULT_WORLD_FILE = path.join(os.homedir(), '.config', 'prompt-beach', 'world.json');
// Where the world was saved before the project was renamed from Switchboard. Read only
// when the new file doesn't exist yet; the next save writes the new file.
export const LEGACY_WORLD_FILE = path.join(os.homedir(), '.config', 'cmux-switchboard', 'world.json');

// Does this item need the person right now? Blocked on a decision, or idle with an
// unread result or a trailing question. (A working agent with an old unread
// notification is working, as the list shows it.)
export function needsYou(item) {
  return item.phase === 'blocked' || (item.phase === 'idle' && (item.unread > 0 || Boolean(item.question)));
}

const agentKeyOf = (it) => (it.agent?.sessionId ? `s:${it.agent.sessionId}` : `p:${it.surfaceId}`);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// The maps are keyed by paths and ids from cmux and the saved file, so they have no
// prototype: a key like "constructor" or "__proto__" is just a key.
function emptyState() {
  return { version: 1, repos: Object.create(null), agents: Object.create(null), archived: Object.create(null) };
}

// Accepts only what this module writes; anything odd is dropped rather than trusted.
export function sanitizeState(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
  const s = emptyState();
  const usedPlots = new Set();
  const repos = raw.repos && typeof raw.repos === 'object' ? Object.entries(raw.repos).slice(0, MAX_REPOS) : [];
  for (const [key, r] of repos) {
    if (!key || key.length > 4096 || !r || typeof r !== 'object') continue;
    let plot = null;
    if (Number.isInteger(r.plot) && r.plot >= 0 && r.plot < PLOT_COUNT && !usedPlots.has(r.plot)) {
      plot = r.plot;
      usedPlots.add(plot);
    } else if (r.plot === OVERFLOW) {
      plot = OVERFLOW;
    }
    s.repos[key] = {
      plot,
      name: typeof r.name === 'string' ? r.name.slice(0, 200) : path.basename(key),
      kind: REPO_KINDS.includes(r.kind) ? r.kind : 'other',
      firstSeen: num(r.firstSeen, now),
      lastSeen: num(r.lastSeen, now),
    };
  }
  // One repo saved under two keys (its work tree, and its .git dir: see repoKeyOf
  // in sources/cmux.mjs) is merged into the .git one, which keeps its plot.
  const renamed = new Map();
  for (const key of Object.keys(s.repos)) {
    const into = `${key.replace(/\/+$/, '')}/.git`;
    if (path.basename(key) === '.git' || !Object.hasOwn(s.repos, into)) continue;
    const from = s.repos[key];
    const to = s.repos[into];
    if (to.plot === null) to.plot = from.plot;
    to.firstSeen = Math.min(to.firstSeen, from.firstSeen);
    to.lastSeen = Math.max(to.lastSeen, from.lastSeen);
    delete s.repos[key];
    renamed.set(`repo:${key}`, `repo:${into}`);
  }
  const agents = raw.agents && typeof raw.agents === 'object' ? Object.entries(raw.agents).slice(0, 5000) : [];
  for (const [key, a] of agents) {
    if (!key || key.length > 300 || !a || typeof a !== 'object' || typeof a.group !== 'string' || a.group.length > 4200) continue;
    const spot = Number.isInteger(a.spot) && a.spot >= 0 && a.spot < SPOTS_PER_PLOT ? a.spot : null;
    s.agents[key] = { group: renamed.get(a.group) ?? a.group, spot, firstSeen: num(a.firstSeen, now) };
  }
  const archived = raw.archived && typeof raw.archived === 'object' ? Object.entries(raw.archived).slice(0, MAX_ARCHIVED) : [];
  for (const [sessionId, at] of archived) if (SESSION_ID_RE.test(sessionId) && Number.isFinite(at)) s.archived[sessionId] = at;
  return s;
}

// Writes a file atomically: a private temp file in the same folder, fsync, rename.
// The folder is created (and kept) at 0700, the file at 0600.
export async function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function lowestFree(used, count) {
  for (let i = 0; i < count; i += 1) if (!used.has(i)) return i;
  return null;
}

// file: where to persist (null keeps everything in memory, as the demo does).
// initial: a starting state (same shape as the file), used by the demo.
export function createWorld({ file = null, fallbackFile = null, initial = null, log = console } = {}) {
  let state = sanitizeState(initial) || emptyState();
  const missingSince = new Map(); // agent key -> when it went missing (this run only)
  const savedSeen = new Map(); // repo key -> lastSeen as last written
  let presentSessions = new Set();
  let writing = null;
  let writeAgain = false;

  for (const [k, r] of Object.entries(state.repos)) savedSeen.set(k, r.lastSeen);

  async function read(from) {
    const st = await stat(from);
    if (st.size > MAX_FILE_BYTES) throw new Error('file is too large');
    const loaded = sanitizeState(JSON.parse(await readFile(from, 'utf8')));
    if (!loaded) throw new Error('unknown format');
    return loaded;
  }

  async function load() {
    if (!file) return;
    let from = file;
    try {
      try {
        state = await read(file);
      } catch (err) {
        if (err.code !== 'ENOENT' || !fallbackFile) throw err;
        from = fallbackFile;
        state = await read(fallbackFile);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn?.(`Prompt Beach: starting with a fresh world; could not read ${from} (${err.message}).`);
    }
    savedSeen.clear();
    for (const [k, r] of Object.entries(state.repos)) savedSeen.set(k, r.lastSeen);
  }

  function serialize() {
    const { repos, agents, archived } = state;
    return `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), repos, agents, archived }, null, 1)}\n`;
  }

  // Saves in the background; overlapping calls collapse into one more write.
  function save() {
    for (const [k, r] of Object.entries(state.repos)) savedSeen.set(k, r.lastSeen);
    if (!file) return Promise.resolve();
    if (writing) {
      writeAgain = true;
      return writing;
    }
    writing = (async () => {
      do {
        writeAgain = false;
        await writeFileAtomic(file, serialize());
      } while (writeAgain);
    })()
      .catch((err) => log.warn?.(`Prompt Beach: could not save ${file} (${err.message}).`))
      .finally(() => {
        writing = null;
      });
    return writing;
  }

  // snapshot.world: plots by repo key, the free plot numbers and the archive.
  function summarize(liveRepos = new Set(), visibleByRepo = new Map()) {
    const plots = {};
    for (const [key, r] of Object.entries(state.repos)) {
      const active = liveRepos.has(key);
      plots[key] = { plot: r.plot, name: r.name, kind: r.kind, firstSeen: iso(r.firstSeen), lastSeen: active ? null : iso(r.lastSeen), active, agents: visibleByRepo.get(key) || 0 };
    }
    const used = new Set(Object.values(state.repos).map((r) => r.plot).filter(Number.isInteger));
    return {
      plotCount: PLOT_COUNT,
      spotsPerPlot: SPOTS_PER_PLOT,
      plots,
      free: Array.from({ length: PLOT_COUNT }, (_, i) => i).filter((i) => !used.has(i)),
      archived: Object.entries(state.archived).map(([sessionId, at]) => ({ sessionId, at: iso(at) })),
    };
  }

  // Adds plot, spot and archived to each item and a `world` summary to the snapshot.
  // Returns a new snapshot; the source's items are not modified.
  function apply(snapshot, now = Date.now()) {
    let dirty = false;
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

    // 1. Repos with an agent right now are seen; new ones join (plot assigned below).
    const liveRepos = new Set();
    for (const it of items) {
      if (!it.agent || !it.repo?.key) continue;
      const key = String(it.repo.key);
      liveRepos.add(key);
      let r = state.repos[key];
      if (!r) {
        r = state.repos[key] = { plot: null, name: it.repo.name || path.basename(key), kind: 'other', firstSeen: now, lastSeen: now };
        dirty = true;
      }
      r.lastSeen = now;
      if (it.repo.name && r.name !== it.repo.name) {
        r.name = String(it.repo.name).slice(0, 200);
        dirty = true;
      }
      if (REPO_KINDS.includes(it.repo.kind) && r.kind !== it.repo.kind) {
        r.kind = it.repo.kind;
        dirty = true;
      }
    }

    // 2. A repo unseen for 7 days frees its plot.
    for (const [key, r] of Object.entries(state.repos)) {
      if (!liveRepos.has(key) && now - r.lastSeen > PLOT_TTL_MS) {
        delete state.repos[key];
        savedSeen.delete(key);
        dirty = true;
      }
    }

    // 3. Repos without a plot (new, or waiting in overflow) take the lowest free one, first seen first.
    const used = new Set(Object.values(state.repos).map((r) => r.plot).filter(Number.isInteger));
    const waiting = Object.values(state.repos)
      .filter((r) => !Number.isInteger(r.plot))
      .sort((a, b) => a.firstSeen - b.firstSeen);
    for (const r of waiting) {
      const free = lowestFree(used, PLOT_COUNT);
      if (free !== null) {
        r.plot = free;
        used.add(free);
        dirty = true;
      } else if (r.plot !== OVERFLOW) {
        r.plot = OVERFLOW;
        dirty = true;
      }
    }

    // 4. Archive bookkeeping: a new prompt after archiving brings a session back for good;
    //    entries for sessions that have been gone a long time are dropped.
    const bySession = new Map();
    for (const it of items) if (it.agent?.sessionId) bySession.set(String(it.agent.sessionId), it);
    presentSessions = new Set(bySession.keys());
    for (const [sid, at] of Object.entries(state.archived)) {
      const it = bySession.get(sid);
      const promptAt = Date.parse(it?.lastPromptAt || '');
      if ((it && Number.isFinite(promptAt) && promptAt > at) || (!it && now - at > ARCHIVE_TTL_MS)) {
        delete state.archived[sid];
        dirty = true;
      }
    }

    // 5. Plot and archived per item. Shells never claim a plot; they show their repo's if it has one.
    //    A repo waiting for a plot (all taken) seats its agents at the beach bar.
    const out = items.map((it) => {
      const repo = it.repo?.key ? state.repos[String(it.repo.key)] : null;
      const repoPlot = repo?.plot === OVERFLOW ? null : (repo?.plot ?? null);
      let plot = null;
      if (it.agent) plot = it.repo?.key ? (repo?.plot === OVERFLOW ? HANGOUT : repoPlot) : HANGOUT;
      else if (repo) plot = repoPlot;
      const sid = it.agent?.sessionId ? String(it.agent.sessionId) : null;
      const archived = Boolean(sid && state.archived[sid] != null && !needsYou(it));
      return { ...it, plot, spot: null, archived };
    });

    // 6. Spots, per plot. A numbered plot's spots belong to its repo (they move with it);
    //    the hangout is shared (sessions outside a repo, and repos waiting for a plot). Visible agents keep their spot; archived ones give
    //    it up at once; ones that disappear keep it for a short grace period.
    const groupOf = (it) => (Number.isInteger(it.plot) ? `repo:${it.repo.key}` : it.plot);
    const visible = out.filter((it) => it.agent && !it.archived && it.plot !== null);
    const hidden = new Set(out.filter((it) => it.agent && it.archived).map(agentKeyOf));
    const seen = new Set();
    for (const it of visible) {
      const key = agentKeyOf(it);
      seen.add(key);
      missingSince.delete(key);
      const group = groupOf(it);
      const a = state.agents[key];
      if (!a) {
        state.agents[key] = { group, spot: null, firstSeen: now };
        dirty = true;
      } else if (a.group !== group) {
        a.group = group;
        a.spot = null;
        dirty = true;
      }
    }
    for (const [key, a] of Object.entries(state.agents)) {
      if (seen.has(key)) continue;
      if (hidden.has(key)) {
        missingSince.delete(key);
        if (a.spot !== null) {
          a.spot = null;
          dirty = true;
        }
        continue;
      }
      if (!missingSince.has(key)) missingSince.set(key, now);
      if (now - missingSince.get(key) > SPOT_GRACE_MS) {
        delete state.agents[key];
        missingSince.delete(key);
        dirty = true;
      }
    }
    const taken = new Map(); // group -> Set of spots
    const takenIn = (group) => taken.get(group) || taken.set(group, new Set()).get(group);
    for (const a of Object.values(state.agents)) {
      if (a.spot === null) continue;
      const set = takenIn(a.group);
      if (set.has(a.spot)) {
        a.spot = null; // two agents on one spot: only possible with a hand-edited file
        dirty = true;
      } else {
        set.add(a.spot);
      }
    }
    const needSpot = [...new Set(visible.map(agentKeyOf))]
      .filter((key) => state.agents[key].spot === null)
      .sort((x, y) => state.agents[x].firstSeen - state.agents[y].firstSeen);
    for (const key of needSpot) {
      const a = state.agents[key];
      const spot = lowestFree(takenIn(a.group), SPOTS_PER_PLOT);
      if (spot !== null) {
        a.spot = spot;
        takenIn(a.group).add(spot);
        dirty = true;
      }
    }
    for (const it of visible) it.spot = state.agents[agentKeyOf(it)].spot;

    // 7. The summary the client draws plots and the Projects and Archive views from.
    const visibleByRepo = new Map();
    for (const it of visible) if (it.repo?.key) visibleByRepo.set(String(it.repo.key), (visibleByRepo.get(String(it.repo.key)) || 0) + 1);
    const world = summarize(liveRepos, visibleByRepo);

    // Persist structural changes at once; a live repo's lastSeen only every 10 minutes.
    if (!dirty) {
      for (const key of liveRepos) {
        if (now - (savedSeen.get(key) ?? 0) > LAST_SEEN_SAVE_MS) {
          dirty = true;
          break;
        }
      }
    }
    if (dirty) save();

    return { ...snapshot, items: out, world };
  }

  function validSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw fail(400, 'Invalid session');
    return sessionId;
  }

  function archive(sessionId, now = Date.now()) {
    validSession(sessionId);
    if (!presentSessions.has(sessionId)) throw fail(404, 'That session is not running any more.');
    state.archived[sessionId] = now;
    const entries = Object.entries(state.archived);
    if (entries.length > MAX_ARCHIVED) {
      entries.sort((a, b) => a[1] - b[1]);
      for (const [sid] of entries.slice(0, entries.length - MAX_ARCHIVED)) delete state.archived[sid];
    }
    save();
  }

  function unarchive(sessionId) {
    validSession(sessionId);
    if (state.archived[sessionId] == null) return;
    delete state.archived[sessionId];
    save();
  }

  function movePlot(repoKey, plot) {
    if (typeof repoKey !== 'string' || !repoKey || repoKey.length > 4096) throw fail(400, 'Invalid project');
    const r = Object.hasOwn(state.repos, repoKey) ? state.repos[repoKey] : null;
    if (!r) throw fail(404, 'That project has no plot.');
    if (!Number.isInteger(plot) || plot < 0 || plot >= PLOT_COUNT) throw fail(400, `Pick a plot from 0 to ${PLOT_COUNT - 1}.`);
    if (r.plot === plot) return;
    if (Object.entries(state.repos).some(([k, o]) => k !== repoKey && o.plot === plot)) throw fail(409, 'That plot is taken. Pick a free one.');
    r.plot = plot;
    save();
  }

  return {
    load,
    apply,
    archive,
    unarchive,
    movePlot,
    // The world summary as it stands, without recording anything (for error snapshots).
    summary: () => summarize(),
    // Resolves once any pending write has finished (for tests and shutdown).
    flush: () => writing || Promise.resolve(),
    get state() {
      return state;
    },
  };
}
