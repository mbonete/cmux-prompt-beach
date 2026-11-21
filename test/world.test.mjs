import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PLOT_COUNT, PLOT_TTL_MS, SPOT_GRACE_MS, createWorld, needsYou } from '../server/world.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const quiet = { warn() {} };

const agent = (id, repo, extra = {}) => ({
  surfaceId: `surface-${id}`,
  agent: { kind: 'claude', sessionId: `session-${id}`, state: 'idle' },
  repo: repo ? { key: `/code/${repo}/.git`, name: repo, kind: 'web' } : null,
  phase: 'idle',
  unread: 0,
  question: null,
  lastPromptAt: null,
  ...extra,
});
const shell = (id, repo) => ({ surfaceId: `surface-${id}`, agent: null, repo: repo ? { key: `/code/${repo}/.git`, name: repo, kind: 'other' } : null, phase: 'shell', unread: 0, question: null });
const snap = (...items) => ({ items });
const byId = (out) => Object.fromEntries(out.items.map((it) => [it.surfaceId.replace('surface-', ''), it]));
const key = (repo) => `/code/${repo}/.git`;

describe('plots', () => {
  test('a new repo takes the lowest free plot, in first-seen order', () => {
    const w = createWorld({ log: quiet });
    let out = w.apply(snap(agent(1, 'a'), agent(2, 'b'), agent(3, 'a')), T0);
    let it = byId(out);
    assert.equal(it[1].plot, 0);
    assert.equal(it[2].plot, 1);
    assert.equal(it[3].plot, 0);
    assert.equal(out.world.plots[key('a')].agents, 2);
    assert.equal(out.world.plots[key('a')].kind, 'web');
    out = w.apply(snap(agent(1, 'a'), agent(2, 'b'), agent(4, 'c')), T0 + MIN);
    it = byId(out);
    assert.equal(it[4].plot, 2);
    assert.deepEqual(out.world.free, Array.from({ length: PLOT_COUNT - 3 }, (_, i) => i + 3));
    assert.equal(out.world.plotCount, PLOT_COUNT);
    assert.deepEqual(Object.keys(out.world.plots), [key('a'), key('b'), key('c')]);
    assert.equal(out.world.plots[key('a')].agents, 1, 'agent 3 has gone');
  });

  test('a repo without sessions keeps its plot for 7 days, then frees it', () => {
    const w = createWorld({ log: quiet });
    w.apply(snap(agent(1, 'a'), agent(2, 'b')), T0);
    let out = w.apply(snap(agent(2, 'b')), T0 + 6 * DAY);
    const a = out.world.plots[key('a')];
    assert.equal(a.plot, 0, 'still owns its plot');
    assert.equal(a.active, false);
    assert.equal(a.agents, 0);
    assert.equal(a.lastSeen, new Date(T0).toISOString());
    assert.equal(out.world.plots[key('b')].lastSeen, null, 'live repos report lastSeen as null');
    out = w.apply(snap(agent(2, 'b'), agent(3, 'c')), T0 + PLOT_TTL_MS + 1);
    assert.equal(out.world.plots[key('a')], undefined, 'freed');
    assert.equal(byId(out)[3].plot, 0, 'the next new repo takes the freed plot');
  });

  test('sessions outside any repo go to the hangout; shells never claim a plot', () => {
    const w = createWorld({ log: quiet });
    const out = w.apply(snap(agent(1, null), shell(2, 'z'), shell(3, null), agent(4, 'a'), shell(5, 'a')), T0);
    const it = byId(out);
    assert.equal(it[1].plot, 'hangout');
    assert.equal(it[1].spot, 0);
    assert.equal(it[2].plot, null, 'a shell-only repo gets no plot');
    assert.equal(it[3].plot, null);
    assert.equal(it[4].plot, 0);
    assert.equal(it[5].plot, 0, "a shell shows its repo's plot");
    assert.equal(it[5].spot, null);
    assert.deepEqual(Object.keys(out.world.plots), [key('a')]);
  });

  test(`repos beyond ${PLOT_COUNT} share the overflow plot, and move up when a plot frees`, () => {
    const w = createWorld({ log: quiet });
    const N = PLOT_COUNT;
    const items = Array.from({ length: N + 2 }, (_, i) => agent(i, `r${i}`));
    let out = w.apply(snap(...items), T0);
    let it = byId(out);
    assert.equal(it[N - 1].plot, N - 1);
    assert.equal(it[N].plot, 'overflow');
    assert.equal(it[N + 1].plot, 'overflow');
    assert.equal(it[N].spot, 0, 'overflow has its own spots');
    assert.equal(it[N + 1].spot, 1);
    assert.deepEqual(out.world.free, []);
    // r0 goes quiet for a week: the earliest overflow repo takes plot 0.
    out = w.apply(snap(...items.slice(1)), T0 + PLOT_TTL_MS + 1);
    it = byId(out);
    assert.equal(it[N].plot, 0);
    assert.equal(it[N + 1].plot, 'overflow');
  });

  test(`movePlot: only an existing repo, only to a free plot from 0 to ${PLOT_COUNT - 1}`, () => {
    const w = createWorld({ log: quiet });
    w.apply(snap(agent(1, 'a'), agent(2, 'b'), agent(3, 'a')), T0);
    assert.throws(() => w.movePlot(key('nope'), 5), { status: 404 });
    assert.throws(() => w.movePlot(key('a'), 1), { status: 409 }, 'taken');
    for (const bad of [-1, PLOT_COUNT, 2.5, '5', null, undefined, 'overflow', 'hangout']) assert.throws(() => w.movePlot(key('a'), bad), { status: 400 }, String(bad));
    for (const bad of ['', 42, null, 'x'.repeat(5000)]) assert.throws(() => w.movePlot(bad, 5), { status: 400 });
    assert.throws(() => w.movePlot('__proto__', 5), { status: 404 });
    w.movePlot(key('a'), 0); // a no-op move is fine
    w.movePlot(key('a'), 7);
    const out = w.apply(snap(agent(1, 'a'), agent(2, 'b'), agent(3, 'a')), T0 + MIN);
    const it = byId(out);
    assert.equal(it[1].plot, 7);
    assert.equal(it[1].spot, 0, 'agents keep their spots when their repo moves');
    assert.equal(it[3].spot, 1);
    assert.ok(out.world.free.includes(0), 'the old plot is free');
    assert.ok(!out.world.free.includes(7));
  });
});

