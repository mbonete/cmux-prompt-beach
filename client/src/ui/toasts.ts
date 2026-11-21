import { esc } from '../app/format';
import { icon, type IconName } from './icons';

// Small notices at the top centre: someone needs you, a job finished, an
// action went through or failed. Clicking one that names an agent flies there.
// At most three at once; the oldest goes first.

export type ToastTone = 'needs' | 'done' | 'info' | 'error';

export interface ToastSpec {
  tone: ToastTone;
  icon: IconName;
  text: string;
  /** Shown after the text, quieter. */
  detail?: string;
  onClick?: () => void;
  /** Milliseconds; errors stay a little longer. */
  ttl?: number;
}

const MAX = 3;

export class Toasts {
  readonly root: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'toasts';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  show(spec: ToastSpec) {
    const el = document.createElement(spec.onClick ? 'button' : 'div');
    el.className = `toast toast--${spec.tone}`;
    if (spec.onClick) (el as HTMLButtonElement).type = 'button';
    el.innerHTML = `<span class="toast__icon">${icon(spec.icon, 'i')}</span><span class="toast__text">${esc(spec.text)}${
      spec.detail ? ` <span class="toast__detail">${esc(spec.detail)}</span>` : ''
    }</span>`;
    if (spec.onClick) {
      el.addEventListener('click', () => {
        spec.onClick?.();
        this.dismiss(el);
      });
    }
    this.root.prepend(el);
    while (this.root.children.length > MAX) this.dismiss(this.root.lastElementChild as HTMLElement, true);
    const ttl = spec.ttl ?? (spec.tone === 'error' ? 9000 : 6000);
    let timer = window.setTimeout(() => this.dismiss(el), ttl);
    // Hovering holds a toast so it can be read and clicked.
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => (timer = window.setTimeout(() => this.dismiss(el), 2500)));
  }

  private dismiss(el: HTMLElement, now = false) {
    if (!el.isConnected || el.classList.contains('toast--out')) {
      if (now) el.remove();
      return;
    }
    if (now) {
      el.remove();
      return;
    }
    el.classList.add('toast--out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 400);
  }
}
