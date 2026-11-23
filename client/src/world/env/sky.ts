import { BackSide, Color, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import {
  Fn,
  abs,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  mx_cell_noise_float,
  normalize,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import { worldTime as time } from '../engine/clock';
import { type Look, sunDirection } from './looks';

// An art-directed sky dome: a zenith-to-horizon gradient, a warm glow and a
// horizon band toward the sun, a sun (or moon) disk, a drifting cloud deck lit
// from the sun's side, and twinkling stars at night. It follows the camera, and
// the same mesh is rendered into the environment map for image-based lighting.

export class Sky {
  readonly mesh: Mesh;
  private readonly u = {
    sunDir: uniform(new Vector3(0, 0.1, -1)),
    zenith: uniform(new Color()),
    horizon: uniform(new Color()),
    glow: uniform(new Color()),
    glowStrength: uniform(1),
    sunColor: uniform(new Color()),
    sunDisk: uniform(10),
    moon: uniform(0),
    cloudCover: uniform(0.5),
    cloudLit: uniform(new Color()),
    cloudShade: uniform(new Color()),
    stars: uniform(0),
    /** 0 in the environment capture so clouds don't flicker the lighting. */
    motion: uniform(1),
  };

  constructor(radius = 4500) {
    const u = this.u;
    const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });

    material.colorNode = Fn(() => {
      const dir = normalize(positionWorld.sub(cameraPosition)).toVar();
      const e = dir.y;
      const up = saturate(e);

      // Base gradient; below the horizon fade into a warm sea haze.
      const grad = mix(u.horizon, u.zenith, pow(up, float(0.42)));
      const below = mix(u.horizon, u.horizon.mul(0.55), saturate(e.negate().mul(6)));
      const base = mix(below, grad, smoothstep(-0.02, 0.02, e)).toVar();

      // Sun glow, horizon band brightening toward the sun's azimuth.
      const cosA = dot(dir, u.sunDir);
      const toward = saturate(cosA.mul(0.5).add(0.5));
      const glow = pow(saturate(cosA), float(6)).mul(0.55).add(pow(saturate(cosA), float(48)).mul(1.4));
      const band = exp(abs(e).mul(-9)).mul(pow(toward, float(2.5)));
      base.addAssign(u.glow.mul(glow.add(band.mul(0.8))).mul(u.glowStrength));

      // Cloud deck: planar projection, fades at the horizon and the zenith.
      const t = time.mul(u.motion);
      const proj = dir.xz.div(max(e, 0.035)).mul(0.55);
      const p = vec3(proj.x.add(t.mul(0.004)), proj.y.add(t.mul(0.0015)), t.mul(0.002));
      const n = mx_fractal_noise_float(p, 5, 2.1, 0.52, 1).mul(0.5).add(0.5);
      const streak = mx_fractal_noise_float(vec3(proj.x.mul(0.35), proj.y.mul(2.2), 3.1), 3, 2, 0.5, 1).mul(0.5).add(0.5);
      const shape = n.mul(0.7).add(streak.mul(0.45));
      const cover = u.cloudCover;
      const density = smoothstep(float(1).sub(cover), float(1.25).sub(cover), shape)
        .mul(smoothstep(0.015, 0.12, e))
        .mul(smoothstep(0.98, 0.6, e))
        .toVar();
      // Clouds facing the sun get a bright rim ("silver lining"); the rest stay cool.
      const lit = mix(u.cloudShade, u.cloudLit, pow(toward, float(1.6)));
      const rim = pow(saturate(cosA), float(10)).mul(u.glowStrength).mul(1.6);
      const cloud = lit.add(u.glow.mul(rim));
      base.assign(mix(base, cloud, density.mul(0.88)));

      // Sun disk with a soft corona; hidden behind clouds and below the horizon.
      const sunSize = float(0.9994);
      const disk = smoothstep(sunSize, sunSize.add(0.0004), cosA).mul(u.sunDisk);
      const visible = float(1).sub(density.mul(0.9)).mul(smoothstep(-0.01, 0.01, e));
      base.addAssign(u.sunColor.mul(disk.mul(visible)));

      // Moon: a crisp pale disk with a faint halo, opposite-ish the city.
      const moonDir = normalize(vec3(-0.45, 0.32, -0.83));
      const cosM = dot(dir, moonDir);
      const moonDisk = smoothstep(0.99955, 0.9997, cosM).mul(2.4);
      const moonHalo = pow(saturate(cosM), float(180)).mul(0.25);
      base.addAssign(vec3(0.85, 0.9, 1).mul(moonDisk.add(moonHalo)).mul(u.moon).mul(visible));

      // Stars: sparse twinkling points, faded near the horizon and behind clouds.
      const sp = dir.mul(220);
      const cell = mx_cell_noise_float(sp);
      const d = mx_worley_noise_float(sp, 0.9);
      const twinkle = sin(t.mul(2.5).add(cell.mul(80))).mul(0.35).add(0.65);
      const star = smoothstep(0.11, 0.0, d).mul(smoothstep(0.82, 1, cell)).mul(twinkle).mul(1.8);
      base.addAssign(vec3(star).mul(u.stars).mul(smoothstep(0.04, 0.3, e)).mul(float(1).sub(density)));

      return clamp(base, vec3(0), vec3(64));
    })();

    this.mesh = new Mesh(new SphereGeometry(radius, 48, 24), material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  apply(look: Look) {
    const u = this.u;
    sunDirection(look, u.sunDir.value);
    u.zenith.value.copy(look.skyZenith);
    u.horizon.value.copy(look.skyHorizon);
    u.glow.value.copy(look.skyGlow);
    u.glowStrength.value = look.glowStrength;
    u.sunColor.value.copy(look.sunColor);
    u.sunDisk.value = look.sunDisk;
    u.moon.value = look.moon;
    u.cloudCover.value = look.cloudCover;
    u.cloudLit.value.copy(look.cloudLit);
    u.cloudShade.value.copy(look.cloudShade);
    u.stars.value = look.stars;
  }

  setMotion(on: boolean) {
    this.u.motion.value = on ? 1 : 0;
  }

  follow(position: Vector3) {
    this.mesh.position.copy(position);
  }
}
