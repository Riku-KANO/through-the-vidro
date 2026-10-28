import * as THREE from 'three/webgpu';
import {
  type AmbienceBanks,
  type AmbienceHit,
  type AmbienceKind,
  type AmbienceOptions,
  AmbiencePlayer,
  type AmbienceSourceState,
  CHIME_SOURCES,
  DOOR_CHIME_SOURCES,
  DROP_SOURCES,
  type DraughtLog,
  FURNACE_SOURCE,
  loadAmbienceBanks,
  WIND_LOOP_SECONDS,
  WIND_SOURCE,
} from '../../audio/ambience';
import { createVidroEngine } from '../../audio/engine';
import {
  FINALE_LEVELS,
  type FinaleBanks,
  finaleSources,
  loadFinaleBanks,
  renderSettle,
} from '../../audio/finale';
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
import { loadWhisperBank, WHISPER_LEVEL, whisperSource } from '../../audio/whisper';
import { loadBank, scheduleBuffer, startLoop, synth } from '../../core/audio/bank';
import type { AudioEngine, Emitter } from '../../core/audio/engine';
import { fadeAndStop, type GlassStrength, type PlannedSource } from '../../core/audio/glass';
import { renderOffline } from '../../core/audio/offline';
import { mulberry32, randomSeed } from '../../core/audio/rng';
import type { ScheduledVoice } from '../../core/audio/voices';
import type { Vec3 } from '../../layers/footing';
import { sweepSpan } from '../../layers/settle';
import { glassEase } from '../../layers/tween';
import {
  AREA1_GATES,
  AREA1_SLOPE,
  AREA1_STREET,
  AREA1_Y,
  area1SlopeHeight,
  eastOf,
  eastX,
  ROOM1_ALLEY,
  SHORTCUT_LEGS,
  SHORTCUT_SECONDS,
} from '../area1/layout';
import { HAND_ORB_RADIUS, handOrbCenter } from '../orb/hand-pose';
import { EYE_HEIGHT, WALK_SPEED } from '../player/constants';
import { type EventBus, eventName, type PrologueEvent } from './events';
import {
  BENCH_ORB,
  BRIDGE_SETTLE,
  DROP,
  EDGE_Z,
  FAR,
  FURNACE_MOUTH,
  floorAt,
  GATE,
  LAMPS,
  lookDirection,
  PEDESTAL_ORB,
  PLAZA,
  PLAZA_Y,
  SLOPE,
  SPAWNS,
  type SpawnName,
  TUB_DRIP,
  WIND_CHIME,
  WORKSHOP_FLOOR_RADIUS,
  WORKSHOP_TOP,
} from './layout';
import type { RoomProbe } from './room';
import {
  type AreaGateEvent,
  type FinaleEvent,
  GATE_OPEN_SECONDS,
  type HintEvent,
  SETTLE_SECONDS,
  type ShortcutEvent,
  steadyEase,
} from './session';

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
 *  - S-25: the workshop's own sounds where S-24 drew them (layout.ts): the furnace burning low in its mouth, a drop
 *    falling from the ladle into the tub, the chime above the door rung by the door's draughts.
 *  - S-34: the close — the drop's light settling the bridge (from the light, following it across) and the gate opening
 *    (from the gate), once each as they start (room.finale; src/audio/finale.ts). Played through the engine's voices
 *    like any event's sound, but logged and counted apart from the cues (`probe.finale`): the cues are S-16's table.
 *  - S-39: 玉のささやき — the vidro left behind whispers (a small glass ring, src/audio/whisper.ts) from where it stands each
 *    time the room's hints say so (room.hints; session.ts whisperDue: as it starts calling, then the gaps apart, widening). Like the
 *    close's sounds, logged and counted apart from the cues (`probe.whisper`).
 *  - S-40: エリア1's shortcut settling (room.shortcut): the bridge's settling sound (src/audio/finale.ts renderSettle), drawn out
 *    over the shortcut's light, from the light's front as it runs along the ridge and down the stairs (`probe.shortcut`).
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

/**
 * The world point a cue sounds from. `hand` is the hand orb's world position. S-36: `at` says where the vidro stands on its
 * pedestal and which drop was touched, when the room has more than the prologue's (RoomProbe orbAt, dropAt); without it,
 * the prologue's pedestal and drop.
 */
export function sourcePoint(
  source: CueSource,
  orb: 'bench' | 'hand' | 'pedestal',
  hand: Vec3,
  at: { orb?: Vec3; drop?: Vec3 } = {},
): Vec3 {
  if (source === 'drop') return at.drop ?? DROP;
  if (source === 'orb' && orb === 'pedestal') return at.orb ?? PEDESTAL_ORB;
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
  /** S-34: the close (the light settling the bridge, the gate opening), apart from `events`. */
  readonly finale?: EventBus<FinaleEvent>;
  /** S-39: the hints (the vidro left behind whispering), apart from `events` and the close's. */
  readonly hints?: EventBus<HintEvent>;
  /** S-40: エリア1's shortcut settling, apart from the others. */
  readonly shortcut?: EventBus<ShortcutEvent>;
  /** S-41: エリア1's gates between its rooms opening, apart from the others. */
  readonly gates?: EventBus<AreaGateEvent>;
  /** The game camera: the listener, and the frame the hand orb is held in. */
  readonly camera: THREE.Object3D;
  readonly probe: Pick<
    RoomProbe,
    'orb' | 'peekAmount' | 'handPresence' | 'time' | 'playing' | 'position' | 'speed' | 'footfalls'
  > & {
    /** S-42: the game's time speed (the pause stops it; 1 when absent): the sounds of the room's time follow it. */
    timeScale?: number;
    /** S-34: where the settling light's front is (world z), null when none. */
    finale?: { readonly frontZ: number | null };
    /** S-36: where the vidro stands on its pedestal, and the drop last touched (the prologue's when absent). */
    orbAt?: Vec3;
    dropAt?: Vec3;
    /**
     * S-36: エリア1 as the room builds it: its ambience starts once it is in the scene and the body is in the town. S-40: where
     * its shortcut's light is now (null while it does not run).
     */
    area1?: { readonly state: string; readonly shortcut?: { readonly front: Vec3 | null } };
  };
}

/* ---------- S-34: the close of the prologue ---------- */

