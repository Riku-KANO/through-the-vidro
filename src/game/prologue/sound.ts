import * as THREE from 'three/webgpu';
import {
  type AmbienceBanks,
  type AmbienceHit,
  type AmbienceKind,
  type AmbienceOptions,
  AmbiencePlayer,
  type AmbienceSourceState,
  CHIME_SOURCES,
  DROP_SOURCES,
  loadAmbienceBanks,
  WIND_LOOP_SECONDS,
  WIND_SOURCE,
} from '../../audio/ambience';
import { createVidroEngine } from '../../audio/engine';
import {
  type FloorMaterial,
  FOOTSTEP_SOURCES,
  FOOTSTEP_TUNING,
  type FootstepBanks,
  Footsteps,
  loadFootstepBanks,
  nextVariant,
} from '../../audio/footsteps';
import { strikeGlass } from '../../audio/glass-tuning';
import { VIDRO_VOLUMES } from '../../audio/levels';
import { type PopenKind, playPopen } from '../../audio/popen';
import { VIDRO_ROOMS } from '../../audio/rooms';
import { loadBank, scheduleBuffer, startLoop } from '../../core/audio/bank';
import type { AudioEngine, Emitter } from '../../core/audio/engine';
import type { GlassStrength } from '../../core/audio/glass';
import { renderOffline } from '../../core/audio/offline';
import { mulberry32, type Rng } from '../../core/audio/rng';
import type { Vec3 } from '../../layers/footing';
import { HAND_ORB_RADIUS, handOrbCenter } from '../orb/hand-pose';
import { EYE_HEIGHT, WALK_SPEED } from '../player/constants';
import { type EventBus, eventName, type PrologueEvent } from './events';
import {
  BENCH_ORB,
  DROP,
  EDGE_Z,
  FAR,
  FURNACE,
  floorAt,
  GATE,
  LAMPS,
  lookDirection,
  PEDESTAL_ORB,
  SPAWNS,
  WORKSHOP_FLOOR_RADIUS,
  WORKSHOP_TOP,
} from './layout';
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
 *  - S-22: footsteps — one per footfall of the body (game/player footfallsBy), from the feet, for the floor under them
 *    (layout.ts floorAt); and the workshop's ambience — wind at the dome's gaps, chimes far off beyond the gate, drops
 *    in a few places (PROLOGUE_AMBIENCE), on the ambience bus, fading in once the room is played (not on the home
 *    screen before the dive). Both are synthesized sounds behind the bank port (src/core/audio/bank.ts), loaded once
 *    the engine is there.
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
  readonly probe: Pick<
    RoomProbe,
    'orb' | 'peekAmount' | 'handPresence' | 'time' | 'playing' | 'position' | 'speed' | 'footfalls'
  >;
}

/* ---------- S-22: where the workshop's ambience is placed ---------- */

/** One ambient sound in the room: what, where, and (wind) where in its loop it starts, (drops) on which notes. */
export interface AmbientSpot {
  readonly id: string;
  readonly kind: AmbienceKind;
  readonly position: Vec3;
  readonly offset?: number;
  /** Indices into DROP_NOTES (src/audio/ambience.ts). */
  readonly notes?: readonly number[];
}

const [, LAMP] = LAMPS;

/**
 * 工房に立体的に置く (仮, to be confirmed by ear):
 *  - the wind through the glass gaps: the skylight at the top of the dome and the door, and outside, rising from the
 *    valley through the broken glass at the edge of the way (S-06: 割れた破片), so the way and the far shore are not
 *    left without air. Each starts at another point of the loop, so no two gaps breathe in step.
 *  - 遠くの風鈴: hung in the town beyond the closed gate, so they are far away from the workshop (about 26 m) and come
 *    closer along the way — the sound of somewhere lived in, ahead (物語と世界: まだそこで暮らしている気配)
 *  - drops: condensation off the skylight's rim onto the glass floor, the quench bucket by the furnace (deeper), and
 *    the milky globe of a lamp onto the stone of the way (higher)
 * None of these is drawn (sounds of what is around, not things to find); the floors they fall on are.
 */
