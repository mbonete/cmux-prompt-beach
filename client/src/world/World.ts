import { ACESFilmicToneMapping, PCFShadowMap, Scene, Timer, Vector3, WebGPURenderer } from 'three/webgpu';
import { CameraRig } from './camera/rig';
import { Pipeline } from './engine/pipeline';
import { AutoQuality, PRESETS, type QualityLevel, type QualitySetting } from './engine/quality';
import { Lighting } from './env/lighting';
import { LOOKS, cloneLook, lookForHour, mixLook, type Look, type TimeOfDay } from './env/looks';
import { wetness } from './env/materials';
import { Ocean } from './env/ocean';
import { Sky } from './env/sky';
import { Palms } from './env/palms';
import { beachHeight, buildGround } from './env/ground';
import { Background } from './city/Background';
import { District, repoColor, type PlotKey, type PlotState } from './city/District';
import { HANGOUT, PLOTS, PLOT_D, PLOT_W, PLOT_X, STREETS_EW, STREETS_NS } from './city/layout';
import { Cast } from './agents/cast';
import { People } from './agents/People';
import { DEFAULT_STALE_MS, laneOf } from '../data/derive';
import type { Snapshot, Tick } from '../data/types';
import { Overlay, type Pin } from '../ui/overlay';
import { KIND_ICON, icon } from '../ui/icons';

export interface WorldOptions {
  reducedMotion: boolean;
  timeOfDay: TimeOfDay;
  quality: QualitySetting;
  onStatus?: (s: WorldStatus) => void;
}

export interface WorldStatus {
  backend: 'webgpu' | 'webgl2';
  quality: QualityLevel;
  fps: number;
}

const LOOK_BLEND_S = 2.4;

export class World {
  readonly scene = new Scene();
  readonly rig: CameraRig;
  private readonly sky = new Sky();
  private readonly ocean = new Ocean();
  private readonly lighting: Lighting;
  private pipeline: Pipeline;
  private readonly timer = new Timer();
  private readonly look: Look = cloneLook(LOOKS.sunset);
  private blend: { from: Look; to: Look; t: number } | null = null;
  private timeOfDay: TimeOfDay;
  private qualitySetting: QualitySetting;
  private level: QualityLevel;
  private readonly auto: AutoQuality;
  readonly district: District;
  private readonly background: Background;
  private staleMs = DEFAULT_STALE_MS;
  private lastSnapshot: Snapshot | null = null;
  readonly overlay: Overlay;
  private readonly cast = new Cast();
  private people: People | null = null;
  private readonly plotTags = new Map<PlotKey, { pin: Pin; key: string }>();
  private lastFrame = 0;
  private fpsFrames = 0;
  private fpsSince = performance.now();
  private fps = 0;
  private reducedMotion: boolean;
  private running = false;
  private autoHourCheck = 0;

  static async create(canvas: HTMLCanvasElement, opts: WorldOptions): Promise<World> {
    const renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    await renderer.init();
    return new World(renderer, canvas, opts);
  }

