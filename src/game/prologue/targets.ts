import type { Vec3 } from '../../layers/footing';

/**
 * What 置く・拾う・調べる acts on (操作とカメラ > 入力の割り当て: one button for all three). Pure: the
 * scene lists what can be acted on right now; the one you look at most directly, within its reach and
 * within `maxAngleDeg` of the view direction, is the target. The design doc leaves reach and angle open
 * (仮 values in layout.ts).
 */
export interface TargetCandidate<T> {
  target: T;
  /** World point the player has to look at (e.g. where the orb sits on the pedestal). */
  point: Vec3;
  /** Metres from the eye. */
  reach: number;
}

/** @param forward unit view direction */
export function pickTarget<T>(
  eye: Vec3,
  forward: Vec3,
  candidates: readonly TargetCandidate<T>[],
  maxAngleDeg: number,
): T | null {
  const minCos = Math.cos((maxAngleDeg * Math.PI) / 180);
  let best: T | null = null;
  let bestCos = -2;
  for (const c of candidates) {
    const dx = c.point[0] - eye[0];
    const dy = c.point[1] - eye[1];
    const dz = c.point[2] - eye[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > c.reach) continue;
    const cos = d > 1e-6 ? (dx * forward[0] + dy * forward[1] + dz * forward[2]) / d : 1;
    if (cos < minCos || cos <= bestCos) continue;
    best = c.target;
    bestCos = cos;
  }
  return best;
}
