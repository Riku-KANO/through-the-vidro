/**
 * Audio foundation shared by both games (design doc: 技術設計 > ディレクトリ構成, core = 音の仕組み).
 *
 *  voices ─▶ [emitter: HRTF panner ▶ fade] ─▶ bus (music | sfx | ambience) ─┬─▶ master ─▶ limiter ─▶ out
 *                                                                           └─▶ send ─▶ RoomReverb ─▶ master
 *
 * - A context the engine creates stays suspended until the first user gesture (browsers block sound
 *   before one; design doc: UI/UX設計 > 画面ごとの設計 > 読み込み). Later gestures resume it again if the
 *   browser suspended or interrupted it.
 * - Works on an OfflineAudioContext too (no unlock needed), so the whole mix can be rendered and measured.
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
import { type ScheduledVoice, VoiceAllocator } from './voices';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A positioned sound source. Connect voices to `input`. */
export interface Emitter {
  readonly input: AudioNode;
  setPosition(p: Vec3): void;
  /** Fades out (~15 ms) and disconnects, so a ringing tail does not click. */
  dispose(): void;
}

export interface AudioEngineOptions {
  room?: RoomPreset;
  /** Concurrent voice cap; at the cap the quietest voice is stolen. Default 48. */
  maxVoices?: number;
  /** Concurrent voices per emitter. Default 8. */
  maxVoicesPerEmitter?: number;
  latencyHint?: AudioContextLatencyCategory;
  /**
   * Use an existing context (shared with other code, or an OfflineAudioContext for rendering).
   * The engine then never suspends or closes it.
   */
  context?: BaseAudioContext;
}

export interface AudioEngineSnapshot {
  state: string;
  realtime: boolean;
  unlocked: boolean;
  sampleRate: number;
  room: string;
  volumes: Record<VolumeChannel, number>;
  voicesStarted: number;
  voicesDropped: number;
  voicesStolen: number;
  activeVoices: number;
}

/** What the engine needs to know about a voice before scheduling it. */
export interface VoiceSpec {
  /** Seconds until it is silent on its own. */
  duration: number;
  /** Peak level (used to pick the quietest voice to steal). */
  level: number;
  emitter?: Emitter;
  /** Bus for a non-positioned voice (default sfx). */
  bus?: BusName;
}

interface EmitterRecord {
  panner: PannerNode;
  fade: GainNode;
  position: Vec3;
  /** Moved while the context was not running; apply on resume. */
  dirty: boolean;
}

function copy(to: Vec3, from: Vec3): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

