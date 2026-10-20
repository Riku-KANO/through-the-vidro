/**
 * Audio foundation shared by both games (design doc: 技術設計 > ディレクトリ構成, core = 音の仕組み).
 *
 *  voices ─▶ [emitter: HRTF panner] ─▶ bus (music | sfx | ambience) ─┬─▶ master ─▶ limiter ─▶ speakers
 *                                                                    └─▶ send ─▶ RoomReverb ─▶ master
 *
 * - The AudioContext stays suspended until the first user gesture (browsers block sound before one;
 *   design doc: UI/UX設計 > 画面ごとの設計 > 読み込み). Later gestures resume it again if the browser
 *   suspended or interrupted it.
 * - Four volumes: master / music / sfx / ambience (サウンドデザイン > 制作方法).
 * - 3D sound with HRTF (サウンドデザイン > 環境音) and per-space reverb with synthesized IRs.
 * No game rules here: callers decide what plays where.
 */
import {
  BUSES,
  type BusName,
  DEFAULT_VOLUMES,
  VOLUME_CHANNELS,
  type VolumeChannel,
  volumeToGain,
} from './mix';
import { ROOM_PRESETS, type RoomPreset, RoomReverb } from './reverb';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A positioned sound source. Connect voices to `input`. */
export interface Emitter {
  readonly input: AudioNode;
  setPosition(p: Vec3): void;
  dispose(): void;
}

export interface AudioEngineOptions {
  room?: RoomPreset;
  /** Concurrent voice cap; extra voices are dropped (protects the audio thread). */
  maxVoices?: number;
  latencyHint?: AudioContextLatencyCategory;
  /** Inject a context (tests, or sharing one context with other code). */
  context?: AudioContext;
}

export interface AudioEngineSnapshot {
  state: string;
  unlocked: boolean;
  sampleRate: number;
  room: string;
  volumes: Record<VolumeChannel, number>;
  voicesStarted: number;
  voicesDropped: number;
  activeVoices: number;
}

interface EmitterRecord {
  panner: PannerNode;
  position: Vec3;
  /** Moved while the context was not running; apply on resume. */
  dirty: boolean;
}

function copy(to: Vec3, from: Vec3): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

