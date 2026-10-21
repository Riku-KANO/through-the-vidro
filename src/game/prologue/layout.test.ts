import { describe, expect, it } from 'vitest';
import { FLOOR_MATERIALS } from '../../audio/footsteps';
import type { Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS } from '../../layers/materialize';
import { HAND_ORB_RADIUS, handOrbCenter, orbScreenCircle } from '../orb/hand-pose';
import { PEEK_FOV_DELTA_DEG } from '../orb/peek';
import { BODY_RADIUS, EYE_HEIGHT, FOV_DEFAULT, MAX_SLOPE_DEG } from '../player/constants';
import { LEDGE_DEFAULTS } from '../player/ledge';
import {
  BENCH_ORB,
  BRIDGE,
  BRIDGE_RISE,
  bridgeFooting,
  DROP,
  DROP_REACH,
  deckHeight,
  EDGE_Z,
  FACING_DEG,
  FAR,
  FLOOR_ZONES,
  floorAt,
  GATE,
  LIGHTHOUSE,
  lookDirection,
  PATH,
  PEDESTAL_BASE,
  PEDESTAL_ORB,
  PEDESTAL_RADIUS,
  REACH,
  SPAWNS,
  WORKSHOP_FLOOR_RADIUS,
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

describe('the bridge seen through the orb (体験の核 2: 行き止まりに見えた場所に、玉越しにだけ橋が架かっている)', () => {
  /** Where a world point lands relative to the fully raised hand orb (1 = on its rim), seen from eyeZ. */
  function inOrb(point: Vec3, pitch: number, eyeZ = deadEnd): number {
    const fov = FOV_DEFAULT + PEEK_FOV_DELTA_DEG;
    const aspect = 16 / 9;
    const tanY = Math.tan((fov * Math.PI) / 360);
    const dy = point[1] - EYE_HEIGHT;
    const dz = point[2] - eyeZ;
    const depth = Math.sin(pitch) * dy - Math.cos(pitch) * dz;
    const up = Math.cos(pitch) * dy + Math.sin(pitch) * dz;
    const sx = 0.5 + (0.5 * (point[0] / depth)) / (tanY * aspect);
    const sy = 0.5 - (0.5 * (up / depth)) / tanY;
    const c = orbScreenCircle(handOrbCenter(1, 1, 0), HAND_ORB_RADIUS, fov, aspect);
    return Math.hypot((sx - c.x) * aspect, sy - c.y) / c.r;
  }
  const mid = (BRIDGE.min[2] + BRIDGE.max[2]) / 2;

  it('peeking across the gap on the last steps to the edge (pitch −0.15), the middle of the deck is inside the orb', () => {
    // 2 m before the edge, where the edge, the pedestal and the gap are all in view (spawn 'dead-end')
    const approach = SPAWNS['dead-end'].feet[2];
    expect(inOrb([0, deckHeight(mid), mid], -0.15, approach)).toBeLessThan(0.85);
  });

  it('standing where the edge stops you, looking down across the gap (pitch −0.4), the deck is inside the orb', () => {
    // At −0.15 from there it would need a rise of ~0.8 m (slopes over 40°): see S-06.md.
    expect(inOrb([0, deckHeight(mid), mid], -0.4)).toBeLessThan(0.85);
  });

  it('the arch is gentle: its steepest part stays well inside the walkable slope', () => {
    let steepest = 0;
    for (let i = 0; i < 200; i++) {
      const z0 = BRIDGE.min[2] + ((BRIDGE.max[2] - BRIDGE.min[2]) * i) / 200;
      const z1 = z0 + (BRIDGE.max[2] - BRIDGE.min[2]) / 200;
      steepest = Math.max(steepest, Math.abs(deckHeight(z1) - deckHeight(z0)) / (z1 - z0));
    }
    expect((Math.atan(steepest) * 180) / Math.PI).toBeLessThan(MAX_SLOPE_DEG - 10);
    expect(BRIDGE_RISE).toBeGreaterThan(0);
    // level where it meets the shores (no step), highest in the middle
    expect(deckHeight(BRIDGE.max[2] - 0.01)).toBeLessThan(0.01);
    expect(deckHeight(BRIDGE.min[2] + 0.01)).toBeLessThan(0.01);
    expect(deckHeight(mid)).toBeCloseTo(BRIDGE_RISE, 6);
  });

  it('every footing segment covers the deck over its length (for 拾う前の安全確認)', () => {
    for (const seg of bridgeFooting()) {
      for (let i = 0; i <= 4; i++) {
        const z = seg.min[2] + ((seg.max[2] - seg.min[2]) * i) / 4;
        expect(deckHeight(z)).toBeLessThanOrEqual(seg.max[1] + 1e-9);
        expect(seg.max[1] - deckHeight(z)).toBeLessThan(0.25);
      }
    }
  });
});

describe('what each floor is made of (S-22: 足音は床の材質ごとに変える, as S-06 drew it)', () => {
  it('the workshop floor is frosted glass, up to the edge of the drawn disc and through the door', () => {
    expect(floorAt(...xz(SPAWNS.bench.feet))).toEqual({ zone: 'workshop', material: 'frosted' });
    expect(floorAt(0, 0).material).toBe('frosted');
    expect(floorAt(2.4, 1.5).material).toBe('frosted');
    // the disc lies over the start of the way: inside the door it is still glass
    expect(floorAt(0, -(WORKSHOP_FLOOR_RADIUS - 0.05)).material).toBe('frosted');
  });

  it('the one way and the far shore are 石畳; the bridge over the gap is frosted glass', () => {
    expect(floorAt(0, -(WORKSHOP_FLOOR_RADIUS + 0.2))).toEqual({ zone: 'path', material: 'stone' });
    expect(floorAt(...xz(SPAWNS.path.feet)).material).toBe('stone');
    expect(floorAt(...xz(SPAWNS['dead-end'].feet)).material).toBe('stone');
    expect(floorAt(...xz(PEDESTAL_BASE)).material).toBe('stone');
    const mid = (EDGE_Z + FAR.maxZ) / 2;
    expect(floorAt(0, mid)).toEqual({ zone: 'bridge', material: 'frosted' });
    expect(floorAt(0.25, EDGE_Z - 0.2).material).toBe('frosted');
    expect(floorAt(0, FAR.maxZ - 0.2)).toEqual({ zone: 'far', material: 'stone' });
    expect(floorAt(...xz(SPAWNS.far.feet)).material).toBe('stone');
  });

  it('every spawn and every footing segment of the bridge stands on a named floor', () => {
    for (const s of Object.values(SPAWNS)) expect(floorAt(...xz(s.feet)).zone).not.toBe('none');
    for (const seg of bridgeFooting()) {
      const z = (seg.min[2] + seg.max[2]) / 2;
      expect(floorAt(0, z).zone).toBe('bridge');
    }
  });

  it('names only materials that have footsteps, and never one that is not drawn underfoot (brass is not)', () => {
    for (const z of FLOOR_ZONES) expect(FLOOR_MATERIALS).toContain(z.material);
    expect(FLOOR_ZONES.map((z) => z.material)).not.toContain('brass');
  });

  it('somewhere it does not know (off every floor) still answers, with 石畳 — the town’s ground', () => {
    expect(floorAt(30, 30)).toEqual({ zone: 'none', material: 'stone' });
  });
});

function xz(p: Vec3): [number, number] {
  return [p[0], p[2]];
}
