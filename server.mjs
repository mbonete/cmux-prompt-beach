#!/usr/bin/env node
// Switchboard: a local web dashboard for the agents running in cmux.
//
// This file is the HTTP side: security checks, the page and its static files, the SSE
// stream, the current snapshot and the world state (plots, spots, archive). Where the
// agents come from is a source in server/sources/: cmux plus Claude Code transcripts,
// or made-up sessions with --demo. Everything stays on this machine: the server listens
// on 127.0.0.1 only, and every write action goes through the source (cmux itself for
// the real one). Snapshot, tick and endpoint shapes: server/SNAPSHOT.md.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveStatic, sendStatic } from './server/static.mjs';
import { DEFAULT_WORLD_FILE, createWorld } from './server/world.mjs';
import { UUID_RE, parseLooseJSON } from './server/util.mjs';
import { createTickGate } from './server/budget.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// SWITCHBOARD_PUBLIC_DIR serves another build folder (the tests use it for fixtures).
const PUBLIC_DIR = process.env.SWITCHBOARD_PUBLIC_DIR ? path.resolve(process.env.SWITCHBOARD_PUBLIC_DIR) : path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4747;
const TOKEN = crypto.randomBytes(24).toString('hex');
const PERIODIC_REFRESH_MS = 5000;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
// Demo mode serves made-up sessions (server/sources/demo.mjs) and never touches cmux
// or the saved world state.
const DEMO = process.argv.includes('--demo') || process.env.SWITCHBOARD_DEMO === '1';

const source = DEMO
  ? (await import('./server/sources/demo.mjs')).createDemoSource({ swarm: process.argv.includes('--swarm') || process.env.SWITCHBOARD_SWARM === '1' })
  : (await import('./server/sources/cmux.mjs')).createCmuxSource();
// SWITCHBOARD_WORLD_FILE keeps the world state somewhere else (handy for trying things out).
const WORLD_FILE = process.env.SWITCHBOARD_WORLD_FILE ? path.resolve(process.env.SWITCHBOARD_WORLD_FILE) : DEFAULT_WORLD_FILE;
const world = createWorld(DEMO ? { initial: source.initialWorld?.() } : { file: WORLD_FILE });
await world.load();

// ---------------------------------------------------------------------------
// Refresh loop and live events

let rawSnapshot = null; // as the source returned it
let snapshot = null; // with the world fields added
let lastPayload = '';
let refreshing = false;
let dirty = false;
let refreshTimer = null;
let firstScheduledAt = 0;
let eventsLive = false;
const clients = new Set();

function scheduleRefresh(delay = 250) {
  const now = Date.now();
  if (!refreshTimer) firstScheduledAt = now;
  clearTimeout(refreshTimer);
  const wait = Math.max(0, Math.min(delay, firstScheduledAt + 1000 - now));
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, wait);
}

async function refresh() {
  if (refreshing) {
    dirty = true;
    return;
  }
  refreshing = true;
  try {
    const raw = await source.snapshot();
    rawSnapshot = raw;
    snapshot = { ...world.apply(raw), source: source.name };
  } catch (err) {
    snapshot = {
      ...(snapshot || { items: [], pulse: null, world: world.summary(), source: source.name }),
      generatedAt: new Date().toISOString(),
      cmux: { ok: false, error: String(err.message || err) },
    };
  } finally {
    refreshing = false;
  }
  publish();
  if (dirty) {
    dirty = false;
    scheduleRefresh();
  }
}

// After a world action: recompute the world fields on the last data and publish at once.
function reapplyWorld() {
  if (!rawSnapshot || !snapshot) return;
  snapshot = { ...world.apply(rawSnapshot), source: source.name, cmux: snapshot.cmux };
  publish();
}

function currentPayload() {
  return { ...snapshot, cmux: { ...snapshot.cmux, eventsLive } };
}

function publish(force = false) {
  if (!snapshot) return;
  const { generatedAt, ...comparable } = currentPayload();
  const key = JSON.stringify(comparable);
  if (!force && key === lastPayload) return;
  lastPayload = key;
  broadcast('snapshot', currentPayload());
}

const tickGate = createTickGate();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

// ---------------------------------------------------------------------------
// Actions

