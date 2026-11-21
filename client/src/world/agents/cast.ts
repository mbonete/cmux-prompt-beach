import type { AnimationClip, Object3D } from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLTF, loadJSON } from '../engine/assets';

// The cast: Rocketbox people converted by tools/assets/characters. Avatars of a
// skeleton (m/f) share one animation file; clips bind by bone name.

export type Skeleton = 'm' | 'f';

export interface ClipInfo {
  duration: number;
  loop: boolean;
  /** "root" clips move the character; apply groundEnd when they finish. */
  mode: string;
  speed?: number;
  groundEnd?: { pos: [number, number, number]; yaw: number };
}

export interface CastManifest {
  avatars: Record<string, { gltf: string; skeleton: Skeleton; height: number }>;
  anims: Record<Skeleton, { gltf: string; clips: Record<string, ClipInfo> }>;
  furniture: { seatHeightTable?: number; seatHeightChair?: number; tableTopFromWorkTable?: number };
}

const BASE = '/assets/characters/';

export class Cast {
  manifest!: CastManifest;
  private readonly clipCache = new Map<Skeleton, Promise<Map<string, AnimationClip>>>();

  async load() {
    this.manifest = await loadJSON<CastManifest>(`${BASE}manifest.json`);
  }

  get ids(): string[] {
    return Object.keys(this.manifest.avatars).sort();
  }

  info(id: string) {
    return this.manifest.avatars[id];
  }

  clipInfo(skeleton: Skeleton, name: string): ClipInfo | undefined {
    return this.manifest.anims[skeleton]?.clips[name];
  }

  async avatar(id: string): Promise<Object3D> {
    const gltf = await loadGLTF(BASE + this.manifest.avatars[id].gltf);
    return cloneSkinned(gltf.scene);
  }

  clips(skeleton: Skeleton): Promise<Map<string, AnimationClip>> {
    let p = this.clipCache.get(skeleton);
    if (!p) {
      p = loadGLTF(BASE + this.manifest.anims[skeleton].gltf).then((g) => new Map(g.animations.map((c) => [c.name, c])));
      this.clipCache.set(skeleton, p);
    }
    return p;
  }

  /** A look for a session: hashed from its id, then nudged to avoid repeats on screen. */
  pick(sessionKey: string, taken: Set<string>): string {
    const ids = this.ids;
    let h = 2166136261;
    for (let i = 0; i < sessionKey.length; i++) h = Math.imul(h ^ sessionKey.charCodeAt(i), 16777619);
    const start = Math.abs(h) % ids.length;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[(start + k) % ids.length];
      if (!taken.has(id)) return id;
    }
    return ids[start];
  }
}
