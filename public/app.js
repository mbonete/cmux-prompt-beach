'use strict';

const TOKEN = document.querySelector('meta[name="sb-token"]').content;
const LANES = ['needs', 'working', 'move', 'stale', 'shells'];
const DEFAULT_STALE_MS = 2 * 24 * 3600 * 1000;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const board = document.getElementById('board');
const favicon = document.getElementById('favicon');
const laneEls = Object.fromEntries(
  LANES.map((lane) => {
    const section = document.querySelector(`.lane[data-lane="${lane}"]`);
    return [lane, { section, cards: section.querySelector('.cards'), count: section.querySelector('.lane-count') }];
  }),
);

const state = {
  snap: null,
  staleMs: readStaleSetting(),
  fullOpen: new Set(),
  replyOpen: new Set(),
  drafts: new Map(),
  selections: new Map(),
  lastRenderAt: 0,
  firstRender: true,
  sseOpen: false,
};

const cards = new Map(); // surfaceId -> { el, key, item, lane, fullText }

// ------------------------------------------------------------------ helpers

function readStaleSetting() {
  try {
    const v = Number(localStorage.getItem('switchboard.staleMs'));
    if (v > 0) return v;
  } catch {
    // Storage unavailable; fall back to the default.
  }
  return DEFAULT_STALE_MS;
}

