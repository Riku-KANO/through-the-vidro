import { describe, expect, it } from 'vitest';
import { FLOOR_MATERIALS } from '../../audio/footsteps';
import type { Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS } from '../../layers/materialize';
import { segmentsCutByBox, settledAt, sweepFront } from '../../layers/settle';
import { HAND_ORB_RADIUS, handOrbCenter, orbScreenCircle } from '../orb/hand-pose';
import { PEEK_FOV_DELTA_DEG } from '../orb/peek';
import { BODY_RADIUS, EYE_HEIGHT, FOV_DEFAULT, MAX_SLOPE_DEG } from '../player/constants';
import { LEDGE_DEFAULTS } from '../player/ledge';
import {
  ANNEALER,
  AREA1_CHIMNEY,
  BENCH,
  BENCH_ORB,
  BRIDGE,
  BRIDGE_RISE,
  BRIDGE_SETTLE,
  bridgeFooting,
  CHAIR,
  COMPASS,
  DROP,
  DROP_REACH,
  deckHeight,
  domeWallRadius,
  EAST_ROAD,
  EAST_ROAD_END_X,
  EDGE_Z,
  FACING_DEG,
  FAR,
  FLOOR_ZONES,
  FURNACE,
  FURNACE_FACING,
  FURNACE_MOUTH,
  floorAt,
  GATE,
  GATE_OPEN_DEG,
  GRATE,
  GRATE_CENTER,
  groundHeight,
  LIGHTHOUSE,
  LIGHTHOUSE_BASE,
  LIGHTHOUSE_HEIGHT,
  LIP_HINTS,
  lookDirection,
  MARVER,
  MEMBRANE,
  MOTES_END_Z,
  MOUTH_PIPE_REACH,
  PATH,
  PEDESTAL_BASE,
  PEDESTAL_ORB,
  PEDESTAL_RADIUS,
  PLAZA,
  PLAZA_GATE,
  PLAZA_GATES,
  PLAZA_RIM,
  PLAZA_Y,
  plazaGateAt,
  REACH,
  ROAD,
  SLOPE,
  SPAWNS,
  type SpawnName,
  shelfFrontRadius,
  slopeHeight,
  TEA_CUP,
  TRIAL_SURFACE_WALL,
  TUB_DRIP,
  WATER_TUB,
  WIND_CHIME,
  WORKS_SHELF,
  WORKSHOP,
  WORKSHOP_FLOOR_RADIUS,
  WORKSHOP_OBJECTS,
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

  it('names only materials that have footsteps; brass only where the grate is drawn (S-24)', () => {
    for (const z of FLOOR_ZONES) expect(FLOOR_MATERIALS).toContain(z.material);
    expect(FLOOR_ZONES.filter((z) => z.material === 'brass').map((z) => z.name)).toEqual(['grate']);
  });

  it('the brass grate in front of the furnace sounds brass, and the glass floor around it frosted (S-24)', () => {
    expect(floorAt(...GRATE_CENTER)).toEqual({ zone: 'grate', material: 'brass' });
    const [fx, fz] = FURNACE_FACING;
    const at = (along: number, across: number): [number, number] => [
      GRATE_CENTER[0] + fx * along - fz * across,
      GRATE_CENTER[1] + fz * along + fx * across,
    ];
    const d = GRATE.depth / 2;
    const w = GRATE.width / 2;
    for (const [a, b] of [
      [d - 0.05, w - 0.05],
      [-d + 0.05, w - 0.05],
      [d - 0.05, -w + 0.05],
      [-d + 0.05, -w + 0.05],
    ] as const)
      expect(floorAt(...at(a, b)).material).toBe('brass');
    for (const [a, b] of [
      [d + 0.08, 0],
      [-d - 0.08, 0],
      [0, w + 0.08],
      [0, -w - 0.08],
    ] as const)
      expect(floorAt(...at(a, b))).toEqual({ zone: 'workshop', material: 'frosted' });
  });

  it('somewhere it does not know (off every floor) still answers, with 石畳 — the town’s ground', () => {
    expect(floorAt(30, 30)).toEqual({ zone: 'none', material: 'stone' });
  });
});

