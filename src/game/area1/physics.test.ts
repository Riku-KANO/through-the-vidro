import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS, MATERIALIZE_SECONDS } from '../../layers/materialize';
import { footingOf, surfaceOf, surfaceSegments } from '../area';
import { COMPASS } from '../area/compass';
import { BODY_RADIUS } from '../player/constants';
import { createWorld, initPhysics } from '../player/physics';
import { PlayerController, type PlayerIntent } from '../player/player';
import {
  bridgeFooting,
  DROP_REACH,
  GATE_OPEN_DEG,
  MEMBRANE,
  PLAZA,
  PLAZA_Y,
  PROLOGUE_AREA,
  slopeHeight,
} from '../prologue/layout';
import {
  addRoomColliders,
  BackFooting,
  deckSegmentShape,
  GateLeaves,
  SurfaceColliders,
  withMembrane,
} from '../prologue/physics';
import {
  DROP_FLIGHT_SECONDS,
  FINALE_SECONDS,
  GATE_OPEN_SECONDS,
  PrologueSession,
  type ShortcutEvent,
} from '../prologue/session';
import {
  AREA1,
  AREA1_GATES,
  AREA1_PLAZA,
  AREA1_RIM,
  AREA1_ROAD,
  AREA1_SLOPE,
  AREA1_STREET,
  AREA1_Y,
  area1GateAngle,
  area1SlopeHeight,
  COURT_Y,
  eastOf,
  eastX,
  gateLeaves,
  ROOM1_ALLEY,
  ROOM1_DROP,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
  ROOM2_BALCONY,
  ROOM2_COURT,
  ROOM2_DROP,
  ROOM2_PEDESTAL_A,
  ROOM2_PEDESTAL_B,
  ROOM2_STAIRS,
  ROOM2_STAIRS_FOOT_Z,
  ROOM2_WALL,
  ROOM3_BRIDGE_N,
  ROOM3_BRIDGE_S,
  ROOM3_DROP,
  ROOM3_PEDESTAL_N,
  ROOM3_PEDESTAL_S,
  ROOM3_RAILING,
  ROOM3_ROOF_N,
  ROOM3_ROOF_S,
  ROOM3_SHADE,
  ROOM3_TERRACE,
  SHORTCUT_GATE,
  SHORTCUT_SECONDS,
  SHORTCUT_STAIRS,
  SUMMIT_Y,
  shortcutHeight,
  shortcutSegments,
} from './layout';
import { Area1Gates, addArea1Colliders, area1Footing } from './physics';

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
/** Looking east (COMPASS). */
const EAST_YAW = yawToward(COMPASS.east[0], COMPASS.east[1]);

/**
 * A world with the prologue's colliders and (`area1`) エリア1's. S-41: its gates between the rooms `open` (the S-40 tests of the
 * slope and the rooms: as if their drops were taken) or `shut` (as they stand before; `played` opens them with the session).
 */
function world(area1 = true, gates: 'open' | 'shut' = 'open') {
  const w = createWorld();
  addRoomColliders(R, w);
  const footing = new BackFooting(R, w, bridgeFooting(), deckSegmentShape);
  const built = area1 ? addArea1Colliders(R, w) : null;
  // S-40: エリア1's back-layer footing (the courtyard's stair, the bridges, the shortcut) and every surface-only wall of it
  const a1 = area1 ? area1Footing(R, w) : null;
  const wall = area1 ? new SurfaceColliders(R, w, surfaceOf([AREA1])) : null;
  const gateLeaves = area1 ? new Area1Gates(R, w) : null;
  if (gates === 'open') for (const g of AREA1_GATES) gateLeaves?.sync(g.id, area1GateAngle(1));
  const allowGround = (x: number, y: number, z: number, c: RAPIER.Collider): boolean =>
    footing.allowGround(x, y, z, c) && (a1?.allowGround(x, y, z, c) ?? true);
  return { world: w, footing, a1, built, wall, gates: gateLeaves, gatesShut: gates === 'shut', allowGround };
}

