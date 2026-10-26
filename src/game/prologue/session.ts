import type { FootingSegment, Vec3 } from '../../layers/footing';
import { countSettled, type SettleSweep, settledSegmentIds, sweepFront } from '../../layers/settle';
import { glassEase, stepTween, type Tween } from '../../layers/tween';
import {
  type AreaCount,
  type AreaDecl,
  type DropState,
  DropTally,
  footingOf,
  type PlacedDrop,
  pedestalsOf,
  type RoomDecl,
  surfaceOf,
} from '../area';
import { createOrbs, type Orb, type OrbSphere, orbSpheres, placeOn, stepOrbs, takeBack } from '../orb/orbs';
import {
  PEEK_FOV_DELTA_DEG,
  PEEK_MOVE_SPEED_FACTOR,
  PEEK_SECONDS,
  type PeekState,
  peekAmount,
  stepPeek,
} from '../orb/peek';
import { canPeek, canPickUp, canPlace, PICKUP_BODY } from '../orb/rules';
import type { MovementModifier } from '../player/motion';
import { EventBus, type PrologueEvent } from './events';

/**
 * The game's state (pure, no three.js or Rapier): where the vidro is, the peek, the hand, the refusals and the light drops.
 * It strings S-02's orb rules together for the rooms of the areas it is given (S-36, game/area: each room's pedestals, its
 * drop, its surface-only walls and back-layer footing), the prologue's first:
 *   作業台の玉を手にする → 覗く → 台座に置く (実体化) → 渡る → 光の雫に触れる
 *   → (S-34) 雫の光が橋を表に定着させ、門が開く → 橋を戻って玉を拾う → 門の先へ
 *   → (S-36) エリア1 部屋1: 置く → 崩れた壁を抜ける → 雫 → 壁の外で玉を拾う.
 * The scene feeds it the input and the player's feet, and draws what it says.
 */

/** 仮 (S-02): 玉が小さく震えて知らせる — how long the tremble lasts and how far it moves. */
export const SHAKE_SECONDS = 0.45;
export const SHAKE_AMPLITUDE = 0.012;
/** 仮 (S-02): the hand brings the orb into view (or lets it go) in the time a peek takes. */
export const HAND_SECONDS = PEEK_SECONDS;
/** 仮: the touched light drop flies into the orb (光の雫の数: 手の玉の中に光の粒として入っていく). */
export const DROP_FLIGHT_SECONDS = 1.2;
/**
 * 仮 (S-34, spine: 定着の見た目は1〜2秒): how long the drop's light takes to run across what it settles (the bridge), from the
 * moment the drop is taken. Its front moves on the game's one curve (glassEase, 遷移のルール5).
 */
export const SETTLE_SECONDS = 1.6;
/**
 * 発案者 2026-10-23: the gate starts to open when the light that runs across the bridge has reached the far shore, not the
 * moment the drop is taken (パズル設計 > 原則4: 解けた瞬間に、なぜそうなったかが光と音で見える). Seconds after the drop is taken.
 */
export const GATE_OPENS_AT_SECONDS = SETTLE_SECONDS;
/** 仮 (S-34): how long the gate takes to swing open, from GATE_OPENS_AT_SECONDS. */
export const GATE_OPEN_SECONDS = 2.6;
/** Seconds from the drop taken to the gate wide open: the whole close. */
export const FINALE_SECONDS = GATE_OPENS_AT_SECONDS + GATE_OPEN_SECONDS;

/**
 * 仮 (S-35): the film at the slope's entrance comes up (or goes) over this long as the vidro leaves the hand (or comes back),
 * and the vidro left behind takes this long to start calling and this long to fall quiet again (UI/UX設計: 0.2秒で現れ… —
 * slower here: it is the world, not a prompt).
 */
export const FILM_SECONDS = 0.5;
export const CALL_RISE_SECONDS = 0.4;
export const CALL_FALL_SECONDS = 1.2;

