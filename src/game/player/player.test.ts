import type RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { EYE_HEIGHT, PEEK_MODIFIER, SPRINT_SPEED, WALK_SPEED } from './constants';
import { LEDGE_DEFAULTS } from './ledge';
import { createWorld, initPhysics } from './physics';
import { PlayerController, type PlayerIntent } from './player';

/**
 * Behaviour of the character controller in a real Rapier world (Node, no browser).
 * The same checks run in the browser through tests/e2e/S-03-walk.spec.ts.
 */
let R: typeof RAPIER;
beforeAll(async () => {
  R = await initPhysics();
});

const DT = 1 / 60;
const forward: PlayerIntent = { move: { x: 0, y: 1 }, sprint: false, lookYaw: 0, lookPitch: 0 };
const still: PlayerIntent = { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 };

function floorWorld() {
  const world = createWorld();
  world.createCollider(R.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0));
  return world;
}

function run(player: PlayerController, world: RAPIER.World, intent: PlayerIntent, seconds: number) {
  const samples: { x: number; y: number; z: number; speed: number; grounded: boolean }[] = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    world.step();
    player.update(DT, intent);
    const f = player.feet;
    const v = player.velocity;
    samples.push({ x: f.x, y: f.y, z: f.z, speed: Math.hypot(v.x, v.z), grounded: player.grounded });
  }
  return samples;
}

describe('walking (操作とカメラ > カメラ)', () => {
  it('holding forward for 2 s walks about 2.8 m at eye height 1.6 m', () => {
    const world = floorWorld();
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 }, settings: { headBob: 0 } });
    run(player, world, forward, 2);
    run(player, world, still, 1);
    expect(-player.feet.z).toBeGreaterThan(2.6);
    expect(-player.feet.z).toBeLessThan(3.0);
    expect(player.grounded).toBe(true);
    expect(player.eye.y).toBeCloseTo(EYE_HEIGHT, 2);
  });

  it('walks at 1.4 m/s and sprints at 2.2 m/s', () => {
    const world = floorWorld();
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 } });
    const walk = run(player, world, forward, 1.5);
    expect(walk[walk.length - 1]?.speed).toBeCloseTo(WALK_SPEED, 2);
    const sprint = run(player, world, { ...forward, sprint: true }, 1.5);
    expect(sprint[sprint.length - 1]?.speed).toBeCloseTo(SPRINT_SPEED, 2);
  });

  it('peeking (S-02 modifier) halves the speed and narrows the view by 6 degrees', () => {
    const world = floorWorld();
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 }, settings: { fovDeg: 70 } });
    player.modifiers.set('peek', { ...PEEK_MODIFIER, weight: 1 });
    const s = run(player, world, forward, 1.5);
    expect(s[s.length - 1]?.speed).toBeCloseTo(WALK_SPEED * 0.5, 2);
    expect(player.fovDeg).toBeCloseTo(64, 6);
    player.modifiers.delete('peek');
    expect(player.fovDeg).toBeCloseTo(70, 6);
  });

  it('turns with look input and keeps the field of view inside 60..100', () => {
    const world = floorWorld();
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 }, settings: { fovDeg: 130 } });
    expect(player.fovDeg).toBe(100);
    run(player, world, { ...still, lookYaw: Math.PI / 2 }, DT);
    run(player, world, forward, 1);
    expect(player.feet.x).toBeLessThan(-0.8);
    expect(Math.abs(player.feet.z)).toBeLessThan(0.05);
  });
});

describe('ledges (コアメカニクス > 基本の動作: 落下死はない、縁ではやわらかく止まる)', () => {
  it('walking off a 1.2 m high platform stops softly at the edge', () => {
    const world = floorWorld();
    world.createCollider(R.ColliderDesc.cuboid(2, 0.6, 2).setTranslation(0, 0.6, 0));
    const player = new PlayerController(world, { feet: { x: 0, y: 1.2, z: 0 }, yaw: -Math.PI / 2 });
    const s = run(player, world, forward, 5);
    expect(s.every((p) => p.grounded && Math.abs(p.y - 1.2) < 0.03)).toBe(true);
    const end = s[s.length - 1];
    expect(end?.speed).toBeLessThan(0.05);
    expect(end?.x).toBeLessThan(2);
    expect(2 - (end?.x ?? 0)).toBeGreaterThan(LEDGE_DEFAULTS.margin - 0.05);
  });

  it('walking diagonally along an edge slides along it', () => {
    const world = floorWorld();
    world.createCollider(R.ColliderDesc.cuboid(2, 0.6, 6).setTranslation(0, 0.6, 0));
    // Facing -Z, pushing forward-right into the +X edge.
    const player = new PlayerController(world, { feet: { x: 1, y: 1.2, z: 4 } });
    const s = run(player, world, { ...forward, move: { x: Math.SQRT1_2, y: Math.SQRT1_2 } }, 4);
    expect(s.every((p) => p.grounded && p.x < 2)).toBe(true);
    expect(4 - (s[s.length - 1]?.z ?? 0)).toBeGreaterThan(2.5);
  });
});