export const PROLOGUE_AMBIENCE: readonly AmbientSpot[] = [
  { id: 'wind:skylight', kind: 'wind', position: [0, WORKSHOP_TOP - 0.15, 0], offset: 0 },
  {
    id: 'wind:door',
    kind: 'wind',
    position: [0, 1.9, -WORKSHOP_FLOOR_RADIUS],
    offset: WIND_LOOP_SECONDS / 2,
  },
  {
    id: 'wind:edge',
    kind: 'wind',
    position: [0, -0.6, (EDGE_Z + FAR.maxZ) / 2],
    offset: WIND_LOOP_SECONDS / 4,
  },
  { id: 'chimes:town', kind: 'chimes', position: [1.6, 3.2, GATE.z - 6.4] },
  { id: 'drops:skylight', kind: 'drops', position: [0.55, 0.02, 0.55], notes: [3, 4, 5] },
  {
    id: 'drops:bucket',
    kind: 'drops',
    position: [FURNACE.center[0] - 1.0, 0.45, FURNACE.center[2] + 0.9],
    notes: [0, 1, 2, 3],
  },
  {
    id: 'drops:lamp',
    kind: 'drops',
    position: [(LAMP?.x ?? -1.12) + 0.17, 0.02, LAMP?.z ?? -9.4],
    notes: [4, 5, 6, 7],
  },
];

/** Emitters for PROLOGUE_AMBIENCE on the ambience bus, and the player that plays into them (live and offline alike). */
function placeAmbience(
  engine: AudioEngine,
  banks: AmbienceBanks,
  rng?: Rng,
  opts?: AmbienceOptions,
): { player: AmbiencePlayer; emitters: Emitter[] } {
  const emitters = PROLOGUE_AMBIENCE.map((s) =>
    engine.createEmitter('ambience', { x: s.position[0], y: s.position[1], z: s.position[2] }),
  );
  const places = PROLOGUE_AMBIENCE.map((s, i) => ({
    id: s.id,
    kind: s.kind,
    input: (emitters[i] as Emitter).input,
    offset: s.offset,
    notes: s.notes,
  }));
  return { player: new AmbiencePlayer(engine.ctx, banks, places, rng, opts), emitters };
}

/** Everything the room's footsteps and ambience play from (S-22). */
export interface SoundBanks {
  footsteps: FootstepBanks;
  ambience: AmbienceBanks;
}

export async function loadSoundBanks(ctx: BaseAudioContext, signal?: AbortSignal): Promise<SoundBanks> {
  return { footsteps: await loadFootstepBanks(ctx, signal), ambience: await loadAmbienceBanks(ctx, signal) };
}

/* ---------- S-22: offline renders for the sensor (OfflineAudioContext, through the game's engine) ---------- */

export type SoundLabSpec =
  /** One sound of a bank at unity, onto the ambience bus (no emitter), in a room's reverb. */
  | {
      kind: 'sound';
      bank: FloorMaterial | 'chimes' | 'drops' | 'wind';
      index: number;
      seconds: number;
      room?: 'workshop' | 'dome';
    }
  /** `steps` footsteps on a floor at the walking cadence, from the feet below the listener (HRTF), in the workshop. */
  | { kind: 'walk'; material: FloorMaterial; steps: number }
  /** The room's ambience heard from a spawn (HRTF, the workshop), with a seed and an ambience volume. */
  | {
      kind: 'ambience';
      seconds: number;
      seed: number;
      at: 'bench' | 'path' | 'dead-end' | 'far';
      volume?: number;
    };

export interface SoundLabResult {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  /** The chimes and drops struck (ambience). */
  hits?: AmbienceHit[];
}

const LAB_RATE = 44100;
/** The walking cadence: 0.7 m strides at 1.4 m/s (game/player/motion.ts footfallsBy). */
const WALK_STEP_SECONDS = 0.5;