/**
 * S-35 玉の置き忘れ (発案者 2026-10-23: 玉を持たずに坂道へは出られない): does the film at the slope's entrance (at `membraneZ`) hold a
 * body whose feet are at `feetZ`? It holds whoever has not got the vidro in hand and comes from the far shore's side (z
 * greater than the film's): the body eases to a stop before it like at any edge. Someone already past it (a dev view) walks
 * on; with the vidro in hand there is nothing to it. S-36: only while the vidro is left behind the film (`orbZ`, where it
 * stands: on the bench or a pedestal on the workshop's side, z greater than the film's) — left on a pedestal down in the town
 * (エリア1), the way back to it is down the slope, and the film never shuts you off from it (原則3: 罰がない).
 */
export function membraneHolds(
  orb: OrbPlace,
  feetZ: number,
  membraneZ: number,
  orbZ: number = Number.POSITIVE_INFINITY,
): boolean {
  return orb !== 'hand' && orbZ > membraneZ && feetZ > membraneZ;
}

/**
 * S-35: the vidro left behind calls — glows faintly where it stands (そのとき台座の玉がかすかに光って知らせる) — once the film,
 * there once the gate has started to open, has held a body pushing on through it (`pushing`: walking toward the slope), and
 * for as long as that body stays within `callReach` of the film (`calling`: it was calling a moment ago) — so it is still
 * glowing when you let go and turn round to look for it. Stepping back from the film, or the vidro in hand, and it falls
 * quiet; just walking up to the film and standing there, it does not start.
 */
export function vidroCalls(
  orb: OrbPlace,
  feetZ: number,
  membrane: { z: number; callReach: number },
  gateOpening: boolean,
  pushing: boolean,
  calling = false,
  orbZ: number = Number.POSITIVE_INFINITY,
): boolean {
  return (
    (pushing || calling) &&
    gateOpening &&
    membraneHolds(orb, feetZ, membrane.z, orbZ) &&
    feetZ - membrane.z <= membrane.callReach
  );
}

/**
 * 仮 (S-39 玉のささやき): seconds between the first two whispers of the vidro left behind, while it keeps calling (繰り返すときは
 * 間を置く). Longer than the call takes to fade (CALL_FALL_SECONDS).
 */
export const WHISPER_GAP_SECONDS = 3.2;

/**
 * 仮 (S-39; 発案者の判断 2026-10-25: だんだん間を広げる): the gaps while it calls on — the first, then wider, the last one from
 * then on — so standing at the film it is heard again but does not nag.
 */
export const WHISPER_GAPS_SECONDS: readonly number[] = [WHISPER_GAP_SECONDS, 6, 12];

/**
 * 仮 (S-39; 発案者の判断 2026-10-25: 膜から離れて戻ると最初の間に戻る): once the vidro has stopped calling this long (counted from the
 * step it stops: you stepped away from the film), the gaps start again from the first. As long as the first gap, so a step back
 * and straight in again is not a new call: the gap since the last whisper still holds (a whisper is only due once that has passed).
 */
export const WHISPER_RESET_SECONDS = WHISPER_GAP_SECONDS;

/** S-39: the gap after the `count`-th whisper of this call (1: after the first; 0, none yet: the first gap). */
export function whisperGap(count: number): number {
  const last = WHISPER_GAPS_SECONDS.length - 1;
  return WHISPER_GAPS_SECONDS[Math.min(Math.max(count - 1, 0), last)] ?? WHISPER_GAP_SECONDS;
}

/**
 * S-39 玉のささやき (ヒント設計 2; 設計書 rev 49: 台座の玉がかすかに光り、小さく鳴って知らせる): is a whisper due now? The vidro
 * whispers the moment it starts calling (`calling`: vidroCalls, the call's own hysteresis), and while it keeps calling, again
 * each time `sinceLast` (seconds since its last whisper, null for none yet) reaches the gap — never sooner, also when the call
 * has stopped and started again in between.
 */
export function whisperDue(
  calling: boolean,
  sinceLast: number | null,
  gap: number = WHISPER_GAP_SECONDS,
): boolean {
  return calling && (sinceLast === null || sinceLast >= gap - 1e-9);
}

/**
 * S-39: the room's hints (ヒント設計), on their own bus: the vidro left behind whispering. Kept off the room's event log
 * (events.ts PrologueEvent, S-16's table of sounds) like the close's.
 */
export type HintEvent = { type: 'whisper' };

/**
 * The close of the prologue (S-34), on its own bus: the light starts across the bridge / is across, the gate starts to
 * open / is open. Kept off the room's event log (events.ts PrologueEvent), whose names are S-16's table of sounds.
 */
