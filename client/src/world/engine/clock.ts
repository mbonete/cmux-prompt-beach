import { uniform } from 'three/tsl';

/**
 * Seconds of ambient motion (sky, sea, palms, the selection ring), advanced by
 * World on each frame it draws. The built-in `time` node follows the wall
 * clock: after the city had been calm (not drawing), everything jumped ahead
 * on the first frame back.
 */
export const worldTime = uniform(0);
