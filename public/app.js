import { createWorld } from '/world.js';
import { icon, portrait } from '/icons.js';

const TOKEN = document.querySelector('meta[name="sb-token"]').content;
const LANES = ['needs', 'working', 'move', 'stale', 'shells'];
const LANE_LABEL = { needs: 'Needs you', working: 'Working', move: 'Your move', stale: 'Stale', shells: 'No agent' };
const DEFAULT_STALE_MS = 2 * 24 * 3600 * 1000;
const THEMES = ['day', 'sunset', 'night'];
const DECISION_MS = 120 * 1000;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const inspector = $('inspector');
const cardEl = $('card');
const roster = $('roster');
const favicon = $('favicon');

const groups = Object.fromEntries(
  LANES.map((lane) => {
    const el = document.querySelector(`.group[data-lane="${lane}"]`);
    return [lane, { el, list: el.querySelector('ul'), count: el.querySelector('.n') }];
  }),
);

const state = {
  snap: null,
  staleMs: readSetting('staleMs', (v) => Number(v) > 0, DEFAULT_STALE_MS, Number),
  theme: readSetting('theme', (v) => THEMES.includes(v), 'sunset'),
  selected: null,
  buckets: null,
  byId: new Map(),
  prev: null, // id -> { lane, phase } from the previous snapshot
  fullOpen: new Set(),
  drafts: new Map(),
  selections: new Map(),
  lastRenderAt: 0,
  framed: false,
  sseOpen: false,
  cardKey: '',
  cardFull: null,
  composerFor: '',
};

const rows = new Map(); // id -> { li, btn, key }

for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

// ------------------------------------------------------------------ helpers

function readSetting(name, ok, fallback, cast = (v) => v) {
  try {
    const v = localStorage.getItem(`switchboard.${name}`);
    if (v != null && ok(v)) return cast(v);
  } catch {
    // Storage unavailable; use the default.
  }
  return fallback;
}

function writeSetting(name, v) {
  try {
    localStorage.setItem(`switchboard.${name}`, String(v));
  } catch {
    // Not persisted; it still applies for this visit.
  }
}