export type FinaleEvent =
  | { type: 'settle' }
  | { type: 'settled' }
  | { type: 'gateOpen' }
  | { type: 'gateOpened' };

/** 0..1 of a span of `seconds`, `elapsed` into it; exactly 1 at its end (within float noise of many small steps). */
export function progressOf(elapsed: number, seconds: number): number {
  if (elapsed >= seconds - 1e-9) return 1;
  return Math.max(0, elapsed / seconds);
}

/** Where the light's front stands along the sweep `elapsed` seconds after the drop was taken (eased, 遷移のルール5). */
export function finaleFront(sweep: SettleSweep, elapsed: number): number {
  return sweepFront(sweep, glassEase(progressOf(elapsed, SETTLE_SECONDS)));
}

/** What 置く・拾う・調べる act on. A drop without an id is the first room's (the prologue's). */
export type InteractTarget =
  | { kind: 'bench' }
  | { kind: 'pedestal'; id: string }
  | { kind: 'drop'; id?: string };

export type InteractResult =
  | 'take'
  | 'place'
  | 'place-denied'
  | 'pickup'
  | 'pickup-denied'
  | 'touch-drop'
  | 'nothing';

export type OrbPlace = 'bench' | 'hand' | 'pedestal';
export type { DropState };

export interface SessionOptions {
  /** Where the vidro starts: on the workbench (the prologue) or already in hand (dev spawns). */
  orbStart: 'bench' | 'hand';
  /**
   * S-36 エリアの仕組み: the areas played (game/area: rooms with their pedestals, drop, surface-only walls, back-layer footing
   * and settling). Without it, the one room the fields below describe (the prologue's room as it was given before S-36).
   */
  areas?: readonly AreaDecl[];
  pedestals?: Readonly<Record<string, Vec3>>;
  /** Back-layer footing, for 拾う前に足場の上にいないか (技術設計 > 裏の層の実装 > 安全). */
  footing?: readonly FootingSegment[];
  /** Surface-only walls (S-28): a placed orb cuts them away, so 拾う前に壁の中にいないか too. */
  surface?: readonly FootingSegment[];
  /** Where the light drop hovers (it is back layer: touchable only inside a sphere). */
  drop?: Vec3;
  /**
   * S-34: what the drop's light fixes onto the surface once it is taken (the bridge, layout.ts BRIDGE_SETTLE). Footing and
   * surface-only segments it has passed are no longer the orb's to hold: the pickup no longer asks about them.
   */
  settle?: SettleSweep;
  /** S-35: the film at the slope's entrance (layout.ts MEMBRANE): where it stands across the way, and the vidro's call. */
  membrane?: { z: number; callReach: number };
}

/** The one room the fields of SessionOptions describe (before S-36), as an area. */
function legacyAreas(o: SessionOptions): AreaDecl[] {
  const room: RoomDecl = {
    id: 'room',
    pedestals: Object.entries(o.pedestals ?? {}).map(([id, orb]) => ({
      id,
      base: [orb[0], 0, orb[2]] as Vec3,
      orb,
    })),
    ...(o.drop ? { drop: { id: 'drop', at: o.drop } } : {}),
    ...(o.settle ? { settle: o.settle } : {}),
  };
  return [{ id: 'room', rooms: [room] }];
}

/**
 * The peek as S-03's movement modifier: 移動速度50% and 視野角-6度, blended in by the peek amount (the same
 * numbers as S-02's peekMoveSpeedMultiplier / peekFovOffset, through the player's weighted modifier).
 */
export function peekModifier(amount: number): MovementModifier {
  return {
    speedMultiplier: PEEK_MOVE_SPEED_FACTOR,
    fovOffsetDeg: PEEK_FOV_DELTA_DEG,
    weight: Math.min(1, Math.max(0, amount)),
  };
}

const MAIN = 'main';

/** Does the time from `was` to `now` reach `at` (within float noise of many small steps)? */
function crosses(was: number, now: number, at: number): boolean {
  return was < at - 1e-9 && now >= at - 1e-9;
}
const NONE: readonly string[] = [];

