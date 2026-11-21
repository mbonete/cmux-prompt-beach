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
  /** Set right after an upgrade probe: the level to fall back to if it doesn't hold. */
  private probeFrom: QualityLevel | null = null;
  /** How long to wait before the next upgrade probe; doubles after each failed one. */
  private probeWait = 20000;
  /** The best level that has failed, and when; not retried for a while. */
  private ceiling: { level: QualityLevel; at: number } | null = null;

  constructor(public level: QualityLevel = 'balanced') {}

  /**
   * Feed one frame's duration (ms). Returns a new level when it should change.
   * Under vsync a frame never reports spare time, so going up is a probe: after a
   * steady stretch, try the next level, keep it if it holds 60 fps, otherwise
   * step back and wait twice as long before trying again.
   */
  sample(ms: number, now: number): QualityLevel | null {
    this.samples.push(ms);
    const enough = this.probeFrom ? 120 : 90;
    if (this.samples.length < enough || now - this.lastChange < 3000) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.samples = [];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const i = ORDER.indexOf(this.level);
    let next: QualityLevel | null = null;

    if (this.probeFrom) {
      // Judging a probe: it must hold close to 60 fps.
      if (p90 > 19.5) {
        this.ceiling = { level: this.level, at: now };
        next = this.probeFrom;
        this.probeWait = Math.min(this.probeWait * 2, 300000);
      } else this.probeWait = 20000;
      this.probeFrom = null;
    } else if (p75 > 21 && i > 0) {
      next = ORDER[i - 1];
    } else if (p90 < 18 && i < ORDER.length - 1 && now - this.lastChange > this.probeWait) {
      const up = ORDER[i + 1];
      const blocked = this.ceiling && ORDER.indexOf(this.ceiling.level) <= i + 1 && now - this.ceiling.at < this.probeWait;
      if (!blocked) {
        this.probeFrom = this.level;
        next = up;
      }
    }
    if (next) {
      this.level = next;
      this.lastChange = now;
    }
    return next;
  }
}