const ts = (iso) => Date.parse(iso) || 0;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const plain = (s) =>
  String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function firstParagraph(text) {
  const paras = String(text || '').trim().split(/\n\s*\n/);
  const para = paras.find((p) => plain(p) && !/^\s*\|/.test(p) && !/^```/.test(p.trim())) || '';
  return clip(plain(para), 260);
}

function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

function ago(ms) {
  if (ms < 45000) return 'just now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60 ? `${m % 60}m ` : ''}ago`;
  return `${span(ms)} ago`;
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTime(fmt, ms) {
  switch (fmt) {
    case 'clock':
      return clock(ms);
    case 'idle':
      return `idle ${span(ms)}`;
    case 'wait':
      return `waiting ${span(ms)}`;
    case 'short':
      return span(ms);
    default:
      return ago(ms);
  }
}

const timeTag = (iso, fmt, cls = '') =>
  iso ? `<span${cls ? ` class="${cls}"` : ''} data-since="${esc(iso)}" data-fmt="${fmt}">${esc(fmtTime(fmt, Date.now() - ts(iso)))}</span>` : '';

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const MODE_LABELS = { auto: 'auto mode', acceptEdits: 'accept edits', plan: 'plan mode', bypassPermissions: 'bypass perms' };

// A small, safe Markdown subset: everything is escaped first.
function inlineMd(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

const BLOCK_START = /^(```|\s*\||\s*[-*•]\s+|\s*\d+[.)]\s+|#{1,6}\s)/;

function tableHTML(lines) {
  const cells = lines
    .filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
    .map((r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inlineMd(esc(c.trim()))));
  if (!cells.length) return '';
  const [head, ...body] = cells;
  return `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^\s*\|/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) buf.push(lines[i++]);
      out.push(tableHTML(buf));
    } else if (/^\s*[-*•]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
      out.push(`<ul>${buf.map((b) => `<li>${inlineMd(esc(b))}</li>`).join('')}</ul>`);
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push(`<ol>${buf.map((b) => `<li>${inlineMd(esc(b))}</li>`).join('')}</ol>`);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<h4>${inlineMd(esc(line.replace(/^#+\s*/, '')))}</h4>`);
      i += 1;
    } else if (!line.trim()) {
      i += 1;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inlineMd(esc(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('');
}

// ------------------------------------------------------------ classifying

function laneOf(item, now) {
  if (item.phase === 'shell') return 'shells';
  if (item.phase === 'blocked') return 'needs';
  if (item.phase === 'working') return 'working';
  if (now - ts(item.lastActivityAt) > state.staleMs) return 'stale';
  if (item.unread > 0 || item.question) return 'needs';
  return 'move';
}

const SORTS = {
  needs: (a, b) =>
    (b.phase === 'blocked') - (a.phase === 'blocked') ||
    ts(a.blocked?.since || a.lastActivityAt) - ts(b.blocked?.since || b.lastActivityAt),
  working: (a, b) => a.order - b.order,
  move: (a, b) => ts(b.lastActivityAt) - ts(a.lastActivityAt),
  stale: (a, b) => ts(b.lastActivityAt) - ts(a.lastActivityAt),
  shells: (a, b) => a.order - b.order,
};

// What kind of "call" an agent that needs you is making.
function beaconOf(item, lane) {
  if (lane !== 'needs') return null;
  if (item.phase === 'blocked') return { permission: 'permission', question: 'question', plan: 'plan' }[item.blocked.kind] || 'terminal';
  return item.question ? 'question' : 'result';
}

const KIND = {
  permission: { label: 'Incoming call', icon: 'call' },
  question: { label: 'New text', icon: 'text' },
  plan: { label: 'New email', icon: 'mail' },
  terminal: { label: 'On hold', icon: 'terminal' },
  result: { label: 'Missed call', icon: 'missed' },
};

function chipLabel(item, lane) {
  const kind = beaconOf(item, lane);
  if (kind === 'question' && item.phase !== 'blocked') return 'Asked you';
  if (kind) return KIND[kind].label;
  return LANE_LABEL[lane];
}

const repoName = (item) => item.repo?.name || 'hangout';

// --------------------------------------------------------------- roster

function rowSub(item, lane) {
  const where = esc(repoName(item));
  if (lane === 'needs') {
    const since = item.phase === 'blocked' ? item.blocked.since || item.lastActivityAt : item.lastActivityAt;
    return `<span class="u-what">${esc(chipLabel(item, lane))}</span> · ${where} · ${timeTag(since, 'short')}`;
  }
  if (lane === 'working') return `<span class="u-what">${esc(item.now?.name || 'Thinking')}</span> · ${where} · ${timeTag(item.turnStartedAt || item.lastActivityAt, 'clock')}`;
  if (lane === 'shells') return where;
  return `${where} · ${timeTag(item.lastActivityAt, lane === 'stale' ? 'idle' : 'short')}`;
}

function rowHTML(item, lane) {
  const kind = beaconOf(item, lane);
  return `${portrait(item.surfaceId, lane)}<span class="u-main"><b>${esc(item.title)}</b><span class="u-sub">${rowSub(item, lane)}</span></span>${
    kind ? `<span class="u-kind" title="${esc(chipLabel(item, lane))}">${icon(KIND[kind].icon)}</span>` : ''
  }${item.here ? `<span class="u-here" title="Selected in cmux">${icon('pin')}</span>` : ''}`;
}

function renderRoster(buckets) {
  const alive = new Set();
  for (const lane of LANES) {
    const { el, list, count } = groups[lane];
    buckets[lane].forEach((item, idx) => {
      let rec = rows.get(item.surfaceId);
      if (!rec) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'unit';
        btn.dataset.id = item.surfaceId;
        li.appendChild(btn);
        rec = { li, btn, key: '' };
        rows.set(item.surfaceId, rec);
      }
      const key = `${lane}|${JSON.stringify([item.title, item.repo?.name, item.project, item.phase, item.blocked?.kind, item.blocked?.since, item.now?.name, item.turnStartedAt, item.lastActivityAt, item.question, item.here])}`;
      if (key !== rec.key) {
        rec.key = key;
        rec.btn.dataset.lane = lane;
        rec.btn.innerHTML = rowHTML(item, lane);
      }
      rec.btn.setAttribute('aria-current', String(item.surfaceId === state.selected));
      alive.add(item.surfaceId);
      if (list.children[idx] !== rec.li) list.insertBefore(rec.li, list.children[idx] || null);
    });
    el.dataset.count = String(buckets[lane].length);
    count.textContent = buckets[lane].length ? String(buckets[lane].length) : '';
  }
  for (const [id, rec] of rows) {
    if (!alive.has(id)) {
      rec.li.remove();
      rows.delete(id);
    }
  }
  const agents = LANES.slice(0, 4).reduce((n, l) => n + buckets[l].length, 0);
  $('roster-count').textContent = agents ? String(agents) : '';
  $('roster-toggle-needs').textContent = buckets.needs.length ? String(buckets.needs.length) : '';
}

roster.addEventListener('click', (e) => {
  const btn = e.target.closest('.unit');
  if (!btn) return;
  selectAgent(btn.dataset.id);
  if (window.matchMedia('(max-width: 760px)').matches) setRoster(false);
});

// --------------------------------------------------------------- the phone

const selKey = (item) => item.blocked?.requestId || item.surfaceId;

function metaHTML(item) {
  const parts = [];
  if (item.project && item.project !== item.repo?.name) parts.push(`<span title="${esc(item.cwd)}">${icon('folder')}${esc(item.project)}</span>`);
  if (item.branch) parts.push(`<span title="Git branch">${icon('branch')}${esc(item.branch)}</span>`);
  if (item.model) parts.push(`<span title="Model">${icon('chip')}${esc(item.model)}</span>`);
  if (item.contextTokens) parts.push(`<span title="Tokens in context on the last turn">${icon('layers')}${fmtTokens(item.contextTokens)}</span>`);
  if (item.mode && MODE_LABELS[item.mode]) parts.push(`<span title="Permission mode">${icon('shield')}${MODE_LABELS[item.mode]}</span>`);
  for (const p of item.ports || []) {
    parts.push(`<span><a href="http://localhost:${p}" target="_blank" rel="noopener noreferrer" title="Listening on port ${p}">${icon('plug')}:${p}</a></span>`);
  }
  return parts.length ? `<div class="meta">${parts.join('')}</div>` : '';
}

const deadlineOf = (b) => (b.requestId && b.deadline ? b.deadline : null);

function countdownRing(item, until) {
  const left = until ? Math.max(0, ts(until) - Date.now()) : 0;
  const frac = until ? Math.min(1, left / DECISION_MS) : 1;
  return `<div class="ring-wrap"><svg class="ring" viewBox="0 0 120 120" aria-hidden="true"><circle class="track" cx="60" cy="60" r="54" pathLength="100"/><circle class="left" cx="60" cy="60" r="54" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${(100 - frac * 100).toFixed(2)}"${
    until ? ` data-ring-until="${esc(until)}"` : ''
  }/></svg>${portrait(item.surfaceId, 'needs', 'avatar-xl')}</div>`;
}

function deadlineHTML(until) {
  return until ? `<p class="deadline">Goes back to the terminal in <span data-until="${esc(until)}">${countdown(ts(until) - Date.now())}</span></p>` : '';
}

const outgoing = (item, label = 'You') =>
  item.lastPrompt
    ? `<div class="bubble out"><span class="who">${label}${item.lastPromptAt ? ` · ${timeTag(item.lastPromptAt, 'ago')}` : ''}</span>${inlineMd(esc(plain(item.lastPrompt)))}</div>`
    : '';

function callHTML(item) {
  const b = item.blocked;
  const tool = b.tool;
  const until = deadlineOf(b);
  const live = Boolean(b.requestId);
  const why = tool?.command && tool.detail && tool.detail !== tool.command ? `: ${esc(tool.detail)}` : '';
  const what = tool?.name ? `Wants to use <b>${esc(tool.name)}</b>${why}` : esc(b.label || 'Waiting for your decision');
  const shown = tool?.command || tool?.detail;
  let h = `<section class="call${live ? '' : ' held'}">${countdownRing(item, until)}<p class="call-kind">${live ? 'Incoming call' : 'On hold in the terminal'}</p><p class="call-what">${what}</p>`;
  if (shown) h += `<pre class="cmd">${esc(shown)}</pre>`;
  if (live) {
    h += `<div class="call-btns"><button type="button" class="round decline" data-act="perm" data-mode="deny">${icon('close')}<span>Decline</span></button><button type="button" class="round answer" data-act="perm" data-mode="once">${icon('call')}<span>Answer</span></button></div>`;
    h += `<button type="button" class="btn ghost always" data-act="perm" data-mode="always">Always allow ${tool?.name ? esc(tool.name) : 'this'}</button>${deadlineHTML(until)}`;
  } else {
    h += '<p class="deadline">Decide in the terminal: open it in cmux.</p>';
  }
  return `${h}</section>`;
}

function textHTML(item) {
  const b = item.blocked;
  const live = Boolean(b.requestId);
  const sel = state.selections.get(selKey(item)) || [];
  let h = `<div class="thread">${outgoing(item)}`;
  b.questions.forEach((q, qi) => {
    h += `<div class="bubble in">${q.header ? `<span class="who">${esc(q.header)}</span>` : ''}${inlineMd(esc(q.question))}</div>`;
    if (q.options.length) {
      h += `<div class="opts" role="group" aria-label="${esc(q.header || 'Answers')}">`;
      for (const o of q.options) {
        const on = Boolean(sel[qi]?.includes(o.label));
        h += `<button type="button" class="opt" data-act="qopt" data-q="${qi}" data-label="${esc(o.label)}" aria-pressed="${on}"${live ? '' : ' disabled'}><span>${esc(o.label)}</span>${
          o.description ? `<small>${esc(o.description)}</small>` : ''
        }</button>`;
      }
      h += '</div>';
    }
  });
  if (live) {
    const ready = b.questions.every((q, qi) => !q.options.length || sel[qi]?.length);
    h += `<div class="btns"><button type="button" class="btn hot" data-act="qsend"${ready ? '' : ' disabled'}>${icon('send')}Send answer</button></div>${deadlineHTML(deadlineOf(b))}`;
  } else {
    h += '<p class="deadline">Answer it in the terminal: open it in cmux.</p>';
  }
  return `${h}</div>`;
}

function mailHTML(item) {
  const b = item.blocked;
  const live = Boolean(b.requestId);
  let h = `<section class="mail"><div class="mail-head">${icon('mail')}<div><b>Plan ready: ${esc(item.title)}</b><span>Finished planning and wants to start.</span></div></div>`;
  if (b.plan) h += `<div class="md">${md(b.plan)}</div>`;
  h += live
    ? `<div class="btns"><button type="button" class="btn hot" data-act="plan" data-mode="manual">Approve</button><button type="button" class="btn" data-act="plan" data-mode="autoAccept">Approve in auto mode</button><button type="button" class="btn danger" data-act="plan" data-mode="deny">Keep planning</button></div>${deadlineHTML(deadlineOf(b))}`
    : '<p class="deadline">Review it in the terminal: open it in cmux.</p>';
  return `${h}</section>`;
}

function threadHTML(item, lane) {
  if (lane === 'shells') return '<div class="thread"><p class="line-note">No one on this line. It is a terminal without an agent.</p></div>';
  if (lane === 'working') {
    const n = item.now;
    const doing = n && (n.name || n.detail) ? `<b>${esc(n.name || '')}</b> ${esc(n.detail || '')}` : 'Thinking';
    return `<div class="thread">${outgoing(item, 'You asked')}<div class="bubble in typing" aria-label="Working"><i></i><i></i><i></i></div><p class="now">${icon('car')}<span>${doing}</span></p></div>`;
  }
  let h = '<div class="thread">';
  if (lane === 'stale') h += `<p class="banner-dnd">${icon('dnd')}Do not disturb · ${timeTag(item.lastActivityAt, 'idle')}</p>`;
  if (lane === 'needs' && item.unread && !item.question) h += `<p class="banner-missed">${icon('missed')}Missed call · ${timeTag(item.lastActivityAt, 'ago')}</p>`;
  h += outgoing(item);
  const summary = item.recap ? plain(item.recap.text) : item.reply ? firstParagraph(item.reply.text) : '';
  if (summary && summary !== plain(item.question || '')) h += `<div class="bubble in">${inlineMd(esc(summary))}</div>`;
  if (item.question) h += `<div class="bubble in ask">${inlineMd(esc(item.question))}</div>`;
  return `${h}</div>`;
}

function activityHTML(item) {
  const bins = item.activity;
  if (!bins) return '';
  const total = bins.reduce((a, b) => a + b, 0);
  const recent = bins.slice(-4).reduce((a, b) => a + b, 0);
  const bars = [1, 3, 6, 10].map((need, i) => `<i${recent >= need ? ' class="on"' : ''} data-h="${i}"></i>`).join('');
  return `<span class="bars" title="${total} tool calls in the last 3 hours" aria-label="${total} tool calls in the last 3 hours">${bars}</span>`;
}

function phoneHTML(item, lane) {
  const now = new Date();
  const status = `<div class="phone-status"><span data-clock>${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</span><span class="carrier">Switchboard</span>${activityHTML(item)}</div>`;
  let when = '';
  if (item.phase === 'blocked') when = timeTag(item.blocked.since || item.lastActivityAt, 'wait', 'when');
  else if (lane === 'working') when = timeTag(item.turnStartedAt || item.lastActivityAt, 'clock', 'when');
  else if (lane === 'stale') when = timeTag(item.lastActivityAt, 'idle', 'when');
  else if (lane !== 'shells') when = timeTag(item.lastActivityAt, 'ago', 'when');
  const contact = `<header class="contact">${portrait(item.surfaceId, lane, 'avatar')}<div class="who"><h2 class="title">${esc(item.title)}</h2><p><span class="chip"><i></i>${esc(
    chipLabel(item, lane),
  )}</span>${when}</p></div><button type="button" class="icon-btn close" data-act="close" aria-label="Close" title="Close (Esc)">${icon('close')}</button></header>`;
  const where = `<p class="where">${icon('pin')}${esc(repoName(item))}${item.here ? ' · selected in cmux' : ''}</p>`;
  let body = '';
  if (item.phase === 'blocked') {
    if (item.blocked.kind === 'question') body = textHTML(item);
    else if (item.blocked.kind === 'plan') body = mailHTML(item);
    else body = callHTML(item);
  } else {
    body = threadHTML(item, lane);
  }
  return status + contact + where + metaHTML(item) + body;
}

function dockHTML(item, lane) {
  const btns = [`<button type="button" class="btn go" data-act="jump">${icon('open')}Open in cmux</button>`];
  if (item.reply) {
    const open = state.fullOpen.has(item.surfaceId);
    btns.push(`<button type="button" class="btn ghost" data-act="full" aria-expanded="${open}">${icon('doc')}${open ? 'Hide reply' : 'Full reply'}</button>`);
  }
  if (item.unread && lane !== 'working') btns.push(`<button type="button" class="btn ghost" data-act="read">${icon('check')}Mark read</button>`);
  return `<div class="phone-dock">${btns.join('')}</div>`;
}

function paintInspector(force = false) {
  const item = state.selected ? state.byId.get(state.selected) : null;
  if (!item) {
    if (!inspector.hidden) {
      inspector.hidden = true;
      state.cardKey = '';
      state.composerFor = '';
    }
    return;
  }
  const lane = item.lane;
  const sel = item.blocked ? JSON.stringify(state.selections.get(selKey(item)) || null) : '';
  const key = `${lane}|${state.fullOpen.has(item.surfaceId)}|${sel}|${JSON.stringify(item)}`;
  inspector.hidden = false;
  if (!force && key === state.cardKey) return;
  state.cardKey = key;
  cardEl.dataset.id = item.surfaceId;
  cardEl.dataset.lane = lane;
  cardEl.dataset.phase = item.phase;
  const focus = saveFocus();
  cardEl.querySelector('.body').innerHTML = phoneHTML(item, lane);
  cardEl.querySelector('.dock-slot').innerHTML = dockHTML(item, lane);
  paintFull(item);
  paintComposer(item);
  restoreFocus(focus);
}

function paintFull(item) {
  const slot = cardEl.querySelector('.full-slot');
  if (!state.fullOpen.has(item.surfaceId) || !item.reply) {
    if (slot.firstChild) slot.replaceChildren();
    state.cardFull = null;
    return;
  }
  const key = `${item.surfaceId}|${item.reply.text}`;
  if (state.cardFull === key) return;
  state.cardFull = key;
  slot.innerHTML = `<div class="bubble in full"><span class="who">Full reply · ${timeTag(item.reply.at, 'ago')}</span><div class="md">${md(item.reply.text)}</div></div>`;
}

// Texting back is only possible while the agent is idle; the server checks again.
function paintComposer(item) {
  const slot = cardEl.querySelector('.reply-slot');
  const want = item.phase === 'idle' ? `${item.surfaceId}|idle` : '';
  if (want === state.composerFor) return;
  state.composerFor = want;
  if (!want) {
    slot.replaceChildren();
    return;
  }
  slot.innerHTML = `<div class="composer">
      <textarea rows="2" placeholder="Text ${esc(clip(item.title, 40))}…" aria-label="Reply to ${esc(item.title)}"></textarea>
      <button type="button" class="send" data-act="send" aria-label="Send" title="Send (⌘↩)">${icon('send')}</button>
    </div>
    <p class="note">Typed into its prompt and sent, as if you were in the terminal.</p>
    <p class="err" hidden></p>`;
  slot.querySelector('textarea').value = state.drafts.get(item.surfaceId) || '';
}

function saveFocus() {
  const el = document.activeElement;
  if (!el || !cardEl.contains(el) || el.closest('.reply-slot')) return null;
  return { act: el.dataset?.act, mode: el.dataset?.mode, label: el.dataset?.label };
}

function restoreFocus(saved) {
  if (!saved?.act) return;
  let sel = `[data-act="${saved.act}"]`;
  if (saved.mode) sel += `[data-mode="${saved.mode}"]`;
  if (saved.label) sel += `[data-label="${CSS.escape(saved.label)}"]`;
  cardEl.querySelector(sel)?.focus({ preventScroll: true });
}

function selectAgent(id, { fly = true } = {}) {
  const item = id ? state.byId.get(id) : null;
  state.selected = item ? id : null;
  world?.select(state.selected, { fly });
  for (const [rid, rec] of rows) rec.btn.setAttribute('aria-current', String(rid === state.selected));
  paintInspector(true);
  if (item) {
    rows.get(id)?.btn.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    hideRinger(id);
  }
}

function closeInspector() {
  const was = state.selected;
  selectAgent(null);
  if (was) rows.get(was)?.btn.focus({ preventScroll: true });
}

// ------------------------------------------------------- banners and calls

const bannerQueue = [];
let bannerBusy = false;

function showBanner(title, sub) {
  bannerQueue.push([title, sub]);
  if (!bannerBusy) nextBanner();
}

function nextBanner() {
  const el = $('job-banner');
  const next = bannerQueue.shift();
  if (!next) {
    bannerBusy = false;
    return;
  }
  bannerBusy = true;
  el.querySelector('b').textContent = next[0];
  el.querySelector('span').textContent = next[1];
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.hidden = true;
      nextBanner();
    }, 400);
  }, 2600);
}

let ringerFor = null;
let ringerTimer = null;

function ring(item) {
  if (item.surfaceId === state.selected) return;
  const el = $('ringer');
  const kind = KIND[beaconOf(item, 'needs')] || KIND.result;
  ringerFor = item.surfaceId;
  el.querySelector('.ringer-icon').innerHTML = icon(kind.icon);
  el.querySelector('.ringer-kind').textContent = item.phase === 'blocked' || !item.question ? kind.label : 'Asked you';
  el.querySelector('.ringer-title').textContent = `${item.title} · ${repoName(item)}`;
  el.hidden = false;
  clearTimeout(ringerTimer);
  ringerTimer = setTimeout(() => hideRinger(), 9000);
}

function hideRinger(id) {
  if (id && id !== ringerFor) return;
  $('ringer').hidden = true;
  ringerFor = null;
}

$('ringer').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="dismiss"]')) return hideRinger();
  if (ringerFor) selectAgent(ringerFor);
});

