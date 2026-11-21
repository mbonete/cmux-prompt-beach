// The district's fixed geography, in metres (see docs/world-v2/BRIEF.md):
// the ocean lies toward −Z, the city extends inland toward +Z, and a bay with a
// skyline sits toward +X. Plots are 20 × 16 m; their fronts face +Z.

export const CITY_Y = 0;
export const SEA_Y = -1;

export const PLOT_W = 20;
export const PLOT_D = 16;
/** Matches PLOT_COUNT in server/world.mjs. */
export const PLOT_COUNT = 32;

/** The original four-by-four core (plots 0–15) and four outer columns (16–31), eight in all. */
export const PLOT_X = [-42, -16, 16, 42] as const;
export const OUTER_X = [-72, 72, -98, 98] as const;
export const PLOT_COLUMNS = [-98, -72, -42, -16, 16, 42, 72, 98] as const;
export const PLOT_Z = [8, 34, 60, 86] as const;

export interface PlotSlot {
  index: number;
  x: number;
  z: number;
  /** Rotation about Y in radians (plots face +Z by default). */
  rot: number;
}

// Plots 0–15 keep their places from the first district, so repos never move;
// 16–31 fill the outer columns nearest first, front rows first. New repos take
// the lowest free plot, so the centre fills before the edges.
const CORE: PlotSlot[] = PLOT_Z.flatMap((z, row) => PLOT_X.map((x, col) => ({ index: row * PLOT_X.length + col, x, z, rot: 0 })));
const OUTER: PlotSlot[] = [0, 1].flatMap((pair) =>
  PLOT_Z.flatMap((z) => OUTER_X.slice(pair * 2, pair * 2 + 2).map((x) => ({ x, z }))),
).map((p, i) => ({ index: 16 + i, ...p, rot: 0 }));
export const PLOTS: PlotSlot[] = [...CORE, ...OUTER];

/** Shared plots: the beach bar (sessions outside any repo) and the co-working overflow. */
export const HANGOUT = { x: 4, z: -44, rot: 0 } as const;
export const OVERFLOW = { x: -29, z: 114, rot: Math.PI / 2 } as const;
/** Half the overflow building's footprint along x and z (it may be turned 90°). */
export const OVERFLOW_HALF = { x: PLOT_D / 2, z: PLOT_W / 2 };

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Seawall / promenade / beach-road band between the city and the sand. */
export const PROMENADE: Rect = { x0: -126, x1: 128, z0: -22, z1: -12 };
export const BEACH_ROAD: Rect = { x0: -121.5, x1: 121.5, z0: -11, z1: -2 };
/** The sand runs from the seawall down below the waterline. */
export const BEACH = { x0: -700, x1: 128, zTop: -22, zShore: -66, zDeep: -150 } as const;

/** Streets: east–west between plot rows, north–south avenues. Width in metres. */
export const STREETS_EW = [21, 47, 73, 99].map((z) => ({ z, width: 9 }));
/**
 * North–south avenues. The two `frame` avenues close the grid at the island's
 * edges (streets turn there); the three in between carry on as causeways.
 */
export const STREETS_NS: { x: number; width: number; frame?: boolean }[] = [
  { x: -117, width: 9, frame: true },
  { x: -57, width: 9 },
  { x: 0, width: 11 },
  { x: 57, width: 9 },
  { x: 117, width: 9, frame: true },
];
export const DISTRICT: Rect = { x0: -110, x1: 110, z0: -2, z1: 122 };

/** The city land's east edge drops to the bay; the skyline sits across it. */
export const BAY_EDGE_X = 128;
export const SKYLINE: Rect = { x0: 240, x1: 900, z0: -260, z1: 520 };

/**
 * The island is small on purpose: city blocks stop one ring out from the
 * district (x0), and inland (z1) a seawall drops to the bay, crossed by the
 * avenues as causeways to a second skyline on the far shore.
 */
export const CITY = { x0: -126, z1: 132 } as const;
/** East–west streets run between the frame avenues. */
export const STREET_WEST = -121.5;
export const STREET_EAST = 121.5;
/** Where the frame avenues end: the far side of the last street. */
export const FRAME_END = 99 + 4.5;
export const CAUSEWAY_END = 335;
export const INLAND_SKYLINE: Rect = { x0: -620, x1: 230, z0: 345, z1: 560 };
