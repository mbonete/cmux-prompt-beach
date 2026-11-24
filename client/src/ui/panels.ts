import type { Actions } from '../app/actions';
import { morph } from './morph';
import { esc, refreshTimes } from '../app/format';
import { STALE_CHOICES, type AppState, type PanelId, type Row } from '../app/state';
import type { Lane } from '../data/derive';
import { ASK_ICON, LANE_TEXT, stateText, stateTime, summaryOf } from './agentView';
import { KIND_ICON, icon } from './icons';

// The rail's panels, opened over the map on the left: Projects, Agents (the
// keyboard list that works without the 3D view), Inbox, Archive, Settings and
// Help. Each repaints from state; the search box and scroll survive repaints.

export interface PanelNav {
  focusAgent(id: string): void;
  focusPlot(plot: number | 'hangout'): void;
  status(): string;
}

const TITLES: Record<PanelId, string> = {
  projects: 'Projects',
  agents: 'Agents',
  inbox: 'Inbox',
  archive: 'Archive',
  settings: 'Settings',
  help: 'Help',
};

const LANES: Lane[] = ['needs', 'working', 'move', 'stale', 'shells'];
/** Room above a group brought into view from the top bar's counts. */
const REVEAL_GAP = 14;
const LANE_GROUP: Record<Lane, string> = { needs: 'Needs you', working: 'Working', move: 'Your move', stale: 'Stale', shells: 'Terminals without an agent' };

