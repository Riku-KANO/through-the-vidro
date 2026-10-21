import * as THREE from 'three/webgpu';
import { createVidroEngine } from '../../audio/engine';
import { strikeGlass } from '../../audio/glass-tuning';
import { type PopenKind, playPopen } from '../../audio/popen';
import { VIDRO_ROOMS } from '../../audio/rooms';
import type { AudioEngine, Emitter } from '../../core/audio/engine';
import type { GlassStrength } from '../../core/audio/glass';
import type { Vec3 } from '../../layers/footing';
import { HAND_ORB_RADIUS, handOrbCenter } from '../orb/hand-pose';
import { type EventBus, eventName, type PrologueEvent } from './events';
import { BENCH_ORB, DROP, PEDESTAL_ORB } from './layout';
import type { RoomProbe } from './room';

/**
 * 序章の音 (S-16): the prologue room's events (room.events, S-06) answered with S-09's sounds.
 *  - サウンドデザイン > ガラスの音: the hand orb's 「ぽぺん」 sounds on 覗く・置く・拾う; アセットリスト > 音: ビードロの
 *    音 4 = 覗く・置く・拾う・震える (the tremble is the refusal of コアメカニクス > 基本の動作). The light drop is glass:
 *    touched (触れる), then ringing the vidro as it flies into it.
 *  - サウンドデザイン > 環境音: in 3D with HRTF, in the workshop's short reverb (src/audio/rooms.ts).
 *  - UI/UX設計 > 画面ごとの設計 (読み込み): no sound before the first gesture. The AudioContext is only made inside
 *    that gesture (so the browser never warns about autoplay); events before it are refused, never queued.
 *  - One AudioContext per page (S-18): through the home, the loading screen's 「はじめる」 starts the engine and the
 *    room plays through it (`shared`), so the UI and the room follow the same four volumes. Alone (direct mode), the
 *    room makes its own on the first gesture.
 * cueFor / sourcePoint / answer are pure; createPrologueSound wires them to the AudioEngine.
 */

/** Where a cue sounds from: the hand, the vidro where it stands (hand, bench or pedestal), the light drop. */
export type CueSource = 'hand' | 'orb' | 'drop';

export type SoundCue =
  | { kind: 'popen'; popen: PopenKind; source: CueSource }
  | { kind: 'glass'; strength: GlassStrength; size: number; source: CueSource };

/**
 * Sizes for the glass pitch rule (src/audio/tuning.ts, 大きい物ほど低く). The vidro is the hand orb's diameter
 * (15 cm, D5). 仮 (to be confirmed by ear, S-16 判断待ち3): the light drop rings as a 0.14 m glass, a step above the
 * vidro (E5). It is a tuning value, not the drawn drop's size (room-art.ts: about 0.11 m wide and 0.24 m tall; by
 * the longest dimension it would ring F#4, below the vidro).
 */
export const VIDRO_SIZE = HAND_ORB_RADIUS * 2;
export const DROP_SIZE = 0.14;

/**
 * The sound of each event, or null for none.
 * peekEnd is silent: the design gives the vidro four sounds (覗く・置く・拾う・震える) and none for lowering it
 * (判断待ち in process/slices/S-16.md).
 * The held vidro's po-pens come from the hand; a refusal from the vidro trembling where it stands (on the pedestal:
 * the hand is empty then); the drop's touch from the drop, its arrival from the vidro it flies into.
 */
export function cueFor(event: PrologueEvent): SoundCue | null {
  switch (event.type) {
    case 'peekStart':
      return { kind: 'popen', popen: 'peek', source: 'hand' };
    case 'peekEnd':
      return null;
    case 'place':
      return { kind: 'popen', popen: 'place', source: 'hand' };
    case 'pickup':
      return { kind: 'popen', popen: 'pickup', source: 'hand' };
    case 'shake':
      return { kind: 'popen', popen: 'tremble', source: 'orb' };
    case 'dropTouched':
      return { kind: 'glass', strength: 'touch', size: DROP_SIZE, source: 'drop' };
    case 'dropTaken':
      return { kind: 'glass', strength: 'tap', size: VIDRO_SIZE, source: 'orb' };
  }
}

