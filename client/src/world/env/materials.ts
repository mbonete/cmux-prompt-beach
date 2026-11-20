import { Color, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  float,
  floor,
  fract,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionWorld,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { SEA_Y } from '../city/layout';

// Procedural ground materials. They give the look-dev scene believable surfaces
// before the tiling PBR textures from tools/assets/env arrive, and stay as the
// fallback for the Light quality preset.

const rgb = (hex: number) => {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
};

/** Shared "wetness" for the evening sheen on roads (0 dry, 1 freshly rained). */
export const wetness = uniform(0.0);

export function sandMaterial() {
  const m = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const dry = rgb(0xf2d9b0);
  const wet = rgb(0x9c8467);
  const p = positionWorld;
  // Wind ripples plus large-scale patches.
  const ripples = mx_noise_float(vec3(p.x.mul(0.9), p.z.mul(3.2), 0)).mul(0.5).add(0.5);
  const patches = mx_fractal_noise_float(vec3(p.x.mul(0.03), p.z.mul(0.03), 1), 3, 2, 0.5, 1).mul(0.5).add(0.5);
  // Wet band just above the waterline, darker and glossier.
  const wetBand = smoothstep(float(SEA_Y + 0.45), float(SEA_Y + 0.05), p.y).toVar();
  m.colorNode = mix(dry.mul(patches.mul(0.16).add(0.9)).mul(ripples.mul(0.08).add(0.96)), wet, wetBand);
  m.roughnessNode = mix(float(0.95), float(0.35), wetBand);
  return m;
}

export function grassMaterial() {
  const m = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const p = positionWorld;
  const n = mx_fractal_noise_float(vec3(p.x.mul(0.08), p.z.mul(0.08), 2), 4, 2, 0.5, 1).mul(0.5).add(0.5);
  const fine = mx_noise_float(vec3(p.x.mul(2.5), p.z.mul(2.5), 0)).mul(0.5).add(0.5);
  const a = vec3(0.16, 0.36, 0.1);
  const b = vec3(0.32, 0.5, 0.14);
  m.colorNode = mix(a, b, n).mul(fine.mul(0.18).add(0.88));
  return m;
}

/**
 * Asphalt with lane markings. Road meshes carry UVs in metres: u along the road,
 * v across it from the centre line, plus an `aHalfW` attribute (half width).
 */
export function asphaltMaterial() {
  const m = new MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  const p = positionWorld;
  const u = uv().x;
  const v = uv().y;
  const halfW = attribute('aHalfW', 'float');
  const grain = mx_noise_float(vec3(p.x.mul(6), p.z.mul(6), 0)).mul(0.5).add(0.5);
  const stains = mx_fractal_noise_float(vec3(p.x.mul(0.05), p.z.mul(0.05), 5), 3, 2, 0.5, 1).mul(0.5).add(0.5);
  const base = vec3(0.105, 0.11, 0.12).mul(grain.mul(0.25).add(0.85)).mul(stains.mul(0.35).add(0.8)).toVar();
  // Dashed centre line (warm yellow) and solid white edge lines.
  const centre = step(abs(v), float(0.08)).mul(step(fract(u.div(6)), float(0.55)));
  const edge = step(abs(abs(v).sub(halfW.sub(0.45))), float(0.07));
  const paintWorn = mx_noise_float(vec3(p.x.mul(1.3), p.z.mul(1.3), 9)).mul(0.5).add(0.5);
  const paint = paintWorn.mul(0.35).add(0.65);
  const marked = mix(mix(base, vec3(0.75, 0.62, 0.22), centre.mul(paint)), vec3(0.78, 0.78, 0.76), edge.mul(paint)).toVar();
  // Wet roads at dusk: darker albedo, mirror-ish roughness in the tyre tracks.
  const track = smoothstep(0.6, 0.0, abs(abs(v).sub(halfW.mul(0.5))));
  m.roughnessNode = mix(float(0.82), mix(float(0.32), float(0.12), track), wetness);
  m.colorNode = marked.mul(mix(float(1), float(0.55), wetness));
  return m;
}

/** Warm cream pavers in a running bond, for the promenade and sidewalks. */
export function paverMaterial(tint = 0xe7c7b0) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0 });
  const col = new Color(tint);
  const p = positionWorld;
  const size = vec2(0.6, 0.3);
  const row = floor(p.z.div(size.y));
  const offset = fract(row.mul(0.5)).mul(size.x);
  const cell = vec2(p.x.add(offset).div(size.x), p.z.div(size.y));
  const f = fract(cell);
  const joint = max(smoothstep(0.035, 0.0, f.x).add(smoothstep(0.965, 1.0, f.x)), smoothstep(0.06, 0.0, f.y).add(smoothstep(0.94, 1.0, f.y)));
  const id = floor(cell);
  const tileVar = mx_noise_float(vec3(id.x.mul(7.13), id.y.mul(3.71), 4)).mul(0.5).add(0.5);
  const dirt = mx_fractal_noise_float(vec3(p.x.mul(0.15), p.z.mul(0.15), 8), 3, 2, 0.5, 1).mul(0.5).add(0.5);
  const base = vec3(col.r, col.g, col.b).mul(tileVar.mul(0.14).add(0.9)).mul(dirt.mul(0.12).add(0.92));
  m.colorNode = mix(base, base.mul(0.55), joint.min(1));
  m.roughnessNode = mix(float(0.75), float(0.95), joint.min(1));
  return m;
}

export function stuccoMaterial(tint: number) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  const col = new Color(tint);
  const p = positionWorld;
  const n = mx_fractal_noise_float(vec3(p.x.mul(1.7), p.y.mul(1.7), p.z.mul(1.7)), 3, 2, 0.5, 1).mul(0.5).add(0.5);
  m.colorNode = vec3(col.r, col.g, col.b).mul(n.mul(0.08).add(0.95));
  return m;
}

/** Concrete curbs and seawall faces. */
export function concreteMaterial(tint = 0xd8d2c6) {
  const m = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const col = new Color(tint);
  const p = positionWorld;
  const n = mx_fractal_noise_float(vec3(p.x.mul(0.8), p.y.mul(0.8), p.z.mul(0.8)), 3, 2, 0.5, 1).mul(0.5).add(0.5);
  m.colorNode = vec3(col.r, col.g, col.b).mul(n.mul(0.15).add(0.88));
  return m;
}

