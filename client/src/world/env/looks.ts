import { Color, MathUtils, Vector3 } from 'three/webgpu';

// The look: everything that sets the mood of the city: sun, sky, fog, water,
// ambient light, practical lights and the colour grade. The city is always at
// sunset. (Day, night, dusk, dawn and "follows your clock" were removed on
// 2026-11-22; they're in the git history if they're ever wanted back.)

export interface Look {
  /** Sun elevation above the horizon, degrees. */
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

export const SUNSET: Look = {
  sunElevation: 11,
  sunAzimuth: -102,
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
  exposure: 1.15,
  windows: 0.55,
  neon: 0.75,
  lamps: 0.35,
  warmth: 0.5,
  saturation: 1.15,
  shadowTint: c(0xc2e2ea),
  highlightTint: c(0xffe2c4),
  vignette: 0.26,
  bloom: 0.2,
};

export function sunDirection(look: Look, out = new Vector3()): Vector3 {
  const el = MathUtils.degToRad(look.sunElevation);
  const az = MathUtils.degToRad(look.sunAzimuth);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
