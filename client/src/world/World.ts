import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  Color,
  type Group,
  MathUtils,
  Mesh,
  MeshBasicNodeMaterial,
  PCFShadowMap,
  type PerspectiveCamera,
  RingGeometry,
  Scene,
  Timer,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { float, sin, time, uniform } from 'three/tsl';
import { CameraRig } from './camera/rig';
import { Pipeline, type PipelineParts } from './engine/pipeline';
import { AutoQuality, PRESETS, type QualityLevel, type QualitySetting } from './engine/quality';
import { Lighting } from './env/lighting';
import { LOOKS, cloneLook, lookForHour, mixLook, type Look, type TimeOfDay } from './env/looks';
import { wetness } from './env/materials';
import { Ocean } from './env/ocean';
import { Sky } from './env/sky';
import { Palms, SHADOW_ONLY_LAYER, wind } from './env/palms';
import { beachHeight, buildGround } from './env/ground';
import { Background } from './city/Background';
import { District, repoColor, type PlotKey, type PlotState } from './city/District';
import { BAY_EDGE_X, CITY, HANGOUT, PLOTS, PLOT_COLUMNS, PLOT_D, PLOT_W, STREETS_EW, STREETS_NS } from './city/layout';
import { Cast } from './agents/cast';
import { People } from './agents/People';
import { Life } from './life/Life';
import { Director } from './director';
import { DEFAULT_STALE_MS, laneOf, type Lane } from '../data/derive';
import type { Snapshot, Tick } from '../data/types';
import { Overlay, type Pin } from '../ui/overlay';
import { KIND_ICON, icon } from '../ui/icons';

export interface WorldOptions {
  reducedMotion: boolean;
  timeOfDay: TimeOfDay;
  quality: QualitySetting;
  onStatus?: (s: WorldStatus) => void;
}

export type Pick = { kind: 'agent'; id: string } | { kind: 'plot'; key: PlotKey } | { kind: 'ground'; x: number; z: number };

const LANE_RING: Record<Lane, Color> = {
  needs: new Color(0xff3f8e),
  working: new Color(0x2fd8ff),
  move: new Color(0x5dffa8),
  stale: new Color(0xa49dbd),
  shells: new Color(0xa49dbd),
};

export interface WorldStatus {
  backend: 'webgpu' | 'webgl2';
  quality: QualityLevel;
  fps: number;
}

const LOOK_BLEND_S = 2.4;
/** Closer than this (metres from what the camera looks at), only the focused plot keeps its label. */
const CLOSE_UP_TAGS = 55;

export class World {
  readonly scene = new Scene();
  readonly rig: CameraRig;
  private readonly sky = new Sky();
  private readonly ocean = new Ocean();
  private readonly ground: Group;
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
  private life: Life | null = null;
  private readonly plotTags = new Map<PlotKey, { pin: Pin; key: string }>();
  private lastFrame = 0;
  private fpsFrames = 0;
  private fpsSince = performance.now();
  private fps = 0;
  private reducedMotion: boolean;
  private running = false;
  private autoHourCheck = 0;
  readonly director: Director;
  private idleCamera = true;
  /** Called after each rendered frame, for HTML that follows the world. */
  onFrame: ((camera: PerspectiveCamera, w: number, h: number, now: number) => void) | null = null;
  /** Clicks in the city: a person, a plot, or open ground. */
  onPick: ((p: Pick) => void) | null = null;
  private selected: string | null = null;
  private readonly ring: Mesh;
  private readonly ringColor = uniform(new Color(0x2fd8ff));
  private hoverNdc: Vector2 | null = null;
  private readonly needsAt: Vector3[] = [];

  /** With `?perf` in the URL: GPU milliseconds per frame (WebGPU timestamp queries), newest last. */
  readonly gpuTimes: number[] = [];
  private readonly perf = new URLSearchParams(location.search).has('perf');

