import { glassEase, stepTween, type Tween } from './tween';

/** コアメカニクス > 裏の層のルール: 実体化の範囲は半径4m(主玉). */
export const MAIN_ORB_RADIUS = 4;
/** コアメカニクス > ガラス玉の性質の成長: 小玉(実体化半径2m)。最大2個. */
export const SMALL_ORB_RADIUS = 2;
/** 技術設計 > 裏の層の実装: 置かれた玉の位置と半径(最大3つ: 主玉＋小玉2). */
export const MAX_SPHERES = 3;
/** トランジション設計 > 玉を置く(実体化): 0.8秒. */
export const MATERIALIZE_SECONDS = 0.8;

/** Materialization of one placed orb. progress 0 = nothing, 1 = full radius. */
export type Materialization = Tween;

export function placeOrb(m: Materialization): Materialization {
  return { progress: m.progress, target: 1 };
}

/** Picking up plays the growth backwards from wherever it is. */
export function pickUpOrb(m: Materialization): Materialization {
  return { progress: m.progress, target: 0 };
}

export function stepMaterialization(m: Materialization, dt: number): Materialization {
  return stepTween(m, dt, MATERIALIZE_SECONDS);
}

export function materializedRadius(m: Materialization, maxRadius: number): number {
  return maxRadius * glassEase(m.progress);
}

/**
 * Brightness of the boundary film: the wavefront flashes while it travels and settles to a
 * calm glow once the sphere is full (玉から光の波紋が球状に広がり、波面が通過した所から…).
 * Picking up flashes the same way on the way back.
 */
export function boundaryGlow(m: Materialization): number {
  const p = m.progress;
  if (p <= 0) return 0;
  const calm = 0.45;
  const travelling = p < 1 || m.target === 0;
  if (!travelling) return calm;
  // bright while the front moves, easing into the calm level as it arrives
  const front = Math.sin(Math.PI * Math.min(1, p)) ** 0.5;
  return calm + 1.6 * front;
}