  private constructor(
    readonly renderer: WebGPURenderer,
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: WorldOptions,
  ) {
    this.reducedMotion = opts.reducedMotion;
    this.timeOfDay = opts.timeOfDay;
    this.qualitySetting = opts.quality;
    this.level = opts.quality === 'auto' ? 'balanced' : opts.quality;
    this.auto = new AutoQuality(this.level);

    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;

    this.rig = new CameraRig(canvas, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.rig.reducedMotion = this.reducedMotion;
    // Plot buildings rise to about 18 m; keep the camera above them when it's over a plot.
    this.rig.clearance = (x, z) =>
      PLOTS.some((p) => Math.abs(x - p.x) < PLOT_W / 2 + 3 && Math.abs(z - p.z) < PLOT_D / 2 + 3) ? 21 : 1.5;

    this.scene.add(this.sky.mesh, this.ocean.mesh, buildGround(), plantPalms().group);
    this.lighting = new Lighting(renderer, this.scene, this.sky);
    this.district = new District(this.scene);
    this.background = new Background(this.scene);
    this.overlay = new Overlay(canvas.parentElement ?? document.body);

    this.applyQuality(this.level);
    this.pipeline = new Pipeline(renderer, this.scene, this.rig.camera, this.level);
    this.setTimeOfDay(this.timeOfDay, true);
    this.setReducedMotion(this.reducedMotion);
    this.resize();

    new ResizeObserver(() => this.resize()).observe(canvas);
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    // Default framing: the district from the land side, the sea and sunset beyond.
    this.rig.flyTo({ target: new Vector3(0, 0, 30), distance: 165 }, 0.01);
  }

  get backend(): 'webgpu' | 'webgl2' {
    const b = this.renderer.backend as { isWebGPUBackend?: boolean };
    return b.isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  setTimeOfDay(tod: TimeOfDay, instant = false) {
    this.timeOfDay = tod;
    const target = tod === 'auto' ? lookForHour(localHour(), cloneLook(LOOKS.day)) : cloneLook(LOOKS[tod]);
    if (instant || this.reducedMotion) {
      mixLook(this.look, target, target, 0);
      this.blend = null;
      this.applyLook();
      this.lighting.updateEnvironment(true);
    } else {
      this.blend = { from: cloneLook(this.look), to: target, t: 0 };
    }
  }

  setQuality(q: QualitySetting) {
    this.qualitySetting = q;
    const level = q === 'auto' ? this.auto.level : q;
    if (level !== this.level) this.rebuildPipeline(level);
  }

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
    this.rig.reducedMotion = on;
    this.sky.setMotion(!on);
    this.ocean.setMotion(!on);
    this.people?.setReducedMotion(on);
  }

  private rebuildPipeline(level: QualityLevel) {
    this.level = level;
    this.applyQuality(level);
    this.pipeline.dispose();
    this.pipeline = new Pipeline(this.renderer, this.scene, this.rig.camera, level);
    this.pipeline.apply(this.look);
    this.resize();
  }

  private applyQuality(level: QualityLevel) {
    const p = PRESETS[level];
    this.lighting.setShadowMapSize(p.shadowMap);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatio));
  }

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
  }

  private applyLook() {
    const l = this.look;
    this.sky.apply(l);
    this.lighting.apply(l);
    this.ocean.apply(l);
    this.pipeline?.apply(l);
    this.renderer.toneMappingExposure = l.exposure;
    wetness.value = Math.max(0, l.lamps - 0.3) * 0.6;
    this.district.windowsLevel.value = 0.25 + l.windows * 0.9;
    this.district.neonLevel.value = 0.3 + l.neon * 1.2;
    this.background.windowsLevel.value = 0.1 + l.windows * 1.0;
    this.background.neonLevel.value = 0.2 + l.neon * 1.1;
    this.district.setNeonLevel(0.55 + l.neon * 0.6);
  }

  private frame(now: number) {
    this.timer.update(now);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);

    // Throttle to ~30 fps while nothing moves and the user is idle.
    const busy = this.rig.moving || this.blend !== null || this.rig.idleMs < 2500;
    if (!busy && now - this.lastFrame < (this.reducedMotion ? 95 : 31)) return;
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;

    if (this.blend) {
      this.blend.t = Math.min(1, this.blend.t + dt / LOOK_BLEND_S);
      const k = this.blend.t * this.blend.t * (3 - 2 * this.blend.t);
      mixLook(this.look, this.blend.from, this.blend.to, k);
      this.applyLook();
      if (this.blend.t >= 1) this.blend = null;
    }
    if (this.timeOfDay === 'auto' && now - this.autoHourCheck > 60000) {
      this.autoHourCheck = now;
      this.setTimeOfDay('auto');
    }

    this.rig.update(dt);
    const cam = this.rig.camera;
    this.sky.follow(cam.position);
    const view = this.rig.current;
    this.lighting.follow(view.target, view.distance * 0.75);
    this.lighting.updateEnvironment();

    this.people?.update(dt, cam);
    this.district.updateCamera(cam.position);
    this.pipeline.render();
    this.overlay.update(cam, this.canvas.clientWidth, this.canvas.clientHeight);

    if (busy && this.qualitySetting === 'auto') {
      const next = this.auto.sample(frameMs, now);
      if (next) this.rebuildPipeline(next);
    }
    this.fpsFrames++;
    if (now - this.fpsSince > 1000) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = now;
      this.opts.onStatus?.({ backend: this.backend, quality: this.level, fps: this.fps });
    }
  }

  /** Loads the buildings and props. */
  async loadCity() {
    const [, , castOk] = await Promise.all([
      this.district.load(),
      this.background.load(),
      this.cast.load().then(
        () => true,
        (err) => (console.warn('No people yet:', err), false),
      ),
    ]);
    if (castOk) {
      this.people = new People(this.scene, this.cast, this.district, this.overlay);
      this.people.setReducedMotion(this.reducedMotion);
    }
    if (this.lastSnapshot) this.sync(this.lastSnapshot);
    this.lighting.updateEnvironment(true);
  }

  setStaleAfter(ms: number) {
    this.staleMs = ms;
    if (this.lastSnapshot) this.sync(this.lastSnapshot);
  }

  /** Applies a server snapshot to the city. */
  sync(snap: Snapshot) {
    this.lastSnapshot = snap;
    const now = Date.now();
    const needsOn = new Set<PlotKey>();
    const busy = new Set<PlotKey>();
    for (const item of snap.items) {
      if (item.phase === 'shell' || item.archived || item.plot === null) continue;
      busy.add(item.plot);
      if (laneOf(item, now, this.staleMs) === 'needs') needsOn.add(item.plot);
    }
    const states: PlotState[] = [];
    for (const [key, p] of Object.entries(snap.world?.plots ?? {})) {
      if (p.plot === 'overflow') continue;
      states.push({ key: p.plot, occupied: true, dormant: !p.active, color: repoColor(key), needs: needsOn.has(p.plot) });
    }
    for (const special of ['hangout', 'overflow'] as const) {
      if (busy.has(special)) states.push({ key: special, occupied: true, dormant: false, color: repoColor(special), needs: needsOn.has(special) });
    }
    this.district.update(states);
    this.syncTags(snap);
    this.people?.sync(snap.items, this.staleMs);
  }

  tick(t: Tick) {
    this.people?.tick(t, this.rig.camera);
  }

  /** Floating name tags over occupied plots: repo name and an icon for its kind. */
  private syncTags(snap: Snapshot) {
    const wanted = new Map<PlotKey, { key: string; name: string; kind: string; dormant: boolean }>();
    for (const [key, p] of Object.entries(snap.world?.plots ?? {})) {
      if (p.plot !== 'overflow') wanted.set(p.plot, { key, name: p.name, kind: p.kind, dormant: !p.active });
    }
    if (snap.items.some((i) => i.plot === 'hangout' && i.phase !== 'shell' && !i.archived)) wanted.set('hangout', { key: 'hangout', name: 'Beach bar', kind: 'other', dormant: false });
    if (snap.items.some((i) => i.plot === 'overflow' && i.phase !== 'shell' && !i.archived)) wanted.set('overflow', { key: 'overflow', name: 'Co-working', kind: 'other', dormant: false });

    for (const [plot, t] of this.plotTags) {
      if (!wanted.has(plot) || wanted.get(plot)!.key !== t.key) {
        this.overlay.remove(t.pin);
        this.plotTags.delete(plot);
      }
    }
    for (const [plot, w] of wanted) {
      let t = this.plotTags.get(plot);
      if (!t) {
        const anchor = this.district.tagAnchor(plot);
        if (!anchor) continue;
        const el = document.createElement('div');
        el.className = 'tag';
        t = { pin: this.overlay.add(el, anchor, { lift: 6, maxDistance: 520 }), key: w.key };
        this.plotTags.set(plot, t);
      }
      const el = t.pin.el;
      const color = repoColor(w.key);
      el.classList.toggle('tag--dormant', w.dormant);
      el.style.setProperty('--repo', `#${color.getHexString()}`);
      const iconName = KIND_ICON[w.kind] ?? 'branch';
      const html = `${icon(iconName, 'i tag__icon')}<span class="tag__name"></span>`;
      if (el.dataset.kind !== iconName) {
        el.innerHTML = html;
        el.dataset.kind = iconName;
      }
      el.querySelector('.tag__name')!.textContent = w.name;
    }
  }
}