function noticeTransitions(now) {
  const next = new Map();
  for (const item of state.snap.items) next.set(item.surfaceId, { lane: item.lane, phase: item.phase });
  if (state.prev) {
    for (const item of state.snap.items) {
      const was = state.prev.get(item.surfaceId);
      if (!was) continue;
      if (was.phase === 'working' && item.phase === 'idle') {
        showBanner('Job done', `${item.title} · ${repoName(item)}`);
      }
      // Only a real change rings, not a lane shift from the "Stale after" setting.
      if (was.lane !== 'needs' && item.lane === 'needs' && was.phase !== item.phase) ring(item);
    }
  }
  state.prev = next;
  return now;
}

// --------------------------------------------------------------- rendering

let world = null;

function render() {
  const snap = state.snap;
  if (!snap) return;
  const now = Date.now();
  state.lastRenderAt = now;

  const buckets = Object.fromEntries(LANES.map((l) => [l, []]));
  state.byId.clear();
  for (const item of snap.items) {
    item.lane = laneOf(item, now);
    buckets[item.lane].push(item);
    state.byId.set(item.surfaceId, item);
  }
  for (const lane of LANES) buckets[lane].sort(SORTS[lane]);
  state.buckets = buckets;
  noticeTransitions(now);

  renderRoster(buckets);

  if (world) {
    const entries = [];
    for (const lane of LANES.slice(0, 4)) {
      for (const item of buckets[lane]) {
        entries.push({ id: item.surfaceId, repoKey: item.repo?.key || null, repoName: item.repo?.name || null, title: item.title, lane, beacon: beaconOf(item, lane), laneLabel: chipLabel(item, lane) });
      }
    }
    world.sync(entries);
    if (!state.framed && entries.length) {
      state.framed = true;
      world.frameAll();
    }
  }
  $('world-empty').hidden = !(world && snap.items.length === 0 && snap.cmux?.ok !== false);

  if (state.selected && !state.byId.has(state.selected)) selectAgent(null);
  paintInspector();
  renderTally(buckets);
  renderPulse(snap.pulse);
  renderTitle(buckets);
  renderHealth();
}