describe('steps and slopes (段差は自動で上る)', () => {
  it('climbs stairs of 0.2 m risers onto a platform', () => {
    const world = floorWorld();
    for (let i = 0; i < 6; i++) {
      const h = 0.2 * (i + 1);
      world.createCollider(R.ColliderDesc.cuboid(1, h / 2, 0.2).setTranslation(0, h / 2, -2 - 0.4 * i - 0.2));
    }
    world.createCollider(R.ColliderDesc.cuboid(1, 0.6, 1.5).setTranslation(0, 0.6, -4.4 - 1.5));
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 } });
    const s = run(player, world, forward, 6);
    const end = s[s.length - 1];
    expect(end?.y).toBeCloseTo(1.2, 1);
    expect(end?.z).toBeLessThan(-4.4);
    expect(end?.grounded).toBe(true);
  });

  it('walks up a 20 degree ramp', () => {
    const world = floorWorld();
    const angle = (20 * Math.PI) / 180;
    const len = 4;
    const rot = { w: Math.cos(angle / 2), x: Math.sin(angle / 2), y: 0, z: 0 };
    world.createCollider(
      R.ColliderDesc.cuboid(1, 0.1, len / 2)
        .setRotation(rot)
        .setTranslation(0, (Math.sin(angle) * len) / 2 - 0.1, -2 - (Math.cos(angle) * len) / 2),
    );
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 } });
    const s = run(player, world, forward, 5);
    // The ramp tops out at 1.36 m and ends in a drop: the body climbs it and stops before the end.
    expect(Math.max(...s.map((p) => p.y))).toBeGreaterThan(1.1);
    expect(s.every((p) => p.grounded)).toBe(true);
  });

  it('does not climb a block taller than a step', () => {
    const world = floorWorld();
    world.createCollider(R.ColliderDesc.cuboid(2, 0.225, 1).setTranslation(0, 0.225, -2));
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 } });
    const s = run(player, world, forward, 2);
    expect(Math.max(...s.map((p) => p.y))).toBeLessThan(0.05);
  });
});

describe('round walls (空間の可読性 4: 丸い壁に沿って滑らかに流れる)', () => {
  it('flows around a round pillar without getting stuck', () => {
    const world = floorWorld();
    // Hit 30 degrees off centre: the push along the surface is 1.4 * sin(30°) = 0.7 m/s at first.
    world.createCollider(R.ColliderDesc.cylinder(1.5, 1.5).setTranslation(0.9, 1.5, -3));
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 } });
    const s = run(player, world, forward, 5);
    expect(s[s.length - 1]?.z).toBeLessThan(-4.5);
    expect(Math.min(...s.slice(30).map((p) => p.speed))).toBeGreaterThan(0.5);
  });

  it('slides along the inside of a curved wall', () => {
    const world = floorWorld();
    // A concave half ring (radius 4, centre at the origin), built as a triangle mesh like a level mesh would be.
    const segments = 48;
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = Math.PI + (Math.PI * i) / segments;
      vertices.push(Math.cos(a) * 4, 0, Math.sin(a) * 4, Math.cos(a) * 4, 2.5, Math.sin(a) * 4);
      if (i < segments) indices.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    world.createCollider(R.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices)));
    // Walk -Z: the wall is hit 30 degrees off its normal, then the body should glide along the curve.
    const player = new PlayerController(world, { feet: { x: -2, y: 0, z: -1 } });
    const s = run(player, world, forward, 4);
    const travelled = s.reduce(
      (acc, p, i) => (i === 0 ? 0 : acc + Math.hypot(p.x - (s[i - 1]?.x ?? 0), p.z - (s[i - 1]?.z ?? 0))),
      0,
    );
    expect(travelled).toBeGreaterThan(3.0);
    expect(s.every((p) => Math.hypot(p.x, p.z) < 4)).toBe(true);
    // No snagging on the mesh facets while there is still a sideways push.
    expect(Math.min(...s.slice(30, 180).map((p) => p.speed))).toBeGreaterThan(0.35);
  });
});

describe('head bob setting (3D酔い対策)', () => {
  it('keeps the eye perfectly level while walking when switched off', () => {
    const world = floorWorld();
    const player = new PlayerController(world, { feet: { x: 0, y: 0, z: 0 }, settings: { headBob: 0 } });
    const ys: number[] = [];
    for (let i = 0; i < 90; i++) {
      world.step();
      player.update(DT, forward);
      ys.push(player.eye.y);
    }
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-3);
  });
});