export class PrologueSession {
  readonly events = new EventBus<PrologueEvent>();
  /** S-34: the close (FinaleEvent), apart from `events`. */
  readonly finaleEvents = new EventBus<FinaleEvent>();
  /** S-39: the hints (HintEvent: the vidro's whisper), apart from `events` and the close's. */
  readonly hintEvents = new EventBus<HintEvent>();

  /** S-36: the rooms played, and what the session asks of them all together. */
  readonly areas: readonly AreaDecl[];
  readonly pedestals: Readonly<Record<string, Vec3>>;
  readonly footing: readonly FootingSegment[];
  readonly surface: readonly FootingSegment[];
  /** S-34: the sweep of the room whose drop settles (at most one: S-40 makes them many), and that drop's id. */
  readonly settle: SettleSweep | null;
  private readonly settleDrop: string | null;
  private readonly drops: DropTally;
  private readonly countsOut: Record<string, AreaCount> = {};

  private orbsValue: readonly Orb[] = createOrbs(0);
  private onBench: boolean;
  private peekState: PeekState = { progress: 0, peeking: false };
  private hand: Tween;
  private shakeLeft = 0;
  private sphereCache: { orbs: readonly Orb[]; spheres: OrbSphere[] } | null = null;
  /** S-34: seconds since the drop was taken (null before). */
  private finaleAt: number | null = null;
  /** Dev hold (holdFinale): the close does not move on. */
  private finaleHeld = false;
  private settledCache: { front: number; footing: string[]; surface: string[] } | null = null;
  /** S-35: the film at the slope's entrance (up while the vidro is not in hand) and the left-behind vidro's call, linear. */
  private filmTween: Tween;
  private callValue = 0;
  private calling = false;
  private feetZ = Number.POSITIVE_INFINITY;
  private pushing = false;
  /** S-39: seconds since the vidro last whispered (null: not yet). */
  private sinceWhisper: number | null = null;
  /** S-39: whispers in this call (the gaps widen with it), and seconds since it stopped calling (back to the first gap). */
  private whispers = 0;
  private quietFor = 0;

  constructor(readonly options: SessionOptions) {
    const areas = options.areas ?? legacyAreas(options);
    this.areas = areas;
    this.pedestals = options.areas ? pedestalsOf(areas) : (options.pedestals ?? {});
    this.footing = options.areas ? footingOf(areas) : (options.footing ?? []);
    this.surface = options.areas ? surfaceOf(areas) : (options.surface ?? []);
    const settling = areas.flatMap((a) => a.rooms.filter((r) => r.settle));
    if (settling.length > 1)
      throw new Error(`PrologueSession: ${settling.length} rooms settle (one at most, S-40)`);
    this.settle = settling[0]?.settle ?? null;
    this.settleDrop = settling[0]?.drop?.id ?? null;
    this.drops = new DropTally(areas, DROP_FLIGHT_SECONDS);
    this.onBench = options.orbStart === 'bench';
    this.hand = this.onBench ? { progress: 0, target: 0 } : { progress: 1, target: 1 };
    this.filmTween = this.onBench ? { progress: 1, target: 1 } : { progress: 0, target: 0 };
  }

  /**
   * S-35: does the film at the slope's entrance hold a body whose feet are at `feetZ` now (membraneHolds)? Never without a
   * membrane in the options.
   */
  holdsAtMembrane(feetZ: number): boolean {
    const m = this.options.membrane;
    return !!m && membraneHolds(this.orbPlace, feetZ, m.z, this.orbZ);
  }

  /**
   * S-36: z of where the vidro stands while it is not in hand — on the bench (the workshop: north of everything), or its
   * pedestal's — so the film knows whether it was left behind it.
   */
  private get orbZ(): number {
    const at = this.pedestal;
    if (at === null) return Number.POSITIVE_INFINITY;
    return this.pedestals[at]?.[2] ?? Number.POSITIVE_INFINITY;
  }

  /**
   * S-35: 0..1, eased: how much the film shows — once the gate has started to open (its swing, eased like the leaves), while
   * the vidro is not in hand (FILM_SECONDS in and out).
   */
  get film(): number {
    if (!this.options.membrane) return 0;
    return glassEase(this.filmTween.progress) * glassEase(Math.min(1, this.gateProgress / 0.25));
  }