function renderTally(buckets) {
  for (const a of document.querySelectorAll('.tally-item')) {
    const n = buckets[a.dataset.lane].length;
    a.querySelector('b').textContent = String(n);
    a.toggleAttribute('data-zero', n === 0);
    a.setAttribute('aria-label', `${n} ${a.querySelector('span').textContent.toLowerCase()}${n ? ', go to the next one' : ''}`);
  }
}

function renderPulse(pulse) {
  if (!pulse) return;
  const svg = document.querySelector('#pulse svg');
  const bins = pulse.bins;
  const W = 216;
  const H = 28;
  const bw = W / bins.length;
  const max = Math.max(6, ...bins);
  svg.innerHTML = bins
    .map((v, i) => {
      const h = v ? Math.max(2, (v / max) * (H - 2)) : 1.5;
      return `<rect x="${(i * bw).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(bw - 1.6).toFixed(2)}" height="${h.toFixed(2)}" rx="1"${v ? '' : ' class="zero"'}/>`;
    })
    .join('');
  $('pulse-total').textContent = bins.reduce((a, b) => a + b, 0).toLocaleString();
}

let lastIconColor = '';
function renderTitle(buckets) {
  const needs = buckets.needs.length;
  const working = buckets.working.length;
  document.title = needs ? `(${needs}) Switchboard` : working ? `Switchboard · ${working} working` : 'Switchboard';
  const color = needs ? '#ff3f8e' : working ? '#2fd8ff' : '#8a84a3';
  if (color === lastIconColor) return;
  lastIconColor = color;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#1a0f26"/><circle cx="16" cy="16" r="7" fill="${color}"/></svg>`;
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function renderHealth() {
  const live = $('live');
  const banner = $('banner');
  const cmux = state.snap?.cmux;
  let s = 'live';
  let label = state.snap?.demo ? 'Demo' : 'Live';
  if (!state.sseOpen) [s, label] = ['down', 'Reconnecting…'];
  else if (cmux && !cmux.ok) [s, label] = ['down', 'cmux unreachable'];
  else if (cmux && !cmux.eventsLive) [s, label] = ['polling', 'Polling every 5 s'];
  live.dataset.state = s;
  live.querySelector('span').textContent = label;
  if (cmux && !cmux.ok) {
    banner.hidden = false;
    banner.textContent = `Switchboard can't read cmux: ${cmux.error}. cmux only accepts connections from its own terminals, so start Switchboard from a cmux terminal.`;
  } else {
    banner.hidden = true;
  }
}

// ------------------------------------------------------------------ actions

async function post(payload) {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Switchboard-Token': TOKEN },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5200 : 2600);
}

async function runAction(btn, fn, okMessage) {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const data = await fn();
    toast(data?.note || okMessage);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

async function sendReply(item, btn) {
  const slot = cardEl.querySelector('.reply-slot');
  const ta = slot.querySelector('textarea');
  const err = slot.querySelector('.err');
  const text = ta.value.trim();
  if (!text) {
    ta.focus();
    return;
  }
  btn.disabled = true;
  err.hidden = true;
  try {
    const data = await post({ action: 'reply', workspaceId: item.workspaceId, surfaceId: item.surfaceId, text });
    state.drafts.delete(item.surfaceId);
    ta.value = '';
    toast(data?.note || `Sent to “${item.title}”`);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

cardEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const item = state.byId.get(cardEl.dataset.id);
  if (!item) return;

  switch (btn.dataset.act) {
    case 'close':
      closeInspector();
      break;
    case 'jump':
      runAction(btn, () => post({ action: 'jump', workspaceId: item.workspaceId, surfaceId: item.surfaceId }), `Opened “${item.title}” in cmux`);
      break;
    case 'send':
      sendReply(item, btn);
      break;
    case 'full':
      if (state.fullOpen.has(item.surfaceId)) state.fullOpen.delete(item.surfaceId);
      else state.fullOpen.add(item.surfaceId);
      paintInspector(true);
      break;
    case 'read':
      runAction(btn, () => post({ action: 'markRead', workspaceId: item.workspaceId }), 'Marked as read');
      break;
    case 'perm':
      runAction(btn, () => post({ action: 'permission', requestId: item.blocked.requestId, mode: btn.dataset.mode }), btn.dataset.mode === 'deny' ? 'Declined' : 'Allowed');
      break;
    case 'plan':
      runAction(btn, () => post({ action: 'plan', requestId: item.blocked.requestId, mode: btn.dataset.mode }), btn.dataset.mode === 'deny' ? 'Sent back to planning' : 'Plan approved');
      break;
    case 'qopt': {
      const key = selKey(item);
      const qi = Number(btn.dataset.q);
      const sel = state.selections.get(key) || [];
      const picked = new Set(sel[qi] || []);
      const label = btn.dataset.label;
      if (item.blocked.questions[qi]?.multiSelect) {
        if (picked.has(label)) picked.delete(label);
        else picked.add(label);
      } else {
        picked.clear();
        picked.add(label);
      }
      sel[qi] = [...picked];
      state.selections.set(key, sel);
      paintInspector(true);
      break;
    }
    case 'qsend': {
      const sel = state.selections.get(selKey(item)) || [];
      const selections = item.blocked.questions.map((q, qi) => (sel[qi] || []).join(', ')).filter(Boolean);
      runAction(btn, () => post({ action: 'question', requestId: item.blocked.requestId, selections }), 'Answer sent');
      break;
    }
    default:
      break;
  }
});

cardEl.addEventListener('input', (e) => {
  if (e.target.matches('.composer textarea')) state.drafts.set(cardEl.dataset.id, e.target.value);
});

cardEl.addEventListener('keydown', (e) => {
  if (!e.target.matches('.composer textarea')) return;
  const item = state.byId.get(cardEl.dataset.id);
  if (!item) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendReply(item, cardEl.querySelector('[data-act="send"]'));
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    e.target.blur();
  }
});

// ------------------------------------------------------------------ HUD controls

function cycleLane(lane) {
  const list = state.buckets?.[lane] || [];
  if (!list.length) return;
  const cur = list.findIndex((i) => i.surfaceId === state.selected);
  selectAgent(list[(cur + 1) % list.length].surfaceId);
}

$('tally').addEventListener('click', (e) => {
  const btn = e.target.closest('.tally-item');
  if (btn) cycleLane(btn.dataset.lane);
});

function setTheme(name) {
  state.theme = name;
  document.documentElement.dataset.theme = name;
  for (const b of document.querySelectorAll('#themes [data-theme]')) b.setAttribute('aria-checked', String(b.dataset.theme === name));
  world?.setTheme(name);
}

$('themes').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme]');
  if (!btn) return;
  setTheme(btn.dataset.theme);
  writeSetting('theme', btn.dataset.theme);
});

