import { type Camera, Vector3 } from 'three/webgpu';

const v = new Vector3();

/**
 * Whether a point is behind the camera. Tested in camera space, not on the
 * projected depth: with the reversed depth buffer a point behind the camera
 * projects to a depth below 0 (not above 1), so `ndc.z > 1` never caught it.
 */
export function behindCamera(camera: Camera, point: Vector3): boolean {
  return v.copy(point).applyMatrix4(camera.matrixWorldInverse).z > 0;
}