describe('the workshop interior (S-24: 職人がついさっきまで仕事をしていた工房, the approved plan)', () => {
  const furniture = Object.values(WORKSHOP_OBJECTS).filter((o) => o.col);

  it('the furniture keeps to the walls, inside the dome', () => {
    for (const o of furniture) {
      const r = Math.hypot(...o.at);
      expect(r, o.name).toBeGreaterThan(2.0);
      expect(r, o.name).toBeLessThan(WORKSHOP_FLOOR_RADIUS - 0.2);
    }
  });

  it('the floor under the skylight stays clear: the grate ends before it, the pipe in the furnace too', () => {
    // the grate's nearest edge to the centre, and the end of the blowpipe left in the furnace's mouth
    const furnaceR = Math.hypot(FURNACE.center[0], FURNACE.center[2]);
    expect(furnaceR - (GRATE.near + GRATE.depth)).toBeGreaterThan(WORKSHOP.oculus);
    expect(furnaceR - MOUTH_PIPE_REACH).toBeGreaterThan(WORKSHOP.oculus);
    // the grate lies between the furnace and the centre, in front of the mouth
    expect(Math.hypot(...GRATE_CENTER)).toBeLessThan(furnaceR);
    const along =
      (FURNACE_MOUTH[0] - FURNACE.center[0]) * FURNACE_FACING[0] +
      (FURNACE_MOUTH[2] - FURNACE.center[2]) * FURNACE_FACING[1];
    expect(along).toBeGreaterThan(0.4);
  });

  it('the stool stands left of the bench with the half-drunk tea by it, the tub left of the marver', () => {
    expect(CHAIR.center[0]).toBeLessThan(BENCH.center[0] - BENCH.size[0] / 2);
    expect(Math.hypot(TEA_CUP[0] - CHAIR.center[0], TEA_CUP[2] - CHAIR.center[2])).toBeLessThan(1.2);
    expect(WATER_TUB.center[0]).toBeLessThan(MARVER.center[0]);
  });

  it('the works shelf follows the leaning wall: every tier stays inside the glass, from the left side round to the back', () => {
    for (const y of WORKS_SHELF.tiers) {
      expect(shelfFrontRadius(y) + WORKS_SHELF.depth).toBeLessThan(domeWallRadius(y + 0.05));
      expect(shelfFrontRadius(y)).toBeGreaterThan(3.4);
    }
    // left (−X) to back (+Z), clear of the annealer at the back and the stool on the left
    expect(WORKS_SHELF.fromDeg).toBeGreaterThan(90);
    expect(WORKS_SHELF.toDeg).toBeLessThan(180);
    const annealerDeg = (Math.atan2(ANNEALER.center[2], ANNEALER.center[0]) * 180) / Math.PI;
    expect(WORKS_SHELF.fromDeg - annealerDeg).toBeGreaterThan(20);
  });

  it('S-25: the drop into the tub falls on its water, inside the rim, off the middle (from the ladle hung on the rim)', () => {
    const [cx, , cz] = WATER_TUB.center;
    const off = Math.hypot(TUB_DRIP[0] - cx, TUB_DRIP[2] - cz);
    // inside the glass wall (2 cm thick at the rim) and not in the middle of the water
    expect(off).toBeLessThan(WATER_TUB.radius - 0.05);
    expect(off).toBeGreaterThan(0.03);
    expect(TUB_DRIP[1]).toBe(WATER_TUB.water);
    // the tub is the only thing there to catch it: not over the brass grate, inside the workshop
    expect(floorAt(TUB_DRIP[0], TUB_DRIP[2]).zone).toBe('workshop');
  });

  it('the wind chime hangs inside the door, above the head', () => {
    expect(Math.abs(WIND_CHIME[0])).toBeLessThan(WORKSHOP.door.halfWidth);
    expect(Math.hypot(WIND_CHIME[0], WIND_CHIME[2])).toBeLessThan(domeWallRadius(WIND_CHIME[1]));
    expect(WIND_CHIME[1] - 0.2).toBeGreaterThan(EYE_HEIGHT + 0.3);
    expect(WIND_CHIME[1]).toBeLessThan(WORKSHOP.door.height);
  });

  it('the fixed views look at what they are named for', () => {
    const eye = (s: (typeof SPAWNS)[SpawnName]): Vec3 => [s.feet[0], EYE_HEIGHT, s.feet[2]];
    const look = (s: (typeof SPAWNS)[SpawnName]) => lookDirection(s.yaw, s.pitch);
    // the fire is straight ahead in front of the furnace, the shelf's middle before the shelf
    expect(angleDeg(eye(SPAWNS.furnace), look(SPAWNS.furnace), FURNACE_MOUTH)).toBeLessThan(20);
    const shelf = WORKSHOP_OBJECTS.shelf.at;
    expect(angleDeg(eye(SPAWNS.shelf), look(SPAWNS.shelf), [shelf[0], 0.88, shelf[1]])).toBeLessThan(15);
    // from the door, looking back, the bench and the furnace are both in view (horizontal half-angle ~51°)
    for (const p of [BENCH_ORB, FURNACE_MOUTH])
      expect(angleDeg(eye(SPAWNS.door), look(SPAWNS.door), p)).toBeLessThan(50);
    // where you wake: the furnace is to the right (out of view), its light falls into the view's right side
    const wake = SPAWNS.bench;
    const right = [Math.cos(wake.yaw), 0, -Math.sin(wake.yaw)];
    const toFire = [FURNACE_MOUTH[0] - wake.feet[0], 0, FURNACE_MOUTH[2] - wake.feet[2]];
    expect((right[0] ?? 0) * (toFire[0] ?? 0) + (right[2] ?? 0) * (toFire[2] ?? 0)).toBeGreaterThan(2);
  });
});

