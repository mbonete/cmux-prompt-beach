// Starts the real server in demo mode on a free port (4770 and up) against a fixture
// public/ folder, and talks to it over HTTP like the page does.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function freePort(from = 4770, to = 4799) {
  for (let port = from; port <= to; port += 1) {
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No free port between 4770 and 4799');
}

let port;
let child;
let tmp;
let token;

function request(method, rawPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const json = (r) => JSON.parse(r.body);
const api = (method, p, body, extra = {}) =>
  request(method, p, {
    headers: { 'X-Switchboard-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });

// Reads SSE frames until `done(frames)` says enough, or the timeout passes.
function readStream(p, done, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        req.destroy();
        return resolve({ status: res.statusCode, frames });
      }
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
        }
        if (done(frames)) {
          req.destroy();
          resolve({ status: 200, frames });
        }
      });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
    setTimeout(() => {
      req.destroy();
      resolve({ status: 0, frames });
    }, timeoutMs).unref();
  });
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sb-server-'));
  const pub = path.join(tmp, 'public');
  await mkdir(path.join(pub, 'build'), { recursive: true });
  await mkdir(path.join(pub, 'assets', 'models'), { recursive: true });
  await mkdir(path.join(pub, 'fonts'), { recursive: true });
  await writeFile(path.join(pub, 'index.html'), '<!doctype html><meta name="sb-token" content="__SWITCHBOARD_TOKEN__"><script type="module" src="/build/app-1a2b3c.js"></script>');
  await writeFile(path.join(pub, 'build', 'app-1a2b3c.js'), 'export const x = 1;\n');
  await writeFile(path.join(pub, 'build', 'app-1a2b3c.js.map'), '{}');
  await writeFile(path.join(pub, 'assets', 'models', 'plot.gltf'), '{"asset":{"version":"2.0"}}');
  await writeFile(path.join(pub, 'assets', 'models', 'plot.bin'), Buffer.alloc(64));
  await writeFile(path.join(pub, 'assets', '.secret.json'), '{}');
  await writeFile(path.join(pub, 'fonts', 'anton.woff2'), 'woff2');
  await writeFile(path.join(pub, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(tmp, 'outside.png'), 'outside');
  await symlink(path.join(tmp, 'outside.png'), path.join(pub, 'assets', 'escape.png'));

  port = await freePort();
  child = spawn(process.execPath, ['server.mjs', '--demo'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SWITCHBOARD_PUBLIC_DIR: pub, SWITCHBOARD_WORLD_FILE: path.join(tmp, 'state', 'world.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${out}`)), 10000);
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('Switchboard is running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => reject(new Error(`Server exited (${code}): ${out}`)));
  });
  const page = await request('GET', '/');
  token = /content="([0-9a-f]+)"/.exec(page.body)?.[1];
});

after(async () => {
  child?.kill();
  await rm(tmp, { recursive: true, force: true });
});

describe('the page', () => {
  test('/ has the token filled in and is never cached', async () => {
    const r = await request('GET', '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    // No other page may frame it (clickjacking a click on Allow).
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.ok(!r.body.includes('__SWITCHBOARD_TOKEN__'));
    const head = await request('HEAD', '/');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });

  test('requests for another host are refused (DNS rebinding)', async () => {
    for (const host of ['evil.example', `127.0.0.1:${port + 1}`, `localhost.evil.example:${port}`]) {
      const r = await request('GET', '/', { headers: { Host: host } });
      assert.equal(r.status, 421, host);
    }
    // No Host header at all (HTTP/1.0; Node's client always adds one, so use a raw socket).
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.end('GET / HTTP/1.0\r\n\r\n'));
      let out = '';
      socket.on('data', (c) => (out += c));
      socket.on('end', () => resolve(Number(/^HTTP\/1\.[01] (\d+)/.exec(out)?.[1])));
      socket.on('error', reject);
    });
    assert.equal(status, 421);
  });
});