/** The close's sounds, timed to the room's close and moving on its curve (session.ts, layers/tween glassEase). */
export const FINALE_SOURCES = finaleSources({
  settleSeconds: SETTLE_SECONDS,
  gateSeconds: GATE_OPEN_SECONDS,
  ease: glassEase,
});
/** Where the settling light's sound stands: over the deck, at the front (its z from the room). */
const SETTLE_SOUND_Y = 0.7;
/** Where the light starts (world z): the near face of what it settles, along its way (layout.ts BRIDGE_SETTLE). */
const SETTLE_SOUND_FROM_Z = sweepSpan(BRIDGE_SETTLE)[0] / BRIDGE_SETTLE.direction[2];
/** The gate's sound: from the middle of the gate, at the height of its hinges' upper knuckles. */
export const GATE_SOUND: Vec3 = [0, 1.4, GATE.z];

/** One of the close's sounds that played: which, from where, how far from the listener when it started. */
export interface FinalePlayed {
  event: 'settle' | 'gateOpen';
  at: [number, number, number];
  distance: number;
}

/* ---------- S-42: the sounds of the room's time follow its speed (the pause) ---------- */

/** A sound of an event of the room's time (the close, the whisper, the shortcut) while it plays: its source and own gain. */
export interface TimedVoice {
  readonly source: AudioBufferSourceNode;
  readonly time: GainNode;
}

/**
 * 仮 (S-42; 発案者の判断 2026-10-28, 判断待ち 2 の a): a sound of the room's time follows the time's speed s (0..1; the pause
 * stops it in 0.4 s on the glass curve and starts it again in 0.3 s): it plays at s times its speed — slowing with the light
 * or the gate it belongs to — and its own gain is s³, so it is silent and held where it was while the time stands; on resume
 * it goes on from there, in step with the light again. (Only turning it down would let it run on unheard and come back ahead
 * of the light it follows.) The gain falls faster than the speed: its pitch sinks as it slows, and by half speed (an
 * octave down) it is 18 dB under, so the slide is a fading breath under the pause's own sound, not a heard glissando (S-42
 * review 3). Changes glide over `tau` seconds (no zipper); the speed never goes quite to 0 (`minRate`: a held source; an
 * hour's pause moves it on 3.6 s, unheard).
 * When play is left (タイトルへ), they fade out over `leaveFade` and stop: the home has no room sounds (S-42 判断待ち 5).
 */
export const TIME_FOLLOW = { minRate: 1e-3, tau: 0.02, leaveFade: 0.3 } as const;

const rateOf = (scale: number): number => Math.max(TIME_FOLLOW.minRate, Math.min(1, scale));
const gainOf = (scale: number): number => Math.max(0, Math.min(1, scale)) ** 3;

/**
 * Plays `buffer` once into `destination` from `when` at `gain` (as bank.ts scheduleBuffer), following the time's speed
 * `scale` from the start; `onEnded` is told when it has played out.
 */
export function scheduleTimed(
  ctx: BaseAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  when: number,
  gain: number,
  scale = 1,
  onEnded?: (voice: TimedVoice) => void,
): { voice: ScheduledVoice; timed: TimedVoice } {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rateOf(scale);
  const time = ctx.createGain();
  time.gain.value = gainOf(scale);
  const out = ctx.createGain();
  out.gain.value = gain;
  source.connect(time).connect(out).connect(destination);
  // the engine counts it as ending when it would at the time's own speed: a pause makes it end later than counted (only
  // the engine's voice count sees that)
  const end = when + buffer.duration;
  source.start(when);
  const timed: TimedVoice = { source, time };
  source.onended = () => {
    out.disconnect();
    onEnded?.(timed);
  };
  const sources: PlannedSource[] = [{ node: source, stop: end }];
  return { voice: { end, fadeOut: (at: number) => fadeAndStop(out, sources, at) }, timed };
}

/** Sets the time's speed `scale` on the sounds of the room's time, from `at` (gliding). */
export function followTime(voices: Iterable<TimedVoice>, scale: number, at: number): void {
  for (const v of voices) {
    v.source.playbackRate.setTargetAtTime(rateOf(scale), at, TIME_FOLLOW.tau);
    v.time.gain.setTargetAtTime(gainOf(scale), at, TIME_FOLLOW.tau);
  }
}

/** Fades the sounds of the room's time out from `at` and stops them (play is left: タイトルへ). */
export function letTimeGo(voices: Iterable<TimedVoice>, at: number): void {
  for (const v of voices) {
    v.time.gain.cancelScheduledValues(at);
    v.time.gain.setTargetAtTime(0, at, TIME_FOLLOW.leaveFade / 3);
    v.source.stop(at + TIME_FOLLOW.leaveFade * 2);
  }
}

/* ---------- S-40: エリア1's shortcut settling ---------- */

/** The shortcut's light's sound: the bridge's (S-34), its run drawn out over the shortcut's seconds, on its light's pace. */
export const SHORTCUT_SOURCE = synth('shortcut-settle', (sr) =>
  renderSettle(sr, SHORTCUT_SECONDS, steadyEase),
);
/** Where its light starts: the near face of its first leg, along its way (area1/layout.ts SHORTCUT_LEGS), over the deck. */
export const SHORTCUT_SOUND_FROM: Vec3 = (() => {
  const leg = SHORTCUT_LEGS[0];
  if (!leg) return [0, 0, 0];
  const { min, max } = leg.box;
  const d = leg.direction;
  const c: Vec3 = [(min[0] + max[0]) / 2, min[1] + 1.3, (min[2] + max[2]) / 2];
  const k = sweepSpan(leg)[0] - (d[0] * c[0] + d[1] * c[1] + d[2] * c[2]);
  return [c[0] + d[0] * k, c[1] + d[1] * k, c[2] + d[2] * k];
})();
/** How loud it plays at its source (the bridge's level: FINALE_LEVELS.settle). */
const SHORTCUT_LEVEL = FINALE_LEVELS.settle;

/** The shortcut's sound that played: from where (the light's front), how far from the listener when it started. */
export interface ShortcutPlayed {
  at: [number, number, number];
  distance: number;
}

/* ---------- S-41: エリア1's gates between its rooms ---------- */

/**
 * Where a gate's sound stands: the prologue gate's (S-34: the latch, the hinges, the leaves coming to rest), from the middle of
 * the gate at its hinges' upper knuckles, as GATE_SOUND for the prologue's.
 */
