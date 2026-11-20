// Demo source: made-up projects and agents in every state, slowly living their lives,
// so Switchboard can be shown or screenshotted without exposing real sessions.
// Start with `npm run demo`. Nothing here talks to cmux or reads real files; every
// name, prompt, reply and conversation below is invented.

import crypto from 'node:crypto';
import { tickTool } from '../tools.mjs';
import { fail } from '../util.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BINS = 36;
const DECISION_TTL = 120 * SEC;
// A working agent makes a tool call every 2.5 to 9 seconds, about what Claude Code does.
const TICK_MIN_MS = 2500;
const TICK_SPREAD_MS = 6500;

const uuid = () => crypto.randomUUID();
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function history(level) {
  return Array.from({ length: BINS }, (_, i) => {
    if (!level) return 0;
    const recent = i > BINS - 8 ? 1.6 : 0.4;
    return Math.random() < 0.55 * recent ? Math.ceil(Math.random() * level * recent) : 0;
  });
}

// ---------------------------------------------------------------------------
// Projects

const REPOS = {
  storefront: { kind: 'web', steps: [
    ['Read', 'src/app/checkout/page.tsx'], ['Grep', '"useCart" in src/'], ['Edit', 'src/components/checkout/SummaryCard.tsx'],
    ['Bash', 'npm test -- --run src/checkout'], ['Bash', 'npx tsc --noEmit'], ['Glob', 'src/**/*.test.tsx'], ['Write', 'tests/e2e/checkout.spec.ts'],
    ['Read', 'src/lib/cart/store.ts'], ['Edit', 'src/lib/cart/store.ts'], ['WebFetch', 'nextjs.org/docs/app/building-your-application/caching'], ['TodoWrite', 'Update the task list'],
  ] },
  'api-gateway': { kind: 'other', steps: [
    ['Read', 'internal/ratelimit/bucket.go'], ['Edit', 'internal/ratelimit/bucket.go'], ['Bash', 'go test ./internal/...'], ['Grep', '"v1/" in openapi/'],
    ['Edit', 'openapi/gateway.yaml'], ['Bash', 'go vet ./...'], ['Read', 'cmd/gateway/main.go'],
  ] },
  'rider-app': { kind: 'mobile', steps: [
    ['Read', 'src/theme/tokens.ts'], ['Edit', 'src/theme/tokens.ts'], ['Grep', '"colors." in app/'], ['Bash', 'npx jest src/theme'],
    ['Bash', 'npx expo-doctor'], ['Read', 'app/(tabs)/settings.tsx'], ['WebSearch', 'expo-notifications permission prompt timing'],
  ] },
  'docs-portal': { kind: 'docs', steps: [
    ['Read', 'docs/guides/getting-started.mdx'], ['Edit', 'docs/v3/routing.mdx'], ['Glob', 'docs/v2/**/*.mdx'], ['Grep', '"/v2/" in docs/'],
    ['Bash', 'npm run build'], ['WebFetch', 'docusaurus.io/docs/search'],
  ] },
  'metrics-pipeline': { kind: 'data', steps: [
    ['Read', 'models/marts/revenue.sql'], ['Edit', 'models/marts/revenue.yml'], ['Bash', 'dbt test --select revenue'], ['Bash', 'dbt run --select +revenue'],
    ['Grep', '"order_total" in models/'], ['Read', 'dags/nightly_backfill.py'],
  ] },
  'design-system': { kind: 'web', steps: [
    ['Read', 'src/Button/Button.tsx'], ['Edit', 'src/Button/Button.css'], ['Bash', 'npm run test:a11y'], ['Grep', '":focus" in src/'],
  ] },
  infra: { kind: 'other', steps: [
    ['Read', 'terraform/staging/rds.tf'], ['Bash', 'terraform plan -out staging.tfplan'], ['Grep', '"engine_version" in terraform/'], ['Edit', 'terraform/staging/rds.tf'],
  ] },
  'growth-emails': { kind: 'other', steps: [
    ['Read', 'emails/onboarding/day-0.mjml'], ['Write', 'emails/onboarding/day-3.mjml'], ['Bash', 'npm run emails:preview'],
  ] },
  'churn-model': { kind: 'data', steps: [
    ['Read', 'notebooks/features.ipynb'], ['NotebookEdit', 'notebooks/features.ipynb'], ['Bash', 'python -m pytest tests/test_features.py'],
    ['Bash', 'jupyter nbconvert --execute notebooks/features.ipynb --to html'], ['Grep', '"tenure_days" in src/'], ['WebSearch', 'sklearn permutation importance with pipelines'],
  ] },
  handbook: { kind: 'docs', steps: [
    ['Read', 'docs/releases/v2.2.md'], ['Write', 'docs/releases/v2.3.md'], ['Bash', 'mkdocs build --strict'], ['Grep', '"breaking" in docs/releases/'],
  ] },
  'watch-companion': { kind: 'mobile', steps: [
    ['Read', 'ios/WatchSync/SessionStore.swift'], ['Bash', 'xcodebuild test -scheme WatchSync'], ['Edit', 'ios/WatchSync/SessionStore.swift'],
  ] },
  'landing-site': { kind: 'web', steps: [
    ['Read', 'src/pages/pricing.astro'], ['Edit', 'src/pages/pricing.astro'], ['Bash', 'npm run build'], ['WebFetch', 'docs.astro.build/en/guides/images/'],
    ['Grep', '"per seat" in src/'],
  ] },
  // A project with no sessions right now: its plot stays (dimmed) for 7 days.
  'brand-site': { kind: 'web', steps: [] },
};

