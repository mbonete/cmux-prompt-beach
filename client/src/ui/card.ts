import type { Actions } from '../app/actions';
import { morph } from './morph';
import { esc, refreshTimes } from '../app/format';
import type { AppState } from '../app/state';
import { askBlock, bindAgentActions, btn, stateLine, whereLine, type AgentHooks } from './agentView';
import { icon } from './icons';

// The anchored agent card: a compact read of the selected agent next to them in
// the world, with that state's main action and Open in cmux. It follows the
// person on screen, flips sides near an edge, and docks to the right edge when
// they are off screen. Expand hands over to the side panel.

/** Clear space between the person and the card: about a metre (a waving arm) on screen, plus a margin. */
const REACH_M = 1.1;
const GAP_MIN = 56;
const GAP_MAX = 170;
const MARGIN = 14;

export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class AgentCard {
  readonly el: HTMLElement;
  private html = '';
  private id: string | null = null;
  private side: 'right' | 'left' = 'right';

  constructor(
    parent: HTMLElement,
    private readonly state: AppState,
    actions: Actions,
    hooks: AgentHooks,
  ) {
    this.el = document.createElement('article');
    this.el.className = 'card';
    this.el.hidden = true;
    this.el.setAttribute('aria-live', 'polite');
    parent.appendChild(this.el);
    bindAgentActions(this.el, state, actions, hooks);
  }

  /** Repaints from state (only when the markup actually changed). */
  render() {
    const row = this.state.selectedRow;
    const show = Boolean(row) && !this.state.expanded;
    if (!show || !row) {
      this.el.hidden = true;
      this.id = null;
      this.html = '';
      return;
    }
    const it = row.item;
    const html = `<header class="card__head"><div class="card__titles"><h2 class="card__title">${esc(it.title)}</h2>${whereLine(it)}</div>${
      '<button type="button" class="icon-btn" data-act="close" aria-label="Close" title="Close (Esc)">' + icon('close', 'i') + '</button>'
    }</header>${stateLine(row)}<div class="card__body">${askBlock(row, this.state, false)}</div><footer class="card__foot">${btn('jump', 'Open in cmux', {
      icon: 'open',
      cls: 'btn--quiet',
    })}${btn('expand', 'Expand', { icon: 'expand', cls: 'btn--quiet', title: 'Conversation, reply and details' })}</footer>`;
    const entering = this.id !== it.surfaceId;
    this.el.dataset.id = it.surfaceId;
    this.el.dataset.lane = row.lane;
    if (html !== this.html) {
      // Another agent: start fresh. The same one: patch, so scroll, a chosen
      // option, typed text and focus survive the update.
      if (entering) this.el.innerHTML = html;
      else morph(this.el, html);
      this.html = html;
    }
    if (entering) {
      this.id = it.surfaceId;
      this.side = 'right';
      this.el.hidden = false;
      this.el.classList.remove('card--in');
      void this.el.offsetWidth;
      this.el.classList.add('card--in');
    }
    refreshTimes(this.el);
  }

  /**
   * Places the card beside a screen point (the person's head), or docks it when
   * the point is off screen. Called every frame while a card is open.
   */
  /** The gap used at the last placement (the camera framing makes room for it). */
  gap = 72;

  place(anchor: { x: number; y: number; pxPerM?: number } | null, view: { w: number; h: number }, insets: Insets) {
    if (this.el.hidden) return;
    const GAP = anchor?.pxPerM ? Math.round(Math.min(GAP_MAX, Math.max(GAP_MIN, anchor.pxPerM * REACH_M + 18))) : this.gap;
    this.gap = GAP;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const minX = insets.left + MARGIN;
    const maxX = view.w - insets.right - MARGIN - w;
    const minY = insets.top + MARGIN;
    const maxY = view.h - insets.bottom - MARGIN - h;
    let x: number;
    let y: number;
    const docked = !anchor || anchor.x < insets.left || anchor.x > view.w - insets.right || anchor.y < insets.top || anchor.y > view.h - insets.bottom;
    if (docked || !anchor) {
      x = maxX;
      y = Math.max(minY, Math.min(maxY, (view.h - h) / 2));
    } else {
      // Keep the side it's on unless it no longer fits there.
      const fitsRight = anchor.x + GAP + w <= view.w - insets.right - MARGIN;
      const fitsLeft = anchor.x - GAP - w >= minX;
      if (this.side === 'right' && !fitsRight && fitsLeft) this.side = 'left';
      else if (this.side === 'left' && !fitsLeft && fitsRight) this.side = 'right';
      x = this.side === 'right' ? anchor.x + GAP : anchor.x - GAP - w;
      y = anchor.y - Math.min(64, h * 0.3);
      x = Math.max(minX, Math.min(maxX, x));
      y = Math.max(minY, Math.min(maxY, y));
    }
    this.el.classList.toggle('card--docked', docked);
    this.el.classList.toggle('card--left', !docked && this.side === 'left');
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  get open() {
    return !this.el.hidden;
  }
}

