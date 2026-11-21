import {
  type Color,
  LinearMipmapLinearFilter,
  MeshStandardNodeMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  color,
  float,
  fract,
  fwidth,
  max,
  mix,
  mx_noise_float,
  normalMap,
  positionWorld,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { loading } from '../engine/assets';
import { SEA_Y } from '../city/layout';
import { wetness } from './materials';

// Ground materials from the tiling PBR sets in public/assets/env/textures,
// mapped in world space (metres) so roads, sand and pavers line up across
// meshes. A second, rotated sample at another scale is blended in by a
// low-frequency mask so long surfaces don't show their repeat.

const loader = new TextureLoader(loading);
const cache = new Map<string, Texture>();

function tex(path: string, srgb: boolean): Texture {
  let t = cache.get(path);
  if (!t) {
    t = loader.load(path);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.minFilter = LinearMipmapLinearFilter;
    t.anisotropy = 8;
    cache.set(path, t);
  }
  return t;
}

export interface TextureSet {
  albedo: Texture;
  normal: Texture;
  orm: Texture;
  /** Metres covered by one repeat. */
  size: number;
}

export function textureSet(name: string, size: number, res: '1k' | '2k' = '1k'): TextureSet {
  const base = `/assets/env/textures/${name}/`;
  return {
    albedo: tex(`${base}albedo_${res}.webp`, true),
    normal: tex(`${base}normal_${res}.webp`, false),
    orm: tex(`${base}orm_${res}.webp`, false),
    size,
  };
}

/** Samples a set at world XZ with anti-tiling; returns colour, normal (encoded), and ORM. */
function sampleSet(set: TextureSet) {
  const p = positionWorld.xz;
  const uvA = p.div(set.size);
  // Second sample: rotated ~37°, scaled 0.62×, offset.
  const c = 0.7986;
  const s = 0.6018;
  const uvB = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).div(set.size * 1.61).add(vec2(0.37, 0.71));
  const mask = smoothstep(0.35, 0.65, mx_noise_float(vec3(p.x.mul(0.045), p.y.mul(0.045), 2.7)).mul(0.5).add(0.5));
  const albedo = mix(texture(set.albedo, uvA).rgb, texture(set.albedo, uvB).rgb, mask);
  const nrm = mix(texture(set.normal, uvA).rgb, texture(set.normal, uvB).rgb, mask);
  const orm = mix(texture(set.orm, uvA).rgb, texture(set.orm, uvB).rgb, mask);
  return { albedo, nrm, orm };
}

/** A plain tiled ground material (pavers, concrete, plaster), optionally tinted. */
export function groundMaterial(set: TextureSet, tint?: Color, normalScale = 1) {
  const m = new MeshStandardNodeMaterial({ metalness: 0 });
  const t = sampleSet(set);
  m.colorNode = tint ? t.albedo.mul(color(tint)) : t.albedo;
  m.normalNode = normalMap(t.nrm, vec2(normalScale));
  m.roughnessNode = t.orm.g;
  m.aoNode = t.orm.r;
  return m;
}

/** Beach sand: dry above, darker and glossier in a band just above the waterline. */
export function sandTextured(dry: TextureSet, wet: TextureSet) {
  const m = new MeshStandardNodeMaterial({ metalness: 0 });
  const a = sampleSet(dry);
  const b = sampleSet(wet);
  const band = smoothstep(float(SEA_Y + 0.5), float(SEA_Y + 0.04), positionWorld.y).toVar();
  m.colorNode = mix(a.albedo, b.albedo, band);
  m.normalNode = normalMap(mix(a.nrm, b.nrm, band), vec2(0.9));
  m.roughnessNode = mix(a.orm.g, b.orm.g.mul(0.45), band);
  m.aoNode = a.orm.r;
  return m;
}

/**
 * Asphalt with our lane markings painted on top. Road meshes carry UVs in
 * metres (u along, v across the centre line) and an `aHalfW` attribute.
 */
export function asphaltTextured(set: TextureSet) {
  const m = new MeshStandardNodeMaterial({ metalness: 0 });
  const t = sampleSet(set);
  const u = uv().x;
  const v = uv().y;
  const halfW = attribute('aHalfW', 'float');
  // Painted lines with soft, pixel-width edges (hard steps shimmer as you zoom).
  const aaV = max(fwidth(v), float(0.002));
  const dash = fract(u.div(6));
  const aaU = max(fwidth(u.div(6)), float(0.002));
  const along = smoothstep(float(0.55).add(aaU), float(0.55).sub(aaU), dash).mul(smoothstep(float(0).sub(aaU), aaU, dash));
  const centre = smoothstep(float(0.08).add(aaV), float(0.08).sub(aaV), abs(v)).mul(along);
  const edge = smoothstep(float(0.07).add(aaV), float(0.07).sub(aaV), abs(abs(v).sub(halfW.sub(0.45))));
  const worn = mx_noise_float(vec3(positionWorld.x.mul(1.3), positionWorld.z.mul(1.3), 9)).mul(0.5).add(0.5).mul(0.35).add(0.65);
  const base = t.albedo.mul(0.82);
  const painted = mix(mix(base, vec3(0.75, 0.62, 0.22), centre.mul(worn)), vec3(0.8, 0.8, 0.78), edge.mul(worn));
  const paint = centre.add(edge).min(1);
  m.colorNode = Fn(() => painted.mul(mix(float(1), float(0.6), wetness)))();
  m.normalNode = normalMap(t.nrm, vec2(mix(float(1), float(0.25), paint)));
  const track = smoothstep(0.6, 0.0, abs(abs(v).sub(halfW.mul(0.5))));
  m.roughnessNode = mix(mix(t.orm.g, float(0.6), paint), mix(float(0.3), float(0.1), track), wetness);
  m.aoNode = t.orm.r;
  return m;
}
