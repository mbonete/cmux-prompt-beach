import { LoadingManager, type Object3D, type Texture } from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

// One loading manager for the whole world, so the title screen can show real
// progress. glTF files are cached by URL; callers clone what they need.

export const loading = new LoadingManager();
const gltfLoader = new GLTFLoader(loading);
const cache = new Map<string, Promise<GLTF>>();

export function loadGLTF(url: string): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = gltfLoader.loadAsync(url);
    cache.set(url, p);
  }
  return p;
}

export async function loadJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json() as Promise<T>;
}

/** Sharper textures at grazing angles (roads, sand, facades seen from the camera). */
export function anisotropy(root: Object3D, level = 8) {
  root.traverse((o) => {
    const m = (o as { material?: unknown }).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
        const t = (mat as Record<string, Texture | null | undefined>)[key];
        if (t) t.anisotropy = level;
      }
    }
  });
}