function body(r: ReturnType<typeof world>, feet: Vec3, yaw: number): PlayerController {
  return new PlayerController(r.world, {
    feet: { x: feet[0], y: feet[1], z: feet[2] },
    yaw,
    allowGround: r.allowGround,
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
    const p = body(r, [eastX(eastOf(AREA1_ROAD.fromX) - 2), PLAZA_Y, AREA1_ROAD.z], EAST_YAW);
    const s = walk(r, p, sprint, (AREA1_ROAD.length + 8) / 2.2);
    expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
    expect(eastOf(p.feet.x)).toBeGreaterThan(eastOf(AREA1_ROAD.toX) + 3);
    expect(Math.abs(p.feet.z - AREA1_ROAD.z)).toBeLessThan(0.1);
  });

  it('its railings hold the body on both sides all along it (no fall)', () => {
    for (const x of [AREA1_ROAD.fromX + 3, (AREA1_ROAD.fromX + AREA1_ROAD.toX) / 2, AREA1_ROAD.toX - 3]) {
      for (const intent of [strafeLeft, strafeRight]) {
        const r = world();
        const p = body(r, [x, PLAZA_Y, AREA1_ROAD.z], EAST_YAW);
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
    const p = body(r, [eastX(eastOf(AREA1_ROAD.toX) - 6), PLAZA_Y, AREA1_ROAD.z], EAST_YAW);
    const s = walk(r, p, forward, 8);
    expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
    expect(eastOf(p.feet.x)).toBeLessThan(eastOf(AREA1_ROAD.toX) + 0.6);
    expect(eastOf(p.feet.x)).toBeGreaterThan(eastOf(AREA1_ROAD.toX) - 1.2);
    expect(s.at(-1)?.speed ?? 1).toBeLessThan(0.05);
  });

  it('built while the body stands on the road, it does not shove the body (nothing of it stands on the road)', () => {
    const r = world(false);
    const p = body(r, [eastX(eastOf(AREA1_ROAD.toX) - 0.4), PLAZA_Y, AREA1_ROAD.z], EAST_YAW);
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
    const p = body(r, [AREA1_PLAZA.center[0], AREA1_Y, AREA1_STREET.z], EAST_YAW);
    const s = walk(r, p, forward, 25);
    expect(s.every((q) => q.grounded && Math.abs(q.y - AREA1_Y) < 0.03)).toBe(true);
    // stopped by the house closing its east end (measured along the east)
    const end = eastOf(AREA1_STREET.endX);
    expect(eastOf(p.feet.x)).toBeGreaterThan(end - BODY_RADIUS - 0.4);
    expect(eastOf(p.feet.x)).toBeLessThan(end);
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
    expect(session.dropMaterialized(AREA1.rooms[0]?.drop?.id)).toBe(true);
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

const SOUTH_YAW = yawToward(0, -1);
const NORTH_YAW = yawToward(0, 1);
const WEST_YAW = yawToward(COMPASS.west[0], COMPASS.west[1]);

/** The session and the world stepped together, as the room does (S-40: エリア1's footing and walls, what the light fixed). */
function played(r: ReturnType<typeof world>, session: PrologueSession) {
  const tick = () => {
    session.step(DT, { wantPeek: false });
    const spheres = session.spheres();
    r.footing.sync(spheres);
    r.a1?.sync(spheres);
    r.wall?.sync(spheres);
    r.a1?.settle(session.settledFooting());
    r.wall?.settle(session.settledSurface());
    // S-41: the gates between the rooms as the session opens them (in a world where they stand shut)
    if (r.gatesShut)
      for (const g of AREA1_GATES) r.gates?.sync(g.id, area1GateAngle(session.areaGateProgress(g.id)));
  };
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) tick();
  };
  /** Walks the body with `intent` for `seconds`, the session stepping with it. */
  const go = (p: PlayerController, intent: PlayerIntent, seconds: number) => {
    const out: { x: number; y: number; z: number; grounded: boolean }[] = [];
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      tick();
      r.world.step();
      p.update(DT, intent);
      const f = p.feet;
      out.push({ x: f.x, y: f.y, z: f.z, grounded: p.grounded });
    }
    return out;
  };
  const feet = (p: PlayerController): Vec3 => [p.feet.x, p.feet.y, p.feet.z];
  return { tick, run, go, feet };
}

/** Turns the body to look along (dx, dz), standing. */
function face(r: ReturnType<typeof world>, p: PlayerController, yaw: number): void {
  const d = Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw));
  r.world.step();
  p.update(DT, { move: { x: 0, y: 0 }, sprint: false, lookYaw: d, lookPitch: 0 });
}

