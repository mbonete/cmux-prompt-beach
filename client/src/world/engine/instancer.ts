import { Color, InstancedMesh, Matrix4, type Material, type Mesh, type Object3D, type Scene } from 'three/webgpu';

// Turns a glTF template into one InstancedMesh per primitive, so a building or
// prop used on many plots costs one draw call per material rather than one per
// copy. Instances can be tinted per primitive material name (e.g. "stucco").

interface Part {
  mesh: InstancedMesh;
  /** Template mesh's transform relative to the template root. */
  local: Matrix4;
  materialName: string;
}

const tmp = new Matrix4();
const white = new Color(1, 1, 1);

export class InstancedModel {
  private readonly parts: Part[] = [];
  private count = 0;

  constructor(
    template: Object3D,
    readonly capacity: number,
    opts: { castShadow?: boolean; receiveShadow?: boolean; tintable?: string[] } = {},
  ) {
    template.updateMatrixWorld(true);
    const rootInv = template.matrixWorld.clone().invert();
    template.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
      const material = m.material as Material;
      const im = new InstancedMesh(m.geometry, material, capacity);
      im.count = 0;
      im.castShadow = opts.castShadow ?? true;
      im.receiveShadow = opts.receiveShadow ?? true;
      im.name = `${template.name}/${m.name}`;
      im.frustumCulled = false;
      const name = material.name || '';
      if (opts.tintable?.includes(name)) {
        for (let i = 0; i < capacity; i++) im.setColorAt(i, white);
      }
      this.parts.push({ mesh: im, local: rootInv.clone().multiply(m.matrixWorld), materialName: name });
    });
  }

  addTo(scene: Scene | Object3D) {
    for (const p of this.parts) scene.add(p.mesh);
  }

  /** Adds an instance at a world transform; returns its index. */
  add(world: Matrix4, tint?: Color): number {
    if (this.count >= this.capacity) throw new Error('InstancedModel is full');
    const i = this.count++;
    this.set(i, world, tint);
    for (const p of this.parts) p.mesh.count = this.count;
    return i;
  }

  set(i: number, world: Matrix4, tint?: Color) {
    for (const p of this.parts) {
      p.mesh.setMatrixAt(i, tmp.multiplyMatrices(world, p.local));
      p.mesh.instanceMatrix.needsUpdate = true;
      if (tint && p.mesh.instanceColor) {
        p.mesh.setColorAt(i, tint);
        p.mesh.instanceColor.needsUpdate = true;
      }
    }
    for (const p of this.parts) p.mesh.computeBoundingSphere();
  }

  /** Draw only the first n instances (the rest are kept, not drawn). */
  setCount(n: number) {
    this.count = n;
    for (const p of this.parts) p.mesh.count = n;
  }

  /** Materials by name across all parts (for driving emissive by time of day). */
  materials(name: string): Material[] {
    return this.parts.filter((p) => p.materialName === name).map((p) => p.mesh.material as Material);
  }

  get meshes() {
    return this.parts.map((p) => p.mesh);
  }
}
