import { BoxGeometry, BufferAttribute, BufferGeometry, Group, Mesh, PlaneGeometry } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BAY_EDGE_X,
  BEACH,
  BEACH_ROAD,
  CAUSEWAY_END,
  CITY,
  INLAND_SKYLINE,
  STREET_WEST,
  STREET_EAST,
  FRAME_END,
  CITY_Y,
  PROMENADE,
  SEA_Y,
  SKYLINE,
  STREETS_EW,
  STREETS_NS,
} from '../city/layout';
import { Color } from 'three/webgpu';
import { concreteMaterial, grassMaterial, stuccoMaterial } from './materials';
import { asphaltTextured, groundMaterial, sandTextured, textureSet } from './textured';

// The land: city lawns, the promenade with its low seawall, the beach sloping
// under the waterline, roads with markings, and the far shore for the skyline.

const LAND_FAR = CITY.z1 + 6;

/** Beach height at a given z (metres): gentle dunes down to the waterline, then deeper. */
export function beachHeight(z: number, x = 0) {
  const top = BEACH.zTop;
  const shore = BEACH.zShore;
  let h: number;
  if (z >= top) h = CITY_Y - 0.55;
  else if (z >= shore) {
    const t = (top - z) / (top - shore);
    h = CITY_Y - 0.55 + (SEA_Y + 0.02 - (CITY_Y - 0.55)) * Math.pow(t, 1.35);
  } else {
    const t = Math.min(1, (shore - z) / (shore - BEACH.zDeep));
    h = SEA_Y + 0.02 - 3.5 * Math.pow(t, 0.8);
  }
  // Past the island's west end the sand slopes away under the water.
  if (x < CITY.x0 + 4) h -= (CITY.x0 + 4 - x) * 0.07;
  // Soft dunes on the dry sand.
  if (z > shore + 6) h += 0.12 * Math.sin(x * 0.07 + z * 0.11) * Math.sin(x * 0.031 - z * 0.05);
  return h;
}

function beachGeometry() {
  const x0 = BEACH.x0;
  const x1 = BEACH.x1;
  const z0 = BEACH.zDeep;
  const z1 = BEACH.zTop;
  const nx = 220;
  const nz = 90;
  const g = new PlaneGeometry(x1 - x0, z1 - z0, nx, nz);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const pos = g.attributes.position as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Round the bay-side corner of the beach so it doesn't end in a hard edge.
    let h = beachHeight(z, x);
    if (x > BAY_EDGE_X - 25) h = Math.min(h, h - ((x - (BAY_EDGE_X - 25)) / 25) * 2.5);
    pos.setY(i, h);
  }
  g.computeVertexNormals();
  return g;
}

/** A road strip with UVs in metres (u along, v across) and a half-width attribute. */
function roadStrip(cx: number, cz: number, length: number, width: number, alongX: boolean) {
  const g = new PlaneGeometry(alongX ? length : width, alongX ? width : length, Math.max(1, Math.round(length / 8)), 1);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, CITY_Y + 0.02, cz);
  const pos = g.attributes.position as BufferAttribute;
  const uvs = new Float32Array(pos.count * 2);
  const halfW = new Float32Array(pos.count).fill(width / 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    uvs[i * 2] = alongX ? x : z;
    uvs[i * 2 + 1] = alongX ? z - cz : x - cx;
  }
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setAttribute('aHalfW', new BufferAttribute(halfW, 1));
  return g;
}