describe('S-40: the slope from the street up to the summit (two flights, the landing between)', () => {
  it('takes the body from the street up to the summit’s terrace, following the slope, never falling', () => {
    const r = world();
    const p = body(r, [AREA1_SLOPE.x, AREA1_Y, AREA1_STREET.z], SOUTH_YAW);
    const s = walk(r, p, sprint, 22);
    expect(s.every((q) => q.grounded)).toBe(true);
    for (const q of s)
      if (q.z < AREA1_SLOPE.fromZ && q.z > AREA1_SLOPE.toZ)
        expect(Math.abs(q.y - area1SlopeHeight(q.z)), `at z ${q.z}`).toBeLessThan(0.08);
    // at the summit, stopped by the house south of its terrace
    expect(p.feet.y).toBeCloseTo(SUMMIT_Y, 1);
    expect(p.feet.z).toBeLessThan(AREA1_SLOPE.toZ - 2);
    expect(p.feet.z).toBeGreaterThan(ROOM3_TERRACE.minZ);
  });

  it('the houses hold the body on both sides of both flights; on the landing the courtyard opens east', () => {
    for (const z of [-134, -148, -155]) {
      for (const intent of [strafeLeft, strafeRight]) {
        const r = world();
        const p = body(r, [AREA1_SLOPE.x, area1SlopeHeight(z), z], SOUTH_YAW);
        const s = walk(r, p, intent, 3);
        expect(
          s.every((q) => q.grounded),
          `at z ${z}`,
        ).toBe(true);
        expect(Math.abs(p.feet.x - AREA1_SLOPE.x), `at z ${z}`).toBeLessThan(
          AREA1_SLOPE.halfWidth - BODY_RADIUS + 0.02,
        );
      }
    }
    // facing south, the right hand is east (COMPASS): into the courtyard off the landing
    const r = world();
    const p = body(r, [AREA1_SLOPE.x, COURT_Y, -143.2], SOUTH_YAW);
    const s = walk(r, p, strafeRight, 4);
    expect(s.every((q) => q.grounded && Math.abs(q.y - COURT_Y) < 0.05)).toBe(true);
    expect(eastOf(p.feet.x)).toBeGreaterThan(eastOf(ROOM2_COURT.minX) + 2);
  });
});

