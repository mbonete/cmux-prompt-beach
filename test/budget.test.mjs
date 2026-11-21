// Swarm budgets: however many agents and helpers run, what the server reads and
// sends stays bounded (server/budget.mjs), and the demo's swarm mode reproduces
// the load they're there for.

import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createTickGate, mapLimit } from '../server/budget.mjs';
import { CREW_ACTIVE_MS, countActiveHelpers } from '../server/sources/claude-transcripts.mjs';
import { createDemoSource } from '../server/sources/demo.mjs';

const tick = (surfaceId) => ({ surfaceId, hook: 'PreToolUse', tool: { name: 'Bash', category: 'command' } });

describe('tick gate', () => {
  test('one session flooding (a crew of 500) gets about three ticks a second', () => {
    let t = 0;
    const allow = createTickGate({ now: () => t });
    let sent = 0;
    // 500 helpers, a tool call every two seconds each: 250 a second, for ten seconds.
    for (let ms = 0; ms < 10_000; ms += 4) {
      t = ms;
      if (allow(tick('lead'))) sent += 1;
    }
    assert.ok(sent <= 30, `sent ${sent}`);
    assert.ok(sent >= 25, `sent ${sent}`);
  });

  test('many sessions at once stay under the global cap', () => {
    let t = 0;
    const allow = createTickGate({ now: () => t });
    for (let s = 0; s < 10; s++) {
      t = s * 1000;
      let sent = 0;
      for (let i = 0; i < 300; i++) if (allow(tick(`session-${i}`))) sent += 1;
      assert.equal(sent, 20);
    }
  });

  test('a quiet session is never held back', () => {
    let t = 0;
    const allow = createTickGate({ now: () => t });
    for (let i = 0; i < 20; i++) {
      t = i * 2000;
      assert.equal(allow(tick('quiet')), true);
    }
  });
});

describe('mapLimit', () => {
  test('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([...Array(50).keys()], 8, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1 + (n % 3)));
      running -= 1;
      return n * 2;
    });
    assert.deepEqual(out, [...Array(50).keys()].map((n) => n * 2));
    assert.equal(peak, 8);
  });

  test('an empty list', async () => {
    assert.deepEqual(await mapLimit([], 8, async () => 1), []);
  });
});

describe('crew', () => {
  let dir;
  after(() => dir && rm(dir, { recursive: true, force: true }));

  test('counts only helper transcripts written in the last 90 seconds', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'switchboard-crew-'));
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const f = path.join(dir, `agent-${i}.jsonl`);
      await writeFile(f, '{}\n');
      // Two thirds are active; the rest finished ten minutes ago.
      const at = (i % 3 === 0 ? now - 10 * 60_000 : now - 5_000) / 1000;
      await utimes(f, at, at);
    }
    await writeFile(path.join(dir, 'notes.txt'), 'not a transcript');
    assert.equal(await countActiveHelpers(dir, now), 8);
    assert.equal(await countActiveHelpers(dir, now + CREW_ACTIVE_MS), 0);
  });

  test('no helpers folder is a crew of none', async () => {
    assert.equal(await countActiveHelpers(path.join(os.tmpdir(), 'switchboard-no-such-dir')), 0);
  });
});

describe('demo swarm', () => {
  test('one lead with a big crew, every plot busy, and a burst of requests', async () => {
    const source = createDemoSource({ swarm: true });
    const snap = await source.snapshot();
    assert.ok(snap.items.length >= 150, `${snap.items.length} sessions`);
    const lead = snap.items.filter((it) => it.crew > 0);
    assert.equal(lead.length, 1);
    assert.ok(lead[0].crew >= 400);
    assert.equal(new Set(snap.items.map((it) => it.repo?.key).filter(Boolean)).size >= 30, true);
  });
});
