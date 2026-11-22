import type { AppState, PanelId } from '../app/state';
import { icon, type IconName } from './icons';

// The fixed frame around the city: the wordmark (top left), the rail of views
// (left), the counts, tour, sound and help (top right), and the
// controls bar (bottom right).

export const RAIL: { id: PanelId | null; label: string; icon: IconName; key: string }[] = [
  { id: null, label: 'Map', icon: 'map', key: '1' },
  { id: 'projects', label: 'Projects', icon: 'building', key: '2' },
  { id: 'agents', label: 'Agents', icon: 'people', key: '3' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', key: '4' },
  { id: 'archive', label: 'Archive', icon: 'archive', key: '5' },
  { id: 'settings', label: 'Settings', icon: 'sliders', key: '6' },
];

export type HintKey = 'pan' | 'rotate' | 'zoom' | 'pick';
const HINTS: { keys: string; text: string }[] = [
  { keys: 'Drag', text: 'to move around' },
  { keys: '⇧ Shift + drag', text: 'to turn' },
  { keys: 'Scroll or pinch', text: 'to zoom' },
  { keys: 'Click a person', text: 'for their card' },
];

export interface HudHooks {
  onRail(id: PanelId | null): void;
  onCount(lane: 'needs' | 'working' | 'move' | 'stale'): void;
  onSound(): void;
  onHelp(): void;
  onTour(): void;
}

export class Hud {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly counts: HTMLElement;
  private readonly sound: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly state: AppState,
    hooks: HudHooks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <header class="brand"><p class="wordmark wordmark--hud" aria-label="Switchboard">Switchboard</p><p class="brand__status" hidden></p></header>
      <nav class="rail" aria-label="Views">${RAIL.map(
        (r) =>
          `<button type="button" class="rail__btn" data-rail="${r.id ?? 'map'}" aria-pressed="false" aria-keyshortcuts="${r.key}" title="${r.label} (${r.key})">${icon(r.icon, 'i')}<span class="rail__label">${r.label}</span>${
            r.id === 'inbox' ? '<span class="rail__badge" hidden></span>' : ''
          }</button>`,
      ).join('')}</nav>
      <div class="topbar">
        <div class="tally" role="group" aria-label="Agents by state"></div>
        <button type="button" class="hud-btn" data-tour aria-pressed="false" aria-keyshortcuts="T" title="Cinematic tour (T)">${icon('film', 'i')}</button>
        <button type="button" class="hud-btn" data-sound aria-pressed="false" title="Sound">${icon('mute', 'i')}</button>
        <button type="button" class="hud-btn" data-help aria-keyshortcuts="Shift+/" title="Help (?)">${icon('help', 'i')}</button>
      </div>
      <aside class="hint" aria-label="Controls"><div class="hint__items">${HINTS.map((h) => `<span class="hint__item"><kbd>${h.keys}</kbd> ${h.text}</span>`).join('')}</div></aside>`;
    parent.appendChild(this.el);
    this.status = this.el.querySelector('.brand__status')!;
    this.rail = this.el.querySelector('.rail')!;
    this.counts = this.el.querySelector('.tally')!;
    this.sound = this.el.querySelector('[data-sound]')!;

    this.rail.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rail]');
      if (b) hooks.onRail(b.dataset.rail === 'map' ? null : (b.dataset.rail as PanelId));
    });
    this.counts.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-lane]');
      if (b) hooks.onCount(b.dataset.lane as 'needs');
    });
    this.sound.addEventListener('click', () => hooks.onSound());
    this.el.querySelector('[data-tour]')!.addEventListener('click', () => hooks.onTour());
    this.el.querySelector('[data-help]')!.addEventListener('click', () => hooks.onHelp());
  }

  render() {
    const s = this.state;
    const c = s.counts;
    for (const b of this.rail.querySelectorAll<HTMLElement>('[data-rail]')) {
      const id = b.dataset.rail === 'map' ? null : b.dataset.rail;
      b.setAttribute('aria-pressed', String(s.panel === id));
    }
    const badge = this.rail.querySelector<HTMLElement>('.rail__badge')!;
    badge.hidden = c.needs === 0;
    badge.textContent = String(c.needs);
    this.rail.querySelector('[data-rail="inbox"]')!.setAttribute('aria-label', c.needs ? `Inbox, ${c.needs} need you` : 'Inbox');

    const tally = (['needs', 'working', 'move', 'stale'] as const)
      .map((l) => {
        const label = { needs: 'need you', working: 'working', move: 'your move', stale: 'stale' }[l];
        return `<button type="button" class="tally__item tally__item--${l}${c[l] ? '' : ' tally__item--zero'}" data-lane="${l}" title="${c[l]} ${label}" aria-label="${c[l]} ${label}"><span class="tally__dot" aria-hidden="true"></span><span class="tally__n">${c[l]}</span></button>`;
      })
      .join('');
    if (this.counts.innerHTML !== tally) this.counts.innerHTML = tally;

    this.sound.setAttribute('aria-pressed', String(s.settings.sound));
    this.sound.innerHTML = icon(s.settings.sound ? 'volume' : 'mute', 'i');
    this.sound.title = s.settings.sound ? 'Sound on' : 'Sound off';
    this.sound.setAttribute('aria-label', this.sound.title);

    // What the wordmark says about the connection.
    let text = '';
    let tone = '';
    if (s.connection === 'retrying') (text = 'Reconnecting…'), (tone = 'warn');
    else if (s.connection === 'offline') (text = 'No server: start it with npm start'), (tone = 'warn');
    else if (s.snap?.cmux && !s.snap.cmux.ok) (text = 'cmux is not answering'), (tone = 'warn');
    else if (s.snap?.demo) (text = 'Demo'), (tone = 'demo');
    this.status.hidden = !text;
    this.status.textContent = text;
    this.status.className = `brand__status${tone ? ` brand__status--${tone}` : ''}`;
    if (s.snap?.cmux?.error) this.status.title = s.snap.cmux.error;

    document.title = c.needs ? `(${c.needs}) Switchboard` : 'Switchboard';
  }

  /** The controls bar is permanent; kept so callers can still report use. */
  used_(_key: HintKey) {}

  /** Shows whether the cinematic tour is running. */
  setTour(on: boolean) {
    const b = this.el.querySelector<HTMLElement>('[data-tour]')!;
    b.setAttribute('aria-pressed', String(on));
  }

  /** The rail button for a panel, to return focus to when it closes. */
  railButton(id: PanelId | null) {
    return this.rail.querySelector<HTMLElement>(`[data-rail="${id ?? 'map'}"]`);
  }
}