describe('static files over HTTP', () => {
  test('MIME, cache, nosniff, ETag and HEAD', async () => {
    const js = await request('GET', '/build/app-1a2b3c.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(js.headers['x-content-type-options'], 'nosniff');
    assert.equal(js.headers['content-security-policy'], CSP);
    assert.equal(js.body, 'export const x = 1;\n');
    assert.ok(js.headers.etag);

    const again = await request('GET', '/build/app-1a2b3c.js', { headers: { 'If-None-Match': js.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.body, '');
    assert.equal(again.headers.etag, js.headers.etag);

    const head = await request('HEAD', '/build/app-1a2b3c.js');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '20');
    assert.equal(head.body, '');

    const gltf = await request('GET', '/assets/models/plot.gltf');
    assert.equal(gltf.headers['content-type'], 'model/gltf+json');
    assert.equal(gltf.headers['cache-control'], 'no-cache');
    // The client adds ?rev= to asset URLs; the same file is served.
    assert.equal((await request('GET', '/assets/models/plot.gltf?rev=2')).status, 200);
    const bin = await request('GET', '/assets/models/plot.bin');
    assert.equal(bin.headers['content-type'], 'application/octet-stream');
    assert.equal(bin.headers['content-length'], '64');
    const font = await request('GET', '/fonts/anton.woff2');
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal(font.headers['cache-control'], 'no-cache');
    const icon = await request('GET', '/favicon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/svg+xml');
    assert.equal(icon.headers['cache-control'], 'no-cache');
  });

  test('traversal, symlink escape, dotfiles, directories and other extensions are 404s', async () => {
    const paths = [
      '/build/../index.html',
      '/build/../../server.mjs',
      '/assets/..%2f..%2fserver.mjs',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/assets/%252e%252e/x.png',
      '/assets/..\\..\\server.mjs',
      '/build/app-1a2b3c.js%00.png',
      '/assets/escape.png',
      '/assets/.secret.json',
      '/.git/config',
      '/build/',
      '/assets',
      '/assets/models/',
      '/index.html',
      '/build/app-1a2b3c.js.map',
      '/server.mjs',
      '/package.json',
    ];
    for (const p of paths) {
      const r = await request('GET', p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('outside') && !r.body.includes('__SWITCHBOARD'), p);
    }
    assert.equal((await request('POST', '/build/app-1a2b3c.js')).status, 404);
  });
});

describe('API', () => {
  test('the stream sends a snapshot with the world fields, then tool ticks', async () => {
    assert.equal((await readStream('/api/stream?token=nope', () => true)).status, 403);
    const { status, frames } = await readStream(`/api/stream?token=${token}`, (f) => f.some((x) => x.event === 'snapshot') && f.some((x) => x.event === 'tick' && x.data.tool));
    assert.equal(status, 200);
    const snap = frames.find((f) => f.event === 'snapshot').data;
    assert.equal(snap.demo, true);
    assert.equal(snap.source, 'demo');
    assert.equal(snap.cmux.ok, true);
    assert.equal(snap.cmux.eventsLive, true);
    assert.equal(snap.world.plotCount, 32);
    assert.ok(snap.items.length >= 24);
    for (const it of snap.items) {
      assert.ok('plot' in it && 'spot' in it && 'archived' in it, it.title);
      if (it.repo) assert.ok(['web', 'mobile', 'docs', 'data', 'other'].includes(it.repo.kind), it.title);
    }
    const agents = snap.items.filter((i) => i.agent);
    assert.deepEqual(new Set(agents.filter((i) => i.repo).map((i) => i.repo.kind)), new Set(['web', 'mobile', 'docs', 'data', 'other']));
    assert.equal(agents.filter((i) => i.plot === 'hangout').length, 2);
    const perPlot = new Map();
    for (const i of agents) perPlot.set(i.plot, (perPlot.get(i.plot) || 0) + 1);
    assert.ok([...perPlot.values()].some((n) => n >= 7), 'one plot shows "+N"');
    assert.ok(agents.some((i) => i.spot === null && Number.isInteger(i.plot)));
    assert.deepEqual(new Set(snap.items.map((i) => i.phase)), new Set(['blocked', 'working', 'idle', 'shell']));
    assert.deepEqual(new Set(snap.items.filter((i) => i.blocked).map((i) => i.blocked.kind)), new Set(['permission', 'question', 'plan', 'terminal']));
    assert.ok(snap.items.some((i) => i.phase === 'idle' && i.unread > 0), 'an unread result');
    assert.ok(snap.items.some((i) => i.question), 'a trailing question');
    assert.ok(snap.items.some((i) => Date.now() - Date.parse(i.lastActivityAt) > 2 * 24 * 3600 * 1000), 'a stale one');
    assert.ok(Object.values(snap.world.plots).some((p) => !p.active && p.lastSeen), 'a dormant plot');
    const tick = frames.find((f) => f.event === 'tick' && f.data.tool).data;
    assert.ok(snap.items.some((i) => i.surfaceId === tick.surfaceId));
    assert.equal(tick.hook, 'PreToolUse');
    assert.ok(['edit', 'command', 'search', 'web', 'read', 'other'].includes(tick.tool.category));
  });

  test('conversation: token, origin and surface checks, then the turns', async () => {
    const snap = json(await api('GET', '/api/snapshot'));
    const item = snap.items.find((i) => i.agent && i.phase === 'idle' && i.reply);
    const shell = snap.items.find((i) => !i.agent);
    const p = `/api/conversation?surfaceId=${item.surfaceId}`;
    assert.equal((await request('GET', p)).status, 403, 'no token');
    assert.equal((await api('GET', p, null, { Origin: 'http://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await api('GET', p, null, { Origin: `http://localhost:${port}` })).status, 200, 'own origin');
    assert.equal((await api('GET', '/api/conversation?surfaceId=../../etc')).status, 400);
    assert.equal((await api('GET', '/api/conversation?surfaceId=00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await api('GET', `/api/conversation?surfaceId=${shell.surfaceId}`)).status, 404);
    const r = await api('GET', p);
    assert.equal(r.headers['cache-control'], 'no-store');
    const c = json(r);
    assert.equal(c.surfaceId, item.surfaceId);
    assert.equal(c.sessionId, item.agent.sessionId);
    assert.equal(c.available, true);
    assert.equal(c.truncated, false);
    assert.equal(c.messages.at(-1).role, 'assistant');
    assert.equal(c.messages.at(-1).text, item.reply.text);
    assert.ok(c.messages.some((m) => m.role === 'user' && m.text === item.lastPrompt));
  });

  test('actions keep their checks; archive and movePlot work in the demo', async () => {
    const snap = json(await api('GET', '/api/snapshot'));
    const idle = snap.items.find((i) => i.agent && i.phase === 'idle' && !i.unread && !i.question && Number.isInteger(i.spot));
    const blocked = snap.items.find((i) => i.phase === 'blocked');
    const body = { action: 'archive', sessionId: idle.agent.sessionId };

    assert.equal((await request('POST', '/api/action', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403, 'no token');
    assert.equal((await api('POST', '/api/action', body, { Origin: 'http://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await api('POST', '/api/action', null, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await api('POST', '/api/action', { action: 'nope' })).status, 400);
    assert.equal((await api('POST', '/api/action', { action: 'archive', sessionId: '../x' })).status, 400);

    let r = await api('POST', '/api/action', body, { Origin: `http://127.0.0.1:${port}` });
    assert.equal(r.status, 200, r.body);
    assert.equal((await api('POST', '/api/action', { action: 'archive', sessionId: blocked.agent.sessionId })).status, 200);
    let now = json(await api('GET', '/api/snapshot'));
    const find = (s, id) => s.items.find((i) => i.surfaceId === id);
    assert.equal(find(now, idle.surfaceId).archived, true);
    assert.equal(find(now, idle.surfaceId).spot, null);
    assert.equal(find(now, blocked.surfaceId).archived, false, 'it needs you, so it stays');
    assert.ok(now.world.archived.some((a) => a.sessionId === idle.agent.sessionId));
    assert.equal((await api('POST', '/api/action', { action: 'unarchive', sessionId: idle.agent.sessionId })).status, 200);
    assert.equal((await api('POST', '/api/action', { action: 'unarchive', sessionId: blocked.agent.sessionId })).status, 200);
    now = json(await api('GET', '/api/snapshot'));
    assert.equal(find(now, idle.surfaceId).archived, false);

    const repoKey = idle.repo?.key || snap.items.find((i) => i.repo && i.agent).repo.key;
    const taken = snap.items.find((i) => i.agent && Number.isInteger(i.plot) && i.repo.key !== repoKey).plot;
    r = await api('POST', '/api/action', { action: 'movePlot', repoKey, plot: taken });
    assert.equal(r.status, 409);
    assert.equal((await api('POST', '/api/action', { action: 'movePlot', repoKey, plot: 99 })).status, 400);
    const free = now.world.free[0];
    assert.equal((await api('POST', '/api/action', { action: 'movePlot', repoKey, plot: free })).status, 200);
    now = json(await api('GET', '/api/snapshot'));
    assert.equal(now.world.plots[repoKey].plot, free);

    // The existing actions still answer as before in the demo.
    assert.equal((await api('POST', '/api/action', { action: 'reply', surfaceId: blocked.surfaceId, text: 'hi' })).status, 409);
    assert.equal(json(await api('POST', '/api/action', { action: 'jump', surfaceId: idle.surfaceId })).ok, true);
    assert.equal(json(await api('POST', '/api/action', { action: 'markRead', workspaceId: idle.workspaceId })).ok, true);
    assert.equal((await api('POST', '/api/action', { action: 'permission', mode: 'once' })).status, 410, 'no request id matches nothing');
  });

  test('the demo never writes the world file', async () => {
    await assert.rejects(stat(path.join(tmp, 'state', 'world.json')), { code: 'ENOENT' });
  });
});
