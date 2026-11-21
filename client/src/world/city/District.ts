import {
  Color,
  Group,
  type InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  type Scene,
  Vector3,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import { loadGLTF, loadJSON } from '../engine/assets';
import { InstancedModel } from '../engine/instancer';
import { perInstanceEmission } from '../engine/materials';
import { Beam, PlotOutline, STATE_COLORS } from './markers';
import { HANGOUT, OVERFLOW, PLOTS } from './layout';

// The plots: a fixed building per plot (authored), always present. A vacant
// plot sits shuttered and dark; when a repo moves in its windows and neon come
// on, its outline lights in the repo's colour, and its tag appears. Buildings
// and props are instanced across plots.

export type PlotKey = number | 'hangout' | 'overflow';

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
}

interface PlotRuntime {
  key: PlotKey;
  type: string;
  world: Matrix4;
  instance: number;
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
const OVERFLOW_DESIGN = ['plot_coworking', 'plot_deco_hotel'];

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

export class District {
  readonly group = new Group();
  private readonly plots = new Map<PlotKey, PlotRuntime>();
  private readonly models = new Map<string, InstancedModel>();
  private readonly lit: { attr: InstancedBufferAttribute; type: string; mesh: InstancedMesh }[] = [];
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

    const slots: { key: PlotKey; x: number; z: number; rot: number; type: string }[] = [
      ...PLOTS.map((p) => ({ key: p.index as PlotKey, x: p.x, z: p.z, rot: p.rot, type: pick(PLOT_DESIGN[p.index % PLOT_DESIGN.length]) })),
      { key: 'hangout', ...HANGOUT, type: pick(HANGOUT_DESIGN) },
      { key: 'overflow', ...OVERFLOW, type: pick(OVERFLOW_DESIGN) },
    ];

    // Load each building type once; read its empties (spots, anchors, props).
    const types = [...new Set(slots.map((s) => s.type))];
    const templates = new Map(await Promise.all(types.map(async (t) => [t, (await loadGLTF(`${BASE}${t}.gltf`)).scene] as const)));

    const propPlacements = new Map<string, Matrix4[]>();
    for (const t of types) {
      const count = slots.filter((s) => s.type === t).length;
      const model = new InstancedModel(meshOnly(templates.get(t)!), count, { tintable: ['stucco'] });
      model.addTo(this.group);
      this.models.set(t, model);
      for (const mesh of model.meshes) {
        const name = (mesh.material as { name?: string }).name;
        // The per-plot pastel comes from the instance colour, so the wall material itself is white.
        if (name === 'stucco') (mesh.material as unknown as { color: Color }).color.set(0xffffff);
        if (name === 'interior' || name === 'neon_accent') {
          const level = name === 'interior' ? this.windowsLevel : this.neonLevel;
          this.lit.push({ attr: perInstanceEmission(mesh, level), type: t, mesh });
        }
      }
    }

    slots.forEach((s, i) => {
      const template = templates.get(s.type)!;
      const world = new Matrix4().compose(new Vector3(s.x, 0, s.z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), s.rot), new Vector3(1, 1, 1));
      const instance = this.models.get(s.type)!.add(world, PASTELS[i % PASTELS.length]);
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
        } else if (o.name === 'tag_anchor') tag = new Vector3().setFromMatrixPosition(m);
        else if (o.name === 'beam_anchor') beam = new Vector3().setFromMatrixPosition(m);
        else if (o.name.startsWith('prop:')) {
          const id = (o.userData as { prop_id?: string }).prop_id ?? o.name.slice(5).replace(/\.\d+$/, '');
          if (!propPlacements.has(id)) propPlacements.set(id, []);
          propPlacements.get(id)!.push(m);
        }
      });

      const outline = new PlotOutline();
      outline.group.position.set(s.x, 0, s.z);
      outline.group.rotation.y = s.rot;
      outline.group.visible = false;
      const beamFx = new Beam();
      beamFx.group.position.copy(beam);
      beamFx.setColumnBase(Math.max(4, tag.y - beam.y - 3));
      this.group.add(outline.group, beamFx.group);
      this.plots.set(s.key, { key: s.key, type: s.type, world, instance, spots, tag, beam, outline, beamFx });
      this.setLit(s.key, 0.08);
    });

    await this.placeProps(propPlacements);
  }

  private async placeProps(placements: Map<string, Matrix4[]>) {
    const env = await loadJSON<{ assets?: Record<string, { files?: string[] }> }>('/assets/env/manifest.json').catch(() => ({ assets: {} as Record<string, { files?: string[] }> }));
    await Promise.all(
      [...placements].map(async ([id, mats]) => {
        const files = env.assets?.[id]?.files ?? [];
        // The manifest lists files relative to env/; without it, fall back to the conventional path.
        const file = files.find((f) => f.endsWith('.gltf')) ?? `props/${id}/${id}.gltf`;
        try {
          const gltf = await loadGLTF(`/assets/env/${file}`);
          const model = new InstancedModel(meshOnly(gltf.scene, true), mats.length);
          for (const m of mats) model.add(m);
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
    for (const l of this.lit) {
      if (l.type !== p.type) continue;
      l.attr.setX(p.instance, value);
      l.attr.needsUpdate = true;
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
      this.setLit(s.key, s.occupied ? (s.dormant ? 0.25 : 1) : 0.08);
    }
    for (const [key, p] of this.plots) {
      if (seen.has(key)) continue;
      p.outline.group.visible = false;
      p.beamFx.set(false);
      this.setLit(key, 0.08);
    }
  }

  updateCamera(position: Vector3) {
    for (const p of this.plots.values()) if (p.beamFx.group.visible) p.beamFx.updateCamera(position.x, position.z);
  }

  setNeonLevel(level: number) {
    for (const p of this.plots.values()) p.outline.setLevel(level);
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
