import { Cache, LoadingManager, type Object3D, type Texture } from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

// One loading manager for the whole world, so the title screen can show real
// progress. glTF files are cached by URL; callers clone what they need.

// Every building file references the same shared textures (stucco, trim, roof…);
// three's URL cache makes each image download and decode once, not once per file.
Cache.enabled = true;

export const loading = new LoadingManager();

/**
 * Added to every /assets URL. The server used to let a browser keep /assets
 * files for an hour without asking; after a rebuild one could pair a model's
 * new .gltf with its old .bin ("Invalid typed array length") and the city
 * failed to load. The server now has them revalidated on every load; moving
 * this once makes browsers skip copies kept under the old rule. (Through the
 * manager, it also reaches the .bin and textures a model pulls in.)
 */
const ASSET_REV = '2';
function withRev(url: string): string {
  if (!url.includes('/assets/') || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}rev=${ASSET_REV}`;
}
loading.setURLModifier(withRev);
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
  const res = await fetch(withRev(url));
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
