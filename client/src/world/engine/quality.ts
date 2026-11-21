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
// is the level Auto starts at; temporal AA keeps 1.1× crisp enough on a Retina screen.
export const PRESETS: Record<QualityLevel, QualityPreset> = {
  cinematic: { pixelRatio: 1.5, shadowMap: 3072, life: 1 },
  balanced: { pixelRatio: 1.1, shadowMap: 1536, life: 0.55 },
  light: { pixelRatio: 1, shadowMap: 1024, life: 0.35 },
};

const ORDER: QualityLevel[] = ['light', 'balanced', 'cinematic'];

/** Watches frame times and proposes a level change for Auto. */
export class AutoQuality {
  private samples: number[] = [];
  private lastChange = 0;

  constructor(public level: QualityLevel = 'balanced') {}

  /**
   * Feed one frame's duration (ms). Returns a new level when it should change.
   * Auto only ever steps down, after a sustained stretch of slow frames: trying a
   * higher level mid-session switches lighting effects on and off where you can
   * see it. A reload starts again from Balanced.
   */
  sample(ms: number, now: number): QualityLevel | null {
    this.samples.push(ms);
    if (this.samples.length < 120 || now - this.lastChange < 4000) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.samples = [];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const i = ORDER.indexOf(this.level);
    if (p75 > 21 && i > 0) {
      this.level = ORDER[i - 1];
      this.lastChange = now;
      return this.level;
    }
    return null;
  }
}