/** Palms along the promenade, the street sidewalks and scattered on the beach. */
function plantPalms(): Palms {
  const palms = new Palms();
  const pts: Vector3[] = [];
  let s = 29;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const avenue = (x: number) => STREETS_NS.some((a) => Math.abs(x - a.x) < a.width / 2 + 3);
  // Never on a plot: the terraces belong to the people.
  const onPlot = (x: number) => PLOT_X.some((px) => Math.abs(x - px) < PLOT_W / 2 + 1.5);
  for (let x = -300; x < 120; x += 9) pts.push(new Vector3(x + (r() - 0.5) * 2, 0.16, -15.5 + (r() - 0.5)));
  for (const st of STREETS_EW) {
    for (let x = -150; x < 120; x += 7) {
      const px = x + (r() - 0.5) * 3;
      if (avenue(px) || onPlot(px)) continue;
      pts.push(new Vector3(px, 0.14, st.z - st.width / 2 - 1.1));
      if (!onPlot(px + 8) && !avenue(px + 8)) pts.push(new Vector3(px + 8, 0.14, st.z + st.width / 2 + 1.1));
    }
  }
  for (let i = 0; i < 36; i++) {
    const x = -220 + r() * 330;
    const z = -26 - r() * 22;
    if (Math.abs(x - HANGOUT.x) < 14 && Math.abs(z - HANGOUT.z) < 12) continue;
    pts.push(new Vector3(x, beachHeight(z, x), z));
  }
  palms.plant(pts);
  return palms;
}

function localHour() {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}
