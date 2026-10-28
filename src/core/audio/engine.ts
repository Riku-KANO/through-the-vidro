/**
 * Audio foundation shared by both games (design doc: 技術設計 > ディレクトリ構成, core = 音の仕組み).
 *
 *  voices ─▶ [emitter: HRTF panner ▶ fade] ─▶ bus (music | sfx | ambience) ▶ duck ─┬─▶ master ▶ duck ─▶ limiter ─▶ out
 *                                                                                  └─▶ send ─▶ RoomReverb ─▶ master
 *  voices ─▶ extra bus (e.g. the UI's sounds) ─┬─▶ master
 *                                              └─▶ send ─▶ RoomReverb
 *
 * - A context the engine creates stays suspended until the first user gesture (browsers block sound
 *   before one; design doc: UI/UX設計 > 画面ごとの設計 > 読み込み). Later gestures resume it again if the
 *   browser suspended or interrupted it.
 * - Works on an OfflineAudioContext too (no unlock needed), so the whole mix can be rendered and measured.
 * - Four volumes: master / music / sfx / ambience (サウンドデザイン > 制作方法): the player's sliders.
 * - Ducks: turn-downs of a channel by an owner (a pause), on a stage of their own after the slider, so they never fight
 *   over the player's volume; several owners multiply (S-43).
 * - Extra buses beside the three, added at run time with a volume of their own (the UI's sounds: S-43).
 * - 3D sound with HRTF (サウンドデザイン > 環境音) and per-space reverb with synthesized IRs.
 * No game rules here: callers decide what plays where.
 */
import { CUT_TAU } from './glass';
import { BUSES, type BusName, VOLUME_CHANNELS, type VolumeChannel, volumeToGain } from './mix';
import { type RoomPreset, RoomReverb } from './reverb';
import { mayRequestResume, type ScheduledVoice, VoiceAllocator } from './voices';

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
  /** The acoustic space to start in (rooms are the game's data). */
  room: RoomPreset;
  /** Starting volume slider positions 0..1 (the game's defaults). Missing channels start at 1. */
  volumes?: Partial<Record<VolumeChannel, number>>;
  /** How much of each bus feeds the room reverb, 0..1. Missing buses send 1. */
  reverbSend?: Partial<Record<BusName, number>>;
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
  /** Peak level (used to pick the quietest voice to steal). */
  level: number;
  emitter?: Emitter;
  /** Bus for a non-positioned voice (default sfx). */
  bus?: BusName;
  /** An extra bus (addBus) for a non-positioned voice, instead of `bus`. Unknown names throw. */
  extraBus?: string;
}

/** An extra bus (addBus): its volume and its reverb send. */
export interface ExtraBusOptions {
  /** Slider position 0..1 (default 1). */
  volume?: number;
  /** How much feeds the room reverb, 0..1 (default 1). */
  reverbSend?: number;
}

