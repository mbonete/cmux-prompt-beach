import { esc, firstParagraph, inlineMd, md, plain, clip, timeTag } from '../app/format';
import type { Actions } from '../app/actions';
import type { AppState, Row } from '../app/state';
import type { Ask, Lane } from '../data/derive';
import type { Blocked, Item } from '../data/types';
import { KIND_ICON, icon, type IconName } from './icons';

// How one session reads, shared by the anchored card, the side panel and the
// lists: its state line, where it lives, what it needs from you and the
// buttons that answer it. One click handler serves every place they appear.

export const LANE_TEXT: Record<Lane, string> = {
  needs: 'Needs you',
  working: 'Working',
  move: 'Your move',
  stale: 'Stale',
  shells: 'No agent',
};

export const ASK_TEXT: Record<Ask, string> = {
  permission: 'Wants permission',
  question: 'Has a question',
  plan: 'Plan ready',
  terminal: 'Waiting in the terminal',
  result: 'Finished',
};

export const ASK_ICON: Record<Ask, IconName> = {
  permission: 'key',
  question: 'question',
  plan: 'plan',
  terminal: 'terminal',
  result: 'result',
};

export const LANE_ICON: Record<Lane, IconName> = {
  needs: 'warning',
  working: 'edit',
  move: 'reply',
  stale: 'clock',
  shells: 'terminal',
};

export function stateText(row: Row): string {
  return row.ask ? ASK_TEXT[row.ask] : LANE_TEXT[row.lane];
}

/** The time that matters for this state: how long it has waited, worked or idled. */
export function stateTime(row: Row): string {
  const it = row.item;
  if (it.phase === 'blocked') return timeTag(it.blocked?.since || it.lastActivityAt, 'wait');
  if (row.lane === 'working') return timeTag(it.turnStartedAt || it.lastActivityAt, 'clock');
  if (row.lane === 'stale') return timeTag(it.lastActivityAt, 'idle');
  if (row.lane === 'shells') return '';
  return timeTag(it.lastActivityAt, 'ago');
}

export function stateLine(row: Row, cls = 'state'): string {
  const t = stateTime(row);
  return `<p class="${cls} state--${row.lane}${row.ask === 'result' ? ' state--done' : ''}"><span class="state__dot" aria-hidden="true"></span><span>${esc(
    stateText(row),
  )}</span>${t ? `<span class="state__sep" aria-hidden="true">·</span>${t}` : ''}</p>`;
}

export function whereLine(it: Item): string {
  const kind = KIND_ICON[it.repo?.kind ?? 'other'] ?? 'branch';
  const name = it.repo?.name ?? it.project ?? 'No repository';
  return `<p class="where">${icon(kind, 'i where__icon')}<span class="where__name">${esc(name)}</span>${
    it.branch ? `<span class="where__sep" aria-hidden="true">·</span><code class="where__branch">${esc(it.branch)}</code>` : ''
  }</p>`;
}

/** One line of what's going on, for lists and toasts. */
export function summaryOf(row: Row): string {
  const it = row.item;
  const b = it.blocked;
  if (row.lane === 'shells') return it.cwd ? it.cwd.replace(/^\/Users\/[^/]+/, '~') : 'Terminal';
  if (b?.kind === 'permission') {
    const t = b.tool;
    if (t?.command) return `Wants to run ${clip(t.command, 90)}`;
    return t?.name ? `Wants to use ${t.name}${t.detail ? `: ${clip(t.detail, 70)}` : ''}` : 'Wants permission';
  }
  if (b?.kind === 'question') return clip(plain(b.questions[0]?.question ?? 'Has a question'), 120);
  if (b?.kind === 'plan') return `Plan: ${firstParagraph(b.plan, 110) || 'ready for review'}`;
  if (b?.kind === 'terminal') return b.label ? `In the terminal: ${b.label}` : 'Waiting in the terminal';
  if (row.lane === 'working') {
    const n = it.now;
    return n?.name ? `${n.name}${n.detail ? ` · ${clip(n.detail, 80)}` : ''}` : 'Thinking';
  }
  if (it.question && row.lane === 'needs') return clip(plain(it.question), 120);
  const said = it.recap?.text ? plain(it.recap.text) : firstParagraph(it.reply?.text, 140);
  if (said) return clip(said, 140);
  if (it.lastPrompt) return `You asked: ${clip(plain(it.lastPrompt), 110)}`;
  return row.lane === 'stale' ? 'Idle' : 'Ready for you';
}