export class Panels {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly tools: HTMLElement;
  private readonly body: HTMLElement;
  private current: PanelId | null = null;
  private html = '';
  private query = '';
  private moving: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly state: AppState,
    private readonly actions: Actions,
    private readonly nav: PanelNav,
  ) {
    this.el = document.createElement('section');
    this.el.className = 'panel';
    this.el.hidden = true;
    this.el.innerHTML = `<header class="panel__head"><h2 class="panel__title" id="panel-title"></h2><button type="button" class="icon-btn" data-panel-close aria-label="Close" title="Close (Esc)">${icon(
      'close',
      'i',
    )}</button></header><div class="panel__tools"></div><div class="panel__body"></div>`;
    this.el.setAttribute('aria-labelledby', 'panel-title');
    parent.appendChild(this.el);
    this.title = this.el.querySelector('.panel__title')!;
    this.tools = this.el.querySelector('.panel__tools')!;
    this.body = this.el.querySelector('.panel__body')!;
    this.bind();
  }

  render() {
    const p = this.state.panel;
    if (!p) {
      this.el.hidden = true;
      this.current = null;
      return;
    }
    if (p !== this.current) {
      this.current = p;
      this.html = '';
      this.moving = null;
      this.el.dataset.panel = p;
      this.title.textContent = TITLES[p];
      this.tools.innerHTML =
        p === 'agents'
          ? `<label class="search">${icon('search', 'i')}<span class="sr">Filter agents</span><input type="search" class="search__input" placeholder="Filter by title, repo or branch" autocomplete="off" spellcheck="false"></label>`
          : '';
      const input = this.tools.querySelector<HTMLInputElement>('input');
      if (input) {
        input.value = this.query;
        input.addEventListener('input', () => {
          this.query = input.value;
          this.render();
        });
      }
      this.el.hidden = false;
      this.body.scrollTop = 0;
      this.el.classList.remove('panel--in');
      void this.el.offsetWidth;
      this.el.classList.add('panel--in');
    }
    const html = this.bodyHTML(p);
    if (html !== this.html) {
      // Patched, not replaced: the list keeps its scroll, focus and any input.
      if (this.html === '') this.body.innerHTML = html;
      else morph(this.body, html);
      this.html = html;
    }
    refreshTimes(this.body);
    for (const el of this.body.querySelectorAll<HTMLElement>('[data-color]')) {
      el.style.setProperty('--repo', el.dataset.color!);
    }
  }

  /** Puts the keyboard in the panel (search box for Agents, else the first row). */
  focusFirst() {
    const target = this.tools.querySelector<HTMLInputElement>('input') ?? this.body.querySelector<HTMLElement>('button, select, input');
    target?.focus();
  }

  /**
   * Brings a lane's group into view from a click on its count: a little
   * below the top of the list (scrollIntoView put its title flush against the
   * edge), then lights the group for a moment so it's clear where you landed.
   * Only the list scrolls. (The light is an animation, not a class: the list
   * is patched on every update, which would strip a class.)
   */
  reveal(lane: string, smooth: boolean) {
    const group = this.body.querySelector<HTMLElement>(`.group--${lane}`);
    if (!group) return;
    const top = group.getBoundingClientRect().top - this.body.getBoundingClientRect().top + this.body.scrollTop - REVEAL_GAP;
    this.body.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    group.animate([{ backgroundColor: 'rgb(255 255 255 / 0.09)' }, { backgroundColor: 'rgb(255 255 255 / 0)' }], {
      duration: 1400,
      delay: smooth ? 250 : 0,
      easing: 'ease-out',
      fill: 'backwards',
    });
  }

  private bodyHTML(p: PanelId): string {
    switch (p) {
      case 'agents':
        return this.agentsHTML();
      case 'inbox':
        return this.inboxHTML();
      case 'projects':
        return this.projectsHTML();
      case 'archive':
        return this.archiveHTML();
      case 'settings':
        return this.settingsHTML();
      case 'help':
        return helpHTML();
    }
  }

  // ------------------------------------------------------------ lists

  private rowHTML(r: Row, rich = false): string {
    const it = r.item;
    const sel = this.state.selected === it.surfaceId;
    const askIcon = r.ask ? icon(ASK_ICON[r.ask], 'i row__ask') : '';
    return `<li><button type="button" class="row row--${r.lane}${r.ask === 'result' ? ' row--done' : ''}${rich ? ' row--rich' : ''}" data-pick="${esc(it.surfaceId)}"${
      sel ? ' aria-current="true"' : ''
    }><span class="row__dot" aria-hidden="true"></span><span class="row__main"><span class="row__title">${esc(it.title)}</span><span class="row__sub">${askIcon}${esc(
      summaryOf(r),
    )}</span></span><span class="row__meta"><span class="row__repo">${esc(it.repo?.name ?? it.project ?? '')}</span>${stateTime(r)}</span><span class="sr">${esc(stateText(r))}</span></button></li>`;
  }

  private agentsHTML(): string {
    const q = this.query.trim().toLowerCase();
    const match = (r: Row) =>
      !q || [r.item.title, r.item.repo?.name, r.item.project, r.item.branch].some((s) => s?.toLowerCase().includes(q));
    let h = '';
    let any = false;
    for (const lane of LANES) {
      const rows = this.state.lane(lane).filter(match);
      if (!rows.length) continue;
      any = true;
      h += `<section class="group group--${lane}"><h3 class="group__title"><span>${LANE_GROUP[lane]}</span><span class="group__count">${rows.length}</span></h3><ul class="rows">${rows
        .map((r) => this.rowHTML(r))
        .join('')}</ul></section>`;
    }
    if (!any) {
      if (q) return `<p class="empty">No session matches “${esc(this.query)}”.</p>`;
      if (!this.state.snap) return '<p class="empty">Waiting for the first update from cmux…</p>';
      return '<p class="empty">No sessions are running in cmux.</p>';
    }
    // cmux lists at most 200 current items; when it holds more, say so rather than hide it.
    const lim = this.state.snap?.limited;
    if (lim) h = `<p class="panel__note">cmux has ${lim.total ? lim.total.toLocaleString('en') : 'more than ' + lim.read} sessions and terminals open; Prompt Beach can read the first ${lim.read}.</p>${h}`;
    return h;
  }

  /** Who needs you (blocked), then finished replies you haven't read. */
  private inboxHTML(): string {
    const needs = this.state.lane('needs');
    const unread = this.state.lane('move').filter((r) => r.ask === 'result');
    if (!needs.length && !unread.length) return '<div class="empty empty--calm"><p class="empty__title">Nobody needs you right now.</p><p>Requests, questions and finished jobs land here as they happen.</p></div>';
    const group = (lane: Lane, title: string, rows: Row[]) =>
      rows.length ? `<section class="group group--${lane}"><h3 class="group__title"><span>${title}</span><span class="group__count">${rows.length}</span></h3><ul class="rows rows--inbox">${rows.map((r) => this.rowHTML(r, true)).join('')}</ul></section>` : '';
    return group('needs', 'Needs you', needs) + group('move', 'Unread', unread);
  }

  private archiveHTML(): string {
    const rows = this.state.archived;
    const note = '<p class="panel__note">Archived sessions are hidden here only; cmux is untouched. One that needs you comes back by itself.</p>';
    if (!rows.length) return `${note}<p class="empty">Nothing archived.</p>`;
    return `${note}<ul class="rows">${rows
      .map(
        (r) =>
          `<li class="row-line">${this.rowHTML(r).replace(/^<li>|<\/li>$/g, '')}<button type="button" class="btn btn--small" data-unarchive="${esc(r.item.agent!.sessionId)}">${icon(
            'restore',
            'i',
          )}<span>Unarchive</span></button></li>`,
      )
      .join('')}</ul>`;
  }

  private projectsHTML(): string {
    const projects = this.state.projects;
    const free = this.state.snap?.world?.free ?? [];
    const rows = [...this.state.rows.values()].filter((r) => !r.item.archived && r.lane !== 'shells');
    const hangout = rows.filter((r) => r.item.plot === 'hangout');
    if (!projects.length && !hangout.length) return '<p class="empty">No projects yet. Each git repository with an agent gets a plot.</p>';
    const sorted = projects.sort((a, b) => Number(b.active) - Number(a.active) || plotOrder(a.plot) - plotOrder(b.plot));
    let h = '<ul class="projects">';
    for (const p of sorted) {
      const mine = rows.filter((r) => r.item.repo?.key === p.key);
      const counts = countLanes(mine);
      // All 32 plots taken: it waits for one, and its people sit at the beach bar.
      const where = p.plot === 'overflow' ? 'Waiting for a plot · at the beach bar' : `Plot ${p.plot + 1}`;
      const status = p.active ? '' : `<span class="project__dormant">No sessions · plot kept until ${keptUntil(p.lastSeen)}</span>`;
      const canMove = free.length > 0 && this.moving !== p.key;
      h += `<li class="project${p.active ? '' : ' project--dormant'}" data-color="${repoHex(p.key)}"><button type="button" class="project__main" data-plot="${p.plot}">${icon(
        KIND_ICON[p.kind] ?? 'branch',
        'i project__icon',
      )}<span class="project__name">${esc(p.name)}</span><span class="project__where">${where}</span></button><div class="project__info">${countsHTML(counts)}${status}${
        canMove ? `<button type="button" class="project__move-open" data-move-open="${esc(p.key)}" title="Move ${esc(p.name)} to a free plot">Move</button>` : ''
      }</div>`;
      if (typeof p.plot === 'number' || p.plot === 'overflow') {
        if (this.moving === p.key) {
          h += `<div class="project__move" role="group" aria-label="Move ${esc(p.name)} to a free plot">${
            free.length
              ? free.map((n) => `<button type="button" class="chip" data-move="${esc(p.key)}" data-to="${n}">Plot ${n + 1}</button>`).join('')
              : '<span class="muted">No free plots.</span>'
          }<button type="button" class="chip chip--quiet" data-move-cancel>Cancel</button></div>`;
        }
      }
      h += '</li>';
    }
    if (hangout.length) {
      h += `<li class="project" data-color="#ffd166"><button type="button" class="project__main" data-plot="hangout">${icon('people', 'i project__icon')}<span class="project__name">Beach bar</span><span class="project__where">Outside any repo</span></button><div class="project__info">${countsHTML(
        countLanes(hangout),
      )}</div></li>`;
    }
    return `${h}</ul>`;
  }

  private settingsHTML(): string {
    const s = this.state.settings;
    const seg = (name: string, label: string, value: string, options: [string, string][], hint = '') =>
      `<div class="field"><span class="field__text"><span class="field__label" id="lbl-${name}">${label}</span>${hint ? `<span class="field__hint">${hint}</span>` : ''}</span><div class="seg" role="radiogroup" aria-labelledby="lbl-${name}">${options
        .map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === value}" data-setting="${name}" data-value="${v}">${l}</button>`)
        .join('')}</div></div>`;
    const toggle = (name: keyof typeof s, label: string, hint: string) =>
      `<div class="field field--toggle"><span class="field__text"><span class="field__label">${label}</span><span class="field__hint">${hint}</span></span><button type="button" role="switch" class="switch" aria-checked="${Boolean(
        s[name],
      )}" data-toggle="${name}" aria-label="${label}"><span class="switch__knob"></span></button></div>`;
    return `<div class="fields">${seg('quality', 'Quality', s.quality, [
      ['auto', 'Auto'],
      ['cinematic', 'Cinematic'],
      ['balanced', 'Balanced'],
      ['light', 'Light'],
    ])}<p class="field__status">${esc(this.nav.status())}</p><div class="field"><label class="field__label" for="stale-after">Stale after</label><select id="stale-after" class="select" data-select="staleAfterMs">${STALE_CHOICES.map(
      (c) => `<option value="${c.ms}"${c.ms === s.staleAfterMs ? ' selected' : ''}>${c.label} without activity</option>`,
    ).join('')}</select></div>${toggle('sound', 'Sound', 'Waves and the city, very quietly.')}${toggle('chime', 'Chime', 'A soft chime when someone starts needing you.')}${toggle(
      'idleCamera',
      'Idle camera',
      'After 2 minutes without input, slow shots of the city that cut to whoever needs you. Needs Keep the city lively.',
    )}${toggle(
      'liveMotion',
      'Keep the city lively',
      'Waves, walkers and the idle camera even when you are not using it. Off, the city holds still after 45 seconds without input and still shows every change, which keeps a laptop cool.',
    )}${seg(
      'motion',
      'Reduced motion',
      s.motion,
      [
        ['system', 'System'],
        ['reduce', 'On'],
        ['full', 'Off'],
      ],
      'For anyone sensitive to motion: the camera cuts instead of flying, and the water, palms, traffic and idle camera hold still. System follows your Mac’s accessibility setting.',
    )}</div>`;
  }

  // ------------------------------------------------------------ input

  private bind() {
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-panel-close]')) return this.state.openPanel(null);
      const pick = t.closest<HTMLElement>('[data-pick]');
      if (pick) return this.nav.focusAgent(pick.dataset.pick!);
      // A whole project row is one target (its title button stays the keyboard focus).
      const row = t.closest<HTMLElement>('.project');
      const plot = t.closest<HTMLElement>('[data-plot]') ?? (row && !t.closest('button') ? row.querySelector<HTMLElement>('[data-plot]') : null);
      if (plot) {
        const v = plot.dataset.plot!;
        return this.nav.focusPlot(v === 'hangout' || v === 'overflow' ? 'hangout' : Number(v));
      }
      const un = t.closest<HTMLButtonElement>('[data-unarchive]');
      if (un) return void this.actions.run({ action: 'unarchive', sessionId: un.dataset.unarchive! }, 'Back from the archive', un);
      const mo = t.closest<HTMLElement>('[data-move-open]');
      if (mo) {
        this.moving = mo.dataset.moveOpen!;
        return this.render();
      }
      if (t.closest('[data-move-cancel]')) {
        this.moving = null;
        return this.render();
      }
      const mv = t.closest<HTMLButtonElement>('[data-move]');
      if (mv) {
        const to = Number(mv.dataset.to);
        void this.actions.run({ action: 'movePlot', repoKey: mv.dataset.move!, plot: to }, `Moved to plot ${to + 1}`, mv).then((ok) => {
          if (ok) {
            this.moving = null;
            this.nav.focusPlot(to);
          }
        });
        return;
      }
      const seg = t.closest<HTMLElement>('[data-setting]');
      if (seg) return this.state.setSettings({ [seg.dataset.setting!]: seg.dataset.value } as never);
      const sw = t.closest<HTMLElement>('[data-toggle]');
      if (sw) {
        const k = sw.dataset.toggle as 'sound' | 'chime' | 'idleCamera';
        return this.state.setSettings({ [k]: !this.state.settings[k] });
      }
    });
    this.el.addEventListener('change', (e) => {
      const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-select]');
      if (sel) this.state.setSettings({ staleAfterMs: Number(sel.value) });
    });
    // Arrow keys walk the rows; Home/End jump.
    this.el.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const rows = [...this.body.querySelectorAll<HTMLElement>('[data-pick], .project__main')];
      if (!rows.length) return;
      const i = rows.indexOf(document.activeElement as HTMLElement);
      const inSearch = (e.target as HTMLElement).matches('.search__input');
      if (i < 0 && !inSearch) return;
      e.preventDefault();
      let next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
      if (inSearch) next = e.key === 'ArrowUp' ? rows.length - 1 : 0;
      rows[Math.max(0, Math.min(rows.length - 1, next))].focus();
    });
  }
}

