import {
  Color,
  DepthTexture,
  FloatType,
  TextureLoader,
  Mesh,
  MeshStandardNodeMaterial,
  NoColorSpace,
  PlaneGeometry,
  RepeatWrapping,
} from 'three/webgpu';
import {
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  distance,
  float,
  Fn,
  length,
  linearDepth,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  normalMap,
  positionLocal,
  positionWorld,
  saturate,
  screenUV,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  viewportDepthTexture,
} from 'three/tsl';
import { BAY_EDGE_X, BEACH, CITY, SEA_Y } from '../city/layout';
import { loading } from '../engine/assets';
import type { Look } from './looks';

// The sea: a PBR surface (so the sun's glitter path and the sky reflection come
// from the real lights), two layers of scrolling FFT wave normals, a gentle swell
// in the vertices, shallow turquoise over the sand, and foam where it meets the
// beach. Depth behind the surface comes from the opaque scene's depth buffer.

export class Ocean {
  readonly mesh: Mesh;
  private readonly u = {
    deep: uniform(new Color(0x18557a)),
    shallow: uniform(new Color(0x3db8b4)),
    motion: uniform(1),
  };

  constructor() {
    const u = this.u;
    // Our FFT wave normals (8 m per repeat), made by tools/assets/env.
    const normals = new TextureLoader(loading).load('/assets/env/textures/water/ocean_normal.webp');
    normals.wrapS = normals.wrapT = RepeatWrapping;
    normals.colorSpace = NoColorSpace;
    normals.anisotropy = 8;
    const t = time.mul(u.motion);

    const geo = new PlaneGeometry(5200, 5200, 260, 260);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -1400);

    const m = new MeshStandardNodeMaterial({ transparent: true, roughness: 0.05, metalness: 0, depthWrite: true });

    // A soft swell: a few long sines, calming toward the beach (in shallow water a
    // big swell would push the waterline back and forth across the sand).
    m.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const swell = sin(p.x.mul(0.045).add(p.z.mul(0.11)).add(t.mul(0.9)))
        .mul(0.09)
        .add(sin(p.x.mul(-0.09).add(p.z.mul(0.07)).add(t.mul(1.3))).mul(0.05))
        .add(sin(p.z.mul(0.2).add(t.mul(1.7))).mul(0.03));
      const nearShore = smoothstep(float(BEACH.zShore - 70), float(BEACH.zShore + 2), p.z);
      p.y.addAssign(swell.mul(mix(float(1), float(0.4), nearShore)));
      return p;
    })();

    // Two scrolling normal layers, blended and faded with distance to avoid shimmer.
    const wp = positionWorld.xz;
    const nA = texture(normals, wp.mul(1 / 21).add(vec2(t.mul(0.011), t.mul(0.006)))).xyz.mul(2).sub(1);
    const nB = texture(normals, wp.mul(1 / 8.5).add(vec2(t.mul(-0.009), t.mul(0.014)))).xyz.mul(2).sub(1);
    const blended = normalize(vec3(nA.x.add(nB.x), nA.y.add(nB.y), nA.z.mul(nB.z)));
    const dist = distance(positionWorld, cameraPosition);
    const fade = smoothstep(600, 40, dist).mul(0.55).add(0.08);
    m.normalNode = normalMap(blended.mul(0.5).add(0.5), vec2(fade));

    // Water thickness in metres along the view ray, from the opaque scene's depth.
    // The renderer uses a reversed float depth buffer, so the copy must be float too.
    // (The third argument, a depth texture, is in three's source but not its types.)
    const depthCopy = (viewportDepthTexture as unknown as (uv: unknown, level: null, tex: DepthTexture) => ReturnType<typeof viewportDepthTexture>)(
      screenUV,
      null,
      new DepthTexture(1, 1, FloatType),
    );
    const sceneDepth = linearDepth(depthCopy);
    const thickness = sceneDepth.sub(linearDepth()).mul(cameraFar.sub(cameraNear)).max(0).toVar();

    // Colour by distance from the island (beach included), not by the depth below:
    // the seabed changes shape where the beach ends and the bays begin, and
    // depth-based colour drew those edges as hard lines on the water. Depth only
    // adds the pale surf right at the waterline, where the sand is continuous.
    const islandCentre = vec2((CITY.x0 + BAY_EDGE_X) / 2, (BEACH.zShore + CITY.z1 + 6) / 2);
    const islandHalf = vec2((BAY_EDGE_X - CITY.x0) / 2, (CITY.z1 + 6 - BEACH.zShore) / 2);
    const q = abs(positionWorld.xz.sub(islandCentre)).sub(islandHalf);
    const coast = length(max(q, vec2(0))).add(min(max(q.x, q.y), float(0)));
    const nearCoast = smoothstep(85, 0, coast).mul(0.9);
    const surf = smoothstep(1.6, 0.1, thickness);
    const shallowness = max(nearCoast, surf);
    const base = mix(u.deep, u.shallow, shallowness).toVar();

    // Shore foam: a soft band at the waterline plus lines running up the sand.
    const n1 = mx_noise_float(vec3(positionWorld.x.mul(0.35), positionWorld.z.mul(0.9), t.mul(0.25))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(positionWorld.x.mul(1.8), positionWorld.z.mul(2.4), t.mul(0.6))).mul(0.5).add(0.5);
    const edge = smoothstep(0.32, 0.0, thickness).mul(n1.mul(0.5).add(0.6));
    const lines = smoothstep(0.88, 0.98, sin(thickness.mul(3.2).sub(t.mul(1.4))).mul(0.5).add(0.5)).mul(smoothstep(1.3, 0.25, thickness)).mul(0.75);
    const foam = saturate(edge.add(lines.mul(n2))).toVar();

    m.colorNode = mix(base, vec3(0.93, 0.95, 0.94), foam);
    m.roughnessNode = mix(float(0.045), float(0.6), foam);
    m.opacityNode = saturate(mix(float(0.5), float(1), smoothstep(0.0, 2.6, thickness)).add(foam));

    this.mesh = new Mesh(geo, m);
    this.mesh.position.y = SEA_Y;
    this.mesh.name = 'ocean';
    // No shadows on the water: with variance shadow maps three also draws every
    // shadow *receiver* into the shadow map, and there this material's depth copy
    // reads the shadow map's own depth buffer (a format mismatch, an error every
    // frame) on top of filling the whole map with a sea-sized plane.
    this.mesh.receiveShadow = false;
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
