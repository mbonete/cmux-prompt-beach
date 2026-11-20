// Quality presets. Auto starts at Balanced and moves one step at a time based on
// measured frame times, never more often than every few seconds.

export type QualityLevel = 'cinematic' | 'balanced' | 'light';
export type QualitySetting = QualityLevel | 'auto';

export interface QualityPreset {
  /** Render resolution as a multiple of CSS pixels (capped by devicePixelRatio). */
  pixelRatio: number;
  shadowMap: number;
  /** Background life density, 0..1. */
  life: number;
}

export const PRESETS: Record<QualityLevel, QualityPreset> = {
  cinematic: { pixelRatio: 1.5, shadowMap: 4096, life: 1 },
  balanced: { pixelRatio: 1.25, shadowMap: 2048, life: 0.7 },
  light: { pixelRatio: 1, shadowMap: 1024, life: 0.35 },
};

const ORDER: QualityLevel[] = ['light', 'balanced', 'cinematic'];

/** Watches frame times and proposes a level change for Auto. */
export class AutoQuality {
  private samples: number[] = [];
  private lastChange = 0;

  constructor(public level: QualityLevel = 'balanced') {}

  /** Feed one frame's duration (ms). Returns a new level when it should change. */
  sample(ms: number, now: number): QualityLevel | null {
    this.samples.push(ms);
    if (this.samples.length < 90 || now - this.lastChange < 4000) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.samples = [];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const i = ORDER.indexOf(this.level);
    let next: QualityLevel | null = null;
    if (p75 > 21 && i > 0) next = ORDER[i - 1];
    else if (p75 < 11.5 && i < ORDER.length - 1 && now - this.lastChange > 15000) next = ORDER[i + 1];
    if (next) {
      this.level = next;
      this.lastChange = now;
    }
    return next;
  }
}
