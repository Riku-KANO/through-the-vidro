import type { FootingSegment, Vec3 } from '../../layers/footing';
import { type SettleSweep, settledSegmentIds, sweepFront } from '../../layers/settle';
import { glassEase, stepTween, type Tween } from '../../layers/tween';
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
 * The prologue's game state (pure, no three.js or Rapier): where the vidro is, the peek, the hand, the
 * refusals and the light drop. It strings S-02's orb rules together for one room:
 *   作業台の玉を手にする → 覗く → 台座に置く (実体化) → 渡る → 光の雫に触れる
 *   → (S-34) 雫の光が橋を表に定着させ、門が開く → 橋を戻って玉を拾う → 門の先へ.
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
/** 仮 (S-34): how long the gate takes to swing open; it starts with the light (同時に向こう岸の門が開く). */
export const GATE_OPEN_SECONDS = 2.6;

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

export type InteractTarget = { kind: 'bench' } | { kind: 'pedestal'; id: string } | { kind: 'drop' };

export type InteractResult =
  | 'take'
  | 'place'
  | 'place-denied'
  | 'pickup'
  | 'pickup-denied'
  | 'touch-drop'
  | 'nothing';

export type OrbPlace = 'bench' | 'hand' | 'pedestal';
export type DropState = 'waiting' | 'flying' | 'taken';

export interface SessionOptions {
  /** Where the vidro starts: on the workbench (the prologue) or already in hand (dev spawns). */
  orbStart: 'bench' | 'hand';
  pedestals: Readonly<Record<string, Vec3>>;
  /** Back-layer footing, for 拾う前に足場の上にいないか (技術設計 > 裏の層の実装 > 安全). */
  footing: readonly FootingSegment[];
  /** Surface-only walls (S-28): a placed orb cuts them away, so 拾う前に壁の中にいないか too. */
  surface?: readonly FootingSegment[];
  /** Where the light drop hovers (it is back layer: touchable only inside a sphere). */
  drop: Vec3;
  /**
   * S-34: what the drop's light fixes onto the surface once it is taken (the bridge, layout.ts BRIDGE_SETTLE). Footing and
   * surface-only segments it has passed are no longer the orb's to hold: the pickup no longer asks about them.
   */
  settle?: SettleSweep;
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
const NONE: readonly string[] = [];
const NONE_SEGMENTS: readonly FootingSegment[] = [];

export class PrologueSession {
  readonly events = new EventBus<PrologueEvent>();
  /** S-34: the close (FinaleEvent), apart from `events`. */
  readonly finaleEvents = new EventBus<FinaleEvent>();

  private orbsValue: readonly Orb[] = createOrbs(0);
  private onBench: boolean;
  private peekState: PeekState = { progress: 0, peeking: false };
  private hand: Tween;
  private shakeLeft = 0;
  private dropValue: DropState = 'waiting';
  private dropElapsed = 0;
  private sphereCache: { orbs: readonly Orb[]; spheres: OrbSphere[] } | null = null;
  /** S-34: seconds since the drop was taken (null before). */
  private finaleAt: number | null = null;
  private settledCache: { front: number; footing: string[]; surface: string[] } | null = null;

  constructor(readonly options: SessionOptions) {
    this.onBench = options.orbStart === 'bench';
    this.hand = this.onBench ? { progress: 0, target: 0 } : { progress: 1, target: 1 };
  }

  get orbs(): readonly Orb[] {
    return this.orbsValue;
  }

  get orbPlace(): OrbPlace {
    if (this.onBench) return 'bench';
    return this.pedestal === null ? 'hand' : 'pedestal';
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

  get dropState(): DropState {
    return this.dropValue;
  }

  /** 0..1 along the drop's flight into the orb. */
  get dropProgress(): number {
    if (this.dropValue === 'taken') return 1;
    return this.dropValue === 'flying' ? Math.min(1, this.dropElapsed / DROP_FLIGHT_SECONDS) : 0;
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
        spheres: orbSpheres(this.orbsValue, this.options.pedestals),
      };
    }
    return this.sphereCache.spheres;
  }

