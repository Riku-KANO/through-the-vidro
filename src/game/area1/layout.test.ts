import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS } from '../../layers/materialize';
import { boxInsideSphere } from '../../layers/surface';
import { checkAreas, surfaceSegments } from '../area';
import { BODY_RADIUS, EYE_HEIGHT, FOV_DEFAULT, MAX_SLOPE_DEG, SKIN } from '../player/constants';
import {
  COMPASS,
  DROP_REACH,
  EAST_ROAD,
  floorAt,
  PLAZA,
  PLAZA_Y,
  plazaGateAt,
  REACH,
  SPAWNS,
} from '../prologue/layout';
import { MORNING, WORKSHOP_LIGHTS } from '../prologue/room-art';
import {
  AREA1,
  AREA1_CHIMNEY,
  AREA1_GATE,
  AREA1_HOUSES,
  AREA1_PLAZA,
  AREA1_ROAD,
  AREA1_SLOPE,
  AREA1_SPAWNS,
  AREA1_STREET,
  AREA1_Y,
  area1Ground,
  area1RimArcs,
  area1SlopeHeight,
  DAY,
  daylightAt,
  type House,
  NEXT_LAMPS,
  ROOM1_ALLEY,
  ROOM1_DROP,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
  STREET_NORTH_Z,
  STREET_SOUTH_Z,
  TOWN,
} from './layout';

/** S-36: エリア1's way in and its first room, as numbers (what the drawing, the colliders and the session are made from). */

const sphere = { center: ROOM1_PEDESTAL.orb, radius: MAIN_ORB_RADIUS };
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** The eye of a body whose feet stand at (x, AREA1_Y, z). */
const eyeAt = (x: number, z: number): Vec3 => [x, AREA1_Y + EYE_HEIGHT, z];

/** Does the segment from a to b pass through the box (a house, from deep under the floor up to its roof's top)? */
function segmentHitsBox(a: Vec3, b: Vec3, min: Vec3, max: Vec3): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    const lo = (min[i] ?? 0) - (a[i] ?? 0);
    const hi = (max[i] ?? 0) - (a[i] ?? 0);
    if (Math.abs(d) < 1e-12) {
      if (lo > 0 || hi < 0) return false;
      continue;
    }
    let e0 = lo / d;
    let e1 = hi / d;
    if (e0 > e1) [e0, e1] = [e1, e0];
    t0 = Math.max(t0, e0);
    t1 = Math.min(t1, e1);
    if (t0 > t1) return false;
  }
  return true;
}
/** A house as the eye sees it: up to its roof's bubble (half its narrower side above its walls). */
const houseBox = (h: House): { min: Vec3; max: Vec3 } => ({
  min: [h.minX, AREA1_Y - 20, h.minZ],
  max: [h.maxX, AREA1_Y + h.height + Math.min(h.maxX - h.minX, h.maxZ - h.minZ) / 2, h.maxZ],
});

