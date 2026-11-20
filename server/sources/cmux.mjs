// The cmux source: terminals, agents and decisions from the cmux CLI and RPC, plus
// Claude Code transcripts. Moved from server.mjs; the logic is unchanged apart from
// repo.kind, the tool on tick events and the conversation reader.
//
// Reads cmux state through the cmux CLI (current, workspace.list, feed.list,
// notification.list, list-status, events) and Claude Code transcripts from
// ~/.claude/projects. Every write action goes through cmux itself.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRepoKindCache } from '../repo-kind.mjs';
import { tickTool } from '../tools.mjs';
import { UUID_RE, clip, fail, latestIso, parseLooseJSON, requireUuid } from '../util.mjs';
import {
  describeTool,
  isHumanText,
  prettyModel,
  prettyToolName,
  readConversation,
  readTranscript,
  trailingQuestion,
} from './claude-transcripts.mjs';

const BUNDLED_CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX = process.env.CMUX_BIN || (existsSync(BUNDLED_CMUX) ? BUNDLED_CMUX : 'cmux');

const ACTIVITY_WINDOW_MS = 3 * 60 * 60 * 1000;
const ACTIVITY_BINS = 36;
// cmux parks a Feed decision for at most ~120 s, then the agent falls back to its own prompt.
const FEED_DECISION_TTL_MS = 120 * 1000;

// Hooks that carry the tool of a tool call. (cmux hooks PreToolUse for every tool and
// PostToolUse only for PushNotification; PermissionRequest repeats a PreToolUse's tool.)
const TOOL_HOOKS = new Set(['PreToolUse', 'PostToolUse']);

// ---------------------------------------------------------------------------
// cmux bridge

function cmux(args, { input, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(CMUX, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).trim().replace(/^Error:\s*/, '');
        reject(Object.assign(new Error(detail || err.message), { status: 502, expose: true }));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.end(input ?? '');
  });
}

const cmuxJSON = async (args) => JSON.parse(await cmux(args));
const rpc = (method, params = {}) => cmuxJSON(['rpc', method, JSON.stringify(params)]);

// `cmux list-status` prints lines like:
//   claude_code=Running icon=bolt.fill color=#4C8DFF work=running
//   program_status=claude-code · Start the dev server icon=bolt.fill priority=2
function parseStatusLines(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([\w.-]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const rest = m[2];
    const attrAt = rest.search(/\s(?:icon|color|work|priority|url|format)=/);
    const value = (attrAt === -1 ? rest : rest.slice(0, attrAt)).trim();
    const attrs = {};
    if (attrAt !== -1) for (const a of rest.slice(attrAt).matchAll(/(\w+)=(\S+)/g)) attrs[a[1]] = a[2];
    out[m[1]] = { value, ...attrs };
  }
  return out;
}

