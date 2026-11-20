// Demo mode: made-up projects and agents in every state, slowly living their lives,
// so the dashboard can be shown or screenshotted without exposing real sessions.
// Start with `npm run demo`. Nothing here talks to cmux.

import crypto from 'node:crypto';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BINS = 36;
const DECISION_TTL = 120 * SEC;

const uuid = () => crypto.randomUUID();
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function history(level) {
  return Array.from({ length: BINS }, (_, i) => {
    if (!level) return 0;
    const recent = i > BINS - 8 ? 1.6 : 0.4;
    return Math.random() < 0.55 * recent ? Math.ceil(Math.random() * level * recent) : 0;
  });
}

const WORK_STEPS = [
  { name: 'Read', detail: 'src/routes/index.ts' },
  { name: 'Grep', detail: '"useCart" in src/' },
  { name: 'Edit', detail: 'src/components/Summary.tsx' },
  { name: 'Bash', detail: 'npm test -- --watch=false' },
  { name: 'Bash', detail: 'npx tsc --noEmit' },
  { name: 'Edit', detail: 'README.md' },
  { name: 'Write', detail: 'tests/summary.spec.ts' },
  { name: 'Task', detail: 'Explore: find every caller of formatPrice' },
];

const NEW_PROMPTS = [
  'add a loading state to the summary card',
  'write tests for the edge cases you found',
  'check the build still passes and open a PR',
  'tidy the copy on the empty state',
  'look at the failing CI job and fix it',
];

const FINISHED = [
  'Done. The change is in and the tests pass. I left a note in the PR description about the one flaky snapshot.',
  'Finished: updated the component, added two tests and checked the build. Nothing else changed.',
  'All set. I refactored the helper, kept the public API the same and the suite is green.',
];

