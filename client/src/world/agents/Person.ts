import {
  type AnimationAction,
  type AnimationClip,
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
const LOD_DISTANCE = 42;
const up = new Vector3(0, 1, 0);
const tmpV = new Vector3();
const tmpQ = new Quaternion();

export class Person {
  readonly root = new Group();
  private readonly body = new Group();
  private model: Object3D | null = null;
  private lods: SkinnedMesh[] = [];
  private headBone: Bone | null = null;
  private mixer: AnimationMixer | null = null;
  private clips = new Map<string, AnimationClip>();
  private current: AnimationAction | null = null;
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
      const m = o as SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.lods.push(m);
    });
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
    const stand = mood === 'ask' || mood === 'celebrate' || !this.seatedSpot;
    this.faceCamera = mood === 'ask';

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
    if (mood === 'celebrate' && !instant) {
      this.playOnce(this.clips.has('fist_pump') ? 'fist_pump' : 'cheer', () => {
        this.mood = null;
        this.setMood('relax');
      });
      return;
    }
    this.loop(this.loopClip(mood ?? 'relax'), instant);
    this.variationAt = this.clock + 6 + Math.random() * 8;
  }

  private loopClip(mood: Mood): string {
    if (this.seated) {
      if (mood === 'work') return this.table ? 'work_table' : 'sitting_writing';
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
      if (m === 'work') return this.table ? 'sit_table_idle' : null;
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
    this.body.position.set(ge.pos[0], 0, ge.pos[2]);
    this.baseYaw = ge.yaw;
    this.yaw = ge.yaw;
    this.body.rotation.y = ge.yaw;
  }

  /** Start the sit-down where it will end on the seat. */
  private prepareSitDown(clip: string) {
    const ge = this.cast.clipInfo(this.skeleton, clip)?.groundEnd;
    if (!ge) return;
    const yaw = -ge.yaw;
    tmpV.set(-ge.pos[0], 0, -ge.pos[2]).applyAxisAngle(up, yaw);
    this.body.position.set(tmpV.x, this.spot.seatH - this.seatClip, tmpV.z);
    this.baseYaw = yaw;
    this.yaw = yaw;
    this.body.rotation.y = yaw;
  }

  update(dt: number, camera: Camera) {
    if (!this.mixer || !this.model) return;
    this.clock += dt;
    const dist = camera.position.distanceTo(this.root.position);

    // Level of detail, and fewer animation updates far away.
    const near = dist < LOD_DISTANCE;
    if (this.lods.length > 1) {
      this.lods[0].visible = near;
      this.lods[1].visible = !near;
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