describe('S-40: 部屋2「二つの台座の中庭」 in a Rapier world, played with the session', () => {
  const stairX = (ROOM2_STAIRS.minX + ROOM2_STAIRS.maxX) / 2;
  const below: Vec3 = [stairX, COURT_Y, ROOM2_STAIRS_FOOT_Z - 1.0];
  const wall = ROOM2_WALL.box;

  it('with nothing placed, the stair is not there: the balcony’s face stops the body below it', () => {
    const r = world();
    const p = body(r, below, NORTH_YAW);
    const s = walk(r, p, forward, 5);
    expect(s.every((q) => q.grounded && Math.abs(q.y - COURT_Y) < 0.05)).toBe(true);
    expect(p.feet.z).toBeLessThan(ROOM2_BALCONY.minZ - BODY_RADIUS + 0.05);
  });

  it('on A: up the stair to the balcony, but the wall stands (A’s sphere does not reach it); down again, A comes from the floor', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const g = played(r, session);
    expect(session.interact({ kind: 'pedestal', id: ROOM2_PEDESTAL_A.id }, below)).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    expect(r.wall?.cutCount).toBe(0);
    const p = body(r, below, NORTH_YAW);
    g.go(p, forward, 4.5);
    expect(p.feet.y).toBeCloseTo(ROOM2_BALCONY.y, 1);
    // on the stair the vidro would not come (it holds the stair): try from the stair's middle
    expect(
      session.interact({ kind: 'pedestal', id: ROOM2_PEDESTAL_A.id }, [
        stairX,
        COURT_Y + 0.8,
        ROOM2_STAIRS_FOOT_Z + 1.4,
      ]),
    ).toBe('pickup-denied');
    // west along the balcony: the wall stops the body on its east side
    face(r, p, WEST_YAW);
    const s = g.go(p, forward, 5);
    expect(s.every((q) => q.grounded)).toBe(true);
    expect(eastOf(p.feet.x)).toBeGreaterThan(eastOf(wall.max[0]) + BODY_RADIUS - 0.05);
    // the drop is not there for the touching (outside A's sphere)
    expect(session.dropMaterialized(ROOM2_DROP.id)).toBe(false);
    // back down the stair: A comes from the floor
    const back = body(r, [stairX, ROOM2_BALCONY.y, ROOM2_BALCONY.minZ + 0.6], SOUTH_YAW);
    g.go(back, forward, 4);
    expect(back.feet.y).toBeCloseTo(COURT_Y, 1);
    expect(session.interact({ kind: 'pedestal', id: ROOM2_PEDESTAL_A.id }, g.feet(back))).toBe('pickup');
  });

  it('on B: up the stair, through the wall (cut), the drop taken; back through and down, B comes from the floor', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const g = played(r, session);
    expect(session.interact({ kind: 'pedestal', id: ROOM2_PEDESTAL_B.id }, below)).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    expect(r.wall?.cutCount).toBe(surfaceSegments(ROOM2_WALL).length);
    const p = body(r, below, NORTH_YAW);
    g.go(p, forward, 4.5);
    expect(p.feet.y).toBeCloseTo(ROOM2_BALCONY.y, 1);
    face(r, p, WEST_YAW);
    const s = g.go(p, forward, 3.2);
    expect(s.every((q) => q.grounded && Math.abs(q.y - ROOM2_BALCONY.y) < 0.05)).toBe(true);
    expect(eastOf(p.feet.x)).toBeLessThan(eastOf(wall.min[0]) - 0.3);
    expect(session.dropMaterialized(ROOM2_DROP.id)).toBe(true);
    expect(session.interact({ kind: 'drop', id: ROOM2_DROP.id }, g.feet(p))).toBe('touch-drop');
    g.run(DROP_FLIGHT_SECONDS + 0.1);
    expect(session.dropStateOf(ROOM2_DROP.id)).toBe('taken');
    // from the balcony B is out of reach (layout.test), and in the wall it would not come
    expect(
      session.interact({ kind: 'pedestal', id: ROOM2_PEDESTAL_B.id }, [
        (wall.min[0] + wall.max[0]) / 2,
        ROOM2_BALCONY.y,
        (wall.min[2] + wall.max[2]) / 2,
      ]),
    ).toBe('pickup-denied');
    // back east through the wall and down the stair
    face(r, p, yawToward(COMPASS.east[0], COMPASS.east[1]));
    g.go(p, forward, 3.4);
    expect(eastOf(p.feet.x)).toBeGreaterThan(eastOf(wall.max[0]) + 0.3);
    const down = body(r, [stairX, ROOM2_BALCONY.y, ROOM2_BALCONY.minZ + 0.6], SOUTH_YAW);
    g.go(down, forward, 4);
    expect(down.feet.y).toBeCloseTo(COURT_Y, 1);
    expect(session.interact({ kind: 'pedestal', id: ROOM2_PEDESTAL_B.id }, g.feet(down))).toBe('pickup');
    g.tick();
    expect(r.wall?.cutCount).toBe(0);
  });

  it('the balcony’s railing holds the body on it (no stepping off its edge), but where the stair arrives', () => {
    const r = world();
    const p = body(
      r,
      [eastX(125.5), ROOM2_BALCONY.y, (ROOM2_BALCONY.minZ + ROOM2_BALCONY.maxZ) / 2],
      SOUTH_YAW,
    );
    const s = walk(r, p, forward, 3);
    expect(s.every((q) => q.grounded && Math.abs(q.y - ROOM2_BALCONY.y) < 0.05)).toBe(true);
    expect(p.feet.z).toBeGreaterThan(ROOM2_BALCONY.minZ);
  });
});

describe('S-40: 部屋3「煙突の見晴らし」 in a Rapier world, played with the session', () => {
  const lipN: Vec3 = [eastX(113.6), SUMMIT_Y, (ROOM3_BRIDGE_N.min[2] + ROOM3_BRIDGE_N.max[2]) / 2];
  const lipS: Vec3 = [eastX(113.6), SUMMIT_Y, (ROOM3_BRIDGE_S.min[2] + ROOM3_BRIDGE_S.max[2]) / 2];

  it('with nothing placed, the body stops at the valley’s lip on either bridge’s line (no way across)', () => {
    for (const at of [lipN, lipS]) {
      const r = world();
      const p = body(r, [eastX(115.5), SUMMIT_Y, at[2]], WEST_YAW);
      const s = walk(r, p, forward, 5);
      expect(s.every((q) => q.grounded && Math.abs(q.y - SUMMIT_Y) < 0.05)).toBe(true);
      expect(eastOf(p.feet.x)).toBeGreaterThan(eastOf(ROOM3_TERRACE.minX) - 0.4);
    }
  });

  it('on the north pedestal: across the north bridge to the drop’s roof; the south bridge is not there', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const g = played(r, session);
    expect(session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_N.id }, lipN)).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    const p = body(r, [eastX(114.6), SUMMIT_Y, lipN[2]], WEST_YAW);
    const s = g.go(p, forward, 3.4);
    expect(s.every((q) => q.grounded && Math.abs(q.y - SUMMIT_Y) < 0.05)).toBe(true);
    expect(eastOf(p.feet.x)).toBeLessThan(eastOf(ROOM3_ROOF_N.maxX) - 0.5);
    expect(session.dropMaterialized(ROOM3_DROP.id)).toBe(true);
    const q = body(r, [eastX(115.0), SUMMIT_Y, lipS[2]], WEST_YAW);
    g.go(q, forward, 5);
    expect(eastOf(q.feet.x)).toBeGreaterThan(eastOf(ROOM3_TERRACE.minX) - 0.4);
  });

  it('on the south pedestal: across the south bridge to an empty roof (the drop is not in its sphere); back, and it comes', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const g = played(r, session);
    expect(session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_S.id }, lipS)).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    const p = body(r, [eastX(114.6), SUMMIT_Y, lipS[2]], WEST_YAW);
    g.go(p, forward, 3.4);
    expect(eastOf(p.feet.x)).toBeLessThan(eastOf(ROOM3_ROOF_S.maxX) - 0.5);
    expect(p.feet.y).toBeCloseTo(SUMMIT_Y, 1);
    expect(session.dropMaterialized(ROOM3_DROP.id)).toBe(false);
    // on the bridge it would not come; back on the terrace it does (罰がない)
    expect(
      session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_S.id }, [eastX(112.1), SUMMIT_Y, lipS[2]]),
    ).toBe('pickup-denied');
    // (S-41: from behind the crumbled wall on the lip: in it, cut, the vidro would not come)
    expect(
      session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_S.id }, [eastX(114.3), SUMMIT_Y, lipS[2]]),
    ).toBe('pickup');
  });
});

