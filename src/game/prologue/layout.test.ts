import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS } from '../../layers/materialize';
import { BODY_RADIUS, EYE_HEIGHT } from '../player/constants';
import { LEDGE_DEFAULTS } from '../player/ledge';
import {
  BENCH_ORB,
  BRIDGE,
  DROP,
  DROP_REACH,
  EDGE_Z,
  FACING_DEG,
  FAR,
  GATE,
  LIGHTHOUSE,
  lookDirection,
  PATH,
  PEDESTAL_BASE,
  PEDESTAL_ORB,
  PEDESTAL_RADIUS,
  REACH,
  SPAWNS,
} from './layout';

/** Level-design invariants of the prologue (パズル設計 > 原則, 空間の可読性と導線). */
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const eyeAt = (x: number, z: number): Vec3 => [x, EYE_HEIGHT, z];
const angleDeg = (from: Vec3, dir: Vec3, to: Vec3): number => {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(...d);
  const cos = (d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) / len;
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
};
/** Where the soft edge stops the body at the broken floor. */
const deadEnd = EDGE_Z + LEDGE_DEFAULTS.margin;

describe('the prologue layout', () => {
  it('the whole bridge materializes from the dead-end pedestal, so it can be crossed end to end', () => {
    for (const x of [BRIDGE.min[0], BRIDGE.max[0]])
      for (const z of [BRIDGE.min[2], BRIDGE.max[2]])
        expect(dist([x, BRIDGE.max[1], z], PEDESTAL_ORB)).toBeLessThan(MAIN_ORB_RADIUS - 0.1);
    // and it really spans the gap between the two shores
    expect(BRIDGE.max[2]).toBe(EDGE_Z);
    expect(BRIDGE.min[2]).toBe(FAR.maxZ);
  });

  it('the light drop is inside the sphere and can be touched from the far end of the bridge', () => {
    expect(dist(DROP, PEDESTAL_ORB)).toBeLessThan(MAIN_ORB_RADIUS - 0.3);
    expect(dist(DROP, eyeAt(0, BRIDGE.min[2] + 0.3))).toBeLessThan(DROP_REACH);
    // but not from the near shore: it has to be crossed to
    expect(dist(DROP, eyeAt(0, deadEnd))).toBeGreaterThan(DROP_REACH);
  });

  it('the pedestal is reachable at the dead end and from the first steps on the bridge', () => {
    expect(dist(PEDESTAL_ORB, eyeAt(0, deadEnd))).toBeLessThan(REACH);
    expect(dist(PEDESTAL_ORB, eyeAt(0, EDGE_Z - 0.5))).toBeLessThan(REACH);
    expect(dist(PEDESTAL_ORB, eyeAt(0, BRIDGE.min[2] + 0.3))).toBeGreaterThan(REACH);
  });

  it('the pedestal does not stand in the way onto the bridge', () => {
    const clear = BRIDGE.min[0] + BODY_RADIUS;
    expect(PEDESTAL_BASE[0] + PEDESTAL_RADIUS).toBeLessThan(clear);
    expect(PEDESTAL_BASE[0] - PEDESTAL_RADIUS).toBeGreaterThan(PATH.minX - 0.05);
  });

  it('the orb on the workbench is in reach and in view where the dive lands', () => {
    const s = SPAWNS.bench;
    const eye: Vec3 = [s.feet[0], EYE_HEIGHT, s.feet[2]];
    expect(dist(BENCH_ORB, eye)).toBeLessThan(REACH);
    expect(angleDeg(eye, lookDirection(s.yaw, s.pitch), BENCH_ORB)).toBeLessThan(FACING_DEG / 2);
  });

  it('the far shore has its reason (a closed gate) and the town lies on beyond it (ルール6, 9)', () => {
    expect(GATE.z).toBeLessThan(DROP[2]);
    expect(GATE.z).toBeGreaterThan(FAR.minZ);
    expect(GATE.halfWidth).toBeGreaterThanOrEqual(FAR.maxX);
    expect(LIGHTHOUSE[2]).toBeLessThan(GATE.z - 30);
    // the lighthouse is roughly straight ahead along the way
    expect(
      angleDeg(eyeAt(0, deadEnd), lookDirection(0, 0), [LIGHTHOUSE[0], EYE_HEIGHT, LIGHTHOUSE[2]]),
    ).toBeLessThan(15);
  });
});