export function areaGateSound(id: string): Vec3 | null {
  const g = AREA1_GATES.find((q) => q.id === id);
  return g ? [g.at[0], g.at[1] + 1.4, g.at[2]] : null;
}

/** A gate's sound that played: which gate, from where, how far from the listener when it started. */
export interface AreaGatePlayed {
  gate: string;
  at: [number, number, number];
  distance: number;
}

/* ---------- S-39: 玉のささやき ---------- */

/** The vidro's whisper (S-39): synthesized now, a recording can take its place there (src/audio/whisper.ts). */
export const WHISPER_SOURCE = whisperSource();

/** One whisper that played: from where (the vidro), how far from the listener, and when (the room's clock, s). */
export interface WhisperPlayed {
  at: [number, number, number];
  distance: number;
  time: number;
}

/* ---------- S-22: where the workshop's ambience is placed ---------- */

/**
 * One ambient sound in the room: what, where, and (wind, fire) where in its loop it starts, (drops) on which notes,
 * (chimes) which bells and, for the door's, the wind whose draughts ring them.
 */
export interface AmbientSpot {
  readonly id: string;
  readonly kind: AmbienceKind;
  readonly position: Vec3;
  readonly offset?: number;
  /** Indices into DROP_NOTES (src/audio/ambience.ts). */
  readonly notes?: readonly number[];
  readonly bells?: 'town' | 'door';
  /** The id of the wind spot a draught swells (the door chime's). */
  readonly draught?: string;
  /**
   * Draws when it strikes from a random stream of its own (S-25), so adding it left the timing of S-22's sounds as it
   * was — live as in the seeded renders the ear and the sensors were tuned on.
   */
  readonly ownStream?: boolean;
  /**
   * S-35: hung far away (the town's chimes, about 195 m from the workshop): its level is set by 1/d, so its panner is told
   * to keep lowering it however far it is (Web Audio's inverse law does already; a browser that bounds it at maxDistance,
   * 100 m in the core engine, would play it about twice as loud in the workshop).
   */
  readonly far?: boolean;
}

const [, LAMP] = LAMPS;

/**
 * 遠くの風鈴 (S-22; S-35: 広場の側（街）へ移す): high on a house of the town beyond the central plaza, 音だけ — never drawn, and
 * never within about 50 m of anywhere you walk. From the workshop it lies on S-22's bearing (about 7° right of the way,
 * 5° up), so the head hears it from where S-22 tuned it (S-22's e2e: a strike stands out above the wind at the bench), and
 * its level (src/audio/ambience.ts AMBIENCE.chimes) is set for its distance from there (about 195 m, by 1/d: the panner's
 * inverse law has no farthest distance); nowhere you walk is it louder than S-22's were from the far shore.
 */
export const TOWN_CHIMES: Vec3 = [PLAZA.center[0] + 22, PLAZA_Y + 30, PLAZA.center[2] - 68.4];

/**
 * エリア1の朝 (S-36, 仮置き, to be confirmed by ear; サウンドデザイン > 環境音): the morning's air moving down the street from the
 * hill (a wind bed at the slope's foot, over the houses), and far chimes hung up the hill where the workshop street climbs,
 * 音だけ (never drawn, never near where you walk). Played apart from the workshop's (its own player, started once エリア1 is
 * built: 技術設計 > エリアごとに分けて読み込む), so the workshop sounds as it did (S-22, S-25: its bed and its strikes); the
 * chimes on a random stream of their own (S-25), the wind a bed that draws nothing.
 */
export const AREA1_AMBIENCE: readonly AmbientSpot[] = [
  {
    id: 'wind:area1',
    kind: 'wind',
    position: [AREA1_SLOPE.x, area1SlopeHeight(AREA1_SLOPE.fromZ - 6) + 5, AREA1_SLOPE.fromZ - 6],
    offset: (WIND_LOOP_SECONDS * 3) / 4,
  },
  {
    id: 'chimes:area1',
    kind: 'chimes',
    // S-40: east of 部屋2's courtyard, high over the houses climbing to the summit (S-36's spot was 4 m over the balcony)
    position: [
      eastX(eastOf(AREA1_STREET.endX) + 13.5),
      AREA1_Y + 20,
      (ROOM1_ALLEY.minZ + AREA1_SLOPE.toZ) / 2 - 9,
    ],
    ownStream: true,
    far: true,
  },
];

/**
 * 工房に立体的に置く (仮, to be confirmed by ear):
 *  - the wind through the glass gaps: the skylight at the top of the dome and the door, and outside, rising from the
 *    valley through the broken glass at the edge of the way (S-06: 割れた破片), so the way and the far shore are not
 *    left without air. Each starts at another point of the loop, so no two gaps breathe in step.
 *  - 炉 (S-25): burning low in the furnace's mouth, where its fire is drawn (FURNACE_MOUTH): someone keeps it going
 *    (物語と世界: まだそこで暮らしている気配). Nearer is louder by distance alone.
 *  - 扉の上の風鈴 (S-25): the bell S-24 hung inside the door (WIND_CHIME), rung now and then by a draught that comes in
 *    at the door and swells the wind there (wind:door)
 *  - 遠くの風鈴: hung in the town, far from the workshop — the sound of somewhere lived in, ahead (物語と世界: まだそこで
 *    暮らしている気配). S-22 hung them 6.4 m past the gate; S-35 carries the way on down the slope, so they hang in the
 *    town beyond the central plaza (TOWN_CHIMES): as loud from the workshop as before, coming closer only as you come down
 *    into the plaza, and never near anywhere you walk
 *  - drops: condensation off the skylight's rim onto the glass floor, the wet ladle hung on the tub's rim into its
 *    water (S-25: TUB_DRIP, deeper; S-22 had it over the brass grate, where nothing is drawn), and the milky globe of a
 *    lamp onto the stone of the way (higher)
 * The wind's gaps, the far chimes and the dripping skylight and lamp are not drawn (sounds of what is around); the
 * furnace, the tub and the door's chime are, and their sounds come from where they are drawn.
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
  { id: 'fire:furnace', kind: 'fire', position: FURNACE_MOUTH },
  {
    id: 'chimes:door',
    kind: 'chimes',
    bells: 'door',
    draught: 'wind:door',
    position: WIND_CHIME,
    ownStream: true,
  },
  { id: 'chimes:town', kind: 'chimes', position: TOWN_CHIMES, far: true },
  { id: 'drops:skylight', kind: 'drops', position: [0.55, 0.02, 0.55], notes: [3, 4, 5] },
  { id: 'drops:tub', kind: 'drops', position: TUB_DRIP, notes: [0, 1, 2, 3] },
  {
    id: 'drops:lamp',
    kind: 'drops',
    position: [(LAMP?.x ?? -1.12) + 0.17, 0.02, LAMP?.z ?? -9.4],
    notes: [4, 5, 6, 7],
  },
];

/** A spot of the room's ambience and the emitter it plays from. */
interface PlacedSpot {
  spot: AmbientSpot;
  emitter: Emitter;
}