// ------------------------------------------------------------ buttons

interface BtnOpts {
  cls?: string;
  icon?: IconName;
  data?: Record<string, string>;
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
}

export function btn(act: string, label: string, o: BtnOpts = {}): string {
  const data = Object.entries(o.data ?? {})
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join('');
  return `<button type="button" class="btn${o.cls ? ` ${o.cls}` : ''}" data-act="${act}"${data}${o.disabled ? ' disabled' : ''}${
    o.title ? ` title="${esc(o.title)}"` : ''
  }${o.pressed !== undefined ? ` aria-pressed="${o.pressed}"` : ''}>${o.icon ? icon(o.icon, 'i') : ''}<span>${esc(label)}</span></button>`;
}

const deadlineLine = (b: Blocked) =>
  b.requestId && 'deadline' in b && b.deadline
    ? `<p class="ask__note">Goes back to the terminal in ${timeTag(b.deadline, 'until', 'ask__countdown')}</p>`
    : '';

const heldLine = (what: string) => `<p class="ask__note">${esc(what)} in the terminal: open it in cmux.</p>`;

function selKey(it: Item) {
  return `${it.surfaceId}:${it.blocked?.requestId ?? ''}`;
}

/**
 * What this session needs from you (or what it's doing), with the buttons to
 * answer it. `full` is the side panel: whole plans and replies instead of a summary.
 */