  static async create(canvas: HTMLCanvasElement, opts: WorldOptions): Promise<World> {
    const perf = new URLSearchParams(location.search).has('perf');
    // Reversed depth (float): surfaces a few millimetres apart (a door's glass
    // in front of its leaf, a lit window behind its frame) stay resolved even a
    // few hundred metres away, where a standard depth buffer let them take turns
    // winning, and the AA jitter turned that into flicker.
    const renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', trackTimestamp: perf, reversedDepthBuffer: true });
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
    // Standard (PCF) shadows. Variance shadows looked softer but made three draw
    // every shadow *receiver* into the shadow map too (209 surfaces on top of 67
    // casters, plus two blur passes): about 120 draw calls a frame. PCF draws only
    // casters. Its samples are rotated by a fixed per-pixel pattern, so `radius`
    // (lighting.ts) stays small to keep edges from crawling while the camera moves.
    renderer.shadowMap.type = PCFShadowMap;

    this.rig = new CameraRig(canvas, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.rig.reducedMotion = this.reducedMotion;
    // Keep the camera clear of the buildings (a height map read from their geometry).
    this.rig.obstacle = (x, z) => this.district.heightAt(x, z);

    this.ground = buildGround();
    this.scene.add(this.sky.mesh, this.ocean.mesh, this.ground, plantPalms().group);
    this.lighting = new Lighting(renderer, this.scene, this.sky);
    // The sun also sees shadow-only stand-ins (palm fronds without their alpha test).
    this.lighting.sun.shadow.camera.layers.enable(SHADOW_ONLY_LAYER);
    this.district = new District(this.scene);
    this.background = new Background(this.scene);
    this.overlay = new Overlay(canvas.parentElement ?? document.body);

    // The selection ring at the chosen person's feet.
    const ringMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    ringMat.colorNode = this.ringColor;
    ringMat.opacityNode = float(0.7).add(sin(time.mul(3)).mul(0.25));
    this.ring = new Mesh(new RingGeometry(0.5, 0.66, 48).rotateX(-Math.PI / 2), ringMat);
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.scene.add(this.ring);

    this.director = new Director(this.rig, () => this.needsAt);
    this.rig.onClick = (ndc) => this.handleClick(ndc);
    this.rig.onDoubleClick = (ndc) => this.handleDoubleClick(ndc);
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const r = canvas.getBoundingClientRect();
      this.hoverNdc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverNdc = null;
      this.people?.setHover(null);
      canvas.classList.remove('is-pointing');
    });

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

