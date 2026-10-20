import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { DIVE } from '../../ui/home/choreography';
import { EYE_HEIGHT } from '../player/constants';
import { createDivePath } from './dive-path';
import { LIGHTHOUSE, lookDirection, SPAWNS, WORKSHOP, WORKSHOP_TOP } from './layout';

/**
 * ホーム → ゲーム開始: the game camera travels from the miniature view of the town, down through the
 * workshop's skylight, to standing in front of the workbench — where the player takes over.
 */
const path = createDivePath();
const pos = new THREE.Vector3();
const target = new THREE.Vector3();

describe('the dive into the prologue (トランジション設計 > ホーム → ゲーム開始)', () => {
  it('ends exactly where the player stands: in front of the workbench, eye 1.6 m, looking at the bench', () => {
    path.pose(1, pos, target);
    const s = SPAWNS.bench;
    expect(pos.x).toBeCloseTo(s.feet[0], 6);
    expect(pos.y).toBeCloseTo(s.feet[1] + EYE_HEIGHT, 6);
    expect(pos.z).toBeCloseTo(s.feet[2], 6);
    const dir = target.clone().sub(pos).normalize();
    const want = lookDirection(s.yaw, s.pitch);
    expect(dir.x).toBeCloseTo(want[0], 6);
    expect(dir.y).toBeCloseTo(want[1], 6);
    expect(dir.z).toBeCloseTo(want[2], 6);
  });

  it('starts far above, looking over the workshop toward the town and its lighthouse', () => {
    path.pose(0, pos, target);
    expect(pos.y).toBeGreaterThan(30);
    expect(Math.hypot(pos.x, pos.z)).toBeGreaterThan(40);
    const toTown = new THREE.Vector3(...LIGHTHOUSE).sub(pos).normalize();
    const look = target.clone().sub(pos).normalize();
    expect(look.dot(toTown)).toBeGreaterThan(Math.cos(THREE.MathUtils.degToRad(20)));
  });

  it('passes through the skylight when the home camera passes through the orb surface', () => {
    let crossing = -1;
    let prevY = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 2000; i++) {
      const u = i / 2000;
      path.pose(u, pos, target);
      if (prevY >= WORKSHOP_TOP && pos.y < WORKSHOP_TOP) {
        crossing = u;
        expect(Math.hypot(pos.x, pos.z)).toBeLessThan(WORKSHOP.oculus * 0.8);
      }
      prevY = pos.y;
    }
    expect(crossing).toBeGreaterThan(DIVE.crossAt - 0.06);
    expect(crossing).toBeLessThan(DIVE.crossAt + 0.06);
  });

  it('stays inside the dome after the skylight (never through its glass)', () => {
    // the glass starts at the skylight's rim (above it the dome is open)
    const rimY = WORKSHOP.sphereCenterY + Math.sqrt(WORKSHOP.radius ** 2 - WORKSHOP.oculus ** 2);
    let below = false;
    for (let i = 0; i <= 2000; i++) {
      path.pose(i / 2000, pos, target);
      below ||= pos.y < rimY;
      if (!below) continue;
      const wallR = Math.sqrt(WORKSHOP.radius ** 2 - (pos.y - WORKSHOP.sphereCenterY) ** 2);
      expect(Math.hypot(pos.x, pos.z)).toBeLessThan(wallR - 0.3);
    }
  });
});
