import { type Camera, type MeshStandardNodeMaterial, Vector2, Vector3 } from 'three/webgpu';
import { Fn, bool, dot, float, fract, positionView, positionWorld, screenCoordinate, screenSize, screenUV, smoothstep, step, uniform, vec2 } from 'three/tsl';

// See-through for the person whose card is open: whatever stands between the
// camera and them (a parasol, an awning, a balcony, a palm) dissolves in a soft
// circle around them, so no angle (the default close-up or one you turn to)
// ever hides them. Same fine dither as the palms' near-camera fade. Floors stay:
// only what is above the person's feet and in front of them is cut. Shadows are
// drawn whole (the shadow pass ignores the mask).

const u = {
  /** The person on screen, 0..1 from the top left; off screen when nobody is selected. */
  center: uniform(new Vector2(-9, -9)),
  /** Their distance in front of the camera (view space, metres). */
  depth: uniform(0),
  /** Height of the floor they're on (world y). */
  floor: uniform(0),
  /** Circle radius as a fraction of the screen height. */
  radius: uniform(0),
  /** 0..1, eased in when a card opens and out when it closes. */
  amount: uniform(0),
};

/** Metres around the person kept clear (a seated person with a raised arm). */
const CLEAR_M = 1.25;
/** In front of the person by at least this much (metres) to be cut: never the person. */
const MARGIN_M = 0.6;
/** Above their feet by at least this much: the floor and its edging stay. */
const ABOVE_FLOOR_M = 0.3;

const keep = Fn(() => {
  const aspect = screenSize.x.div(screenSize.y);
  const d = screenUV.sub(u.center).mul(vec2(aspect, 1)).length();
  const inside = smoothstep(u.radius, u.radius.mul(0.55), d);
  const inFront = step(positionView.z.negate(), u.depth.sub(MARGIN_M));
  const above = step(u.floor.add(ABOVE_FLOOR_M), positionWorld.y);
  const fade = inside.mul(inFront).mul(above).mul(u.amount);
  const p = screenCoordinate.xy;
  const ign = fract(float(52.9829189).mul(fract(dot(p, vec2(0.06711056, 0.00583715)))));
  return ign.greaterThanEqual(fade);
});

/** Lets the selected person be seen through this material. */
export function seeThrough(m: MeshStandardNodeMaterial) {
  // (three's types call maskNode a plain Node; it is a boolean node at runtime.)
  const prev = m.maskNode as unknown as ReturnType<typeof bool> | null;
  m.maskNode = prev ? prev.and(keep()) : keep();
  m.maskShadowNode = prev ?? bool(true);
}

const tmp = new Vector3();
const fwd = new Vector3();

/**
 * Called every frame: `at` is the selected person's chest (or null), `feetY`
 * their floor. Eases the cut in and out so it never pops.
 */
export function updateSeeThrough(camera: Camera, at: Vector3 | null, feetY: number, fovDeg: number, dt: number) {
  const target = at ? 1 : 0;
  u.amount.value += (target - u.amount.value) * (1 - Math.exp(-dt * 6));
  if (!at) {
    if (u.amount.value < 0.01) u.center.value.set(-9, -9);
    return;
  }
  tmp.copy(at).project(camera);
  u.center.value.set(tmp.x * 0.5 + 0.5, -tmp.y * 0.5 + 0.5);
  camera.getWorldDirection(fwd);
  const depth = tmp.copy(at).sub(camera.position).dot(fwd);
  u.depth.value = depth;
  u.floor.value = feetY;
  u.radius.value = CLEAR_M / (2 * Math.tan(((fovDeg / 2) * Math.PI) / 180) * Math.max(1, depth));
}