$('themes').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
  const next = THEMES[(THEMES.indexOf(state.theme) + step + THEMES.length) % THEMES.length];
  setTheme(next);
  writeSetting('theme', next);
  document.querySelector(`#themes [data-theme="${next}"]`).focus();
});

document.querySelector('.camera-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cam]');
  if (!btn || !world) return;
  ({ in: () => world.zoom(0.7), out: () => world.zoom(1.4), rotate: () => world.rotate(Math.PI / 4), frame: () => world.frameAll() })[btn.dataset.cam]();
});

function setRoster(open) {
  roster.classList.toggle('open', open);
  $('roster-toggle').setAttribute('aria-expanded', String(open));
  if (open) roster.querySelector('.unit')?.focus({ preventScroll: true });
}
$('roster-toggle').addEventListener('click', () => setRoster(!roster.classList.contains('open')));
$('roster-close').addEventListener('click', () => {
  setRoster(false);
  $('roster-toggle').focus();
});

const staleSelect = $('stale-after');
staleSelect.value = String(state.staleMs);
if (staleSelect.value !== String(state.staleMs)) staleSelect.value = String(DEFAULT_STALE_MS);
staleSelect.addEventListener('change', () => {
  state.staleMs = Number(staleSelect.value);
  writeSetting('staleMs', state.staleMs);
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (e.key === 'Escape') {
    if (roster.classList.contains('open') && !state.selected) setRoster(false);
    else if (state.selected) closeInspector();
    return;
  }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (t.closest?.('button') && (k === ' ' || k === 'Enter')) return;
  if (k === 'n') {
    e.preventDefault();
    cycleLane('needs');
    return;
  }
  if (!world) return;
  const map = {
    f: () => world.frameAll(),
    '+': () => world.zoom(0.75),
    '=': () => world.zoom(0.75),
    '-': () => world.zoom(1.33),
    q: () => world.rotate(-Math.PI / 12),
    e: () => world.rotate(Math.PI / 12),
    w: () => world.pan(0, -1),
    s: () => world.pan(0, 1),
    a: () => world.pan(-1, 0),
    d: () => world.pan(1, 0),
  };
  const fn = map[k];
  if (!fn) return;
  e.preventDefault();
  fn();
});