/** How much of each bus feeds the room reverb. Tuning values. */
const REVERB_SEND: Record<BusName, number> = { music: 0.5, sfx: 1, ambience: 1 };
/** Smoothing for volume and listener changes, seconds (avoids zipper noise). */
const SMOOTH = 0.03;
const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly reverb: RoomReverb;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly buses: Record<BusName, GainNode>;
  private readonly sends: GainNode[] = [];
  private readonly volumes: Record<VolumeChannel, number> = { ...DEFAULT_VOLUMES };
  private readonly maxVoices: number;
  private voiceEnds: number[] = [];
  private gestureTarget: EventTarget | null = null;
  private isUnlocked = false;
  private resuming = false;
  private voicesStarted = 0;
  private voicesDropped = 0;
  private readonly emitters = new Set<EmitterRecord>();
  private readonly listenerPose = {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };
  private listenerDirty = false;

  /** Create the engine. Its context is suspended until unlock() runs inside a user gesture. */
  static async create(opts: AudioEngineOptions = {}): Promise<AudioEngine> {
    const ctx = opts.context ?? new AudioContext({ latencyHint: opts.latencyHint ?? 'interactive' });
    // Some browsers (or autoplay settings) start the context running. Start silent everywhere so the
    // first gesture is always the moment sound begins.
    if (ctx.state === 'running') await ctx.suspend();
    return new AudioEngine(ctx, opts);
  }

  private constructor(ctx: AudioContext, opts: AudioEngineOptions) {
    this.ctx = ctx;
    this.maxVoices = opts.maxVoices ?? 48;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = volumeToGain(this.volumes.master);
    this.master.connect(this.limiter);
    this.reverb = new RoomReverb(ctx, opts.room ?? ROOM_PRESETS.smallRoom);
    this.reverb.output.connect(this.master);
    const buses = {} as Record<BusName, GainNode>;
    for (const name of BUSES) {
      const bus = ctx.createGain();
      bus.gain.value = volumeToGain(this.volumes[name]);
      bus.connect(this.master);
      const send = ctx.createGain();
      send.gain.value = REVERB_SEND[name];
      bus.connect(send).connect(this.reverb.input);
      this.sends.push(send);
      buses[name] = bus;
    }
    this.buses = buses;
    ctx.addEventListener('statechange', this.onStateChange);
  }

  get state(): string {
    return this.ctx.state;
  }

  /** True once a user gesture asked the context to start. */
  get unlocked(): boolean {
    return this.isUnlocked;
  }

  /**
   * Start (or restart) audio. Must be called from inside a user gesture handler.
   * Never rejects: a browser that refuses (no user activation) just leaves the context suspended.
   */
  unlock(): Promise<void> {
    this.isUnlocked = true;
    if (this.ctx.state === 'closed' || this.ctx.state === 'running') return Promise.resolve();
    this.resuming = true;
    return this.ctx.resume().then(
      () => {
        this.resuming = false;
      },
      () => {
        this.resuming = false;
      },
    );
  }

  private readonly onGesture = (): void => {
    if (this.ctx.state !== 'running') void this.unlock();
  };

  /** Unlock on the first pointer / key / touch on `target`, and resume after any later interruption. */
  bindUnlockGestures(target: EventTarget = window): void {
    this.unbindUnlockGestures();
    this.gestureTarget = target;
    for (const type of GESTURES) target.addEventListener(type, this.onGesture, { capture: true });
  }

  private unbindUnlockGestures(): void {
    if (!this.gestureTarget) return;
    for (const type of GESTURES)
      this.gestureTarget.removeEventListener(type, this.onGesture, { capture: true });
    this.gestureTarget = null;
  }

  /** Volume slider position 0..1 for master / music / sfx / ambience. */
  setVolume(channel: VolumeChannel, value: number): void {
    const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.volumes[channel] = v;
    const node = channel === 'master' ? this.master : this.buses[channel];
    node.gain.setTargetAtTime(volumeToGain(v), this.ctx.currentTime, SMOOTH);
  }

  getVolume(channel: VolumeChannel): number {
    return this.volumes[channel];
  }

  get room(): RoomPreset {
    return this.reverb.room;
  }

  /** Change the acoustic space (crossfades the reverb). */
  setRoom(preset: RoomPreset, fade = 0.6): void {
    this.reverb.setRoom(preset, fade);
  }

  /** Where non-positioned voices of a bus should connect. */
  bus(name: BusName): AudioNode {
    return this.buses[name];
  }

  /**
   * Listener pose (usually the camera): position and unit forward / up vectors, in metres.
   * Safe to call every frame: values are copied, nothing is allocated. While the context is not
   * running, time stands still and automation would pile up, so the latest pose waits for resume.
   */
  setListener(position: Vec3, forward: Vec3, up: Vec3): void {
    const pose = this.listenerPose;
    copy(pose.position, position);
    copy(pose.forward, forward);
    copy(pose.up, up);
    if (this.ctx.state === 'running') this.applyListener();
    else this.listenerDirty = true;
  }

  private applyListener(): void {
    this.listenerDirty = false;
    const { position, forward, up } = this.listenerPose;
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      const tau = SMOOTH / 3;
      l.positionX.setTargetAtTime(position.x, t, tau);
      l.positionY.setTargetAtTime(position.y, t, tau);
      l.positionZ.setTargetAtTime(position.z, t, tau);
      l.forwardX.setTargetAtTime(forward.x, t, tau);
      l.forwardY.setTargetAtTime(forward.y, t, tau);
      l.forwardZ.setTargetAtTime(forward.z, t, tau);
      l.upX.setTargetAtTime(up.x, t, tau);
      l.upY.setTargetAtTime(up.y, t, tau);
      l.upZ.setTargetAtTime(up.z, t, tau);
    } else {
      // Older Firefox / Safari.
      l.setPosition(position.x, position.y, position.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  private applyEmitter(rec: EmitterRecord): void {
    rec.dirty = false;
    const { panner, position: p } = rec;
    if (panner.positionX) {
      const t = this.ctx.currentTime;
      panner.positionX.setTargetAtTime(p.x, t, SMOOTH / 3);
      panner.positionY.setTargetAtTime(p.y, t, SMOOTH / 3);
      panner.positionZ.setTargetAtTime(p.z, t, SMOOTH / 3);
    } else {
      panner.setPosition(p.x, p.y, p.z);
    }
  }

  /** On resume, apply the poses that changed while the context was not running. */
  private readonly onStateChange = (): void => {
    if (this.ctx.state !== 'running') return;
    if (this.listenerDirty) this.applyListener();
    for (const rec of this.emitters) if (rec.dirty) this.applyEmitter(rec);
  };

  /** A positioned source rendered with HRTF (direction is audible on headphones). */
  createEmitter(busName: BusName = 'sfx', position: Vec3 = { x: 0, y: 0, z: 0 }): Emitter {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 100;
    panner.rolloffFactor = 1;
    panner.connect(this.buses[busName]);
    // Initial placement takes effect immediately (a one-off, so nothing piles up while suspended).
    if (panner.positionX) {
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
    } else {
      panner.setPosition(position.x, position.y, position.z);
    }
    const rec: EmitterRecord = {
      panner,
      position: { x: position.x, y: position.y, z: position.z },
      dirty: false,
    };
    this.emitters.add(rec);
    return {
      input: panner,
      setPosition: (p: Vec3): void => {
        copy(rec.position, p);
        if (this.ctx.state === 'running') this.applyEmitter(rec);
        else rec.dirty = true;
      },
      dispose: () => {
        this.emitters.delete(rec);
        panner.disconnect();
      },
    };
  }

  /**
   * Reserve a voice that ends at `endTime` (context time). Returns false — and the caller should not
   * play — when the voice cap is reached, or when audio is not running and not about to resume
   * (before the first gesture, or while the browser has suspended / interrupted it): such sounds
   * would otherwise pile up and burst out all at once on resume. A sound triggered by the unlocking
   * gesture itself still plays, a few ms later.
   */
  beginVoice(endTime: number): boolean {
    const now = this.ctx.currentTime;
    this.voiceEnds = this.voiceEnds.filter((t) => t > now);
    const live = this.ctx.state === 'running' || (this.isUnlocked && this.resuming);
    if (!live || this.voiceEnds.length >= this.maxVoices) {
      this.voicesDropped++;
      return false;
    }
    this.voiceEnds.push(endTime);
    this.voicesStarted++;
    return true;
  }

  /** Scheduling time for a sound that should start "now" (a few ms ahead to avoid clipped attacks). */
  now(): number {
    return this.ctx.currentTime + 0.005;
  }

  snapshot(): AudioEngineSnapshot {
    const now = this.ctx.currentTime;
    const volumes = {} as Record<VolumeChannel, number>;
    for (const ch of VOLUME_CHANNELS) volumes[ch] = this.volumes[ch];
    return {
      state: this.ctx.state,
      unlocked: this.isUnlocked,
      sampleRate: this.ctx.sampleRate,
      room: this.reverb.room.id,
      volumes,
      voicesStarted: this.voicesStarted,
      voicesDropped: this.voicesDropped,
      activeVoices: this.voiceEnds.filter((t) => t > now).length,
    };
  }

  async dispose(): Promise<void> {
    this.unbindUnlockGestures();
    this.ctx.removeEventListener('statechange', this.onStateChange);
    this.emitters.clear();
    this.reverb.dispose();
    for (const s of this.sends) s.disconnect();
    for (const b of Object.values(this.buses)) b.disconnect();
    this.master.disconnect();
    this.limiter.disconnect();
    if (this.ctx.state !== 'closed') await this.ctx.close();
  }
}
