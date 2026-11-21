import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  Mesh,
  PMREMGenerator,
  type RenderTarget,
  Scene,
  SphereGeometry,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  dot,
  exp,
  float,
  fog,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  saturate,
  uniform,
} from 'three/tsl';
import { type Look, sunDirection } from './looks';
import type { Sky } from './sky';

// Sun (a directional light whose shadow box follows the camera's focus and is
// snapped to shadow texels so edges don't crawl), a hemisphere fill, image-based
// lighting captured from the sky shader, and height fog that warms toward the sun.

export class Lighting {
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly fogNode;
  private readonly sunDir = new Vector3();
  private readonly pmrem: PMREMGenerator;
  private envTarget: RenderTarget | null = null;
  private readonly envScene = new Scene();
  private envDirty = true;
  private envCooldown = 0;
  private shadowRadius = 60;
  private readonly u = {
    fogColor: uniform(new Color()),
    sunColor: uniform(new Color()),
    sunDir: uniform(new Vector3()),
    density: uniform(0.0015),
    height: uniform(8),
    glow: uniform(1),
  };

  constructor(
    renderer: WebGPURenderer,
    private readonly scene: Scene,
    sky: Sky,
  ) {
    this.sun = new DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    // Slightly soft edges: thin shadows spread over a few texels instead of popping.
    this.sun.shadow.radius = 2.4;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 700;
    scene.add(this.sun, this.sun.target);

    this.hemi = new HemisphereLight(0xbfdcf5, 0xc9b48f, 0.5);
    scene.add(this.hemi);

    // The environment capture uses its own small sky sphere sharing the sky's material.
    const envSky = new Mesh(new SphereGeometry(40, 32, 16), sky.mesh.material);
    this.envScene.add(envSky);
    this.pmrem = new PMREMGenerator(renderer);

    const u = this.u;
    this.fogNode = fog(
      Fn(() => {
        const view = normalize(positionWorld.sub(cameraPosition));
        const toward = pow(saturate(dot(view, u.sunDir)), float(6)).mul(u.glow);
        return mix(u.fogColor, u.sunColor, toward.mul(0.65));
      })(),
      Fn(() => {
        const dist = positionWorld.sub(cameraPosition).length();
        // Thicker near the ground and over the water.
        // Distance haze, with a thin extra layer near the ground; none for the first stretch.
        const lift = exp(max(positionWorld.y, float(-2)).negate().div(u.height)).mul(0.6).add(0.4);
        const far = max(dist.sub(60), float(0));
        return saturate(float(1).sub(exp(far.mul(u.density).mul(lift).negate()))).mul(0.92);
      })(),
    );
    scene.fogNode = this.fogNode;
  }

  setShadowMapSize(size: number) {
    const s = this.sun.shadow;
    if (s.mapSize.x === size) return;
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;
  }

  apply(look: Look) {
    sunDirection(look, this.sunDir);
    this.sun.color.copy(look.sunColor);
    // Below the horizon the "sun" fades out and the hemisphere carries the scene.
    const up = Math.max(0, Math.min(1, (look.sunElevation + 2) / 6));
    this.sun.intensity = look.sunIntensity * up;
    this.sun.castShadow = this.sun.intensity > 0.05;
    this.hemi.color.copy(look.hemiSky);
    this.hemi.groundColor.copy(look.hemiGround);
    this.hemi.intensity = look.hemiIntensity;
    this.scene.environmentIntensity = look.envIntensity;

    const u = this.u;
    u.fogColor.value.copy(look.fogColor);
    u.sunColor.value.copy(look.sunColor).multiplyScalar(1.2);
    u.sunDir.value.copy(this.sunDir);
    u.density.value = look.fogDensity;
    u.height.value = look.fogHeight;
    u.glow.value = up;
    this.envDirty = true;
  }

  /** Keep the shadow box on the area the camera looks at. */
  follow(focus: Vector3, viewRadius: number) {
    // The shadow box size moves in steps (×1.3) with slack, not with every zoom:
    // a size that changes each frame changes the texel size, and every shadow
    // edge in view shimmers.
    const want = Math.min(260, Math.max(30, viewRadius));
    const cur = this.shadowRadius;
    if (!cur || want > cur * 1.12 || want < cur / 1.45) {
      const step = Math.round(Math.log(want / 30) / Math.log(1.3));
      this.shadowRadius = Math.min(260, 30 * Math.pow(1.3, Math.max(0, step)));
    }
    const r = this.shadowRadius;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.updateProjectionMatrix();

    // Snap the focus to shadow texels in light space to stop edge shimmer.
    const texel = (2 * r) / this.sun.shadow.mapSize.x;
    const lightRot = new Matrix4().lookAt(new Vector3(), this.sunDir.clone().negate(), new Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const p = focus.clone().applyMatrix4(inv);
    p.x = Math.round(p.x / texel) * texel;
    p.y = Math.round(p.y / texel) * texel;
    const snapped = p.applyMatrix4(lightRot);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(this.sunDir, 350);
  }

  /** Re-capture the environment map after the look changed (throttled). */
  updateEnvironment(force = false) {
    if (!this.envDirty && !force) return;
    if (this.envCooldown > 0 && !force) {
      this.envCooldown--;
      return;
    }
    this.envDirty = false;
    this.envCooldown = 6;
    const prev = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 100);
    this.scene.environment = this.envTarget.texture;
    prev?.dispose();
  }

  get direction() {
    return this.sunDir;
  }

  dispose() {
    this.envTarget?.dispose();
    this.pmrem.dispose();
  }
}
