import type RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../layers/footing';
import { footingOf, surfaceOf } from '../area';
import { AREA1, AREA1_PLAZA, AREA1_Y, area1Ground } from '../area1/layout';
import { addArea1Colliders, area1Footing } from '../area1/physics';
import { createWorld, initPhysics } from '../player/physics';
import { PlayerController } from '../player/player';
import { Autopilot } from './autopilot';
import {
  bridgeFooting,
  DROP_REACH,
  FACING_DEG,
  groundHeight,
  lookDirection,
  PROLOGUE_AREA,
  REACH,
} from './layout';
import { addRoomColliders, BackFooting, deckSegmentShape, SurfaceColliders } from './physics';
import { PrologueSession } from './session';
import { pickTarget, type TargetCandidate } from './targets';

/**
 * S-40: the scripted play (?autoplay=1&autoplayTo=area1) through エリア1 — from the road into its entrance plaza, 部屋1, 部屋2,
 * 部屋3 and down the shortcut — played in a Rapier world with the game's session, as the room plays it (its targets the room's
 * rule: room.ts chooseTarget), so a step that cannot be done (out of reach, blocked, not there) is found here, in seconds, not
 * by a ten-minute browser run.
 */
let R: typeof RAPIER;
beforeAll(async () => {
  R = await initPhysics();
});

const DT = 1 / 60;

describe('S-40: the autopilot’s エリア1 (rooms 1, 2, 3, the shortcut) in a Rapier world', () => {
  it('plays from the road to the entrance plaza by the shortcut: every drop taken, the vidro in hand, never falling', () => {
    const world = createWorld();
    addRoomColliders(R, world);
    const footing = new BackFooting(R, world, bridgeFooting(), deckSegmentShape);
    addArea1Colliders(R, world);
    const a1 = area1Footing(R, world);
    const walls = new SurfaceColliders(R, world, surfaceOf([AREA1]));
    expect(footingOf([AREA1]).length).toBe(a1.segments.length);
    const session = new PrologueSession({ orbStart: 'hand', areas: [PROLOGUE_AREA, AREA1] });
    session.holdFinale(60);
    const pilot = new Autopilot();
    pilot.extendToArea1();
    pilot.startAt('walk-road');
    expect(pilot.current).toBe('walk-road');
    // at the central plaza's east gate, facing east along the road
    const p = new PlayerController(world, {
      feet: { x: 22, y: AREA1_Y, z: AREA1_PLAZA.center[2] },
      yaw: Math.atan2(-1, 0),
      allowGround: (x, y, z, c) => footing.allowGround(x, y, z, c) && a1.allowGround(x, y, z, c),
      settings: { headBob: 0 },
    });
    const candidates: TargetCandidate<{ kind: 'pedestal' | 'drop'; id: string }>[] = [];
    const eye: [number, number, number] = [0, 0, 0];
    const fwd: [number, number, number] = [0, 0, 0];
    let lowest = Number.POSITIVE_INFINITY;
    let t = 0;
    const steps: string[] = [];
    for (; t < 600 && !pilot.done; t += DT) {
      const f = p.feet;
      const feet: Vec3 = [f.x, f.y, f.z];
      // the room's targets: the placed vidro's pedestal, or every pedestal when it is in hand; a waiting drop that is real
      candidates.length = 0;
      const placed = session.pedestal;
      for (const [id, point] of Object.entries(session.pedestals))
        if (placed === null || placed === id)
          candidates.push({ target: { kind: 'pedestal', id }, point, reach: REACH });
      for (const d of session.dropList)
        if (session.dropStateOf(d.id) === 'waiting' && session.dropMaterialized(d.id))
          candidates.push({ target: { kind: 'drop', id: d.id }, point: d.at, reach: DROP_REACH });
      eye[0] = f.x;
      eye[1] = p.eye.y;
      eye[2] = f.z;
      const target = pickTarget(eye, lookDirection(p.yaw, p.pitch, fwd), candidates, FACING_DEG);
      const v = p.velocity;
      const order = pilot.step(DT, {
        feet,
        yaw: p.yaw,
        pitch: p.pitch,
        speed: Math.hypot(v.x, v.z),
        target: target?.kind ?? null,
        orb: session.orbPlace,
        sphereRadius: session.spheres().find((s) => s.kind === 'main')?.radius ?? 0,
        drop: session.dropState,
        taken: Object.values(session.areaCounts()).reduce((n, c) => n + c.taken, 0),
      });
      if (steps.at(-1) !== pilot.current) steps.push(pilot.current);
      if (order.interact && target) session.interact(target, feet);
      session.step(DT, { wantPeek: order.peek, feet });
      const spheres = session.spheres();
      footing.sync(spheres);
      a1.sync(spheres);
      walls.sync(spheres);
      a1.settle(session.settledFooting());
      walls.settle(session.settledSurface());
      world.step();
      p.update(DT, order.intent);
      // never under the ground where it stands (落下死はない)
      const g = Math.max(groundHeight(p.feet.x, p.feet.z), area1Ground(p.feet.x, p.feet.z) ?? -Infinity);
      lowest = Math.min(lowest, p.feet.y - g);
    }
    expect(pilot.done, `stuck at ${pilot.current} after ${t.toFixed(0)} s (steps: ${steps.join(' ')})`).toBe(
      true,
    );
    expect(session.areaCounts().area1).toEqual({ drops: 3, taken: 3 });
    expect(session.orbPlace).toBe('hand');
    expect(session.shortcutProgress('area1')).toBe(1);
    const [cx, , cz] = AREA1_PLAZA.center;
    expect(Math.hypot(p.feet.x - cx, p.feet.z - cz)).toBeLessThan(AREA1_PLAZA.radius);
    expect(p.feet.y).toBeCloseTo(AREA1_Y, 1);
    expect(lowest).toBeGreaterThan(-0.5);
    // about how long it plays (the browser's autoplay waits for it)
    expect(t).toBeLessThan(330);
  });
});
