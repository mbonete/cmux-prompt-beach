// Claude Code transcripts (~/.claude/projects/*/<session>.jsonl), read-only.
// Moved from server.mjs unchanged except where noted; readConversation() is new.

import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapLimit } from '../budget.mjs';
import { UUID_RE, clip } from '../util.mjs';

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

const transcriptPaths = new Map();
const transcriptCache = new Map();

async function locateTranscript(sessionId) {
  const known = transcriptPaths.get(sessionId);
  if (known && existsSync(known)) return known;
  let dirs = [];
  try {
    dirs = await readdir(CLAUDE_PROJECTS);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      transcriptPaths.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

// The last `bytes` of a file as text, starting at a line boundary.
async function readTail(file, size, bytes = TRANSCRIPT_TAIL_BYTES) {
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fh = await open(file, 'r');
  try {
    await fh.read(buf, 0, buf.length, start);
  } finally {
    await fh.close();
  }
  let text = buf.toString('utf8');
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  return { text, start };
}

// A session's helpers (subagents, workflow agents) run inside it and write their
// own transcripts next to it, in <session>/subagents/. The ones written to in the
// last 90 seconds are its active crew. Counted at most every few seconds per
// session, and never more than CREW_MAX_FILES files looked at.
export const CREW_ACTIVE_MS = 90_000;
const CREW_RECOUNT_MS = 3000;
const CREW_MAX_FILES = 10_000;
const crewCache = new Map(); // sessionId -> { at, n }

/** How many helper transcripts in `dir` were written within `activeMs` of `now`. */
export async function countActiveHelpers(dir, now = Date.now(), activeMs = CREW_ACTIVE_MS) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).slice(0, CREW_MAX_FILES);
  } catch {
    return 0;
  }
  const fresh = await mapLimit(names, 32, async (n) => {
    try {
      return now - (await stat(path.join(dir, n))).mtimeMs < activeMs;
    } catch {
      return false;
    }
  });
  return fresh.filter(Boolean).length;
}

export async function crewSize(sessionId, now = Date.now()) {
  if (!UUID_RE.test(sessionId || '')) return 0;
  const cached = crewCache.get(sessionId);
  if (cached && now - cached.at < CREW_RECOUNT_MS) return cached.n;
  const file = await locateTranscript(sessionId);
  const n = file ? await countActiveHelpers(path.join(file.replace(/\.jsonl$/, ''), 'subagents'), now) : 0;
  crewCache.set(sessionId, { at: now, n });
  if (crewCache.size > 2000) for (const [k, v] of crewCache) if (now - v.at > 10 * 60_000) crewCache.delete(k);
  return n;
}

/**
 * Forget the caches of sessions that are gone (the server runs for days; every
 * session ever seen used to stay in memory with its transcript summary).
 */
export function forgetSessionsExcept(keep) {
  for (const map of [transcriptPaths, transcriptCache, promptMemory, conversationCache, crewCache]) {
    for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
  }
}

export async function readTranscript(sessionId) {
  if (!UUID_RE.test(sessionId || '')) return null;
  const file = await locateTranscript(sessionId);
  if (!file) return null;
  const st = await stat(file);
  const cached = transcriptCache.get(sessionId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;

  const { text, start } = await readTail(file, st.size);
  const data = summarizeTranscript(text.split('\n'));

  // Long agentic turns can push the last typed prompt out of the tail. Look further back once and remember it.
  if (data.lastUserText) {
    promptMemory.set(sessionId, { text: data.lastUserText, at: data.lastUserAt });
  } else {
    let remembered = promptMemory.get(sessionId);
    if (!remembered && start > 0) {
      remembered = (await scanBackForPrompt(file, start).catch(() => null)) || { text: null, at: null };
      promptMemory.set(sessionId, remembered);
    }
    if (remembered?.text) {
      data.lastPrompt = remembered.text;
      data.lastUserAt = remembered.at;
    }
  }

  transcriptCache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

const promptMemory = new Map();

async function scanBackForPrompt(file, end) {
  const CHUNK = 4 * 1024 * 1024;
  const LIMIT = 96 * 1024 * 1024;
  const fh = await open(file, 'r');
  try {
    let pos = end;
    let carry = Buffer.alloc(0);
    while (pos > 0 && end - pos < LIMIT) {
      const start = Math.max(0, pos - CHUNK);
      const chunk = Buffer.alloc(pos - start);
      await fh.read(chunk, 0, chunk.length, start);
      let combined = Buffer.concat([chunk, carry]);
      if (start > 0) {
        // The first line may begin before this chunk; carry its bytes into the next read.
        const nl = combined.indexOf(0x0a);
        carry = nl === -1 ? combined : combined.subarray(0, nl);
        combined = nl === -1 ? Buffer.alloc(0) : combined.subarray(nl + 1);
      }
      const lines = combined.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].includes('"type":"user"')) continue;
        let r;
        try {
          r = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const prompt = humanPromptOf(r);
        if (prompt) return { text: prompt, at: r.timestamp };
      }
      pos = start;
    }
  } finally {
    await fh.close();
  }
  return null;
}