describe('S-34: the close of the prologue (発案者 2026-10-22: 雫の光で橋が定着し、門が開く)', () => {
  const settledAll = (p: Vec3): boolean => settledAt(p, BRIDGE_SETTLE, sweepFront(BRIDGE_SETTLE, 1));

  it('the light runs from the dead end across the bridge to the far shore', () => {
    const [x, y, z] = BRIDGE_SETTLE.direction;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
    // from the pedestal's side (the vidro the drop flew into) toward the far shore
    expect(z).toBeLessThan(-0.99);
    for (const seg of bridgeFooting()) {
      expect(settledAll(seg.min)).toBe(true);
      expect(settledAll(seg.max)).toBe(true);
    }
  });

  it('it fixes the bridge and everything that hints at it, not the pedestal, the rest of the far shore or the gate', () => {
    // the deck is drawn 0.15 m onto each shore, the rails and the lanterns stand on its ends
    expect(settledAll([0, 0, BRIDGE.max[2] + 0.14])).toBe(true);
    expect(settledAll([0, 0, BRIDGE.min[2] - 0.14])).toBe(true);
    expect(settledAll([0.62, 1.3, (BRIDGE.min[2] + BRIDGE.max[2]) / 2])).toBe(true);
    expect(settledAll(TRIAL_SURFACE_WALL.min)).toBe(true);
    expect(settledAll(TRIAL_SURFACE_WALL.max)).toBe(true);
    // the broken edge's shards and stones on the lip, with a margin on the dead end's side (S-34 review round 2: a shard
    // cut by the box's face would be left standing half there)
    expect(settledAll(LIP_HINTS.min)).toBe(true);
    expect(settledAll(LIP_HINTS.max)).toBe(true);
    expect(BRIDGE_SETTLE.box.max[2] - LIP_HINTS.max[2]).toBeGreaterThanOrEqual(0.1);
    // the light motes (a hint of the bridge) all along their drift, up to where they fade over the far shore: none is
    // left coming out of thin air once the bridge is there (S-34 review)
    for (const z of [EDGE_Z + 0.2, (EDGE_Z + MOTES_END_Z) / 2, MOTES_END_Z])
      for (const [x, y] of [
        [-0.6, 0.1],
        [0.6, 1.75],
      ] as const)
        expect(settledAll([x, y, z]), `a mote at ${x}, ${y}, ${z}`).toBe(true);
    expect(settledAll(PEDESTAL_BASE)).toBe(false);
    expect(settledAll(PEDESTAL_ORB)).toBe(false);
    expect(settledAll([0, 0, MOTES_END_Z - 0.3])).toBe(false);
    expect(settledAll([0, 1, GATE.z])).toBe(false);
    // the drop hovers in the box, but the light only runs once it has been taken
    expect(DROP[2]).toBeGreaterThan(MOTES_END_Z);
  });

  it('no footing segment of the bridge is cut by the box: what is drawn settled is what collides settled', () => {
    expect(segmentsCutByBox(bridgeFooting(), BRIDGE_SETTLE.box)).toEqual([]);
  });

  it('past the gate the road is the slope’s first few metres, level up to its brow (S-35: the railing is gone)', () => {
    expect(ROAD.maxZ).toBe(FAR.minZ);
    expect(ROAD.minX).toBe(FAR.minX);
    expect(ROAD.maxX).toBe(FAR.maxX);
    const pastGate = GATE.z - ROAD.minZ;
    expect(pastGate).toBeGreaterThan(2.5);
    expect(pastGate).toBeLessThan(6);
    // the slope starts down where the road ends
    expect(SLOPE.fromZ).toBe(ROAD.minZ);
    expect(slopeHeight((ROAD.minZ + ROAD.maxZ) / 2)).toBe(0);
    // ルール6: the town and its lighthouse lie on beyond it
    expect(LIGHTHOUSE[2]).toBeLessThan(ROAD.minZ - 30);
    expect(floorAt(0, (ROAD.minZ + ROAD.maxZ) / 2)).toEqual({ zone: 'road', material: 'stone' });
  });

  it('the gate’s leaves swing away from the far shore, out over the road’s edges (out of the way, 形は縁で伝える)', () => {
    expect(GATE_OPEN_DEG).toBeGreaterThan(80);
    expect(GATE_OPEN_DEG).toBeLessThan(110);
    const a = (GATE_OPEN_DEG * Math.PI) / 180;
    // the right leaf, hinged at the right post: its far end, open
    const tipX = GATE.halfWidth - GATE.halfWidth * Math.cos(a);
    const tipZ = GATE.z - GATE.halfWidth * Math.sin(a);
    expect(tipX).toBeGreaterThanOrEqual(ROAD.maxX - 0.01);
    expect(tipZ).toBeLessThan(GATE.z - 1);
    expect(tipZ).toBeGreaterThan(ROAD.minZ);
  });

  it('the fixed views of the close look at what they are named for', () => {
    const eye = (s: (typeof SPAWNS)[SpawnName]): Vec3 => [s.feet[0], EYE_HEIGHT, s.feet[2]];
    const look = (s: (typeof SPAWNS)[SpawnName]) => lookDirection(s.yaw, s.pitch);
    // before the gate, the gate ahead; on the road, the slope and the lighthouse beyond it
    expect(SPAWNS.gate.feet[2]).toBeGreaterThan(GATE.z);
    expect(angleDeg(eye(SPAWNS.gate), look(SPAWNS.gate), [0, 1.3, GATE.z])).toBeLessThan(15);
    expect(SPAWNS.road.feet[2]).toBeLessThan(GATE.z);
    expect(SPAWNS.road.feet[2]).toBeGreaterThan(ROAD.minZ);
    expect(
      angleDeg(eye(SPAWNS.road), look(SPAWNS.road), [LIGHTHOUSE[0], LIGHTHOUSE[1] + 20, LIGHTHOUSE[2]]),
    ).toBeLessThan(30);
  });
});

