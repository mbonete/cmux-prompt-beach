import {
  AdditiveBlending,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  type Scene,
  Vector3,
} from 'three/webgpu';
import { attribute, float, instancedBufferAttribute, int, materialEmissive, pow, smoothstep, texture, uniform, uniformArray, uv, vec2, vec3 } from 'three/tsl';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import { aoAtlas, mergeStatic, type MergeSource } from '../engine/merge';
import { loadGLTF, loadJSON } from '../engine/assets';
import { InstancedModel } from '../engine/instancer';
import { perInstanceEmission } from '../engine/materials';
import { Beam, PlotOutline, STATE_COLORS } from './markers';
import { HANGOUT, PLOTS, PLOT_COUNT } from './layout';
import { beachHeight } from '../env/ground';

// The plots: a fixed building per plot (authored), always present. A vacant
// plot sits shuttered and dark; when a repo moves in its windows and neon come
// on, its outline lights in the repo's colour, and its tag appears. Buildings
// and props are instanced across plots.

export type PlotKey = number | 'hangout';

export interface Spot {
  position: Vector3;
  quaternion: Quaternion;
  kind: 'desk' | 'lounger' | 'stool' | 'bench' | 'steps' | 'standing';
  seatH: number;
  tableH: number;
}

export interface PlotState {
  key: PlotKey;
  occupied: boolean;
  /** A repo that has no sessions right now (kept 7 days): tag and outline dimmed. */
  dormant: boolean;
  color: Color;
  needs: boolean;
}

interface BuildingManifest {
  assets: Record<string, { kind: string; files: string[] }>;
  /** Which building stands where; owned by the buildings kit. Falls back to PLOT_DESIGN. */
  layout?: { plots?: string[]; hangout?: string };
}

/** Coarse height map of a building type: max height per 2 m cell over a 24 × 20 m area. */
interface HeightGrid {
  cells: Float32Array;
}
const CELL = 2;
const GRID_W = 12; // 24 m along local X (plot 20 m + 2 m each side)
const GRID_D = 10; // 20 m along local Z

interface PlotRuntime {
  key: PlotKey;
  type: string;
  world: Matrix4;
  inverse: Matrix4;
  /** Index into the per-plot light levels the merged buildings read. */
  slot: number;
  spots: Spot[];
  tag: Vector3;
  beam: Vector3;
  outline: PlotOutline;
  beamFx: Beam;
}

/** Preferred building per plot index; the first one available in the kit is used. */
const PLOT_DESIGN: string[][] = [
  ['plot_deco_hotel'],
  ['plot_beach_cafe', 'plot_diner', 'plot_deco_hotel'],
  ['plot_diner', 'plot_deco_hotel'],
  ['plot_deco_hotel'],
];
const HANGOUT_DESIGN = ['plot_beach_bar', 'plot_beach_cafe', 'plot_deco_hotel'];

/** Pastel stucco tints, cycled across plots so repeated buildings still read as different. */
const PASTELS = [0xf6c5c0, 0xbfe9dc, 0xfae3a8, 0xc8dcf6, 0xe3cff4, 0xf8d5b2, 0xffffff, 0xd8f0c4].map((h) => new Color(h));

/** Neon colours for repos (pink is reserved for "needs you"). */
const REPO_NEON = [0x2fd8ff, 0xffb347, 0xa78bfa, 0x5dffa8, 0xff9f6b, 0x7dd3fc, 0xffd166, 0xd9a4ff, 0x34e3c4, 0xc4f25a].map((h) => new Color(h));

export function repoColor(key: string): Color {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return REPO_NEON[Math.abs(h) % REPO_NEON.length];
}

const BASE = '/assets/buildings/';
/** 32 plots, the beach bar and the co-working. */
const SLOTS = PLOT_COUNT + 2;
/** Materials whose shadows matter; glass, lights, water and floors don't cast. */
// Metal is mostly thin (stool rings, rails, ribs): its shadows were finer than a
// shadow texel and flickered, so it doesn't cast.
const CASTS = new Set(['stucco', 'trim', 'concrete', 'roof', 'wood', 'awning', 'planter', 'glass_block']);