export function askBlock(row: Row, state: AppState, full: boolean): string {
  const it = row.item;
  const b = it.blocked;
  if (it.phase === 'blocked' && b) {
    const live = Boolean(b.requestId);
    if (b.kind === 'permission') {
      const t = b.tool;
      const shown = t?.command || t?.detail;
      const why = t?.command && t.detail && t.detail !== t.command ? ` <span class="ask__why">${esc(t.detail)}</span>` : '';
      let h = `<div class="ask ask--permission"><p class="ask__lead">${t?.command ? 'Wants to run' : t?.name ? `Wants to use <strong>${esc(t.name)}</strong>` : 'Wants permission'}${why}</p>`;
      if (shown) h += `<pre class="cmd"><code>${esc(shown)}</code></pre>`;
      if (live) {
        h += `<div class="ask__btns">${btn('perm', 'Allow once', { cls: 'btn--primary', data: { mode: 'once' } })}${btn('perm', `Always allow${t?.name ? ` ${t.name}` : ''}`, {
          data: { mode: 'always' },
        })}${btn('perm', 'Deny', { cls: 'btn--deny', data: { mode: 'deny' } })}</div>${deadlineLine(b)}`;
      } else h += heldLine('Decide');
      return `${h}</div>`;
    }
    if (b.kind === 'question') {
      const sel = state.selections.get(selKey(it)) ?? [];
      let h = '<div class="ask ask--question">';
      b.questions.forEach((q, qi) => {
        h += `<div class="q">${q.header ? `<p class="q__header">${esc(q.header)}</p>` : ''}<p class="q__text">${inlineMd(esc(q.question))}</p>`;
        if (q.options.length) {
          h += `<div class="q__opts" role="group" aria-label="${esc(q.header || 'Answers')}">`;
          for (const o of q.options) {
            const on = Boolean(sel[qi]?.includes(o.label));
            h += `<button type="button" class="opt${q.multiSelect ? ' opt--multi' : ''}" data-act="qopt" data-q="${qi}" data-label="${esc(o.label)}" aria-pressed="${on}"${
              live ? '' : ' disabled'
            }><span class="opt__mark" aria-hidden="true"></span><span class="opt__body"><span class="opt__label">${esc(o.label)}</span>${
              o.description && (full || b.questions.length === 1) ? `<span class="opt__desc">${esc(o.description)}</span>` : ''
            }</span></button>`;
          }
          h += '</div>';
        }
        h += '</div>';
      });
      if (live) {
        const ready = b.questions.every((q, qi) => !q.options.length || sel[qi]?.length);
        h += `<div class="ask__btns">${btn('qsend', 'Send answer', { cls: 'btn--primary', icon: 'send', disabled: !ready })}</div>${deadlineLine(b)}`;
      } else h += heldLine('Answer it');
      return `${h}</div>`;
    }
    if (b.kind === 'plan') {
      let h = '<div class="ask ask--plan">';
      if (b.plan) h += full ? `<div class="md md--plan">${md(b.plan)}</div>` : `<p class="ask__lead">${esc(firstParagraph(b.plan, 240) || 'A plan is ready.')}</p>`;
      if (!full && b.plan) h += `<button type="button" class="link" data-act="expand">Read the whole plan</button>`;
      if (live) {
        h += `<div class="ask__btns">${btn('plan', 'Approve', { cls: 'btn--primary', data: { mode: 'manual' } })}${btn('plan', 'Approve, auto-accept edits', {
          data: { mode: 'autoAccept' },
        })}${btn('plan', 'Keep planning', { cls: 'btn--deny', data: { mode: 'deny' } })}</div>${deadlineLine(b)}`;
      } else h += heldLine('Review it');
      return `${h}</div>`;
    }
    // Only the terminal can answer this one.
    const what = b.label || b.tool?.name || 'a prompt';
    return `<div class="ask ask--terminal"><p class="ask__lead">Waiting for you in the terminal: <strong>${esc(what)}</strong></p>${
      b.tool?.command ? `<pre class="cmd"><code>${esc(b.tool.command)}</code></pre>` : ''
    }<div class="ask__btns">${btn('jump', 'Open in cmux', { cls: 'btn--primary', icon: 'open' })}</div></div>`;
  }

  if (row.lane === 'shells') {
    return `<div class="ask"><p class="ask__lead">A terminal without an agent.</p><div class="ask__btns">${btn('jump', 'Open in cmux', { cls: 'btn--primary', icon: 'open' })}</div></div>`;
  }

  if (row.lane === 'working') {
    const n = it.now;
    const doing = n?.name ? `<strong>${esc(n.name)}</strong>${n.detail ? ` <span class="ask__why">${esc(clip(n.detail, 120))}</span>` : ''}` : 'Thinking';
    return `<div class="ask ask--working"><p class="ask__now"><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>${doing}</p>${
      it.lastPrompt ? `<blockquote class="said said--you"><span class="said__who">You asked</span>${inlineMd(esc(clip(plain(it.lastPrompt), full ? 600 : 180)))}</blockquote>` : ''
    }</div>`;
  }

  // Idle: finished (unread), asking in its reply, your move, or stale.
  const said = it.recap?.text ? plain(it.recap.text) : '';
  const reply = it.reply?.text ?? '';
  let h = `<div class="ask ask--${row.ask ?? row.lane}">`;
  if (full && reply) h += `<div class="md md--reply">${md(reply)}</div>`;
  else if (said || reply) h += `<blockquote class="said"><span class="said__who">${said ? 'Recap' : 'Claude'}</span>${inlineMd(esc(said || firstParagraph(reply, 280)))}</blockquote>`;
  if (it.question && (!full || !reply.includes(it.question))) h += `<p class="ask__question">${inlineMd(esc(it.question))}</p>`;
  const btns: string[] = [];
  if (it.unread > 0) btns.push(btn('read', 'Mark read', { cls: row.ask === 'result' ? 'btn--primary' : '', icon: 'check' }));
  if (it.phase === 'idle' && !full) btns.push(btn('reply-open', 'Reply', { cls: it.unread > 0 ? '' : 'btn--primary', icon: 'reply' }));
  if (row.lane === 'stale' && !it.archived) btns.push(btn('archive', 'Archive', { icon: 'archive' }));
  if (btns.length) h += `<div class="ask__btns">${btns.join('')}</div>`;
  return `${h}</div>`;
}

// ------------------------------------------------------------ actions

export interface AgentHooks {
  /** The session the clicked element belongs to (from the closest [data-id]). */
  close?: () => void;
  expand: (id: string, focusReply?: boolean) => void;
  collapse?: () => void;
  focus: (id: string) => void;
}