  /** S-35: 0..1, eased: the left-behind vidro calling (vidroCalls), rising over CALL_RISE_SECONDS and falling over CALL_FALL_SECONDS. */
  get call(): number {
    return glassEase(this.callValue);
  }

  get orbs(): readonly Orb[] {
    return this.orbsValue;
  }

  get orbPlace(): OrbPlace {
    if (this.onBench) return 'bench';
    return this.pedestal === null ? 'hand' : 'pedestal';
  }

  /** S-36: every drop of the areas, with its area and room, in declaration order. */
  get dropList(): readonly PlacedDrop[] {
    return this.drops.drops;
  }

  /** S-36: how many drops each area has and how many are taken (the same object each call, updated). */
  areaCounts(): Record<string, AreaCount> {
    return this.drops.counts(this.countsOut);
  }

  /** S-36: a drop's state (the first room's when no id is given). */
  dropStateOf(id?: string): DropState {
    const d = id ?? this.drops.first;
    return d === null ? 'waiting' : this.drops.state(d);
  }

  /** S-36: 0..1 along a drop's flight into the vidro. */
  dropProgressOf(id?: string): number {
    const d = id ?? this.drops.first;
    return d === null ? 0 : this.drops.progress(d);
  }

  /** The pedestal the vidro stands on, or null. */
  get pedestal(): string | null {
    return this.orbsValue.find((o) => o.id === MAIN)?.pedestal ?? null;
  }

  /** Eased 0..1: the orb pose, refraction, FOV and speed all follow this. */
  get peekAmount(): number {
    return peekAmount(this.peekState);
  }

  get peeking(): boolean {
    return this.peekState.peeking;
  }

  /** Eased 0..1: the orb in the hand (0 = hand empty). */
  get handPresence(): number {
    return glassEase(this.hand.progress);
  }

  /** 1 → 0 over a tremble, 0 when still. */
  get shake(): number {
    return this.shakeLeft / SHAKE_SECONDS;
  }

  /** The first room's drop (the prologue's). */
  get dropState(): DropState {
    return this.dropStateOf();
  }

  /** 0..1 along the first room's drop's flight into the orb. */
  get dropProgress(): number {
    return this.dropProgressOf();
  }

  /** 覗ける: the vidro is in hand (not on the bench, not placed). */
  get canPeek(): boolean {
    return !this.onBench && canPeek(this.orbsValue);
  }

  /** Spheres that materialize the back layer now (main orb first). Same array until the orbs change. */
  spheres(): readonly OrbSphere[] {
    if (this.sphereCache?.orbs !== this.orbsValue) {
      this.sphereCache = {
        orbs: this.orbsValue,
        spheres: orbSpheres(this.orbsValue, this.pedestals),
      };
    }
    return this.sphereCache.spheres;
  }

  /** S-34: 0..1, linear in time since the drop was taken: the light across the bridge (SETTLE_SECONDS). */
  get settleProgress(): number {
    return this.finaleAt === null ? 0 : progressOf(this.finaleAt, SETTLE_SECONDS);
  }

  /**
   * S-34: 0..1, linear in time: the gate's opening (GATE_OPEN_SECONDS), from when the light has reached the far shore
   * (GATE_OPENS_AT_SECONDS after the drop was taken).
   */
  get gateProgress(): number {
    return this.finaleAt === null ? 0 : progressOf(this.finaleAt - GATE_OPENS_AT_SECONDS, GATE_OPEN_SECONDS);
  }

  /** S-34: seconds since the drop was taken, or null before. */
  get finaleElapsed(): number | null {
    return this.finaleAt;
  }

  /** S-34: where the light's front stands along the sweep (settle.ts), or null before the drop is taken / with no sweep. */
  get settleFront(): number | null {
    const sweep = this.settle;
    return sweep && this.finaleAt !== null ? finaleFront(sweep, this.finaleAt) : null;
  }

  /** S-34: ids of the bridge's footing segments the light has fixed, in segment order (the same array until it moves). */
  settledFooting(): readonly string[] {
    return this.settled()?.footing ?? NONE;
  }

  /** S-34: ids of the surface-only segments the light has fixed as cut, in segment order. */
  settledSurface(): readonly string[] {
    return this.settled()?.surface ?? NONE;
  }