describe('S-41: rooms open in order — the gates in a Rapier world, played with the session (部屋は順に開く)', () => {
  const [court, summit] = AREA1_GATES as [(typeof AREA1_GATES)[0], (typeof AREA1_GATES)[0]];

  it('the gate across the slope’s foot stops the body in the street until 部屋1’s drop; its light comes, it opens, up to the landing', () => {
    const r = world(true, 'shut');
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const g = played(r, session);
    const p = body(r, [AREA1_SLOPE.x, AREA1_Y, AREA1_STREET.z], SOUTH_YAW);
    const before = g.go(p, forward, 4);
    expect(before.every((q) => q.grounded)).toBe(true);
    // stopped at the gate's leaves (a body's radius and half a leaf before its line)
    expect(p.feet.z).toBeGreaterThan(court.at[2] + BODY_RADIUS - 0.05);
    // 部屋1's drop taken (as if just now): the light comes along the lamps to the keystone, then the leaves swing open
    expect(
      session.interact({ kind: 'pedestal', id: ROOM1_PEDESTAL.id }, [eastX(114.7), AREA1_Y, -123.6]),
    ).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    expect(session.interact({ kind: 'drop', id: ROOM1_DROP.id }, [eastX(113.8), AREA1_Y, -119.9])).toBe(
      'touch-drop',
    );
    g.run(DROP_FLIGHT_SECONDS + 0.1);
    expect(r.gates?.angle(court.id)).toBe(0);
    const opensAt = AREA1.gates?.[0]?.opensAt ?? 0;
    g.run(opensAt - 0.2);
    expect(r.gates?.angle(court.id)).toBe(0);
    g.run(0.3 + GATE_OPEN_SECONDS);
    expect(r.gates?.angle(court.id)).toBeCloseTo(area1GateAngle(1), 9);
    const s = g.go(p, forward, 12);
    expect(s.every((q) => q.grounded)).toBe(true);
    expect(p.feet.y).toBeCloseTo(COURT_Y, 1);
    expect(p.feet.z).toBeLessThan(AREA1_SLOPE.landingFromZ);
    // the second gate still stands shut
    expect(r.gates?.angle(summit.id)).toBe(0);
  });

  it('the gate across the second flight stops the body on the landing until 部屋2’s drop; then up to the summit', () => {
    const r = world(true, 'shut');
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    session.holdDropTaken(ROOM1_DROP.id);
    const g = played(r, session);
    g.tick();
    expect(r.gates?.angle(court.id)).toBeCloseTo(area1GateAngle(1), 9);
    const p = body(r, [AREA1_SLOPE.x, COURT_Y, -143.0], SOUTH_YAW);
    g.go(p, forward, 4);
    expect(p.feet.z).toBeGreaterThan(summit.at[2] + BODY_RADIUS - 0.05);
    expect(p.feet.y).toBeLessThan(COURT_Y + 0.5);
    // nor round it through the courtyard (it stands past the courtyard's opening, against its houses)
    const q = body(r, [eastX(124.0), COURT_Y, ROOM2_COURT.minZ + 0.5], yawToward(-1, -1));
    g.go(q, forward, 4);
    expect(q.feet.z).toBeGreaterThan(summit.at[2]);
    q.dispose();
    // 部屋2's drop (held taken as of now: its light on its way)
    expect(
      session.interact({ kind: 'pedestal', id: ROOM2_PEDESTAL_B.id }, [eastX(128.6), COURT_Y, -144.6]),
    ).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    expect(
      session.interact({ kind: 'drop', id: ROOM2_DROP.id }, [eastX(127.4), ROOM2_BALCONY.y, -141.1]),
    ).toBe('touch-drop');
    g.run(DROP_FLIGHT_SECONDS + (AREA1.gates?.[1]?.opensAt ?? 0) + GATE_OPEN_SECONDS + 0.1);
    expect(r.gates?.angle(summit.id)).toBeCloseTo(area1GateAngle(1), 9);
    const s = g.go(p, sprint, 10);
    expect(s.every((v) => v.grounded)).toBe(true);
    expect(p.feet.y).toBeCloseTo(SUMMIT_Y, 1);
  });
});

