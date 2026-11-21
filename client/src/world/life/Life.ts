import type { Camera, Scene } from 'three/webgpu';
import type { Cast } from '../agents/cast';
import type { QualityLevel } from '../engine/quality';

// Background life around the district: street lamps, beach furniture, traffic,
// boats, a helicopter, a blimp and people out walking. None of it is an agent:
// nothing here carries a tag, stands on a plot or can be clicked.
// (Stub: the street-kit work fills this in. World.ts already calls every method.)

export class Life {
  constructor(
    protected readonly scene: Scene,
    protected readonly cast: Cast | null,
  ) {}

  /** Loads the street kit and places everything. Never blocks the city reveal. */
  async load(): Promise<void> {}

  /** Called every rendered frame. `dt` is in seconds, already clamped to 0.1. */
  update(_dt: number, _camera: Camera): void {}

  /** Density and cost follow the quality level (see PRESETS[level].life). */
  setLevel(_level: QualityLevel): void {}

  /** With reduced motion everything holds still (but stays visible). */
  setReducedMotion(_on: boolean): void {}

  /** 0 by day … 1 at night: street lamps, headlights, boat lights. */
  setLamps(_level: number): void {}
}
