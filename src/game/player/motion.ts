import {
  ACCEL_TAU,
  DECEL_TAU,
  EYE_FOLLOW_TAU,
  EYE_MAX_LAG,
  FOOTSTEP_LENGTH,
  FOV_DEFAULT,
  FOV_MAX,
  FOV_MIN,
  HEAD_BOB_AMPLITUDE,
  PITCH_LIMIT,
} from './constants';

/** Pure movement and camera math for the first-person body. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Horizontal velocity on the ground plane. */
export interface PlanarVelocity {
  x: number;
  z: number;
}

/**
 * Velocity the player asks for. `move.y` is forward, `move.x` is right, both in -1..1.
 * Yaw 0 looks down -Z like a three.js camera; positive yaw turns left.
 */
export function wishVelocity(move: Vec2, yaw: number, speed: number): PlanarVelocity {
  const len = Math.hypot(move.x, move.y);
  const k = len > 1 ? speed / len : speed;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    x: (move.y * -sin + move.x * cos) * k,
    z: (move.y * -cos + move.x * -sin) * k,
  };
}

/**
 * 短い慣性: exponential approach to the wished velocity. Frame-rate independent and never overshoots.
 * Letting go uses a slightly longer time constant so stopping glides a little.
 */
export function approachVelocity(
  current: PlanarVelocity,
  target: PlanarVelocity,
  dt: number,
  tauAccel = ACCEL_TAU,
  tauDecel = DECEL_TAU,
): PlanarVelocity {
  const stopping = target.x === 0 && target.z === 0;
  const k = 1 - Math.exp(-dt / (stopping ? tauDecel : tauAccel));
  return { x: current.x + (target.x - current.x) * k, z: current.z + (target.z - current.z) * k };
}

/**
 * A temporary change to how the body moves and sees, e.g. peeking (S-02).
 * `weight` 0..1 lets a transition blend it in; omitted means fully on.
 */
export interface MovementModifier {
  speedMultiplier?: number;
  fovOffsetDeg?: number;
  weight?: number;
}

export function combineModifiers(modifiers: Iterable<MovementModifier>): {
  speedMultiplier: number;
  fovOffsetDeg: number;
} {
  let speedMultiplier = 1;
  let fovOffsetDeg = 0;
  for (const m of modifiers) {
    const w = Math.min(1, Math.max(0, m.weight ?? 1));
    speedMultiplier *= 1 + ((m.speedMultiplier ?? 1) - 1) * w;
    fovOffsetDeg += (m.fovOffsetDeg ?? 0) * w;
  }
  return { speedMultiplier, fovOffsetDeg };
}

/** 視野角70度(設定で60〜100度). */
export function clampFov(deg: number): number {
  if (!Number.isFinite(deg)) return FOV_DEFAULT;
  return Math.min(FOV_MAX, Math.max(FOV_MIN, deg));
}

export function clampPitch(rad: number): number {
  return Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, rad));
}

/**
 * 歩行時の上下の揺れはごく弱く、設定でオフにできる.
 * `distance` is how far the body has walked, `speedRatio` its speed relative to walking (fades the bob
 * in and out), `strength` the setting (0 = off, 1 = default).
 */
export function headBobOffset(distance: number, speedRatio: number, strength: number): number {
  const s = Math.min(1, Math.max(0, strength)) * Math.min(1, Math.max(0, speedRatio));
  if (s === 0) return 0;
  // One dip per footstep.
  return -HEAD_BOB_AMPLITUDE * s * 0.5 * (1 - Math.cos((2 * Math.PI * distance) / FOOTSTEP_LENGTH));
}

/**
 * Footfalls by `distance` walked on the ground (S-22: 足音は歩幅に合わせて): one per stride, the first half a stride in —
 * at every dip of the walking bob above, so the step heard and the step felt agree. Pure; the moment a foot comes down
 * is when this count goes up.
 * Stride: the design doc gives none. FOOTSTEP_LENGTH (0.7 m) is the walking speed 1.4 m/s (操作とカメラ > カメラ) at
 * 2 steps a second, an ordinary cadence at that speed; peeking halves the speed (移動50%), so the steps come half as
 * often, and Shift (2.2 m/s) makes them about 3 a second.
 */
export function footfallsBy(distance: number, stride: number = FOOTSTEP_LENGTH): number {
  if (!(distance > 0) || !(stride > 0)) return 0;
  return Math.floor(distance / stride + 0.5);
}

/**
 * Eye height follows the body with a short ease so automatic steps do not jolt the view,
 * but never trails further than EYE_MAX_LAG behind.
 */
export function followEye(current: number, target: number, dt: number, tau = EYE_FOLLOW_TAU): number {
  const eased = current + (target - current) * (1 - Math.exp(-dt / tau));
  return Math.min(target + EYE_MAX_LAG, Math.max(target - EYE_MAX_LAG, eased));
}