  /**
   * What the light has fixed. The light only moves on, so the same number of settled segments is the same set: the lists
   * are made again only when it grows (a few times while the light crosses, not every frame).
   */
  private settled(): { footing: string[]; surface: string[] } | null {
    const sweep = this.settle;
    const front = this.settleFront;
    if (!sweep || front === null) return null;
    const cache = this.settledCache;
    if (cache?.front === front) return cache;
    const footing = this.footing;
    const surface = this.surface;
    const nFooting = countSettled(footing, sweep, front);
    const nSurface = countSettled(surface, sweep, front);
    if (cache && cache.footing.length === nFooting && cache.surface.length === nSurface) {
      cache.front = front;
      return cache;
    }
    this.settledCache = {
      front,
      footing: settledSegmentIds(footing, sweep, front),
      surface: settledSegmentIds(surface, sweep, front),
    };
    return this.settledCache;
  }

  /**
   * Dev holds (the room's ?finaleHold): as if the drop had been taken `elapsed` seconds ago, and held there (the light, the
   * settled segments and the gate stop at that moment, for the drawing, the colliders and the pickup alike). No events.
   * The orb is the caller's to place.
   */
  holdFinale(elapsed: number): void {
    if (this.settleDrop !== null) this.drops.setTaken(this.settleDrop);
    this.finaleAt = Math.max(0, elapsed);
    this.finaleHeld = true;
  }

  /**
   * Dev holds (the room's ?area1Drop=taken): a drop as if taken long ago — no events, and (unlike holdFinale) not the close.
   */
  holdDropTaken(id: string): void {
    this.drops.setTaken(id);
  }

  /** A light drop (the first room's when no id is given) is real (inside a sphere) and can be touched. */
  dropMaterialized(id?: string): boolean {
    const d = this.drops.drop(id ?? this.drops.first ?? '');
    if (!d) return false;
    const [x, y, z] = d.at;
    return this.spheres().some(
      (s) => Math.hypot(x - s.center[0], y - s.center[1], z - s.center[2]) <= s.radius,
    );
  }

  /**
   * `feet`: where the player stands, `pushing`: whether they walk toward the slope (S-35: the film and the vidro's call);
   * without them the last known place counts (far from any film until one is given), and nobody is pushing.
   */
  step(dt: number, input: { wantPeek: boolean; feet?: Vec3; pushing?: boolean }): void {
    const was = this.peekState.peeking;
    this.peekState = stepPeek(this.peekState, { wantPeek: input.wantPeek, allowed: this.canPeek }, dt);
    if (this.peekState.peeking !== was)
      this.events.emit({ type: this.peekState.peeking ? 'peekStart' : 'peekEnd' });
    this.orbsValue = stepOrbs(this.orbsValue, dt);
    this.hand = stepTween(this.hand, dt, HAND_SECONDS);
    this.shakeLeft = Math.max(0, this.shakeLeft - dt);
    if (this.finaleAt !== null) this.stepFinale(dt);
    if (input.feet) this.feetZ = input.feet[2];
    this.pushing = input.pushing ?? false;
    this.stepMembrane(dt);
    for (const id of this.drops.step(dt)) {
      this.events.emit({ type: 'dropTaken' });
      // S-34: 雫の光が橋を渡って表に定着させ、向こう岸に届くと門が開く (stepFinale) — the settling room's drop only
      if (id === this.settleDrop && this.finaleAt === null) {
        this.finaleAt = 0;
        this.finaleEvents.emit({ type: 'settle' });
      }
    }
  }

  /** S-35: the film follows the hand (up while the vidro is elsewhere); the vidro calls while the film holds someone at it. */
  private stepMembrane(dt: number): void {
    const m = this.options.membrane;
    if (!m) return;
    // up while the vidro is left behind the film (S-36: not while it stands on a pedestal down in the town)
    const orbZ = this.orbZ;
    const away = this.orbPlace !== 'hand' && orbZ > m.z;
    this.filmTween.target = away ? 1 : 0;
    this.filmTween = stepTween(this.filmTween, dt, FILM_SECONDS);
    this.calling = vidroCalls(
      this.orbPlace,
      this.feetZ,
      m,
      this.gateProgress > 0,
      this.pushing,
      this.calling,
      orbZ,
    );
    this.callValue = this.calling
      ? Math.min(1, this.callValue + dt / CALL_RISE_SECONDS)
      : Math.max(0, this.callValue - dt / CALL_FALL_SECONDS);
    // S-39: and whispers as it starts calling, again the gaps apart (widening) while it calls on; stepped away a while, the
    // gaps start again from the first
    if (this.sinceWhisper !== null) this.sinceWhisper += dt;
    this.quietFor = this.calling ? 0 : this.quietFor + dt;
    if (this.quietFor >= WHISPER_RESET_SECONDS - 1e-9) this.whispers = 0;
    if (whisperDue(this.calling, this.sinceWhisper, whisperGap(this.whispers))) {
      this.sinceWhisper = 0;
      this.whispers += 1;
      this.hintEvents.emit({ type: 'whisper' });
    }
  }

