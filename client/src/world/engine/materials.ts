import {
  InstancedBufferAttribute,
  type InstancedMesh,
  type Material,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  type UniformNode,
} from 'three/webgpu';
import { float, instancedBufferAttribute, materialEmissive, texture, uv, vec3 } from 'three/tsl';

type FloatUniform = UniformNode<'float', number>;
type FloatNode = ReturnType<typeof float>;

// glTF materials arrive as MeshStandardMaterial. These helpers turn one into a
// node material so its emission can be driven per instance (a vacant plot's
// windows stay dark while an occupied one glows) and by time of day.

export function toNodeMaterial(src: Material): MeshStandardNodeMaterial {
  const s = src as MeshStandardMaterial;
  const m = new MeshStandardNodeMaterial();
  m.name = s.name;
  m.color.copy(s.color);
  m.map = s.map;
  m.normalMap = s.normalMap;
  m.normalScale.copy(s.normalScale);
  m.roughness = s.roughness;
  m.metalness = s.metalness;
  m.roughnessMap = s.roughnessMap;
  m.metalnessMap = s.metalnessMap;
  m.aoMap = s.aoMap;
  m.aoMapIntensity = s.aoMapIntensity;
  m.emissive.copy(s.emissive);
  m.emissiveMap = s.emissiveMap;
  m.emissiveIntensity = s.emissiveIntensity;
  m.transparent = s.transparent;
  m.opacity = s.opacity;
  m.alphaTest = s.alphaTest;
  m.side = s.side;
  m.depthWrite = s.depthWrite;
  return m;
}

/**
 * Gives an instanced mesh a per-instance "lit" value (0..1) that scales its
 * emission, times a shared level uniform (time of day). Returns the attribute
 * so callers can update values.
 */
export function perInstanceEmission(mesh: InstancedMesh, level: FloatUniform): InstancedBufferAttribute {
  const attr = new InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count).fill(1), 1);
  const lit = instancedBufferAttribute(attr, 'float') as unknown as FloatNode;
  const mat = toNodeMaterial(mesh.material as Material);
  const map = mat.emissiveMap ? vec3(texture(mat.emissiveMap, uv()).rgb) : vec3(1, 1, 1);
  mat.emissiveNode = vec3(materialEmissive).mul(map).mul(lit).mul(level);
  mesh.material = mat;
  return attr;
}