describe('S-36: the road from the central plaza’s east gate to エリア1’s entrance plaza', () => {
  it('hangs off the central plaza as the prologue has it, east along the compass (S-39: 東 = +X)', () => {
    expect(TOWN.center).toEqual(PLAZA.center);
    expect(TOWN.radius).toBe(PLAZA.radius);
    expect(AREA1_Y).toBe(PLAZA_Y);
    expect(COMPASS.east).toEqual([1, 0]);
    const [gx, gz] = plazaGateAt(COMPASS.east);
    expect(AREA1_ROAD.fromX).toBeCloseTo(gx, 9);
    expect(AREA1_ROAD.z).toBeCloseTo(gz, 9);
  });

  it('is about 60 m long (街の配置: 各エリアの入口の広場まで約 60m) and ends where the entrance plaza begins', () => {
    const length = AREA1_ROAD.toX - AREA1_ROAD.fromX;
    expect(length).toBeGreaterThan(55);
    expect(length).toBeLessThan(65);
    // the prologue's east road is this road (S-35 its first metres)
    expect(EAST_ROAD.length).toBeCloseTo(length, 9);
    expect(EAST_ROAD.halfWidth).toBe(AREA1_ROAD.halfWidth);
    expect(AREA1_PLAZA.center[0] - AREA1_PLAZA.radius).toBeCloseTo(AREA1_ROAD.toX, 9);
    expect(AREA1_PLAZA.center[2]).toBe(AREA1_ROAD.z);
    // stone underfoot all the way, and in the plaza
    for (let x = AREA1_ROAD.fromX + 0.5; x < AREA1_ROAD.toX; x += 5)
      expect(floorAt(x, AREA1_ROAD.z).material).toBe('stone');
    expect(floorAt(AREA1_PLAZA.center[0], AREA1_PLAZA.center[2])).toEqual({
      zone: 'area1-plaza',
      material: 'stone',
    });
  });

  it('the sky goes from before dawn to morning along it, by where you stand: none at the gate, all of it at the plaza', () => {
    expect(daylightAt(AREA1_ROAD.fromX)).toBe(0);
    expect(daylightAt(TOWN.center[0])).toBe(0);
    expect(daylightAt(DAY.fromX)).toBe(0);
    expect(daylightAt(DAY.toX)).toBe(1);
    expect(daylightAt(AREA1_PLAZA.center[0])).toBe(1);
    expect(daylightAt((DAY.fromX + DAY.toX) / 2)).toBeCloseTo(0.5, 9);
    // only ever more toward the east, so walking back it goes back the same way (引き返せば戻る)
    let last = -1;
    for (let x = AREA1_ROAD.fromX; x <= AREA1_ROAD.toX; x += 0.5) {
      const d = daylightAt(x);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
    // the transition takes most of the road (no sudden change: 切り替えはなし)
    expect(DAY.toX - DAY.fromX).toBeGreaterThan(40);
    // the view on the road stands where the sky is half way
    const road = AREA1_SPAWNS['area1-road'];
    expect(daylightAt(road.feet[0])).toBeGreaterThan(0.3);
    expect(daylightAt(road.feet[0])).toBeLessThan(0.7);
  });

  it('the morning sun stands on the dawn’s side (東), higher than the dawn (エリア1は朝)', () => {
    const [dx, , dz] = WORKSHOP_LIGHTS.sky.dawn;
    const [mx, my, mz] = MORNING.sun;
    expect(mx * COMPASS.east[0] + mz * COMPASS.east[1]).toBeGreaterThan(0.5);
    // the same bearing as the dawn (the sun has risen there), within 20°
    const apart = Math.acos((mx * dx + mz * dz) / Math.hypot(mx, mz) / Math.hypot(dx, dz));
    expect((apart * 180) / Math.PI).toBeLessThan(20);
    const elevation = Math.atan2(my, Math.hypot(mx, mz));
    const { at, target } = WORKSHOP_LIGHTS.sun;
    const dawnElevation = Math.atan2(at[1] - target[1], Math.hypot(at[0] - target[0], at[2] - target[2]));
    expect(elevation).toBeGreaterThan(dawnElevation + (10 * Math.PI) / 180);
  });
});

describe('S-36: the entrance plaza (入口の広場)', () => {
  it('its rim is a balustrade open only to the road (west) and the street (east): the edge stops you softly', () => {
    const arcs = area1RimArcs();
    expect(arcs).toHaveLength(2);
    const half = Math.asin(1.75 / AREA1_PLAZA.radius);
    const covered = arcs.reduce((n, a) => n + (a.to - a.from), 0);
    expect(covered + 4 * half).toBeCloseTo(2 * Math.PI, 9);
    // the openings take the road and the street with the body
    expect(1.75).toBeGreaterThan(AREA1_ROAD.halfWidth + BODY_RADIUS);
    expect(1.75).toBeGreaterThan(AREA1_STREET.halfWidth);
  });

  it('from it, the workshop street’s chimney stands up the hill, over every house (ルール5・6)', () => {
    const v = AREA1_SPAWNS['area1-plaza'];
    const e: Vec3 = [v.feet[0], v.feet[1] + EYE_HEIGHT, v.feet[2]];
    const top: Vec3 = [AREA1_CHIMNEY.foot[0], TOWN.center[1] + AREA1_CHIMNEY.top, AREA1_CHIMNEY.foot[2]];
    for (const h of AREA1_HOUSES) {
      const b = houseBox(h);
      expect(segmentHitsBox(e, top, b.min, b.max), `house at x ${h.minX}..${h.maxX}`).toBe(false);
    }
    // and in the picture: within the vertical half view, its top a little below the top edge
    const cp = Math.cos(v.pitch);
    const look: Vec3 = [-Math.sin(v.yaw) * cp, Math.sin(v.pitch), -Math.cos(v.yaw) * cp];
    const to: Vec3 = [top[0] - e[0], top[1] - e[1], top[2] - e[2]];
    const l = Math.hypot(...to);
    const angle = (Math.acos((to[0] * look[0] + to[1] * look[1] + to[2] * look[2]) / l) * 180) / Math.PI;
    expect(angle).toBeLessThan(FOV_DEFAULT / 2 - 3);
    // the chimney stands on the summit, the top of the slope up from the street
    expect(AREA1_CHIMNEY.foot[1]).toBeCloseTo(area1SlopeHeight(AREA1_SLOPE.toZ), 9);
    expect(Math.abs(AREA1_CHIMNEY.foot[2] - AREA1_SLOPE.toZ)).toBeLessThan(2);
  });

  it('the houses stand round it, never on it, nor on the road, the street or the alley', () => {
    const [cx, , cz] = AREA1_PLAZA.center;
    for (const h of AREA1_HOUSES) {
      // the nearest point of the house to the plaza's centre is outside its rim
      const nx = Math.min(Math.max(cx, h.minX), h.maxX);
      const nz = Math.min(Math.max(cz, h.minZ), h.maxZ);
      expect(Math.hypot(nx - cx, nz - cz), `house at x ${h.minX}`).toBeGreaterThan(AREA1_PLAZA.radius - 0.2);
      const overlaps = (minX: number, maxX: number, minZ: number, maxZ: number) =>
        h.maxX > minX + 1e-9 && h.minX < maxX - 1e-9 && h.maxZ > minZ + 1e-9 && h.minZ < maxZ - 1e-9;
      expect(overlaps(AREA1_ROAD.fromX, AREA1_ROAD.toX, AREA1_ROAD.z - 1.4, AREA1_ROAD.z + 1.4)).toBe(false);
      expect(overlaps(AREA1_STREET.fromX, AREA1_STREET.toX, STREET_SOUTH_Z, STREET_NORTH_Z)).toBe(false);
      expect(overlaps(ROOM1_ALLEY.minX, ROOM1_ALLEY.maxX, ROOM1_ALLEY.minZ, ROOM1_ALLEY.maxZ)).toBe(false);
      expect(
        overlaps(
          AREA1_SLOPE.x - AREA1_SLOPE.halfWidth,
          AREA1_SLOPE.x + AREA1_SLOPE.halfWidth,
          AREA1_GATE.z - 30,
          AREA1_SLOPE.fromZ,
        ),
      ).toBe(false);
    }
  });
});

describe('S-36: 部屋1「崩れた壁の路地」 — the surface-only wall alone, somewhere safe (パズル設計 > ギミック一覧)', () => {
  const segments = surfaceSegments(ROOM1_WALL);
  const wall = ROOM1_WALL.box;

  it('is one room of the area: a pedestal, the drop, the wall (the session plays it: game/area)', () => {
    expect(AREA1.rooms.map((r) => r.id)).toEqual(['area1-room1']);
    expect(checkAreas([AREA1], MAIN_ORB_RADIUS)).toEqual([]);
  });

  it('the whole wall lies inside the placed vidro’s sphere: every segment is cut (S-28), with room to spare', () => {
    expect(segments.length).toBeGreaterThan(10);
    for (const s of segments) expect(boxInsideSphere(s, sphere), s.id).toBe(true);
    // the farthest corner stays a quarter metre inside the film
    expect(boxInsideSphere(wall, { ...sphere, radius: MAIN_ORB_RADIUS - 0.25 })).toBe(true);
  });

  it('the wall stops the alley wall to wall, taller than the body and the eye (no way past or over it)', () => {
    expect(wall.min[0]).toBe(ROOM1_ALLEY.minX);
    expect(wall.max[0]).toBe(ROOM1_ALLEY.maxX);
    expect(wall.min[1]).toBe(AREA1_Y);
    expect(wall.max[1] - AREA1_Y).toBeGreaterThan(EYE_HEIGHT + 0.5);
    // the alley's sides and end are houses that stop the body (it is a cul-de-sac)
    const blocks = (x: number, z: number) =>
      AREA1_HOUSES.some((h) => h.collide && x >= h.minX && x <= h.maxX && z >= h.minZ && z <= h.maxZ);
    for (let z = ROOM1_ALLEY.minZ + 0.1; z < ROOM1_ALLEY.maxZ; z += 0.25) {
      expect(blocks(ROOM1_ALLEY.minX - 0.05, z), `west side at z ${z}`).toBe(true);
      expect(blocks(ROOM1_ALLEY.maxX + 0.05, z), `east side at z ${z}`).toBe(true);
    }
    for (let x = ROOM1_ALLEY.minX + 0.05; x < ROOM1_ALLEY.maxX; x += 0.25)
      expect(blocks(x, ROOM1_ALLEY.maxZ + 0.05), `end at x ${x}`).toBe(true);
  });

  it('the drop hovers behind the wall, inside the sphere (玉越しに見えて、置けば触れられる), in reach from just behind the wall', () => {
    const d = ROOM1_DROP.at;
    expect(d[2]).toBeGreaterThan(wall.max[2]);
    expect(dist(d, ROOM1_PEDESTAL.orb)).toBeLessThan(MAIN_ORB_RADIUS - 0.3);
    const behind = wall.max[2] + BODY_RADIUS + SKIN + 0.05;
    expect(dist(eyeAt(d[0], behind), d)).toBeLessThan(DROP_REACH - 0.3);
    expect(d[2]).toBeLessThan(ROOM1_ALLEY.maxZ - 0.6);
  });

  it('nowhere behind the wall is the pedestal in reach: the vidro cannot be taken from there and shut you in (原則3)', () => {
    const behind = wall.max[2] + BODY_RADIUS + SKIN;
    for (let x = ROOM1_ALLEY.minX + BODY_RADIUS; x <= ROOM1_ALLEY.maxX - BODY_RADIUS; x += 0.1)
      for (let z = behind; z <= ROOM1_ALLEY.maxZ - BODY_RADIUS; z += 0.1)
        expect(dist(eyeAt(x, z), ROOM1_PEDESTAL.orb), `${x}, ${z}`).toBeGreaterThan(REACH + 0.1);
  });

  it('the pedestal stands just in from the street, in reach before the wall, and leaves the way past it open', () => {
    expect(ROOM1_PEDESTAL.base[2] - ROOM1_ALLEY.minZ).toBeGreaterThan(0.8);
    expect(ROOM1_PEDESTAL.base[2]).toBeLessThan(wall.min[2] - 1);
    const front = wall.min[2] - BODY_RADIUS - SKIN - 0.4;
    expect(dist(eyeAt(ROOM1_PEDESTAL.base[0] - 0.8, front), ROOM1_PEDESTAL.orb)).toBeLessThan(REACH);
    // the gap beside it (its foot 0.26 m) is wide enough for the body, with room
    const gap = ROOM1_PEDESTAL.base[0] - 0.26 - ROOM1_ALLEY.minX;
    expect(gap).toBeGreaterThan(2 * (BODY_RADIUS + SKIN) + 0.5);
    // the view before the alley sees the pedestal on its left and the wall ahead
    const v = AREA1_SPAWNS['area1-alley'];
    const right: [number, number] = [Math.cos(v.yaw), -Math.sin(v.yaw)];
    const toPedestal = [ROOM1_PEDESTAL.base[0] - v.feet[0], ROOM1_PEDESTAL.base[2] - v.feet[2]] as const;
    expect(toPedestal[0] * right[0] + toPedestal[1] * right[1]).toBeLessThan(0);
  });
});

describe('S-36: the slope’s foot and its shut gate (仮の行き止まり until S-40)', () => {
  it('turns south off the street’s end and climbs gently to the gate, level where it leaves the street', () => {
    expect(AREA1_SLOPE.x + AREA1_SLOPE.halfWidth).toBeLessThan(AREA1_STREET.toX + 0.01);
    expect(area1SlopeHeight(AREA1_SLOPE.fromZ)).toBe(AREA1_Y);
    expect(area1SlopeHeight(AREA1_GATE.z)).toBeGreaterThan(AREA1_Y + 0.5);
    let steepest = 0;
    for (let z = AREA1_SLOPE.fromZ; z > AREA1_SLOPE.toZ; z -= 0.25) {
      const k = (area1SlopeHeight(z - 0.25) - area1SlopeHeight(z)) / 0.25;
      expect(k).toBeGreaterThanOrEqual(0);
      steepest = Math.max(steepest, (Math.atan(k) * 180) / Math.PI);
    }
    expect(steepest).toBeLessThan(MAX_SLOPE_DEG - 5);
  });

  it('the gate is its only end: houses close both sides from the street to past the gate', () => {
    const blocks = (x: number, z: number) =>
      AREA1_HOUSES.some((h) => h.collide && x >= h.minX && x <= h.maxX && z >= h.minZ && z <= h.maxZ);
    for (let z = AREA1_SLOPE.fromZ - 0.1; z > AREA1_GATE.z - 1; z -= 0.25) {
      expect(blocks(AREA1_SLOPE.x - AREA1_SLOPE.halfWidth - 0.05, z), `west at ${z}`).toBe(true);
      expect(blocks(AREA1_SLOPE.x + AREA1_SLOPE.halfWidth + 0.05, z), `east at ${z}`).toBe(true);
    }
    expect(AREA1_GATE.halfWidth).toBe(AREA1_SLOPE.halfWidth);
  });

  it('once the drop is taken, the lamps light from the alley toward the gate (次の部屋の方向が見える)', () => {
    const mouth: Vec3 = [(ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2, AREA1_Y + 2, ROOM1_ALLEY.minZ];
    let last = -1;
    for (const p of NEXT_LAMPS) {
      const d = dist(p, mouth);
      expect(d).toBeGreaterThan(last);
      last = d;
    }
    const lastLamp = NEXT_LAMPS.at(-1) as Vec3;
    expect(lastLamp[2]).toBeCloseTo(AREA1_GATE.z, 9);
    expect(lastLamp[0]).toBeCloseTo(AREA1_SLOPE.x, 9);
  });
});

describe('S-36: where you can stand in エリア1', () => {
  it('every view of it stands on stone on its ground, and the prologue’s spawns know them', () => {
    for (const [name, s] of Object.entries(AREA1_SPAWNS)) {
      expect(floorAt(s.feet[0], s.feet[2]).material, name).toBe('stone');
      expect(floorAt(s.feet[0], s.feet[2]).zone, name).not.toBe('none');
      expect(SPAWNS[name as keyof typeof SPAWNS], name).toEqual(s);
      const g = area1Ground(s.feet[0], s.feet[2]) ?? (name === 'area1-road' ? AREA1_Y : null);
      expect(g, name).not.toBeNull();
      expect(s.feet[1]).toBeCloseTo(g as number, 9);
    }
  });
});