function same(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function wallSeconds(): number {
  return performance.now() / 1000;
}

/**
 * Technical defaults (not from the design doc; see process/slices/S-09.md).
 * Reverb send per bus, smoothing time, resume grace, voice caps.
 */
const REVERB_SEND: Record<BusName, number> = { music: 0.5, sfx: 1, ambience: 1 };
const SMOOTH = 0.03;
const RESUME_GRACE = 0.25;
const EMITTER_FADE = 0.015;
/** Activation-triggering events (pointerup / click cover browsers that only grant activation on release). */
const GESTURES = ['pointerdown', 'pointerup', 'click', 'keydown', 'touchend'] as const;

export class AudioEngine {
  readonly ctx: BaseAudioContext;
  readonly reverb: RoomReverb;
  /** False for an OfflineAudioContext. */
  readonly realtime: boolean;
  private readonly ownsContext: boolean;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly buses: Record<BusName, GainNode>;
  private readonly sends: GainNode[] = [];
  private readonly volumes: Record<VolumeChannel, number> = { ...DEFAULT_VOLUMES };
  private readonly voices: VoiceAllocator<ScheduledVoice>;
  private readonly emitters = new Set<EmitterRecord>();
  private readonly listenerPose = {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };
  private listenerDirty = false;
  private listenerSet = false;
  private gestureTarget: EventTarget | null = null;
  private isUnlocked = false;
  private resumeRequestedAt: number | null = null;
  private voicesStarted = 0;
  private voicesDropped = 0;
  private voicesStolen = 0;

  /**
   * Create the engine. A context it creates itself is suspended until unlock() runs inside a user
   * gesture; a context passed in is used as is.
   */
  static async create(opts: AudioEngineOptions = {}): Promise<AudioEngine> {
    if (opts.context) return new AudioEngine(opts.context, false, opts);
    const ctx = new AudioContext({ latencyHint: opts.latencyHint ?? 'interactive' });
    // Some browsers (or autoplay settings) start the context running. Start silent everywhere so the
    // first gesture is always the moment sound begins.
    if (ctx.state === 'running') await ctx.suspend();
    return new AudioEngine(ctx, true, opts);
  }

  private constructor(ctx: BaseAudioContext, owns: boolean, opts: AudioEngineOptions) {
    this.ctx = ctx;
    this.ownsContext = owns;
    this.realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    this.voices = new VoiceAllocator({
      maxVoices: opts.maxVoices ?? 48,
      maxPerGroup: opts.maxVoicesPerEmitter ?? 8,
      resumeGrace: RESUME_GRACE,
    });
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

  private get running(): boolean {
    return this.ctx.state === 'running';
  }

  /**
   * Start (or restart) audio. Call it from inside a user gesture handler. Never rejects.
   * Without user activation Chrome keeps resume() pending forever, so it is not even attempted then;
   * and sounds are only accepted for a short grace period while a resume is in flight.
   */
  unlock(): Promise<void> {
    if (!this.realtime || this.ctx.state === 'closed' || this.running) return Promise.resolve();
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    if (activation && !activation.isActive) return Promise.resolve();
    this.isUnlocked = true;
    this.resumeRequestedAt = wallSeconds();
    return (this.ctx as AudioContext).resume().catch(() => undefined);
  }

  private readonly onGesture = (): void => {
    if (!this.running) void this.unlock();
  };

  /** Unlock on the first pointer / key / touch on `target`, and resume after any later interruption. */
  bindUnlockGestures(target: EventTarget = window): void {
    this.unbindUnlockGestures();
    if (!this.realtime) return;
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
    const param = (channel === 'master' ? this.master : this.buses[channel]).gain;
    const t = this.ctx.currentTime;
    if (this.realtime && this.running) {
      param.setTargetAtTime(volumeToGain(v), t, SMOOTH);
    } else {
      // Not playing (or offline before rendering): take effect at once, no ramp.
      param.cancelScheduledValues(t);
      param.setValueAtTime(volumeToGain(v), t);
    }
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
   * Safe to call every frame: unchanged poses return early and nothing is allocated. While the
   * context is not running, time stands still and automation would pile up, so the latest pose
   * waits for resume.
   */
  setListener(position: Vec3, forward: Vec3, up: Vec3): void {
    const pose = this.listenerPose;
    if (this.listenerSet && same(pose.position, position) && same(pose.forward, forward) && same(pose.up, up))
      return;
    this.listenerSet = true;
    copy(pose.position, position);
    copy(pose.forward, forward);
    copy(pose.up, up);
    if (this.running || !this.realtime) this.applyListener();
    else this.listenerDirty = true;
  }

  /** Move a param: glide while playing, jump otherwise (offline renders start exactly in place). */
  private moveTo(param: AudioParam, value: number): void {
    const t = this.ctx.currentTime;
    if (this.running) param.setTargetAtTime(value, t, SMOOTH / 3);
    else param.setValueAtTime(value, t);
  }

  private applyListener(): void {
    this.listenerDirty = false;
    const { position, forward, up } = this.listenerPose;
    const l = this.ctx.listener;
    if (l.positionX) {
      this.moveTo(l.positionX, position.x);
      this.moveTo(l.positionY, position.y);
      this.moveTo(l.positionZ, position.z);
      this.moveTo(l.forwardX, forward.x);
      this.moveTo(l.forwardY, forward.y);
      this.moveTo(l.forwardZ, forward.z);
      this.moveTo(l.upX, up.x);
      this.moveTo(l.upY, up.y);
      this.moveTo(l.upZ, up.z);
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
      this.moveTo(panner.positionX, p.x);
      this.moveTo(panner.positionY, p.y);
      this.moveTo(panner.positionZ, p.z);
    } else {
      panner.setPosition(p.x, p.y, p.z);
    }
  }

  /** On resume, apply the poses that changed while the context was not running. */
  private readonly onStateChange = (): void => {
    if (!this.running) return;
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
    const fade = this.ctx.createGain();
    panner.connect(fade).connect(this.buses[busName]);
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
      fade,
      position: { x: position.x, y: position.y, z: position.z },
      dirty: false,
    };
    this.emitters.add(rec);
    return {
      input: panner,
      setPosition: (p: Vec3): void => {
        if (same(rec.position, p)) return;
        copy(rec.position, p);
        if (this.running || !this.realtime) this.applyEmitter(rec);
        else rec.dirty = true;
      },
      dispose: () => {
        if (!this.emitters.delete(rec)) return;
        if (this.realtime && this.running) {
          fade.gain.setTargetAtTime(0, this.ctx.currentTime, EMITTER_FADE / 4);
          setTimeout(() => disconnectEmitter(rec), EMITTER_FADE * 2000);
        } else {
          disconnectEmitter(rec);
        }
      },
    };
  }

  /**
   * Start a voice now. `schedule` builds it into `destination` at `when`. Returns null when audio is
   * not running and not about to (before the first gesture, while suspended / interrupted, or a
   * resume that did not complete within the grace period): such sounds would otherwise pile up and
   * burst out together on resume. At the voice cap the quietest voice is faded out to make room.
   */
  startVoice(
    spec: VoiceSpec,
    schedule: (ctx: BaseAudioContext, destination: AudioNode, when: number) => ScheduledVoice,
  ): ScheduledVoice | null {
    const gate = {
      realtime: this.realtime,
      running: this.running,
      resumeRequestedAt: this.resumeRequestedAt,
      wallNow: wallSeconds(),
    };
    if (this.ctx.state === 'closed' || !this.voices.accepts(gate)) {
      this.voicesDropped++;
      return null;
    }
    const now = this.ctx.currentTime;
    const group = spec.emitter ?? null;
    for (const victim of this.voices.makeRoom(now, group)) {
      victim.fadeOut(now);
      this.voicesStolen++;
    }
    const when = this.now();
    const destination = spec.emitter?.input ?? this.buses[spec.bus ?? 'sfx'];
    const voice = schedule(this.ctx, destination, when);
    this.voices.add({ start: when, end: voice.end, level: spec.level, group, data: voice });
    this.voicesStarted++;
    return voice;
  }

  /** Scheduling time for a sound that should start "now" (a few ms ahead to avoid clipped attacks). */
  now(): number {
    return this.ctx.currentTime + 0.005;
  }

  snapshot(): AudioEngineSnapshot {
    const volumes = {} as Record<VolumeChannel, number>;
    for (const ch of VOLUME_CHANNELS) volumes[ch] = this.volumes[ch];
    return {
      state: this.ctx.state,
      realtime: this.realtime,
      unlocked: this.isUnlocked,
      sampleRate: this.ctx.sampleRate,
      room: this.reverb.room.id,
      volumes,
      voicesStarted: this.voicesStarted,
      voicesDropped: this.voicesDropped,
      voicesStolen: this.voicesStolen,
      activeVoices: this.voices.active(this.ctx.currentTime),
    };
  }

  /** Disconnect everything; close the context only if the engine created it. */
  async dispose(): Promise<void> {
    this.unbindUnlockGestures();
    this.ctx.removeEventListener('statechange', this.onStateChange);
    for (const rec of this.emitters) disconnectEmitter(rec);
    this.emitters.clear();
    this.reverb.dispose();
    for (const s of this.sends) s.disconnect();
    for (const b of Object.values(this.buses)) b.disconnect();
    this.master.disconnect();
    this.limiter.disconnect();
    if (this.ownsContext && this.ctx.state !== 'closed') await (this.ctx as AudioContext).close();
  }
}

function disconnectEmitter(rec: EmitterRecord): void {
  rec.panner.disconnect();
  rec.fade.disconnect();
}