export class District {
  readonly group = new Group();
  private readonly plots = new Map<PlotKey, PlotRuntime>();
  /** Per plot (slot): windows and neon (0.08 vacant … 1 lived in), and terrace bulbs. */
  private readonly windowLit = uniformArray(new Array(SLOTS).fill(0.08), 'float');
  private readonly bulbLit = uniformArray(new Array(SLOTS).fill(0), 'float');
  /** Terrace string lights and lanterns: 0 by day, about 1.5 at night. */
  readonly lampsLevel = uniform(0.1);
  /** Where the plots want palms (from `palm_N` empties), with their heights. */
  readonly palmSpots: { position: Vector3; height: number }[] = [];
  private pools: { mesh: InstancedMesh; lit: InstancedBufferAttribute; owner: PlotKey[] } | null = null;
  /** Laptop screens: glowing where someone lives, more so after dark. */
  readonly screensLevel = uniform(0.6);
  private readonly screens: { attr: InstancedBufferAttribute; owner: PlotKey[] }[] = [];
  private readonly heights = new Map<string, HeightGrid>();
  readonly windowsLevel = uniform(1);
  readonly neonLevel = uniform(1);

  constructor(private readonly scene: Scene) {
    this.group.name = 'district';
    scene.add(this.group);
  }

  async load(): Promise<void> {
    const manifest = await loadJSON<BuildingManifest>(`${BASE}manifest.json`);
    const available = new Set(Object.entries(manifest.assets).filter(([, a]) => a.kind === 'plot').map(([id]) => id));
    const pick = (prefs: string[]) => prefs.find((p) => available.has(p)) ?? [...available][0];

    const lay = manifest.layout ?? {};
    const prefer = (first: string | undefined, rest: string[]) => pick(first ? [first, ...rest] : rest);
    const slots: { key: PlotKey; x: number; y: number; z: number; rot: number; type: string }[] = [
      ...PLOTS.map((p) => ({ key: p.index as PlotKey, x: p.x, y: 0, z: p.z, rot: p.rot, type: prefer(lay.plots?.[p.index], PLOT_DESIGN[p.index % PLOT_DESIGN.length]) })),
      // The beach bar stands on the sand (its deck sits on posts).
      { key: 'hangout', ...HANGOUT, y: beachHeight(HANGOUT.z, HANGOUT.x), type: prefer(lay.hangout, HANGOUT_DESIGN) },
    ];

    // Load each building type once; read its empties (spots, anchors, props).
    const types = [...new Set(slots.map((s) => s.type))];
    const templates = new Map(await Promise.all(types.map(async (t) => [t, (await loadGLTF(`${BASE}${t}.gltf`)).scene] as const)));
    const t0 = performance.now();

    for (const t of types) this.heights.set(t, heightGrid(templates.get(t)!));

    const propPlacements = new Map<string, { m: Matrix4; key: PlotKey }[]>();
    const poolSpots: { m: Matrix4; radius: number; color: Color; key: PlotKey }[] = [];
    const floors = new Map<string, Map<string, number>>();
    for (const t of types) {
      let needsRay = false;
      templates.get(t)!.traverse((o) => {
        if (/^light_\d+$/.test(o.name) && (o.userData as { floor_y?: number }).floor_y === undefined) needsRay = true;
      });
      if (needsRay) floors.set(t, lightFloors(templates.get(t)!));
    }
    const sources = new Map<string, MergeSource>(types.map((t) => [t, { template: meshOnly(templates.get(t)!), placements: [] }]));

    slots.forEach((s, i) => {
      const template = templates.get(s.type)!;
      const world = new Matrix4().compose(new Vector3(s.x, s.y, s.z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), s.rot), new Vector3(1, 1, 1));
      sources.get(s.type)!.placements.push({ matrix: world, tint: PASTELS[i % PASTELS.length], slot: i });
      const spots: Spot[] = [];
      let tag = new Vector3(s.x, 14, s.z);
      let beam = new Vector3(s.x, 0, s.z);
      template.updateMatrixWorld(true);
      template.traverse((o) => {
        const m = new Matrix4().multiplyMatrices(world, o.matrixWorld);
        if (/^spot_\d$/.test(o.name)) {
          const e = o.userData as { spot_kind?: Spot['kind']; spot_index?: number; seat_h?: number; table_h?: number };
          const pos = new Vector3();
          const q = new Quaternion();
          m.decompose(pos, q, new Vector3());
          spots[e.spot_index ?? Number(o.name.slice(5))] = { position: pos, quaternion: q, kind: e.spot_kind ?? 'standing', seatH: e.seat_h ?? 0.46, tableH: e.table_h ?? 0.74 };
        } else if (/^light_\d+$/.test(o.name)) {
          const e = o.userData as { light_radius?: number; light_color?: string; floor_y?: number };
          // The kit says where the floor under each light is; older outputs fall back to a raycast.
          const floor = e.floor_y ?? floors.get(s.type)?.get(o.name) ?? 0.05;
          const local = new Vector3().setFromMatrixPosition(o.matrixWorld);
          local.y = floor + 0.04;
          const at = local.applyMatrix4(world);
          const r = Math.max(1.5, Math.min(7, e.light_radius ?? 3.5));
          poolSpots.push({ m: new Matrix4().compose(at, new Quaternion(), new Vector3(r, 1, r)), radius: r, color: new Color(e.light_color ?? '#ffcf96'), key: s.key });
        } else if (/^palm_\d+$/.test(o.name)) {
          const e = o.userData as { palm_height?: number };
          const at = new Vector3().setFromMatrixPosition(m);
          // On the sand (the beach bar), palms stand on the dunes, not at the deck's origin height.
          if (s.key === 'hangout') at.y = beachHeight(at.z, at.x);
          this.palmSpots.push({ position: at, height: e.palm_height ?? 8 });
        } else if (o.name === 'tag_anchor') tag = new Vector3().setFromMatrixPosition(m);
        else if (o.name === 'beam_anchor') beam = new Vector3().setFromMatrixPosition(m);
        else if (o.name.startsWith('prop:')) {
          const id = (o.userData as { prop_id?: string }).prop_id ?? o.name.slice(5).replace(/\.\d+$/, '');
          if (!propPlacements.has(id)) propPlacements.set(id, []);
          propPlacements.get(id)!.push({ m, key: s.key });
        }
      });

      const outline = new PlotOutline();
      outline.group.position.set(s.x, s.y, s.z);
      outline.group.rotation.y = s.rot;
      outline.group.visible = false;
      const beamFx = new Beam();
      beamFx.group.position.copy(beam);
      beamFx.setColumnBase(Math.max(4, tag.y - beam.y - 3));
      this.group.add(outline.group, beamFx.group);
      this.plots.set(s.key, { key: s.key, type: s.type, world, inverse: world.clone().invert(), slot: i, spots, tag, beam, outline, beamFx });
      this.setLit(s.key, 0.08);
    });

