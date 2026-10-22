import type { FootingSegment, Vec3 } from '../../layers/footing';
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
 *   作業台の玉を手にする → 覗く → 台座に置く (実体化) → 渡る → 光の雫に触れる.
 * The scene feeds it the input and the player's feet, and draws what it says.
 */

/** 仮 (S-02): 玉が小さく震えて知らせる — how long the tremble lasts and how far it moves. */
export const SHAKE_SECONDS = 0.45;
export const SHAKE_AMPLITUDE = 0.012;
/** 仮 (S-02): the hand brings the orb into view (or lets it go) in the time a peek takes. */
export const HAND_SECONDS = PEEK_SECONDS;
/** 仮: the touched light drop flies into the orb (光の雫の数: 手の玉の中に光の粒として入っていく). */
export const DROP_FLIGHT_SECONDS = 1.2;

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

export class PrologueSession {
  readonly events = new EventBus<PrologueEvent>();

  private orbsValue: readonly Orb[] = createOrbs(0);
  private onBench: boolean;
  private peekState: PeekState = { progress: 0, peeking: false };
  private hand: Tween;
  private shakeLeft = 0;
  private dropValue: DropState = 'waiting';
  private dropElapsed = 0;
  private sphereCache: { orbs: readonly Orb[]; spheres: OrbSphere[] } | null = null;

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
    if (this.dropValue === 'flying') {
      this.dropElapsed += dt;
      if (this.dropElapsed >= DROP_FLIGHT_SECONDS - 1e-9) {
        this.dropValue = 'taken';
        this.events.emit({ type: 'dropTaken' });
      }
    }
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
    const surface = this.options.surface;
    const ctx = {
      pedestals: this.options.pedestals,
      footing: this.options.footing,
      surface: surface && surface.length > 0 ? { segments: surface, body: PICKUP_BODY } : undefined,
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
