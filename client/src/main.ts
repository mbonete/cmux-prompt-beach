import './styles/base.css';
import './styles/hud.css';
import { App } from './app/App';
import { loadSettings } from './app/state';
import { SwitchboardClient } from './data/client';
import { loading } from './world/engine/assets';
import { World } from './world/World';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function boot() {
  const root = $('app');
  const canvas = $<HTMLCanvasElement>('world');
  const settings = loadSettings();
  const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduced = settings.motion === 'reduce' || (settings.motion === 'system' && systemReduced);
  const note = $('loading-note');

  let world: World | null = null;
  try {
    world = await World.create(canvas, { reducedMotion: reduced, timeOfDay: settings.timeOfDay, quality: settings.quality });
    world.start();
  } catch (err) {
    // No WebGPU or WebGL 2 here: the lists, cards and actions still work.
    console.error(err);
    canvas.hidden = true;
    const fatal = $('fatal');
    fatal.hidden = false;
    fatal.textContent = `The 3D city couldn't start on this device (${err instanceof Error ? err.message : String(err)}). Everything else works from the lists.`;
  }

  const app = new App(root, new SwitchboardClient(), world);
  app.connect();

  if (world) {
    const fill = document.querySelector<HTMLElement>('.loading__fill');
    const bar = document.querySelector<HTMLElement>('.loading__bar');
    loading.onProgress = (_url, done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      bar?.setAttribute('aria-valuenow', String(pct));
      fill?.classList.add('loading__fill--real');
      fill?.style.setProperty('--progress', `${pct}%`);
      note.textContent = `Building the city… ${pct}%`;
    };
    note.textContent = 'Building the city…';
    await world.loadCity();
    // People and background life load lazily after this; their progress doesn't belong on the title screen.
    loading.onProgress = () => {};
  }

  root.classList.add('app--ready');
  $('loading').classList.add('loading--done');
  setTimeout(() => $('loading').remove(), 1000);
  (window as unknown as { switchboard: unknown }).switchboard = { app, world };
}

boot().catch((err) => {
  console.error(err);
  const fatal = $('fatal');
  fatal.hidden = false;
  fatal.textContent = `Switchboard couldn't start: ${err instanceof Error ? err.message : String(err)}`;
  $('loading').classList.add('loading--done');
});