reduceMotion.addEventListener('change', () => world?.setReducedMotion(reduceMotion.matches));

// -------------------------------------------------------------- live data

function onTick({ surfaceId }) {
  world?.tick(surfaceId);
  if (reduceMotion.matches) return;
  const btn = rows.get(surfaceId)?.btn;
  if (btn) {
    btn.classList.remove('tick');
    void btn.offsetWidth; // restart the animation
    btn.classList.add('tick');
  }
}

async function waitForServerThenReload() {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (res.ok) return window.location.reload();
    } catch {
      // Still down.
    }
  }
}

function connect() {
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('open', () => {
    state.sseOpen = true;
    renderHealth();
  });
  es.addEventListener('snapshot', (e) => {
    state.snap = JSON.parse(e.data);
    render();
  });
  es.addEventListener('tick', (e) => onTick(JSON.parse(e.data)));
  es.addEventListener('error', () => {
    state.sseOpen = false;
    renderHealth();
    // A restarted server issues a new token, so the old stream is refused for good.
    if (es.readyState === EventSource.CLOSED) waitForServerThenReload();
  });
}

setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmtTime(el.dataset.fmt, now - ts(el.dataset.since));
  for (const el of document.querySelectorAll('[data-until]')) {
    const left = ts(el.dataset.until) - now;
    el.textContent = left > 0 ? countdown(left) : 'a moment';
  }
  for (const el of document.querySelectorAll('[data-ring-until]')) {
    const frac = Math.max(0, Math.min(1, (ts(el.dataset.ringUntil) - now) / DECISION_MS));
    el.style.strokeDashoffset = String(100 - frac * 100);
    el.classList.toggle('late', frac < 0.25);
  }
  const d = new Date();
  for (const el of document.querySelectorAll('[data-clock]')) el.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (state.snap && now - state.lastRenderAt > 30000) render();
}, 1000);