/** Renders a sound of the room offline (no gesture needed, no live context touched). For the sensor and the ear. */
export async function renderSoundLab(spec: SoundLabSpec): Promise<SoundLabResult> {
  const seconds = spec.kind === 'walk' ? spec.steps * WALK_STEP_SECONDS + 1 : spec.seconds;
  let hits: AmbienceHit[] | undefined;
  const buffer = await renderOffline(
    { duration: seconds, sampleRate: LAB_RATE, channels: 2 },
    async (ctx) => {
      const room = spec.kind === 'sound' && spec.room === 'dome' ? VIDRO_ROOMS.dome : VIDRO_ROOMS.workshop;
      const engine = await createVidroEngine(ctx, room);
      if (spec.kind === 'sound') {
        const source =
          spec.bank === 'chimes'
            ? CHIME_SOURCES[spec.index]
            : spec.bank === 'drops'
              ? DROP_SOURCES[spec.index]
              : spec.bank === 'wind'
                ? WIND_SOURCE
                : FOOTSTEP_SOURCES[spec.bank][spec.index];
        if (!source) throw new RangeError(`no sound ${spec.bank} #${spec.index}`);
        const [buf] = await loadBank(ctx, [source]);
        if (!buf) throw new Error(`sound ${source.id} did not render`);
        if (spec.bank === 'wind') startLoop(ctx, engine.bus('ambience'), buf, 0);
        else scheduleBuffer(ctx, engine.bus('ambience'), buf, 0.01);
      } else if (spec.kind === 'walk') {
        engine.setListener({ x: 0, y: EYE_HEIGHT, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
        const feet = engine.createEmitter('ambience', { x: 0, y: 0, z: 0 });
        const bank = await loadBank(ctx, FOOTSTEP_SOURCES[spec.material]);
        const rng = mulberry32(5);
        let prev: number | null = null;
        for (let k = 0; k < spec.steps; k++) {
          const v = nextVariant(prev, bank.length, rng);
          prev = v;
          const b = bank[v];
          if (b)
            scheduleBuffer(ctx, feet.input, b, 0.3 + k * WALK_STEP_SECONDS, { gain: FOOTSTEP_TUNING.level });
        }
      } else {
        const spawn = SPAWNS[spec.at];
        const [fx, fy, fz] = lookDirection(spawn.yaw, 0);
        engine.setListener(
          { x: spawn.feet[0], y: spawn.feet[1] + EYE_HEIGHT, z: spawn.feet[2] },
          { x: fx, y: fy, z: fz },
          { x: 0, y: 1, z: 0 },
        );
        engine.setVolume('ambience', spec.volume ?? VIDRO_VOLUMES.ambience);
        const banks = await loadAmbienceBanks(ctx);
        const { player } = placeAmbience(engine, banks, mulberry32(spec.seed), { waitForRunning: false });
        player.start(0);
        for (let t = 0; t <= seconds; t += 0.1) player.update(t);
        hits = player.hits;
      }
      return engine;
    },
  );
  return {
    sampleRate: buffer.sampleRate,
    left: buffer.getChannelData(0),
    right: buffer.getChannelData(1),
    hits,
  };
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
   * Voices the engine started / refused while answering this sound's cues, on its own engine as on a shared one
   * (S-22: the engine also plays the footsteps, counted under `footsteps`, and a shared one the UI's). The engine's
   * whole count is `engineVoices`.
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
  /** Every voice the engine has started (S-22: on its own engine, the cues' and the steps'; shared, also the UI's). */
  readonly engineVoices: number;
  /** S-22: the footsteps. */
  readonly footsteps: FootstepsProbe;
  /** S-22: the workshop's ambience. */
  readonly ambience: AmbienceProbe;
  /** S-22 sensor (not enumerable, so probes copied by the e2e leave it out): renders a sound offline. */
  readonly render: (spec: SoundLabSpec) => Promise<SoundLabResult>;
}

/** One footstep that sounded: the floor (zone and material) where the foot came down, and how. */
export interface FootstepEntry {
  material: FloorMaterial;
  zone: string;
  variant: number;
  x: number;
  z: number;
  /** The room's clock (s). */
  time: number;
  /** The body's speed (m/s). */
  speed: number;
  /** Metres from the listener. */
  distance: number;
}

export interface FootstepsProbe {
  /** The steps' sounds are loaded and the feet's emitter placed. */
  ready: boolean;
  /**
   * Footfalls answered: steps that sounded, that the engine refused, footfalls that fell in a frame that had already
   * stepped, and steps on a floor none of whose sounds could be loaded.
   */
  count: number;
  refused: number;
  skipped: number;
  missing: number;
  /** The room's footfall count when the steps began to answer it (earlier footfalls are never played). */
  since: number | null;
  /** Voices the engine started for the steps. */
  voicesStarted: number;
  /** The last steps (at most 64), oldest first. */
  log: FootstepEntry[];
}

export interface AmbienceProbe {
  /** Its sounds are loaded and its emitters placed. */
  ready: boolean;
  /** Started (the room is played) and not stopped. */
  playing: boolean;
  sources: AmbienceSourceState[];
  /** How loud each kind sounds now, at its source (RMS of the last ~43 ms). */
  levels: Record<AmbienceKind, number>;
}

const SILENT_LEVELS: Readonly<Record<AmbienceKind, number>> = { wind: 0, chimes: 0, drops: 0 };
const MAX_STEPS_LOGGED = 64;

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
  /**
   * Loads the footsteps' and the ambience's sounds once the engine is there (S-22); `signal` is aborted when the room
   * is left. Default: loadSoundBanks.
   */
  loadBanks?: (ctx: BaseAudioContext, signal?: AbortSignal) => Promise<SoundBanks>;
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
  const loadBanks = opts.loadBanks ?? loadSoundBanks;
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
  // S-22: the footsteps and the ambience, once their sounds are loaded
  let steps: { player: Footsteps; feet: Emitter } | null = null;
  let ambience: AmbiencePlayer | null = null;
  const stepLog: FootstepEntry[] = [];
  const stepCounts = { count: 0, refused: 0, skipped: 0, missing: 0, voices: 0 };
  /** Stops the loading of the sounds when the room is left before they are all made. */
  const loading = new AbortController();
  let stepsSince: number | null = null;
  let lastFootfalls = 0;
  const feetAt = { x: 0, y: 0, z: 0 };

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
    // S-22: the footsteps' and the ambience's sounds (rendered or decoded a little at a time, off the gesture)
    void loadBanks(e.ctx, loading.signal).then(
      (banks) => {
        if (disposed || engine !== e) return;
        const p = roomProbe.position;
        const feet = e.createEmitter('ambience', { x: p.x, y: p.y, z: p.z });
        const placed = placeAmbience(e, banks.ambience);
        live.push(feet, ...placed.emitters);
        steps = { player: new Footsteps(banks.footsteps), feet };
        ambience = placed.player;
      },
      (err) => {
        if (!disposed) console.error('S-22: the footsteps and the ambience could not be loaded:', err);
      },
    );
  };

  /** One footstep where the feet are now, for the floor under them (the engine admits it like any effect). */
  const step = (e: AudioEngine, s: NonNullable<typeof steps>): void => {
    const { x, y, z } = roomProbe.position;
    const floor = floorAt(x, z);
    if (!s.player.has(floor.material)) {
      stepCounts.missing++;
      return;
    }
    feetAt.x = x;
    feetAt.y = y;
    feetAt.z = z;
    s.feet.setPosition(feetAt);
    const before = e.snapshot().voicesStarted;
    const played = s.player.play(e, s.feet, floor.material, roomProbe.speed / WALK_SPEED);
    stepCounts.voices += e.snapshot().voicesStarted - before;
    if (!played) {
      stepCounts.refused++;
      return;
    }
    stepCounts.count++;
    stepLog.push({
      material: floor.material,
      zone: floor.zone,
      variant: played.variant,
      x,
      z,
      time: roomProbe.time,
      speed: roomProbe.speed,
      distance: Math.hypot(x - ear.x, y - ear.y, z - ear.z),
    });
    if (stepLog.length > MAX_STEPS_LOGGED) stepLog.shift();
  };

  /** Every frame (S-22): a footstep for a new footfall; the ambience starts with the room and is planned ahead. */
  const tick = (): void => {
    const e = engine;
    if (!e || disposed) return;
    if (steps) {
      const n = roomProbe.footfalls;
      if (stepsSince === null) {
        // footfalls from before the sound could answer them are never played (溜めて後から鳴らさない)
        stepsSince = n;
        lastFootfalls = n;
      } else if (n > lastFootfalls) {
        // one step a frame; a long frame that held two footfalls plays the latest
        stepCounts.skipped += n - lastFootfalls - 1;
        lastFootfalls = n;
        step(e, steps);
      }
    }
    if (ambience) {
      // the workshop sounds once it is played (not on the home screen or during the dive), and only while the audio
      // runs, so nothing is queued up to burst out later
      if (!ambience.playing && roomProbe.playing && e.ctx.state === 'running') ambience.start(e.now());
      ambience.update(e.ctx.currentTime);
    }
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
    // what the engine did for the cues, on its own engine as on a shared one: since S-22 the footsteps play on it too
    // (counted under footsteps), and a shared one also plays the UI's (engineVoices is the engine's whole count)
    get voicesStarted() {
      return voicesStarted;
    },
    get voicesDropped() {
      return voicesDropped;
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
    get engineVoices() {
      return engine?.snapshot().voicesStarted ?? 0;
    },
    get footsteps(): FootstepsProbe {
      return {
        ready: steps !== null,
        count: stepCounts.count,
        refused: stepCounts.refused,
        skipped: stepCounts.skipped,
        missing: stepCounts.missing,
        since: stepsSince,
        voicesStarted: stepCounts.voices,
        log: stepLog,
      };
    },
    get ambience(): AmbienceProbe {
      return {
        ready: ambience !== null,
        playing: ambience?.playing ?? false,
        sources: ambience?.sources ?? [],
        levels: ambience?.levels() ?? { ...SILENT_LEVELS },
      };
    },
  } as Omit<SoundProbe, 'render'> as SoundProbe;
  // the sensor's offline renders: not enumerable, so the probes the e2e copies leave the function out
  Object.defineProperty(probe, 'render', { value: renderSoundLab, enumerable: false });

  return {
    probe,
    update() {
      follow();
      tick();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      subscribed = false;
      stopListening();
      stopWaiting?.();
      loading.abort();
      // the ambience glides to silence (~20 ms) and lets go of its own nodes once that has run; the emitters fade too
      ambience?.dispose();
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