function xz(p: Vec3): [number, number] {
  return [p[0], p[2]];
}

/* ---------- S-35 坂道と中央広場 (進行構造とエリア設計 > 街の配置と序章の締め) ---------- */

describe('S-35: the slope from the gate down to the central plaza', () => {
  const eye = (s: (typeof SPAWNS)[SpawnName]): Vec3 => [s.feet[0], s.feet[1] + EYE_HEIGHT, s.feet[2]];
  const look = (s: (typeof SPAWNS)[SpawnName]) => lookDirection(s.yaw, s.pitch);
  /** Degrees left (+) or right (−) of `dir` on the ground at which `to` lies, seen from `from`. */
  const leftOf = (from: Vec3, dir: Vec3, to: Vec3): number => {
    const a = Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
    const b = Math.atan2(-dir[0], -dir[2]);
    return (Math.atan2(Math.sin(a - b), Math.cos(a - b)) * 180) / Math.PI;
  };

  it('is one way of about 80 m from the gate to the plaza’s rim (街の配置: 門から約 80m の坂道), as wide as the road', () => {
    const fromGate = GATE.z - SLOPE.toZ;
    expect(fromGate).toBeGreaterThan(75);
    expect(fromGate).toBeLessThan(85);
    expect(SLOPE.minX).toBe(ROAD.minX);
    expect(SLOPE.maxX).toBe(ROAD.maxX);
    // it meets the plaza's rim
    expect(Math.abs(PLAZA.center[2] + PLAZA.radius - SLOPE.toZ)).toBeLessThan(0.05);
  });

  it('goes down, never up, level where it meets the road and the plaza, and never steeper than the body climbs', () => {
    expect(slopeHeight(SLOPE.fromZ)).toBe(0);
    expect(slopeHeight(SLOPE.toZ)).toBeCloseTo(-SLOPE.drop, 9);
    expect(PLAZA_Y).toBe(-SLOPE.drop);
    expect(SLOPE.drop).toBeGreaterThan(4);
    let last = 0;
    let steepest = 0;
    const step = 0.05;
    for (let z = SLOPE.fromZ + 2; z >= SLOPE.toZ - 2; z -= step) {
      const h = slopeHeight(z);
      expect(h).toBeLessThanOrEqual(last + 1e-12);
      steepest = Math.max(steepest, (last - h) / step);
      last = h;
    }
    // gentle at both ends (no kink where it meets the level stone)
    expect(slopeHeight(SLOPE.fromZ - 0.5)).toBeGreaterThan(-0.02);
    expect(slopeHeight(SLOPE.toZ + 0.5)).toBeLessThan(-SLOPE.drop + 0.02);
    expect((Math.atan(steepest) * 180) / Math.PI).toBeLessThan(Math.min(20, MAX_SLOPE_DEG));
    // the ground the fall guard measures from follows it
    expect(groundHeight(0, -3)).toBe(0);
    expect(groundHeight(0, (SLOPE.fromZ + SLOPE.toZ) / 2)).toBeCloseTo(-SLOPE.drop / 2, 9);
    expect(groundHeight(0, PLAZA.center[2])).toBe(PLAZA_Y);
  });

  it('is stone underfoot all the way, and so are the plaza and the road past its east gate (足音は石畳)', () => {
    for (let z = SLOPE.fromZ - 0.1; z > SLOPE.toZ; z -= 3)
      expect(floorAt(0.4, z)).toEqual({ zone: 'slope', material: 'stone' });
    expect(floorAt(PLAZA.center[0] + 10, PLAZA.center[2] - 7)).toEqual({ zone: 'plaza', material: 'stone' });
    expect(floorAt(EAST_ROAD_END_X + 1, PLAZA.center[2])).toEqual({ zone: 'east-road', material: 'stone' });
  });

  it('from its brow, the plaza and the broken lighthouse are straight ahead (ルール6), エリア1’s chimney on the left (東, ルール5)', () => {
    const s = SPAWNS.slope;
    expect(s.feet[2]).toBeLessThan(GATE.z);
    expect(s.feet[2]).toBeGreaterThan(SLOPE.fromZ);
    const e = eye(s);
    const ahead = lookDirection(s.yaw, 0);
    expect(Math.abs(leftOf(e, ahead, LIGHTHOUSE))).toBeLessThan(5);
    expect(Math.abs(leftOf(e, ahead, PLAZA.center))).toBeLessThan(5);
    // the lighthouse, base to top, and the plaza in the picture (vertical half view 35°)
    const top: Vec3 = [LIGHTHOUSE[0], LIGHTHOUSE[1] + LIGHTHOUSE_HEIGHT, LIGHTHOUSE[2]];
    expect(angleDeg(e, look(s), top)).toBeLessThan(FOV_DEFAULT / 2 - 5);
    expect(angleDeg(e, look(s), PLAZA.center)).toBeLessThan(FOV_DEFAULT / 2 - 5);
    // looking down at the plaza
    expect(PLAZA.center[1]).toBeLessThan(e[1] - 8);
    // the chimney: left of the lighthouse, and still inside the 16:9 picture's half width (about 51°)
    const chimneyTop: Vec3 = [AREA1_CHIMNEY.foot[0], PLAZA_Y + AREA1_CHIMNEY.top, AREA1_CHIMNEY.foot[2]];
    const left = leftOf(e, ahead, chimneyTop);
    expect(left).toBeGreaterThan(20);
    expect(left).toBeLessThan(47);
    // and over the horizon, against the sky
    expect(chimneyTop[1]).toBeGreaterThan(e[1] + 5);
  });

  it('east is on the left of the way down (左手（東）): the compass turns with the map, the workshop to the north', () => {
    const way = lookDirection(0, 0);
    expect(way[2]).toBeLessThan(0);
    // the way down runs south; east is its left (yaw +90°)
    expect(COMPASS.south).toEqual([0, -1]);
    const left = lookDirection(Math.PI / 2, 0);
    expect(COMPASS.east[0]).toBeCloseTo(left[0], 9);
    expect(COMPASS.east[1]).toBeCloseTo(left[2], 9);
    expect(COMPASS.west[0]).toBeCloseTo(-COMPASS.east[0], 9);
    expect(COMPASS.west[1]).toBeCloseTo(-COMPASS.east[1], 9);
  });
});

