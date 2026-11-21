import {
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  NoColorSpace,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  RepeatWrapping,
  Scene,
  TextureLoader,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  cameraPosition,
  distance,
  float,
  Fn,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  normalMap,
  positionLocal,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { BAY_EDGE_X, BEACH, CAUSEWAY_END, CITY, SEABED_Y, SEA_Y } from '../city/layout';
import { loading } from '../engine/assets';
import type { Look } from './looks';

// The sea: a PBR surface (so the sun's glitter path and the sky reflection come
// from the real lights), two layers of scrolling FFT wave normals, a gentle swell
// in the vertices, shallow turquoise over the sand, and foam where it meets the
// beach. How deep the water is comes from a height map of everything under it
// (beach, walls, causeways, seabed), drawn once from above at startup: none of it
// moves, so the water never copies the scene's depth mid-frame (which split every
// frame in two), and the foam keeps its width whatever the camera angle.

/** The area the height map covers, and its resolution (metres per texel). */
const SEABED_MAP = { x0: BEACH.x0 - 10, x1: BEACH.x1 + 10, z0: BEACH.zDeep - 10, z1: CAUSEWAY_END + 15, texel: 0.5 };
/** Heights are stored as 0..1 over this range: negative values come out of the bake clamped to 0. */
const HEIGHT_MIN = SEABED_Y - 1;
const HEIGHT_RANGE = 20;
/**
 * The foam and see-through thresholds below were tuned on the depth along the
 * view ray, which from the usual 25-40° camera is about twice the depth straight
 * down; this keeps their look.
 */
const SLANT = 2;

export class Ocean {
  readonly mesh: Mesh;
  /** Height (world y) of whatever is under the water, seen from above. Filled by bakeSeabed(). */
  private readonly seabed: RenderTarget;
  private readonly u = {
    deep: uniform(new Color(0x18557a)),
    shallow: uniform(new Color(0x3db8b4)),
    motion: uniform(1),
  };

  constructor() {
    const u = this.u;
    const M = SEABED_MAP;
    this.seabed = new RenderTarget(Math.round((M.x1 - M.x0) / M.texel), Math.round((M.z1 - M.z0) / M.texel), { type: HalfFloatType, depthBuffer: true });
    this.seabed.texture.minFilter = this.seabed.texture.magFilter = LinearFilter;
    this.seabed.texture.generateMipmaps = false;
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

    // How deep the water is here, from the baked height map (plain seabed outside it).
    const mapUv = vec2(positionWorld.x.sub(M.x0).div(M.x1 - M.x0), positionWorld.z.sub(M.z0).div(M.z1 - M.z0));
    const inMap = step(0, mapUv.x).mul(step(mapUv.x, 1)).mul(step(0, mapUv.y)).mul(step(mapUv.y, 1));
    const floorY = mix(float(SEABED_Y), texture(this.seabed.texture, mapUv).r.mul(HEIGHT_RANGE).add(HEIGHT_MIN), inMap);
    const thickness = positionWorld.y.sub(floorY).max(0).mul(SLANT).toVar();

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
    // Receives shadows (palms near the shore). With standard shadows only casters
    // are drawn into the shadow map, so this costs nothing there.
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }

  /**
   * Draws the height of everything in `ground` (seen straight down) into the
   * height map. Once, after the ground is built; nothing under the water moves.
   */
  bakeSeabed(renderer: WebGPURenderer, ground: Object3D) {
    const M = SEABED_MAP;
    const w = M.x1 - M.x0;
    const d = M.z1 - M.z0;
    const cam = new OrthographicCamera(-w / 2, w / 2, d / 2, -d / 2, 1, 600);
    cam.position.set((M.x0 + M.x1) / 2, 300, (M.z0 + M.z1) / 2);
    // Looking down with -z up: x runs left to right, z0 lands on the first row, which
    // three samples at v = 0 for render targets (checked against the shoreline).
    cam.up.set(0, 0, -1);
    cam.lookAt((M.x0 + M.x1) / 2, 0, (M.z0 + M.z1) / 2);
    cam.updateMatrixWorld();

    const height = new MeshBasicNodeMaterial();
    height.colorNode = vec3(saturate(positionWorld.y.sub(HEIGHT_MIN).div(HEIGHT_RANGE)));
    height.fog = false;
    const scene = new Scene();
    scene.overrideMaterial = height;
    const parent = ground.parent;
    scene.add(ground); // the seabed plane in it covers every texel
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.seabed);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    parent?.add(ground);
    height.dispose();
  }

  apply(look: Look) {
    this.u.deep.value.copy(look.seaDeep);
    this.u.shallow.value.copy(look.seaShallow);
  }

  setMotion(on: boolean) {
    this.u.motion.value = on ? 1 : 0;
  }
}
