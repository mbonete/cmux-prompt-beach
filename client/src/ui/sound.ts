// Sound, muted by default and synthesised on the spot (no audio files): a low
// wash of waves with a breath of city behind it, and a soft two-note chime when
// someone starts needing you. The context only starts after a click (browsers
// require a gesture), which is always how sound gets switched on.

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: GainNode | null = null;
  private chimeOn = false;
  private ambienceOn = false;
  private lastChime = 0;

  /** Applies the two settings; starting audio is only possible inside a user gesture. */
  set(ambience: boolean, chime: boolean) {
    this.chimeOn = chime;
    this.ambienceOn = ambience;
    if ((ambience || chime) && !this.ctx) this.start();
    if (!this.ctx || !this.ambience) return;
    const now = this.ctx.currentTime;
    this.ambience.gain.cancelScheduledValues(now);
    this.ambience.gain.setTargetAtTime(ambience ? 1 : 0, now, 0.8);
    if (ambience || chime) void this.ctx.resume();
    else {
      // All off: once the waves have faded, stop the audio engine (the noise
      // sources and filters otherwise kept running silently, costing CPU).
      setTimeout(() => {
        if (!this.ambienceOn && !this.chimeOn) void this.ctx?.suspend();
      }, 4000);
    }
  }

  /** A gentle "someone needs you" chime, at most every few seconds. */
  chime() {
    if (!this.chimeOn || !this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime;
    if (t0 - this.lastChime < 4) return;
    this.lastChime = t0;
    const notes = [880, 1318.5];
    notes.forEach((f, i) => this.bell(f, t0 + i * 0.16, i ? 0.16 : 0.2));
  }

  private bell(freq: number, at: number, level: number) {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(level, at + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0008, at + 1.6);
    out.connect(this.master!);
    // A bell-ish tone: the fundamental plus two quieter inharmonic partials.
    for (const [ratio, g] of [
      [1, 1],
      [2.76, 0.28],
      [5.4, 0.08],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * ratio;
      const pg = ctx.createGain();
      pg.gain.value = g;
      o.connect(pg).connect(out);
      o.start(at);
      o.stop(at + 1.7);
    }
  }

  private start() {
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    // Waves: brown-ish noise through a slowly breathing low-pass, panned wide.
    this.ambience = ctx.createGain();
    this.ambience.gain.value = 0;
    this.ambience.connect(this.master);
    const len = ctx.sampleRate * 6;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last * 3.2;
      }
      // Crossfade the ends so the loop has no click.
      const fade = 4000;
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        d[len - fade + i] = d[len - fade + i] * (1 - k) + d[i] * k;
      }
    }
    const waves = (rate: number, cutoff: number, gain: number, pan: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = rate;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      const amp = ctx.createGain();
      amp.gain.value = gain;
      // The swell: a slow LFO on the level, each layer at its own pace.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + Math.random() * 0.05;
      const depth = ctx.createGain();
      depth.gain.value = gain * 0.7;
      lfo.connect(depth).connect(amp.gain);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(lp).connect(amp).connect(p).connect(this.ambience!);
      src.start(0, Math.random() * 5);
      lfo.start();
    };
    waves(1, 520, 0.22, -0.45);
    waves(0.93, 760, 0.16, 0.5);
    // The city: a faint low hum far away.
    waves(0.5, 180, 0.08, 0);
  }
}
