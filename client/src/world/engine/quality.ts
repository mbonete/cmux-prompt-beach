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
    this.samples.length = 0;
    const i = ORDER.indexOf(this.level);
    if (slow > 0.15 && i > 0) {
      this.level = ORDER[i - 1];
      this.lastChange = now;
      return this.level;
    }
    return null;
  }
}