describe('S-41: the gates’ leaves collide where they are drawn (layout gateLeaves, art.ts)', () => {
  it('each leaf’s box stands over the middle of its leaf, turned along it, at every angle of its swing', () => {
    const w = createWorld();
    const gates = new Area1Gates(R, w);
    for (const angle of [0, 0.4, 1.1, area1GateAngle(1)])
      for (const g of AREA1_GATES) {
        gates.sync(g.id, angle);
        const leaves = gateLeaves(g, angle);
        gates.leafColliders(g.id).forEach((c, i) => {
          const leaf = leaves[i] as (typeof leaves)[0];
          const t = c.translation();
          // (Rapier keeps 32-bit floats)
          expect(t.x).toBeCloseTo(leaf.hinge[0] + (leaf.dir[0] * leaf.length) / 2, 4);
          expect(t.z).toBeCloseTo(leaf.hinge[1] + (leaf.dir[1] * leaf.length) / 2, 4);
          // its long side (the box's +x) along the leaf
          const q = c.rotation();
          const along = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
          expect(along.x).toBeCloseTo(leaf.dir[0], 4);
          expect(along.z).toBeCloseTo(leaf.dir[1], 4);
        });
      }
    gates.dispose();
  });
});

describe('S-41: 部屋3 — the drop in the lee of the roof’s walls, the crumbled wall on the lip (屋根の陰)', () => {
  const lipN: Vec3 = [eastX(113.6), SUMMIT_Y, (ROOM3_BRIDGE_N.min[2] + ROOM3_BRIDGE_N.max[2]) / 2];

  it('the crumbled wall on the lip stops the body; on the south pedestal it is cut: onto the south bridge (S-28), back, it comes', () => {
    const r = world();
    const w = ROOM3_RAILING.box;
    const zS = (ROOM3_BRIDGE_S.min[2] + ROOM3_BRIDGE_S.max[2]) / 2;
    const p = body(r, [eastX(115.0), SUMMIT_Y, zS], WEST_YAW);
    walk(r, p, forward, 3);
    expect(p.feet.x).toBeGreaterThan(w.max[0] + BODY_RADIUS - 0.05);
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const g = played(r, session);
    const by: Vec3 = [eastX(114.3), SUMMIT_Y, zS];
    expect(session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_S.id }, by)).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    expect(r.wall?.cutCount).toBe(surfaceSegments(ROOM3_RAILING).length);
    g.go(p, forward, 3);
    expect(eastOf(p.feet.x)).toBeLessThan(eastOf(ROOM3_ROOF_S.maxX) - 0.3);
    // standing in the cut wall the vidro will not come; behind it on the terrace it does, and the wall is back
    expect(
      session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_S.id }, [
        (w.min[0] + w.max[0]) / 2,
        SUMMIT_Y,
        zS,
      ]),
    ).toBe('pickup-denied');
    expect(session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_S.id }, by)).toBe('pickup');
    g.run(MATERIALIZE_SECONDS + 0.1);
    expect(r.wall?.cutCount).toBe(0);
  });

  it('placed on the north pedestal: over its bridge, round the northern wall to the drop in its lee, and the drop is touched', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const g = played(r, session);
    expect(session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_N.id }, lipN)).toBe('place');
    g.run(MATERIALIZE_SECONDS + 0.1);
    const p = body(r, [eastX(114.6), SUMMIT_Y, lipN[2]], WEST_YAW);
    g.go(p, forward, 3.4);
    expect(p.feet.y).toBeCloseTo(SUMMIT_Y, 1);
    // west of the walls, then south toward the drop (it hovers there in their lee)
    face(r, p, SOUTH_YAW);
    g.go(p, forward, 1.0);
    const eye: Vec3 = [p.feet.x, p.feet.y + 1.6, p.feet.z];
    const [dx, dy, dz] = ROOM3_DROP.at;
    const d = Math.hypot(dx - eye[0], dy - eye[1], dz - eye[2]);
    expect(d).toBeLessThan(DROP_REACH);
    expect(session.dropMaterialized(ROOM3_DROP.id)).toBe(true);
    expect(session.interact({ kind: 'drop', id: ROOM3_DROP.id }, g.feet(p))).toBe('touch-drop');
    // the northern wall stands solid on the roof's edge: east from the lee it holds the body (no stepping into the valley)
    const wallA = ROOM3_SHADE[0] as (typeof ROOM3_SHADE)[0];
    face(r, p, yawToward(1, 0));
    g.go(p, forward, 2);
    expect(p.feet.x).toBeLessThan(wallA.minX - BODY_RADIUS + 0.05);
  });
});

