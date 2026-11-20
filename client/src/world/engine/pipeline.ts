import { Color, RenderPipeline, type Camera, type Scene, type WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  unpackRGBToNormal,
  packNormalToRGB,
  float,
  length,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  sample,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { Look } from '../env/looks';
import type { QualityLevel } from './quality';

// Post-processing: ground-truth ambient occlusion, temporal anti-aliasing,
// bloom, then a colour grade (warmth, split toning, saturation, vignette) in
// linear light before the renderer's AgX tone mapping. Light quality drops AO
// and TRAA and uses FXAA on the tone-mapped image instead.

export class Pipeline {
  readonly pipeline: RenderPipeline;
  private readonly grade = {
    warmth: uniform(0.3),
    saturation: uniform(1.1),
    shadowTint: uniform(new Color(0xd0dcff)),
    highlightTint: uniform(new Color(0xffe8d0)),
    vignette: uniform(0.25),
    aoStrength: uniform(0.85),
  };
  private bloomPass: ReturnType<typeof bloom> | null = null;

  constructor(renderer: WebGPURenderer, scene: Scene, camera: Camera, level: QualityLevel) {
    const g = this.grade;
    this.pipeline = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const full = level !== 'light';

    let beauty;
    if (full) {
      scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView), velocity }));
      const color = scenePass.getTextureNode('output');
      const depth = scenePass.getTextureNode('depth');
      const normalTex = scenePass.getTextureNode('normal');
      const velocityTex = scenePass.getTextureNode('velocity');
      const sceneNormal = sample((uv) => unpackRGBToNormal(normalTex.sample(uv)));
      const aoPass = ao(depth, sceneNormal, camera);
      aoPass.resolutionScale = level === 'cinematic' ? 1 : 0.5;
      aoPass.radius.value = 0.6;
      aoPass.thickness.value = 1.2;
      const occlusion = mix(float(1), aoPass.getTextureNode().r, g.aoStrength);
      const lit = vec4(color.rgb.mul(occlusion), color.a);
      beauty = traa(lit, depth, velocityTex, camera);
    } else {
      beauty = scenePass.getTextureNode('output');
    }

    const glow = bloom(beauty, 0.2, 0.55, 1.15);
    this.bloomPass = glow;

    const graded = Fn(() => {
      const c = beauty.add(glow).rgb.toVar();
      c.mulAssign(vec3(float(1).add(g.warmth.mul(0.09)), float(1).add(g.warmth.mul(0.012)), float(1).sub(g.warmth.mul(0.1))));
      const tone = smoothstep(0.03, 1.4, luminance(c));
      c.mulAssign(mix(g.shadowTint, g.highlightTint, tone));
      c.assign(mix(vec3(luminance(c)), c, g.saturation));
      const r = length(screenUV.sub(0.5).mul(vec2(1.0, 0.82))).mul(1.32);
      c.mulAssign(mix(float(1), smoothstep(1.08, 0.32, r), g.vignette));
      return vec4(c, 1);
    })();

    if (full) {
      this.pipeline.outputNode = graded;
    } else {
      this.pipeline.outputColorTransform = false;
      this.pipeline.outputNode = fxaa(renderOutput(graded));
    }
  }

  apply(look: Look) {
    const g = this.grade;
    g.warmth.value = look.warmth;
    g.saturation.value = look.saturation;
    g.shadowTint.value.copy(look.shadowTint);
    g.highlightTint.value.copy(look.highlightTint);
    g.vignette.value = look.vignette;
    if (this.bloomPass) this.bloomPass.strength.value = look.bloom;
  }

  render() {
    this.pipeline.render();
  }

  dispose() {
    this.pipeline.dispose();
  }
}