async function handleAction(body) {
  switch (body.action) {
    // World actions live here, not in the source: they only change Switchboard's own state.
    case 'archive':
      world.archive(body.sessionId);
      reapplyWorld();
      return { ok: true };
    case 'unarchive':
      world.unarchive(body.sessionId);
      reapplyWorld();
      return { ok: true };
    case 'movePlot':
      world.movePlot(body.repoKey, body.plot);
      reapplyWorld();
      return { ok: true };
    default:
      return source.act(body);
  }
}

// ---------------------------------------------------------------------------
// HTTP

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

const sendJSON = (res, status, data) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

// Browsers send Origin on cross-origin requests (and on every POST); when present it must be ours.
const originOk = (req) => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413, expose: true }));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Reject anything not addressed to this machine by name (blocks DNS rebinding).
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, 'text/plain', 'Misdirected request');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const isGet = req.method === 'GET' || req.method === 'HEAD';

    if (isGet && url.pathname === '/') {
      let html;
      try {
        html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return send(res, 503, 'text/plain; charset=utf-8', 'The Switchboard page has not been built yet (public/index.html is missing).');
        throw err;
      }
      return send(res, 200, 'text/html; charset=utf-8', html.replace('__SWITCHBOARD_TOKEN__', TOKEN));
    }

    if (url.pathname.startsWith('/api/')) {
      if (!originOk(req)) return sendJSON(res, 403, { error: 'Forbidden origin' });

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        if (url.searchParams.get('token') !== TOKEN) return send(res, 403, 'text/plain', 'Forbidden');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
        res.write('retry: 2000\n\n');
        clients.add(res);
        if (snapshot) res.write(`event: snapshot\ndata: ${JSON.stringify(currentPayload())}\n\n`);
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        return;
      }

      if (url.pathname === '/api/snapshot' && req.method === 'GET') {
        if (req.headers['x-switchboard-token'] !== TOKEN) return sendJSON(res, 403, { error: 'Forbidden' });
        return sendJSON(res, 200, snapshot ? currentPayload() : { ...world.apply(await source.snapshot()), source: source.name });
      }

      if (url.pathname === '/api/conversation' && req.method === 'GET') {
        if (req.headers['x-switchboard-token'] !== TOKEN) return sendJSON(res, 403, { error: 'Forbidden' });
        const surfaceId = url.searchParams.get('surfaceId') || '';
        if (!UUID_RE.test(surfaceId)) return sendJSON(res, 400, { error: 'Invalid surface' });
        const item = snapshot?.items?.find((i) => String(i.surfaceId).toLowerCase() === surfaceId.toLowerCase());
        if (!item?.agent) return sendJSON(res, 404, { error: 'There is no agent in that terminal.' });
        const conversation = (await source.conversation?.(item)) || null;
        return sendJSON(res, 200, {
          surfaceId: item.surfaceId,
          sessionId: item.agent.sessionId || null,
          available: Boolean(conversation),
          messages: conversation?.messages || [],
          truncated: Boolean(conversation?.truncated),
        });
      }

      if (url.pathname === '/api/action' && req.method === 'POST') {
        if (req.headers['x-switchboard-token'] !== TOKEN) return sendJSON(res, 403, { error: 'Forbidden' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJSON(res, 415, { error: 'Send JSON' });
        const body = parseLooseJSON(await readBody(req));
        if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Invalid JSON' });
        return sendJSON(res, 200, await handleAction(body));
      }

      return send(res, 404, 'text/plain', 'Not found');
    }

    if (isGet) {
      const found = await resolveStatic(PUBLIC_DIR, req.url);
      if (found) return sendStatic(req, res, found, SECURITY_HEADERS);
    }

    return send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    if (!res.headersSent) sendJSON(res, err.status || 500, { error: err.expose ? err.message : 'Something went wrong on the Switchboard server.' });
    if (!err.expose) console.error(err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with PORT=<other> npm start.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Switchboard is running at http://localhost:${PORT}${DEMO ? ' (demo mode: made-up sessions)' : ''}`);
  source.start({
    changed: (delay = 250) => scheduleRefresh(delay),
    // Tool-call ticks are decoration: under a swarm most are dropped (server/budget.mjs).
    tick: (event) => tickGate(event) && broadcast('tick', event),
    live: (isLive) => {
      eventsLive = isLive;
      publish(true);
    },
  });
  refresh();
  setInterval(() => scheduleRefresh(0), PERIODIC_REFRESH_MS);
});
