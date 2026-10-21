import * as THREE from 'three/webgpu';
import { EYE_HEIGHT } from '../player/constants';
import { lookDirection, SPAWNS } from './layout';

/**
 * ホーム → ゲーム開始 (トランジション設計 > 遷移の一覧): the game camera's way from the miniature view
 * of the town inside the home orb, down through the workshop's skylight, to standing in front of the
 * workbench (目の高さ1.6m) — exactly the pose the player starts from, so the hand-over is invisible.
 *
 * Catmull-Rom through five keys, sampled by `getPoint` (even per key): the skylight is crossed between
 * the third and fourth key at u ≈ 0.62, the moment the home camera passes through the orb's surface
 * (ui/home/choreography DIVE.crossAt), so the two crossings are one.
 */
export interface DivePath {
  /** u = 0: the miniature view, u = 1: standing at the bench. */
  pose(u: number, outPos: THREE.Vector3, outTarget: THREE.Vector3): void;
  /** The point the miniature view turns around when the home orb tilts. */
  pivot: THREE.Vector3;
}

export function createDivePath(): DivePath {
  const s = SPAWNS.bench;
  const eye = new THREE.Vector3(s.feet[0], s.feet[1] + EYE_HEIGHT, s.feet[2]);
  const look = new THREE.Vector3(...lookDirection(s.yaw, s.pitch));
  const positions = new THREE.CatmullRomCurve3(
    [
      // high above and behind the workshop, the town and its lighthouse across the valley
      new THREE.Vector3(12, 32, 40),
      new THREE.Vector3(4, 17, 18),
      // over the skylight, then just under it
      new THREE.Vector3(0.25, 5.6, 0.3),
      new THREE.Vector3(-0.75, 2.5, -0.35),
      eye,
    ],
    false,
    'centripetal',
  );
  const targets = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(2, 4, -68),
      new THREE.Vector3(1, 0, -30),
      new THREE.Vector3(-0.3, 0.2, -6),
      new THREE.Vector3(-1.4, 0.8, -3.2),
      eye.clone().add(look),
    ],
    false,
    'centripetal',
  );
  return {
    pose(u, outPos, outTarget) {
      const t = Math.min(1, Math.max(0, u));
      positions.getPoint(t, outPos);
      targets.getPoint(t, outTarget);
    },
    pivot: new THREE.Vector3(0, 0, -40),
  };
}
