import type { Vec3 } from '../../layers/footing';

/**
 * Where the hand orb sits in view space (camera at the origin looking down -z).
 * 覗く: 手の玉が視界中央にせり上がり、玉越しの円が広がる (コアメカニクス > 基本の動作, トランジション設計).
 * Pure; the composite shader draws the orb from these numbers.
 */

/** 仮置き: the orb size is not in the design doc (a hand-held vidro, ~15 cm across). */
export const HAND_ORB_RADIUS = 0.075;
/** Held low in the right hand: only the top of the orb shows at the bottom of the view. */
const REST: Vec3 = [0.085, -0.255, -0.42];
/** Raised to the middle of the view and close to the eye, so the circle fills ~43 % of the height. */
const PEEK: Vec3 = [0, -0.01, -0.29];
/** How far the orb drops out of view when the hand is empty (玉を置いている間は手ぶら). */
const STOWED_DROP = 0.22;

/**
 * @param peek eased peek amount 0..1
 * @param presence 0 = hand empty, 1 = orb in hand (eased)
 * @param t seconds, for a barely visible idle sway (the orb is held, not glued to the screen)
 */
export function handOrbCenter(
  peek: number,
  presence: number,
  t: number,
  out: [number, number, number] = [0, 0, 0],
): Vec3 {
  const sway = 1 - 0.7 * peek;
  out[0] = REST[0] + (PEEK[0] - REST[0]) * peek + 0.0018 * Math.sin(t * 0.9) * sway;
  out[1] =
    REST[1] +
    (PEEK[1] - REST[1]) * peek -
    (1 - presence) * STOWED_DROP +
    0.0022 * Math.sin(t * 1.3 + 1) * sway;
  out[2] = REST[2] + (PEEK[2] - REST[2]) * peek;
  return out;
}

export interface ScreenCircle {
  /** Centre in normalized screen coordinates, origin top-left. */
  x: number;
  y: number;
  /** Radius as a fraction of the viewport height. */
  r: number;
}

/** Screen-space circle of a sphere in view space for a perspective camera. */
export function orbScreenCircle(
  center: Vec3,
  radius: number,
  fovDeg: number,
  aspect: number,
  out: ScreenCircle = { x: 0, y: 0, r: 0 },
): ScreenCircle {
  const tanY = Math.tan((fovDeg * Math.PI) / 360);
  const tanX = tanY * aspect;
  const depth = Math.max(1e-4, -center[2]);
  const dist2 = center[0] ** 2 + center[1] ** 2 + center[2] ** 2;
  const angular = radius / Math.sqrt(Math.max(1e-8, dist2 - radius * radius));
  out.x = 0.5 + (0.5 * (center[0] / depth)) / tanX;
  out.y = 0.5 - (0.5 * (center[1] / depth)) / tanY;
  out.r = (0.5 * angular) / tanY;
  return out;
}