describe('S-35: the central plaza, its broken lighthouse and its three gates', () => {
  it('is round, about 25 m across its radius (街の配置: 中央広場は半径約 25m), the lighthouse in its middle, about 40 m tall', () => {
    expect(PLAZA.radius).toBeGreaterThan(20);
    expect(PLAZA.radius).toBeLessThan(30);
    expect(LIGHTHOUSE).toEqual(PLAZA.center);
    expect(LIGHTHOUSE_HEIGHT).toBeGreaterThan(35);
    expect(LIGHTHOUSE_HEIGHT).toBeLessThan(45);
    // a wide plaza round the lighthouse's foot: room to walk round it
    expect(PLAZA.radius - LIGHTHOUSE_BASE.radius).toBeGreaterThan(15);
  });

  it('has three gates, east (エリア1), south (エリア2), west (エリア3): only the east one is open', () => {
    expect(PLAZA_GATES.map((g) => g.name)).toEqual(['east', 'south', 'west']);
    expect(PLAZA_GATES.filter((g) => g.open).map((g) => g.name)).toEqual(['east']);
    expect(PLAZA_GATES.find((g) => g.name === 'east')?.dir).toEqual(COMPASS.east);
    expect(PLAZA_GATES.find((g) => g.name === 'south')?.dir).toEqual(COMPASS.south);
    expect(PLAZA_GATES.find((g) => g.name === 'west')?.dir).toEqual(COMPASS.west);
    // each on the rim, none where the slope comes in (from the north)
    for (const g of PLAZA_GATES) {
      const [x, z] = plazaGateAt(g.dir);
      expect(Math.hypot(x - PLAZA.center[0], z - PLAZA.center[2])).toBeCloseTo(PLAZA.radius, 9);
      expect(g.dir).not.toEqual(COMPASS.north);
    }
    // a gate as wide as the slope and taller than the body; the rim's openings take the gates and the slope
    expect(PLAZA_GATE.halfWidth).toBeGreaterThanOrEqual(SLOPE.maxX);
    expect(PLAZA_GATE.height).toBeGreaterThan(2.5);
    expect(PLAZA_RIM.openingHalf).toBeGreaterThan(PLAZA_GATE.halfWidth);
    expect(PLAZA_RIM.openingHalf).toBeGreaterThan(SLOPE.maxX + BODY_RADIUS);
  });

  it('past the open east gate a few metres of road end at a railing (仮 until S-36), エリア1’s chimney beyond (ルール6, 9)', () => {
    expect(EAST_ROAD.length).toBeGreaterThan(3);
    expect(EAST_ROAD.length).toBeLessThan(10);
    expect(EAST_ROAD_END_X).toBeLessThan(PLAZA.center[0] - PLAZA.radius - 3);
    // from the plaza the chimney rises over the open east gate
    const [gx, gz] = plazaGateAt(COMPASS.east);
    const toGate = Math.atan2(gz - PLAZA.center[2], gx - PLAZA.center[0]);
    const toChimney = Math.atan2(
      AREA1_CHIMNEY.foot[2] - PLAZA.center[2],
      AREA1_CHIMNEY.foot[0] - PLAZA.center[0],
    );
    const apart = Math.abs(Math.atan2(Math.sin(toGate - toChimney), Math.cos(toGate - toChimney)));
    expect((apart * 180) / Math.PI).toBeLessThan(15);
    expect(Math.hypot(AREA1_CHIMNEY.foot[0] - gx, AREA1_CHIMNEY.foot[2] - gz)).toBeGreaterThan(50);
  });

  it('the fixed views look at what they are named for: up at the lighthouse, at the east gate', () => {
    const eye = (s: (typeof SPAWNS)[SpawnName]): Vec3 => [s.feet[0], s.feet[1] + EYE_HEIGHT, s.feet[2]];
    const look = (s: (typeof SPAWNS)[SpawnName]) => lookDirection(s.yaw, s.pitch);
    for (const name of ['plaza', 'east'] as const) {
      const s = SPAWNS[name];
      expect(s.feet[1]).toBe(PLAZA_Y);
      expect(Math.hypot(s.feet[0] - PLAZA.center[0], s.feet[2] - PLAZA.center[2])).toBeLessThan(
        PLAZA.radius - 1,
      );
      expect(Math.hypot(s.feet[0] - PLAZA.center[0], s.feet[2] - PLAZA.center[2])).toBeGreaterThan(
        LIGHTHOUSE_BASE.radius + 1,
      );
    }
    // 見上げる: the view tips up, and takes in the lighthouse from its foot to its broken top
    const p = SPAWNS.plaza;
    expect(p.pitch).toBeGreaterThan(0.3);
    const top: Vec3 = [LIGHTHOUSE[0], LIGHTHOUSE[1] + LIGHTHOUSE_HEIGHT - 3, LIGHTHOUSE[2]];
    expect(angleDeg(eye(p), look(p), top)).toBeLessThan(FOV_DEFAULT / 2);
    expect(angleDeg(eye(p), look(p), [LIGHTHOUSE[0], PLAZA_Y + 2, LIGHTHOUSE[2]])).toBeLessThan(
      FOV_DEFAULT / 2,
    );
    const [gx, gz] = plazaGateAt(COMPASS.east);
    const e = SPAWNS.east;
    expect(angleDeg(eye(e), look(e), [gx, PLAZA_Y + 2, gz])).toBeLessThan(10);
  });
});

describe('S-35: the film at the slope’s entrance (玉を持たずに坂道へは出られない)', () => {
  it('stands in the gate’s arch — the slope’s entrance, its first metres the road — and calls from where the body is held', () => {
    expect(MEMBRANE.z).toBe(GATE.z);
    // the body is eased to a stop LEDGE margin before an edge: well inside the reach of the call
    expect(MEMBRANE.callReach).toBeGreaterThan(LEDGE_DEFAULTS.margin + 0.2);
    // and the call does not reach back to the drop's place: only someone at the gate
    expect(MEMBRANE.z + MEMBRANE.callReach).toBeLessThan(DROP[2]);
  });
});