/** FNV-1a of a string: a spot's own stream is the seed mixed with its id. */
function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

interface PlaceOptions extends AmbienceOptions {
  /** Seeds the timing (the sensor's renders); live, a random one. */
  seed?: number;
  /** Only the spots with these ids. */
  only?: readonly string[];
  /** The spots placed (PROLOGUE_AMBIENCE by default; S-36: AREA1_AMBIENCE, its own player). */
  spots?: readonly AmbientSpot[];
}

/**
 * Emitters for PROLOGUE_AMBIENCE (or only the spots named in `only`) on the ambience bus, and the player that plays
 * into them (live and offline alike).
 */
function placeAmbience(
  engine: AudioEngine,
  banks: AmbienceBanks,
  opts: PlaceOptions = {},
): { player: AmbiencePlayer; placed: PlacedSpot[] } {
  const { only } = opts;
  const seed = opts.seed ?? randomSeed();
  const all = opts.spots ?? PROLOGUE_AMBIENCE;
  const spots = only ? all.filter((s) => only.includes(s.id)) : all;
  const placed = spots.map((spot) => {
    const emitter = engine.createEmitter('ambience', {
      x: spot.position[0],
      y: spot.position[1],
      z: spot.position[2],
    });
    // S-35: a far place's panner lowers it by distance however far it is (AmbientSpot.far)
    const panner = emitter.input as Partial<PannerNode>;
    if (spot.far && typeof panner.maxDistance === 'number') panner.maxDistance = 10_000;
    return { spot, emitter };
  });
  const places = placed.map(({ spot, emitter }) => ({
    id: spot.id,
    kind: spot.kind,
    input: emitter.input,
    offset: spot.offset,
    notes: spot.notes,
    bells: spot.bells,
    draught: spot.draught,
    rng: spot.ownStream ? mulberry32((seed ^ idHash(spot.id)) >>> 0) : undefined,
  }));
  const player = new AmbiencePlayer(engine.ctx, banks, places, mulberry32(seed), {
    waitForRunning: opts.waitForRunning,
  });
  return { player, placed };
}

/** Everything the room's footsteps and ambience play from (S-22), and (S-34) the close's two sounds. */
export interface SoundBanks {
  footsteps: FootstepBanks;
  ambience: AmbienceBanks;
  /** S-34. Without it the close stays silent (and says so: probe.finale.refused). */
  finale?: FinaleBanks;
  /** S-39. Without it the vidro's whisper stays silent (and says so: probe.whisper.refused). */
  whisper?: AudioBuffer | null;
  /** S-40. Without it エリア1's shortcut settles silent (and says so: probe.shortcut.refused). */
  shortcut?: AudioBuffer | null;
}

export async function loadSoundBanks(ctx: BaseAudioContext, signal?: AbortSignal): Promise<SoundBanks> {
  return {
    footsteps: await loadFootstepBanks(ctx, signal),
    ambience: await loadAmbienceBanks(ctx, signal),
    finale: await loadFinaleBanks(ctx, FINALE_SOURCES, signal),
    whisper: await loadWhisperBank(ctx, WHISPER_SOURCE, signal),
    shortcut: (await loadBank(ctx, [SHORTCUT_SOURCE], { signal }))[0] ?? null,
  };
}

/* ---------- S-22: offline renders for the sensor (OfflineAudioContext, through the game's engine) ---------- */

export type SoundLabSpec =
  /**
   * One sound of a bank at unity, onto the ambience bus (no emitter), in a room's reverb. The loops (wind, S-25 fire)
   * play on from the start. S-34: 'finale' #0 is the bridge settling, #1 the gate opening. S-39: 'whisper' #0.
   */
  | {
      kind: 'sound';
      bank: FloorMaterial | 'chimes' | 'drops' | 'wind' | 'fire' | 'door-chime' | 'finale' | 'whisper';
      index: number;
      seconds: number;
      room?: 'workshop' | 'dome';
    }
  /** `steps` footsteps on a floor at the walking cadence, from the feet below the listener (HRTF), in the workshop. */
  | { kind: 'walk'; material: FloorMaterial; steps: number }
  /**
   * The room's ambience heard from a spawn (HRTF, the workshop), with a seed and an ambience volume; `only` keeps the
   * spots of PROLOGUE_AMBIENCE named (S-25: one sound heard on its own from where you stand).
   */
  | {
      kind: 'ambience';
      seconds: number;
      seed: number;
      at: SpawnName;
      volume?: number;
      only?: readonly string[];
    }
  /**
   * S-39: the room's ambience heard from a spawn as above (facing `yaw` instead of the spawn's, when given), and
   * (`whisper`) the vidro's whisper from its pedestal `when` seconds in, at its level on the effects bus (as the room plays
   * it): is it heard where you stand?
   */
  | {
      kind: 'whisper';
      seconds: number;
      seed: number;
      at: SpawnName;
      yaw?: number;
      when: number;
      whisper: boolean;
    }
  /**
   * S-42: one of the sounds of the room's time from 0.01 s, on the effects bus at its level (no emitter), as the room plays
   * it (`scheduleTimed`), its time's speed set at the given moments ([seconds, speed]: the pause sets it frame by frame).
   */
  | {
      kind: 'timed';
      sound: 'settle' | 'gate' | 'shortcut' | 'whisper';
      seconds: number;
      speeds?: readonly (readonly [number, number])[];
    };

export interface SoundLabResult {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  /** The chimes and drops struck (ambience). */
  hits?: AmbienceHit[];
  /** S-25: the door's draughts (ambience). */
  draughts?: DraughtLog[];
}