describe('S-40: 近道 — the stairs from the summit’s ridge to the entrance plaza, fixed by the third drop’s light', () => {
  const stairsX = (SHORTCUT_STAIRS.minX + SHORTCUT_STAIRS.maxX) / 2;

  it('before: the ridge’s edge stops the body above the stairs, and the gate stops it in the plaza', () => {
    const r = world();
    const p = body(r, [stairsX, SUMMIT_Y, SHORTCUT_STAIRS.topZ - 1.2], NORTH_YAW);
    const s = walk(r, p, forward, 4);
    expect(s.every((q) => q.grounded && Math.abs(q.y - SUMMIT_Y) < 0.05)).toBe(true);
    expect(p.feet.z).toBeLessThan(SHORTCUT_STAIRS.topZ + 0.4);
    const q = body(r, [stairsX, AREA1_Y, AREA1_PLAZA.center[2] - 6], SOUTH_YAW);
    walk(r, q, forward, 5);
    expect(q.feet.z).toBeGreaterThan(SHORTCUT_GATE.box.max[2]);
  });

  it('the third drop (部屋3’s, the others taken): the light runs over the north bridge and down the stairs, the gate goes', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    const shortcut: ShortcutEvent[] = [];
    session.shortcutEvents.on((e) => shortcut.push(e));
    session.holdDropTaken(ROOM1_DROP.id);
    session.holdDropTaken(ROOM2_DROP.id);
    const g = played(r, session);
    const lip: Vec3 = [eastX(113.6), SUMMIT_Y, (ROOM3_BRIDGE_N.min[2] + ROOM3_BRIDGE_N.max[2]) / 2];
    session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_N.id }, lip);
    g.run(MATERIALIZE_SECONDS + 0.1);
    const p = body(r, [eastX(114.6), SUMMIT_Y, lip[2]], WEST_YAW);
    g.go(p, forward, 3.0);
    expect(session.interact({ kind: 'drop', id: ROOM3_DROP.id }, g.feet(p))).toBe('touch-drop');
    // (S-41: that body leaves the world; another walks the way home below — it would stand in its way on the bridge's line)
    p.dispose();
    g.run(DROP_FLIGHT_SECONDS + 0.1);
    expect(shortcut).toEqual([{ type: 'settle', area: 'area1' }]);
    g.run(SHORTCUT_SECONDS + 0.1);
    expect(shortcut.map((e) => e.type)).toEqual(['settle', 'settled']);
    const steps = shortcutSegments();
    const bridgeN = footingOf([AREA1]).filter((seg) => seg.id.startsWith('area1-bridge-n'));
    expect(session.settledFooting()).toEqual([...bridgeN, ...steps].map((seg) => seg.id));
    expect(session.settledSurface()).toEqual(surfaceSegments(SHORTCUT_GATE).map((seg) => seg.id));
    // back on the settled north bridge the vidro comes (光で定着した足場の上では回収できる); the bridge stays
    const onBridge: Vec3 = [eastX(112.1), SUMMIT_Y, lip[2]];
    expect(session.interact({ kind: 'pedestal', id: ROOM3_PEDESTAL_N.id }, onBridge)).toBe('pickup');
    g.run(MATERIALIZE_SECONDS + 0.2);
    expect(r.a1?.activeIds).toEqual(expect.arrayContaining(bridgeN.map((seg) => seg.id)));
    // over the bridge again with the vidro in hand, along the ridge, and down the stairs into the plaza
    const q = body(r, [eastX(114.6), SUMMIT_Y, lip[2]], WEST_YAW);
    g.go(q, sprint, 9.5);
    expect(eastOf(q.feet.x)).toBeLessThan(eastOf(SHORTCUT_STAIRS.maxX) + 1);
    const down = body(r, [stairsX, SUMMIT_Y, SHORTCUT_STAIRS.topZ - 0.6], NORTH_YAW);
    const s = g.go(down, forward, 19);
    expect(s.every((v) => v.grounded)).toBe(true);
    for (const v of s) {
      const h = shortcutHeight(v.z);
      if (h !== null && v.z > SHORTCUT_STAIRS.topZ + 0.2 && v.z < SHORTCUT_STAIRS.footZ - 0.2)
        expect(Math.abs(v.y - h), `at z ${v.z}`).toBeLessThan(0.3);
    }
    // through the opening where the gate was, into the plaza
    expect(down.feet.y).toBeCloseTo(AREA1_Y, 1);
    expect(down.feet.z).toBeGreaterThan(SHORTCUT_GATE.box.max[2] + 1);
  });

  it('held fixed (?shortcutHold), the stairs take the body up from the plaza to the summit’s ridge too', () => {
    const r = world();
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    session.holdShortcut('area1', SHORTCUT_SECONDS + 1);
    const g = played(r, session);
    g.tick();
    const p = body(r, [stairsX, AREA1_Y, AREA1_PLAZA.center[2] - 7], SOUTH_YAW);
    const s = g.go(p, forward, 28);
    expect(s.every((v) => v.grounded)).toBe(true);
    expect(p.feet.y).toBeCloseTo(SUMMIT_Y, 1);
    expect(p.feet.z).toBeLessThan(SHORTCUT_STAIRS.topZ - 0.5);
  });
});