// ------------------------------------------------------------------ boot

try {
  world = createWorld($('world'), {
    onSelect: (id) => selectAgent(id),
    onHover: () => {},
    reducedMotion: reduceMotion.matches,
    theme: state.theme,
  });
} catch (err) {
  console.error(err);
  world = null;
}
if (world) {
  world.attachMinimap($('minimap'), { onPick: (id) => selectAgent(id) });
} else {
  $('world-fallback').hidden = false;
  document.body.classList.add('no-world');
}

// Tell the camera which parts of the screen the panels cover.
const narrow = window.matchMedia('(max-width: 760px)');
function updateInsets() {
  if (!world) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const hud = document.querySelector('.hud').getBoundingClientRect();
  const dock = document.querySelector('.dock').getBoundingClientRect();
  const insp = inspector.hidden ? null : inspector.getBoundingClientRect();
  if (narrow.matches) {
    world.setInsets({ left: 0, right: 0, top: hud.bottom, bottom: insp ? H - insp.top : H - dock.top });
    return;
  }
  const rost = roster.getBoundingClientRect();
  world.setInsets({ left: rost.right, right: insp ? W - insp.left : 0, top: hud.bottom, bottom: H - dock.top });
}
const insetObserver = new ResizeObserver(updateInsets);
for (const el of [roster, inspector, document.querySelector('.hud'), document.body]) insetObserver.observe(el);
narrow.addEventListener('change', updateInsets);
updateInsets();

setTheme(state.theme);
connect();
