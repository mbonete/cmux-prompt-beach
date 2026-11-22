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
  let lost: (message: string) => void = () => {};
  try {
    // If the browser's graphics stop answering (a crashed GPU process never
    // resolves), don't wait forever: open the lists instead.
    const stalled = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('the browser’s graphics stopped responding; restarting the browser usually fixes it')), 15000),
    );
    world = await Promise.race([
      World.create(canvas, {
        reducedMotion: reduced,
        quality: settings.quality,
        onLost: (message) => lost(message),
      }),
      stalled,
    ]);
    world.start();
  } catch (err) {
    // No WebGPU or WebGL 2 here: the lists, cards and actions still work.
    console.error(err);
    canvas.hidden = true;
    const fatal = $('fatal');
    fatal.hidden = false;
    fatal.textContent = `The 3D city couldn't start (${err instanceof Error ? err.message : String(err)}). Everything else works from the lists.`;
  }

  const app = new App(root, new SwitchboardClient(), world);
  // The graphics device went away after startup: say so and carry on from the lists.
  lost = (message) => {
    canvas.hidden = true;
    const fatal = $('fatal');
    fatal.hidden = false;
    fatal.textContent = `The 3D city stopped (${message}). Reloading the page usually brings it back; everything else works from the lists.`;
    app.openLists();
  };
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
    try {
      await world.loadCity();
    } catch (err) {
      // A building or skyline file failed to load: stop the 3D, keep everything else
      // (the rail, the lists, the cards) usable instead of a half-hidden page.
      console.error(err);
      world.stop();
      canvas.hidden = true;
      const fatal = $('fatal');
      fatal.hidden = false;
      fatal.textContent = `The 3D city couldn't load (${err instanceof Error ? err.message : String(err)}). Everything else works from the lists.`;
      app.openLists();
    }
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
