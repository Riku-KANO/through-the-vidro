import type RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS, MATERIALIZE_SECONDS } from '../../layers/materialize';
import { surfaceSegments } from '../area';
import { BODY_RADIUS } from '../player/constants';
import { createWorld, initPhysics } from '../player/physics';
import { PlayerController, type PlayerIntent } from '../player/player';
import { bridgeFooting, PLAZA, PLAZA_Y, PROLOGUE_AREA } from '../prologue/layout';
import { addRoomColliders, BackFooting, deckSegmentShape, SurfaceColliders } from '../prologue/physics';
import { PrologueSession } from '../prologue/session';
import {
  AREA1,
  AREA1_GATE,
  AREA1_PLAZA,
  AREA1_RIM,
  AREA1_ROAD,
  AREA1_SLOPE,
  AREA1_STREET,
  AREA1_Y,
  area1SlopeHeight,
  ROOM1_ALLEY,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
} from './layout';
import { addArea1Colliders } from './physics';

/**
 * S-36: エリア1's way in and its first room in a real Rapier world (Node): the prologue's colliders (the town, its road), エリア1's
 * (built behind the scenes while you are in the central plaza), the surface-only wall of 部屋1, and the S-03 body.
 */
let R: typeof RAPIER;
beforeAll(async () => {
  R = await initPhysics();
});

const DT = 1 / 60;
const forward: PlayerIntent = { move: { x: 0, y: 1 }, sprint: false, lookYaw: 0, lookPitch: 0 };
const sprint: PlayerIntent = { ...forward, sprint: true };
const strafeLeft: PlayerIntent = { ...forward, move: { x: -1, y: 0 } };
const strafeRight: PlayerIntent = { ...forward, move: { x: 1, y: 0 } };
/** Yaw that looks along (dx, dz) (S-03: 0 looks down −Z, positive turns left). */
const yawToward = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

function world(area1 = true) {
  const w = createWorld();
  addRoomColliders(R, w);
  const footing = new BackFooting(R, w, bridgeFooting(), deckSegmentShape);
  const built = area1 ? addArea1Colliders(R, w) : null;
  const wall = area1 ? new SurfaceColliders(R, w, surfaceSegments(ROOM1_WALL)) : null;
  return { world: w, footing, built, wall };
}

function body(r: ReturnType<typeof world>, feet: Vec3, yaw: number): PlayerController {
  return new PlayerController(r.world, {
    feet: { x: feet[0], y: feet[1], z: feet[2] },
    yaw,
    allowGround: r.footing.allowGround,
    settings: { headBob: 0 },
  });
}

