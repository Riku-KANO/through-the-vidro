import { join } from 'node:path';
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { activeSegmentIds, type Sphere, type Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS } from '../../layers/materialize';
import { boxInsideSphere, SURFACE_SEGMENT, splitSurface } from '../../layers/surface';
import { type AssembledAsset, addAssetColliders, assembleAsset } from '../assets';
import { loadGlbInNode } from '../assets/node-glb.test-helper';
import { BODY_RADIUS } from '../player/constants';
import { createWorld, initPhysics } from '../player/physics';
import { PlayerController, type PlayerIntent } from '../player/player';
import type { PrologueEvent } from './events';
import {
  ANNEALER,
  BENCH,
  BRIDGE,
  bridgeFooting,
  DROP,
  deckHeight,
  EDGE_Z,
  FAR,
  FOOTING_SEGMENT,
  FURNACE,
  FURNACE_FACING,
  FURNACE_MOUTH,
  GATE,
  GRATE,
  MOUTH_PIPE_REACH,
  PEDESTAL_ID,
  PEDESTAL_ORB,
  SPAWNS,
  type SpawnName,
  TRIAL_SURFACE_WALL,
  WORKSHOP,
  WORKSHOP_ASSET,
  WORKSHOP_FLOOR_RADIUS,
  WORKSHOP_OBJECTS,
} from './layout';
import {
  addRoomColliders,
  BackFooting,
  deckSegmentShape,
  FallGuard,
  insideAnySphere,
  SurfaceColliders,
} from './physics';
import { PrologueSession } from './session';

/**
 * The prologue room in a real Rapier world (Node): the same colliders the scene builds (the room's own, and the
 * workshop's furniture from the committed glb, S-24), the S-03 body, and the S-02 back-layer footing switched by the
 * materialized sphere.
 */
let R: typeof RAPIER;
let workshop: AssembledAsset;
beforeAll(async () => {
  R = await initPhysics();
  workshop = assembleAsset((await loadGlbInNode(join(process.cwd(), 'public', WORKSHOP_ASSET))).scene);
});

const DT = 1 / 60;
/** Unit (x, z) from a point toward the centre of the dome (where the workshop's pieces open). */
const toCentre = (c: Vec3): [number, number] => {
  const l = Math.hypot(c[0], c[2]);
  return [-c[0] / l, -c[2] / l];
};
const forward: PlayerIntent = { move: { x: 0, y: 1 }, sprint: false, lookYaw: 0, lookPitch: 0 };
const fullSphere: Sphere = { center: PEDESTAL_ORB, radius: MAIN_ORB_RADIUS };

function room() {
  const world = createWorld();
  addRoomColliders(R, world);
  const furniture = addAssetColliders(R, world, workshop.colliders);
  const footing = new BackFooting(R, world, bridgeFooting(), deckSegmentShape);
  return { world, footing, furniture };
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
    const count = Math.round((BRIDGE.max[2] - BRIDGE.min[2]) / FOOTING_SEGMENT);
    expect(r.footing.segments.length).toBe(count);
    expect(r.footing.activeCount).toBe(0);
    const partial: Sphere = { center: PEDESTAL_ORB, radius: 1.6 };
    r.footing.sync([partial]);
    const expected = activeSegmentIds(r.footing.segments, [partial]);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(count);
    expect([...r.footing.activeIds]).toEqual(expected);
    expect(r.footing.activeCount).toBe(expected.length);
    r.footing.sync([fullSphere]);
    expect(r.footing.activeCount).toBe(count);
    r.footing.sync([]);
    expect(r.footing.activeCount).toBe(0);
  });

  it('a sphere shrinking after a pickup keeps its colliders but is no ground to step onto (the fence)', () => {
    const r = room();
    const mid = (BRIDGE.min[2] + BRIDGE.max[2]) / 2;
    const deck = r.footing.segments.find((seg) => seg.min[2] <= mid && seg.max[2] > mid);
    if (!deck) throw new Error('no segment under the middle of the bridge');
    const probeAt = (): boolean => {
      // a ray straight down onto the middle of the deck, asking the fence like the body does
      r.world.step(); // queries see enabled colliders after a step
      const hit = r.world.castRay(new R.Ray({ x: 0, y: 2, z: mid }, { x: 0, y: -1, z: 0 }), 4, true);
      return !!hit && r.footing.allowGround(0, 2 - hit.timeOfImpact, mid, hit.collider);
    };
    const placed = {
      center: PEDESTAL_ORB,
      radius: MAIN_ORB_RADIUS,
      materialize: { progress: 1, target: 1 as const },
    };
    r.footing.sync([placed]);
    expect(r.footing.activeIds).toContain(deck.id);
    expect(probeAt()).toBe(true);
    const shrinking = { ...placed, materialize: { progress: 0.9, target: 0 as const } };
    r.footing.sync([shrinking]);
    expect(r.footing.activeIds).toContain(deck.id); // the colliders stay until the sphere is gone
    expect(probeAt()).toBe(false); // but nobody new may step onto them
  });

  it('inside a sphere means inside the sphere, boundary included', () => {
    expect(insideAnySphere(0, 1, 0, [{ center: [0, 0, 0], radius: 1 }])).toBe(true);
    expect(insideAnySphere(0, 1.01, 0, [{ center: [0, 0, 0], radius: 1 }])).toBe(false);
    expect(insideAnySphere(0, 0, 0, [])).toBe(false);
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
    // over the gap the feet follow the arch, on the shores they stay at 0
    expect(s.every((q) => q.grounded && Math.abs(q.y - deckHeight(q.z)) < 0.05)).toBe(true);
    expect(Math.max(...s.map((q) => q.y))).toBeGreaterThan(0.3);
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
    expect(s.every((q) => q.grounded && Math.abs(q.y - deckHeight(q.z)) < 0.05)).toBe(true);
    expect(p.feet.z).toBeLessThan(EDGE_Z - 0.2);
    for (const q of s) {
      if (q.z < EDGE_Z) expect(insideAnySphere(q.x, q.y, q.z, [partial])).toBe(true);
    }
    // Soft, like any edge.
    expect(s.some((q) => q.speed > 0.2 && q.speed < 1.1)).toBe(true);
  });
});