function seed(now) {
  const s = (o) => ({
    surfaceId: uuid(),
    workspaceId: uuid(),
    sessionId: uuid(),
    subtitle: null,
    branch: null,
    ports: [],
    model: 'Opus 5.5',
    mode: null,
    contextTokens: 40000 + Math.floor(Math.random() * 90000),
    phase: 'idle',
    blocked: null,
    now: null,
    lastPrompt: null,
    lastPromptAt: null,
    reply: null,
    recap: null,
    question: null,
    unread: 0,
    doneAt: null,
    here: false,
    activity: history(o.phase === 'working' ? 5 : o.phase === 'shell' ? 0 : 2),
    ...o,
  });

  const list = [
    s({
      project: 'api-gateway',
      title: 'Rate limiter for public API',
      branch: 'feat/rate-limit',
      phase: 'blocked',
      lastPrompt: 'add a token-bucket rate limiter to the public routes and load test it',
      lastPromptAt: now - 9 * MIN,
      lastActivityAt: now - 40 * SEC,
      decision: {
        kind: 'permission',
        tool: { name: 'Bash', command: 'npm run test:load -- --rps 500 --duration 60s', detail: 'Load test the gateway at 500 requests per second' },
      },
    }),
    s({
      project: 'api-gateway',
      title: 'OpenAPI spec cleanup',
      branch: 'chore/openapi',
      model: 'Sonnet 5.5',
      phase: 'working',
      now: { name: 'Edit', detail: 'openapi/gateway.yaml' },
      lastPrompt: 'remove the deprecated v1 endpoints from the OpenAPI spec',
      lastPromptAt: now - 4 * MIN,
      lastActivityAt: now - 3 * SEC,
      doneAt: now + 70 * SEC,
    }),
    s({
      project: 'web-shop',
      title: 'Checkout page redesign',
      branch: 'redesign/checkout',
      ports: [5173],
      here: true,
      phase: 'working',
      mode: 'acceptEdits',
      now: { name: 'Edit', detail: 'src/checkout/SummaryCard.tsx' },
      lastPrompt: 'rebuild the checkout summary card from the new Figma frame',
      lastPromptAt: now - 12 * MIN,
      lastActivityAt: now - 2 * SEC,
      doneAt: now + 140 * SEC,
    }),
    s({
      project: 'web-shop-e2e',
      repoName: 'web-shop',
      title: 'Flaky login e2e test',
      branch: 'fix/flaky-login',
      phase: 'working',
      now: { name: 'Bash', detail: 'npx playwright test login --repeat-each 20' },
      lastPrompt: 'find out why the login e2e test fails on CI about one run in five',
      lastPromptAt: now - 3 * MIN,
      lastActivityAt: now - 5 * SEC,
      doneAt: now + 45 * SEC,
    }),
    s({
      project: 'web-shop',
      title: 'Product image zoom',
      branch: 'feat/image-zoom',
      lastPrompt: 'let people zoom product photos with pinch and scroll',
      lastPromptAt: now - 52 * MIN,
      lastActivityAt: now - 38 * MIN,
      recap: 'Added pinch and wheel zoom to the product gallery, with a reset button. Tests pass; not committed yet.',
      reply: 'Added pinch and wheel zoom to the product gallery, with a reset button.\n\n- `Gallery.tsx`: zoom state and gestures\n- `gallery.spec.ts`: 6 new tests\n\nNot committed yet.',
    }),
    s({
      project: 'web-shop',
      title: 'Cart badge count',
      branch: 'fix/cart-badge',
      lastPrompt: 'the cart badge shows 0 after a refresh',
      lastPromptAt: now - 5 * DAY - 2 * HOUR,
      lastActivityAt: now - 5 * DAY - HOUR,
      recap: 'Traced the bug to the cart store hydrating after the header renders. Proposed two fixes and waited for a pick.',
      reply: 'The badge reads the cart before it has loaded from storage. I can either delay the header or subscribe the badge to the store.',
    }),
    s({
      project: 'growth-emails',
      title: 'Onboarding email sequence',
      model: 'Sonnet 5.5',
      lastPrompt: 'draft a five email onboarding sequence for new trial users',
      lastPromptAt: now - 26 * MIN,
      lastActivityAt: now - 7 * MIN,
      unread: 1,
      recap: 'Drafted the five onboarding emails in emails/onboarding/ with subject lines, preview text and send delays.',
      reply: 'Drafted the five onboarding emails in `emails/onboarding/`.\n\n| Day | Subject |\n| --- | --- |\n| 0 | Welcome, here is your first step |\n| 1 | Three things to try today |\n| 3 | How teams use it |\n| 7 | Your trial, halfway |\n| 13 | Last day of your trial |',
    }),
    s({
      project: 'docs',
      title: 'Docs site search',
      branch: 'feat/search',
      ports: [4321],
      lastPrompt: 'add search to the docs site',
      lastPromptAt: now - 70 * MIN,
      lastActivityAt: now - 12 * MIN,
      recap: 'Search is in: a local index built at deploy time and a ⌘K dialog. PR #42 is open.',
      reply: 'Search is in: a local index built at deploy time and a ⌘K dialog. PR #42 is open.',
    }),
    s({
      project: 'docs',
      title: 'Migrate v2 guides',
      branch: 'docs/v3-guides',
      lastPrompt: 'move the v2 guides to the v3 structure',
      lastPromptAt: now - 40 * MIN,
      lastActivityAt: now - 15 * MIN,
      reply: 'Moved all 24 guides to the v3 structure and fixed the internal links.\n\nShould I also add redirects from the old /v2 URLs?',
      question: 'Should I also add redirects from the old /v2 URLs?',
    }),
    s({
      project: 'mobile-app',
      title: 'Push notification opt-in',
      branch: 'feat/push-optin',
      phase: 'blocked',
      lastPrompt: 'add a push notification opt-in screen',
      lastPromptAt: now - 6 * MIN,
      lastActivityAt: now - 25 * SEC,
      decision: {
        kind: 'question',
        questions: [
          {
            header: 'Timing',
            question: 'When should the app ask for notification permission?',
            multiSelect: false,
            options: [
              { label: 'After the first order', description: 'People have a reason to want updates by then' },
              { label: 'On first launch', description: 'Simplest, but most people decline' },
              { label: 'Only from settings', description: 'Never prompt on its own' },
            ],
          },
        ],
      },
    }),
    s({
      project: 'mobile-app',
      title: 'Dark mode tokens',
      branch: 'feat/dark-tokens',
      model: 'Sonnet 5.5',
      phase: 'working',
      now: { name: 'Read', detail: 'src/theme/tokens.ts' },
      lastPrompt: 'add dark mode values to every colour token',
      lastPromptAt: now - 2 * MIN,
      lastActivityAt: now - 4 * SEC,
      doneAt: now + 95 * SEC,
    }),
    s({
      project: 'infra',
      title: 'Staging database upgrade',
      branch: 'infra/pg17',
      mode: 'plan',
      phase: 'blocked',
      lastPrompt: 'plan the staging Postgres upgrade to 17',
      lastPromptAt: now - 11 * MIN,
      lastActivityAt: now - 50 * SEC,
      decision: {
        kind: 'plan',
        plan: '## Upgrade staging Postgres 15 → 17\n\n1. Snapshot the staging volume\n2. Run `pg_upgrade --check` on a clone\n3. Upgrade in place during the 02:00 window\n4. Re-run the smoke tests and `ANALYZE`\n\nRollback: restore the snapshot (about 6 minutes).',
      },
    }),
    s({
      project: 'infra',
      title: 'Rotate CI secrets',
      lastPrompt: 'rotate the deploy keys used by CI',
      lastPromptAt: now - 9 * DAY,
      lastActivityAt: now - 9 * DAY + 20 * MIN,
      recap: 'Rotated three of four keys; the registry token needs an admin login.',
    }),
    s({ project: 'infra', title: 'zsh', phase: 'shell', lastActivityAt: null }),
    s({
      project: 'code',
      noRepo: true,
      title: 'Regex for log timestamps',
      model: 'Haiku 5.5',
      lastPrompt: 'write a regex that matches ISO timestamps with optional milliseconds',
      lastPromptAt: now - 34 * MIN,
      lastActivityAt: now - 33 * MIN,
      recap: 'Gave a regex with tests for the six formats in your sample, plus one edge case it rejects on purpose.',
    }),
    s({
      project: 'code',
      noRepo: true,
      title: 'Compare two CSV exports',
      phase: 'working',
      now: { name: 'Bash', detail: 'diff <(sort a.csv) <(sort b.csv) | head' },
      lastPrompt: 'tell me which rows changed between these two exports',
      lastPromptAt: now - 90 * SEC,
      lastActivityAt: now - 6 * SEC,
      doneAt: now + 55 * SEC,
    }),
    s({
      project: 'design-system',
      title: 'Button focus rings',
      branch: 'a11y/focus',
      lastPrompt: 'make focus rings visible on every button variant',
      lastPromptAt: now - 3 * HOUR,
      lastActivityAt: now - 2 * HOUR - 40 * MIN,
      recap: 'Every button variant now has a 2px focus ring that passes contrast on all surfaces.',
    }),
    s({
      project: 'product',
      title: 'Release notes for v2.3',
      model: 'Haiku 5.5',
      lastPrompt: 'summarise the merged PRs since v2.2',
      lastPromptAt: now - 2 * HOUR,
      lastActivityAt: now - 2 * HOUR + 3 * MIN,
      recap: 'Wrote release notes for v2.3 from 31 merged PRs, grouped into features, fixes and internal.',
    }),
    s({
      project: 'data-pipeline',
      title: 'Nightly ETL backfill',
      lastPrompt: 'backfill the events table for March',
      lastPromptAt: now - 3 * DAY - 4 * HOUR,
      lastActivityAt: now - 3 * DAY - 3 * HOUR,
      recap: 'Backfilled March; two days had gaps in the source and are listed in backfill.log.',
    }),
    s({ project: 'data-pipeline', title: 'logs', phase: 'shell', lastActivityAt: null }),
  ];

  list.forEach((x, i) => {
    x.order = i;
    x.cwd = x.noRepo ? '~/code' : `~/code/${x.project}`;
    const repo = x.repoName || x.project;
    x.repo = x.noRepo || x.phase === 'shell' && !repo ? null : { key: `~/code/${repo}/.git`, name: repo };
    if (x.phase === 'blocked') openDecision(x, now - (x.decision.kind === 'permission' ? 40 : 15) * SEC);
  });
  return list;
}

