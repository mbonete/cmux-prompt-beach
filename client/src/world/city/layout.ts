// The district's fixed geography, in metres (see docs/world-v2/BRIEF.md):
// the ocean lies toward −Z, the city extends inland toward +Z, and a bay with a
// skyline sits toward +X. Plots are 20 × 16 m; their fronts face +Z.

export const CITY_Y = 0;
export const SEA_Y = -1;

export const PLOT_W = 20;
export const PLOT_D = 16;
export const PLOT_COUNT = 16;

/** Plot column centres (x) and row centres (z), four by four. */
export const PLOT_X = [-42, -16, 16, 42] as const;
export const PLOT_Z = [8, 34, 60, 86] as const;

export interface PlotSlot {
  index: number;
  x: number;
  z: number;
  /** Rotation about Y in radians (plots face +Z by default). */
  rot: number;
}

export const PLOTS: PlotSlot[] = PLOT_Z.flatMap((z, row) =>
  PLOT_X.map((x, col) => ({ index: row * PLOT_X.length + col, x, z, rot: 0 })),
);

/** Shared plots: the beach bar (sessions outside any repo) and the co-working overflow. */
export const HANGOUT = { x: 4, z: -44, rot: 0 } as const;
export const OVERFLOW = { x: -84, z: 34, rot: Math.PI / 2 } as const;

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Seawall / promenade / beach-road band between the city and the sand. */
export const PROMENADE: Rect = { x0: -700, x1: 128, z0: -22, z1: -12 };
export const BEACH_ROAD: Rect = { x0: -700, x1: 128, z0: -11, z1: -2 };
/** The sand runs from the seawall down below the waterline. */
export const BEACH = { x0: -700, x1: 128, zTop: -22, zShore: -66, zDeep: -150 } as const;

/** Streets: east–west between plot rows, north–south avenues. Width in metres. */
export const STREETS_EW = [21, 47, 73, 99, 125, 151, 177].map((z) => ({ z, width: 9 }));
export const STREETS_NS = [
  { x: -57, width: 9 },
  { x: 0, width: 11 },
  { x: 57, width: 9 },
];
export const DISTRICT: Rect = { x0: -62, x1: 62, z0: -2, z1: 104 };

/** The city land's east edge drops to the bay; the skyline sits across it. */
export const BAY_EDGE_X = 128;
export const SKYLINE: Rect = { x0: 240, x1: 900, z0: -260, z1: 520 };

/**
 * The island is small on purpose: city blocks stop one ring out from the
 * district (x0), and inland (z1) a seawall drops to the bay, crossed by the
 * avenues as causeways to a second skyline on the far shore.
 */
export const CITY = { x0: -185, z1: 200 } as const;
/** Streets run a little past the last blocks so traffic can leave out of sight. */
export const STREET_WEST = -265;
export const CAUSEWAY_END = 335;
export const INLAND_SKYLINE: Rect = { x0: -620, x1: 230, z0: 345, z1: 560 };