/** 'popen:<kind>' or 'glass:<strength>' (the probe's log). */
export function cueName(cue: SoundCue): string {
  return cue.kind === 'popen' ? `popen:${cue.popen}` : `glass:${cue.strength}`;
}

/** The world point a cue sounds from. `hand` is the hand orb's world position. */
export function sourcePoint(source: CueSource, orb: 'bench' | 'hand' | 'pedestal', hand: Vec3): Vec3 {
  if (source === 'drop') return DROP;
  if (source === 'orb' && orb === 'pedestal') return PEDESTAL_ORB;
  if (source === 'orb' && orb === 'bench') return BENCH_ORB;
  return hand;
}

export interface PlayedCue {
  event: string;
  cue: string;
  source: CueSource;
  /** Metres from the listener when it started. */
  distance: number;
}

export interface RefusedCue {
  event: string;
  cue: string;
}

/** Plays a cue now. Null when the audio refused it (not started yet): it is then dropped, not kept for later. */
export interface CuePlayer {
  play(cue: SoundCue): { distance: number } | null;
}

/** What sounded and what was refused, newest last; bounded, with running counts. */
export class CueLog {
  readonly played: PlayedCue[] = [];
  readonly refused: RefusedCue[] = [];
  playedCount = 0;
  refusedCount = 0;

  constructor(readonly limit = 64) {}

  notePlayed(p: PlayedCue): void {
    this.played.push(p);
    if (this.played.length > this.limit) this.played.shift();
    this.playedCount++;
  }

  noteRefused(r: RefusedCue): void {
    this.refused.push(r);
    if (this.refused.length > this.limit) this.refused.shift();
    this.refusedCount++;
  }
}

/** Answers one event: its cue is played once now, or logged as refused. Nothing is retried later. */
export function answer(event: PrologueEvent, player: CuePlayer, log: CueLog): void {
  const cue = cueFor(event);
  if (!cue) return;
  const played = player.play(cue);
  const entry = { event: eventName(event), cue: cueName(cue) };
  if (played) log.notePlayed({ ...entry, source: cue.source, distance: played.distance });
  else log.noteRefused(entry);
}

/** What the sound needs from the room (PrologueRoom satisfies it). */
export interface SoundRoom {
  readonly events: EventBus<PrologueEvent>;
  /** The game camera: the listener, and the frame the hand orb is held in. */
  readonly camera: THREE.Object3D;
  readonly probe: Pick<RoomProbe, 'orb' | 'peekAmount' | 'handPresence' | 'time'>;
}

/** window.__vidro.sceneProbe.sound (tests/e2e/S-16-*.spec.ts). Getters read the live state. */
export interface SoundProbe {
  /**
   * 'locked' before the audio starts, then the AudioContext's state. Its own context is closed when this sound is
   * disposed ('closed'); a shared one when its owner is (S-18), and 'locked' stays while the owner has none
   * (not pressed yet, the autoplay script, or no Web Audio: the owner's probe tells which).
   */
  readonly state: string;
  /** The audio has started: the first gesture made its own engine, or the shared one was handed over. */
  readonly unlocked: boolean;
  /** Playing on an engine someone else owns (the home's, S-18), not its own. */
  readonly shared: boolean;
  /** The reverb's room. */
  readonly room: string;
  /** Panning model of each live emitter. */
  readonly panning: string[];
  /**
   * Voices the engine started / refused: on its own engine, all of them (only this sound plays there); on a shared
   * one, those started while answering this sound's cues (the engine also counts the UI's).
   */
  readonly voicesStarted: number;
  readonly voicesDropped: number;
  readonly played: readonly PlayedCue[];
  readonly refused: readonly RefusedCue[];
  readonly playedCount: number;
  readonly refusedCount: number;
  readonly emitters: number;
  /** Still listening to room.events. */
  readonly subscribed: boolean;
  readonly disposed: boolean;
}

export interface PrologueSound {
  readonly probe: SoundProbe;
  /** Every frame, after the camera moved: the listener and the hand follow. */
  update(): void;
  /**
   * Stops listening and lets go of its emitters. Its own engine fades out and its AudioContext is closed; a shared
   * engine is left to its owner.
   */
  dispose(): void;
}