function plotOrder(p: number | 'overflow') {
  return p === 'overflow' ? 99 : p;
}

function countLanes(rows: Row[]) {
  const c: Partial<Record<Lane, number>> = {};
  for (const r of rows) c[r.lane] = (c[r.lane] ?? 0) + 1;
  return c;
}

function countsHTML(c: Partial<Record<Lane, number>>) {
  const parts = (['needs', 'working', 'move', 'stale'] as Lane[])
    .filter((l) => c[l])
    .map((l) => `<span class="count count--${l}" title="${LANE_TEXT[l]}"><span class="count__dot" aria-hidden="true"></span>${c[l]}<span class="sr"> ${LANE_TEXT[l]}</span></span>`);
  return parts.length ? `<span class="counts">${parts.join('')}</span>` : '';
}

function keptUntil(lastSeen: string | null) {
  const t = lastSeen ? Date.parse(lastSeen) + 7 * 24 * 3600e3 : Date.now();
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Same hash and palette as District.repoColor, as CSS hex. */
const REPO_NEON = ['#2fd8ff', '#ffb347', '#a78bfa', '#5dffa8', '#ff9f6b', '#7dd3fc', '#ffd166', '#d9a4ff', '#34e3c4', '#c4f25a'];
export function repoHex(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return REPO_NEON[Math.abs(h) % REPO_NEON.length];
}

function helpHTML(): string {
  const keys: [string, string][] = [
    ['Drag', 'Move around'],
    ['⇧ Shift + drag · right-drag', 'Turn and tilt'],
    ['Scroll · pinch', 'Zoom toward the pointer'],
    ['Click someone', 'Their card'],
    ['Double-click · F', 'Focus there'],
    ['N', 'Next one who needs you'],
    ['T', 'Cinematic tour (any input ends it)'],
    ['W A S D · arrows', 'Move'],
    ['Q · E', 'Turn'],
    ['+ · −', 'Zoom'],
    ['1 – 6', 'Map, Projects, Agents, Inbox, Archive, Settings'],
    ['/', 'Find an agent'],
    ['Esc', 'Close'],
  ];
  const states: [Lane, string][] = [
    ['needs', 'Waves at you: standing up where there is room, from their seat where there isn\'t. A light beam rises from their plot.'],
    ['working', 'At their desk. A small icon pops up for each tool call.'],
    ['move', 'Relaxing: it finished. A check badge until you read its reply.'],
    ['stale', 'Dozing: nothing for a while (see Settings).'],
  ];
  const badges: [string, string][] = [
    ['key', 'Wants permission to use a tool'],
    ['question', 'Has a question'],
    ['plan', 'A plan to approve'],
    ['terminal', 'Only the terminal can answer'],
    ['result', 'Finished; not read yet'],
  ];
  return `<section class="help"><h3 class="section-title">Controls</h3><dl class="keys">${keys
    .map(([k, v]) => `<div class="keys__row"><dt>${k
      .split(' · ')
      .map((x) => `<kbd>${esc(x)}</kbd>`)
      .join(' ')}</dt><dd>${esc(v)}</dd></div>`)
    .join('')}</dl><h3 class="section-title">States</h3><ul class="legend">${states
    .map(([l, v]) => `<li class="legend__item legend__item--${l}"><span class="row__dot" aria-hidden="true"></span><span><strong>${LANE_TEXT[l]}</strong> ${esc(v)}</span></li>`)
    .join('')}</ul><h3 class="section-title">Badges</h3><ul class="legend">${badges
    .map(([i, v]) => `<li class="legend__item"><span class="mini-badge${i === 'result' ? ' mini-badge--done' : ''}">${icon(i as 'key', 'i')}</span><span>${esc(v)}</span></li>`)
    .join('')}</ul><p class="panel__note">Everything in the city also works from the Agents list and the keyboard. Nothing leaves this computer.</p></section>`;
}