describe('spots', () => {
  test('six spots per plot; the 7th agent and beyond get null', () => {
    const w = createWorld({ log: quiet });
    const items = Array.from({ length: 8 }, (_, i) => agent(i, 'a'));
    const it = byId(w.apply(snap(...items), T0));
    assert.deepEqual(items.map((x, i) => it[i].spot), [0, 1, 2, 3, 4, 5, null, null]);
  });

  test('spots are stable while an agent lives; freed spots go to the longest-waiting agent', () => {
    const w = createWorld({ log: quiet });
    const items = Array.from({ length: 8 }, (_, i) => agent(i, 'a'));
    w.apply(snap(...items), T0);
    // Agent 2 closes. Within the grace period its spot stays reserved.
    const without2 = items.filter((_, i) => i !== 2);
    let it = byId(w.apply(snap(...without2), T0 + MIN));
    assert.equal(it[6].spot, null);
    assert.equal(it[3].spot, 3);
    // After the grace period, the first agent without a spot (6, seen before 7) takes spot 2.
    it = byId(w.apply(snap(...without2), T0 + MIN + SPOT_GRACE_MS + 1));
    assert.equal(it[6].spot, 2);
    assert.equal(it[7].spot, null);
    assert.equal(it[3].spot, 3, 'nobody else moved');
    // Agent 1 closes just as agent 9 opens: 1's spot is still reserved, so 9 waits (behind 7).
    const without1and2 = without2.filter((x) => x.surfaceId !== 'surface-1');
    it = byId(w.apply(snap(...without1and2, agent(9, 'a')), T0 + 2 * MIN + SPOT_GRACE_MS + 2));
    assert.equal(it[9].spot, null);
    assert.equal(it[7].spot, null);
  });

  test('order of items in the snapshot does not move anyone', () => {
    const w = createWorld({ log: quiet });
    const items = Array.from({ length: 4 }, (_, i) => agent(i, 'a'));
    w.apply(snap(...items), T0);
    const it = byId(w.apply(snap(...[...items].reverse()), T0 + 1000));
    assert.deepEqual([0, 1, 2, 3].map((i) => it[i].spot), [0, 1, 2, 3]);
  });

  test('an agent that moves to another repo gets a spot there', () => {
    const w = createWorld({ log: quiet });
    w.apply(snap(agent(1, 'a'), agent(2, 'a'), agent(3, 'b')), T0);
    const it = byId(w.apply(snap(agent(1, 'a'), agent(2, 'b'), agent(3, 'b')), T0 + 1000));
    assert.equal(it[2].plot, 1);
    assert.equal(it[2].spot, 1);
    assert.equal(it[3].spot, 0);
  });
});