// Feed workstream ids look like "cmux-feed-v1:<base64 agent>:<base64 session id>".
function sessionFromWorkstream(id) {
  const m = /^cmux-feed-v1:([^:]+):(.+)$/.exec(id || '');
  if (!m) return null;
  try {
    return Buffer.from(m[2], 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function normalizePorts(ports) {
  if (!Array.isArray(ports)) return [];
  return [...new Set(ports.map((p) => Number(typeof p === 'object' ? p?.port : p)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Snapshot

function pickAgent(agents = []) {
  const byRecent = [...agents].sort((a, b) => (Date.parse(b.last_activity_at) || 0) - (Date.parse(a.last_activity_at) || 0));
  return { live: byRecent.find((a) => a.state !== 'ended') || null, ended: byRecent.find((a) => a.state === 'ended') || null };
}

function isOpenDecision(item, now) {
  if (!/permission|question|plan/i.test(item.kind || '')) return false;
  if (item.resolved_at) return false;
  if (['expired', 'telemetry', 'resolved', 'answered', 'completed', 'cancelled', 'timeout', 'timed_out'].includes(item.status)) return false;
  const created = Date.parse(item.created_at);
  return Number.isFinite(created) && now - created < FEED_DECISION_TTL_MS;
}

function describeDecision(feedItem, tx) {
  const kind = /question/i.test(feedItem.kind) ? 'question' : /plan/i.test(feedItem.kind) ? 'plan' : 'permission';
  const created = Date.parse(feedItem.created_at);
  const base = {
    kind,
    requestId: UUID_RE.test(feedItem.request_id || '') ? feedItem.request_id : null,
    since: feedItem.created_at,
    deadline: Number.isFinite(created) ? new Date(created + FEED_DECISION_TTL_MS).toISOString() : null,
  };
  if (kind === 'question') {
    return { ...base, questions: tx?.pendingQuestion || [{ header: null, question: feedItem.question_prompt || feedItem.title || 'Question', multiSelect: Boolean(feedItem.question_multi_select), options: [] }] };
  }
  if (kind === 'plan') return { ...base, plan: tx?.pendingPlan || null };
  // Prefer the transcript's copy of the tool call: the Feed copy has paths redacted.
  const toolName = feedItem.tool_name || feedItem.title;
  const fromTx = tx?.currentTool && tx.currentTool.name === prettyToolName(toolName) ? tx.currentTool : null;
  return { ...base, tool: fromTx || describeTool(toolName, parseLooseJSON(feedItem.tool_input) || {}) };
}

// A project is a git repository: worktrees and subfolders join their repo through the
// shared git dir. Sessions outside any repo get null and share one "hangout" lot.
const REPO_TTL_MS = 60 * 1000;
const repoCache = new Map(); // cwd -> { at, promise }
const repoKind = createRepoKindCache();

function repoOf(cwd) {
  if (!cwd) return Promise.resolve(null);
  const hit = repoCache.get(cwd);
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.promise;
  const promise = new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const dir = path.resolve(cwd, String(stdout).trim());
      const top = path.basename(dir) === '.git' ? path.dirname(dir) : dir.replace(/\.git$/, '');
      // The kind is read from the main worktree's root, so every worktree of a repo agrees.
      repoKind(top).then((kind) => resolve({ key: dir, name: path.basename(top), kind }));
    });
  });
  repoCache.set(cwd, { at: Date.now(), promise });
  return promise;
}

async function buildSnapshot() {
  const now = Date.now();
  const [current, wsList, feed, notes] = await Promise.all([
    cmuxJSON(['current', '--json', '--limit', '200']),
    rpc('workspace.list').catch(() => ({ workspaces: [] })),
    rpc('feed.list').catch(() => ({ items: [] })),
    rpc('notification.list').catch(() => ({ notifications: [] })),
  ]);

  const workspaces = new Map((wsList.workspaces || []).map((w) => [w.id, w]));
  const terminals = (current.items || []).filter((it) => it.kind === 'terminal' && it.projections?.[0]?.panel_id);
  const wsIds = [...new Set(terminals.map((t) => t.projections[0].workspace_id).filter(Boolean))];
  const statuses = new Map(
    await Promise.all(wsIds.map(async (id) => [id, parseStatusLines(await cmux(['list-status', '--workspace', id]).catch(() => ''))])),
  );

  // Feed: open decisions, activity histogram, last stop message per session.
  const windowStart = now - ACTIVITY_WINDOW_MS;
  const binMs = ACTIVITY_WINDOW_MS / ACTIVITY_BINS;
  const pulse = new Array(ACTIVITY_BINS).fill(0);
  const activity = new Map();
  const decisions = new Map();
  const lastStop = new Map();
  for (const it of feed.items || []) {
    const sessionId = sessionFromWorkstream(it.workstream_id);
    if (!sessionId) continue;
    const t = Date.parse(it.created_at);
    if (it.kind === 'toolUse' && t >= windowStart && t <= now) {
      const bin = Math.min(ACTIVITY_BINS - 1, Math.floor((t - windowStart) / binMs));
      if (!activity.has(sessionId)) activity.set(sessionId, new Array(ACTIVITY_BINS).fill(0));
      activity.get(sessionId)[bin] += 1;
      pulse[bin] += 1;
    } else if (it.kind === 'stop' && it.reason) {
      lastStop.set(sessionId, { text: it.reason, at: it.created_at });
    }
    if (isOpenDecision(it, now)) decisions.set(sessionId, it);
  }

  const unread = new Map();
  for (const n of notes.notifications || []) {
    if (n.is_read || !n.surface_id) continue;
    unread.set(n.surface_id, (unread.get(n.surface_id) || 0) + 1);
  }

  const items = await Promise.all(
    terminals.map(async (t) => {
      const proj = t.projections[0];
      const ws = workspaces.get(proj.workspace_id) || {};
      const { live: agent, ended } = pickAgent(t.agents);
      const st = statuses.get(proj.workspace_id) || {};
      const agentStatus = st.claude_code || st.codex || Object.values(st).find((v) => v.work) || null;
      let programStatus = st.program_status?.value?.replace(/^[\w-]+\s*·\s*/, '') || null;
      if (/^(working|running|idle|waiting|thinking)$/i.test(programStatus || '')) programStatus = null;
      const tx = agent?.kind === 'claude' ? await readTranscript(agent.session_id).catch(() => null) : null;
      const feedDecision = agent ? decisions.get(agent.session_id) : null;

      let phase = 'shell';
      let blocked = null;
      if (agent) {
        if (feedDecision) {
          phase = 'blocked';
          blocked = describeDecision(feedDecision, tx);
        } else if (tx?.pendingQuestion) {
          phase = 'blocked';
          blocked = { kind: 'question', requestId: null, since: tx.lastAssistantAt, questions: tx.pendingQuestion };
        } else if (tx?.pendingPlan) {
          phase = 'blocked';
          blocked = { kind: 'plan', requestId: null, since: tx.lastAssistantAt, plan: tx.pendingPlan };
        } else if (/permission|needs input|approval/i.test(agentStatus?.value || '')) {
          phase = 'blocked';
          blocked = { kind: 'terminal', requestId: null, since: agent.last_activity_at, label: agentStatus.value, tool: tx?.currentTool || null };
        } else if (agent.state === 'working' || agentStatus?.work === 'running') {
          phase = 'working';
        } else {
          phase = 'idle';
        }
      }

      // The transcript knows which prompts a person typed; cmux's workspace copy also counts
      // injected ones (background-task notices), so it is only the fallback.
      const wsPrompt = isHumanText(ws.latest_submitted_message) ? ws.latest_submitted_message : null;
      const lastPromptAt = tx?.lastUserAt || (wsPrompt ? ws.latest_submitted_at : null) || null;
      const lastPrompt = tx?.lastUserAt ? tx.lastPrompt : wsPrompt;
      const reply = tx?.lastText ? { text: clip(tx.lastText, 24000), at: tx.lastTextAt } : agent ? lastStop.get(agent.session_id) || null : null;
      const replyIsCurrent = reply && (!lastPromptAt || Date.parse(reply.at) >= Date.parse(lastPromptAt));
      const recapIsCurrent = tx?.recap && (!lastPromptAt || Date.parse(tx.recapAt) >= Date.parse(lastPromptAt));
      const cwd = tx?.cwd || t.cwd || ws.current_directory || null;

      return {
        surfaceId: proj.panel_id,
        workspaceId: proj.workspace_id,
        workspaceRef: ws.ref || null,
        order: Number.isInteger(ws.index) ? ws.index : 999,
        title: ws.title || t.label || 'Terminal',
        subtitle: t.label && ws.title && t.label !== ws.title ? t.label : null,
        here: Boolean(ws.selected),
        cwd,
        project: cwd ? path.basename(cwd) : null,
        repo: await repoOf(cwd),
        branch: tx?.branch && tx.branch !== 'HEAD' ? tx.branch : null,
        ports: normalizePorts(ws.listening_ports),
        agent: agent ? { kind: agent.kind, sessionId: agent.session_id, state: agent.state } : null,
        phase,
        blocked,
        statusLabel: agentStatus?.value || null,
        model: prettyModel(tx?.model),
        mode: tx?.mode || null,
        contextTokens: tx?.contextTokens ?? null,
        lastPrompt: lastPrompt ? clip(lastPrompt, 600) : null,
        lastPromptAt,
        reply: replyIsCurrent ? reply : null,
        recap: recapIsCurrent ? { text: tx.recap, at: tx.recapAt } : null,
        question: phase === 'idle' && replyIsCurrent ? trailingQuestion(reply.text) : null,
        now: phase === 'working' ? tx?.currentTool || (programStatus ? { name: null, detail: programStatus } : null) : null,
        turnStartedAt: phase === 'working' ? lastPromptAt : null,
        // cmux bumps last_activity_at when it restores sessions after a restart, so a
        // transcript's own timestamps are the better signal for "when did work last happen".
        lastActivityAt:
          tx?.lastAssistantAt || tx?.lastUserAt
            ? latestIso(tx.lastAssistantAt, tx.lastUserAt, phase === 'working' || phase === 'blocked' ? agent?.last_activity_at : null)
            : latestIso(agent?.last_activity_at, ended?.last_activity_at),
        unread: unread.get(proj.panel_id) || 0,
        activity: agent ? activity.get(agent.session_id) || null : null,
      };
    }),
  );

  return {
    generatedAt: new Date(now).toISOString(),
    cmux: { ok: true },
    items,
    pulse: { start: new Date(windowStart).toISOString(), binMs, bins: pulse },
  };
}

// ---------------------------------------------------------------------------
// Live events

// The tick for an `agent.hook.*` event from `cmux events`, or null. The payload carries
// `tool_name` (tool_input is redacted) on PreToolUse, e.g.
//   { hook_event_name: 'PreToolUse', tool_name: 'Bash', surface_id: '…', … }
export function hookTick(e) {
  const p = e.payload || {};
  const surfaceId = p.surface_id || e.surface_id;
  if (!surfaceId) return null;
  const hook = p.hook_event_name || String(e.name || '').slice('agent.hook.'.length);
  const tool = TOOL_HOOKS.has(hook) ? tickTool(p.tool_name) : null;
  return tool ? { surfaceId, hook, tool } : { surfaceId, hook };
}

export function createCmuxSource() {
  let changed = () => {};
  let tick = () => {};
  let live = () => {};
  let eventsLive = false;
  const seenHookRequests = new Map();

  function onEvent(e) {
    if (e.type !== 'event') return;
    const name = e.name || '';
    if (name.startsWith('agent.hook.')) {
      const p = e.payload || {};
      const requestKey = p._opencode_request_id || e.id;
      if (!seenHookRequests.has(requestKey)) {
        seenHookRequests.set(requestKey, Date.now());
        const event = hookTick(e);
        if (event) tick(event);
      }
      if (seenHookRequests.size > 2000) {
        const cutoff = Date.now() - 60000;
        for (const [k, t] of seenHookRequests) if (t < cutoff) seenHookRequests.delete(k);
      }
    }
    if (['agent', 'feed', 'notification', 'workspace', 'sidebar', 'terminal', 'surface'].includes(e.category)) changed();
  }

  function startEvents() {
    const child = spawn(CMUX, ['events', '--reconnect', '--no-heartbeat', '--no-ack'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!eventsLive) {
        eventsLive = true;
        live(true);
      }
      try {
        onEvent(JSON.parse(line));
      } catch {
        // Ignore malformed frames.
      }
    });
    child.on('error', () => {});
    child.on('exit', () => {
      eventsLive = false;
      live(false);
      setTimeout(startEvents, 3000);
    });
  }

  // -------------------------------------------------------------------------
  // Actions

  async function act(body) {
    switch (body.action) {
      case 'jump': {
        const ws = requireUuid(body.workspaceId, 'workspace');
        const surface = requireUuid(body.surfaceId, 'surface');
        await cmux(['select-workspace', '--workspace', ws]);
        await cmux(['focus-panel', '--panel', surface, '--workspace', ws]).catch(() => {});
        await new Promise((resolve) => execFile('open', ['-a', 'cmux'], () => resolve()));
        return { ok: true };
      }
      case 'reply': {
        const ws = requireUuid(body.workspaceId, 'workspace');
        const surface = requireUuid(body.surfaceId, 'surface');
        const text = String(body.text ?? '').replace(/\r\n?/g, '\n').trim();
        if (!text) throw fail(400, 'Write a reply first.');
        if (text.length > 8000) throw fail(400, 'That reply is too long for a quick reply. Open the terminal instead.');
        if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw fail(400, 'The reply contains control characters.');
        // Re-check against live state: only type into an idle agent whose prompt box is empty.
        const fresh = await buildSnapshot();
        const item = fresh.items.find((i) => i.surfaceId === surface);
        if (!item?.agent) throw fail(409, 'There is no agent running in that terminal.');
        if (item.phase !== 'idle') throw fail(409, `The agent is ${item.phase === 'blocked' ? 'waiting on a decision' : 'working'} right now. Open it in cmux instead.`);
        const input = await rpc('surface.input_state', { surface_id: surface });
        if (!input.agent || input.blocks_typing || input.state !== 'empty') {
          throw fail(409, 'The prompt box in that terminal is not empty. Open it in cmux so your draft is not mixed in.');
        }
        await cmux(['paste', '--workspace', ws, '--surface', surface, '--submit', '-'], { input: text });
        changed(100);
        return { ok: true };
      }
      case 'permission': {
        const requestId = requireUuid(body.requestId, 'request');
        if (!['once', 'always', 'deny'].includes(body.mode)) throw fail(400, 'Unknown permission choice');
        await rpc('feed.permission.reply', { request_id: requestId, mode: body.mode });
        changed(100);
        return { ok: true };
      }
      case 'plan': {
        const requestId = requireUuid(body.requestId, 'request');
        if (!['manual', 'autoAccept', 'deny'].includes(body.mode)) throw fail(400, 'Unknown plan choice');
        await rpc('feed.exit_plan.reply', { request_id: requestId, mode: body.mode });
        changed(100);
        return { ok: true };
      }
      case 'question': {
        const requestId = requireUuid(body.requestId, 'request');
        const selections = Array.isArray(body.selections) ? body.selections.map((s) => String(s).slice(0, 500)).slice(0, 16) : [];
        if (!selections.length) throw fail(400, 'Pick an answer first.');
        await rpc('feed.question.reply', { request_id: requestId, selections });
        changed(100);
        return { ok: true };
      }
      case 'markRead': {
        const ws = requireUuid(body.workspaceId, 'workspace');
        await cmux(['mark-notification-read', '--workspace', ws]);
        changed(100);
        return { ok: true };
      }
      default:
        throw fail(400, 'Unknown action');
    }
  }

  return {
    name: 'cmux',
    // changed(delay?): something changed, refresh soon. tick(event): a hook fired.
    // live(bool): whether the live event stream is connected.
    start(hooks) {
      changed = hooks.changed || changed;
      tick = hooks.tick || tick;
      live = hooks.live || live;
      if (!process.env.CMUX_SOCKET && !process.env.CMUX_SOCKET_PATH && !process.env.CMUX_PANEL_ID) {
        console.log('Note: this shell does not look like a cmux terminal. If cmux refuses the connection, start Switchboard from a cmux terminal.');
      }
      startEvents();
    },
    snapshot: buildSnapshot,
    act,
    // The recent conversation of an item's agent, or null when there is no transcript.
    async conversation(item) {
      if (item?.agent?.kind !== 'claude') return null;
      return readConversation(item.agent.sessionId);
    },
  };
}