  private stepFinale(dt: number): void {
    if (this.finaleHeld) return;
    const was = this.finaleAt ?? 0;
    const now = was + dt;
    this.finaleAt = now;
    // once each, when the time crosses its moment (within float noise, like stepTween): the light across, and with it
    // the gate starting to open; the gate open
    if (crosses(was, now, SETTLE_SECONDS)) this.finaleEvents.emit({ type: 'settled' });
    if (crosses(was, now, GATE_OPENS_AT_SECONDS)) this.finaleEvents.emit({ type: 'gateOpen' });
    if (crosses(was, now, FINALE_SECONDS)) this.finaleEvents.emit({ type: 'gateOpened' });
  }

  /** A peek was asked for while it is not possible. A placed orb trembles (置いている間は覗けない). */
  refusePeek(): void {
    if (this.pedestal === null) return;
    this.tremble('peek');
  }

  /** 置く・拾う・調べる on what the player looks at. `feet` is where the player stands. */
  interact(target: InteractTarget | null, feet: Vec3): InteractResult {
    if (!target) return 'nothing';
    switch (target.kind) {
      case 'bench':
        if (!this.onBench) return 'nothing';
        this.onBench = false;
        this.hand = { progress: this.hand.progress, target: 1 };
        this.events.emit({ type: 'pickup', from: 'bench' });
        return 'take';
      case 'pedestal':
        return this.atPedestal(target.id, feet);
      case 'drop': {
        const id = target.id ?? this.drops.first;
        if (id === null || this.drops.state(id) !== 'waiting' || !this.dropMaterialized(id)) return 'nothing';
        this.drops.touch(id);
        this.events.emit({ type: 'dropTouched' });
        return 'touch-drop';
      }
    }
  }

  private atPedestal(id: string, feet: Vec3): InteractResult {
    if (this.onBench) return 'nothing';
    const at = this.pedestal;
    if (at === null) {
      if (!canPlace(this.orbsValue, MAIN, id)) return 'place-denied';
      this.orbsValue = placeOn(this.orbsValue, MAIN, id);
      this.hand = { progress: this.hand.progress, target: 0 };
      this.events.emit({ type: 'place', pedestal: id });
      return 'place';
    }
    if (at !== id) return 'nothing';
    // S-34: what the drop's light has fixed is no longer this orb's to hold: on the settled bridge the orb comes (the
    // exception to 実体化した足場の上にいるときは回収できない), and a settled surface-only wall stays cut
    const settled = this.settled();
    const unsettled = (segments: readonly FootingSegment[], ids: readonly string[] | undefined) =>
      ids && ids.length > 0 ? segments.filter((seg) => !ids.includes(seg.id)) : segments;
    const surface = unsettled(this.surface, settled?.surface);
    const ctx = {
      pedestals: this.pedestals,
      footing: unsettled(this.footing, settled?.footing),
      surface: surface.length > 0 ? { segments: surface, body: PICKUP_BODY } : undefined,
      feet,
    };
    if (!canPickUp(this.orbsValue, MAIN, ctx)) {
      this.tremble('pickup');
      return 'pickup-denied';
    }
    this.orbsValue = takeBack(this.orbsValue, MAIN);
    this.hand = { progress: this.hand.progress, target: 1 };
    this.events.emit({ type: 'pickup', from: 'pedestal' });
    return 'pickup';
  }

  private tremble(reason: 'peek' | 'pickup'): void {
    this.shakeLeft = SHAKE_SECONDS;
    this.events.emit({ type: 'shake', reason });
  }
}
