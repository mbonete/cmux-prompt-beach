// Browser tests for the 3D city: real WebGPU in a headless Chrome, driven over
// the DevTools protocol, against demo servers this script starts itself. They
// cover what unit tests can't: the page boots without errors on every quality
// and time of day, the camera behaves (one landing, straight zoom-out, steady
// tilt while panning), panels and actions work, the phone layout fits, swarm
// budgets hold, and nothing grows while you use it.
//
//   npm run test:browser            (needs Google Chrome and a GPU: run it on a Mac, not CI)
//
// Exit code 1 if any check fails.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BOOT_MS = 45_000;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- processes

const children = [];
function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(p);
  return p;
}
function cleanup() {
  for (const p of children) p.kill('SIGTERM');
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function waitFor(url, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`${url} never answered`);
}

// ---------------------------------------------------------------- CDP

class Page {
  static async open(debugPort) {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = list.find((t) => t.type === 'page');
    const page = new Page(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((r) => this.ws.addEventListener('open', r, { once: true }));
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(`exception: ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails?.text}`);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an async function body in the page; returns its value or throws its error. */
  async run(body, timeout = 120_000) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout,
    });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }

  async load(url, { width = 1512, height = 792, quality = null } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
    // The quality for this load only (a registered script would run on every later load too).
    const added = quality ? await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('switchboard.quality', ${JSON.stringify(quality)}); } catch {}` }) : null;
    this.errors = [];
    await this.send('Page.navigate', { url });
    if (added?.result?.identifier) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.result.identifier });
    const until = Date.now() + BOOT_MS;
    while (Date.now() < until) {
      await sleep(1000);
      const state = await this.run(`return window.switchboard?.world ? 'world' : document.getElementById('fatal')?.hidden === false ? 'fatal' : 'loading';`).catch(() => 'loading');
      if (state === 'world') return;
      if (state === 'fatal') throw new Error('the 3D city fell back to the lists');
    }
    throw new Error('the city did not start');
  }
}

// ---------------------------------------------------------------- checks

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, note: err.message, ms: Date.now() - t0 });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
function noErrors(page, since = 0) {
  const errs = page.errors.slice(since);
  expect(!errs.length, `${errs.length} console error(s): ${errs[0]}`);
}

// Shared page snippets.
const SETUP = `const sb = window.switchboard; const W = sb.world; const R = W.rig; W.director.enabled = false;`;
const AGENT = `[...sb.app.state.rows.values()].find((r) => r.item.spot !== null && typeof r.item.plot === 'number')`;

async function main() {
  const demoPort = await freePort();
  const swarmPort = await freePort();
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'switchboard-browser-'));
  start(process.execPath, ['server.mjs', '--demo'], { PORT: String(demoPort) });
  start(process.execPath, ['server.mjs', '--demo', '--swarm'], { PORT: String(swarmPort) });
  start(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--enable-unsafe-webgpu', '--window-size=1512,792', '--no-first-run', '--no-default-browser-check', '--enable-precise-memory-info', 'about:blank']);
  await waitFor(`http://127.0.0.1:${demoPort}/`);
  await waitFor(`http://127.0.0.1:${swarmPort}/`);
  await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
  const page = await Page.open(debugPort);
  const demo = `http://localhost:${demoPort}/`;

  console.log('\nBoot');
  for (const quality of ['light', 'balanced', 'cinematic']) {
    await check(`boots on ${quality} with no console errors`, async () => {
      await page.load(demo, { quality });
      await sleep(4000);
      const q = await page.run(`return window.switchboard.world.status.quality;`);
      noErrors(page);
      return `quality ${q}`;
    });
  }

  console.log('\nTimes of day');
  await check('every time of day renders without errors', async () => {
    const since = page.errors.length;
    const looks = await page.run(`${SETUP} const out = []; for (const t of ['day', 'sunset', 'dusk', 'night', 'dawn']) { W.setTimeOfDay(t); await new Promise((r) => setTimeout(r, 3500)); out.push(t); } W.setTimeOfDay('sunset'); return out.join(', ');`);
    noErrors(page, since);
    return looks;
  });

  console.log('\nCamera');
  await check('clicking a person: one flight, then the camera holds still', async () => {
    const r = await page.run(`${SETUP} sb.app.state.select(null); W.overview(); await new Promise((x) => setTimeout(x, 2500));
      const row = ${AGENT}; const s = []; let alive = true;
      const tick = () => { if (!alive) return; const p = R.camera.position; s.push({ f: !!R.flight, x: p.x, y: p.y, z: p.z }); requestAnimationFrame(tick); };
      requestAnimationFrame(tick); sb.app.selectAgent(row.item.surfaceId); await new Promise((x) => setTimeout(x, 4500)); alive = false;
      const end = s.findIndex((x, i) => i > 3 && !x.f); let after = 0;
      for (let i = end + 1; i < s.length; i++) after += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y, s[i].z - s[i - 1].z);
      return { landed: end > 0, after, card: !document.querySelector('.card').hidden, selected: sb.app.state.selected === row.item.surfaceId };`);
    expect(r.landed && r.selected && r.card, 'the close-up and card did not open');
    expect(r.after < 0.01, `the camera kept moving after landing (${r.after.toFixed(3)} m)`);
    return `moved ${r.after.toFixed(3)} m after landing`;
  });
  await check('Esc closes the card', async () => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
    const open = await page.run(`return { selected: window.switchboard.app.state.selected, hidden: document.querySelector('.card').hidden };`);
    expect(!open.selected && open.hidden, 'the card is still open');
  });
  await check('zooming out with a card open pulls straight back', async () => {
    const r = await page.run(`${SETUP} const row = ${AGENT}; sb.app.selectAgent(row.item.surfaceId); await new Promise((x) => setTimeout(x, 3000));
      const canvas = document.querySelector('canvas'); const rect = canvas.getBoundingClientRect();
      const rows = []; let alive = true; let prev = R.camera.position.clone();
      const tick = () => { if (!alive) return; const p = R.camera.position; const right = p.clone().set(1, 0, 0).applyQuaternion(R.camera.quaternion); rows.push(p.clone().sub(prev).dot(right)); prev = p.clone(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      for (let i = 0; i < 28; i++) { canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 70, clientX: rect.left + rect.width * 0.25, clientY: rect.top + rect.height * 0.7, bubbles: true, cancelable: true })); await new Promise((x) => setTimeout(x, 60)); }
      await new Promise((x) => setTimeout(x, 1500)); alive = false;
      return { sideways: Math.abs(rows.reduce((a, b) => a + b, 0)), closed: !sb.app.state.selected, distance: R.current.distance };`);
    expect(r.closed, 'the card stayed open past the close-up range');
    expect(r.sideways < 0.2, `the camera slid ${r.sideways.toFixed(2)} m sideways`);
    return `${r.sideways.toFixed(2)} m sideways over a pull-back to ${Math.round(r.distance)} m`;
  });
  await check('panning keeps the tilt', async () => {
    const r = await page.run(`${SETUP} const out = []; for (const dist of [75, 45, 30]) {
        R.flyTo({ target: R.desired.target.clone().set(0, 0, -40), distance: dist, pitch: 38 * Math.PI / 180, yaw: 0 }, 0.01); await new Promise((x) => setTimeout(x, 1200));
        const tilts = []; let alive = true; const tick = () => { if (!alive) return; const p = R.camera.position, L = R.look; tilts.push(Math.atan2(p.y - L.y, Math.hypot(p.x - L.x, p.z - L.z)) * 180 / Math.PI); requestAnimationFrame(tick); };
        requestAnimationFrame(tick); for (let i = 0; i < 40; i++) { R.touched(); R.desired.target.z += i < 20 ? 2.2 : -2.2; R.current.target.copy(R.desired.target); await new Promise((x) => setTimeout(x, 33)); }
        await new Promise((x) => setTimeout(x, 300)); alive = false; out.push(Math.max(...tilts) - Math.min(...tilts)); }
      return out;`);
    const worst = Math.max(...r);
    expect(worst < 0.5, `the tilt changed by ${worst.toFixed(1)}° while panning`);
    return `tilt varied ${worst.toFixed(2)}° at most`;
  });

  // Shared by the two collision checks: a camera recorder and wheel ticks.
  const COLLIDE = `${SETUP} sb.app.state.select(null); await new Promise((x) => setTimeout(x, 300));
    const D = W.district; const wait = (ms) => new Promise((x) => setTimeout(x, ms)); const V = () => R.desired.target.clone();
    const canvas = document.querySelector('canvas'); const rect = canvas.getBoundingClientRect();
    // The real height under a point (the rig's lookup adds slack around footprints).
    const trueH = (x, z) => { let h = 0; const v = V(); for (const p of D.plots.values()) { v.set(x, 0, z).applyMatrix4(p.inverse); const gx = Math.floor((v.x + 12) / 2), gz = Math.floor((v.z + 10) / 2); if (gx < 0 || gz < 0 || gx >= 12 || gz >= 10) continue; h = Math.max(h, D.heights.get(p.type).cells[gz * 12 + gx] + p.world.elements[13]); } return h; };
    const record = () => { const log = []; let on = true; const f = () => { if (!on) return; const c = R.camera.position, l = R.look; log.push({ dist: R.current.distance, tilt: Math.asin((c.y - l.y) / c.distanceTo(l)) * 180 / Math.PI, above: c.y - trueH(c.x, c.z) }); requestAnimationFrame(f); }; requestAnimationFrame(f); return () => { on = false; return log; }; };
    const wheel = async (n, dy, x, y) => { for (let i = 0; i < n; i++) { canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true })); await wait(70); } };`;

  await check('zooming in toward a kiosk keeps the tilt (stops short of its roof)', async () => {
    const r = await page.run(`${COLLIDE}
      const kiosk = [...D.plots.entries()].find(([, p]) => p.type === 'plot_juice_kiosk'); if (!kiosk) return { missing: true };
      // Its roof (the only part over 5 m), and a view across the plot toward it like the one it was reported from.
      const g = D.heights.get(kiosk[1].type).cells; let k = 0; for (let i = 0; i < g.length; i++) if (g[i] > g[k]) k = i;
      const roof = V().set((k % 12) * 2 - 11, g[k] - 0.5, Math.floor(k / 12) * 2 - 9).applyMatrix4(kiosk[1].world);
      R.flyTo({ target: V().set(roof.x + 4, 0, roof.z + 7), distance: 46, pitch: 48 * Math.PI / 180, yaw: 0.12 }, 0.01); await wait(800);
      const s = roof.clone().project(R.camera); const stop = record();
      await wheel(40, -40, rect.left + (s.x + 1) / 2 * rect.width, rect.top + (1 - s.y) / 2 * rect.height); await wait(1200); const log = stop();
      const t = log.map((f) => f.tilt); return { swing: Math.max(...t) - Math.min(...t), end: log.at(-1).dist, above: Math.min(...log.map((f) => f.above)) };`);
    expect(!r.missing, 'no juice kiosk in the city');
    expect(r.swing < 0.5, `the camera tilted ${r.swing.toFixed(1)}° on its own while zooming in`);
    expect(r.above > 0.5, `the camera went within ${r.above.toFixed(1)} m of a roof`);
    return `tilt held within ${r.swing.toFixed(2)}°, stopped at ${r.end.toFixed(1)} m`;
  });
  await check('zooming out into a tall building lifts the camera over it, never through it', async () => {
    const r = await page.run(`${COLLIDE}
      let best = null; for (const [key, p] of D.plots) { const g = D.heights.get(p.type).cells; for (let k = 0; k < g.length; k++) if (!best || g[k] > best.h) best = { key, p, k, h: g[k] }; }
      const B = V().set((best.k % 12) * 2 - 11, 0, Math.floor(best.k / 12) * 2 - 9).applyMatrix4(best.p.world); const C = D.center(best.key);
      const away = V().set(C.x - B.x, 0, C.z - B.z).normalize(); const target = B.clone().addScaledVector(away, 14);
      R.flyTo({ target, distance: 8, pitch: 30 * Math.PI / 180, yaw: Math.atan2(B.x - target.x, B.z - target.z) }, 0.01); await wait(800);
      const stop = record(); await wheel(25, 40, rect.left + rect.width / 2, rect.top + rect.height / 2); await wait(1500); const log = stop();
      return { height: best.h, to: log.at(-1).dist, above: Math.min(...log.map((f) => f.above)), rose: Math.max(...log.map((f) => f.tilt)) - 30 };`);
    expect(r.to > 20, `the zoom out stopped at ${r.to.toFixed(0)} m`);
    expect(r.above > 0.5, `the camera went within ${r.above.toFixed(1)} m of the ${r.height.toFixed(0)} m roof (or inside it)`);
    return `${r.height.toFixed(0)} m building: rose ${r.rose.toFixed(0)}°, kept ${r.above.toFixed(1)} m above its roofs`;
  });
  await check('scrolling during a flight takes over from where the camera is', async () => {
    const r = await page.run(`${SETUP} sb.app.state.select(null); W.overview(); await new Promise((x) => setTimeout(x, 2500));
      const row = ${AGENT}; sb.app.selectAgent(row.item.surfaceId); await new Promise((x) => setTimeout(x, 500));
      const mid = R.current.distance; const canvas = document.querySelector('canvas'); const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
      const heading = R.desired.distance;
      await new Promise((x) => setTimeout(x, 1500));
      return { mid, heading, after: R.current.distance, selected: sb.app.state.selected === row.item.surfaceId };`);
    expect(r.heading <= r.mid * 1.05, `after the scroll the camera headed for ${Math.round(r.heading)} m (it was at ${Math.round(r.mid)} m)`);
    expect(r.after <= r.mid * 1.05, `the camera went back out to ${Math.round(r.after)} m (it was at ${Math.round(r.mid)} m)`);
    expect(r.selected, 'the card closed');
    return `${Math.round(r.mid)} m → ${Math.round(r.after)} m, card kept`;
  });
  await check('someone behind the camera is known to be behind (edge arrows point the right way)', async () => {
    const r = await page.run(`${SETUP} sb.app.state.select(null); await new Promise((x) => setTimeout(x, 300)); // no follow pulling the view back
      const row = ${AGENT}; const p = W.people.positionOf(row.item.surfaceId, R.desired.target.clone());
      R.flyTo({ target: p.clone().setY(0.9), distance: 30, pitch: 30 * Math.PI / 180, yaw: 0 }, 0.01); await new Promise((x) => setTimeout(x, 400));
      const front = { x: 0, y: 0, behind: false }; W.screenOf(row.item.surfaceId, front);
      // Looking along +z from 16 m past them: they're behind the camera.
      R.flyTo({ target: p.clone().setY(0.9).add(p.clone().set(0, 0, 25)), distance: 10, pitch: 30 * Math.PI / 180, yaw: Math.PI }, 0.01); await new Promise((x) => setTimeout(x, 400));
      const back = { x: 0, y: 0, behind: false }; W.screenOf(row.item.surfaceId, back); return { front: front.behind, back: back.behind };`);
    expect(r.front === false && r.back === true, `in front: behind=${r.front}; behind: behind=${r.back}`);
  });
  await check('the idle tour doesn’t follow a selected person, and gives the follow back', async () => {
    const r = await page.run(`${SETUP} W.director.enabled = true; const row = ${AGENT}; sb.app.selectAgent(row.item.surfaceId); await new Promise((x) => setTimeout(x, 2500));
      W.director.start(); await new Promise((x) => setTimeout(x, 900));
      // During a shot the camera should hold its framing, not slide toward the selected person.
      const a = R.desired.target.clone(); await new Promise((x) => setTimeout(x, 2000)); const drift = R.desired.target.distanceTo(a);
      W.director.stop(); await new Promise((x) => setTimeout(x, 1800));
      const person = W.people.positionOf(row.item.surfaceId, R.desired.target.clone()); const back = Math.hypot(R.desired.target.x - person.x, R.desired.target.z - person.z);
      W.director.enabled = false; sb.app.state.select(null);
      return { drift, back };`);
    expect(r.drift < 0.5, `a tour shot drifted ${r.drift.toFixed(1)} m toward the selected person`);
    expect(r.back < 2, `after the tour the camera is ${r.back.toFixed(1)} m off the selected person`);
    return `shot drift ${r.drift.toFixed(2)} m`;
  });

  console.log('\nInterface');
  await check('a list that reorders keeps the keyboard focus', async () => {
    const r = await page.run(`${SETUP} sb.app.state.openPanel('agents'); await new Promise((x) => setTimeout(x, 600));
      // The last row of "your move" (sorted by latest activity): give it the newest activity so it jumps to the top.
      const lane = sb.app.state.lane('move'); const pick = lane[lane.length - 1].item.surfaceId;
      const target = document.querySelector('.panel [data-pick="' + CSS.escape(pick) + '"]'); target.focus();
      const order = () => [...document.querySelectorAll('.panel .group--move [data-pick]')].map((e) => e.dataset.pick);
      const before = order().indexOf(pick);
      const row = sb.app.state.row(pick); row.item.lastActivityAt = new Date().toISOString(); sb.app.state.emit(); await new Promise((x) => setTimeout(x, 300));
      const after = order().indexOf(pick);
      const a = document.activeElement; const out = { moved: before !== after, before, after, same: a === target, pick: a?.dataset?.pick === pick, tag: a?.tagName };
      sb.app.state.openPanel(null); return out;`);
    expect(r.moved, `the row didn't move (position ${r.before})`);
    expect(r.pick, `focus moved to ${r.tag}`);
    return `row moved ${r.before} → ${r.after}; ${r.same ? 'same element kept' : 'focus restored'}`;
  });
  await check('a reply sent twice quickly goes once', async () => {
    const r = await page.run(`${SETUP} const row = sb.app.state.lane('move').find((x) => x.item.agent) ?? sb.app.state.lane('needs')[0]; sb.app.state.select(row.item.surfaceId, true); await new Promise((x) => setTimeout(x, 800));
      const ta = document.querySelector('.composer__input'); if (!ta) return { composer: false };
      let calls = 0; const run = sb.app.actions.run.bind(sb.app.actions); sb.app.actions.run = async (a, ...rest) => { if (a.action === 'reply') calls++; return run(a, ...rest); };
      ta.value = 'test reply'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      for (let i = 0; i < 2; i++) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      await new Promise((x) => setTimeout(x, 1500)); sb.app.actions.run = run; sb.app.state.select(null);
      return { composer: true, calls };`);
    expect(r.composer, 'no reply box in the side panel');
    expect(r.calls === 1, `${r.calls} replies sent`);
  });
  await check('every panel opens with content and no errors', async () => {
    const since = page.errors.length;
    const r = await page.run(`${SETUP} const out = {}; for (const p of ['agents', 'projects', 'inbox', 'archive', 'settings', 'help']) { sb.app.state.openPanel(p); await new Promise((x) => setTimeout(x, 500)); out[p] = document.querySelector('.panel')?.innerText.trim().length ?? 0; } sb.app.state.openPanel(null); return out;`);
    noErrors(page, since);
    const empty = Object.entries(r).filter(([, n]) => n < 10).map(([p]) => p);
    expect(!empty.length, `empty panel(s): ${empty.join(', ')}`);
    return Object.keys(r).join(', ');
  });
  await check('answering a permission request in the card', async () => {
    const r = await page.run(`${SETUP} const row = sb.app.state.lane('needs').find((x) => x.item.blocked?.kind === 'permission' && x.item.spot !== null);
      if (!row) return { skipped: true }; sb.app.selectAgent(row.item.surfaceId); await new Promise((x) => setTimeout(x, 2500));
      const btn = document.querySelector('.card [data-act="perm"]'); if (!btn) return { button: false }; btn.click();
      for (let i = 0; i < 20; i++) { await new Promise((x) => setTimeout(x, 300)); const now = sb.app.state.row(row.item.surfaceId); if (now && now.item.phase !== 'blocked') return { answered: true }; }
      return { answered: false };`);
    if (r.skipped) return 'no permission request in the demo right now';
    expect(r.button !== false, 'no permission buttons on the card');
    expect(r.answered, 'the agent was still blocked after answering');
  });
  await check('labels and chrome can’t be text-selected', async () => {
    const r = await page.run(`return ['.overlay', '.hud', '.minimap'].map((s) => getComputedStyle(document.querySelector(s)).userSelect).concat(getComputedStyle(document.querySelector('.card')).userSelect);`);
    expect(r.slice(0, 3).every((v) => v === 'none'), `user-select: ${r.join(', ')}`);
    expect(r[3] === 'text', 'the card text should stay selectable');
  });

  console.log('\nPhone');
  await check('a phone-sized screen boots and nothing overflows sideways', async () => {
    await page.load(demo, { width: 390, height: 844 });
    await sleep(3000);
    const r = await page.run(`const d = document.documentElement; const wide = [...document.querySelectorAll('.hud *, .panel *, .card *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1); }).slice(0, 4).map((e) => e.className || e.tagName);
      return { scroll: d.scrollWidth, width: d.clientWidth, wide };`);
    noErrors(page);
    expect(r.scroll <= r.width, `the page scrolls sideways (${r.scroll} > ${r.width})`);
    expect(!r.wide.length, `cut off at the edge: ${r.wide.join(', ')}`);
  });
  await check('on a phone the wordmark and toasts don’t sit under the top bar', async () => {
    const r = await page.run(`const sb = window.switchboard; sb.app.toasts.show({ tone: 'info', icon: 'check', text: 'Test toast' }); await new Promise((x) => setTimeout(x, 400));
      const box = (s) => { const e = document.querySelector(s); if (!e || e.offsetParent === null || getComputedStyle(e).display === 'none') return null; return e.getBoundingClientRect(); };
      const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const top = box('.topbar'); return { brand: hit(box('.brand'), top), toast: hit(box('.toast'), top) };`);
    expect(!r.brand, 'the wordmark is under the top bar');
    expect(!r.toast, 'the toast covers the top bar');
  });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 792, deviceScaleFactor: 2, mobile: false });

  console.log('\nSwarm (one session with 487 helpers, 178 sessions)');
  await check('budgets hold: tool icons, edge arrows, grouped toasts', async () => {
    await page.load(`http://localhost:${swarmPort}/`);
    const r = await page.run(`${SETUP} let pops = 0, edges = 0; const t0 = performance.now(); W.overview();
      while (performance.now() - t0 < 8000) { pops = Math.max(pops, document.querySelectorAll('.overlay .pop').length); edges = Math.max(edges, [...document.querySelectorAll('.edges .edge')].filter((e) => !e.hidden).length); await new Promise((x) => requestAnimationFrame(x)); }
      return { pops, edges, crew: !!document.querySelector('.agent__crew:not([hidden])'), toasts: document.querySelectorAll('.toast').length };`);
    expect(r.pops <= 12, `${r.pops} tool icons at once (budget 12)`);
    expect(r.edges <= 8, `${r.edges} edge arrows (budget 8)`);
    expect(r.toasts <= 3, `${r.toasts} toasts at once`);
    return `max ${r.pops} icons, ${r.edges} arrows, crew badge ${r.crew ? 'shown' : 'missing'}`;
  });

  console.log('\nOver time');
  await check('a minute of use leaves memory and labels flat', async () => {
    await page.load(demo);
    const r = await page.run(`${SETUP} const sample = () => ({ heap: performance.memory.usedJSHeapSize / 1e6, pins: W.overlay.root.children.length, tex: W.renderer.info.memory.textures });
      const rows = () => [...sb.app.state.rows.values()].filter((x) => x.item.spot !== null); await new Promise((x) => setTimeout(x, 3000)); const a = sample();
      for (let i = 0; i < 16; i++) { sb.app.selectAgent(rows()[i % rows().length].item.surfaceId); await new Promise((x) => setTimeout(x, 1200)); sb.app.state.openPanel(['agents', 'inbox', 'projects', null][i % 4]); await new Promise((x) => setTimeout(x, 400)); sb.app.state.openPanel(null); sb.app.state.select(null); W.overview(); await new Promise((x) => setTimeout(x, 1200)); }
      const b = sample(); return { a, b };`, 180_000);
    expect(r.b.pins <= r.a.pins + 4, `labels grew from ${r.a.pins} to ${r.b.pins}`);
    expect(r.b.tex <= r.a.tex + 4, `textures grew from ${r.a.tex} to ${r.b.tex}`);
    expect(r.b.heap - r.a.heap < 40, `memory grew ${Math.round(r.b.heap - r.a.heap)} MB`);
    return `memory ${Math.round(r.a.heap)} → ${Math.round(r.b.heap)} MB, labels ${r.a.pins} → ${r.b.pins}`;
  });

  page.ws.close();
  rmSync(profile, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 200));
