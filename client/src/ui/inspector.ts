import type { Actions } from '../app/actions';
import { esc, fmtTokens, inlineMd, md, MODE_LABELS, refreshTimes, shortPath, timeTag } from '../app/format';
import type { AppState, Row } from '../app/state';
import type { Conversation } from '../data/types';
import { askBlock, bindAgentActions, btn, stateLine, whereLine, type AgentHooks } from './agentView';
import { icon } from './icons';

// The side panel: everything about one session. The request and its buttons,
// the recent conversation, the reply box (only while the agent is idle),
// details, and Open in cmux / Mark read / Archive. Regions repaint separately
// so typing a reply or scrolling the conversation survives live updates.

interface ConvoCache {
  version: string;
  data: Conversation | null;
  error: string | null;
  loading: boolean;
}

export class Inspector {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly ask: HTMLElement;
  private readonly convo: HTMLElement;
  private readonly composer: HTMLElement;
  private readonly details: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly scroller: HTMLElement;
  private id: string | null = null;
  private readonly cache = new Map<string, ConvoCache>();
  private readonly html = new WeakMap<HTMLElement, string>();
  private focusReply = false;

  constructor(
    parent: HTMLElement,
    private readonly state: AppState,
    private readonly actions: Actions,
    hooks: AgentHooks,
  ) {
    this.el = document.createElement('aside');
    this.el.className = 'inspector';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Session details');
    this.el.innerHTML = `<header class="inspector__head"></header><div class="inspector__scroll"><section class="inspector__ask"></section><section class="convo" aria-label="Recent conversation"></section><section class="composer-slot"></section><section class="details"></section></div><footer class="inspector__foot"></footer>`;
    parent.appendChild(this.el);
    this.head = this.el.querySelector('.inspector__head')!;
    this.scroller = this.el.querySelector('.inspector__scroll')!;
    this.ask = this.el.querySelector('.inspector__ask')!;
    this.convo = this.el.querySelector('.convo')!;
    this.composer = this.el.querySelector('.composer-slot')!;
    this.details = this.el.querySelector('.details')!;
    this.foot = this.el.querySelector('.inspector__foot')!;
    bindAgentActions(this.el, state, actions, hooks);
  }

  /** Ask the next render to put the cursor in the reply box. */
  wantReply() {
    this.focusReply = true;
  }

  render() {
    const row = this.state.selectedRow;
    if (!row || !this.state.expanded) {
      if (!this.el.hidden) {
        this.el.hidden = true;
        this.el.classList.remove('inspector--in');
      }
      this.id = null;
      return;
    }
    const it = row.item;
    const fresh = this.id !== it.surfaceId;
    if (fresh) {
      this.id = it.surfaceId;
      this.el.dataset.id = it.surfaceId;
      this.composer.innerHTML = '';
      this.html.delete(this.composer);
      this.scroller.scrollTop = 0;
    }
    if (this.el.hidden) {
      this.el.hidden = false;
      void this.el.offsetWidth;
      this.el.classList.add('inspector--in');
    }
    this.el.dataset.lane = row.lane;

    this.set(
      this.head,
      `<div class="inspector__titles"><h2 class="inspector__title">${esc(it.title)}</h2>${whereLine(it)}${stateLine(row)}</div><div class="inspector__tools">${
        `<button type="button" class="icon-btn" data-act="focus" aria-label="Show them in the city" title="Show in the city (F)">${icon('focus', 'i')}</button>` +
        `<button type="button" class="icon-btn" data-act="collapse" aria-label="Back to the card" title="Back to the card">${icon('collapse', 'i')}</button>` +
        `<button type="button" class="icon-btn" data-act="close" aria-label="Close" title="Close (Esc)">${icon('close', 'i')}</button>`
      }</div>`,
    );
    const needsBlock = row.lane === 'needs' || row.lane === 'working' || row.lane === 'shells';
    this.set(this.ask, needsBlock ? askBlock(row, this.state, true) : '');
    this.ask.hidden = !needsBlock;

    this.renderConvo(row, fresh);
    this.renderComposer(row);
    this.set(this.details, this.detailsHTML(row));
    this.afterPaint();

    const footBtns = [btn('jump', 'Open in cmux', { cls: 'btn--primary', icon: 'open' })];
    if (it.unread > 0) footBtns.push(btn('read', 'Mark read', { icon: 'check' }));
    if (it.agent) footBtns.push(it.archived ? btn('unarchive', 'Unarchive', { icon: 'restore' }) : btn('archive', 'Archive', { icon: 'archive', title: 'Hide it here; cmux is untouched' }));
    this.set(this.foot, footBtns.join(''));
    refreshTimes(this.el);
  }

  private set(el: HTMLElement, html: string) {
    if (this.html.get(el) === html) return;
    el.innerHTML = html;
    this.html.set(el, html);
  }

  // -------------------------------------------------------- conversation

  private renderConvo(row: Row, fresh: boolean) {
    const it = row.item;
    if (!it.agent) {
      this.set(this.convo, '');
      this.convo.hidden = true;
      return;
    }
    this.convo.hidden = false;
    const version = `${it.lastPromptAt}|${it.reply?.at}|${it.recap?.at}|${it.phase}`;
    let c = this.cache.get(it.surfaceId);
    if (!c || (c.version !== version && !c.loading)) {
      const prev = c?.data ?? null;
      c = { version, data: prev, error: null, loading: true };
      this.cache.set(it.surfaceId, c);
      const entry = c;
      this.actions.conversation(it.surfaceId).then(
        (data) => {
          entry.data = data;
          entry.loading = false;
          if (this.id === it.surfaceId) this.paintConvo(true);
        },
        (err: Error) => {
          entry.error = err.message || 'Could not load the conversation.';
          entry.loading = false;
          if (this.id === it.surfaceId) this.paintConvo(false);
        },
      );
    }
    if (fresh) this.paintConvo(true);
  }

