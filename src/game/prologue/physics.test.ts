import type RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { activeSegmentIds, type Sphere, splitFooting, type Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS } from '../../layers/materialize';
import { createWorld, initPhysics } from '../player/physics';
import { PlayerController, type PlayerIntent } from '../player/player';
import {
  BENCH,
  BRIDGE,
  EDGE_Z,
  FAR,
  FOOTING_SEGMENT,
  GATE,
  PEDESTAL_ORB,
  SPAWNS,
  type SpawnName,
  WORKSHOP_FLOOR_RADIUS,
} from './layout';
import { addRoomColliders, BackFooting, insideAnySphere } from './physics';

/**
 * The prologue room in a real Rapier world (Node): the same colliders the scene builds, the S-03 body,
 * and the S-02 back-layer footing switched by the materialized sphere.
 */
let R: typeof RAPIER;
beforeAll(async () => {
  R = await initPhysics();
});

const DT = 1 / 60;
const forward: PlayerIntent = { move: { x: 0, y: 1 }, sprint: false, lookYaw: 0, lookPitch: 0 };
const fullSphere: Sphere = { center: PEDESTAL_ORB, radius: MAIN_ORB_RADIUS };

function room() {
  const world = createWorld();
  addRoomColliders(R, world);
  const footing = new BackFooting(R, world, splitFooting('bridge', BRIDGE, FOOTING_SEGMENT));
  return { world, footing };
}

function body(r: ReturnType<typeof room>, at: SpawnName | { feet: Vec3; yaw: number }) {
  const s = typeof at === 'string' ? SPAWNS[at] : at;
  const [x, y, z] = s.feet;
  return new PlayerController(r.world, {
    feet: { x, y, z },
    yaw: s.yaw,
    allowGround: r.footing.allowGround,
    settings: { headBob: 0 },
  });
}

function walk(r: ReturnType<typeof room>, p: PlayerController, intent: PlayerIntent, seconds: number) {
  const out: { x: number; y: number; z: number; speed: number; grounded: boolean }[] = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    r.world.step();
    p.update(DT, intent);
    const f = p.feet;
    const v = p.velocity;
    out.push({ x: f.x, y: f.y, z: f.z, speed: Math.hypot(v.x, v.z), grounded: p.grounded });
  }
  return out;
}

describe('back-layer footing as Rapier colliders (技術設計 > 裏の層の実装 > 当たり判定)', () => {
  it('has one collider per segment, all off until a sphere overlaps them', () => {
    const r = room();
    expect(r.footing.segments.length).toBe(7);
    expect(r.footing.activeCount).toBe(0);
    const partial: Sphere = { center: PEDESTAL_ORB, radius: 1.6 };
    r.footing.sync([partial]);
    const expected = activeSegmentIds(r.footing.segments, [partial]);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(7);
    expect([...r.footing.activeIds]).toEqual(expected);
    expect(r.footing.activeCount).toBe(expected.length);
    r.footing.sync([fullSphere]);
    expect(r.footing.activeCount).toBe(7);
    r.footing.sync([]);
    expect(r.footing.activeCount).toBe(0);
  });

  it('inside a sphere means inside the sphere, boundary included', () => {
    expect(insideAnySphere([0, 1, 0], [{ center: [0, 0, 0], radius: 1 }])).toBe(true);
    expect(insideAnySphere([0, 1.01, 0], [{ center: [0, 0, 0], radius: 1 }])).toBe(false);
    expect(insideAnySphere([0, 0, 0], [])).toBe(false);
  });
});

describe('the one way (序章: 失敗のしようがない一本道)', () => {
  it('the dome keeps you in the workshop except through its door', () => {
    const r = room();
    const back = body(r, { feet: SPAWNS.bench.feet, yaw: Math.PI });
    walk(r, back, forward, 6);
    expect(Math.hypot(back.feet.x, back.feet.z)).toBeLessThan(WORKSHOP_FLOOR_RADIUS);
    expect(back.grounded).toBe(true);
    // Around the bench and out of the door onto the way.
    const out = body(r, { feet: [0, 0, -1], yaw: 0 });
    walk(r, out, forward, 5);
    expect(out.feet.z).toBeLessThan(-6);
    expect(Math.abs(out.feet.y)).toBeLessThan(0.03);
  });

  it('the workbench stands in the way (当たり判定は見た目に正直に)', () => {
    const r = room();
    const p = body(r, 'bench');
    walk(r, p, forward, 3);
    expect(p.feet.z).toBeGreaterThan(BENCH.center[2] + BENCH.size[2] / 2);
  });

  it('stops softly at the broken edge while the bridge is not there (崩れた床の先の谷)', () => {
    const r = room();
    const p = body(r, 'path');
    const s = walk(r, p, forward, 9);
    expect(s.every((q) => q.grounded && Math.abs(q.y) < 0.03)).toBe(true);
    expect(p.feet.z).toBeGreaterThan(EDGE_Z);
    expect(p.feet.z).toBeLessThan(EDGE_Z + 0.6);
    expect(s.at(-1)?.speed ?? 1).toBeLessThan(0.05);
  });

  it('with the bridge materialized, walks across without stopping and stops at the gate', () => {
    const r = room();
    r.footing.sync([fullSphere]);
    const p = body(r, { feet: [0, 0, EDGE_Z + 1.2], yaw: 0 });
    const s = walk(r, p, forward, 7);
    expect(s.every((q) => q.grounded && Math.abs(q.y) < 0.03)).toBe(true);
    // over the gap the walking speed holds (no seams caught between segments)
    const onBridge = s.filter((q) => q.z < BRIDGE.max[2] - 0.2 && q.z > BRIDGE.min[2] + 0.2);
    expect(onBridge.length).toBeGreaterThan(20);
    expect(Math.min(...onBridge.map((q) => q.speed))).toBeGreaterThan(1.25);
    expect(p.feet.z).toBeLessThan(FAR.maxZ - 2);
    expect(p.feet.z).toBeGreaterThan(GATE.z);
  });

  it('the invisible fence: on back footing the body never leaves the sphere (外へは踏み出せない)', () => {
    const r = room();
    // A sphere that reaches only part of the way across. Its boundary crosses the bridge at a slant, so on
    // the right-hand side of the deck the last active segment reaches ~0.3 m past the boundary.
    const partial: Sphere = { center: PEDESTAL_ORB, radius: 2.26 };
    r.footing.sync([partial]);
    expect(r.footing.activeCount).toBeGreaterThan(0);
    const p = body(r, { feet: [0.28, 0, EDGE_Z + 0.8], yaw: 0 });
    const s = walk(r, p, forward, 6);
    expect(s.every((q) => q.grounded && Math.abs(q.y) < 0.03)).toBe(true);
    expect(p.feet.z).toBeLessThan(EDGE_Z - 0.2);
    for (const q of s) {
      if (q.z < EDGE_Z) expect(insideAnySphere([q.x, q.y, q.z], [partial])).toBe(true);
    }
    // Soft, like any edge.
    expect(s.some((q) => q.speed > 0.2 && q.speed < 1.1)).toBe(true);
  });
});