function writeStaleSetting(v) {
  try {
    localStorage.setItem('switchboard.staleMs', String(v));
  } catch {
    // Not persisted; the setting still applies for this visit.
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

function tableHTML(rows) {
  const cells = rows
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

function chipLabel(item, lane) {
  if (item.phase === 'blocked') {
    const b = item.blocked;
    if (b.kind === 'permission') return 'Permission';
    if (b.kind === 'question') return 'Question';
    if (b.kind === 'plan') return 'Plan ready';
    return b.label || 'Waiting';
  }
  if (lane === 'needs') return item.question ? 'Asked you' : 'New result';
  if (lane === 'working') return 'Working';
  return 'Your move';
}

// --------------------------------------------------------------- templates

const selKey = (item) => item.blocked?.requestId || item.surfaceId;

function headHTML(item, lane) {
  let when = '';
  if (item.phase === 'blocked') when = timeTag(item.blocked.since || item.lastActivityAt, 'wait', 'when');
  else if (lane === 'working') when = timeTag(item.turnStartedAt || item.lastActivityAt, 'clock', 'when');
  else when = timeTag(item.lastActivityAt, 'ago', 'when');
  return `<div class="card-head"><span class="chip"><i></i>${esc(chipLabel(item, lane))}</span>${when}${
    item.here ? '<span class="here">You are here</span>' : ''
  }${item.unread && lane !== 'working' ? '<span class="unread-dot">● unread</span>' : ''}</div>`;
}

function metaHTML(item) {
  const parts = [];
  if (item.project) parts.push(`<span title="${esc(item.cwd)}">${esc(item.project)}</span>`);
  if (item.branch) parts.push(`<span title="Git branch">⎇ ${esc(item.branch)}</span>`);
  if (item.model) parts.push(`<span>${esc(item.model)}</span>`);
  if (item.contextTokens) parts.push(`<span title="Tokens in context on the last turn">${fmtTokens(item.contextTokens)} ctx</span>`);
  if (item.mode && MODE_LABELS[item.mode]) parts.push(`<span>${MODE_LABELS[item.mode]}</span>`);
  for (const p of item.ports || []) {
    parts.push(`<span><a href="http://localhost:${p}" target="_blank" rel="noopener noreferrer" title="Listening on port ${p}">:${p}</a></span>`);
  }
  return parts.length ? `<div class="meta">${parts.join('')}</div>` : '';
}

function nowHTML(item) {
  const n = item.now;
  if (!n || (!n.name && !n.detail)) return '<div class="now"><span>Thinking<span class="dots"></span></span></div>';
  return `<div class="now">${n.name ? `<b>${esc(n.name)}</b>` : ''}<span>${esc(n.detail || '')}${n.detail ? '' : '<span class="dots"></span>'}</span></div>`;
}

function decisionHTML(item) {
  const b = item.blocked;
  const live = Boolean(b.requestId);
  const deadline =
    live && b.deadline ? `<p class="deadline">Falls back to the terminal prompt in <span data-until="${esc(b.deadline)}">${countdown(ts(b.deadline) - Date.now())}</span></p>` : '';
  const elsewhere = (verb) => `<p class="deadline">${verb} in the terminal: open it in cmux.</p>`;

  if (b.kind === 'question') {
    const sel = state.selections.get(selKey(item)) || [];
    let h = '<div class="decision">';
    b.questions.forEach((q, qi) => {
      h += `<div class="q">${q.header ? `<div class="q-head">${esc(q.header)}</div>` : ''}<div class="q-text">${inlineMd(esc(q.question))}</div>`;
      if (q.options.length) {
        h += '<div class="opts">';
        for (const o of q.options) {
          const on = Boolean(sel[qi]?.includes(o.label));
          h += `<button class="btn" data-act="qopt" data-q="${qi}" data-label="${esc(o.label)}" aria-pressed="${on}"${live ? '' : ' disabled'}>${esc(o.label)}${
            o.description ? `<small>${esc(o.description)}</small>` : ''
          }</button>`;
        }
        h += '</div>';
      }
      h += '</div>';
    });
    if (live) {
      const ready = b.questions.every((q, qi) => !q.options.length || sel[qi]?.length);
      h += `<div class="btns"><button class="btn primary" data-act="qsend"${ready ? '' : ' disabled'}>Send answer</button></div>${deadline}`;
    } else {
      h += elsewhere('Answer it');
    }
    return `${h}</div>`;
  }

  if (b.kind === 'plan') {
    let h = '<div class="decision"><p>Finished planning and wants to start.</p>';
    if (b.plan) h += `<div class="plan md">${md(b.plan)}</div>`;
    h += live
      ? `<div class="btns"><button class="btn primary" data-act="plan" data-mode="manual">Approve</button><button class="btn" data-act="plan" data-mode="autoAccept">Approve in auto mode</button><button class="btn danger" data-act="plan" data-mode="deny">Keep planning</button></div>${deadline}`
      : elsewhere('Review it');
    return `${h}</div>`;
  }

  const tool = b.tool;
  const why = tool?.command && tool.detail && tool.detail !== tool.command ? `: ${esc(tool.detail)}` : '';
  let h = `<div class="decision"><p>${tool?.name ? `Wants to use <b>${esc(tool.name)}</b>${why}` : esc(b.label || 'Waiting for your decision')}</p>`;
  const shown = tool?.command || tool?.detail;
  if (shown) h += `<pre class="cmd">${esc(shown)}</pre>`;
  h += live
    ? `<div class="btns"><button class="btn primary" data-act="perm" data-mode="once">Allow once</button><button class="btn" data-act="perm" data-mode="always">Always allow</button><button class="btn danger" data-act="perm" data-mode="deny">Deny</button></div>${deadline}`
    : elsewhere('Decide');
  return `${h}</div>`;
}

function sparkHTML(bins, lane) {
  if (!bins) return '';
  const total = bins.reduce((a, b) => a + b, 0);
  if (!total && lane !== 'working') return '';
  const max = Math.max(4, ...bins);
  const w = 6;
  const h = 20;
  const rects = bins
    .map((v, i) => {
      const bh = v ? Math.max(2, (v / max) * h) : 1.5;
      const cls = [v ? '' : 'zero', i === bins.length - 1 ? 'last' : ''].filter(Boolean).join(' ');
      return `<rect x="${i * w}" y="${(h - bh).toFixed(1)}" width="${w - 2}" height="${bh.toFixed(1)}" rx="1"${cls ? ` class="${cls}"` : ''}/>`;
    })
    .join('');
  return `<svg class="spark" viewBox="0 0 ${bins.length * w - 2} ${h}" preserveAspectRatio="none" role="img" aria-label="${total} tool calls in the last 3 hours"><title>${total} tool calls in the last 3 hours</title>${rects}</svg>`;
}

function actionsHTML(item, lane) {
  const btns = ['<button class="btn primary" data-act="jump">Open in cmux</button>'];
  if (item.phase === 'idle' && (lane === 'needs' || lane === 'move')) {
    btns.push(`<button class="btn" data-act="reply" aria-expanded="${state.replyOpen.has(item.surfaceId)}">Reply</button>`);
  }
  if (item.reply) {
    btns.push(`<button class="btn ghost" data-act="full" aria-expanded="${state.fullOpen.has(item.surfaceId)}">${state.fullOpen.has(item.surfaceId) ? 'Hide reply' : 'Last reply'}</button>`);
  }
  if (item.unread && lane !== 'working') btns.push('<button class="btn ghost" data-act="read">Mark read</button>');
  return `<div class="actions">${btns.join('')}</div>`;
}

function cardHTML(item, lane) {
  let h = headHTML(item, lane);
  h += `<h3 class="title">${esc(item.title)}</h3>`;
  if (item.subtitle) h += `<p class="subtitle">${esc(item.subtitle)}</p>`;
  h += metaHTML(item);

  if (item.phase === 'blocked') h += decisionHTML(item);
  else if (lane === 'working') h += nowHTML(item);
  else if (item.question) h += `<p class="ask">${inlineMd(esc(item.question))}</p>`;

  if (lane !== 'working' && item.phase !== 'blocked') {
    const summary = item.recap ? plain(item.recap.text) : item.reply ? firstParagraph(item.reply.text) : '';
    if (summary && summary !== plain(item.question || '')) h += `<p class="recap">${inlineMd(esc(summary))}</p>`;
  }

  if (item.lastPrompt) {
    const label = lane === 'working' ? 'You asked' : 'You';
    h += `<div class="you"><b>${label}${item.lastPromptAt && lane !== 'working' ? `, ${timeTag(item.lastPromptAt, 'ago')}` : ''}:</b><span title="${esc(item.lastPrompt)}">${esc(plain(item.lastPrompt))}</span></div>`;
  }

  h += sparkHTML(item.activity, lane);
  h += actionsHTML(item, lane);
  return h;
}

function staleHTML(item) {
  const text = item.recap?.text || (item.reply ? firstParagraph(item.reply.text) : item.lastPrompt) || '';
  const where = [item.project, item.branch].filter(Boolean).join(' · ') || item.subtitle || '';
  return `<div class="row-title"><strong title="${esc(item.title)}">${esc(item.title)}</strong><span>${esc(where)}</span></div>
    <div class="row-recap" title="${esc(plain(text))}">${esc(plain(text))}</div>
    <div class="row-side">${item.question ? '<span class="badge">Left a question</span>' : ''}${timeTag(item.lastActivityAt, 'idle')}</div>
    <button class="btn" data-act="jump">Open</button>`;
}

function shellHTML(item) {
  return `<span>${esc(item.title)}</span><button class="btn ghost" data-act="jump">Open</button>`;
}

function bodyHTML(item, lane) {
  if (lane === 'stale') return staleHTML(item);
  if (lane === 'shells') return shellHTML(item);
  return cardHTML(item, lane);
}

// --------------------------------------------------------------- rendering

function ensureCard(item) {
  let rec = cards.get(item.surfaceId);
  if (!rec) {
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.id = item.surfaceId;
    el.innerHTML = '<div class="body"></div><div class="full-slot"></div><div class="reply-slot"></div>';
    rec = { el, key: '', item, lane: null, fullText: null };
    cards.set(item.surfaceId, rec);
  }
  return rec;
}

function paintCard(rec, item, lane, force = false) {
  const sel = item.blocked ? JSON.stringify(state.selections.get(selKey(item)) || null) : '';
  const key = `${lane}|${state.fullOpen.has(item.surfaceId)}|${state.replyOpen.has(item.surfaceId)}|${sel}|${JSON.stringify(item)}`;
  rec.item = item;
  if (!force && key === rec.key) return;
  rec.key = key;
  rec.lane = lane;
  rec.el.dataset.lane = lane;
  rec.el.dataset.phase = item.phase;
  rec.el.querySelector('.body').innerHTML = bodyHTML(item, lane);
  paintFull(rec);
}

function paintFull(rec) {
  const slot = rec.el.querySelector('.full-slot');
  const item = rec.item;
  if (!state.fullOpen.has(item.surfaceId) || !item.reply) {
    if (slot.firstChild) slot.replaceChildren();
    rec.fullText = null;
    return;
  }
  if (rec.fullText === item.reply.text) return;
  rec.fullText = item.reply.text;
  slot.innerHTML = `<p class="md-meta">Last reply, ${timeTag(item.reply.at, 'ago')}</p><div class="md">${md(item.reply.text)}</div>`;
}

function saveFocus() {
  const el = document.activeElement;
  if (!el || !board.contains(el)) return null;
  return { el, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(saved) {
  if (!saved || !saved.el.isConnected || document.activeElement === saved.el) return;
  saved.el.focus({ preventScroll: true });
  if (saved.start != null) {
    try {
      saved.el.setSelectionRange(saved.start, saved.end);
    } catch {
      // Not a text field.
    }
  }
}

function flipFirst() {
  if (reduceMotion.matches) return null;
  const rects = new Map();
  for (const [id, rec] of cards) if (rec.el.isConnected) rects.set(id, rec.el.getBoundingClientRect());
  return rects;
}

function flipPlay(first) {
  if (!first) return;
  let n = 0;
  for (const [id, rec] of cards) {
    if (!rec.el.isConnected) continue;
    const was = first.get(id);
    const now = rec.el.getBoundingClientRect();
    if (!was) {
      rec.el.animate(
        [{ opacity: 0, transform: 'translateY(8px) scale(0.985)' }, { opacity: 1, transform: 'none' }],
        { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)', delay: state.firstRender ? Math.min(n++ * 35, 400) : 0, fill: 'backwards' },
      );
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    rec.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

function render() {
  const snap = state.snap;
  if (!snap) return;
  const now = Date.now();
  state.lastRenderAt = now;

  const buckets = Object.fromEntries(LANES.map((l) => [l, []]));
  for (const item of snap.items) buckets[laneOf(item, now)].push(item);
  for (const lane of LANES) buckets[lane].sort(SORTS[lane]);

  const first = flipFirst();
  const focus = saveFocus();
  const alive = new Set();

  for (const lane of LANES) {
    const { section, cards: container, count } = laneEls[lane];
    buckets[lane].forEach((item, idx) => {
      const rec = ensureCard(item);
      paintCard(rec, item, lane);
      alive.add(item.surfaceId);
      if (container.children[idx] !== rec.el) container.insertBefore(rec.el, container.children[idx] || null);
    });
    section.dataset.count = String(buckets[lane].length);
    count.textContent = buckets[lane].length ? String(buckets[lane].length) : '';
  }

  for (const [id, rec] of cards) {
    if (!alive.has(id)) {
      rec.el.remove();
      cards.delete(id);
    }
  }

  restoreFocus(focus);
  flipPlay(first);
  state.firstRender = false;

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
  }
}

function renderPulse(pulse) {
  if (!pulse) return;
  const svg = document.querySelector('#pulse svg');
  const bins = pulse.bins;
  const W = 216;
  const H = 40;
  const bw = W / bins.length;
  const max = Math.max(6, ...bins);
  svg.innerHTML = bins
    .map((v, i) => {
      const h = v ? Math.max(2, (v / max) * (H - 2)) : 1.5;
      return `<rect x="${(i * bw).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(bw - 1.5).toFixed(2)}" height="${h.toFixed(2)}" rx="1"${v ? '' : ' class="zero"'}/>`;
    })
    .join('');
  document.getElementById('pulse-total').textContent = bins.reduce((a, b) => a + b, 0).toLocaleString();
}

let lastIconColor = '';
function renderTitle(buckets) {
  const needs = buckets.needs.length;
  const working = buckets.working.length;
  document.title = needs ? `(${needs}) Switchboard` : working ? `Switchboard · ${working} working` : 'Switchboard';
  const color = needs ? '#ffb547' : working ? '#5b97ff' : '#7d8597';
  if (color === lastIconColor) return;
  lastIconColor = color;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#11141a"/><circle cx="16" cy="16" r="8" fill="${color}"/></svg>`;
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function renderHealth() {
  const live = document.getElementById('live');
  const banner = document.getElementById('banner');
  const cmux = state.snap?.cmux;
  let s = 'live';
  let label = 'Live';
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
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5200 : 2600);
}

async function runAction(btn, fn, okMessage) {
  btn.disabled = true;
  try {
    await fn();
    if (okMessage) toast(okMessage);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function openReply(rec) {
  const id = rec.item.surfaceId;
  state.replyOpen.add(id);
  const slot = rec.el.querySelector('.reply-slot');
  slot.innerHTML = `<div class="reply-form">
      <textarea rows="3" placeholder="Reply to this agent…" aria-label="Reply to ${esc(rec.item.title)}"></textarea>
      <div class="row">
        <span class="note">Typed into its prompt and sent, as if you were in the terminal.</span>
        <button type="button" class="btn ghost" data-act="cancel">Cancel</button>
        <button type="button" class="btn primary" data-act="send">Send <kbd>⌘↩</kbd></button>
      </div>
      <p class="err" hidden></p>
    </div>`;
  const ta = slot.querySelector('textarea');
  ta.value = state.drafts.get(id) || '';
  ta.focus();
  paintCard(rec, rec.item, rec.lane, true);
}

function closeReply(rec) {
  state.replyOpen.delete(rec.item.surfaceId);
  rec.el.querySelector('.reply-slot').replaceChildren();
  paintCard(rec, rec.item, rec.lane, true);
}

async function sendReply(rec, btn) {
  const slot = rec.el.querySelector('.reply-slot');
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
    await post({ action: 'reply', workspaceId: rec.item.workspaceId, surfaceId: rec.item.surfaceId, text });
    state.drafts.delete(rec.item.surfaceId);
    closeReply(rec);
    toast(`Sent to “${rec.item.title}”`);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    btn.disabled = false;
  }
}

board.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const el = btn.closest('.card');
  const rec = el && cards.get(el.dataset.id);
  if (!rec) return;
  const item = rec.item;

  switch (btn.dataset.act) {
    case 'jump':
      runAction(btn, () => post({ action: 'jump', workspaceId: item.workspaceId, surfaceId: item.surfaceId }), `Opened “${item.title}” in cmux`);
      break;
    case 'reply':
      if (state.replyOpen.has(item.surfaceId)) closeReply(rec);
      else openReply(rec);
      break;
    case 'cancel':
      closeReply(rec);
      break;
    case 'send':
      sendReply(rec, btn);
      break;
    case 'full':
      if (state.fullOpen.has(item.surfaceId)) state.fullOpen.delete(item.surfaceId);
      else state.fullOpen.add(item.surfaceId);
      paintCard(rec, item, rec.lane, true);
      break;
    case 'read':
      runAction(btn, () => post({ action: 'markRead', workspaceId: item.workspaceId }), 'Marked as read');
      break;
    case 'perm':
      runAction(
        btn,
        () => post({ action: 'permission', requestId: item.blocked.requestId, mode: btn.dataset.mode }),
        btn.dataset.mode === 'deny' ? 'Denied' : 'Allowed',
      );
      break;
    case 'plan':
      runAction(
        btn,
        () => post({ action: 'plan', requestId: item.blocked.requestId, mode: btn.dataset.mode }),
        btn.dataset.mode === 'deny' ? 'Sent back to planning' : 'Plan approved',
      );
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
      paintCard(rec, item, rec.lane, true);
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

board.addEventListener('input', (e) => {
  if (e.target.matches('.reply-form textarea')) {
    const id = e.target.closest('.card')?.dataset.id;
    if (id) state.drafts.set(id, e.target.value);
  }
});

board.addEventListener('keydown', (e) => {
  if (!e.target.matches('.reply-form textarea')) return;
  const rec = cards.get(e.target.closest('.card')?.dataset.id);
  if (!rec) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendReply(rec, rec.el.querySelector('[data-act="send"]'));
  } else if (e.key === 'Escape') {
    closeReply(rec);
  }
});

const staleSelect = document.getElementById('stale-after');
staleSelect.value = String(state.staleMs);
if (staleSelect.value !== String(state.staleMs)) staleSelect.value = String(DEFAULT_STALE_MS);
staleSelect.addEventListener('change', () => {
  state.staleMs = Number(staleSelect.value);
  writeStaleSetting(state.staleMs);
  render();
});

// -------------------------------------------------------------- live data

function onTick({ surfaceId }) {
  const rec = cards.get(surfaceId);
  if (!rec || reduceMotion.matches) return;
  rec.el.classList.remove('tick');
  void rec.el.offsetWidth; // restart the animation
  rec.el.classList.add('tick');
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
  if (state.snap && now - state.lastRenderAt > 30000) render();
}, 1000);

connect();