describe('S-36: the central plaza is unchanged by it', () => {
  it('nothing of エリア1 stands in the central plaza or its gate', () => {
    const r = world();
    const p = body(r, [eastX(18), PLAZA_Y, PLAZA.center[2]], EAST_YAW);
    const s = walk(r, p, forward, 4);
    expect(s.every((q) => q.grounded && Math.abs(q.y - PLAZA_Y) < 0.03)).toBe(true);
    expect(eastOf(p.feet.x)).toBeGreaterThan(22);
  });
});

describe('S-36: the vidro left on エリア1’s pedestal never shuts you out of the town (原則3: 罰がない)', () => {
  it('up the slope past the film in the workshop’s gate and back down again, while the vidro stands in 部屋1', () => {
    const w = createWorld();
    addRoomColliders(R, w);
    const footing = new BackFooting(R, w, bridgeFooting(), deckSegmentShape);
    const gate = new GateLeaves(R, w);
    gate.sync((GATE_OPEN_DEG * Math.PI) / 180);
    const session = new PrologueSession({
      orbStart: 'hand',
      areas: [PROLOGUE_AREA, AREA1],
      membrane: MEMBRANE,
    });
    session.holdFinale(FINALE_SECONDS + 1);
    expect(session.interact({ kind: 'pedestal', id: ROOM1_PEDESTAL.id }, [eastX(114), AREA1_Y, -124])).toBe(
      'place',
    );
    let feetZ = MEMBRANE.z - 3;
    const p = new PlayerController(w, {
      feet: { x: 0.2, y: slopeHeight(feetZ), z: feetZ },
      yaw: yawToward(0, 1),
      allowGround: withMembrane(footing.allowGround, () => session.holdsAtMembrane(feetZ)),
      settings: { headBob: 0 },
    });
    const go = (intent: PlayerIntent, seconds: number) => {
      for (let t = 0; t < seconds; t += DT) {
        session.step(DT, { wantPeek: false, feet: [p.feet.x, p.feet.y, feetZ], pushing: false });
        w.step();
        p.update(DT, intent);
        feetZ = p.feet.z;
      }
    };
    // up onto the far shore, past the film
    go(forward, 5);
    expect(p.feet.z).toBeGreaterThan(MEMBRANE.z + 2);
    expect(p.grounded).toBe(true);
    // and back down the slope: the film does not hold (the vidro is down there)
    go({ ...forward, move: { x: 0, y: -1 } }, 6);
    expect(p.feet.z).toBeLessThan(MEMBRANE.z - 2);
    expect(p.grounded).toBe(true);
  });
});
