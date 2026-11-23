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
    const added = quality ? await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('promptBeach.quality', ${JSON.stringify(quality)}); } catch {}` }) : null;
    this.errors = [];
    await this.send('Page.navigate', { url });
    if (added?.result?.identifier) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.result.identifier });
    const until = Date.now() + BOOT_MS;
    while (Date.now() < until) {
      await sleep(1000);
      const state = await this.run(`return window.promptBeach?.world ? 'world' : document.getElementById('fatal')?.hidden === false ? 'fatal' : 'loading';`).catch(() => 'loading');
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
// (Kept lively: these checks measure motion. Calm mode has its own check.)
const SETUP = `const sb = window.promptBeach; const W = sb.world; const R = W.rig; W.director.enabled = false; W.setLiveMotion(true);`;
const AGENT = `[...sb.app.state.rows.values()].find((r) => r.item.spot !== null && typeof r.item.plot === 'number')`;

async function main() {
  const demoPort = await freePort();
  const swarmPort = await freePort();
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'prompt-beach-browser-'));
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
      const q = await page.run(`return window.promptBeach.world.status.quality;`);
      noErrors(page);
      return `quality ${q}`;
    });
  }

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
    const open = await page.run(`return { selected: window.promptBeach.app.state.selected, hidden: document.querySelector('.card').hidden };`);
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
    // The plot whose building the lens is inside right now (or null), and how faded it is.
    const insideOf = (c) => { for (const p of D.plots.values()) if (D.surfaceAt(p, c.x, c.z) > c.y) return p; return null; };
    const record = () => { const log = []; let on = true; const f = () => { if (!on) return; const c = R.camera.position, l = R.look; const inside = insideOf(c); log.push({ dist: R.current.distance, tilt: Math.asin((c.y - l.y) / c.distanceTo(l)) * 180 / Math.PI, above: c.y - trueH(c.x, c.z), inside: !!inside, fade: inside ? D.fade.array[inside.slot] : null }); requestAnimationFrame(f); }; requestAnimationFrame(f); return () => { on = false; return log; }; };
    const faded = (log) => { const ins = log.filter((f) => f.inside); return { frames: ins.length, worst: ins.length ? Math.min(...ins.map((f) => f.fade)) : 1, late: ins.filter((f) => f.fade < 0.5).length }; };
    const wheel = async (n, dy, x, y) => { for (let i = 0; i < n; i++) { canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true })); await wait(70); } };`;

  await check('zooming in toward a kiosk keeps the tilt', async () => {
    const r = await page.run(`${COLLIDE}
      const kiosk = [...D.plots.entries()].find(([, p]) => p.type === 'plot_juice_kiosk'); if (!kiosk) return { missing: true };
      // Its roof (the only part over 5 m), and a view across the plot toward it like the one it was reported from.
      const g = D.heights.get(kiosk[1].type).cells; let k = 0; for (let i = 0; i < g.length; i++) if (g[i] > g[k]) k = i;
      const roof = V().set((k % 12) * 2 - 11, g[k] - 0.5, Math.floor(k / 12) * 2 - 9).applyMatrix4(kiosk[1].world);
      R.flyTo({ target: V().set(roof.x + 4, 0, roof.z + 7), distance: 46, pitch: 48 * Math.PI / 180, yaw: 0.12 }, 0.01); await wait(800);
      const s = roof.clone().project(R.camera); const stop = record();
      await wheel(40, -40, rect.left + (s.x + 1) / 2 * rect.width, rect.top + (1 - s.y) / 2 * rect.height); await wait(1200); const log = stop();
      const t = log.map((f) => f.tilt); return { swing: Math.max(...t) - Math.min(...t), end: log.at(-1).dist, faded: faded(log) };`);
    expect(!r.missing, 'no juice kiosk in the city');
    expect(r.swing < 0.05, `the camera tilted ${r.swing.toFixed(1)}° on its own while zooming in`);
    expect(r.faded.late <= 1, `the lens was inside the kiosk for ${r.faded.late} frames before it faded`);
    return `tilt held within ${r.swing.toFixed(2)}°, zoomed to ${r.end.toFixed(1)} m${r.faded.frames ? `, kiosk faded while the lens was in it` : ''}`;
  });
  await check('zooming out through a tall building keeps the tilt; the building fades while the lens is in it', async () => {
    const r = await page.run(`${COLLIDE}
      let best = null; for (const [key, p] of D.plots) { const g = D.heights.get(p.type).cells; for (let k = 0; k < g.length; k++) if (!best || g[k] > best.h) best = { key, p, k, h: g[k] }; }
      const B = V().set((best.k % 12) * 2 - 11, 0, Math.floor(best.k / 12) * 2 - 9).applyMatrix4(best.p.world); const C = D.center(best.key);
      const away = V().set(C.x - B.x, 0, C.z - B.z).normalize(); const target = B.clone().addScaledVector(away, 14);
      R.flyTo({ target, distance: 8, pitch: 30 * Math.PI / 180, yaw: Math.atan2(B.x - target.x, B.z - target.z) }, 0.01); await wait(800);
      const stop = record(); await wheel(25, 40, rect.left + rect.width / 2, rect.top + rect.height / 2); await wait(1500); const log = stop();
      await wait(1500); const after = { fade: D.fade.array[best.p.slot], solid: !D.dissolving };
      const t = log.map((f) => f.tilt); return { height: best.h, to: log.at(-1).dist, swing: Math.max(...t) - Math.min(...t), faded: faded(log), after };`);
    expect(r.to > 20, `the zoom out stopped at ${r.to.toFixed(0)} m`);
    expect(r.swing < 0.05, `the camera tilted ${r.swing.toFixed(1)}° on its own while zooming out`);
    expect(r.faded.frames > 0, 'the lens never went inside the building (the test no longer covers the case)');
    expect(r.faded.late <= 1, `the lens was inside the building for ${r.faded.late} frames before it faded (least ${r.faded.worst.toFixed(2)})`);
    expect(r.after.fade === 0 && r.after.solid, `after the lens left, the building stayed faded (${r.after.fade}) or the dissolving materials stayed on`);
    return `${r.height.toFixed(0)} m building: tilt held within ${r.swing.toFixed(2)}°, faded for the ${r.faded.frames} frames the lens was inside, back after`;
  });
  await check('at every plot, the angle on screen is always the one you set (zooming in and out)', async () => {
    const r = await page.run(`${COLLIDE}
      let worst = 0; let where = ''; let late = 0; let insideFrames = 0;
      const keys = [...D.plots.keys()];
      for (let n = 0; n < keys.length; n++) {
        const C = D.center(keys[n]); const yaw = (n * 2.39996) % (Math.PI * 2); const pitch = (25 + (n % 5) * 9) * Math.PI / 180;
        R.flyTo({ target: V().set(C.x, 0, C.z), distance: 22, pitch, yaw }, 0.01); await wait(250);
        const stop = record(); const cx = rect.left + rect.width * (0.3 + (n % 3) * 0.2), cy = rect.top + rect.height * 0.55;
        await wheel(6, -40, cx, cy); await wheel(9, 40, cx, cy); await wait(400); const log = stop();
        const want = R.current.pitch * 180 / Math.PI; for (const f of log) { const d = Math.abs(f.tilt - want); if (d > worst) { worst = d; where = keys[n]; } }
        const fd = faded(log); late += fd.late; insideFrames += fd.frames;
      }
      return { worst, where, late, insideFrames, plots: keys.length };`);
    expect(r.worst < 0.05, `at plot ${r.where} the view tilted ${r.worst.toFixed(1)}° away from the angle set`);
    expect(r.late <= r.plots, `the lens was inside an unfaded building for ${r.late} frames`);
    return `${r.plots} plots: angle within ${r.worst.toFixed(3)}°; lens inside a building for ${r.insideFrames} frames, faded in all but ${r.late}`;
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

  // Buildings: a click on a wall or a roof is that building's (the ground behind it is another plot, or the street).
  const BUILDINGS = `const D = W.district; const V = () => R.desired.target.clone(); const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    const rect = W.canvas.getBoundingClientRect();
    const merged = []; D.group.traverse((o) => { if (o.isMesh && o.geometry?.getAttribute('aSlot')) merged.push(o); });
    const slotKey = new Map([...D.plots.values()].map((p) => [p.slot, p.key])); const ray = new R.ray.constructor();
    // The plot whose building really is under a screen point: every triangle, the slow way (80 ms).
    const exact = (ndc) => { ray.setFromCamera(ndc, R.camera); const h = ray.intersectObjects(merged, false)[0]; return h ? slotKey.get(Math.round(h.object.geometry.getAttribute('aSlot').getX(h.face.a))) : undefined; };
    const ndcAt = (x, y) => R.ndc({ clientX: x, clientY: y });
    const view = async (tx, tz, distance, pitch, yaw) => { R.flyTo({ target: V().set(tx, 0, tz), distance, pitch: pitch * Math.PI / 180, yaw }, 0.01); await wait(900); R.camera.updateMatrixWorld(); };
    let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);`;
  const click = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  await check('a click on a wall or a roof goes to that building, not the ground behind it', async () => {
    const r = await page.run(`${SETUP} ${BUILDINGS} sb.app.state.select(null);
      let n = 0, right = 0, ground = 0, ms = 0;
      for (const v of [[0, 30, 165, 50, 0], [-20, 10, 80, 40, 0.8], [0, 0, 60, 25, 2.4], [30, 20, 120, 25, 3.6]]) {
        await view(...v);
        for (let i = 0; i < 300; i++) {
          const ndc = ndcAt(rect.left + rnd() * rect.width, rect.top + rnd() * rect.height);
          const want = exact(ndc); if (want === undefined) continue;
          const t = performance.now(); const p = W.ndcToPick(ndc); ms += performance.now() - t;
          if (p?.kind === 'agent') continue;
          n++; if (p?.kind === 'plot' && p.key === want) right++;
          const g = R.groundAt(ndc); if (g && W.plotAt(g.x, g.z) === want) ground++;
        }
      }
      return { n, right, ground, ms: ms / Math.max(1, n) };`);
    expect(r.n > 300, `only ${r.n} points on buildings sampled`);
    expect(r.right / r.n >= 0.98, `${r.right}/${r.n} clicks on a building went to it`);
    return `${r.right}/${r.n} went to the building under the pointer (by the ground alone: ${r.ground}); ${r.ms.toFixed(2)} ms a pick`;
  });
  await check('pointing at a building shows the hand and lights its tag; a click flies there', async () => {
    const found = await page.run(`${SETUP} ${BUILDINGS} sb.app.state.select(null); await view(0, 0, 60, 25, 2.4);
      // A wall or roof of a building with a tag, where the ground under the pointer is somewhere else.
      for (let i = 0; i < 4000; i++) {
        const x = rect.left + rnd() * rect.width, y = rect.top + rnd() * rect.height; const ndc = ndcAt(x, y);
        const want = exact(ndc); if (want === undefined || !W.plotTags.has(want) || document.elementFromPoint(x, y) !== W.canvas) continue;
        const g = R.groundAt(ndc); if (g && W.plotAt(g.x, g.z) === want) continue;
        const p = W.ndcToPick(ndc); if (p?.kind !== 'plot' || p.key !== want) continue;
        return { x, y, key: want };
      }
      return null;`);
    expect(found, 'found no wall of a tagged building with the ground behind it elsewhere');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y });
    await sleep(400);
    const key = JSON.stringify(found.key);
    const hover = await page.run(`const W = window.promptBeach.world; return { hand: W.canvas.classList.contains('is-pointing'), hot: W.plotTags.get(${key})?.pin.el.classList.contains('tag--hot') };`);
    expect(hover.hand, 'no hand over the building');
    expect(hover.hot, 'its tag did not light up');
    await click(found.x, found.y);
    await sleep(2200);
    const after = await page.run(`const W = window.promptBeach.world; const R = W.rig; const c = W.district.center(${key}); return { off: Math.hypot(R.desired.target.x - c.x, R.desired.target.z - c.z), distance: R.desired.distance };`);
    expect(after.off < 0.5 && Math.abs(after.distance - 46) < 0.5, `the click did not fly to that building (${after.off.toFixed(1)} m off, at ${after.distance.toFixed(0)} m)`);
    return `plot ${found.key}`;
  });
  await check('a click on the building you are already looking at keeps the view (and closes the card)', async () => {
    const found = await page.run(`${SETUP} ${BUILDINGS} const row = ${AGENT}; sb.app.selectAgent(row.item.surfaceId); await wait(3500);
      const key = row.item.plot; if (!W.looksAt(key)) return { notLooking: key };
      for (let i = 0; i < 4000; i++) {
        const x = rect.left + rnd() * rect.width, y = rect.top + rnd() * rect.height; const ndc = ndcAt(x, y);
        if (document.elementFromPoint(x, y) !== W.canvas) continue;
        const p = W.ndcToPick(ndc); if (p?.kind !== 'plot' || p.key !== key || exact(ndc) !== key) continue;
        return { x, y, key };
      }
      return null;`);
    expect(found && found.notLooking === undefined, found ? `the close-up is not on the person's plot ${found.notLooking}` : 'found no point on their building');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y });
    await sleep(400);
    const before = await page.run(`const W = window.promptBeach.world; const p = W.rig.camera.position; return { pos: [p.x, p.y, p.z], hand: W.canvas.classList.contains('is-pointing') };`);
    expect(!before.hand, 'a hand over the building you are already at (clicking it does not go anywhere)');
    await click(found.x, found.y);
    await sleep(1500);
    const after = await page.run(`const sb = window.promptBeach; const p = sb.world.rig.camera.position; return { pos: [p.x, p.y, p.z], selected: sb.app.state.selected, card: !document.querySelector('.card').hidden };`);
    const moved = Math.hypot(...after.pos.map((v, i) => v - before.pos[i]));
    expect(!after.selected && !after.card, 'the card is still open');
    expect(moved < 0.05, `the camera moved ${moved.toFixed(2)} m`);
    return `camera moved ${moved.toFixed(3)} m, card closed`;
  });

  await check('zoomed all the way in on someone, their table, seat and counter stay whole', async () => {
    const r = await page.run(`${SETUP} const D = W.district; const wait = (ms) => new Promise((x) => setTimeout(x, ms));
      const rows = [...sb.app.state.rows.values()].filter((r) => r.item.spot !== null && r.item.plot !== null).slice(0, 12);
      let faded = 0, cut = 0; const bad = [];
      for (const row of rows) {
        sb.app.selectAgent(row.item.surfaceId); await wait(2500);
        for (let i = 0; i < 30; i++) { W.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true })); await wait(40); }
        await wait(1500);
        const p = D.plots.get(row.item.plot); const spot = D.spot(row.item.plot, row.item.spot);
        if (D.fade.array[p.slot] > 0) {
          faded++;
          // What dissolves stops short of them: everything within 1.5 m of where they are stays.
          const near = R.camera.position.distanceTo(spot.position) - 1.5;
          if (D.fadeReach.value > near) { cut++; bad.push(row.item.plot); }
        }
        sb.app.state.select(null); await wait(300);
      }
      return { n: rows.length, faded, cut, bad, dist: R.current.distance };`);
    expect(r.cut === 0, `around ${r.cut} of ${r.n} people (plots ${r.bad.join(', ')}) their furniture dissolved`);
    return `${r.n} people at full zoom: ${r.faded} with something faded near the lens, furniture whole around all`;
  });
  await check('someone who needs you stands up only where there is room', async () => {
    const r = await page.run(`${SETUP} const D = W.district; const V = () => R.camera.position.clone(); const cast = W.people.cast;
      // Every seat in the city: is there room where standing up from it lands?
      let seats = 0, room = 0;
      for (const p of D.plots.values()) for (const s of p.spots) {
        if (!s || s.kind === 'standing') continue;
        const ge = cast.clipInfo('m', s.kind === 'desk' || s.kind === 'stool' ? 'stand_up_table' : 'stand_up_chair').groundEnd;
        const at = V().set(ge.pos[0], 0, ge.pos[2]).applyQuaternion(s.quaternion).add(s.position);
        seats++; if (D.roomToStand(p.key, at.x, at.z, s.position.y)) room++;
      }
      let stood = 0, stayed = 0; const bad = [];
      for (const e of W.people.entries.values()) { if (e.person.spot.kind !== 'standing') e.person.setMood('ask', true); }
      for (const e of W.people.entries.values()) {
        const p = e.person; if (p.spot.kind === 'standing') continue;
        if (p.seated) { stayed++; continue; }
        stood++; const at = p.body.getWorldPosition(V());
        if (!D.roomToStand(e.plot, at.x, at.z, p.spot.position.y)) bad.push(p.spot.kind);
      }
      // Those who stayed seated wave from the waist up. Checked at once: the next data update puts everyone back in
      // their real mood. (Someone mid-yawn takes the change when the yawn ends.)
      const seatedAsk = [...W.people.entries.values()].map((e) => e.person).filter((p) => p.seated && p.spot.kind !== 'standing' && p.model && !p.busy);
      const still = seatedAsk.filter((p) => !(p.overlay?.isRunning() && p.overlay.getClip().tracks.some((t) => /UpperArm/.test(t.name)))).length;
      return { seats, room, stood, stayed, bad, waving: seatedAsk.length - still, still };`);
    expect(r.room > 0, 'no seat in the city has room to stand up from');
    expect(r.still === 0, `${r.still} seated people who need you never raised a hand`);
    expect(!r.bad.length, `${r.bad.length} stood up into furniture (${[...new Set(r.bad)].join(', ')})`);
    return `${r.room}/${r.seats} seats have room to stand up from; here ${r.stood} stood to wave, ${r.waving} waved from their seat`;
  });

  await check('a laptop or notes on the table in front of seated people, only while someone sits there', async () => {
    const r = await page.run(`${SETUP} const D = W.district; const M = D.deskModels;
      // Drawn: in the front part of its instance list (only those are drawn), at its own table.
      const shown = (item) => { if (item.slot < 0) return false; const mesh = item.kind === 'laptop' ? M.laptop.meshes[0] : M.notes; return item.slot < mesh.count; };
      const sitting = new Set([...W.people.entries.values()].map((x) => x.plot + ':' + x.spot));
      let laptops = 0, notes = 0, wrong = 0;
      for (const [key, item] of D.deskItems) { const on = shown(item); if (on !== sitting.has(key)) wrong++; else if (on) item.kind === 'laptop' ? laptops++ : notes++; }
      const drawn = M.laptop.meshes[0].count + M.notes.count;
      return { items: D.deskItems.size, laptops, notes, wrong, drawn };`);
    expect(r.items > 0, 'no table found in front of any seat');
    expect(r.wrong === 0, `${r.wrong} items shown at an empty seat, or missing where someone sits`);
    expect(r.drawn === r.laptops + r.notes, `${r.drawn} drawn for ${r.laptops + r.notes} in use`);
    return `${r.items} tables with a place for one; ${r.laptops} laptops and ${r.notes} notebooks in use`;
  });

  await check('left alone, the city stops drawing; input or a change brings it back', async () => {
    const r = await page.run(`${SETUP} W.setLiveMotion(false); const wait = (ms) => new Promise((x) => setTimeout(x, ms));
      let n = 0; const orig = W.onFrame; W.onFrame = (...a) => { n++; orig?.(...a); };
      const frames = async (ms) => { const a = n; await wait(ms); return n - a; };
      // A short calm delay; then wait for a calm second (the demo's own changes wake it now and then).
      W.calmAfterMs = 2000; W.awakeUntil = performance.now() + 2000;
      let calmSecond = null;
      const why = [];
      for (let i = 0; i < 20 && !calmSecond; i++) { const f = await frames(1000); if (W.calm && f <= 1) calmSecond = { f, paused: document.querySelector('.app').classList.contains('app--calm') }; else why.push(f + 'f left ' + Math.round(W.awakeUntil - performance.now()) + ' moving ' + R.moving + ' tour ' + W.director.running + ' busy ' + W.people.transitioning + ' live ' + W.liveMotion); }
      W.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, clientX: 400, clientY: 300, bubbles: true }));
      const afterInput = await frames(1000);
      // Calm again, then a camera flight with no input (a click in a list does this).
      W.awakeUntil = performance.now(); for (let i = 0; i < 40 && !W.calm; i++) await wait(100);
      const wasCalm = W.calm; const row = [...sb.app.state.rows.values()].find((x) => x.item.spot !== null); W.focusAgent(row.item.surfaceId);
      const afterFlight = await frames(1000);
      W.onFrame = orig; W.calmAfterMs = 45000; sb.app.state.select(null); W.setLiveMotion(true);
      return { calmSecond, afterInput, wasCalm, afterFlight, why: why.slice(-3) };`);
    expect(r.calmSecond, `never went calm: ${r.why.join(' | ')}`);
    expect(r.calmSecond.paused, 'calm, but the page animations kept running');
    expect(r.afterInput > 30, `input brought back only ${r.afterInput} frames a second`);
    expect(!r.wasCalm || r.afterFlight > 30, `a camera flight while calm drew only ${r.afterFlight} frames a second`);
    return `calm: ${r.calmSecond.f} frames in a second; input: ${r.afterInput}/s; flight: ${r.afterFlight}/s`;
  });

  console.log('\nInterface');
  await check('a list that reorders keeps the keyboard focus', async () => {
    const r = await page.run(`${SETUP} sb.app.state.openPanel('agents'); await new Promise((x) => setTimeout(x, 600));
      // The last row of "your move" (sorted by latest activity): give it the newest activity so it jumps to the top.
      // A data update from the demo can land in between and put the row back: then try again (up to 3 times).
      const order = () => [...document.querySelectorAll('.panel .group--move [data-pick]')].map((e) => e.dataset.pick);
      let pick, target, before, after;
      for (let attempt = 0; attempt < 3; attempt++) {
        const lane = sb.app.state.lane('move'); pick = lane[lane.length - 1].item.surfaceId;
        target = document.querySelector('.panel [data-pick="' + CSS.escape(pick) + '"]'); target.focus();
        before = order().indexOf(pick);
        const row = sb.app.state.row(pick); row.item.lastActivityAt = new Date().toISOString(); sb.app.state.emit(); await new Promise((x) => setTimeout(x, 300));
        after = order().indexOf(pick);
        if (after !== before) break;
      }
      const a = document.activeElement; const out = { moved: before !== after, before, after, same: a === target, pick: a?.dataset?.pick === pick, tag: a?.tagName };
      sb.app.state.openPanel(null); return out;`);
    expect(r.moved, `the row didn't move (position ${r.before})`);
    expect(r.pick, `focus moved to ${r.tag}`);
    return `row moved ${r.before} → ${r.after}; ${r.same ? 'same element kept' : 'focus restored'}`;
  });
  await check('a count in the top bar brings its group into view with room above it', async () => {
    const at = await page.run(`const sb = window.promptBeach; sb.app.state.openPanel('agents'); await new Promise((x) => setTimeout(x, 600));
      document.querySelector('.panel__body').scrollTop = 0;
      // A group in the middle of the list (the last can't scroll to the top).
      const lane = ['working', 'move', 'needs'].find((l) => document.querySelector('.panel__body .group--' + l) && document.querySelector('.tally__item--' + l));
      const r = document.querySelector('.tally__item--' + lane).getBoundingClientRect(); return { lane, x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1200);
    const r = await page.run(`const body = document.querySelector('.panel__body'); const t = body.querySelector('.group--${at.lane} .group__title');
      const gap = t.getBoundingClientRect().top - body.getBoundingClientRect().top; const atEnd = body.scrollTop >= body.scrollHeight - body.clientHeight - 1;
      const out = { gap, atEnd, doc: document.scrollingElement.scrollTop }; window.promptBeach.app.state.openPanel(null); return out;`);
    expect(r.doc === 0, 'the page itself scrolled');
    expect(r.atEnd || (r.gap >= 8 && r.gap <= 24), `the ${at.lane} title sits ${Math.round(r.gap)} px from the top of the list`);
    return `${at.lane}: title ${Math.round(r.gap)} px below the top of the list`;
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
    const r = await page.run(`const sb = window.promptBeach; sb.app.toasts.show({ tone: 'info', icon: 'check', text: 'Test toast' }); await new Promise((x) => setTimeout(x, 400));
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
      const rows = () => [...sb.app.state.rows.values()].filter((x) => x.item.spot !== null);
      // One round first: people out of view load their textures when first seen. The check is for growth after that.
      for (let round = 0; round < 2; round++) { if (round) var a = sample();
      for (let i = 0; i < 16; i++) { sb.app.selectAgent(rows()[i % rows().length].item.surfaceId); await new Promise((x) => setTimeout(x, 1200)); sb.app.state.openPanel(['agents', 'inbox', 'projects', null][i % 4]); await new Promise((x) => setTimeout(x, 400)); sb.app.state.openPanel(null); sb.app.state.select(null); W.overview(); await new Promise((x) => setTimeout(x, 1200)); }
      }
      const b = sample(); return { a, b };`, 240_000);
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