const LAB_RATE = 44100;
/** S-42: the sounds of the room's time in the lab, and the level the room plays each at. */
const TIMED_LAB = {
  settle: { source: FINALE_SOURCES.settle, level: FINALE_LEVELS.settle },
  gate: { source: FINALE_SOURCES.gate, level: FINALE_LEVELS.gate },
  shortcut: { source: SHORTCUT_SOURCE, level: SHORTCUT_LEVEL },
  whisper: { source: WHISPER_SOURCE, level: WHISPER_LEVEL },
} as const;
/** The walking cadence: 0.7 m strides at 1.4 m/s (game/player/motion.ts footfallsBy). */
const WALK_STEP_SECONDS = 0.5;

/** Renders a sound of the room offline (no gesture needed, no live context touched). For the sensor and the ear. */
export async function renderSoundLab(spec: SoundLabSpec): Promise<SoundLabResult> {
  const seconds = spec.kind === 'walk' ? spec.steps * WALK_STEP_SECONDS + 1 : spec.seconds;
  let hits: AmbienceHit[] | undefined;
  let draughts: DraughtLog[] | undefined;
  const buffer = await renderOffline(
    { duration: seconds, sampleRate: LAB_RATE, channels: 2 },
    async (ctx) => {
      const room = spec.kind === 'sound' && spec.room === 'dome' ? VIDRO_ROOMS.dome : VIDRO_ROOMS.workshop;
      const engine = await createVidroEngine(ctx, room);
      if (spec.kind === 'sound') {
        const { bank, index } = spec;
        const source =
          bank === 'chimes'
            ? CHIME_SOURCES[index]
            : bank === 'door-chime'
              ? DOOR_CHIME_SOURCES[index]
              : bank === 'drops'
                ? DROP_SOURCES[index]
                : bank === 'wind'
                  ? WIND_SOURCE
                  : bank === 'fire'
                    ? FURNACE_SOURCE
                    : bank === 'finale'
                      ? [FINALE_SOURCES.settle, FINALE_SOURCES.gate][index]
                      : bank === 'whisper'
                        ? [WHISPER_SOURCE][index]
                        : FOOTSTEP_SOURCES[bank][index];
        if (!source) throw new RangeError(`no sound ${bank} #${index}`);
        const [buf] = await loadBank(ctx, [source]);
        if (!buf) throw new Error(`sound ${source.id} did not render`);
        if (bank === 'wind' || bank === 'fire') startLoop(ctx, engine.bus('ambience'), buf, 0);
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
      } else if (spec.kind === 'timed') {
        const { source, level } = TIMED_LAB[spec.sound];
        const [buf] = await loadBank(ctx, [source]);
        if (!buf) throw new Error(`sound ${source.id} did not render`);
        const { timed } = scheduleTimed(ctx, engine.bus('sfx'), buf, 0.01, level);
        for (const [at, speed] of spec.speeds ?? []) followTime([timed], speed, at);
      } else {
        const spawn = SPAWNS[spec.at];
        const yaw = spec.kind === 'whisper' && spec.yaw !== undefined ? spec.yaw : spawn.yaw;
        const [fx, fy, fz] = lookDirection(yaw, 0);
        engine.setListener(
          { x: spawn.feet[0], y: spawn.feet[1] + EYE_HEIGHT, z: spawn.feet[2] },
          { x: fx, y: fy, z: fz },
          { x: 0, y: 1, z: 0 },
        );
        engine.setVolume(
          'ambience',
          (spec.kind === 'ambience' ? spec.volume : undefined) ?? VIDRO_VOLUMES.ambience,
        );
        const banks = await loadAmbienceBanks(ctx);
        const { player } = placeAmbience(engine, banks, {
          seed: spec.seed,
          waitForRunning: false,
          only: spec.kind === 'ambience' ? spec.only : undefined,
        });
        player.start(0);
        for (let t = 0; t <= seconds; t += 0.1) player.update(t);
        hits = player.hits;
        draughts = player.draughts;
        // S-39: the whisper from the vidro on its pedestal, as the room plays it (sound.ts playWhisper)
        if (spec.kind === 'whisper' && spec.whisper) {
          const [buf] = await loadBank(ctx, [WHISPER_SOURCE]);
          if (!buf) throw new Error('the whisper did not render');
          const emitter = engine.createEmitter('sfx', {
            x: PEDESTAL_ORB[0],
            y: PEDESTAL_ORB[1],
            z: PEDESTAL_ORB[2],
          });
          scheduleBuffer(ctx, emitter.input, buf, spec.when, { gain: WHISPER_LEVEL });
        }
      }
      return engine;
    },
  );
  return {
    sampleRate: buffer.sampleRate,
    left: buffer.getChannelData(0),
    right: buffer.getChannelData(1),
    hits,
    draughts,
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
  /** S-34: the close's sounds (the bridge settling, the gate opening), counted apart from the cues. */
  readonly finale: FinaleSoundProbe;
  /** S-39: the vidro's whisper, counted apart from the cues. */
  readonly whisper: WhisperSoundProbe;
  /** S-40: エリア1's shortcut settling, counted apart from the cues. */
  readonly shortcut: ShortcutSoundProbe;
  /** S-41: エリア1's gates between its rooms opening, counted apart from the cues. */
  readonly gates: AreaGateSoundProbe;
  /** S-42: the time's speed the sounds of the room's time follow, and how many of them are playing. */
  readonly time: TimeSoundProbe;
  /** S-22 sensor (not enumerable, so probes copied by the e2e leave it out): renders a sound offline. */
  readonly render: (spec: SoundLabSpec) => Promise<SoundLabResult>;
}

/**
 * S-34: the close's sounds. Each of 'settle' and 'gateOpen' is answered once, as it happens: played (with where from), or
 * refused (no audio yet, its sounds not loaded, or the engine refused it) and then never played later.
 */
export interface FinaleSoundProbe {
  /** Its sounds are loaded and its emitters placed. */
  ready: boolean;
  played: FinalePlayed[];
  refused: string[];
  /** Voices the engine started for them (the engine's whole count takes them in: engineVoices). */
  voicesStarted: number;
}

/**
 * S-39: the vidro's whisper. Each whisper the room's hints ask for is answered once, as it happens: played (from where, how
 * far, when), or refused (no audio yet, its sound not loaded, or the engine refused it) and then never played later.
 */
export interface WhisperSoundProbe {
  /** Its sound is loaded and its emitter placed. */
  ready: boolean;
  played: WhisperPlayed[];
  refused: string[];
  /** Voices the engine started for it (the engine's whole count takes them in: engineVoices). */
  voicesStarted: number;
}

/**
 * S-40: エリア1's shortcut settling. Its light starting is answered once, as it happens: played (from where, how far), or refused
 * (no audio yet, its sound not loaded, or the engine refused it) and then never played later.
 */
export interface ShortcutSoundProbe {
  /** Its sound is loaded and its emitter placed. */
  ready: boolean;
  played: ShortcutPlayed[];
  refused: string[];
  /** Voices the engine started for it (the engine's whole count takes them in: engineVoices). */
  voicesStarted: number;
}

/**
 * S-41: エリア1's gates between its rooms. Each gate starting to open is answered once, as it happens: played (which, from where,
 * how far), or refused (no audio yet, its sound not loaded, or the engine refused it) and then never played later.
 */
export interface AreaGateSoundProbe {
  /** Its sound (the prologue gate's) is loaded and its emitter placed. */
  ready: boolean;
  played: AreaGatePlayed[];
  refused: string[];
  /** Voices the engine started for them (the engine's whole count takes them in: engineVoices). */
  voicesStarted: number;
}

/** S-42: the sounds of the room's time (the close, the whisper, the shortcut, エリア1's gates) and the speed they follow. */
export interface TimeSoundProbe {
  /** The speed last followed (1 = as they play; 0 = standing, silent). */
  scale: number;
  /** Such sounds playing now (also standing ones). */
  voices: number;
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

/** The footsteps. Every footfall since `since` is answered once: count + refused + skipped + missing = footfalls - since. */
export interface FootstepsProbe {
  /** The steps' sounds are loaded and the feet's emitter placed. */
  ready: boolean;
  /** Steps that sounded. */
  count: number;
  /** Steps the engine refused (audio not running). */
  refused: number;
  /** Footfalls folded into a step of the same frame (a long frame that held two). */
  skipped: number;
  /** Steps on a floor none of whose sounds could be loaded (silent). */
  missing: number;
  /** The room's footfall count when the steps began to answer it (earlier footfalls are never played). */
  since: number | null;
  /** Voices the engine started for the steps. */
  voicesStarted: number;
  /** The last steps (at most 64), oldest first. */
  log: FootstepEntry[];
}

/** S-25: one spot of the ambience as the audio graph has it. */
export interface AmbiencePlaceProbe {
  id: string;
  kind: AmbienceKind;
  /** Where its emitter's PannerNode stands (read back from the node, not from the table). */
  position: [number, number, number];
  panning: string;
}

export interface AmbienceProbe {
  /** Its sounds are loaded and its emitters placed. */
  ready: boolean;
  /** Started (the room is played) and not stopped. */
  playing: boolean;
  sources: AmbienceSourceState[];
  /** How loud each kind sounds now, at its source (RMS of the last ~43 ms). */
  levels: Record<AmbienceKind, number>;
  /** S-25: each spot's emitter, in PROLOGUE_AMBIENCE's order then (S-36) AREA1_AMBIENCE's (none before the sounds are loaded). */
  places: AmbiencePlaceProbe[];
  /** S-25: the last strikes of chimes and drops (at most 64), oldest first. */
  hits: AmbienceHit[];
  /** S-25: the door's last draughts (at most 16), oldest first. */
  draughts: DraughtLog[];
}

const SILENT_LEVELS: Readonly<Record<AmbienceKind, number>> = { wind: 0, fire: 0, chimes: 0, drops: 0 };

/** Where a PannerNode stands (its AudioParams; the old setPosition-only API is not read). */
function pannerPosition(node: AudioNode): [number, number, number] {
  const p = node as PannerNode;
  return [
    p.positionX?.value ?? Number.NaN,
    p.positionY?.value ?? Number.NaN,
    p.positionZ?.value ?? Number.NaN,
  ];
}
const MAX_STEPS_LOGGED = 64;
const MAX_WHISPERS_LOGGED = 32;

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
  let ambienceSpots: PlacedSpot[] = [];
  /** S-36: エリア1's morning, its own player (started once エリア1 is built). */
  let area1Ambience: AmbiencePlayer | null = null;
  let area1Spots: PlacedSpot[] = [];
  const stepLog: FootstepEntry[] = [];
  const stepCounts = { count: 0, refused: 0, skipped: 0, missing: 0, voices: 0 };
  /** Stops the loading of the sounds when the room is left before they are all made. */
  const loading = new AbortController();
  let stepsSince: number | null = null;
  let lastFootfalls = 0;
  const feetAt = { x: 0, y: 0, z: 0 };
  /** S-42: the sounds of the room's time now playing (held until they end: S-09), and the time's speed they follow. */
  const timed = new Set<TimedVoice>();
  let timeScale = 1;
  const playTimed =
    (buffer: AudioBuffer, level: number) =>
    (ctx: BaseAudioContext, destination: AudioNode, when: number): ScheduledVoice => {
      const { voice, timed: t } = scheduleTimed(ctx, destination, buffer, when, level, timeScale, (v) =>
        timed.delete(v),
      );
      timed.add(t);
      return voice;
    };

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
      const point = sourcePoint(cue.source, roomProbe.orb, [handWorld.x, handWorld.y, handWorld.z], {
        orb: roomProbe.orbAt,
        drop: roomProbe.dropAt,
      });
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

  // S-34: the close's two sounds, once their buffers are loaded; apart from the cues (S-16's table)
  let finale: { banks: FinaleBanks; settle: Emitter; gate: Emitter } | null = null;
  const finaleLog = { played: [] as FinalePlayed[], refused: [] as string[], voices: 0 };
  const settleAt = { x: 0, y: SETTLE_SOUND_Y, z: SETTLE_SOUND_FROM_Z };
  /**
   * The settling light's sound goes with its front over the bridge. The moment the light starts, the room has not drawn
   * its front yet (the event comes from the session's step): it starts where the light does.
   */
  const followFront = (): void => {
    if (!finale) return;
    const z = roomProbe.finale?.frontZ;
    settleAt.z = z === null || z === undefined ? SETTLE_SOUND_FROM_Z : z;
    finale.settle.setPosition(settleAt);
  };
  /** The light is on its way over the bridge (from 'settle' to 'settled'): only then does its sound move. */
  let lightRunning = false;
  /** The light starting across / the gate starting to open: its sound, once, now (or refused, never later). */
  const playFinale = (event: FinaleEvent): void => {
    if (event.type === 'settle') lightRunning = true;
    if (event.type === 'settled') lightRunning = false;
    if (disposed || (event.type !== 'settle' && event.type !== 'gateOpen')) return;
    const kind = event.type;
    const buffer = kind === 'settle' ? finale?.banks.settle : finale?.banks.gate;
    if (!engine || !finale || !buffer) {
      finaleLog.refused.push(kind);
      return;
    }
    follow();
    followFront();
    const emitter = kind === 'settle' ? finale.settle : finale.gate;
    const where: [number, number, number] =
      kind === 'settle'
        ? [settleAt.x, settleAt.y, settleAt.z]
        : [GATE_SOUND[0], GATE_SOUND[1], GATE_SOUND[2]];
    const level = kind === 'settle' ? FINALE_LEVELS.settle : FINALE_LEVELS.gate;
    const before = engine.snapshot().voicesStarted;
    const started = engine.startVoice({ level, emitter }, playTimed(buffer, level));
    finaleLog.voices += engine.snapshot().voicesStarted - before;
    if (!started) {
      finaleLog.refused.push(kind);
      return;
    }
    finaleLog.played.push({
      event: kind,
      at: where,
      distance: Math.hypot(where[0] - ear.x, where[1] - ear.y, where[2] - ear.z),
    });
  };
  const offFinale = room.finale?.on(playFinale) ?? null;

  // S-39: the vidro's whisper, once its buffer is loaded; apart from the cues (S-16's table) and the close's
  let whisper: { buffer: AudioBuffer; emitter: Emitter } | null = null;
  const whisperLog = { played: [] as WhisperPlayed[], refused: [] as string[], voices: 0 };
  const whisperAt = { x: PEDESTAL_ORB[0], y: PEDESTAL_ORB[1], z: PEDESTAL_ORB[2] };
  const refuseWhisper = (type: string): void => {
    whisperLog.refused.push(type);
    if (whisperLog.refused.length > MAX_WHISPERS_LOGGED) whisperLog.refused.shift();
  };
  /** A whisper: from the vidro where it stands (the pedestal; the bench), once, now (or refused, never later). */
  const playWhisper = (event: HintEvent): void => {
    if (disposed || event.type !== 'whisper') return;
    if (!engine || !whisper) {
      refuseWhisper(event.type);
      return;
    }
    follow();
    const [x, y, z] = sourcePoint('orb', roomProbe.orb, [handWorld.x, handWorld.y, handWorld.z], {
      orb: roomProbe.orbAt,
    });
    whisperAt.x = x;
    whisperAt.y = y;
    whisperAt.z = z;
    whisper.emitter.setPosition(whisperAt);
    const { buffer } = whisper;
    const before = engine.snapshot().voicesStarted;
    const started = engine.startVoice(
      { level: WHISPER_LEVEL, emitter: whisper.emitter },
      playTimed(buffer, WHISPER_LEVEL),
    );
    whisperLog.voices += engine.snapshot().voicesStarted - before;
    if (!started) {
      refuseWhisper(event.type);
      return;
    }
    whisperLog.played.push({
      at: [x, y, z],
      distance: Math.hypot(x - ear.x, y - ear.y, z - ear.z),
      time: roomProbe.time,
    });
    if (whisperLog.played.length > MAX_WHISPERS_LOGGED) whisperLog.played.shift();
  };
  const offHints = room.hints?.on(playWhisper) ?? null;

  // S-40: エリア1's shortcut settling, once its buffer is loaded; from the light's front, following it while it runs
  let shortcutSound: { buffer: AudioBuffer; emitter: Emitter } | null = null;
  const shortcutLog = { played: [] as ShortcutPlayed[], refused: [] as string[], voices: 0 };
  const shortcutAt = { x: SHORTCUT_SOUND_FROM[0], y: SHORTCUT_SOUND_FROM[1], z: SHORTCUT_SOUND_FROM[2] };
  /** Its light is on its way (from 'settle' to 'settled'): only then does its sound move. */
  let shortcutRunning = false;
  const followShortcut = (): void => {
    if (!shortcutSound) return;
    const front = roomProbe.area1?.shortcut?.front;
    if (front) {
      shortcutAt.x = front[0];
      shortcutAt.y = front[1] + 0.7;
      shortcutAt.z = front[2];
    }
    shortcutSound.emitter.setPosition(shortcutAt);
  };
  const playShortcut = (event: ShortcutEvent): void => {
    if (event.type === 'settled') shortcutRunning = false;
    if (disposed || event.type !== 'settle') return;
    shortcutRunning = true;
    if (!engine || !shortcutSound) {
      shortcutLog.refused.push(event.type);
      return;
    }
    follow();
    // it starts where the light does (the room has not moved its front yet: the event comes from the session's step)
    shortcutAt.x = SHORTCUT_SOUND_FROM[0];
    shortcutAt.y = SHORTCUT_SOUND_FROM[1];
    shortcutAt.z = SHORTCUT_SOUND_FROM[2];
    shortcutSound.emitter.setPosition(shortcutAt);
    const { buffer } = shortcutSound;
    const before = engine.snapshot().voicesStarted;
    const started = engine.startVoice(
      { level: SHORTCUT_LEVEL, emitter: shortcutSound.emitter },
      playTimed(buffer, SHORTCUT_LEVEL),
    );
    shortcutLog.voices += engine.snapshot().voicesStarted - before;
    if (!started) {
      shortcutLog.refused.push(event.type);
      return;
    }
    const [x, y, z] = [shortcutAt.x, shortcutAt.y, shortcutAt.z];
    shortcutLog.played.push({ at: [x, y, z], distance: Math.hypot(x - ear.x, y - ear.y, z - ear.z) });
  };
  const offShortcut = room.shortcut?.on(playShortcut) ?? null;

  // S-41: エリア1's gates between its rooms, once the close's sounds are loaded (the gate's is theirs); from each gate
  let gateEmitter: Emitter | null = null;
  const gateLog = { played: [] as AreaGatePlayed[], refused: [] as string[], voices: 0 };
  const playAreaGate = (event: AreaGateEvent): void => {
    if (disposed || event.type !== 'open') return;
    const where = areaGateSound(event.gate);
    const buffer = finale?.banks.gate;
    if (!engine || !gateEmitter || !buffer || !where) {
      gateLog.refused.push(event.gate);
      return;
    }
    follow();
    gateEmitter.setPosition({ x: where[0], y: where[1], z: where[2] });
    const level = FINALE_LEVELS.gate;
    const emitter = gateEmitter;
    const before = engine.snapshot().voicesStarted;
    // S-42: a sound of the room's time (it stands with the pause)
    const started = engine.startVoice({ level, emitter }, playTimed(buffer, level));
    gateLog.voices += engine.snapshot().voicesStarted - before;
    if (!started) {
      gateLog.refused.push(event.gate);
      return;
    }
    gateLog.played.push({
      gate: event.gate,
      at: [where[0], where[1], where[2]],
      distance: Math.hypot(where[0] - ear.x, where[1] - ear.y, where[2] - ear.z),
    });
  };
  const offGates = room.gates?.on(playAreaGate) ?? null;

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
        const { player: placedPlayer, placed } = placeAmbience(e, banks.ambience);
        const area1 = placeAmbience(e, banks.ambience, { spots: AREA1_AMBIENCE });
        live.push(feet, ...placed.map((p) => p.emitter), ...area1.placed.map((p) => p.emitter));
        steps = { player: new Footsteps(banks.footsteps), feet };
        ambience = placedPlayer;
        ambienceSpots = placed;
        area1Ambience = area1.player;
        area1Spots = area1.placed;
        // S-34: the close's sounds, from the bridge (following the light) and from the gate
        if (banks.finale) {
          const settle = e.createEmitter('sfx', settleAt);
          const gate = e.createEmitter('sfx', { x: GATE_SOUND[0], y: GATE_SOUND[1], z: GATE_SOUND[2] });
          // S-41: and エリア1's gates (the same sound, from wherever the gate opening stands)
          const first = areaGateSound(AREA1_GATES[0]?.id ?? '') ?? GATE_SOUND;
          gateEmitter = e.createEmitter('sfx', { x: first[0], y: first[1], z: first[2] });
          live.push(settle, gate, gateEmitter);
          finale = { banks: banks.finale, settle, gate };
        }
        // S-39: the vidro's whisper, from where it stands
        if (banks.whisper) {
          const emitter = e.createEmitter('sfx', whisperAt);
          live.push(emitter);
          whisper = { buffer: banks.whisper, emitter };
        }
        // S-40: エリア1's shortcut settling, from its light
        if (banks.shortcut) {
          const emitter = e.createEmitter('sfx', shortcutAt);
          live.push(emitter);
          shortcutSound = { buffer: banks.shortcut, emitter };
        }
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
    // S-42: the sounds of the room's time slow and stand with it (the pause), and go on with it
    const scale = roomProbe.timeScale ?? 1;
    if (scale !== timeScale) {
      timeScale = scale;
      followTime(timed, scale, e.ctx.currentTime);
    }
    // and leaving play (タイトルへ) they fade out instead of going on over the dive back and the home
    if (!roomProbe.playing && timed.size > 0) {
      letTimeGo(timed, e.ctx.currentTime);
      timed.clear();
    }
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
    if (area1Ambience) {
      // S-36: エリア1's morning once it is in the scene and the body has come down into the town (past the slope's foot: not
      // from the slope's brow, where it starts being built), then on, as the workshop's once it played
      const st = roomProbe.area1?.state ?? 'waiting';
      const there = (st === 'warming' || st === 'ready') && roomProbe.position.z < SLOPE.toZ;
      if (!area1Ambience.playing && there && roomProbe.playing && e.ctx.state === 'running')
        area1Ambience.start(e.now());
      area1Ambience.update(e.ctx.currentTime);
    }
    // S-34: the settling light's sound follows its front across the bridge (and stays where the light stopped)
    if (lightRunning) followFront();
    // S-40: and エリア1's shortcut's along the ridge and down the stairs
    if (shortcutRunning) followShortcut();
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
    get finale(): FinaleSoundProbe {
      return {
        ready: finale !== null,
        played: [...finaleLog.played],
        refused: [...finaleLog.refused],
        voicesStarted: finaleLog.voices,
      };
    },
    get whisper(): WhisperSoundProbe {
      return {
        ready: whisper !== null,
        played: [...whisperLog.played],
        refused: [...whisperLog.refused],
        voicesStarted: whisperLog.voices,
      };
    },
    get shortcut(): ShortcutSoundProbe {
      return {
        ready: shortcutSound !== null,
        played: [...shortcutLog.played],
        refused: [...shortcutLog.refused],
        voicesStarted: shortcutLog.voices,
      };
    },
    get gates(): AreaGateSoundProbe {
      return {
        ready: gateEmitter !== null && finale !== null,
        played: [...gateLog.played],
        refused: [...gateLog.refused],
        voicesStarted: gateLog.voices,
      };
    },
    get time(): TimeSoundProbe {
      return { scale: timeScale, voices: timed.size };
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
        sources: [...(ambience?.sources ?? []), ...(area1Ambience?.sources ?? [])],
        levels: ambience?.levels() ?? { ...SILENT_LEVELS },
        places: [...ambienceSpots, ...area1Spots].map(({ spot, emitter }) => ({
          id: spot.id,
          kind: spot.kind,
          position: pannerPosition(emitter.input),
          panning: (emitter.input as PannerNode).panningModel,
        })),
        hits: [...(ambience?.hits ?? []), ...(area1Ambience?.hits ?? [])],
        draughts: ambience ? [...ambience.draughts] : [],
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
      offFinale?.();
      finale = null;
      offHints?.();
      offShortcut?.();
      offGates?.();
      gateEmitter = null;
      whisper = null;
      subscribed = false;
      stopListening();
      stopWaiting?.();
      loading.abort();
      // the ambience glides to silence (~20 ms) and lets go of its own nodes once that has run; the emitters fade too
      ambience?.dispose();
      area1Ambience?.dispose();
      for (const e of live) e.dispose();
      live.length = 0;
      ambienceSpots = [];
      area1Spots = [];
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