// The text a person typed in a transcript "user" entry, or null for tool results and injected context.
// (New in world v2: the summary Claude Code writes after /compact is a "user" entry too,
// flagged isCompactSummary / isVisibleInTranscriptOnly; it is not something the person typed.)
export function humanPromptOf(r) {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) return null;
  const content = r.message?.content;
  if (typeof content === 'string') return isHumanText(content) ? content : null;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((b) => b.type === 'text' && isHumanText(b.text)).map((b) => b.text);
  return texts.length ? texts.join('\n') : null;
}

export function isHumanText(text) {
  const t = String(text || '').trim();
  return t.length > 0 && !t.startsWith('<') && !t.startsWith('[Request interrupted');
}

export function summarizeTranscript(lines) {
  const s = {
    title: null,
    customTitle: null,
    lastPrompt: null,
    lastUserAt: null,
    lastText: null,
    lastTextAt: null,
    lastAssistantAt: null,
    recap: null,
    recapAt: null,
    model: null,
    contextTokens: null,
    branch: null,
    cwd: null,
    /** Distinct working folders in the tail, most recent first (a few). */
    cwds: [],
    mode: null,
  };
  const openTools = new Map();

  const seenCwd = new Set(); // insertion order = recency
  for (const line of lines) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    switch (r.type) {
      case 'ai-title':
        s.title = r.aiTitle || s.title;
        break;
      case 'custom-title':
        s.customTitle = r.customTitle || s.customTitle;
        break;
      case 'last-prompt':
        // Background-task notices and slash-command echoes also land here; keep only what a person typed.
        if (isHumanText(r.lastPrompt)) s.lastPrompt = r.lastPrompt;
        break;
      case 'system':
        if (r.subtype === 'away_summary' && r.content) {
          s.recap = String(r.content).replace(/\s*\(turn off recaps in \/config\)\s*$/i, '');
          s.recapAt = r.timestamp;
        }
        break;
      case 'user': {
        if (r.isSidechain) break;
        if (r.permissionMode) s.mode = r.permissionMode;
        const content = r.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) if (block.type === 'tool_result') openTools.delete(block.tool_use_id);
        }
        const promptText = humanPromptOf(r);
        if (promptText) {
          s.lastUserAt = r.timestamp;
          s.lastUserText = promptText;
        }
        break;
      }
      case 'assistant': {
        if (r.isSidechain) break;
        const m = r.message || {};
        const real = m.model && m.model !== '<synthetic>';
        if (real) s.model = m.model;
        const u = m.usage;
        if (real && u) {
          s.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
        if (r.gitBranch) s.branch = r.gitBranch;
        if (r.cwd) {
          s.cwd = r.cwd;
          seenCwd.delete(r.cwd);
          seenCwd.add(r.cwd);
        }
        s.lastAssistantAt = r.timestamp;
        for (const block of m.content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            s.lastText = block.text;
            s.lastTextAt = r.timestamp;
          } else if (block.type === 'tool_use') {
            openTools.set(block.id, { name: block.name, input: block.input || {}, at: r.timestamp });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Claude writes its last-prompt entry at the end of a turn; the message itself is there sooner.
  if (s.lastUserText) s.lastPrompt = s.lastUserText;

  // Tools from before the latest prompt that never got a result were interrupted; ignore them.
  const since = Date.parse(s.lastUserAt || 0) || 0;
  const live = [...openTools.values()].filter((t) => (Date.parse(t.at) || 0) >= since);
  const lastTool = live[live.length - 1] || null;
  s.currentTool = lastTool ? describeTool(lastTool.name, lastTool.input) : null;
  s.pendingQuestion = lastTool?.name === 'AskUserQuestion' ? normalizeQuestions(lastTool.input?.questions) : null;
  s.pendingPlan = lastTool?.name === 'ExitPlanMode' ? clip(String(lastTool.input?.plan || ''), 6000) : null;
  s.cwds = [...seenCwd].reverse().slice(0, 6);
  return s;
}

export function prettyToolName(name) {
  if (!name) return null;
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return `${server.replace(/^claude_ai_/, '')} · ${rest.join('__')}`;
  }
  return name;
}

export function describeTool(name, input = {}) {
  let detail = input.description || input.command || input.pattern || input.url || input.query || input.skill || input.prompt || '';
  if (!detail && (input.file_path || input.path || input.notebook_path)) {
    detail = path.basename(String(input.file_path || input.path || input.notebook_path));
  }
  detail = String(detail).replace(/\s+/g, ' ').trim();
  const command = typeof input.command === 'string' ? clip(input.command.trim(), 800) : null;
  return { name: prettyToolName(name), detail: clip(detail, 180), command };
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return null;
  return questions.slice(0, 4).map((q) => ({
    header: q.header || null,
    question: q.question || '',
    multiSelect: Boolean(q.multiSelect ?? q.multi_select),
    options: (q.options || []).slice(0, 8).map((o) => ({ label: o.label || String(o), description: o.description || null })),
  }));
}

// The final paragraph of a reply that ends with a question mark, trimmed to the question itself.
export function trailingQuestion(text) {
  if (!text) return null;
  const paras = String(text).trim().split(/\n\s*\n/);
  const last = paras[paras.length - 1] || '';
  const plain = last.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (!/[?？]["”)]?$/.test(plain)) return null;
  const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z¿¡"“(])/);
  let q = sentences[sentences.length - 1];
  if (q.length < 30 && sentences.length > 1) q = sentences.slice(-2).join(' ');
  return q.length > 320 ? `…${q.slice(-319)}` : q;
}

export function prettyModel(model) {
  if (!model) return null;
  return model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(?:-\d{8})?$/, ' $1.$2').replace(/-/g, ' ');
}

// ---------------------------------------------------------------------------
// Conversation for the side panel (new in world v2)

export const CONVERSATION_LIMITS = {
  turns: 20, // most recent prompts, each with what the agent wrote back
  textsPerTurn: 3, // the agent's last few text blocks in a turn (the final one is the answer)
  userChars: 2000,
  assistantChars: 4000,
  totalChars: 80000,
};

// Turns transcript lines into the recent conversation: what the person typed and the
// text the agent wrote back, oldest first. Tool calls, tool output, injected context,
// sidechains (subagents) and synthetic messages are left out.
export function extractConversation(lines, { partial = false, limits = CONVERSATION_LIMITS } = {}) {
  const turns = [];
  let cur = null;
  for (const line of lines) {
    if (!line || (!line.includes('"user"') && !line.includes('"assistant"'))) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.isSidechain) continue;
    if (r.type === 'user') {
      const text = humanPromptOf(r);
      if (!text) continue;
      cur = { user: { text, at: r.timestamp || null }, texts: [] };
      turns.push(cur);
    } else if (r.type === 'assistant') {
      const m = r.message || {};
      if (m.model === '<synthetic>') continue;
      for (const block of m.content || []) {
        if (block.type !== 'text' || !block.text?.trim()) continue;
        if (!cur) {
          cur = { user: null, texts: [] };
          turns.push(cur);
        }
        const last = cur.texts[cur.texts.length - 1];
        if (last && last.text === block.text) continue; // the same block written twice
        cur.texts.push({ text: block.text, at: r.timestamp || null });
      }
    }
  }

  let truncated = partial || turns.length > limits.turns;
  const messages = [];
  for (const t of turns.slice(-limits.turns)) {
    if (t.user) messages.push({ role: 'user', text: clip(t.user.text.trim(), limits.userChars), at: t.user.at });
    for (const x of t.texts.slice(-limits.textsPerTurn)) messages.push({ role: 'assistant', text: clip(x.text.trim(), limits.assistantChars), at: x.at });
  }
  let total = messages.reduce((n, m) => n + m.text.length, 0);
  while (messages.length > 1 && total > limits.totalChars) {
    total -= messages.shift().text.length;
    truncated = true;
  }
  return { messages, truncated };
}

const conversationCache = new Map(); // sessionId -> { mtimeMs, size, data }
const conversationReads = new Map(); // sessionId -> in-flight promise

// The recent conversation of a Claude Code session, from the last 2 MB of its transcript.
export async function readConversation(sessionId) {
  if (!UUID_RE.test(sessionId || '')) return null;
  if (conversationReads.has(sessionId)) return conversationReads.get(sessionId);
  const work = (async () => {
    const file = await locateTranscript(sessionId);
    if (!file) return null;
    const st = await stat(file);
    const cached = conversationCache.get(sessionId);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
    const { text, start } = await readTail(file, st.size);
    const data = extractConversation(text.split('\n'), { partial: start > 0 });
    conversationCache.delete(sessionId);
    conversationCache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, data });
    if (conversationCache.size > 40) conversationCache.delete(conversationCache.keys().next().value);
    return data;
  })().finally(() => conversationReads.delete(sessionId));
  conversationReads.set(sessionId, work);
  return work;
}
