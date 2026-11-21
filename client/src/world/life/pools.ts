import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { abs, exp, float, instancedBufferAttribute, length, max, mx_noise_float, positionWorld, pow, smoothstep, time, uniform, uv, vec2, vec3 } from 'three/tsl';

// Fake light on the ground: flat additive quads with a soft falloff, one
// instanced draw per kind. No real lights. "round" pools sit under street
// lamps, "beam" pools stretch ahead of headlights, and "wake" draws the foam
// trail behind a moving boat.

type Shape = 'round' | 'beam' | 'wake';
type N = ReturnType<typeof float>;

const up = new Vector3(0, 1, 0);
/** 0 with reduced motion: the wake foam stops shimmering. */
export const poolMotion = uniform(1);
const tmpQ = new Quaternion();
const tmpM = new Matrix4();
const tmpP = new Vector3();
const tmpS = new Vector3();

export class Pools {
  readonly mesh: InstancedMesh;
  readonly level = uniform(0);
  private readonly strength: InstancedBufferAttribute;

  constructor(
    readonly capacity: number,
    shape: Shape,
    tint: Color,
  ) {
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    if (shape !== 'round') geo.translate(0, 0, 0.5); // starts at the origin and runs along +Z
    this.strength = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
    const k = instancedBufferAttribute(this.strength, 'float') as unknown as N;
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    m.fog = false;
    m.toneMapped = true;
    const u = uv();
    let f: N;
    if (shape === 'round') {
      const d = length(u.sub(vec2(0.5, 0.5))).mul(2) as unknown as N;
      f = exp(d.mul(d).mul(-4.2)).mul(smoothstep(1.0, 0.75, d)) as unknown as N;
    } else if (shape === 'beam') {
      // u across, v from the bumper (1 after the rotate) to the far end (0)
      const along = float(1).sub(u.y) as unknown as N;
      const across = abs(u.x.sub(0.5)).mul(2) as unknown as N;
      const width = along.mul(0.75).add(0.25);
      f = smoothstep(0, 0.12, along)
        .mul(pow(float(1).sub(along), 1.6))
        .mul(exp(across.div(width).pow(2).mul(-2.5))) as unknown as N;
    } else {
      const along = float(1).sub(u.y) as unknown as N;
      const across = abs(u.x.sub(0.5)).mul(2) as unknown as N;
      const n = mx_noise_float(vec3(positionWorld.x.mul(0.45), positionWorld.z.mul(0.45), time.mul(poolMotion).mul(0.6))).mul(0.5).add(0.5) as unknown as N;
      const core = exp(across.div(along.mul(0.35).add(0.12)).pow(2).mul(-3)).mul(pow(float(1).sub(along), 1.4));
      const arms = exp(across.sub(along.mul(0.92).add(0.08)).div(0.07).pow(2).mul(-1)).mul(pow(float(1).sub(along), 2.2)).mul(0.7);
      f = max(core, arms).mul(n.mul(0.6).add(0.55)).mul(smoothstep(0, 0.05, along)) as unknown as N;
    }
    m.colorNode = vec3(tint.r, tint.g, tint.b).mul(f).mul(k).mul(this.level);
    this.mesh = new InstancedMesh(geo, m, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = `life/pools-${shape}`;
  }

  /** Places pool i: centre (round) or start point (beam, wake), size, heading (radians about +Y), strength. */
  set(i: number, x: number, y: number, z: number, width: number, len: number, yaw = 0, strength = 1) {
    tmpQ.setFromAxisAngle(up, yaw);
    tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(width, 1, len));
    this.mesh.setMatrixAt(i, tmpM);
    (this.strength.array as Float32Array)[i] = strength;
  }

  set count(n: number) {
    this.mesh.count = Math.min(n, this.capacity);
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.strength.needsUpdate = true;
  }
}
