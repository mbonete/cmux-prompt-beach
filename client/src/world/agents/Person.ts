import {
  type AnimationAction,
  AnimationClip,
  AnimationMixer,
  type Bone,
  type Camera,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three/webgpu';
import type { Spot } from '../city/District';
import type { Cast, Skeleton } from './cast';

// One agent as a person on their plot. A mood comes from the agent's state;
// the person gets there with motion-captured transitions (standing up from a
// desk, sitting back down) and then loops a fitting clip, with small
// variations so a busy plot never looks like a copy-paste.

export type Mood = 'work' | 'ask' | 'celebrate' | 'relax' | 'doze';

const FADE = 0.35;
/**
 * The seated wave blends over the seated pose with normalised weights: this
 * much heavier, it owns the bones it has (arm, neck, head), and the seated
 * clip keeps the rest.
 */
const OVERLAY_WEIGHT = 40;
const LOD_DISTANCE = 42;
export const SHADOW_DISTANCE = 70;
const up = new Vector3(0, 1, 0);
const tmpV = new Vector3();
const tmpQ = new Quaternion();

export class Person {
  readonly root = new Group();
  private readonly body = new Group();
  private model: Object3D | null = null;
  /** The `lod0` / `lod1` nodes (each holds one skinned mesh per material). */
  private lods: Object3D[] = [];
  private meshes: SkinnedMesh[] = [];
  private shadows = true;
  private headBone: Bone | null = null;
  private mixer: AnimationMixer | null = null;
  private clips = new Map<string, AnimationClip>();
  private current: AnimationAction | null = null;
  /** The wave from the waist up, playing over a seated pose (someone who needs you but has no room to stand). */
  private overlay: AnimationAction | null = null;
  private waveUpper: AnimationClip | null | undefined;
  private onDone: (() => void) | null = null;
  private seated: boolean;
  private mood: Mood | null = null;
  private pending: Mood | null = null;
  private busy = false;
  private faceCamera = false;
  private yaw = 0;
  private baseYaw = 0;
  private variationAt = 0;
  private clock = 0;
  private skipAccum = 0;
  private readonly skeleton: Skeleton;
  private readonly seatClip: number;
  reducedMotion = false;
  readonly ready: Promise<void>;

  constructor(
    readonly id: string,
    readonly avatarId: string,
    readonly spot: Spot,
    private readonly cast: Cast,
  ) {
    this.root.name = `person:${id}`;
    this.root.position.copy(spot.position);
    this.root.quaternion.copy(spot.quaternion);
    this.root.add(this.body);
    this.skeleton = cast.info(avatarId).skeleton;
    this.seated = this.seatedSpot;
    const f = cast.manifest.furniture;
    this.seatClip = (this.table ? f.seatHeightTable : f.seatHeightChair) ?? 0.46;
    this.ready = this.load();
  }

  /**
   * Whether standing up from this seat lands on clear floor (People asks the
   * district). Standing up from a lounger walked them onto it; from a bar stool,
   * into the counter. Where it isn't clear they stay seated: the badge and the
   * ring still say they need you.
   */
  roomToStand = true;

  /** Where standing up from this seat would leave them (world), or null for a standing spot. */
  standPoint(out: Vector3): Vector3 | null {
    if (!this.seatedSpot) return null;
    const ge = this.cast.clipInfo(this.skeleton, this.table ? 'stand_up_table' : 'stand_up_chair')?.groundEnd;
    out.set(ge ? ge.pos[0] : 0, 0, ge ? ge.pos[2] : 0.45);
    return out.applyQuaternion(this.spot.quaternion).add(this.spot.position);
  }

  private get seatedSpot() {
    return this.spot.kind !== 'standing';
  }

  private get table() {
    return this.spot.kind === 'desk' || this.spot.kind === 'stool';
  }

  private async load() {
    const [model, clips] = await Promise.all([this.cast.avatar(this.avatarId), this.cast.clips(this.skeleton)]);
    this.model = model;
    this.clips = clips;
    model.traverse((o) => {
      const lod = /^lod(\d)$/.exec(o.name);
      if (lod) this.lods[Number(lod[1])] = o;
      const m = o as SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.meshes.push(m);
    });
    this.lods = this.lods.filter(Boolean);
    model.traverse((o) => {
      if (!this.headBone && /Head$/.test(o.name) && (o as Bone).isBone) this.headBone = o as Bone;
    });
    this.body.add(model);
    this.mixer = new AnimationMixer(model);
    this.mixer.addEventListener('finished', () => {
      const done = this.onDone;
      this.onDone = null;
      this.busy = false;
      done?.();
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.setMood(next);
      }
    });
    this.restOffset();
    if (this.mood) {
      const m = this.mood;
      this.mood = null;
      this.setMood(m, true);
    }
  }

  /** Where a badge should float: just above the head. */
  headPosition(out: Vector3): Vector3 {
    if (this.headBone) return this.headBone.getWorldPosition(out).add(tmpV.set(0, 0.42, 0));
    return this.root.localToWorld(out.set(0, (this.seated ? 1.35 : 1.95) + this.body.position.y, 0));
  }

  setMood(mood: Mood, instant = false) {
    if (!this.mixer) {
      this.mood = mood;
      return;
    }
    if (this.busy) {
      this.pending = mood;
      return;
    }
    if (mood === this.mood && this.current) return;
    this.mood = mood;
    instant ||= this.reducedMotion;
    const stand = ((mood === 'ask' || mood === 'celebrate') && this.roomToStand) || !this.seatedSpot;
    // Turning toward the camera is for someone standing; seated, it swung them off the seat.
    this.faceCamera = mood === 'ask' && stand;

    this.setOverlay(false);
    if (stand && this.seated) {
      const clip = this.table ? 'stand_up_table' : 'stand_up_chair';
      if (instant || !this.clips.has(clip)) {
        this.seated = false;
        this.applyGroundEnd(clip);
        this.continueMood(instant);
      } else {
        this.playOnce(clip, () => {
          this.seated = false;
          this.applyGroundEnd(clip);
          this.continueMood();
        });
      }
      return;
    }
    if (!stand && !this.seated && this.seatedSpot) {
      const clip = this.table ? 'sit_down_table' : 'sit_down_chair';
      this.faceCamera = false;
      if (instant || !this.clips.has(clip)) {
        this.seated = true;
        this.restOffset();
        this.continueMood(instant);
      } else {
        this.prepareSitDown(clip);
        this.playOnce(clip, () => {
          this.seated = true;
          this.restOffset();
          this.continueMood();
        });
      }
      return;
    }
    this.continueMood(instant);
  }

  private continueMood(instant = false) {
    const mood = this.mood;
    // The fist pump is a standing clip; someone who stayed seated just relaxes.
    if (mood === 'celebrate' && this.seated) {
      this.mood = 'relax';
    } else if (mood === 'celebrate' && !instant) {
      this.playOnce(this.clips.has('fist_pump') ? 'fist_pump' : 'cheer', () => {
        this.mood = null;
        this.setMood('relax');
      });
      return;
    }
    this.loop(this.loopClip(mood ?? 'relax'), instant);
    this.setOverlay(this.seated && mood === 'ask');
    this.variationAt = this.clock + 6 + Math.random() * 8;
  }

  /** The wave, from the waist up: the waving arm, neck and head only (the seated pose keeps the rest). */
  private seatedWave(): AnimationClip | null {
    if (this.waveUpper !== undefined) return this.waveUpper;
    const wave = this.clips.get('wave');
    if (!wave) return (this.waveUpper = null);
    // The waving arm is the upper arm that turns the most.
    const swing = (side: string) => {
      const v = wave.tracks.find((t) => t.name === `Bip01_${side}_UpperArm.quaternion`)?.values;
      if (!v) return 0;
      let least = 1;
      for (let i = 4; i < v.length; i += 4) least = Math.min(least, Math.abs(v[0] * v[i] + v[1] * v[i + 1] + v[2] * v[i + 2] + v[3] * v[i + 3]));
      return 1 - least;
    };
    const side = swing('R') >= swing('L') ? 'R' : 'L';
    const keep = new RegExp(`^Bip01_(Neck|Head|${side}_(Clavicle|UpperArm|Forearm|Hand|Finger\\d*))\\.`);
    this.waveUpper = new AnimationClip('wave_seated', wave.duration, wave.tracks.filter((t) => keep.test(t.name)));
    return this.waveUpper;
  }

  private setOverlay(on: boolean) {
    if (!this.mixer || on === Boolean(this.overlay)) return;
    if (!on) {
      this.overlay!.fadeOut(FADE);
      this.overlay = null;
      return;
    }
    const clip = this.seatedWave();
    if (!clip) return;
    const a = this.mixer.clipAction(clip);
    a.reset();
    a.setLoop(LoopRepeat, Infinity);
    a.setEffectiveWeight(OVERLAY_WEIGHT);
    a.fadeIn(FADE);
    a.play();
    this.overlay = a;
  }

  private loopClip(mood: Mood): string {
    if (this.seated) {
      // Rocketbox's work_table is a standing lean; at a desk, forearms on the table reads as typing.
      if (mood === 'work') return this.table ? 'sit_table_idle' : 'sitting_writing';
      if (mood === 'doze') return this.table ? 'sit_table_relaxed' : 'sit_chair_relaxed';
      return this.table ? 'sit_table_relaxed' : 'sit_chair_relaxed';
    }
    if (mood === 'ask') return 'wave';
    if (mood === 'work') return 'phone_text';
    return 'idle';
  }

  /** Occasional variations: a look around between waves, a yawn while dozing, a pause while typing. */
  private variation(): string | null {
    const m = this.mood;
    if (this.seated) {
      if (m === 'work') return this.table ? 'sit_table_relaxed' : null;
      if (m === 'doze') return this.table ? 'sit_table_yawn' : 'sit_chair_yawn';
      if (m === 'relax') return this.table ? 'sit_table_idle' : null;
      return null;
    }
    if (m === 'ask') return Math.random() < 0.5 ? 'idle_look' : 'phone_talk';
    if (m === 'relax') return Math.random() < 0.5 ? 'idle_look' : 'stretch';
    return null;
  }

  private playOnce(name: string, then: () => void) {
    if (!this.play(name, true)) {
      then();
      return;
    }
    this.busy = true;
    this.onDone = then;
  }

  private loop(name: string, instant = false) {
    if (!this.play(name, false) && name !== 'idle') this.play(this.seated ? (this.table ? 'sit_table_idle' : 'sit_chair_relaxed') : 'idle', false);
    if (instant && this.current) {
      this.current.time = this.current.getClip().duration * 0.35;
      this.mixer!.update(0);
    }
  }

  private play(name: string, once: boolean): boolean {
    const clip = this.clips.get(name);
    if (!clip || !this.mixer) return false;
    const a = this.mixer.clipAction(clip);
    a.reset();
    a.setLoop(once ? LoopOnce : LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.enabled = true;
    a.setEffectiveTimeScale(1);
    a.setEffectiveWeight(1);
    if (this.current && this.current !== a) a.crossFadeFrom(this.current, FADE, false);
    a.play();
    this.current = a;
    return true;
  }

  /** Seated in place: lift or lower so the clip's seat matches the furniture. */
  private restOffset() {
    this.body.position.set(0, this.seated ? this.spot.seatH - this.seatClip : 0, 0);
    this.baseYaw = 0;
    this.yaw = 0;
    this.body.rotation.y = 0;
  }

  private applyGroundEnd(clip: string) {
    const ge = this.cast.clipInfo(this.skeleton, clip)?.groundEnd;
    if (!ge) {
      this.body.position.set(0, 0, 0.45);
      return;
    }
    const yaw = MathUtils.degToRad(ge.yawDeg ?? 0);
    this.body.position.set(ge.pos[0], 0, ge.pos[2]);
    this.baseYaw = yaw;
    this.yaw = yaw;
    this.body.rotation.y = yaw;
  }

  /** Start the sit-down where it will end on the seat. */
  private prepareSitDown(clip: string) {
    const ge = this.cast.clipInfo(this.skeleton, clip)?.groundEnd;
    if (!ge) return;
    const yaw = -MathUtils.degToRad(ge.yawDeg ?? 0);
    tmpV.set(-ge.pos[0], 0, -ge.pos[2]).applyAxisAngle(up, yaw);
    this.body.position.set(tmpV.x, this.spot.seatH - this.seatClip, tmpV.z);
    this.baseYaw = yaw;
    this.yaw = yaw;
    this.body.rotation.y = yaw;
  }

  /**
   * `inView`: whether the camera can see them or their shadow (People decides,
   * once per frame). Off screen they're neither drawn nor animated; the time
   * they missed is played on their next visible frame, so they don't freeze.
   */
  update(dt: number, camera: Camera, inView = true) {
    if (!this.mixer || !this.model) return;
    this.clock += dt;
    if (this.root.visible !== inView) this.root.visible = inView;
    if (!inView) {
      this.skipAccum = Math.min(this.skipAccum + dt, 2);
      return;
    }
    const dist = camera.position.distanceTo(this.root.position);

    // Level of detail, and fewer animation updates far away.
    const near = dist < LOD_DISTANCE;
    if (this.lods.length > 1) {
      this.lods[0].visible = near;
      this.lods[1].visible = !near;
    }
    // A person's shadow is a few pixels from far away; skip it there.
    const shadows = dist < SHADOW_DISTANCE;
    if (shadows !== this.shadows) {
      this.shadows = shadows;
      for (const m of this.meshes) m.castShadow = shadows;
    }
    this.skipAccum += dt;
    const every = dist > 160 ? 3 : dist > 80 ? 2 : 1;
    if (Math.round(this.clock * 60) % every === 0 || this.busy) {
      this.mixer.update(this.reducedMotion ? 0 : this.skipAccum);
      this.skipAccum = 0;
    }

    // Someone who needs you turns toward the camera while they wave.
    let target = this.baseYaw;
    if (this.faceCamera && !this.busy) {
      tmpQ.copy(this.root.quaternion).invert();
      tmpV.copy(camera.position).sub(this.root.position).applyQuaternion(tmpQ);
      const toCam = Math.atan2(tmpV.x, tmpV.z);
      target = this.baseYaw + MathUtils.clamp(angleDiff(this.baseYaw, toCam), -1.4, 1.4);
    }
    this.yaw += angleDiff(this.yaw, target) * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 3));
    this.body.rotation.y = this.yaw;

    if (!this.busy && this.clock > this.variationAt && !this.reducedMotion) {
      const v = this.variation();
      this.variationAt = this.clock + 9 + Math.random() * 12;
      if (v && this.clips.has(v)) this.playOnce(v, () => this.continueMood());
    }
  }

  dispose() {
    this.mixer?.stopAllAction();
    this.root.removeFromParent();
  }
}

function angleDiff(a: number, b: number) {
  return ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}