    const t1 = performance.now();
    this.buildMerged([...sources.values()]);
    if (location.search.includes('perf')) console.log(`[switchboard] district: buildings loaded at ${Math.round(t0)} ms, read in ${Math.round(t1 - t0)} ms, merged in ${Math.round(performance.now() - t1)} ms`);
    this.buildPools(poolSpots);
    await this.placeProps(propPlacements);
  }

  /** Every plot building, merged by material: one draw per material for the whole district. */
  private buildMerged(sources: MergeSource[]) {
    const atlas = aoAtlas(sources);
    const { parts } = mergeStatic(sources, { tintable: new Set(['stucco']), atlas });
    for (const { mesh, name, detail } of parts) {
      mesh.castShadow = CASTS.has(name) && !detail;
      mesh.receiveShadow = true;
      if (name === 'interior' || name === 'neon_accent' || name === 'bulb') {
        const mat = mesh.material as MeshStandardNodeMaterial;
        const map = mat.emissiveMap ? vec3(texture(mat.emissiveMap, uv()).rgb) : vec3(1, 1, 1);
        // The slot arrives interpolated (3.0 can be 2.9999998): round, never truncate,
        // or windows take a neighbouring plot's light and flicker with the AA jitter.
        const slot = int(attribute('aSlot', 'float').add(0.5));
        const lit = float((name === 'bulb' ? this.bulbLit : this.windowLit).element(slot) as never);
        const level = name === 'interior' ? this.windowsLevel : name === 'bulb' ? this.lampsLevel : this.neonLevel;
        mat.emissiveNode = vec3(materialEmissive).mul(map).mul(lit).mul(level);
      }
      this.group.add(mesh);
    }
  }

  /** Soft warm pools of light on the terraces at night: additive discs, no real lights. */
  private buildPools(spots: { m: Matrix4; color: Color; key: PlotKey }[]) {
    if (!spots.length) return;
    const geo = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const colors = new InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
    const lit = new InstancedBufferAttribute(new Float32Array(spots.length), 1);
    spots.forEach((sp, i) => colors.setXYZ(i, sp.color.r, sp.color.g, sp.color.b));
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    const d = uv().sub(vec2(0.5)).length().mul(2);
    const falloff = pow(float(1).sub(smoothstep(0, 1, d)), float(2.2));
    const c = instancedBufferAttribute(colors, 'vec3') as unknown as ReturnType<typeof vec2>;
    const l = instancedBufferAttribute(lit, 'float') as unknown as ReturnType<typeof float>;
    mat.colorNode = c.mul(falloff).mul(l).mul(this.lampsLevel).mul(0.42) as never;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    const mesh = new InstancedMesh(geo, mat, spots.length);
    spots.forEach((sp, i) => mesh.setMatrixAt(i, sp.m));
    mesh.computeBoundingSphere();
    mesh.renderOrder = 3;
    mesh.name = 'light-pools';
    this.group.add(mesh);
    this.pools = { mesh, lit, owner: spots.map((sp) => sp.key) };
  }

  private async placeProps(placements: Map<string, { m: Matrix4; key: PlotKey }[]>) {
    const env = await loadJSON<{ assets?: Record<string, { files?: string[] }> }>('/assets/env/manifest.json').catch(() => ({ assets: {} as Record<string, { files?: string[] }> }));
    await Promise.all(
      [...placements].map(async ([id, mats]) => {
        const files = env.assets?.[id]?.files ?? [];
        // The manifest lists files relative to env/; without it, fall back to the conventional path.
        const file = files.find((f) => f.endsWith('.gltf')) ?? `props/${id}/${id}.gltf`;
        try {
          const gltf = await loadGLTF(`/assets/env/${file}`);
          const model = new InstancedModel(meshOnly(gltf.scene, true), mats.length);
          for (const { m } of mats) model.add(m);
          for (const mesh of model.meshes) {
            const mat = mesh.material as unknown as { name?: string; emissive?: Color };
            if (mat.name !== 'screen') continue;
            mat.emissive = new Color(0x8fb8ff);
            const attr = perInstanceEmission(mesh, this.screensLevel);
            attr.array.fill(0);
            attr.needsUpdate = true;
            this.screens.push({ attr, owner: mats.map((x) => x.key) });
          }
          model.addTo(this.group);
        } catch (err) {
          console.warn(`Prop ${id} failed to load`, err);
        }
      }),
    );
  }

  /** Window and neon glow for one plot (0 = shuttered, 1 = lived in). */
  private setLit(key: PlotKey, value: number) {
    const p = this.plots.get(key);
    if (!p) return;
    // Terrace lights are on where someone lives, low on a dormant plot, off on a vacant one.
    const bulb = value >= 1 ? 1 : value >= 0.2 ? 0.25 : 0;
    (this.windowLit.array as number[])[p.slot] = value;
    (this.bulbLit.array as number[])[p.slot] = bulb;
    for (const sc of this.screens) {
      sc.owner.forEach((k, i) => {
        if (k === key) sc.attr.setX(i, value >= 1 ? 1 : 0);
      });
      sc.attr.needsUpdate = true;
    }
    if (this.pools) {
      this.pools.owner.forEach((k, i) => {
        if (k === key) this.pools!.lit.setX(i, bulb);
      });
      this.pools.lit.needsUpdate = true;
    }
  }

  /** Current light level per plot, and a pending dim (lights dim only once a change holds). */
  private readonly litNow = new Map<PlotKey, number>();
  private readonly dimLater = new Map<PlotKey, { value: number; at: number }>();

  /** Lights come on at once; they dim only if the change holds for a few seconds (no flicker on a blip). */
  private light(key: PlotKey, value: number) {
    const now = performance.now();
    const cur = this.litNow.get(key);
    if (cur === undefined || value >= cur) {
      this.dimLater.delete(key);
      if (cur !== value) {
        this.litNow.set(key, value);
        this.setLit(key, value);
      }
      return;
    }
    const pending = this.dimLater.get(key);
    if (!pending || pending.value !== value) this.dimLater.set(key, { value, at: now + 8000 });
  }

  private settleLights() {
    if (!this.dimLater.size) return;
    const now = performance.now();
    for (const [key, d] of this.dimLater) {
      if (now < d.at) continue;
      this.dimLater.delete(key);
      this.litNow.set(key, d.value);
      this.setLit(key, d.value);
    }
  }

  update(states: PlotState[]) {
    const seen = new Set<PlotKey>();
    for (const s of states) {
      const p = this.plots.get(s.key);
      if (!p) continue;
      seen.add(s.key);
      p.outline.group.visible = s.occupied;
      p.outline.setState(s.needs ? STATE_COLORS.needs : s.color, s.needs, s.dormant);
      p.beamFx.set(s.needs && !s.dormant);
      this.light(s.key, s.occupied ? (s.dormant ? 0.25 : 1) : 0.08);
    }
    for (const [key, p] of this.plots) {
      if (seen.has(key)) continue;
      p.outline.group.visible = false;
      p.beamFx.set(false);
      this.light(key, 0.08);
    }
  }

  updateCamera(position: Vector3) {
    this.settleLights();
    for (const p of this.plots.values()) if (p.beamFx.group.visible) p.beamFx.updateCamera(position.x, position.z);
  }

  setNeonLevel(level: number) {
    for (const p of this.plots.values()) p.outline.setLevel(level);
  }

  /** Highest building point near a ground position (metres), for keeping the camera out of buildings. */
  heightAt(x: number, z: number): number {
    let h = 0;
    const v = new Vector3();
    for (const p of this.plots.values()) {
      const e = p.world.elements;
      if (Math.abs(x - e[12]) > 15 || Math.abs(z - e[14]) > 15) continue;
      v.set(x, 0, z).applyMatrix4(p.inverse);
      const gx = Math.floor((v.x + GRID_W) / CELL);
      const gz = Math.floor((v.z + GRID_D) / CELL);
      if (gx < -1 || gz < -1 || gx > GRID_W || gz > GRID_D) continue;
      const grid = this.heights.get(p.type);
      if (!grid) continue;
      // One cell of slack all round.
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = gx + dx;
          const cz = gz + dz;
          if (cx < 0 || cz < 0 || cx >= GRID_W || cz >= GRID_D) continue;
          h = Math.max(h, grid.cells[cz * GRID_W + cx] + p.world.elements[13]);
        }
    }
    return h;
  }

  spot(key: PlotKey, index: number): Spot | null {
    return this.plots.get(key)?.spots[index] ?? null;
  }

  tagAnchor(key: PlotKey): Vector3 | null {
    return this.plots.get(key)?.tag ?? null;
  }

  center(key: PlotKey): Vector3 | null {
    const p = this.plots.get(key);
    return p ? new Vector3().setFromMatrixPosition(p.world) : null;
  }

  get keys() {
    return [...this.plots.keys()];
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

/** For each `light_N` empty, the height of the floor below it (local space), found by a downward ray. */
function lightFloors(root: Object3D): Map<string, number> {
  const out = new Map<string, number>();
  root.updateMatrixWorld(true);
  const meshes: Object3D[] = [];
  root.traverse((o) => {
    if ((o as InstancedMesh).isMesh) meshes.push(o);
  });
  const ray = new Raycaster();
  const down = new Vector3(0, -1, 0);
  root.traverse((o) => {
    if (!/^light_\d+$/.test(o.name)) return;
    const from = new Vector3().setFromMatrixPosition(o.matrixWorld);
    ray.set(from, down);
    const hit = ray
      .intersectObjects(meshes, false)
      .find((h) => h.distance > 0.6 && (h.face?.normal.y ?? 0) > 0.7);
    out.set(o.name, hit ? hit.point.y : 0.05);
  });
  return out;
}

function heightGrid(root: Object3D): HeightGrid {
  const cells = new Float32Array(GRID_W * GRID_D);
  const v = new Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const gx = Math.floor((v.x + GRID_W) / CELL);
      const gz = Math.floor((v.z + GRID_D) / CELL);
      if (gx < 0 || gz < 0 || gx >= GRID_W || gz >= GRID_D) continue;
      const k = gz * GRID_W + gx;
      if (v.y > cells[k]) cells[k] = v.y;
    }
  });
  return { cells };
}

/** A copy of the template keeping only meshes (empties are read separately). */
function meshOnly(root: Object3D, props = false): Object3D {
  const copy = root.clone(true);
  const drop: Object3D[] = [];
  copy.traverse((o) => {
    if (!(o as { isMesh?: boolean }).isMesh && o !== copy && o.children.length === 0) drop.push(o);
    if (props && (o as { isMesh?: boolean }).isMesh && /lod1/i.test(o.name)) drop.push(o);
  });
  for (const o of drop) o.removeFromParent();
  return copy;
}
