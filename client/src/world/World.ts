import { AgXToneMapping, PCFShadowMap, Scene, Timer, Vector3, WebGPURenderer } from 'three/webgpu';
import { CameraRig } from './camera/rig';
import { Pipeline } from './engine/pipeline';
import { AutoQuality, PRESETS, type QualityLevel, type QualitySetting } from './engine/quality';
import { buildGround } from './env/ground';
import { Lighting } from './env/lighting';
import { LOOKS, cloneLook, lookForHour, mixLook, type Look, type TimeOfDay } from './env/looks';
import { wetness } from './env/materials';
import { Ocean } from './env/ocean';
import { Sky } from './env/sky';
import { buildBackgroundBlocks, buildSkyline, windowsLevel } from './city/blockout';
import { Beam, PlotOutline, STATE_COLORS } from './city/markers';
import { PLOTS } from './city/layout';

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
  private readonly outlines: PlotOutline[] = [];
  private readonly beams: Beam[] = [];
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

    renderer.toneMapping = AgXToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;

    this.rig = new CameraRig(canvas, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.rig.reducedMotion = this.reducedMotion;

    this.scene.add(this.sky.mesh, this.ocean.mesh, buildGround(), buildBackgroundBlocks(), buildSkyline());
    this.lighting = new Lighting(renderer, this.scene, this.sky);
    this.buildLookDevPlots();

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
    windowsLevel.value = l.windows;
    wetness.value = Math.max(0, l.lamps - 0.3) * 0.6;
    for (const o of this.outlines) o.setLevel(0.55 + l.neon * 0.6);
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

    this.pipeline.render();

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

  /** Look-dev only: empty plots with outlines in each state, one with a beam. */
  private buildLookDevPlots() {
    const states = [STATE_COLORS.working, STATE_COLORS.needs, STATE_COLORS.move, STATE_COLORS.stale];
    PLOTS.forEach((p, i) => {
      const o = new PlotOutline();
      const color = states[i % states.length];
      o.setState(color, color === STATE_COLORS.needs, color === STATE_COLORS.stale);
      o.group.position.set(p.x, 0, p.z);
      this.outlines.push(o);
      this.scene.add(o.group);
      if (color === STATE_COLORS.needs && i < 4) {
        const b = new Beam();
        b.set(true);
        b.group.position.set(p.x, 0, p.z);
        this.beams.push(b);
        this.scene.add(b.group);
      }
    });
  }
}

function localHour() {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}