/**
 * An engine started and owned elsewhere: the loading screen's 「はじめる」 (src/ui/audio-gate.ts AudioGate, S-18).
 * Its owner starts it inside the press, resumes it after interruptions and closes it.
 */
export interface SharedEngine {
  /** Hands the engine to `ready` once it has started (at once if it has). Returns a function that stops waiting. */
  whenReady(ready: (engine: AudioEngine) => void): () => void;
}

/** Activation-triggering input (as in src/core/audio/engine.ts). */
const GESTURES = ['pointerdown', 'pointerup', 'click', 'keydown', 'touchend'] as const;

export interface SoundOptions {
  /** Play on this engine instead of making one: no AudioContext of its own, no gesture listening (S-18). */
  shared?: SharedEngine;
  /** Where the first gesture is listened for (own engine only). Default: window. */
  target?: EventTarget;
  /** Makes the AudioContext inside the first gesture. Default: `new AudioContext()` (unit tests pass a stand-in). */
  makeContext?: () => AudioContext;
  /** Builds the engine on that context. Default: the game's engine (src/audio/engine.ts) in the workshop. */
  makeEngine?: (context: AudioContext) => Promise<AudioEngine>;
}

const vidroEngine = (context: AudioContext): Promise<AudioEngine> =>
  createVidroEngine(context, VIDRO_ROOMS.workshop);

/**
 * The prologue's sound. Nothing sounds until the audio has started: on its own engine, made inside the first gesture
 * on `target`; on a `shared` one, once its owner has started it. From then on the room's events play through the
 * engine in the workshop's reverb, each from its place in the room (HRTF), the camera listening.
 */
