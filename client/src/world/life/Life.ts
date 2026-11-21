import { type Camera, Group, type Scene } from 'three/webgpu';
import type { Cast } from '../agents/cast';
import { PRESETS, type QualityLevel } from '../engine/quality';
import { Air } from './air';
import { Dressing } from './dressing';
import { StreetKit } from './kit';
import { Marine } from './marine';
import { poolMotion } from './pools';
import { Traffic } from './traffic';
import { palmPositions } from './util';
import { Walkers } from './walkers';

// Background life around the district: street lamps, beach furniture, traffic,
// boats, a helicopter, a blimp and people out walking. None of it is an agent:
// nothing here carries a tag, stands on a plot or can be clicked.
//
// Everything is instanced from the street kit (one draw per asset), only movers
// update matrices, and density follows PRESETS[level].life. With reduced motion
// everything holds still where it is.

const MAX_CARS = 40;
const MAX_WALKERS = 10;
const MAX_BATHERS = 4;

export class Life {
  private readonly group = new Group();
  private readonly kit = new StreetKit();
  private dressing: Dressing | null = null;
  private traffic: Traffic | null = null;
  private marine: Marine | null = null;
  private air: Air | null = null;
  private walkers: Walkers | null = null;
  private level: QualityLevel = 'balanced';
  private reduced = false;
  private lamps = 0;

  constructor(
    protected readonly scene: Scene,
    protected readonly cast: Cast | null,
  ) {
    this.group.name = 'life';
    // Life is scenery: never a raycast target.
    this.group.raycast = () => {};
    scene.add(this.group);
  }

  /** Loads the street kit and places everything. Never blocks the city reveal. */
  async load(): Promise<void> {
    await this.kit.load();
    const palms = palmPositions(this.scene);
    const dressing = new Dressing(this.kit, palms);
    const traffic = new Traffic(this.kit);
    const marine = new Marine(this.kit);
    const air = new Air(this.kit);
    await Promise.all([dressing.build(), traffic.build(MAX_CARS), marine.build(), air.build()]);
    for (const part of [dressing, traffic, marine, air]) this.group.add(part.group);
    this.dressing = dressing;
    this.traffic = traffic;
    this.marine = marine;
    this.air = air;
    if (this.cast) {
      const walkers = new Walkers(this.cast, dressing.obstacles, () => dressing.steadyTowels());
      this.group.add(walkers.group);
      this.walkers = walkers;
      walkers.setReducedMotion(this.reduced);
      walkers.build(MAX_WALKERS, MAX_BATHERS);
    }
    this.setLevel(this.level);
    this.setLamps(this.lamps);
  }

  /** Called every rendered frame. `dt` is in seconds, already clamped to 0.1. */
  update(dt: number, camera: Camera): void {
    if (this.reduced) return;
    this.traffic?.update(dt);
    this.marine?.update(dt);
    this.air?.update(dt);
    this.walkers?.update(dt, camera);
  }

  /** Density and cost follow the quality level (see PRESETS[level].life). */
  setLevel(level: QualityLevel): void {
    this.level = level;
    const d = PRESETS[level].life;
    this.dressing?.setDensity(d);
    this.traffic?.setDensity(d);
    this.marine?.setDensity(d);
    this.air?.setDensity(d);
    this.walkers?.setDensity(d);
  }

  /** With reduced motion everything holds still (but stays visible). */
  setReducedMotion(on: boolean): void {
    this.reduced = on;
    poolMotion.value = on ? 0 : 1;
    this.walkers?.setReducedMotion(on);
  }

  /** 0 by day … 1 at night: street lamps, headlights, boat lights. */
  setLamps(level: number): void {
    this.lamps = level;
    const l = this.kit.levels;
    l.lamp.value = Math.pow(level, 1.3);
    l.head.value = 0.08 + 0.92 * level;
    l.tail.value = 0.15 + 0.85 * level;
    this.dressing?.setLamps(level);
    this.traffic?.setLamps(level);
    this.marine?.setLamps(level);
  }
}
