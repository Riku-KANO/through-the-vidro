import { glassEase, stepTween } from '../../layers/tween';

/** トランジション設計 > 覗く開始・終了: 0.25秒. */
export const PEEK_SECONDS = 0.25;
/** 操作とカメラ > カメラ: 覗いている間は視野角をわずかに狭め(-6度). */
export const PEEK_FOV_DELTA_DEG = -6;
/** コアメカニクス > 基本の動作: 覗いている間は移動速度50%. Exposed for S-03's player. */
export const PEEK_MOVE_SPEED_FACTOR = 0.5;

export interface PeekState {
  /** 0..1 linear in time; 1 = orb fully raised. */
  progress: number;
  /** The player is peeking: input held (or toggled on) and peeking is allowed. */
  peeking: boolean;
}

export interface PeekInput {
  /** Hold or toggle state from the input layer (S-03 decides which mode). */
  wantPeek: boolean;
  /** From rules.canPeek: false while the main orb is placed. */
  allowed: boolean;
}

export function stepPeek(s: PeekState, input: PeekInput, dt: number): PeekState {
  const peeking = input.wantPeek && input.allowed;
  const { progress } = stepTween({ progress: s.progress, target: peeking ? 1 : 0 }, dt, PEEK_SECONDS);
  return { progress, peeking };
}

/** Eased 0..1 used for the orb pose, refraction strength, FOV and blend. */
export function peekAmount(s: PeekState): number {
  return glassEase(s.progress);
}

export function peekFovOffset(amount: number): number {
  return amount > 0 ? PEEK_FOV_DELTA_DEG * amount : 0;
}

/** Multiplier for walking speed: 1 at rest, 0.5 at full peek, eased in between. */
export function peekMoveSpeedMultiplier(amount: number): number {
  return 1 + (PEEK_MOVE_SPEED_FACTOR - 1) * amount;
}