/** The parts of [from, to] left after removing the cut intervals. */
function spans(from: number, to: number, cuts: readonly (readonly [number, number])[]) {
  const out: [number, number][] = [];
  let start = from;
  for (const [a, b] of [...cuts].sort((p, q) => p[0] - q[0])) {
    if (b <= start || a >= to) continue;
    if (a > start) out.push([start, a]);
    start = Math.max(start, b);
  }
  if (start < to) out.push([start, to]);
  return out.filter(([a, b]) => b - a > 0.5);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

export function buildGround(): Group {
  const group = new Group();
  group.name = 'ground';

  // City land (lawns under everything), up to the bay edge.
  // From under the promenade (so no gap ever shows the sea through) to far inland.
  const landZ0 = PROMENADE.z0;
  const land = new PlaneGeometry(BAY_EDGE_X - CITY.x0, LAND_FAR - landZ0, 1, 1);
  land.rotateX(-Math.PI / 2);
  land.translate((BAY_EDGE_X + CITY.x0) / 2, CITY_Y - 0.005, (LAND_FAR + landZ0) / 2);
  const lawn = new Mesh(land, grassMaterial());
  lawn.receiveShadow = true;
  lawn.name = 'lawns';
  group.add(lawn);

  // Bay seawall: the land's east edge drops to the water.
  const bayWall = new Mesh(box(2, CITY_Y - SEA_Y + 1.5, LAND_FAR + 24, BAY_EDGE_X + 1, SEA_Y - 1.5, LAND_FAR / 2 - 12), concreteMaterial(0xcfc6b8));
  bayWall.receiveShadow = true;
  group.add(bayWall);

  // Inland seawall: the island ends at the bay.
  const inlandWall = new Mesh(box(BAY_EDGE_X - CITY.x0 + 2, CITY_Y - SEA_Y + 1.5, 2, (BAY_EDGE_X + CITY.x0) / 2, SEA_Y - 1.5, LAND_FAR + 1), concreteMaterial(0xcfc6b8));
  inlandWall.receiveShadow = true;
  group.add(inlandWall);
  // West seawall: the island ends just past the last plots.
  const westWall = new Mesh(box(2, CITY_Y - SEA_Y + 1.5, LAND_FAR - PROMENADE.z0 + 2, CITY.x0 - 1, SEA_Y - 1.5, (LAND_FAR + PROMENADE.z0) / 2), concreteMaterial(0xcfc6b8));
  westWall.receiveShadow = true;
  group.add(westWall);

  // Causeways: the avenues carry on over the bay to the far shore.
  const decks: BufferGeometry[] = [];
  const deckLen = CAUSEWAY_END - LAND_FAR + 10;
  const deckZ = LAND_FAR + deckLen / 2 - 2;
  for (const a of STREETS_NS) {
    if (a.frame) continue;
    decks.push(box(a.width + 1.6, 0.7, deckLen, a.x, CITY_Y - 0.69, deckZ));
    for (const side of [-1, 1]) decks.push(box(0.35, 0.9, deckLen, a.x + side * (a.width / 2 + 0.6), CITY_Y, deckZ));
    for (let z = LAND_FAR + 14; z < CAUSEWAY_END; z += 24) decks.push(box(a.width * 0.6, CITY_Y - SEA_Y + 2, 1.4, a.x, SEA_Y - 2, z));
  }
  const causeways = new Mesh(mergeGeometries(decks), concreteMaterial(0xd9d2c6));
  causeways.receiveShadow = true;
  causeways.castShadow = true;
  causeways.name = 'causeways';
  group.add(causeways);

  // Far shore of the inland bay, under the second skyline.
  const inland = new PlaneGeometry(INLAND_SKYLINE.x1 - INLAND_SKYLINE.x0 + 300, INLAND_SKYLINE.z1 - INLAND_SKYLINE.z0 + 300, 1, 1);
  inland.rotateX(-Math.PI / 2);
  inland.translate((INLAND_SKYLINE.x0 + INLAND_SKYLINE.x1) / 2, CITY_Y + 0.4, (INLAND_SKYLINE.z0 + INLAND_SKYLINE.z1) / 2 + 140);
  const inlandShore = new Mesh(inland, grassMaterial());
  inlandShore.receiveShadow = true;
  group.add(inlandShore);

  // Far shore for the skyline.
  const far = new PlaneGeometry(SKYLINE.x1 - SKYLINE.x0 + 400, SKYLINE.z1 - SKYLINE.z0 + 400, 1, 1);
  far.rotateX(-Math.PI / 2);
  far.translate((SKYLINE.x0 + SKYLINE.x1) / 2 + 200, CITY_Y + 0.4, (SKYLINE.z0 + SKYLINE.z1) / 2);
  const farShore = new Mesh(far, grassMaterial());
  farShore.receiveShadow = true;
  group.add(farShore);

  // Beach.
  const beach = new Mesh(beachGeometry(), sandTextured(textureSet('sand_dry', 3, '2k'), textureSet('sand_wet', 1.87)));
  beach.receiveShadow = true;
  beach.name = 'beach';
  group.add(beach);

  // Promenade: raised pavers with a low stucco wall on the sand side, with gaps for beach access.
  const promH = 0.16;
  const prom = new Mesh(
    box(PROMENADE.x1 - PROMENADE.x0, promH, PROMENADE.z1 - PROMENADE.z0, (PROMENADE.x0 + PROMENADE.x1) / 2, CITY_Y, (PROMENADE.z0 + PROMENADE.z1) / 2),
    groundMaterial(textureSet('pavers', 2, '2k'), new Color(0xf6dccb)),
  );
  prom.receiveShadow = true;
  prom.name = 'promenade';
  group.add(prom);

  const wallParts: BufferGeometry[] = [];
  const seaFace = box(PROMENADE.x1 - PROMENADE.x0, CITY_Y + promH - (CITY_Y - 0.6), 0.5, (PROMENADE.x0 + PROMENADE.x1) / 2, CITY_Y - 0.6, PROMENADE.z0 - 0.25);
  wallParts.push(seaFace);
  for (let x = PROMENADE.x0 + 6; x < PROMENADE.x1 - 6; x += 44) {
    const len = 38;
    const cx = Math.min(x + len / 2, PROMENADE.x1 - len / 2 - 2);
    wallParts.push(box(len, 0.62, 0.45, cx, CITY_Y + promH, PROMENADE.z0 + 0.3));
    wallParts.push(box(len + 0.2, 0.08, 0.6, cx, CITY_Y + promH + 0.62, PROMENADE.z0 + 0.3));
  }
  const wall = new Mesh(mergeGeometries(wallParts), stuccoMaterial(0xf3e6d6));
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.name = 'seawall';
  group.add(wall);

  // Roads.
  const roads: BufferGeometry[] = [];
  roads.push(roadStrip((BEACH_ROAD.x0 + BEACH_ROAD.x1) / 2, (BEACH_ROAD.z0 + BEACH_ROAD.z1) / 2, BEACH_ROAD.x1 - BEACH_ROAD.x0, BEACH_ROAD.z1 - BEACH_ROAD.z0, true));
  for (const s of STREETS_EW) roads.push(roadStrip((STREET_WEST + STREET_EAST) / 2, s.z, STREET_EAST - STREET_WEST, s.width, true));
  // Avenues stop at each cross street (which carries the crossing), so no two road
  // surfaces overlap and their lane markings never fight; north of the island they
  // carry on as causeways.
  const crossings = STREETS_EW.map((e) => [e.z - e.width / 2, e.z + e.width / 2] as const);
  for (const s of STREETS_NS) {
    for (const [a, b] of spans(BEACH_ROAD.z1, s.frame ? FRAME_END : CAUSEWAY_END, crossings)) roads.push(roadStrip(s.x, (a + b) / 2, b - a, s.width, false));
  }
  const roadMesh = new Mesh(mergeGeometries(roads), asphaltTextured(textureSet('asphalt', 3, '2k')));
  roadMesh.receiveShadow = true;
  roadMesh.name = 'roads';
  group.add(roadMesh);

  // Kerbed sidewalks along both sides of each street, interrupted at crossings.
  const walks: BufferGeometry[] = [];
  const walkW = 2.2;
  const curbH = 0.14;
  const xMin = STREET_WEST;
  const xMax = STREET_EAST;
  const zMax = CITY.z1;
  const nsCuts = STREETS_NS.map((s) => [s.x - s.width / 2 - walkW, s.x + s.width / 2 + walkW] as const);
  const ewCuts = [
    [BEACH_ROAD.z0 - walkW, BEACH_ROAD.z1 + walkW] as const,
    ...STREETS_EW.map((s) => [s.z - s.width / 2 - walkW, s.z + s.width / 2 + walkW] as const),
  ];
  const ewLine = (z: number) => {
    for (const [a, b] of spans(xMin, xMax, nsCuts)) walks.push(box(b - a, curbH, walkW, (a + b) / 2, CITY_Y, z));
  };
  const nsLine = (x: number, end: number = zMax) => {
    for (const [a, b] of spans(BEACH_ROAD.z1, end, ewCuts)) walks.push(box(walkW, curbH, b - a, x, CITY_Y, (a + b) / 2));
  };
  ewLine(BEACH_ROAD.z1 + walkW / 2);
  for (const s of STREETS_EW) {
    ewLine(s.z - s.width / 2 - walkW / 2);
    ewLine(s.z + s.width / 2 + walkW / 2);
  }
  for (const s of STREETS_NS) {
    nsLine(s.x - s.width / 2 - walkW / 2, s.frame ? FRAME_END + walkW : zMax);
    nsLine(s.x + s.width / 2 + walkW / 2, s.frame ? FRAME_END + walkW : zMax);
  }
  const walkMesh = new Mesh(mergeGeometries(walks), groundMaterial(textureSet('concrete', 1.8), new Color(0xf0ebe4)));
  walkMesh.receiveShadow = true;
  walkMesh.name = 'sidewalks';
  group.add(walkMesh);

  return group;
}