describe('picking the vidro up never drops you into the valley (罰がない、落下死はない)', () => {
  it('right after a pickup from the shore, pushing toward the vanishing bridge keeps the body on the shore', () => {
    // Found in the parent review (S-06 P1): the shrinking sphere still counted as ground for the fence, so the
    // body could step onto the bridge while it vanished and fall forever.
    for (const start of [
      [0.2, 0, -13.67],
      [-0.1, 0, -13.7],
    ] as const) {
      for (const delay of [0, 3, 6]) {
        const r = room();
        const session = new PrologueSession({
          orbStart: 'hand',
          pedestals: { [PEDESTAL_ID]: PEDESTAL_ORB },
          footing: r.footing.segments,
          drop: DROP,
        });
        // exactly what the room does every frame: hand the session's spheres over as they are
        const tick = () => {
          session.step(DT, { wantPeek: false });
          r.footing.sync(session.spheres());
        };
        const feet: Vec3 = [start[0], start[1], start[2]];
        expect(session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, feet)).toBe('place');
        for (let i = 0; i < 60; i++) tick();
        const yaw = Math.atan2(-(PEDESTAL_ORB[0] - feet[0]), -(PEDESTAL_ORB[2] - feet[2]));
        const p = body(r, { feet, yaw });
        const strafe: PlayerIntent = { move: { x: 1, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 };
        const samples: { y: number; z: number; grounded: boolean }[] = [];
        const step = (intent: PlayerIntent) => {
          tick();
          r.world.step();
          p.update(DT, intent);
          const f = p.feet;
          samples.push({ y: f.y, z: f.z, grounded: p.grounded });
        };
        for (let i = 0; i < 10; i++) step({ ...strafe, move: { x: 0, y: 0 } });
        const f0 = p.feet;
        expect(session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, [f0.x, f0.y, f0.z])).toBe('pickup');
        for (let i = 0; i < delay; i++) step({ ...strafe, move: { x: 0, y: 0 } });
        for (let t = 0; t < 3; t += DT) step(strafe);
        for (const q of samples) {
          expect(q.grounded).toBe(true);
          expect(q.y).toBeGreaterThan(-0.05);
          expect(q.z).toBeGreaterThan(EDGE_Z - 0.05);
        }
      }
    }
  });

  it('the fall guard puts a body that fell below the walkways back where it last stood on solid ground', () => {
    const guard = new FallGuard();
    expect(guard.rescue([0, -2, -14])).toBeNull(); // nowhere known yet
    guard.observe([0, 0, -12], true, false);
    guard.observe([0, 0, -13.5], true, false);
    guard.observe([0, 0.1, -14.5], true, true); // standing on the bridge (back footing): not a safe place
    guard.observe([0, -0.5, -14.6], false, false); // in the air: not a safe place
    expect(guard.rescue([0, -0.5, -14.6])).toBeNull(); // still above the floor of the guard
    expect(guard.rescue([0, -1.2, -14.8])).toEqual([0, 0, -13.5]);
  });
});

