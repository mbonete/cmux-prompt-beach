import './styles/base.css';
import { World } from './world/World';
import { SwitchboardClient } from './data/client';
import { loading } from './world/engine/assets';
import type { TimeOfDay } from './world/env/looks';
import type { QualitySetting } from './world/engine/quality';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get<T extends string>(key: string, fallback: T): T {
    try {
      return (localStorage.getItem(`switchboard.${key}`) as T) || fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`switchboard.${key}`, value);
    } catch {
      /* private mode: settings just don't persist */
    }
  },
};

async function boot() {
  const canvas = $<HTMLCanvasElement>('world');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const tod = store.get<TimeOfDay>('timeOfDay', 'sunset');
  const quality = store.get<QualitySetting>('quality', 'auto');

  const world = await World.create(canvas, {
    reducedMotion: reduced.matches,
    timeOfDay: tod,
    quality,
    onStatus: (s) => {
      $('stats').textContent = `${s.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} · ${s.quality} · ${Math.round(s.fps)} fps`;
    },
  });
  reduced.addEventListener('change', () => world.setReducedMotion(reduced.matches));
  world.start();

  const fill = document.querySelector<HTMLElement>('.loading__fill');
  const bar = document.querySelector<HTMLElement>('.loading__bar');
  loading.onProgress = (_url, done, total) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    bar?.setAttribute('aria-valuenow', String(pct));
    fill?.classList.add('loading__fill--real');
    fill?.style.setProperty('--progress', `${pct}%`);
    $('loading-note').textContent = `Building the city… ${pct}%`;
  };
  $('loading-note').textContent = 'Building the city…';
  await world.loadCity();

  const client = new SwitchboardClient();
  client.connect({
    onSnapshot: (snap) => world.sync(snap),
    onTick: (t) => world.tick(t),
    onStatus: (st) => {
      if (st === 'restarted') location.reload();
    },
  });

  const lookdev = $('lookdev');
  lookdev.hidden = false;
  const pick = (group: HTMLElement, attr: string, value: string) => {
    for (const b of group.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset[attr] === value));
  };
  pick($('tod'), 'tod', tod);
  pick($('quality'), 'q', quality);
  $('tod').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tod]');
    if (!b) return;
    const v = b.dataset.tod as TimeOfDay;
    world.setTimeOfDay(v);
    store.set('timeOfDay', v);
    pick($('tod'), 'tod', v);
  });
  $('quality').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-q]');
    if (!b) return;
    const v = b.dataset.q as QualitySetting;
    world.setQuality(v);
    store.set('quality', v);
    pick($('quality'), 'q', v);
  });

  $('loading').classList.add('loading--done');
  setTimeout(() => $('loading').remove(), 900);
  (window as unknown as { world: World }).world = world;
}

boot().catch((err) => {
  console.error(err);
  const fatal = $('fatal');
  fatal.hidden = false;
  fatal.textContent = `The 3D view couldn't start: ${err instanceof Error ? err.message : String(err)}`;
  $('loading').classList.add('loading--done');
});