  private paintConvo(stickToEnd: boolean) {
    const id = this.id;
    const c = id ? this.cache.get(id) : null;
    if (!c) return;
    const atEnd = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 40;
    let h = '<h3 class="section-title">Conversation</h3>';
    if (c.error && !c.data) h += `<p class="muted">${esc(c.error)}</p>`;
    else if (!c.data) h += '<p class="muted convo__loading">Loading the conversation…</p>';
    else if (!c.data.available || !c.data.messages.length) h += '<p class="muted">No conversation to show yet.</p>';
    else {
      if (c.data.truncated) h += '<p class="muted convo__more">Earlier messages are in the terminal.</p>';
      h += '<ol class="convo__list">';
      for (const m of c.data.messages) {
        h += `<li class="msg msg--${m.role}"><div class="msg__meta">${m.role === 'user' ? 'You' : 'Claude'} · ${timeTag(m.at, 'ago')}</div><div class="msg__body md">${
          m.role === 'user' ? `<p>${inlineMd(esc(m.text)).replace(/\n/g, '<br>')}</p>` : md(m.text)
        }</div></li>`;
      }
      h += '</ol>';
    }
    this.set(this.convo, h);
    refreshTimes(this.convo);
    if (stickToEnd && (atEnd || this.scroller.scrollTop === 0) && this.ask.hidden) {
      this.scroller.scrollTop = this.scroller.scrollHeight;
    }
  }

  // -------------------------------------------------------- reply box

  private renderComposer(row: Row) {
    const it = row.item;
    if (!it.agent) {
      this.set(this.composer, '');
      return;
    }
    const idle = it.phase === 'idle';
    let ta = this.composer.querySelector<HTMLTextAreaElement>('.composer__input');
    if (!ta) {
      this.composer.innerHTML = `<form class="composer" data-id="${esc(it.surfaceId)}"><label class="section-title" for="reply-${esc(it.surfaceId)}">Reply</label><textarea class="composer__input" id="reply-${esc(
        it.surfaceId,
      )}" rows="3" maxlength="8000" placeholder="Type to ${esc(it.title)}…"></textarea><div class="composer__row"><p class="composer__note"></p>${btn('send', 'Send', {
        cls: 'btn--primary',
        icon: 'send',
        title: 'Send (⌘ Enter)',
      })}</div></form>`;
      this.html.set(this.composer, this.composer.innerHTML);
      ta = this.composer.querySelector<HTMLTextAreaElement>('.composer__input')!;
      ta.value = this.state.drafts.get(it.surfaceId) ?? '';
      this.composer.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    }
    const send = this.composer.querySelector<HTMLButtonElement>('[data-act="send"]')!;
    const note = this.composer.querySelector<HTMLElement>('.composer__note')!;
    ta.disabled = !idle;
    send.disabled = !idle;
    note.textContent = idle
      ? 'Typed into its prompt and sent. ⌘ Enter sends.'
      : it.phase === 'working'
        ? 'You can reply once it stops working.'
        : 'Answer the request above first.';
    if (this.focusReply && idle) {
      this.focusReply = false;
      requestAnimationFrame(() => {
        ta?.focus();
        this.composer.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  // -------------------------------------------------------- details

  private detailsHTML(row: Row): string {
    const it = row.item;
    const rows: [string, string][] = [];
    if (it.model) rows.push(['Model', `<code>${esc(it.model)}</code>${it.mode ? ` <span class="muted">· ${esc(MODE_LABELS[it.mode] ?? it.mode)}</span>` : ''}`]);
    if (it.contextTokens) rows.push(['Context', `${fmtTokens(it.contextTokens)} tokens`]);
    if (it.cwd) rows.push(['Folder', `<code>${esc(shortPath(it.cwd))}</code>`]);
    if (it.branch) rows.push(['Branch', `<code>${esc(it.branch)}</code>`]);
    if (it.ports.length) rows.push(['Ports', it.ports.map((p) => `<code>${p}</code>`).join(' ')]);
    if (it.turnStartedAt && row.lane === 'working') rows.push(['This turn', timeTag(it.turnStartedAt, 'clock')]);
    if (it.lastActivityAt) rows.push(['Last activity', timeTag(it.lastActivityAt, 'ago')]);
    if (it.here) rows.push(['In cmux', 'Selected right now']);
    let h = `<h3 class="section-title">Details</h3><dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    const bins = it.activity;
    if (bins?.length) {
      const total = bins.reduce((a, b) => a + b, 0);
      const peak = Math.max(1, ...bins);
      h += `<figure class="activity" aria-label="${total} tool calls in the last 3 hours"><div class="activity__bars">${bins
        .map((n) => `<i data-n="${n}" class="${n ? 'on' : ''}" style-h="${Math.round((n / peak) * 100)}"></i>`)
        .join('')}</div><figcaption><span>${total} tool calls</span><span>last 3 hours</span></figcaption></figure>`;
    }
    return h;
  }

  /** Bar heights go through CSSOM (no inline styles under the CSP). */
  private afterPaint() {
    for (const bar of this.details.querySelectorAll<HTMLElement>('.activity__bars i[style-h]')) {
      bar.style.setProperty('--h', `${bar.getAttribute('style-h')}%`);
      bar.removeAttribute('style-h');
    }
  }
}