describe('S-28: a surface-only wall inside the placed orb’s sphere (裏の層のルール: 表にしかない壁は消えて通れるようになる)', () => {
  const placed = {
    center: PEDESTAL_ORB,
    radius: MAIN_ORB_RADIUS,
    materialize: { progress: 1, target: 1 as const },
  };
  const wallSegments = () => splitSurface('trial-wall', TRIAL_SURFACE_WALL, SURFACE_SEGMENT);
  /** The dead end with the wall (?trial=surface-wall) on its lip; the orb placed (the bridge on) or not. */
  function deadEnd(orbPlaced: boolean) {
    const r = room();
    const wall = new SurfaceColliders(R, r.world, wallSegments());
    const spheres = orbPlaced ? [placed] : [];
    r.footing.sync(spheres);
    wall.sync(spheres);
    return { ...r, wall };
  }
  const towardBridge = { feet: [0.05, 0, EDGE_Z + 1.4] as Vec3, yaw: 0 };
  const wallMidZ = (TRIAL_SURFACE_WALL.min[2] + TRIAL_SURFACE_WALL.max[2]) / 2;
  const still: PlayerIntent = { ...forward, move: { x: 0, y: 0 } };
  const backward: PlayerIntent = { ...forward, move: { x: 0, y: -1 } };

  it('the whole wall is inside the sphere of the orb on the dead-end pedestal (it vanishes from view there)', () => {
    for (const seg of wallSegments()) expect(boxInsideSphere(seg, placed)).toBe(true);
  });

  it('before the orb is placed, the wall stops you short of the edge', () => {
    const r = deadEnd(false);
    const p = body(r, towardBridge);
    walk(r, p, forward, 4);
    expect(r.wall.cutCount).toBe(0);
    expect(p.feet.z).toBeGreaterThan(TRIAL_SURFACE_WALL.max[2] + BODY_RADIUS - 0.05);
  });

  it('with the orb placed the wall is gone in both senses (not drawn, no collider), and you walk onto the bridge', () => {
    const r = deadEnd(true);
    const p = body(r, towardBridge);
    walk(r, p, forward, 4);
    expect(r.wall.cutCount).toBe(wallSegments().length);
    expect(p.feet.z).toBeLessThan(EDGE_Z - 1);
  });

  it('once the orb is picked up (its sphere shrinking back), the wall is solid again', () => {
    const r = deadEnd(true);
    r.wall.sync([{ ...placed, materialize: { target: 0 as const } }]);
    expect(r.wall.cutCount).toBe(0);
    const p = body(r, towardBridge);
    walk(r, p, forward, 4);
    expect(p.feet.z).toBeGreaterThan(TRIAL_SURFACE_WALL.max[2]);
  });

  it('standing in the wall the pickup is refused (the orb trembles), the wall stays cut, and you walk out of it', () => {
    // what the room does: every frame the session's spheres go to the footing and the wall; E asks with the feet
    const r = room();
    const wall = new SurfaceColliders(R, r.world, wallSegments());
    const session = new PrologueSession({
      orbStart: 'hand',
      pedestals: { [PEDESTAL_ID]: PEDESTAL_ORB },
      footing: r.footing.segments,
      surface: wall.segments,
      drop: DROP,
    });
    const tick = () => {
      session.step(DT, { wantPeek: false });
      r.footing.sync(session.spheres());
      wall.sync(session.spheres());
    };
    expect(session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, SPAWNS['dead-end'].feet)).toBe('place');
    for (let i = 0; i < 60; i++) tick();
    expect(wall.cutCount).toBe(wall.segments.length);
    // in the wall, on the shore (not on the bridge's footing)
    const p = body(r, { feet: [0.05, 0, wallMidZ], yaw: 0 });
    const step = (intent: PlayerIntent) => {
      tick();
      r.world.step();
      p.update(DT, intent);
    };
    for (let i = 0; i < 20; i++) step(still);
    const f = p.feet;
    expect(f.z).toBeGreaterThan(EDGE_Z);
    expect(Math.abs(f.z - wallMidZ)).toBeLessThan(0.05);
    const events: PrologueEvent[] = [];
    session.events.on((e) => events.push(e));
    expect(session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, [f.x, f.y, f.z])).toBe('pickup-denied');
    expect(events).toEqual([{ type: 'shake', reason: 'pickup' }]);
    for (let i = 0; i < 30; i++) step(still);
    expect(wall.cutCount).toBe(wall.segments.length);
    // the body is not shut in: it walks back out of the wall, and from there the orb comes
    for (let t = 0; t < 1.5; t += DT) step(backward);
    const out = p.feet;
    expect(out.z).toBeGreaterThan(TRIAL_SURFACE_WALL.max[2] + BODY_RADIUS);
    expect(session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, [out.x, out.y, out.z])).toBe('pickup');
    tick();
    expect(wall.cutCount).toBe(0);
    p.dispose();
  });
});