describe('archive', () => {
  test('needsYou: blocked, or idle with an unread result or a trailing question', () => {
    assert.ok(needsYou({ phase: 'blocked', unread: 0 }));
    assert.ok(needsYou({ phase: 'idle', unread: 1 }));
    assert.ok(needsYou({ phase: 'idle', unread: 0, question: 'Ship it?' }));
    assert.ok(!needsYou({ phase: 'idle', unread: 0, question: null }));
    assert.ok(!needsYou({ phase: 'working', unread: 2 }), 'a working agent is working');
    assert.ok(!needsYou({ phase: 'shell', unread: 1 }));
  });

  test('an archived session is hidden unless it needs you, and comes back when it does', () => {
    const w = createWorld({ log: quiet });
    w.apply(snap(agent(1, 'a'), agent(2, 'a')), T0);
    w.archive('session-1', T0 + 1000);
    let it = byId(w.apply(snap(agent(1, 'a'), agent(2, 'a')), T0 + 2000));
    assert.equal(it[1].archived, true);
    assert.equal(it[1].spot, null, 'hidden agents give up their spot');
    assert.equal(it[2].archived, false);

    for (const extra of [{ phase: 'blocked' }, { unread: 1 }, { question: 'Add redirects?' }]) {
      it = byId(w.apply(snap(agent(1, 'a', extra), agent(2, 'a')), T0 + 3000));
      assert.equal(it[1].archived, false, JSON.stringify(extra));
      assert.notEqual(it[1].spot, null, 'back on the plot');
    }
    // Once it no longer needs you, it is archived again.
    it = byId(w.apply(snap(agent(1, 'a', { phase: 'working', unread: 1 }), agent(2, 'a')), T0 + 4000));
    assert.equal(it[1].archived, true);
    assert.deepEqual(
      w.apply(snap(agent(1, 'a')), T0 + 5000).world.archived,
      [{ sessionId: 'session-1', at: new Date(T0 + 1000).toISOString() }],
    );
  });

  test('a new prompt after archiving un-archives the session for good', () => {
    const w = createWorld({ log: quiet });
    w.apply(snap(agent(1, 'a', { lastPromptAt: new Date(T0 - MIN).toISOString() })), T0);
    w.archive('session-1', T0 + 1000);
    let out = w.apply(snap(agent(1, 'a', { lastPromptAt: new Date(T0 - MIN).toISOString() })), T0 + 2000);
    assert.equal(out.items[0].archived, true);
    out = w.apply(snap(agent(1, 'a', { phase: 'working', lastPromptAt: new Date(T0 + 5000).toISOString() })), T0 + 6000);
    assert.equal(out.items[0].archived, false);
    assert.deepEqual(out.world.archived, []);
  });

  test('archive/unarchive validation', () => {
    const w = createWorld({ log: quiet });
    w.apply(snap(agent(1, 'a'), shell(2, 'a')), T0);
    assert.throws(() => w.archive('session-9'), { status: 404 }, 'not running');
    for (const bad of ['', '../x', 'a b', null, 42, 'x'.repeat(200)]) assert.throws(() => w.archive(bad), { status: 400 });
    assert.throws(() => w.unarchive('../x'), { status: 400 });
    w.unarchive('session-1'); // not archived: fine
    w.archive('session-1');
    w.unarchive('session-1');
    assert.equal(w.apply(snap(agent(1, 'a')), T0 + 1000).items[0].archived, false);
  });
});

