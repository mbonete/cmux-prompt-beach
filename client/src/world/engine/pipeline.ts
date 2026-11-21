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
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import type { Look } from '../env/looks';
import type { QualityLevel } from './quality';

// Post-processing: ground-truth ambient occlusion (denoised within the frame),
// bloom, a colour grade (warmth, split toning, saturation, vignette) in linear
// light, tone mapping, then anti-aliasing within the frame: SMAA, or FXAA on
// Light. Deliberately no temporal AA: its sub-pixel jitter made every detail
// smaller than a pixel (bulbs, cables, window edges, surfaces millimetres apart)
// appear and vanish from frame to frame, which reads as flicker everywhere.
// Every frame is now computed the same way, so a still view is perfectly still.

/** Leaving a pass out, for measuring what it costs (World.perfPipeline, with ?perf). */
export interface PipelineParts {
  ao?: boolean;
  bloom?: boolean;
  aa?: 'smaa' | 'fxaa' | 'none';
}

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

  constructor(renderer: WebGPURenderer, scene: Scene, camera: Camera, level: QualityLevel, parts: PipelineParts = {}) {
    const g = this.grade;
    this.pipeline = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const full = level !== 'light';
    const useAo = parts.ao ?? full;
    const aa = parts.aa ?? (full ? 'smaa' : 'fxaa');

    let beauty;
    if (useAo) {
      scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView) }));
      const color = scenePass.getTextureNode('output');
      const depth = scenePass.getTextureNode('depth');
      const normalTex = scenePass.getTextureNode('normal');
      const sceneNormal = sample((uv) => unpackRGBToNormal(normalTex.sample(uv)));
      const aoPass = ao(depth, sceneNormal, camera);
      aoPass.resolutionScale = level === 'cinematic' ? 1 : 0.5;
      aoPass.radius.value = 0.6;
      aoPass.thickness.value = 1.2;
      // GTAO's noise used to be averaged away over frames; denoise it here instead.
      const aoClean = denoise(aoPass.getTextureNode(), depth, sceneNormal, camera) as unknown as ReturnType<typeof vec4>;
      const occlusion = mix(float(1), aoClean.r, g.aoStrength);
      beauty = vec4(color.rgb.mul(occlusion), color.a);
    } else {
      beauty = scenePass.getTextureNode('output');
    }

    const glow = parts.bloom === false ? null : bloom(beauty, 0.2, 0.55, 1.15);
    this.bloomPass = glow;

    const graded = Fn(() => {
      const c = (glow ? beauty.add(glow) : beauty).rgb.toVar();
      c.mulAssign(vec3(float(1).add(g.warmth.mul(0.09)), float(1).add(g.warmth.mul(0.012)), float(1).sub(g.warmth.mul(0.1))));
      const tone = smoothstep(0.03, 1.4, luminance(c));
      c.mulAssign(mix(g.shadowTint, g.highlightTint, tone));
      c.assign(mix(vec3(luminance(c)), c, g.saturation));
      const r = length(screenUV.sub(0.5).mul(vec2(1.0, 0.82))).mul(1.32);
      c.mulAssign(mix(float(1), smoothstep(1.08, 0.32, r), g.vignette));
      return vec4(c, 1);
    })();

    // Anti-aliasing on the tone-mapped image, within the frame.
    this.pipeline.outputColorTransform = false;
    const out = renderOutput(graded);
    this.pipeline.outputNode = aa === 'smaa' ? smaa(out) : aa === 'fxaa' ? fxaa(out) : out;
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