const HANGOUT_STEPS = [
  ['Bash', 'diff <(sort exports/a.csv) <(sort exports/b.csv) | head -40'], ['Read', 'exports/b.csv'], ['Bash', 'python3 compare.py exports/a.csv exports/b.csv'],
  ['WebSearch', 'csv diff ignore column order'], ['Write', 'compare.py'],
];

const NEW_PROMPTS = [
  'add a loading state while this fetches',
  'write tests for the edge cases you found',
  'check the build still passes and open a PR',
  'tidy the copy on the empty state',
  'look at the failing CI job and fix it',
  'split that change into two commits',
];

const FINISHED = [
  'Done. The change is in and the tests pass. I left a note in the PR description about the one flaky snapshot.',
  'Finished: updated the component, added two tests and checked the build. Nothing else changed.',
  'All set. I refactored the helper, kept the public API the same and the suite is green.',
  'Done and pushed to the branch. CI is running; locally everything passes.',
];

const NARRATION = [
  'Let me look at how this is wired up first.',
  'Found it. Making the change now.',
  'Running the tests to make sure nothing else moved.',
];

// ---------------------------------------------------------------------------
// Sessions

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
    say: [],
    past: [],
    activity: history(o.phase === 'working' ? 5 : o.phase === 'shell' ? 0 : 2),
    ...o,
  });
  const ago = (ms) => now - ms;

  const list = [
    // storefront: eight agents on one plot, so it shows "+2".
    s({
      repo: 'storefront', title: 'Checkout page redesign', branch: 'redesign/checkout', ports: [3000], here: true, phase: 'working', mode: 'acceptEdits',
      lastPrompt: 'rebuild the checkout summary card from the new Figma frame', lastPromptAt: ago(12 * MIN), lastActivityAt: ago(2 * SEC), doneAt: now + 140 * SEC,
      say: ['Reading the current summary card and the exported frame first.', 'The totals block needs its own grid. Updating SummaryCard.tsx now.'],
      past: [
        { prompt: 'what does the checkout summary card render today?', at: ago(40 * MIN), texts: ['It renders the line items, a promo code field and the totals, all in one flex column. Totals are computed in the component, not the store.'] },
        { prompt: 'move the totals into the cart store first', at: ago(25 * MIN), texts: ['Moved subtotal, tax and shipping into `cartStore.totals()` and updated the three callers. Tests pass.'] },
      ],
    }),
    s({
      repo: 'storefront', title: 'Flaky login e2e test', branch: 'fix/flaky-login', model: 'Sonnet 5.5', phase: 'working',
      lastPrompt: 'find out why the login e2e test fails on CI about one run in five', lastPromptAt: ago(3 * MIN), lastActivityAt: ago(5 * SEC), doneAt: now + 45 * SEC,
      say: ['Running the login test twenty times in a row to catch the failure locally.'],
    }),
    s({
      repo: 'storefront', title: 'Gift card support', branch: 'feat/gift-cards', phase: 'blocked',
      lastPrompt: 'add gift cards as a payment method, behind a feature flag', lastPromptAt: ago(8 * MIN), lastActivityAt: ago(30 * SEC),
      say: ['The schema change is ready. I need to run the migration against the local database before wiring up checkout.'],
      decision: { kind: 'permission', tool: { name: 'Bash', command: 'npm run db:migrate -- --name add_gift_cards', detail: 'Apply the gift card migration to the local database' } },
    }),
    s({
      repo: 'storefront', title: 'Search results paging', branch: 'feat/search-paging', phase: 'working',
      lastPrompt: 'replace infinite scroll on search with numbered pages', lastPromptAt: ago(6 * MIN), lastActivityAt: ago(9 * SEC), doneAt: now + 110 * SEC,
      say: ['Finding every place that reads the search cursor.'],
    }),
    s({
      repo: 'storefront', title: 'Wishlist sync', branch: 'feat/wishlist-sync', unread: 1,
      lastPrompt: 'sync the wishlist across devices for signed-in shoppers', lastPromptAt: ago(31 * MIN), lastActivityAt: ago(4 * MIN),
      reply: 'Wishlists now sync for signed-in shoppers.\n\n- Local items merge into the account on sign-in (newest wins)\n- `useWishlist` subscribes to the account copy\n- 9 new tests, all green\n\nGuests keep the local-only list as before.',
      recap: 'Wishlists sync across devices for signed-in shoppers; guests keep the local list. 9 new tests pass.',
    }),
    s({
      repo: 'storefront', title: 'Order history filters', branch: 'feat/order-filters', model: 'Sonnet 5.5',
      lastPrompt: 'add date and status filters to the order history page', lastPromptAt: ago(47 * MIN), lastActivityAt: ago(21 * MIN),
      reply: 'Added the date range and status filters, both kept in the URL so the page can be shared.\n\nShould the filters also apply to the CSV export?',
      question: 'Should the filters also apply to the CSV export?',
    }),
    s({
      repo: 'storefront', title: 'Product image zoom', branch: 'feat/image-zoom',
      lastPrompt: 'let people zoom product photos with pinch and scroll', lastPromptAt: ago(52 * MIN), lastActivityAt: ago(38 * MIN),
      recap: 'Added pinch and wheel zoom to the product gallery, with a reset button. Tests pass; not committed yet.',
      reply: 'Added pinch and wheel zoom to the product gallery, with a reset button.\n\n- `Gallery.tsx`: zoom state and gestures\n- `gallery.spec.ts`: 6 new tests\n\nNot committed yet.',
    }),
    s({
      repo: 'storefront', title: 'Cart badge count', branch: 'fix/cart-badge',
      lastPrompt: 'the cart badge shows 0 after a refresh', lastPromptAt: ago(5 * DAY + 2 * HOUR), lastActivityAt: ago(5 * DAY + HOUR),
      recap: 'Traced the bug to the cart store hydrating after the header renders. Proposed two fixes and waited for a pick.',
      reply: 'The badge reads the cart before it has loaded from storage. I can either delay the header or subscribe the badge to the store.',
    }),

    s({
      repo: 'api-gateway', title: 'Rate limiter for public API', branch: 'feat/rate-limit', phase: 'blocked',
      lastPrompt: 'add a token-bucket rate limiter to the public routes and load test it', lastPromptAt: ago(9 * MIN), lastActivityAt: ago(40 * SEC),
      say: ['The limiter is in and unit tested. Next I want to load test it at 500 requests per second.'],
      decision: { kind: 'permission', tool: { name: 'Bash', command: 'npm run test:load -- --rps 500 --duration 60s', detail: 'Load test the gateway at 500 requests per second' } },
    }),
    s({
      repo: 'api-gateway', title: 'OpenAPI spec cleanup', branch: 'chore/openapi', model: 'Sonnet 5.5', phase: 'working',
      lastPrompt: 'remove the deprecated v1 endpoints from the OpenAPI spec', lastPromptAt: ago(4 * MIN), lastActivityAt: ago(3 * SEC), doneAt: now + 70 * SEC,
      say: ['Listing every v1 path in the spec before removing anything.'],
    }),

    s({
      repo: 'rider-app', title: 'Push notification opt-in', branch: 'feat/push-optin', phase: 'blocked',
      lastPrompt: 'add a push notification opt-in screen', lastPromptAt: ago(6 * MIN), lastActivityAt: ago(25 * SEC),
      say: ['Before I build the screen, one product question.'],
      decision: {
        kind: 'question',
        questions: [{
          header: 'Timing', question: 'When should the app ask for notification permission?', multiSelect: false,
          options: [
            { label: 'After the first ride', description: 'People have a reason to want updates by then' },
            { label: 'On first launch', description: 'Simplest, but most people decline' },
            { label: 'Only from settings', description: 'Never prompt on its own' },
          ],
        }],
      },
    }),
    s({
      repo: 'rider-app', title: 'Dark mode tokens', branch: 'feat/dark-tokens', model: 'Sonnet 5.5', phase: 'working',
      lastPrompt: 'add dark mode values to every colour token', lastPromptAt: ago(2 * MIN), lastActivityAt: ago(4 * SEC), doneAt: now + 95 * SEC,
      say: ['Reading the token file to see how the light values are structured.'],
    }),

    s({
      repo: 'docs-portal', title: 'Docs site search', branch: 'feat/search', ports: [3001],
      lastPrompt: 'add search to the docs site', lastPromptAt: ago(70 * MIN), lastActivityAt: ago(12 * MIN),
      recap: 'Search is in: a local index built at deploy time and a ⌘K dialog. PR #42 is open.',
      reply: 'Search is in: a local index built at deploy time and a ⌘K dialog. PR #42 is open.',
    }),
    s({
      repo: 'docs-portal', title: 'Migrate v2 guides', branch: 'docs/v3-guides',
      lastPrompt: 'move the v2 guides to the v3 structure', lastPromptAt: ago(40 * MIN), lastActivityAt: ago(15 * MIN),
      reply: 'Moved all 24 guides to the v3 structure and fixed the internal links.\n\nShould I also add redirects from the old /v2 URLs?',
      question: 'Should I also add redirects from the old /v2 URLs?',
    }),

    s({
      repo: 'metrics-pipeline', title: 'Revenue model tests', branch: 'test/revenue', phase: 'working',
      lastPrompt: 'add dbt tests for the revenue mart: uniqueness, not null and the refund rule', lastPromptAt: ago(7 * MIN), lastActivityAt: ago(6 * SEC), doneAt: now + 80 * SEC,
      say: ['Reading the revenue model to see which columns the refund rule touches.'],
    }),
    s({
      repo: 'metrics-pipeline', title: 'Nightly ETL backfill',
      lastPrompt: 'backfill the events table for March', lastPromptAt: ago(3 * DAY + 4 * HOUR), lastActivityAt: ago(3 * DAY + 3 * HOUR),
      recap: 'Backfilled March; two days had gaps in the source and are listed in backfill.log.',
      reply: 'Backfilled March. Two days (the 9th and the 23rd) had gaps in the source; they are listed in `backfill.log`.',
    }),
    s({ repo: 'metrics-pipeline', title: 'logs', phase: 'shell', lastActivityAt: null }),

    s({
      repo: 'design-system', title: 'Button focus rings', branch: 'a11y/focus',
      lastPrompt: 'make focus rings visible on every button variant', lastPromptAt: ago(3 * HOUR), lastActivityAt: ago(2 * HOUR + 40 * MIN),
      recap: 'Every button variant now has a 2px focus ring that passes contrast on all surfaces.',
      reply: 'Every button variant now has a 2px focus ring that passes contrast on all six surfaces. Screenshots are in the PR.',
    }),

    s({
      repo: 'infra', title: 'Staging database upgrade', branch: 'infra/pg17', mode: 'plan', phase: 'blocked',
      lastPrompt: 'plan the staging Postgres upgrade to 17', lastPromptAt: ago(11 * MIN), lastActivityAt: ago(50 * SEC),
      say: ['I read the RDS module and the last two upgrade runbooks. Here is the plan.'],
      decision: {
        kind: 'plan',
        plan: '## Upgrade staging Postgres 15 → 17\n\n1. Snapshot the staging volume\n2. Run `pg_upgrade --check` on a clone\n3. Upgrade in place during the 02:00 window\n4. Re-run the smoke tests and `ANALYZE`\n\nRollback: restore the snapshot (about 6 minutes).',
      },
    }),
    s({
      repo: 'infra', title: 'Rotate CI secrets',
      lastPrompt: 'rotate the deploy keys used by CI', lastPromptAt: ago(9 * DAY), lastActivityAt: ago(9 * DAY - 20 * MIN),
      recap: 'Rotated three of four keys; the registry token needs an admin login.',
      reply: 'Rotated three of the four keys. The registry token needs an admin login, so I left it.',
    }),
    s({ repo: 'infra', title: 'zsh', phase: 'shell', lastActivityAt: null }),

    s({
      repo: 'growth-emails', title: 'Onboarding email sequence', model: 'Sonnet 5.5', unread: 1,
      lastPrompt: 'draft a five email onboarding sequence for new trial users', lastPromptAt: ago(26 * MIN), lastActivityAt: ago(7 * MIN),
      recap: 'Drafted the five onboarding emails in emails/onboarding/ with subject lines, preview text and send delays.',
      reply: 'Drafted the five onboarding emails in `emails/onboarding/`.\n\n| Day | Subject |\n| --- | --- |\n| 0 | Welcome, here is your first step |\n| 1 | Three things to try today |\n| 3 | How teams use it |\n| 7 | Your trial, halfway |\n| 13 | Last day of your trial |',
    }),

    s({
      repo: 'churn-model', title: 'Churn features notebook', branch: 'exp/tenure-features', phase: 'working',
      lastPrompt: 'add tenure and support-ticket features and compare the model with and without them', lastPromptAt: ago(14 * MIN), lastActivityAt: ago(8 * SEC), doneAt: now + 150 * SEC,
      say: ['Adding the two feature columns to the notebook, then re-running the comparison.'],
      past: [{ prompt: 'what is the baseline AUC right now?', at: ago(50 * MIN), texts: ['The baseline gradient-boosted model scores 0.781 AUC on the March holdout.'] }],
    }),

    s({
      repo: 'handbook', title: 'Release notes for v2.3', model: 'Haiku 5.5',
      lastPrompt: 'summarise the merged PRs since v2.2', lastPromptAt: ago(2 * HOUR), lastActivityAt: ago(2 * HOUR - 3 * MIN),
      recap: 'Wrote release notes for v2.3 from 31 merged PRs, grouped into features, fixes and internal.',
      reply: 'Wrote `docs/releases/v2.3.md` from 31 merged PRs, grouped into features, fixes and internal changes.',
    }),

    s({
      repo: 'watch-companion', title: 'Workout sync crash', branch: 'fix/sync-crash', phase: 'blocked', statusLabel: 'Needs input',
      lastPrompt: 'the watch app crashes when a workout syncs while the phone is locked', lastPromptAt: ago(5 * MIN), lastActivityAt: ago(20 * SEC),
      say: ['Reproducing it with the simulator pair. The test run is waiting on a prompt in the terminal.'],
      decision: { kind: 'terminal', label: 'Needs input', tool: { name: 'Bash', detail: 'xcodebuild test -scheme WatchSync', command: 'xcodebuild test -scheme WatchSync' } },
    }),

    s({
      repo: 'landing-site', title: 'Pricing page copy', branch: 'copy/pricing', model: 'Sonnet 5.5', phase: 'working',
      lastPrompt: 'rewrite the pricing page copy so each plan says who it is for', lastPromptAt: ago(5 * MIN), lastActivityAt: ago(7 * SEC), doneAt: now + 60 * SEC,
      say: ['Reading the current pricing page and the plan limits.'],
    }),

    // The hangout: sessions outside any repository.
    s({
      repo: null, title: 'Regex for log timestamps', model: 'Haiku 5.5',
      lastPrompt: 'write a regex that matches ISO timestamps with optional milliseconds', lastPromptAt: ago(34 * MIN), lastActivityAt: ago(33 * MIN),
      recap: 'Gave a regex with tests for the six formats in your sample, plus one edge case it rejects on purpose.',
      reply: 'This matches all six formats in your sample:\n\n```\n\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})\n```\n\nIt rejects `2024-03-09 10:00` (no `T`) on purpose.',
    }),
    s({
      repo: null, title: 'Compare two CSV exports', phase: 'working',
      lastPrompt: 'tell me which rows changed between these two exports', lastPromptAt: ago(90 * SEC), lastActivityAt: ago(6 * SEC), doneAt: now + 55 * SEC,
      say: ['Sorting both files so the diff lines up.'],
    }),
  ];

  list.forEach((x, i) => {
    x.order = i;
    x.cwd = x.repo ? `~/code/${x.repo}` : '~/code';
    x.project = x.repo || 'code';
    x.repoInfo = x.repo ? { key: `~/code/${x.repo}/.git`, name: x.repo, kind: REPOS[x.repo].kind } : null;
    x.steps = (x.repo ? REPOS[x.repo].steps : HANGOUT_STEPS).map(([name, detail]) => ({ name, detail }));
    if (x.phase === 'working') x.now = pick(x.steps);
    if (x.phase === 'blocked') openDecision(x, now - (x.decision.kind === 'permission' ? 40 : 15) * SEC);
    // Earlier turns: their replies came a few minutes after each prompt.
    x.past = x.past.map((t) => ({ prompt: t.prompt, at: t.at, texts: t.texts.map((text) => ({ text, at: t.at + 3 * MIN })) }));
  });
  return list;
}

