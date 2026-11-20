import {
  Color,
  DataTexture,
  LinearMipmapLinearFilter,
  LinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  NoColorSpace,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three/webgpu';
import {
  Fn,
  cameraFar,
  cameraNear,
  cameraPosition,
  distance,
  float,
  linearDepth,
  mix,
  mx_noise_float,
  normalMap,
  normalize,
  positionLocal,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  viewportLinearDepth,
} from 'three/tsl';
import { SEA_Y } from '../city/layout';
import type { Look } from './looks';

// The sea: a PBR surface (so the sun's glitter path and the sky reflection come
// from the real lights), two layers of scrolling wave normals, a gentle swell
// in the vertices, shallow turquoise over the sand, and foam where it meets the
// beach. Depth behind the surface comes from the opaque scene's depth buffer.

/** A tileable wave-normal texture built from integer-frequency sines (no download). */
function waveNormals(size = 256, seed = 7): DataTexture {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const waves = Array.from({ length: 28 }, () => {
    const k = 1 + Math.floor(rnd() * 14);
    const a = rnd() * Math.PI * 2;
    return {
      kx: Math.round(Math.cos(a) * k),
      ky: Math.round(Math.sin(a) * k),
      amp: 1 / Math.pow(k, 1.2),
      phase: rnd() * Math.PI * 2,
    };
  });
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += w.amp * Math.sin(((w.kx * x + w.ky * y) / size) * Math.PI * 2 + w.phase);
      h[y * size + x] = v;
    }
  const data = new Uint8Array(size * size * 4);
  const strength = 3.2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x + size - 1) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const d = h[((y + size - 1) % size) * size + x];
      const u = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (d - u) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class Ocean {
  readonly mesh: Mesh;
  private readonly u = {
    deep: uniform(new Color(0x18557a)),
    shallow: uniform(new Color(0x3db8b4)),
    motion: uniform(1),
  };

  constructor() {
    const u = this.u;
    const normals = waveNormals();
    const t = time.mul(u.motion);

    const geo = new PlaneGeometry(5200, 5200, 260, 260);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -1400);

    const m = new MeshStandardNodeMaterial({ transparent: true, roughness: 0.05, metalness: 0, depthWrite: true });

    // A soft swell: a few long sines, strongest near the camera's area.
    m.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const swell = sin(p.x.mul(0.045).add(p.z.mul(0.11)).add(t.mul(0.9)))
        .mul(0.09)
        .add(sin(p.x.mul(-0.09).add(p.z.mul(0.07)).add(t.mul(1.3))).mul(0.05))
        .add(sin(p.z.mul(0.2).add(t.mul(1.7))).mul(0.03));
      p.y.addAssign(swell);
      return p;
    })();

    // Two scrolling normal layers, blended and faded with distance to avoid shimmer.
    const wp = positionWorld.xz;
    const nA = texture(normals, wp.mul(1 / 64).add(vec2(t.mul(0.008), t.mul(0.004)))).xyz.mul(2).sub(1);
    const nB = texture(normals, wp.mul(1 / 27).add(vec2(t.mul(-0.006), t.mul(0.009)))).xyz.mul(2).sub(1);
    const blended = normalize(vec3(nA.x.add(nB.x), nA.y.add(nB.y), nA.z.mul(nB.z)));
    const dist = distance(positionWorld, cameraPosition);
    const fade = smoothstep(500, 40, dist).mul(0.2).add(0.035);
    m.normalNode = normalMap(blended.mul(0.5).add(0.5), vec2(fade));

    // Water thickness in metres along the view ray, from the opaque scene's depth.
    const thickness = viewportLinearDepth.sub(linearDepth()).mul(cameraFar.sub(cameraNear)).max(0).toVar();

    const shallowness = smoothstep(7, 0.2, thickness);
    const base = mix(u.deep, u.shallow, shallowness).toVar();

    // Shore foam: a soft band at the waterline plus lines running up the sand.
    const n1 = mx_noise_float(vec3(positionWorld.x.mul(0.35), positionWorld.z.mul(0.9), t.mul(0.25))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(positionWorld.x.mul(1.8), positionWorld.z.mul(2.4), t.mul(0.6))).mul(0.5).add(0.5);
    const edge = smoothstep(0.55, 0.0, thickness).mul(n1.mul(0.6).add(0.55));
    const lines = smoothstep(0.86, 0.98, sin(thickness.mul(3.2).sub(t.mul(1.4))).mul(0.5).add(0.5)).mul(smoothstep(2.2, 0.3, thickness));
    const foam = saturate(edge.add(lines.mul(n2))).toVar();

    m.colorNode = mix(base, vec3(0.93, 0.95, 0.94), foam);
    m.roughnessNode = mix(float(0.045), float(0.6), foam);
    m.opacityNode = saturate(mix(float(0.5), float(1), smoothstep(0.0, 2.6, thickness)).add(foam));

    this.mesh = new Mesh(geo, m);
    this.mesh.position.y = SEA_Y;
    this.mesh.name = 'ocean';
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }

  apply(look: Look) {
    this.u.deep.value.copy(look.seaDeep);
    this.u.shallow.value.copy(look.seaShallow);
  }

  setMotion(on: boolean) {
    this.u.motion.value = on ? 1 : 0;
  }
}