interface ExtraBus {
  node: GainNode;
  send: GainNode;
  volume: number;
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

/** Mechanism constants (not sound tuning): smoothing, resume grace, fade lengths. */
const SMOOTH = 0.03;
const RESUME_GRACE = 0.25;
const EMITTER_FADE = 0.015;
/** Fade of the whole mix before the engine is torn down while playing (≈ -60 dB in 20 ms). */
const DISPOSE_TAU = CUT_TAU;
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
  private readonly volumes: Record<VolumeChannel, number> = { master: 1, music: 1, sfx: 1, ambience: 1 };
  /** Each channel's duck stage (after its slider), and the ducks on it by owner (slider positions; 1 = none). */
  private readonly duckNodes: Record<VolumeChannel, GainNode>;
  private readonly ducks: Record<VolumeChannel, Map<string, number>> = {
    master: new Map(),
    music: new Map(),
    sfx: new Map(),
    ambience: new Map(),
  };
  private readonly extraBuses = new Map<string, ExtraBus>();
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
  static async create(opts: AudioEngineOptions): Promise<AudioEngine> {
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
    for (const ch of VOLUME_CHANNELS) {
      const v = opts.volumes?.[ch];
      if (v !== undefined && Number.isFinite(v)) this.volumes[ch] = Math.min(1, Math.max(0, v));
    }
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
    const ducks = {} as Record<VolumeChannel, GainNode>;
    ducks.master = unityGain(ctx);
    this.master.connect(ducks.master).connect(this.limiter);
    this.reverb = new RoomReverb(ctx, opts.room);
    this.reverb.output.connect(this.master);
    const buses = {} as Record<BusName, GainNode>;
    for (const name of BUSES) {
      const bus = ctx.createGain();
      bus.gain.value = volumeToGain(this.volumes[name]);
      // the duck after the slider: what it turns down also feeds the reverb less (the whole bus is quieter)
      const duck = unityGain(ctx);
      bus.connect(duck).connect(this.master);
      const send = ctx.createGain();
      send.gain.value = Math.min(1, Math.max(0, opts.reverbSend?.[name] ?? 1));
      duck.connect(send).connect(this.reverb.input);
      this.sends.push(send);
      buses[name] = bus;
      ducks[name] = duck;
    }
    this.buses = buses;
    this.duckNodes = ducks;
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
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    const ask = mayRequestResume({
      realtime: this.realtime,
      state: this.ctx.state,
      activationActive: activation ? activation.isActive : null,
    });
    if (!ask) return Promise.resolve();
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

  /**
   * Turns a channel down for `owner` (a slider position 0..1 on a stage after the player's slider: 1 = not at all). The
   * player's volume is left as it is; ducks of different owners multiply. Used by the pause (S-42) through duckStage.
   */
  setDuck(owner: string, channel: VolumeChannel, value: number): void {
    const v = Number.isFinite(value) ? unit(value) : 1;
    const ducks = this.ducks[channel];
    if (v === 1) ducks.delete(owner);
    else ducks.set(owner, v);
    let gain = 1;
    for (const d of ducks.values()) gain *= volumeToGain(d);
    this.glide(this.duckNodes[channel].gain, gain);
  }

  getDuck(owner: string, channel: VolumeChannel): number {
    return this.ducks[channel].get(owner) ?? 1;
  }

  /** The channel as the mix plays it, as a slider position: the player's volume times every duck on it. */
  mixVolume(channel: VolumeChannel): number {
    let v = this.volumes[channel];
    for (const d of this.ducks[channel].values()) v *= d;
    return v;
  }

  /**
   * A bus beside music / sfx / ambience (the UI's sounds: S-43), into the master and the room's reverb, with a volume of
   * its own (setBusVolume). Asked again by name, the same bus (its options then are ignored). Voices go in with
   * `startVoice({ extraBus: name })`.
   */
  addBus(name: string, opts: ExtraBusOptions = {}): AudioNode {
    const had = this.extraBuses.get(name);
    if (had) return had.node;
    const volume = unit(opts.volume ?? 1);
    const node = this.ctx.createGain();
    node.gain.value = volumeToGain(volume);
    node.connect(this.master);
    const send = this.ctx.createGain();
    send.gain.value = unit(opts.reverbSend ?? 1);
    node.connect(send).connect(this.reverb.input);
    this.extraBuses.set(name, { node, send, volume });
    return node;
  }

  /** Slider position 0..1 of an extra bus (no-op for a name never added). */
  setBusVolume(name: string, value: number): void {
    const bus = this.extraBuses.get(name);
    if (!bus) return;
    bus.volume = Number.isFinite(value) ? unit(value) : 0;
    this.glide(bus.node.gain, volumeToGain(bus.volume));
  }

  /** Slider position of an extra bus; 0 for a name never added. */
  getBusVolume(name: string): number {
    return this.extraBuses.get(name)?.volume ?? 0;
  }

  /** Moves a gain: smoothly while playing, at once otherwise (offline before rendering, or suspended). */
  private glide(param: AudioParam, value: number): void {
    const t = this.ctx.currentTime;
    if (this.realtime && this.running) {
      param.setTargetAtTime(value, t, SMOOTH);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(value, t);
    }
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
    const emitter: Emitter = {
      input: panner,
      setPosition: (p: Vec3): void => {
        if (same(rec.position, p)) return;
        copy(rec.position, p);
        if (this.running || !this.realtime) this.applyEmitter(rec);
        else rec.dirty = true;
      },
      dispose: () => {
        if (!this.emitters.delete(rec)) return;
        // Its voices fade with the emitter; they must no longer count towards caps or be stolen.
        this.voices.releaseGroup(emitter);
        if (this.realtime && this.running) {
          fade.gain.setTargetAtTime(0, this.ctx.currentTime, EMITTER_FADE / 4);
          setTimeout(() => disconnectEmitter(rec), EMITTER_FADE * 2000);
        } else {
          disconnectEmitter(rec);
        }
      },
    };
    return emitter;
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
    // where it goes, first: an unknown extra bus throws before anything is stolen or counted
    const destination = spec.emitter?.input ?? this.destinationOf(spec);
    const when = this.now();
    // Fade stolen voices from the same instant the new one starts (a time the renderer has not reached).
    for (const victim of this.voices.makeRoom(now, group)) {
      victim.fadeOut(when);
      this.voicesStolen++;
    }
    const voice = schedule(this.ctx, destination, when);
    this.voices.add({ start: when, end: voice.end, level: spec.level, group, data: voice });
    this.voicesStarted++;
    return voice;
  }

  private destinationOf(spec: VoiceSpec): AudioNode {
    if (spec.extraBus === undefined) return this.buses[spec.bus ?? 'sfx'];
    const extra = this.extraBuses.get(spec.extraBus);
    if (!extra) throw new Error(`AudioEngine: no bus named ${spec.extraBus} (addBus first)`);
    return extra.node;
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

  /**
   * Glide the whole mix (dry and reverb) to silence from `at` — continuous, so no click.
   * Used before tearing down while playing; setVolume('master', …) brings it back.
   */
  fadeOutAll(at: number = this.now()): void {
    const g = this.master.gain;
    g.cancelScheduledValues(at);
    g.setTargetAtTime(0, at, DISPOSE_TAU);
  }

  /**
   * Fade out (~20 ms) if playing, then disconnect everything; close the context only if the engine
   * created it.
   */
  async dispose(): Promise<void> {
    if (this.realtime && this.running) {
      this.fadeOutAll();
      await new Promise((resolve) => setTimeout(resolve, (DISPOSE_TAU * 7 + 0.005) * 1000));
    }
    this.unbindUnlockGestures();
    this.ctx.removeEventListener('statechange', this.onStateChange);
    for (const rec of this.emitters) disconnectEmitter(rec);
    this.emitters.clear();
    this.reverb.dispose();
    for (const s of this.sends) s.disconnect();
    for (const b of Object.values(this.buses)) b.disconnect();
    for (const d of Object.values(this.duckNodes)) d.disconnect();
    for (const x of this.extraBuses.values()) {
      x.node.disconnect();
      x.send.disconnect();
    }
    this.extraBuses.clear();
    this.master.disconnect();
    this.limiter.disconnect();
    if (this.ownsContext && this.ctx.state !== 'closed') await (this.ctx as AudioContext).close();
  }
}

/** A gain node at 1 (set, not assumed: a stand-in context may start its params elsewhere). */
function unityGain(ctx: BaseAudioContext): GainNode {
  const g = ctx.createGain();
  g.gain.value = 1;
  return g;
}

function unit(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * A duck stage of `owner` in the shape of the four volumes (getVolume / setVolume), for a mix written against the player's
 * volumes: the pause's (src/audio/pause.ts PauseMix, S-42) turns the game down here instead of moving the player's sliders,
 * so a slider moved by the settings meanwhile is not overwritten when the pause gives the volume back (S-43).
 */
export function duckStage(
  engine: Pick<AudioEngine, 'getDuck' | 'setDuck'>,
  owner: string,
): Pick<AudioEngine, 'getVolume' | 'setVolume'> {
  return {
    getVolume: (channel) => engine.getDuck(owner, channel),
    setVolume: (channel, value) => engine.setDuck(owner, channel, value),
  };
}

function disconnectEmitter(rec: EmitterRecord): void {
  rec.panner.disconnect();
  rec.fade.disconnect();
}
