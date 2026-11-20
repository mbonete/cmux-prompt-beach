import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  TubeGeometry,
  CurvePath,
  LineCurve3,
  QuadraticBezierCurve3,
  Vector3,
} from 'three/webgpu';
import { Fn, abs, float, max, mix, mx_noise_float, positionLocal, pow, saturate, sin, smoothstep, time, uniform, uv, vec3 } from 'three/tsl';
import { PLOT_D, PLOT_W } from './layout';

// The plot's neon outline (in the repo's colour, pulsing pink while someone
// needs you) and the tall light beam that marks a needs-you plot from anywhere.

export const STATE_COLORS = {
  needs: new Color(0xff3f8e),
  working: new Color(0x2fd8ff),
  move: new Color(0x5dffa8),
  stale: new Color(0xa49dbd),
} as const;

function roundedRectPath(w: number, d: number, r: number, y: number) {
  const path = new CurvePath<Vector3>();
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  const v = (x: number, z: number) => new Vector3(x, y, z);
  path.add(new LineCurve3(v(x0 + r, z1), v(x1 - r, z1)));
  path.add(new QuadraticBezierCurve3(v(x1 - r, z1), v(x1, z1), v(x1, z1 - r)));
  path.add(new LineCurve3(v(x1, z1 - r), v(x1, z0 + r)));
  path.add(new QuadraticBezierCurve3(v(x1, z0 + r), v(x1, z0), v(x1 - r, z0)));
  path.add(new LineCurve3(v(x1 - r, z0), v(x0 + r, z0)));
  path.add(new QuadraticBezierCurve3(v(x0 + r, z0), v(x0, z0), v(x0, z0 + r)));
  path.add(new LineCurve3(v(x0, z0 + r), v(x0, z1 - r)));
  path.add(new QuadraticBezierCurve3(v(x0, z1 - r), v(x0, z1), v(x0 + r, z1)));
  return path;
}

export class PlotOutline {
  readonly group = new Group();
  private readonly u = {
    color: uniform(new Color(0x2fd8ff)),
    pulse: uniform(0),
    level: uniform(1),
    dim: uniform(1),
  };

  constructor(w = PLOT_W - 0.6, d = PLOT_D - 0.6) {
    const u = this.u;
    const intensity = Fn(() => {
      const beat = sin(time.mul(5)).mul(0.5).add(0.5);
      return mix(float(1), beat.mul(1.6).add(0.4), u.pulse).mul(u.level).mul(u.dim);
    })();

    const tubeMat = new MeshBasicNodeMaterial({ fog: true });
    tubeMat.colorNode = u.color.mul(intensity.mul(4.5));
    const tube = new Mesh(new TubeGeometry(roundedRectPath(w, d, 1.4, 0.22), 160, 0.055, 6, true), tubeMat);
    tube.name = 'outline';

    // A soft glow spilling on the ground just inside and outside the tube.
    const shape = new Shape();
    const gw = w + 1.6;
    const gd = d + 1.6;
    shape.moveTo(-gw / 2, -gd / 2);
    shape.lineTo(gw / 2, -gd / 2);
    shape.lineTo(gw / 2, gd / 2);
    shape.lineTo(-gw / 2, gd / 2);
    const glowGeo = new ShapeGeometry(shape);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    glowMat.colorNode = u.color.mul(intensity.mul(0.55));
    glowMat.opacityNode = Fn(() => {
      // Distance to the rectangle edge in metres, from the local position.
      const p = positionLocal.xz;
      const dx = abs(p.x).sub(w / 2);
      const dz = abs(p.y).sub(d / 2);
      const edge = max(dx, dz);
      return pow(smoothstep(0.9, 0.0, abs(edge)), float(2.2));
    })();
    const glow = new Mesh(glowGeo, glowMat);
    glow.position.y = 0.05;
    glow.renderOrder = 2;

    this.group.add(tube, glow);
  }

  setState(color: Color, needs: boolean, dim = false) {
    this.u.color.value.copy(color);
    this.u.pulse.value = needs ? 1 : 0;
    this.u.dim.value = dim ? 0.35 : 1;
  }

  /** Time-of-day multiplier (neon reads stronger at dusk and night). */
  setLevel(level: number) {
    this.u.level.value = level;
  }
}

/** A tall translucent column of light with slow rising streaks. */
export class Beam {
  readonly group = new Group();
  private readonly u = { color: uniform(new Color(0xff3f8e)), on: uniform(0) };

  constructor(height = 70) {
    const u = this.u;
    const geo = new CylinderGeometry(1.15, 1.6, height, 32, 1, true);
    geo.translate(0, height / 2, 0);
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false });
    const v = uv().y;
    const streaks = mx_noise_float(vec3(uv().x.mul(12), v.mul(6).sub(time.mul(0.35)), 0)).mul(0.5).add(0.5);
    mat.colorNode = u.color.mul(2.2);
    mat.opacityNode = Fn(() => {
      const fade = pow(float(1).sub(v), float(1.6)).mul(smoothstep(0.0, 0.03, v));
      return saturate(fade.mul(streaks.mul(0.5).add(0.5)).mul(0.55).mul(u.on));
    })();
    const beam = new Mesh(geo, mat);
    beam.renderOrder = 3;

    // A bright ring where the beam meets the ground.
    const ringGeo = new PlaneGeometry(7, 7);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    ringMat.colorNode = u.color.mul(3);
    ringMat.opacityNode = Fn(() => {
      const d = uv().sub(0.5).length().mul(2);
      const ring = smoothstep(0.12, 0.0, abs(d.sub(0.55))).add(smoothstep(0.6, 0.0, d).mul(0.35));
      const beat = sin(time.mul(3)).mul(0.25).add(0.75);
      return saturate(ring.mul(beat).mul(u.on));
    })();
    const ring = new Mesh(ringGeo, ringMat);
    ring.position.y = 0.12;
    ring.renderOrder = 3;

    this.group.add(beam, ring);
    this.group.visible = false;
  }

  set(on: boolean, color = STATE_COLORS.needs) {
    this.u.on.value = on ? 1 : 0;
    this.u.color.value.copy(color);
    this.group.visible = on;
  }
}
