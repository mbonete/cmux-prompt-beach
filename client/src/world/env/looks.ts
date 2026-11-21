import { Color, MathUtils, Vector3 } from 'three/webgpu';

// A "look" is everything that changes with the time of day: sun, sky, fog,
// water, ambient light, practical lights and the colour grade. Looks are
// art-directed keyframes; Auto blends between them by the local clock.

export type TimeOfDay = 'day' | 'sunset' | 'night' | 'auto';

export interface Look {
  /** Sun (or moon at night) elevation above the horizon, degrees. */
  sunElevation: number;
  /** Azimuth in degrees: 0 = toward the ocean (−Z), +90 = toward +X. */
  sunAzimuth: number;
  sunColor: Color;
  sunIntensity: number;
  /** Visible sun disk brightness (HDR). 0 hides it (night uses a moon). */
  sunDisk: number;
  moon: number;

  skyZenith: Color;
  skyHorizon: Color;
  /** Haze colour just above the horizon, toward the sun. */
  skyGlow: Color;
  glowStrength: number;
  cloudCover: number;
  cloudLit: Color;
  cloudShade: Color;
  stars: number;

  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  envIntensity: number;

  fogColor: Color;
  /** Distance haze density (per metre). */
  fogDensity: number;
  /** Extra low-lying haze below this height (metres). */
  fogHeight: number;

  seaDeep: Color;
  seaShallow: Color;

  exposure: number;
  /** Practical lights: lit windows, neon, street lamps (0..1). */
  windows: number;
  neon: number;
  lamps: number;

  /** Colour grade, applied in linear light before tone mapping. */
  warmth: number;
  saturation: number;
  shadowTint: Color;
  highlightTint: Color;
  vignette: number;
  bloom: number;
}

const c = (hex: number) => new Color(hex);

export const LOOKS: Record<'day' | 'sunset' | 'night' | 'dusk' | 'dawn', Look> = {
  day: {
    sunElevation: 52,
    sunAzimuth: -38,
    sunColor: c(0xfff1dc),
    sunIntensity: 3.4,
    sunDisk: 18,
    moon: 0,
    skyZenith: c(0x2f7fd6),
    skyHorizon: c(0xbfe3f2),
    skyGlow: c(0xfff3d6),
    glowStrength: 0.35,
    cloudCover: 0.42,
    cloudLit: c(0xffffff),
    cloudShade: c(0xa9bccd),
    stars: 0,
    hemiSky: c(0xbfdcf5),
    hemiGround: c(0xc9b48f),
    hemiIntensity: 0.55,
    envIntensity: 0.9,
    fogColor: c(0xc7e1ee),
    fogDensity: 0.00031,
    fogHeight: 6,
    seaDeep: c(0x0b6f8f),
    seaShallow: c(0x3fd6c6),
    exposure: 0.95,
    windows: 0,
    neon: 0.25,
    lamps: 0,
    warmth: 0.15,
    saturation: 1.12,
    shadowTint: c(0xe4f0ff),
    highlightTint: c(0xfff6ea),
    vignette: 0.18,
    bloom: 0.12,
  },
  sunset: {
    sunElevation: 8,
    sunAzimuth: -66,
    sunColor: c(0xffaa63),
    sunIntensity: 4.4,
    sunDisk: 26,
    moon: 0,
    skyZenith: c(0x2c4a8c),
    skyHorizon: c(0xff9a6b),
    skyGlow: c(0xffc25c),
    glowStrength: 1.15,
    cloudCover: 0.5,
    cloudLit: c(0xffb079),
    cloudShade: c(0x5f5482),
    stars: 0,
    hemiSky: c(0x8db4cf),
    hemiGround: c(0xc98a5e),
    hemiIntensity: 0.42,
    envIntensity: 0.55,
    fogColor: c(0xf0a07a),
    fogDensity: 0.00056,
    fogHeight: 9,
    seaDeep: c(0x18557a),
    seaShallow: c(0x3db8b4),
    exposure: 1.0,
    windows: 0.55,
    neon: 0.75,
    lamps: 0.35,
    warmth: 0.5,
    saturation: 1.28,
    shadowTint: c(0xc2e2ea),
    highlightTint: c(0xffe2c4),
    vignette: 0.26,
    bloom: 0.2,
  },
  dusk: {
    sunElevation: -4,
    sunAzimuth: -18,
    sunColor: c(0xff7a6a),
    sunIntensity: 0.6,
    sunDisk: 0,
    moon: 0,
    skyZenith: c(0x1b1f5c),
    skyHorizon: c(0xd86a8a),
    skyGlow: c(0xff8a6e),
    glowStrength: 0.9,
    cloudCover: 0.45,
    cloudLit: c(0xd27c9c),
    cloudShade: c(0x3a2f62),
    stars: 0.25,
    hemiSky: c(0x5a5aa8),
    hemiGround: c(0x6e4a5c),
    hemiIntensity: 0.55,
    envIntensity: 0.8,
    fogColor: c(0x8a5f8f),
    fogDensity: 0.00063,
    fogHeight: 8,
    seaDeep: c(0x14294f),
    seaShallow: c(0x2a6f86),
    exposure: 1.25,
    windows: 0.9,
    neon: 1,
    lamps: 0.9,
    warmth: 0.1,
    saturation: 1.15,
    shadowTint: c(0xc3c8ff),
    highlightTint: c(0xffd9e6),
    vignette: 0.3,
    bloom: 0.3,
  },
  night: {
    sunElevation: 38,
    sunAzimuth: 32,
    sunColor: c(0x9db8ff),
    sunIntensity: 0.32,
    sunDisk: 0,
    moon: 1,
    skyZenith: c(0x070b22),
    skyHorizon: c(0x2a2452),
    skyGlow: c(0x5b3a74),
    glowStrength: 0.35,
    cloudCover: 0.35,
    cloudLit: c(0x4b4d7a),
    cloudShade: c(0x14152e),
    stars: 1,
    hemiSky: c(0x3a4a8a),
    hemiGround: c(0x2a2238),
    hemiIntensity: 0.45,
    envIntensity: 0.7,
    fogColor: c(0x241f45),
    fogDensity: 0.00049,
    fogHeight: 6,
    seaDeep: c(0x081430),
    seaShallow: c(0x153e57),
    exposure: 1.45,
    windows: 1,
    neon: 1,
    lamps: 1,
    warmth: -0.15,
    saturation: 1.1,
    shadowTint: c(0xb9c6ff),
    highlightTint: c(0xffe6f3),
    vignette: 0.34,
    bloom: 0.38,
  },
  dawn: {
    sunElevation: 7,
    sunAzimuth: 120,
    sunColor: c(0xffc59a),
    sunIntensity: 2.2,
    sunDisk: 18,
    moon: 0,
    skyZenith: c(0x4f6fb8),
    skyHorizon: c(0xf6c1a8),
    skyGlow: c(0xffd7a8),
    glowStrength: 0.8,
    cloudCover: 0.4,
    cloudLit: c(0xffd2b5),
    cloudShade: c(0x8d84a8),
    stars: 0,
    hemiSky: c(0xb9c4e6),
    hemiGround: c(0xc7a58c),
    hemiIntensity: 0.6,
    envIntensity: 0.85,
    fogColor: c(0xe6c2b8),
    fogDensity: 0.00059,
    fogHeight: 10,
    seaDeep: c(0x1c5b7f),
    seaShallow: c(0x48bcb8),
    exposure: 1.0,
    windows: 0.3,
    neon: 0.4,
    lamps: 0.2,
    warmth: 0.3,
    saturation: 1.1,
    shadowTint: c(0xd6e0ff),
    highlightTint: c(0xfff0e0),
    vignette: 0.22,
    bloom: 0.16,
  },
};