/** One delegated handler for every [data-act] inside `root`. */
export function bindAgentActions(root: HTMLElement, state: AppState, actions: Actions, hooks: AgentHooks) {
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!el || el.disabled || !root.contains(el)) return;
    const id = el.closest<HTMLElement>('[data-id]')?.dataset.id ?? null;
    const row = state.row(id);
    const act = el.dataset.act!;
    if (act === 'close') return hooks.close?.();
    if (act === 'collapse') return hooks.collapse?.();
    if (!row) return;
    const it = row.item;
    const b = it.blocked;
    switch (act) {
      case 'expand':
        hooks.expand(it.surfaceId);
        break;
      case 'reply-open':
        hooks.expand(it.surfaceId, true);
        break;
      case 'focus':
        hooks.focus(it.surfaceId);
        break;
      case 'jump':
        void actions.run({ action: 'jump', workspaceId: it.workspaceId, surfaceId: it.surfaceId }, `Opened “${it.title}” in cmux`, el);
        break;
      case 'read':
        void actions.run({ action: 'markRead', workspaceId: it.workspaceId }, 'Marked as read', el);
        break;
      case 'archive':
        if (it.agent) void actions.run({ action: 'archive', sessionId: it.agent.sessionId }, `Archived “${it.title}”`, el);
        break;
      case 'unarchive':
        if (it.agent) void actions.run({ action: 'unarchive', sessionId: it.agent.sessionId }, `“${it.title}” is back`, el);
        break;
      case 'perm':
        if (b?.requestId) {
          const mode = el.dataset.mode as 'once' | 'always' | 'deny';
          void actions.run({ action: 'permission', requestId: b.requestId, mode }, mode === 'deny' ? 'Denied' : 'Allowed', el);
        }
        break;
      case 'plan':
        if (b?.requestId) {
          const mode = el.dataset.mode as 'manual' | 'autoAccept' | 'deny';
          void actions.run({ action: 'plan', requestId: b.requestId, mode }, mode === 'deny' ? 'Sent back to planning' : 'Plan approved', el);
        }
        break;
      case 'qopt': {
        if (b?.kind !== 'question') break;
        const key = selKey(it);
        const qi = Number(el.dataset.q);
        const sel = state.selections.get(key) ?? [];
        const picked = new Set(sel[qi] ?? []);
        const label = el.dataset.label!;
        if (b.questions[qi]?.multiSelect) {
          if (picked.has(label)) picked.delete(label);
          else picked.add(label);
        } else {
          picked.clear();
          picked.add(label);
        }
        sel[qi] = [...picked];
        state.selections.set(key, sel);
        state.emit();
        break;
      }
      case 'qsend': {
        if (b?.kind !== 'question' || !b.requestId) break;
        const sel = state.selections.get(selKey(it)) ?? [];
        const selections = b.questions.map((_q, qi) => (sel[qi] ?? []).join(', ')).filter(Boolean);
        void actions.run({ action: 'question', requestId: b.requestId, selections }, 'Answer sent', el);
        break;
      }
      case 'send':
        void sendReply(root, row, state, actions, el);
        break;
      default:
        break;
    }
  });

  root.addEventListener('input', (e) => {
    const ta = e.target as HTMLElement;
    if (!(ta instanceof HTMLTextAreaElement) || !ta.matches('.composer__input')) return;
    const id = ta.closest<HTMLElement>('[data-id]')?.dataset.id;
    if (id) state.drafts.set(id, ta.value);
  });

  root.addEventListener('keydown', (e) => {
    const ta = e.target as HTMLElement;
    if (!(ta instanceof HTMLTextAreaElement) || !ta.matches('.composer__input')) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const row = state.row(ta.closest<HTMLElement>('[data-id]')?.dataset.id);
      if (row) void sendReply(root, row, state, actions, root.querySelector<HTMLButtonElement>('[data-act="send"]'));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      ta.blur();
    }
  });
}

async function sendReply(root: HTMLElement, row: Row, state: AppState, actions: Actions, el: HTMLButtonElement | null) {
  const ta = root.querySelector<HTMLTextAreaElement>(`[data-id="${CSS.escape(row.item.surfaceId)}"] .composer__input`);
  const text = ta?.value.trim() ?? '';
  if (!text) {
    ta?.focus();
    return;
  }
  const ok = await actions.run({ action: 'reply', workspaceId: row.item.workspaceId, surfaceId: row.item.surfaceId, text }, `Sent to “${row.item.title}”`, el);
  if (ok) {
    state.drafts.delete(row.item.surfaceId);
    if (ta) ta.value = '';
  }
}