export function createPrologueSound(room: SoundRoom, opts: SoundOptions = {}): PrologueSound {
  const shared = opts.shared ?? null;
  const target = opts.target ?? window;
  const makeContext = opts.makeContext ?? (() => new AudioContext({ latencyHint: 'interactive' }));
  const makeEngine = opts.makeEngine ?? vidroEngine;
  const log = new CueLog();
  const { camera, probe: roomProbe } = room;
  const roomId = VIDRO_ROOMS.workshop.id;
  /** The engine's context: its own (made in the gesture), or the shared engine's. */
  let context: BaseAudioContext | null = null;
  let engine: AudioEngine | null = null;
  let emitters: { hand: Emitter; orb: Emitter; drop: Emitter } | null = null;
  const live: Emitter[] = [];
  let failed = false;
  let subscribed = true;
  let disposed = false;
  let voicesStarted = 0;
  let voicesDropped = 0;

  const ear = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const handView: [number, number, number] = [0, 0, 0];
  const handWorld = new THREE.Vector3();
  const at = { x: 0, y: 0, z: 0 };

  /** The listener is the camera; the hand orb is held in its frame (orb/hand-pose.ts). */
  const follow = (): void => {
    const m = camera.matrixWorld;
    ear.setFromMatrixPosition(m);
    forward.set(0, 0, -1).transformDirection(m);
    up.set(0, 1, 0).transformDirection(m);
    handOrbCenter(roomProbe.peekAmount, roomProbe.handPresence, roomProbe.time, handView);
    handWorld.set(handView[0], handView[1], handView[2]).applyMatrix4(m);
    if (!engine || !emitters) return;
    engine.setListener(ear, forward, up);
    emitters.hand.setPosition(handWorld);
  };

  const player: CuePlayer = {
    play(cue) {
      if (disposed || !engine || !emitters) return null;
      follow();
      const point = sourcePoint(cue.source, roomProbe.orb, [handWorld.x, handWorld.y, handWorld.z]);
      const emitter =
        cue.source === 'drop'
          ? emitters.drop
          : cue.source === 'orb' && roomProbe.orb !== 'hand'
            ? emitters.orb
            : emitters.hand;
      if (emitter !== emitters.hand) {
        at.x = point[0];
        at.y = point[1];
        at.z = point[2];
        emitter.setPosition(at);
      }
      // what the engine itself started / refused for this cue (a shared engine also counts the UI's voices)
      const before = engine.snapshot();
      const started =
        cue.kind === 'popen'
          ? playPopen(engine, cue.popen, { emitter }) !== null
          : strikeGlass(engine, cue.size, cue.strength, { emitter }) !== null;
      const after = engine.snapshot();
      voicesStarted += after.voicesStarted - before.voicesStarted;
      voicesDropped += after.voicesDropped - before.voicesDropped;
      if (!started) return null;
      return { distance: Math.hypot(point[0] - ear.x, point[1] - ear.y, point[2] - ear.z) };
    },
  };

  const off = room.events.on((e) => answer(e, player, log));

  /** The engine is there (its own, or handed over): place the emitters in the room. */
  const attach = (e: AudioEngine): void => {
    engine = e;
    context ??= e.ctx;
    // the room's space is the game's to decide (S-16: the workshop), also on an engine started elsewhere
    if (e.room.id !== roomId) e.setRoom(VIDRO_ROOMS.workshop);
    emitters = {
      hand: e.createEmitter('sfx'),
      orb: e.createEmitter('sfx', { x: PEDESTAL_ORB[0], y: PEDESTAL_ORB[1], z: PEDESTAL_ORB[2] }),
      drop: e.createEmitter('sfx', { x: DROP[0], y: DROP[1], z: DROP[2] }),
    };
    live.push(emitters.hand, emitters.orb, emitters.drop);
    follow();
  };

  const stopListening = (): void => {
    for (const type of GESTURES) target.removeEventListener(type, onGesture, { capture: true });
  };

  /** Own engine: the first gesture makes the AudioContext inside it (it starts at once), then the engine. */
  function onGesture(): void {
    if (context || failed || disposed) return;
    // Esc and the like do not count as activation: making the context then would leave it suspended
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    stopListening();
    let ctx: AudioContext;
    try {
      ctx = makeContext();
    } catch {
      failed = true;
      return;
    }
    context = ctx;
    void makeEngine(ctx).then(
      (e) => {
        // left before the engine was ready: dispose() has already closed the context
        if (disposed) {
          void e.dispose();
          return;
        }
        attach(e);
        // later interruptions (a backgrounded tab, a device change) resume on the next gesture
        e.bindUnlockGestures(target);
        // still inside the gesture's activation: start it if the browser made it suspended
        void e.unlock();
      },
      () => {
        // no audio here: the room plays on, silent
        failed = true;
        void ctx.close().catch(() => undefined);
      },
    );
  }

  // a shared engine is started (and resumed, and closed) by its owner; otherwise wait for the first gesture
  const stopWaiting = shared
    ? shared.whenReady((e) => {
        if (!disposed && !engine) attach(e);
      })
    : null;
  if (!shared) for (const type of GESTURES) target.addEventListener(type, onGesture, { capture: true });

  const probe: SoundProbe = {
    get state() {
      if (failed) return 'unavailable';
      if (context) return context.state;
      return disposed ? 'closed' : 'locked';
    },
    get unlocked() {
      return context !== null;
    },
    get shared() {
      return shared !== null;
    },
    get room() {
      return engine?.snapshot().room ?? roomId;
    },
    get panning() {
      return live.map((e) => (e.input as PannerNode).panningModel);
    },
    // its own engine: everything the engine did (nothing else plays on it); shared: what it did for this sound
    get voicesStarted() {
      return shared ? voicesStarted : (engine?.snapshot().voicesStarted ?? 0);
    },
    get voicesDropped() {
      return shared ? voicesDropped : (engine?.snapshot().voicesDropped ?? 0);
    },
    get played() {
      return log.played;
    },
    get refused() {
      return log.refused;
    },
    get playedCount() {
      return log.playedCount;
    },
    get refusedCount() {
      return log.refusedCount;
    },
    get emitters() {
      return live.length;
    },
    get subscribed() {
      return subscribed;
    },
    get disposed() {
      return disposed;
    },
  };

  return {
    probe,
    update: follow,
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      subscribed = false;
      stopListening();
      stopWaiting?.();
      for (const e of live) e.dispose();
      live.length = 0;
      // a shared engine and its context are its owner's to fade out and close
      if (shared) return;
      const e = engine;
      const ctx = context as AudioContext | null;
      if (!ctx) return;
      const close = (): Promise<void> => ctx.close().catch(() => undefined);
      // the engine fades the mix out (~20 ms) and disconnects; the context is ours to close
      if (e) void e.dispose().then(close, close);
      else void close();
    },
  };
}