  setIdleCamera(on: boolean) {
    this.idleCamera = on;
    this.director.enabled = on && !this.reducedMotion;
    if (!this.director.enabled) this.director.stop();
  }

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
    this.rig.reducedMotion = on;
    this.director.enabled = this.idleCamera && !on;
    if (on) this.director.stop();
    this.sky.setMotion(!on);
    this.ocean.setMotion(!on);
    wind.value = on ? 0 : 1;
    this.people?.setReducedMotion(on);
    this.life?.setReducedMotion(on);
  }

  /** With ?perf: rebuild the post-processing without some of its passes, to measure them. */
  perfPipeline(parts: PipelineParts) {
    if (!this.perf) return;
    this.pipeline.dispose();
    this.pipeline = new Pipeline(this.renderer, this.scene, this.rig.camera, this.level, parts);
    this.pipeline.apply(this.look);
    this.resize();
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
    this.life?.setLevel(level);
  }

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
    this.rig.viewHeight = h;
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
    this.district.lampsLevel.value = 0.12 + l.lamps * 1.5;
    this.district.screensLevel.value = 0.35 + l.lamps * 0.9;
    this.life?.setLamps(l.lamps);
  }

  private frame(now: number) {
    this.timer.update(now);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);

    // Every frame while the page is visible (people, water and traffic always
    // move, and a throttled frame rate reads as lag); the loop stops when hidden.
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

    this.director.update(dt);
    this.rig.update(dt);
    const cam = this.rig.camera;
    this.sky.follow(cam.position);
    const view = this.rig.current;
    this.lighting.follow(view.target, view.distance * 0.75);
    this.lighting.updateEnvironment();

    this.people?.update(dt, cam);
    this.life?.update(dt, cam);
    this.district.updateCamera(cam.position);
    this.updateRing();
    this.updateHover();
    this.focusTags();
    this.pipeline.render();
    if (this.perf) {
      void this.renderer.resolveTimestampsAsync('render').then((ms) => {
        if (typeof ms !== 'number') return;
        this.gpuTimes.push(ms);
        if (this.gpuTimes.length > 600) this.gpuTimes.shift();
      });
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.overlay.update(cam, w, h);
    this.onFrame?.(cam, w, h, now);

    if (this.qualitySetting === 'auto' && !document.hidden) {
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
  /** With `?perf`: how long each startup stage took (ms since navigation). */
  private mark(label: string) {
    if (this.perf) console.log(`[switchboard] ${label}: ${Math.round(performance.now())} ms`);
  }

  async loadCity() {
    this.mark('loading the city');
    const timed = <T,>(label: string, pr: Promise<T>) => pr.then((v) => (this.mark(label), v));
    const [, , castOk] = await Promise.all([
      timed('district ready', this.district.load()),
      timed('skylines ready', this.background.load()),
      timed('cast ready', this.cast.load()).then(
        () => true,
        (err) => (console.warn('No people yet:', err), false),
      ),
    ]);
    // Palms the buildings ask for (planters, the trailer's yard, the beach bar).
    if (this.district.palmSpots.length) {
      const plotPalms = new Palms(5);
      plotPalms.plant(
        this.district.palmSpots.map((p) => p.position),
        this.district.palmSpots.map((p) => p.height),
      );
      this.scene.add(plotPalms.group);
    }
    if (castOk) {
      this.people = new People(this.scene, this.cast, this.district, this.overlay);
      this.people.setReducedMotion(this.reducedMotion);
    }
    if (this.lastSnapshot) this.sync(this.lastSnapshot);
    this.mark('people placed');
    this.lighting.updateEnvironment(true);
    this.ocean.bakeSeabed(this.renderer, this.ground);
    this.mark('city built');
    // Build every GPU pipeline now, in parallel and off the main thread, instead of
    // one by one inside the first frames (which froze the page for seconds).
    await this.renderer.compileAsync(this.scene, this.rig.camera).catch(() => {});
    this.mark('shaders compiled');

    // Background life loads after the reveal; the district comes first.
    const life = new Life(this.scene, castOk ? this.cast : null);
    life.setLevel(this.level);
    life.setReducedMotion(this.reducedMotion);
    life.setLamps(this.look.lamps);
    this.life = life;
    life
      .load()
      .then(() => this.renderer.compileAsync(this.scene, this.rig.camera))
      .then(() => this.mark('background life ready'))
      .catch((err) => console.warn('Background life failed to load:', err));
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
      if (p.plot === 'overflow') continue; // waiting for a plot: its people are at the beach bar
      states.push({ key: p.plot, occupied: true, dormant: !p.active, color: repoColor(key), needs: needsOn.has(p.plot) });
    }
    if (busy.has('hangout')) states.push({ key: 'hangout', occupied: true, dormant: false, color: repoColor('hangout'), needs: needsOn.has('hangout') });
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

    for (const [plot, t] of this.plotTags) {
      if (!wanted.has(plot) || wanted.get(plot)!.key !== t.key) {
        this.overlay.remove(t.pin);
        this.plotTags.delete(plot);
      }
    }
    // The 7th agent on a plot and beyond have no spot: the tag shows "+N".
    const extra = new Map<PlotKey, number>();
    for (const i of snap.items) {
      if (i.agent && i.phase !== 'shell' && !i.archived && i.plot !== null && i.spot === null) extra.set(i.plot, (extra.get(i.plot) ?? 0) + 1);
    }
    for (const [plot, w] of wanted) {
      let t = this.plotTags.get(plot);
      if (!t) {
        const anchor = this.district.tagAnchor(plot);
        if (!anchor) continue;
        const el = document.createElement('div');
        el.className = 'tag';
        el.dataset.plot = String(plot);
        t = { pin: this.overlay.add(el, anchor, { lift: 6, maxDistance: 520, kind: 'tag' }), key: w.key };
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
      if (el.querySelector('.tag__name')!.textContent !== w.name) t.pin.size = null;
      el.querySelector('.tag__name')!.textContent = w.name;
      const more = extra.get(plot) ?? 0;
      let moreEl = el.querySelector<HTMLElement>('.tag__more');
      if (more && !moreEl) {
        moreEl = document.createElement('span');
        moreEl.className = 'tag__more';
        el.appendChild(moreEl);
      }
      if (moreEl) {
        if (moreEl.hidden !== !more) t.pin.size = null;
        moreEl.hidden = !more;
        moreEl.textContent = `+${more}`;
        moreEl.title = `${more} more here without a seat`;
      }
    }
  }

  // ------------------------------------------------------------ interaction

  private ndcToPick(ndc: Vector2): Pick | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const id = this.people?.pick(this.rig.camera, ndc, w, h);
    if (id) return { kind: 'agent', id };
    const g = this.rig.groundAt(ndc);
    if (!g) return null;
    const key = this.plotAt(g.x, g.z);
    return key !== null ? { kind: 'plot', key } : { kind: 'ground', x: g.x, z: g.z };
  }

  private handleClick(ndc: Vector2) {
    const p = this.ndcToPick(ndc);
    if (p) this.onPick?.(p);
  }

  private handleDoubleClick(ndc: Vector2) {
    const p = this.ndcToPick(ndc);
    if (!p) return;
    if (p.kind === 'agent') this.focusAgent(p.id);
    else if (p.kind === 'plot') this.focusPlot(p.key);
    else this.rig.flyTo({ target: new Vector3(p.x, 0, p.z), distance: Math.min(this.rig.desired.distance, 70) }, 1.1);
  }

  private plotAt(x: number, z: number): PlotKey | null {
    for (const p of PLOTS) if (Math.abs(x - p.x) < PLOT_W / 2 && Math.abs(z - p.z) < PLOT_D / 2) return p.index;
    if (Math.abs(x - HANGOUT.x) < 10 && Math.abs(z - HANGOUT.z) < 8) return 'hangout';
    return null;
  }

  /**
   * In a close-up only the label of the plot being looked at stays: other
   * projects' labels hang high over their plots, and from close by they slid
   * across the scene with every zoom. They come back as the camera pulls out.
   */
  private focusTags() {
    const v = this.rig.current;
    const closeUp = v.distance < CLOSE_UP_TAGS;
    const here = closeUp ? this.plotAt(v.target.x, v.target.z) : null;
    for (const [plot, t] of this.plotTags) t.pin.visible = !closeUp || plot === here;
  }

  private hoverAt = 0;
  private updateHover() {
    if (!this.people || !this.hoverNdc) return;
    const now = performance.now();
    if (now - this.hoverAt < 60) return;
    this.hoverAt = now;
    const id = this.rig.moving ? null : this.people.pick(this.rig.camera, this.hoverNdc, this.canvas.clientWidth, this.canvas.clientHeight);
    this.people.setHover(id);
    this.canvas.classList.toggle('is-pointing', Boolean(id));
  }

  /** Selects a person in the world: their ring, their name, and the camera follows. */
  select(id: string | null, lane: Lane | null) {
    this.selected = id;
    this.people?.setSelected(id);
    if (lane) this.ringColor.value.copy(LANE_RING[lane]);
    if (!id) this.rig.setFollow(null);
  }

  private updateRing() {
    const pos = this.selected ? this.people?.positionOf(this.selected, this.ring.position) : null;
    this.ring.visible = Boolean(pos);
    if (pos) this.ring.position.y += 0.03;
  }

  /** Flies to a framed close-up of someone and keeps them in frame until the user pans. */
  focusAgent(id: string, seconds = 1.2): boolean {
    const p = this.people?.positionOf(id, new Vector3());
    if (!p) return false;
    this.rig.poke();
    const yaw = this.rig.desired.yaw;
    // Face them from the street side when we're far off; keep the angle when already close.
    const close = this.rig.desired.target.distanceTo(p) < 40 && this.rig.desired.distance < 60;
    this.rig.flyTo({ target: p.clone().setY(0.9), distance: 17, pitch: MathUtils.degToRad(27), yaw: close ? yaw : 0 }, seconds);
    const follow = new Vector3();
    this.rig.setFollow(() => {
      const q = this.people?.positionOf(id, follow);
      return q ? q.setY(0.9) : null;
    });
    return true;
  }

  focusPlot(key: PlotKey) {
    const c = this.district.center(key);
    if (!c) return;
    this.rig.poke();
    this.rig.setFollow(null);
    this.rig.flyTo({ target: c.setY(0), distance: 46, pitch: MathUtils.degToRad(42) }, 1.4);
  }

  flyToGround(x: number, z: number) {
    this.rig.poke();
    this.rig.setFollow(null);
    this.rig.flyTo({ target: new Vector3(x, 0, z) }, 1.0);
  }

  /** The whole district from the land side. */
  overview() {
    this.rig.poke();
    this.rig.setFollow(null);
    this.rig.flyTo({ target: new Vector3(0, 0, 30), distance: 165, pitch: MathUtils.degToRad(40), yaw: 0 }, 1.6);
  }

  private readonly anchorTmp = new Vector3();

  /** Screen position (CSS px) of a steady point above someone, and whether it's in front of the camera. */
  screenOf(id: string, out: { x: number; y: number; behind: boolean; pxPerM?: number }): boolean {
    const at = this.people?.anchorOf(id, this.anchorTmp);
    if (!at) return false;
    const cam = this.rig.camera;
    // How many pixels one metre spans at the person, for spacing HTML around them.
    const h = this.canvas.clientHeight;
    const dist = cam.position.distanceTo(at);
    out.pxPerM = h / (2 * Math.tan(MathUtils.degToRad(cam.fov / 2)) * Math.max(1, dist));
    const v = at.project(cam);
    out.behind = v.z > 1;
    out.x = (v.x * 0.5 + 0.5) * this.canvas.clientWidth;
    out.y = (-v.y * 0.5 + 0.5) * h;
    return true;
  }

  /** Where the people who need you are (for the idle camera). */
  setNeeds(ids: string[]) {
    this.needsAt.length = 0;
    for (const id of ids) {
      const p = this.people?.positionOf(id, new Vector3());
      if (p) this.needsAt.push(p);
    }
  }

  get peoplePositions() {
    return this.people?.positions() ?? [];
  }

  get view() {
    const v = this.rig.current;
    return { x: v.target.x, z: v.target.z, yaw: v.yaw, distance: v.distance };
  }

  get status(): WorldStatus {
    return { backend: this.backend, quality: this.level, fps: this.fps };
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
  const onPlot = (x: number) => PLOT_COLUMNS.some((px) => Math.abs(x - px) < PLOT_W / 2 + 1.5);
  for (let x = CITY.x0 + 4; x < 120; x += 9) pts.push(new Vector3(x + (r() - 0.5) * 2, 0.16, -15.5 + (r() - 0.5)));
  for (const st of STREETS_EW) {
    for (let x = CITY.x0; x < 120; x += 7) {
      const px = x + (r() - 0.5) * 3;
      if (avenue(px) || onPlot(px)) continue;
      pts.push(new Vector3(px, 0.14, st.z - st.width / 2 - 1.1));
      if (!onPlot(px + 8) && !avenue(px + 8)) pts.push(new Vector3(px + 8, 0.14, st.z + st.width / 2 + 1.1));
    }
  }
  for (let i = 0; i < 30; i++) {
    const x = CITY.x0 + 6 + r() * (BAY_EDGE_X - 16 - CITY.x0);
    const z = -26 - r() * 22;
    if (Math.abs(x - HANGOUT.x) < 14 && Math.abs(z - HANGOUT.z) < 12) continue;
    pts.push(new Vector3(x, beachHeight(z, x), z));
  }
  palms.plant(pts, undefined, nearDistrict);
  return palms;
}

/** Where shadows are worth their cost: the district, the promenade and the beach in front of it. */
export function nearDistrict(p: { x: number; z: number }) {
  return p.x > -125 && p.x < 130 && p.z > -75 && p.z < CITY.z1 + 4;
}

function localHour() {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}