  /** S-34: 0..1, linear in time since the drop was taken: the light across the bridge (SETTLE_SECONDS). */
  get settleProgress(): number {
    return this.finaleAt === null ? 0 : progressOf(this.finaleAt, SETTLE_SECONDS);
  }

  /** S-34: 0..1, linear in time since the drop was taken: the gate's opening (GATE_OPEN_SECONDS). */
  get gateProgress(): number {
    return this.finaleAt === null ? 0 : progressOf(this.finaleAt, GATE_OPEN_SECONDS);
  }

  /** S-34: seconds since the drop was taken, or null before. */
  get finaleElapsed(): number | null {
    return this.finaleAt;
  }

  /** S-34: where the light's front stands along the sweep (settle.ts), or null before the drop is taken / with no sweep. */
  get settleFront(): number | null {
    const sweep = this.options.settle;
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

  private settled(): { footing: string[]; surface: string[] } | null {
    const sweep = this.options.settle;
    const front = this.settleFront;
    if (!sweep || front === null) return null;
    if (this.settledCache?.front !== front) {
      this.settledCache = {
        front,
        footing: settledSegmentIds(this.options.footing, sweep, front),
        surface: settledSegmentIds(this.options.surface ?? NONE_SEGMENTS, sweep, front),
      };
    }
    return this.settledCache;
  }

  /**
   * Dev holds (the room's ?finaleHold): as if the orb had been set on its pedestal, the drop taken and the close played
   * through. No events; the room draws the moment it holds.
   */
  jumpToFinale(): void {
    this.dropValue = 'taken';
    this.dropElapsed = DROP_FLIGHT_SECONDS;
    this.finaleAt = Math.max(SETTLE_SECONDS, GATE_OPEN_SECONDS);
  }

  /** The light drop is real (inside a sphere) and can be touched. */
  dropMaterialized(): boolean {
    const [x, y, z] = this.options.drop;
    return this.spheres().some(
      (s) => Math.hypot(x - s.center[0], y - s.center[1], z - s.center[2]) <= s.radius,
    );
  }

  step(dt: number, input: { wantPeek: boolean }): void {
    const was = this.peekState.peeking;
    this.peekState = stepPeek(this.peekState, { wantPeek: input.wantPeek, allowed: this.canPeek }, dt);
    if (this.peekState.peeking !== was)
      this.events.emit({ type: this.peekState.peeking ? 'peekStart' : 'peekEnd' });
    this.orbsValue = stepOrbs(this.orbsValue, dt);
    this.hand = stepTween(this.hand, dt, HAND_SECONDS);
    this.shakeLeft = Math.max(0, this.shakeLeft - dt);
    if (this.finaleAt !== null) this.stepFinale(dt);
    if (this.dropValue === 'flying') {
      this.dropElapsed += dt;
      if (this.dropElapsed >= DROP_FLIGHT_SECONDS - 1e-9) {
        this.dropValue = 'taken';
        this.events.emit({ type: 'dropTaken' });
        // S-34: 雫の光で橋が表に定着し、同時に門が開く
        this.finaleAt = 0;
        this.finaleEvents.emit({ type: 'settle' });
        this.finaleEvents.emit({ type: 'gateOpen' });
      }
    }
  }

  private stepFinale(dt: number): void {
    const was = this.finaleAt ?? 0;
    const now = was + dt;
    this.finaleAt = now;
    // once each, when the time crosses its end (within float noise, like stepTween)
    const crossed = (end: number): boolean => was < end - 1e-9 && now >= end - 1e-9;
    if (crossed(SETTLE_SECONDS)) this.finaleEvents.emit({ type: 'settled' });
    if (crossed(GATE_OPEN_SECONDS)) this.finaleEvents.emit({ type: 'gateOpened' });
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
      case 'drop':
        if (this.dropValue !== 'waiting' || !this.dropMaterialized()) return 'nothing';
        this.dropValue = 'flying';
        this.dropElapsed = 0;
        this.events.emit({ type: 'dropTouched' });
        return 'touch-drop';
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
    const surface = unsettled(this.options.surface ?? NONE_SEGMENTS, settled?.surface);
    const ctx = {
      pedestals: this.options.pedestals,
      footing: unsettled(this.options.footing, settled?.footing),
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