function openDecision(x, since) {
  x.phase = 'blocked';
  x.blocked = { ...x.decision, requestId: uuid(), since: new Date(since).toISOString(), deadline: new Date(since + DECISION_TTL).toISOString() };
  if (x.decision.kind === 'terminal') {
    // Only the terminal can answer this one: there is no Feed request and no deadline.
    x.blocked = { kind: 'terminal', requestId: null, since: new Date(since).toISOString(), label: x.decision.label, tool: x.decision.tool };
  }
}

// The demo's world: one project closed three days ago keeps its plot (dimmed).
function initialWorld(now) {
  return {
    version: 1,
    repos: {
      '~/code/brand-site/.git': { plot: 12, name: 'brand-site', kind: REPOS['brand-site'].kind, firstSeen: now - 20 * DAY, lastSeen: now - 3 * DAY },
    },
    agents: {},
    archived: {},
  };
}

export function createDemoSource() {
  const sessions = seed(Date.now());
  let onChange = () => {};
  let onTick = () => {};

  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

  function tick(x, hook, tool) {
    onTick(tool ? { surfaceId: x.surfaceId, hook, tool } : { surfaceId: x.surfaceId, hook });
  }

  function scheduleTick(x, now) {
    x.nextTickAt = now + TICK_MIN_MS + Math.random() * TICK_SPREAD_MS;
  }

  // Keeps what was said in the current turn, so the conversation endpoint can show it later.
  function archiveTurn(x) {
    if (!x.lastPrompt) return;
    const texts = x.say.map((text) => ({ text, at: x.lastPromptAt + 20 * SEC }));
    if (x.reply) texts.push({ text: typeof x.reply === 'string' ? x.reply : x.reply.text, at: x.lastActivityAt });
    x.past.push({ prompt: x.lastPrompt, at: x.lastPromptAt, texts });
    if (x.past.length > 19) x.past.shift();
  }

  function startWork(x, prompt, now, ms) {
    if (prompt) {
      archiveTurn(x);
      x.lastPrompt = prompt;
      x.lastPromptAt = now;
      x.say = [pick(NARRATION)];
      x.reply = null;
      tick(x, 'UserPromptSubmit');
    }
    x.phase = 'working';
    x.blocked = null;
    x.question = null;
    x.unread = 0;
    x.now = pick(x.steps);
    x.lastActivityAt = now;
    x.doneAt = now + ms;
    scheduleTick(x, now);
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
    tick(x, 'Stop');
  }

  // Tool calls: each working agent on its own rhythm, so icons don't pop in unison.
  function toolCalls() {
    const now = Date.now();
    let changed = false;
    for (const x of sessions) {
      if (x.phase !== 'working') continue;
      if (!x.nextTickAt) scheduleTick(x, now - Math.random() * TICK_MIN_MS);
      if (now < x.nextTickAt) continue;
      let step = pick(x.steps);
      if (x.steps.length > 1) while (step === x.now) step = pick(x.steps);
      x.now = step;
      x.activity[BINS - 1] += 1;
      x.lastActivityAt = now;
      tick(x, 'PreToolUse', tickTool(step.name));
      scheduleTick(x, now);
      changed = true;
    }
    if (changed) onChange();
  }

  function step() {
    const now = Date.now();
    let changed = false;
    for (const x of sessions) {
      if (x.phase === 'working') {
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
    if (changed) onChange(0);
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
        repo: x.repoInfo,
        branch: x.branch,
        ports: x.ports,
        agent: x.phase === 'shell' ? null : { kind: 'claude', sessionId: x.sessionId, state: x.phase === 'working' ? 'working' : 'idle' },
        phase: x.phase,
        blocked: x.blocked,
        statusLabel: x.phase === 'blocked' && x.blocked?.kind === 'terminal' ? x.blocked.label : null,
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

  function conversation(item) {
    const x = sessions.find((s) => s.surfaceId === item?.surfaceId);
    if (!x || x.phase === 'shell') return null;
    const messages = [];
    for (const t of x.past) {
      messages.push({ role: 'user', text: t.prompt, at: iso(t.at) });
      for (const m of t.texts) messages.push({ role: 'assistant', text: m.text, at: iso(m.at) });
    }
    if (x.lastPrompt) {
      messages.push({ role: 'user', text: x.lastPrompt, at: iso(x.lastPromptAt) });
      x.say.forEach((text, i) => messages.push({ role: 'assistant', text, at: iso(Math.min(x.lastPromptAt + (i + 1) * 20 * SEC, x.lastActivityAt)) }));
      if (x.reply && x.phase === 'idle') {
        const reply = typeof x.reply === 'string' ? { text: x.reply, at: iso(x.lastActivityAt) } : x.reply;
        messages.push({ role: 'assistant', text: reply.text, at: reply.at });
      }
    }
    return { messages, truncated: false };
  }

  const byRequest = (id) => sessions.find((x) => x.blocked?.requestId && x.blocked.requestId === id) || null;

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
          x.reply = { text: "Okay, I won't run that. Tell me if you'd like a lighter version instead.", at: iso(now) };
          x.recap = x.reply.text;
          x.question = "Tell me if you'd like a lighter version instead.";
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
    onChange(0);
    return note ? { ok: true, note } : { ok: true };
  }

  return {
    name: 'demo',
    start({ changed, tick: tickHook, live }) {
      onChange = changed || onChange;
      onTick = tickHook || onTick;
      live?.(true);
      setInterval(step, SEC);
      setInterval(toolCalls, 250);
    },
    snapshot: async () => snapshot(),
    act,
    conversation: async (item) => conversation(item),
    initialWorld: () => initialWorld(Date.now()),
  };
}