/** Keyframes for Auto, in hours of the local day. */
const AUTO_KEYS: [number, keyof typeof LOOKS][] = [
  [0, 'night'],
  [5.2, 'night'],
  [6.3, 'dawn'],
  [8.5, 'day'],
  [17.0, 'day'],
  [18.9, 'sunset'],
  [19.9, 'dusk'],
  [21.0, 'night'],
  [24, 'night'],
];

export function cloneLook(l: Look): Look {
  const out = { ...l } as Look;
  for (const k of Object.keys(l) as (keyof Look)[]) {
    const v = l[k];
    if (v instanceof Color) (out as unknown as Record<string, unknown>)[k] = v.clone();
  }
  return out;
}

/** Blend `a` toward `b` by t into `out` (all three may alias). */
export function mixLook(out: Look, a: Look, b: Look, t: number): Look {
  for (const k of Object.keys(a) as (keyof Look)[]) {
    const va = a[k];
    const vb = b[k];
    if (va instanceof Color && vb instanceof Color) (out[k] as Color).copy(va).lerp(vb, t);
    else if (typeof va === 'number' && typeof vb === 'number') (out as unknown as Record<string, number>)[k] = va + (vb - va) * t;
  }
  // Azimuth crosses large angles between keys: take the short way round.
  out.sunAzimuth = lerpAngle(a.sunAzimuth, b.sunAzimuth, t);
  return out;
}

function lerpAngle(a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

export function lookForHour(hour: number, out: Look): Look {
  for (let i = 0; i < AUTO_KEYS.length - 1; i++) {
    const [h0, k0] = AUTO_KEYS[i];
    const [h1, k1] = AUTO_KEYS[i + 1];
    if (hour >= h0 && hour <= h1) {
      const t = h1 === h0 ? 0 : MathUtils.smoothstep(hour, h0, h1);
      return mixLook(out, LOOKS[k0], LOOKS[k1], t);
    }
  }
  return mixLook(out, LOOKS.night, LOOKS.night, 0);
}

export function sunDirection(look: Look, out = new Vector3()): Vector3 {
  const el = MathUtils.degToRad(look.sunElevation);
  const az = MathUtils.degToRad(look.sunAzimuth);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
