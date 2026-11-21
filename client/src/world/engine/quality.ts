// Quality presets. Auto starts at Balanced and steps down (one level at a time)
// when frames stay slow; it never steps back up mid-session.

export type QualityLevel = 'cinematic' | 'balanced' | 'light';
export type QualitySetting = QualityLevel | 'auto';

export interface QualityPreset {
  /** Render resolution as a multiple of CSS pixels (capped by devicePixelRatio). */
  pixelRatio: number;
  shadowMap: number;
  /** Background life density, 0..1. */
  life: number;
}

// Tuned on a MacBook Air M3 at full window size (2 × 1710 × 896 CSS px): Balanced
// is the level Auto starts at; SMAA keeps 1.1× crisp enough on a Retina screen.
export const PRESETS: Record<QualityLevel, QualityPreset> = {
  cinematic: { pixelRatio: 1.5, shadowMap: 3072, life: 1 },
  balanced: { pixelRatio: 1.1, shadowMap: 1536, life: 0.55 },
  light: { pixelRatio: 1, shadowMap: 1024, life: 0.35 },
};

const ORDER: QualityLevel[] = ['light', 'balanced', 'cinematic'];

/** Watches frame times and proposes a level change for Auto. */
export class AutoQuality {
  private samples: number[] = [];
  /** No judgement in the first seconds (shaders compile, assets stream in). */
  private lastChange = performance.now() + 5000;

  /** Running on battery (where Chrome may cap the frame rate). */
  onBattery = false;

  constructor(public level: QualityLevel = 'balanced') {}

  /**
   * Feed every frame's duration (ms). Returns a new level when it should change.
   * Jank is frames missing vsync, so the test is the share of slow frames: more
   * than 15% over about three seconds steps down one level. Auto never steps back
   * up mid-session (that switched lighting effects on and off where you could
   * see it); a reload starts again from Balanced.
   */
  sample(ms: number, now: number): QualityLevel | null {
    if (now - this.lastChange < 4000) {
      this.samples.length = 0;
      return null;
    }
    this.samples.push(ms);
    if (this.samples.length < 180) return null;
    const slow = this.samples.filter((x) => x > 20).length / this.samples.length;
    // On battery, a steady 30 fps (or 20) is the browser capping the frame rate
    // (Chrome's Energy Saver), not the city being too heavy: a lower quality
    // wouldn't draw any faster, so don't step down. (Plugged in, the same steady
    // 30 fps is a GPU that can't make 60, and stepping down is right.)
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const capped = this.onBattery && p90 - p10 < 4 && [33.3, 50].some((cap) => Math.abs(sorted[sorted.length >> 1] - cap) < 2.5);
    this.samples.length = 0;
    if (capped) return null;
    const i = ORDER.indexOf(this.level);
    if (slow > 0.15 && i > 0) {
      this.level = ORDER[i - 1];
      this.lastChange = now;
      return this.level;
    }
    return null;
  }
}