describe('persistence', () => {
  let tmp;
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sb-world-'));
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  test('writes world.json atomically with private permissions and reloads it', async () => {
    const file = path.join(tmp, 'cfg', 'world.json');
    const w = createWorld({ file, log: quiet });
    await w.load();
    w.apply(snap(agent(1, 'a'), agent(2, 'b'), agent(3, 'b')), T0);
    w.archive('session-1', T0 + 10);
    await w.flush();
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(path.dirname(file))).filter((f) => f !== 'world.json'), [], 'no temp files left');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.repos[key('b')].plot, 1);
    assert.equal(saved.archived['session-1'], T0 + 10);

    // A restart: plots and spots survive; an agent that is gone keeps its spot for the grace period.
    const w2 = createWorld({ file, log: quiet });
    await w2.load();
    let it = byId(w2.apply(snap(agent(1, 'a'), agent(3, 'b'), agent(4, 'b')), T0 + DAY));
    assert.equal(it[3].plot, 1);
    assert.equal(it[3].spot, 1, 'kept its spot across the restart');
    assert.equal(it[4].spot, 2, "a newcomer takes a free spot; agent 2's is still reserved right after the restart");
    assert.equal(it[1].archived, true);
    it = byId(w2.apply(snap(agent(1, 'a'), agent(3, 'b'), agent(4, 'b'), agent(5, 'b')), T0 + DAY + SPOT_GRACE_MS + 1));
    assert.equal(it[5].spot, 0, "after the grace period agent 2's spot is free again");
    await w2.flush();
  });

  test('an unreadable or foreign file means a fresh start, not a crash', async () => {
    const dir = path.join(tmp, 'bad');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'world.json');
    const warnings = [];
    for (const content of ['{not json', JSON.stringify({ version: 99 }), JSON.stringify({ version: 1, repos: { '/x/.git': { plot: 3, name: 'x' }, '/y/.git': { plot: 3, name: 'y' } }, agents: { k: { group: 'g', spot: 99 } }, archived: { '../bad': 1, ok: 'nope' } })]) {
      await writeFile(file, content);
      const w = createWorld({ file, log: { warn: (m) => warnings.push(m) } });
      await w.load();
      const out = w.apply(snap(agent(1, 'z')), T0);
      assert.ok(out.items[0].plot !== null);
      const plots = Object.values(out.world.plots).map((p) => p.plot);
      assert.equal(new Set(plots).size, plots.length, 'no two repos on one plot');
      assert.deepEqual(out.world.archived, []);
      await w.flush();
    }
    assert.equal(warnings.length, 2);
  });

  test('the demo (no file) never writes anything', async () => {
    const w = createWorld({ initial: { version: 1, repos: { '/d/.git': { plot: 12, name: 'd', kind: 'web', firstSeen: T0, lastSeen: T0 } } }, log: quiet });
    await w.load();
    const out = w.apply(snap(agent(1, 'a')), T0 + 1000);
    assert.equal(out.world.plots['/d/.git'].plot, 12);
    assert.equal(out.world.plots['/d/.git'].active, false);
    assert.equal(byId(out)[1].plot, 0);
    await w.flush();
  });
});

test('keys that look like Object.prototype members are plain keys', () => {
  const w = createWorld({ log: quiet });
  const out = w.apply(snap({ ...agent(1, 'a'), agent: { kind: 'claude', sessionId: 'constructor', state: 'idle' } }, { ...agent(2, null), repo: { key: '__proto__', name: 'x' } }), T0);
  assert.equal(out.items[0].archived, false);
  assert.equal(out.items[1].plot, 1);
  w.archive('constructor', T0 + 1);
  assert.equal(w.apply(snap({ ...agent(1, 'a'), agent: { kind: 'claude', sessionId: 'constructor', state: 'idle' } }), T0 + 2).items[0].archived, true);
  assert.equal({}.plot, undefined, 'Object.prototype untouched');
  assert.equal({}.lastSeen, undefined);
});