function openDecision(x, since) {
  x.phase = 'blocked';
  x.blocked = { ...x.decision, requestId: uuid(), since: new Date(since).toISOString(), deadline: new Date(since + DECISION_TTL).toISOString() };
}

export function createDemo() {
  const sessions = seed(Date.now());
  let onChange = () => {};
  let onTick = () => {};

  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

  function startWork(x, prompt, now, ms) {
    x.phase = 'working';
    x.blocked = null;
    x.question = null;
    x.unread = 0;
    if (prompt) {
      x.lastPrompt = prompt;
      x.lastPromptAt = now;
    }
    x.now = pick(WORK_STEPS);
    x.lastActivityAt = now;
    x.doneAt = now + ms;
  }

  function finish(x, now) {
    x.phase = 'idle';
    x.now = null;
    x.doneAt = null;
    x.lastActivityAt = now;
    x.unread = Math.random() < 0.5 ? 1 : 0;
    const text = pick(FINISHED);
    x.reply = { text, at: iso(now) };
    x.recap = text;
  }

  function step() {
    const now = Date.now();
    let changed = false;
    for (const x of sessions) {
      if (x.phase === 'working') {
        if (Math.random() < 0.4) {
          x.activity[BINS - 1] += 1;
          x.lastActivityAt = now;
          onTick(x.surfaceId);
          if (Math.random() < 0.3) {
            x.now = pick(WORK_STEPS);
            changed = true;
          }
        }
        if (x.doneAt && now >= x.doneAt) {
          finish(x, now);
          changed = true;
        }
      } else if (x.phase === 'blocked' && x.blocked?.deadline && Date.parse(x.blocked.deadline) < now) {
        // Keep the demo's decisions answerable: re-open them as cmux would on a new prompt.
        openDecision(x, now);
        changed = true;
      }
    }
    // Results get read in the terminal after a while, as they would in real use.
    for (const x of sessions) {
      if (x.phase === 'idle' && x.unread && !x.question && now - x.lastActivityAt > 75 * SEC && Math.random() < 1 / 30) {
        x.unread = 0;
        changed = true;
      }
    }
    // Every so often an idle agent gets a new task.
    if (Math.random() < 1 / 40) {
      const idle = sessions.filter((x) => x.phase === 'idle' && !x.unread && !x.question && now - x.lastActivityAt < DAY);
      if (idle.length) {
        startWork(pick(idle), pick(NEW_PROMPTS), now, (40 + Math.random() * 60) * SEC);
        changed = true;
      }
    }
    if (changed) onChange();
  }

  function snapshot() {
    const pulse = new Array(BINS).fill(0);
    for (const x of sessions) x.activity.forEach((v, i) => (pulse[i] += v));
    const now = Date.now();
    return {
      generatedAt: iso(now),
      demo: true,
      cmux: { ok: true },
      items: sessions.map((x) => ({
        surfaceId: x.surfaceId,
        workspaceId: x.workspaceId,
        workspaceRef: null,
        order: x.order,
        title: x.title,
        subtitle: x.subtitle,
        here: x.here,
        cwd: x.cwd,
        project: x.project,
        repo: x.repo,
        branch: x.branch,
        ports: x.ports,
        agent: x.phase === 'shell' ? null : { kind: 'claude', sessionId: x.sessionId, state: x.phase === 'working' ? 'working' : 'idle' },
        phase: x.phase,
        blocked: x.blocked,
        statusLabel: null,
        model: x.phase === 'shell' ? null : x.model,
        mode: x.mode,
        contextTokens: x.phase === 'shell' ? null : x.contextTokens,
        lastPrompt: x.lastPrompt,
        lastPromptAt: iso(x.lastPromptAt),
        reply: x.reply ? (typeof x.reply === 'string' ? { text: x.reply, at: iso(x.lastActivityAt) } : x.reply) : null,
        recap: x.recap ? { text: x.recap, at: iso(x.lastActivityAt) } : null,
        question: x.phase === 'idle' ? x.question : null,
        now: x.phase === 'working' ? x.now : null,
        turnStartedAt: x.phase === 'working' ? iso(x.lastPromptAt) : null,
        lastActivityAt: iso(x.lastActivityAt),
        unread: x.unread,
        activity: x.phase === 'shell' ? null : x.activity,
      })),
      pulse: { start: iso(now - 3 * HOUR), binMs: (3 * HOUR) / BINS, bins: pulse },
    };
  }

  const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
  const byRequest = (id) => sessions.find((x) => x.blocked?.requestId === id) || null;

  async function act(body) {
    const now = Date.now();
    let note;
    switch (body.action) {
      case 'jump':
        if (!sessions.some((x) => x.surfaceId === body.surfaceId)) throw fail(404, 'That terminal is gone.');
        return { ok: true, note: 'Demo mode: there is no real terminal to open.' };
      case 'reply': {
        const x = sessions.find((s) => s.surfaceId === body.surfaceId);
        const text = String(body.text ?? '').trim();
        if (!x || x.phase === 'shell') throw fail(409, 'There is no agent running in that terminal.');
        if (!text) throw fail(400, 'Write a reply first.');
        if (x.phase !== 'idle') throw fail(409, `The agent is ${x.phase === 'blocked' ? 'waiting on a decision' : 'working'} right now. Open it in cmux instead.`);
        startWork(x, text.slice(0, 600), now, 35 * SEC);
        break;
      }
      case 'permission': {
        const x = byRequest(body.requestId);
        if (!x) throw fail(410, 'That request has already been answered.');
        if (body.mode === 'deny') {
          x.phase = 'idle';
          x.blocked = null;
          x.lastActivityAt = now;
          x.reply = { text: "Okay, I won't run that. Tell me if you'd like a lighter test instead.", at: iso(now) };
          x.recap = x.reply.text;
          x.question = "Tell me if you'd like a lighter test instead.";
        } else {
          startWork(x, null, now, 30 * SEC);
          x.now = { name: x.decision.tool?.name || 'Bash', detail: x.decision.tool?.command || '' };
        }
        break;
      }
      case 'plan': {
        const x = byRequest(body.requestId);
        if (!x) throw fail(410, 'That plan has already been answered.');
        x.mode = body.mode === 'autoAccept' ? 'auto' : body.mode === 'deny' ? 'plan' : null;
        startWork(x, null, now, 40 * SEC);
        break;
      }
      case 'question': {
        const x = byRequest(body.requestId);
        if (!x) throw fail(410, 'That question has already been answered.');
        startWork(x, null, now, 40 * SEC);
        break;
      }
      case 'markRead':
        for (const x of sessions) if (x.workspaceId === body.workspaceId) x.unread = 0;
        break;
      default:
        throw fail(400, 'Unknown action');
    }
    onChange();
    return note ? { ok: true, note } : { ok: true };
  }

  return {
    snapshot,
    act,
    start({ changed, tick }) {
      onChange = changed;
      onTick = tick;
      setInterval(step, SEC);
    },
  };
}