describe('the workshop’s furniture (S-24: 当たり判定は見た目に正直に, from the glb’s _col)', () => {
  /** Steers the body through waypoints like a player would (turn toward the next point, walk). */
  function walkThrough(
    r: ReturnType<typeof room>,
    from: SpawnName,
    points: [number, number][],
    seconds: number,
  ) {
    const s = SPAWNS[from];
    const p = body(r, { feet: s.feet, yaw: s.yaw });
    const samples: { x: number; z: number; speed: number }[] = [];
    let next = 0;
    for (let t = 0; t < seconds && next < points.length; t += DT) {
      const target = points[next] as [number, number];
      const f = p.feet;
      if (Math.hypot(target[0] - f.x, target[1] - f.z) < 0.25) {
        next++;
        continue;
      }
      const yaw = Math.atan2(-(target[0] - f.x), -(target[1] - f.z));
      const turn = Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw));
      r.world.step();
      p.update(DT, { move: { x: 0, y: 1 }, sprint: false, lookYaw: turn, lookPitch: 0 });
      const v = p.velocity;
      samples.push({ x: p.feet.x, z: p.feet.z, speed: Math.hypot(v.x, v.z) });
    }
    return { reached: next, samples };
  }

  it('from where you wake, round the bench and out of the door onto the way, nothing is in the way', () => {
    const r = room();
    const route: [number, number][] = [
      [-0.15, -1.55],
      [0, -3.6],
      [0, -6],
    ];
    const w = walkThrough(r, 'bench', route, 12);
    expect(w.reached).toBe(route.length);
    // walking all along (no furniture to slide along): after the first second the pace holds
    const walking = w.samples.slice(60);
    expect(walking.filter((q) => q.speed < 1.1).length).toBeLessThan(walking.length * 0.08);
  });

  it('nothing stands on the floor under the skylight (天窓の下の中央は空ける)', () => {
    const r = room();
    r.world.step();
    const furniture = new Set(r.furniture.fixed.map((c) => c.handle));
    const hits: number[] = [];
    // a column as wide as the skylight, from just above the floor to above the head
    r.world.intersectionsWithShape(
      { x: 0, y: 1.0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      new R.Cylinder(0.9, WORKSHOP.oculus),
      (c) => {
        if (furniture.has(c.handle)) hits.push(c.handle);
        return true;
      },
    );
    expect(hits).toEqual([]);
  });

  /**
   * 空間の可読性と導線 4 (当たり判定は見た目に正直に), both ways, with horizontal rays at body heights from all around each
   * piece (off its symmetry lines: a ray exactly along a mesh edge can slip between its two triangles):
   *  - you cannot walk into what you see: where a ray meets the piece, it meets its collider no more than 5 cm later
   *  - no invisible wall: where it meets the collider, it meets the piece no more than 10 cm later. Not checked for the
   *    rays that go into a hollow the body cannot enter anyway (HOLLOWS, each with its reason: only those rays)
   */
  const facingAway = (dir: THREE.Vector3, facing: readonly [number, number], halfDeg: number): boolean =>
    -(dir.x * facing[0] + dir.z * facing[1]) > Math.cos((halfDeg * Math.PI) / 180);
  const HOLLOWS: Record<string, { why: string; skip(q: { h: number; dir: THREE.Vector3 }): boolean }> = {
    [WORKSHOP_OBJECTS.bench.name]: {
      why: 'under the bench top (the body is 1.75 m tall) and through its brass end frames',
      skip: (q) => q.h < BENCH.size[1] - 0.07,
    },
    [WORKSHOP_OBJECTS.annealer.name]: {
      why: 'into its arched mouth, which faces the centre of the room',
      skip: (q) =>
        q.h < ANNEALER.mouthHeight + 0.05 &&
        facingAway(q.dir, toCentre(ANNEALER.center), ANNEALER.mouthHalfDeg),
    },
    [WORKSHOP_OBJECTS.furnace.name]: {
      why: "straight into the furnace's mouth: a brass tube 0.34 m across, the fire at its back",
      skip: (q) => Math.abs(q.h - FURNACE_MOUTH[1]) < 0.25 && facingAway(q.dir, FURNACE_FACING, 20),
    },
  };
  function raysAround(piece: { name: string; at: readonly [number, number] }) {
    const r = room();
    r.world.step();
    const visual = workshop.layered.find((l) => l.object.userData.name === piece.name)?.object;
    const collider = r.furniture.byName.get(`${piece.name}_col`);
    if (!visual || !collider) throw new Error(`no ${piece.name} or its collider`);
    visual.updateWorldMatrix(true, true);
    const raycaster = new THREE.Raycaster();
    const out: { h: number; i: number; dir: THREE.Vector3; seen?: number; felt?: number }[] = [];
    for (const h of [0.25, 0.6, 1.0, 1.5]) {
      for (let i = 0; i < 24; i++) {
        const a = ((i + 0.37) / 24) * Math.PI * 2;
        const dir = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a));
        const origin = new THREE.Vector3(piece.at[0] + Math.cos(a) * 3, h, piece.at[1] + Math.sin(a) * 3);
        raycaster.set(origin, dir);
        raycaster.far = 6;
        const seen = raycaster.intersectObject(visual, true)[0]?.distance;
        const felt = r.world.castRay(
          new R.Ray(origin, dir),
          6,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          (c) => c === collider,
        )?.timeOfImpact;
        out.push({ h, i, dir, seen, felt });
      }
    }
    r.world.free();
    return out;
  }
  const pieces = Object.values(WORKSHOP_OBJECTS).filter((o) => o.col);

  it('every collider of the workshop’s file is checked both ways (S-30: also the furniture S-27 added)', () => {
    expect(new Set(pieces.map((p) => `${p.name}_col`))).toEqual(
      new Set(workshop.colliders.map((c) => c.name)),
    );
  });

  it('you cannot walk into what you see: a ray that meets a piece meets its collider first (or within 5 cm)', () => {
    const misses: string[] = [];
    for (const piece of pieces)
      for (const q of raysAround(piece))
        if (q.seen !== undefined && (q.felt === undefined || q.felt > q.seen + 0.05))
          misses.push(`${piece.name} h${q.h} a${q.i}: seen ${q.seen.toFixed(2)} felt ${q.felt?.toFixed(2)}`);
    expect(misses).toEqual([]);
  });

  it('no invisible wall: where a piece’s collider stops you, the piece is drawn within 10 cm (hollows the body cannot enter aside)', () => {
    const walls: string[] = [];
    let skipped = 0;
    for (const piece of pieces)
      for (const q of raysAround(piece)) {
        if (HOLLOWS[piece.name]?.skip(q)) {
          skipped++;
          continue;
        }
        if (q.felt !== undefined && (q.seen === undefined || q.seen > q.felt + 0.1))
          walls.push(`${piece.name} h${q.h} a${q.i}: felt ${q.felt.toFixed(2)} seen ${q.seen?.toFixed(2)}`);
      }
    expect(walls).toEqual([]);
    // the hollows are few rays of a few pieces, not whole pieces (of 8 pieces × 96 rays)
    expect(skipped).toBeLessThan(80);
  });

  it('walking at the fire, the body slides by the pipe left in the mouth and round the furnace, never through either', () => {
    const r = room();
    const p = body(r, 'furnace');
    const [fx, fz] = FURNACE_FACING;
    const [cx, , cz] = FURNACE.center;
    /** Distance in x/z from the pipe's axis (it runs from the mouth to MOUTH_PIPE_REACH, at hip height). */
    const offPipe = (x: number, z: number): number => {
      const along = Math.max(0.55, Math.min(MOUTH_PIPE_REACH, (x - cx) * fx + (z - cz) * fz));
      return Math.hypot(x - (cx + fx * along), z - (cz + fz * along));
    };
    const s = walk(r, p, forward, 5);
    const closest = Math.min(...s.map((q) => Math.hypot(q.x - cx, q.z - cz)));
    for (const q of s) expect(offPipe(q.x, q.z)).toBeGreaterThan(BODY_RADIUS - 0.02);
    // it got right up to the furnace (it was pushed toward it all along) but never into its bubbles (about 0.9 m out
    // at body height) — a round thing makes the body slide along it rather than come to rest
    expect(closest).toBeLessThan(GRATE.near + 0.5);
    expect(closest).toBeGreaterThan(1.0);
  });
});