function walk(r: ReturnType<typeof world>, p: PlayerController, intent: PlayerIntent, seconds: number) {
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

describe('S-36: from the central plaza’s east gate along the road into エリア1', () => {
  it('the road takes the body from the gate to the entrance plaza (about 60 m), level, never falling', () => {
    const r = world();
    const p = body(r, [AREA1_ROAD.fromX - 2, PLAZA_Y, AREA1_ROAD.z], yawToward(1, 0));
    const s = walk(r, p, sprint, (AREA1_ROAD.toX - AREA1_ROAD.fromX + 8) / 2.2);
    expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
    expect(p.feet.x).toBeGreaterThan(AREA1_ROAD.toX + 3);
    expect(Math.abs(p.feet.z - AREA1_ROAD.z)).toBeLessThan(0.1);
  });

  it('its railings hold the body on both sides all along it (no fall)', () => {
    for (const x of [AREA1_ROAD.fromX + 3, (AREA1_ROAD.fromX + AREA1_ROAD.toX) / 2, AREA1_ROAD.toX - 3]) {
      for (const intent of [strafeLeft, strafeRight]) {
        const r = world();
        const p = body(r, [x, PLAZA_Y, AREA1_ROAD.z], yawToward(1, 0));
        const s = walk(r, p, intent, 3);
        expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
        expect(Math.abs(p.feet.z - AREA1_ROAD.z), `at x ${x}`).toBeLessThan(
          AREA1_ROAD.halfWidth - BODY_RADIUS,
        );
        expect(s.at(-1)?.speed ?? 1).toBeLessThan(0.05);
      }
    }
  });

  it('before エリア1 is built, the body eases to a stop at the road’s end (落下死はない), never past it', () => {
    const r = world(false);
    const p = body(r, [AREA1_ROAD.toX - 6, PLAZA_Y, AREA1_ROAD.z], yawToward(1, 0));
    const s = walk(r, p, forward, 8);
    expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
    expect(p.feet.x).toBeLessThan(AREA1_ROAD.toX + 0.6);
    expect(p.feet.x).toBeGreaterThan(AREA1_ROAD.toX - 1.2);
    expect(s.at(-1)?.speed ?? 1).toBeLessThan(0.05);
  });

  it('built while the body stands on the road, it does not shove the body (nothing of it stands on the road)', () => {
    const r = world(false);
    const p = body(r, [AREA1_ROAD.toX - 0.4, PLAZA_Y, AREA1_ROAD.z], yawToward(1, 0));
    walk(r, p, { ...forward, move: { x: 0, y: 0 } }, 0.5);
    const before = p.feet;
    addArea1Colliders(R, r.world);
    walk(r, p, { ...forward, move: { x: 0, y: 0 } }, 0.5);
    expect(Math.hypot(p.feet.x - before.x, p.feet.z - before.z)).toBeLessThan(0.01);
    expect(p.grounded).toBe(true);
  });
});

describe('S-36: the entrance plaza and the street', () => {
  it('the plaza’s rim stops the body softly all round, except where the road and the street go on', () => {
    for (const deg of [45, 100, 160, 200, 260, 315]) {
      const a = (deg * Math.PI) / 180;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const r = world();
      const [cx, , cz] = AREA1_PLAZA.center;
      const p = body(r, [cx + dx * 3, AREA1_Y, cz + dz * 3], yawToward(dx, dz));
      const s = walk(r, p, forward, 10);
      expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
      const d = Math.hypot(p.feet.x - cx, p.feet.z - cz);
      expect(d, `toward ${deg}°`).toBeLessThan(AREA1_PLAZA.radius - AREA1_RIM.thickness / 2);
      expect(d).toBeGreaterThan(AREA1_PLAZA.radius - 1.2);
    }
  });

  it('the street leads east from the plaza between the houses to where the slope turns up', () => {
    const r = world();
    const p = body(r, [AREA1_PLAZA.center[0], AREA1_Y, AREA1_STREET.z], yawToward(1, 0));
    const s = walk(r, p, forward, 25);
    expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
    // stopped by the house closing its east end
    expect(p.feet.x).toBeGreaterThan(AREA1_STREET.toX - BODY_RADIUS - 0.4);
    expect(p.feet.x).toBeLessThan(AREA1_STREET.toX);
  });
});

describe('S-36: 部屋1 — the crumbled wall across the alley (表だけの壁, S-28)', () => {
  const alleyX = (ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2 - 0.4;
  const inAlley: Vec3 = [alleyX, AREA1_Y, ROOM1_ALLEY.minZ + 0.4];
  const north = yawToward(0, 1);
  const wall = ROOM1_WALL.box;

  it('stops the body before it while nothing is placed', () => {
    const r = world();
    const p = body(r, inAlley, north);
    const s = walk(r, p, forward, 6);
    expect(s.every((q) => q.grounded)).toBe(true);
    expect(r.wall?.cutCount).toBe(0);
    expect(p.feet.z).toBeLessThan(wall.min[2] - BODY_RADIUS + 0.05);
    expect(p.feet.z).toBeGreaterThan(wall.min[2] - BODY_RADIUS - 0.3);
  });

  it('placed on its pedestal, the vidro’s sphere cuts the whole wall: through it to the drop, and back', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const tick = () => {
      session.step(DT, { wantPeek: false });
      r.footing.sync(session.spheres());
      r.wall?.sync(session.spheres());
    };
    expect(session.interact({ kind: 'pedestal', id: ROOM1_PEDESTAL.id }, inAlley)).toBe('place');
    for (let t = 0; t < MATERIALIZE_SECONDS + 0.1; t += DT) tick();
    expect(session.spheres()[0]?.radius).toBeCloseTo(MAIN_ORB_RADIUS, 6);
    expect(r.wall?.cutCount).toBe(surfaceSegments(ROOM1_WALL).length);
    const p = body(r, inAlley, north);
    walk(r, p, forward, 4);
    expect(p.feet.z).toBeGreaterThan(wall.max[2] + 0.2);
    // behind the wall the drop is real (inside the sphere) and is taken
    expect(session.dropMaterialized(AREA1.rooms[0]?.drop.id)).toBe(true);
    // standing in the wall, the vidro will not come (it would shut the body in)
    const inWall: Vec3 = [alleyX, AREA1_Y, (wall.min[2] + wall.max[2]) / 2];
    expect(session.interact({ kind: 'pedestal', id: ROOM1_PEDESTAL.id }, inWall)).toBe('pickup-denied');
    // back out before the wall: it comes, the wall is solid again at once, and stops the body as before
    const back = body(r, [alleyX, AREA1_Y, wall.min[2] - 0.8], north);
    expect(
      session.interact({ kind: 'pedestal', id: ROOM1_PEDESTAL.id }, [alleyX, AREA1_Y, wall.min[2] - 0.8]),
    ).toBe('pickup');
    tick();
    expect(r.wall?.cutCount).toBe(0);
    walk(r, back, forward, 4);
    expect(back.feet.z).toBeLessThan(wall.min[2] - BODY_RADIUS + 0.05);
  });
});

describe('S-36: the slope’s foot and its shut gate', () => {
  it('turns south off the street and climbs; the shut gate stops the body before it (仮の行き止まり), no fall', () => {
    const r = world();
    const p = body(r, [AREA1_SLOPE.x, AREA1_Y, AREA1_STREET.z], yawToward(0, -1));
    const s = walk(r, p, forward, 12);
    expect(s.every((q) => q.grounded && Math.abs(q.y - area1SlopeHeight(q.z)) < 0.06)).toBe(true);
    expect(p.feet.z).toBeGreaterThan(AREA1_GATE.z);
    expect(p.feet.z).toBeLessThan(AREA1_GATE.z + BODY_RADIUS + 0.4);
    expect(p.feet.y).toBeGreaterThan(AREA1_Y + 0.5);
  });

  it('the houses along it hold the body on both sides', () => {
    for (const intent of [strafeLeft, strafeRight]) {
      const r = world();
      const z = (AREA1_SLOPE.fromZ + AREA1_GATE.z) / 2;
      const p = body(r, [AREA1_SLOPE.x, area1SlopeHeight(z), z], yawToward(0, -1));
      const s = walk(r, p, intent, 3);
      expect(s.every((q) => q.grounded)).toBe(true);
      expect(Math.abs(p.feet.x - AREA1_SLOPE.x)).toBeLessThan(AREA1_SLOPE.halfWidth - BODY_RADIUS + 0.02);
    }
  });
});

describe('S-36: the central plaza is unchanged by it', () => {
  it('nothing of エリア1 stands in the central plaza or its gate', () => {
    const r = world();
    const p = body(r, [PLAZA.center[0] + 18, PLAZA_Y, PLAZA.center[2]], yawToward(1, 0));
    const s = walk(r, p, forward, 4);
    expect(s.every((q) => q.grounded && Math.abs(q.y - PLAZA_Y) < 0.03)).toBe(true);
    expect(p.feet.x).toBeGreaterThan(PLAZA.center[0] + 22);
  });
});
