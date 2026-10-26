import { describe, expect, it } from 'vitest';
import { type Box, sphereOverlapsBox, type Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS } from '../../layers/materialize';
import { sweepSpan } from '../../layers/settle';
import { boxInsideSphere, cutSurfaceIds } from '../../layers/surface';
import { checkAreas, footingOf, surfaceSegments } from '../area';
import { BODY_RADIUS, EYE_HEIGHT, FOV_DEFAULT, MAX_SLOPE_DEG, SKIN, STEP_HEIGHT } from '../player/constants';
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
  AREA1_GLIMMERS,
  AREA1_HOUSES,
  AREA1_PLAZA,
  AREA1_RIM,
  AREA1_ROAD,
  AREA1_SHORTCUT,
  AREA1_SLOPE,
  AREA1_SPAWNS,
  AREA1_STREET,
  AREA1_Y,
  area1Ground,
  area1RimArcs,
  area1SlopeHeight,
  COURT_Y,
  DAY,
  daylightAt,
  eastOf,
  eastX,
  type House,
  MOTE_PATHS,
  motePathAt,
  NEXT_LAMPS,
  NEXT_LAMPS_BY_ROOM,
  ROOM1_ALLEY,
  ROOM1_DROP,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
  ROOM2,
  ROOM2_BALCONY,
  ROOM2_COURT,
  ROOM2_DROP,
  ROOM2_PEDESTAL_A,
  ROOM2_PEDESTAL_B,
  ROOM2_RAIL,
  ROOM2_STAIRS,
  ROOM2_STAIRS_FOOT_Z,
  ROOM2_WALL,
  ROOM3,
  ROOM3_BRIDGE_N,
  ROOM3_BRIDGE_S,
  ROOM3_DROP,
  ROOM3_EDGE,
  ROOM3_PEDESTAL_N,
  ROOM3_PEDESTAL_S,
  ROOM3_ROOF_N,
  ROOM3_ROOF_S,
  ROOM3_TERRACE,
  ROOM3_VALLEY,
  room2StairSegments,
  SHORTCUT_GATE,
  SHORTCUT_LEGS,
  SHORTCUT_RISE,
  SHORTCUT_STAIRS,
  SHORTCUT_TREAD,
  STREET_NORTH_Z,
  STREET_SOUTH_Z,
  SUMMIT_Y,
  shortcutSegments,
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
  max: [
    h.maxX,
    AREA1_Y + h.height + (h.roof === 'flat' ? 0 : Math.min(h.maxX - h.minX, h.maxZ - h.minZ) / 2),
    h.maxZ,
  ],
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
    const length = eastOf(AREA1_ROAD.toX) - eastOf(AREA1_ROAD.fromX);
    expect(AREA1_ROAD.length).toBeCloseTo(length, 9);
    expect(length).toBeGreaterThan(55);
    expect(length).toBeLessThan(65);
    // the prologue's east road is this road (S-35 its first metres)
    expect(EAST_ROAD.length).toBeCloseTo(length, 9);
    expect(EAST_ROAD.halfWidth).toBe(AREA1_ROAD.halfWidth);
    expect(eastOf(AREA1_PLAZA.center[0]) - AREA1_PLAZA.radius).toBeCloseTo(eastOf(AREA1_ROAD.toX), 9);
    expect(AREA1_PLAZA.center[2]).toBe(AREA1_ROAD.z);
    // stone underfoot all the way, and in the plaza
    for (let d = eastOf(AREA1_ROAD.fromX) + 0.5; d < eastOf(AREA1_ROAD.toX); d += 5)
      expect(floorAt(eastX(d), AREA1_ROAD.z).material).toBe('stone');
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
    for (let e = eastOf(AREA1_ROAD.fromX); e <= eastOf(AREA1_ROAD.toX); e += 0.5) {
      const d = daylightAt(eastX(e));
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
    // the transition takes most of the road (no sudden change: 切り替えはなし)
    expect(eastOf(DAY.toX) - eastOf(DAY.fromX)).toBeGreaterThan(40);
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
  it('its rim is a balustrade open only to the road (west), the street (east) and (S-40) the shortcut’s foot (south)', () => {
    const arcs = area1RimArcs();
    expect(arcs).toHaveLength(3);
    const half = Math.asin(1.75 / AREA1_PLAZA.radius);
    const covered = arcs.reduce((n, a) => n + (a.to - a.from), 0);
    expect(covered + 6 * half).toBeCloseTo(2 * Math.PI, 9);
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
    // the chimney stands on the summit, the top of the slope up from the street (S-40: east of where it arrives)
    expect(AREA1_CHIMNEY.foot[1]).toBeCloseTo(area1SlopeHeight(AREA1_SLOPE.toZ), 9);
    expect(Math.abs(AREA1_CHIMNEY.foot[2] - AREA1_SLOPE.toZ)).toBeLessThan(2);
    expect(eastOf(AREA1_CHIMNEY.foot[0])).toBeGreaterThan(eastOf(AREA1_SLOPE.x));
  });

  it('the houses stand round it, never on it, nor on the road, the street, the alley, the slope, the courtyard, the summit', () => {
    const [cx, , cz] = AREA1_PLAZA.center;
    for (const h of AREA1_HOUSES) {
      // the nearest point of the house to the plaza's centre is outside its rim
      const nx = Math.min(Math.max(cx, h.minX), h.maxX);
      const nz = Math.min(Math.max(cz, h.minZ), h.maxZ);
      expect(Math.hypot(nx - cx, nz - cz), `house at x ${h.minX}`).toBeGreaterThan(AREA1_PLAZA.radius - 0.2);
      const overlaps = (minX: number, maxX: number, minZ: number, maxZ: number) =>
        h.maxX > minX + 1e-9 && h.minX < maxX - 1e-9 && h.maxZ > minZ + 1e-9 && h.minZ < maxZ - 1e-9;
      const road = [AREA1_ROAD.fromX, AREA1_ROAD.toX].sort((a, b) => a - b) as [number, number];
      expect(overlaps(road[0], road[1], AREA1_ROAD.z - 1.4, AREA1_ROAD.z + 1.4)).toBe(false);
      expect(overlaps(AREA1_STREET.minX, AREA1_STREET.maxX, STREET_SOUTH_Z, STREET_NORTH_Z)).toBe(false);
      expect(overlaps(ROOM1_ALLEY.minX, ROOM1_ALLEY.maxX, ROOM1_ALLEY.minZ, ROOM1_ALLEY.maxZ)).toBe(false);
      expect(
        overlaps(
          AREA1_SLOPE.x - AREA1_SLOPE.halfWidth,
          AREA1_SLOPE.x + AREA1_SLOPE.halfWidth,
          AREA1_SLOPE.toZ,
          AREA1_SLOPE.fromZ,
        ),
      ).toBe(false);
      // S-40: none on the courtyard, the balcony, the summit's terrace or the shortcut's stairs; on the roofs across the
      // valley only the houses whose flat tops they are
      for (const r of [ROOM2_COURT, ROOM2_BALCONY, ROOM3_TERRACE])
        expect(overlaps(r.minX, r.maxX, r.minZ, r.maxZ), `house at x ${h.minX}`).toBe(false);
      expect(
        overlaps(SHORTCUT_STAIRS.minX, SHORTCUT_STAIRS.maxX, SHORTCUT_STAIRS.topZ, SHORTCUT_STAIRS.landingZ),
      ).toBe(false);
      if (h.roof !== 'flat')
        for (const r of [ROOM3_ROOF_N, ROOM3_ROOF_S])
          expect(overlaps(r.minX, r.maxX, r.minZ, r.maxZ), `house at x ${h.minX}`).toBe(false);
    }
  });
});

describe('S-36: 部屋1「崩れた壁の路地」 — the surface-only wall alone, somewhere safe (パズル設計 > ギミック一覧)', () => {
  const segments = surfaceSegments(ROOM1_WALL);
  const wall = ROOM1_WALL.box;

  it('is one room of the area: a pedestal, the drop, the wall (the session plays it: game/area)', () => {
    expect(AREA1.rooms.map((r) => r.id)).toEqual(['area1-room1', 'area1-room2', 'area1-room3']);
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

/** A sphere of the main vidro placed on a pedestal. */
const sphereOf = (p: { orb: Vec3 }) => ({ center: p.orb, radius: MAIN_ORB_RADIUS });
/** Does anything of the houses stand between two points (houses as the eye sees them, roofs included)? */
const hidden = (a: Vec3, b: Vec3): string[] =>
  AREA1_HOUSES.filter((h) => {
    const box = houseBox(h);
    return segmentHitsBox(a, b, box.min, box.max);
  }).map((h) => `${h.zone} house at x ${h.minX.toFixed(1)}..${h.maxX.toFixed(1)}, z ${h.minZ}..${h.maxZ}`);
/** Is (x, z) inside a house that stops the body? */
const blocks = (x: number, z: number) =>
  AREA1_HOUSES.some((h) => h.collide && x >= h.minX && x <= h.maxX && z >= h.minZ && z <= h.maxZ);
/** The walkable points of a tread or a bridge's deck (the body's centre on it, a body's radius in from its sides). */
function feetOn(seg: Box, step = 0.2): Vec3[] {
  const out: Vec3[] = [];
  const r = BODY_RADIUS;
  for (let x = seg.min[0] + r; x <= seg.max[0] - r + 1e-9; x += step)
    for (let z = seg.min[2]; z <= seg.max[2] + 1e-9; z += step) out.push([x, seg.max[1], z]);
  for (let z = seg.min[2] + r; z <= seg.max[2] - r + 1e-9; z += step)
    for (let x = seg.min[0]; x <= seg.max[0] + 1e-9; x += step) out.push([x, seg.max[1], z]);
  return out;
}

describe('S-40: the slope — east from the plaza, then south up to the summit in two flights, the courtyard on its landing', () => {
  it('turns south off the street’s end and climbs to the summit (頂) by a level landing, never too steep, level at each end', () => {
    expect(eastOf(AREA1_SLOPE.x) + AREA1_SLOPE.halfWidth).toBeLessThan(eastOf(AREA1_STREET.endX) + 0.01);
    expect(area1SlopeHeight(AREA1_SLOPE.fromZ)).toBe(AREA1_Y);
    expect(area1SlopeHeight(AREA1_SLOPE.toZ)).toBe(SUMMIT_Y);
    expect(SUMMIT_Y - AREA1_Y).toBe(AREA1_SLOPE.rise);
    for (let z = AREA1_SLOPE.landingFromZ; z >= AREA1_SLOPE.landingToZ; z -= 0.2)
      expect(area1SlopeHeight(z)).toBe(COURT_Y);
    let steepest = 0;
    for (let z = AREA1_SLOPE.fromZ; z > AREA1_SLOPE.toZ - 1; z -= 0.25) {
      const k = (area1SlopeHeight(z - 0.25) - area1SlopeHeight(z)) / 0.25;
      expect(k).toBeGreaterThanOrEqual(0);
      steepest = Math.max(steepest, (Math.atan(k) * 180) / Math.PI);
    }
    expect(steepest).toBeLessThan(MAX_SLOPE_DEG - 5);
    // the landing is long enough to stop on and turn into the courtyard; the courtyard opens off it
    expect(AREA1_SLOPE.landingFromZ - AREA1_SLOPE.landingToZ).toBeGreaterThan(3);
    expect(ROOM2_COURT.minX).toBeCloseTo(AREA1_SLOPE.x + AREA1_SLOPE.halfWidth, 9);
  });

  it('houses close both sides all the way up, but where the courtyard opens off the landing (east)', () => {
    const west = AREA1_SLOPE.x - AREA1_SLOPE.halfWidth - 0.05;
    const east = AREA1_SLOPE.x + AREA1_SLOPE.halfWidth + 0.05;
    for (let z = AREA1_SLOPE.fromZ - 0.1; z > AREA1_SLOPE.toZ + 0.1; z -= 0.25) {
      expect(blocks(west, z), `west at ${z}`).toBe(true);
      const intoCourt = z < ROOM2_BALCONY.minZ && z > ROOM2_COURT.minZ;
      // the balcony's side stops you as a wall where it meets the slope (more than a step above it)
      const underBalcony = z >= ROOM2_BALCONY.minZ && z <= ROOM2_BALCONY.maxZ;
      if (intoCourt) expect(blocks(east, z), `the courtyard's opening at ${z}`).toBe(false);
      else if (underBalcony) expect(ROOM2_BALCONY.y - area1SlopeHeight(z)).toBeGreaterThan(STEP_HEIGHT + 0.5);
      else expect(blocks(east, z), `east at ${z}`).toBe(true);
    }
    // the courtyard is level with the landing where they meet (and the second flight's foot by it is less than a step up)
    expect(area1SlopeHeight(ROOM2_COURT.minZ) - COURT_Y).toBeLessThan(STEP_HEIGHT);
  });

  it('the summit’s terrace is where it arrives: its other edges are houses or the valley’s lip', () => {
    expect(ROOM3_TERRACE.maxZ).toBe(AREA1_SLOPE.toZ);
    for (let x = ROOM3_TERRACE.minX + 0.2; x < AREA1_SLOPE.x - AREA1_SLOPE.halfWidth; x += 0.25)
      expect(blocks(x, ROOM3_TERRACE.maxZ + 0.05), `north edge at x ${x}`).toBe(true);
    for (let x = ROOM3_TERRACE.minX + 0.2; x < ROOM3_TERRACE.maxX; x += 0.25)
      expect(blocks(x, ROOM3_TERRACE.minZ - 0.05), `south edge at x ${x}`).toBe(true);
    for (let z = ROOM3_TERRACE.minZ + 0.2; z < ROOM3_TERRACE.maxZ; z += 0.25)
      expect(blocks(ROOM3_TERRACE.maxX + 0.05, z), `east edge at z ${z}`).toBe(true);
    expect(ROOM3_TERRACE.minX).toBe(ROOM3_VALLEY.maxX);
  });
});

describe('S-40: 部屋2「二つの台座の中庭」 — two pedestals whose spheres overlap, a back-layer stair, a surface-only wall', () => {
  it('under its stair (there or not) the ground is the courtyard’s floor: the fall guard never pulls at a body standing there', () => {
    for (let x = ROOM2_STAIRS.minX; x <= ROOM2_STAIRS.maxX; x += 0.2)
      for (let z = ROOM2_STAIRS_FOOT_Z; z < ROOM2_STAIRS.topZ; z += 0.1) expect(area1Ground(x, z)).toBe(COURT_Y);
  });

  const a = sphereOf(ROOM2_PEDESTAL_A);
  const b = sphereOf(ROOM2_PEDESTAL_B);
  const treads = room2StairSegments();
  const wallSegments = surfaceSegments(ROOM2_WALL);

  it('is a room of the area: its two pedestals, its drop, the wall and the stair (the session plays it)', () => {
    expect(ROOM2.pedestals.map((p) => p.id)).toEqual([ROOM2_PEDESTAL_A.id, ROOM2_PEDESTAL_B.id]);
    expect(ROOM2.drop).toBe(ROOM2_DROP);
    expect(ROOM2.surface).toEqual([ROOM2_WALL]);
    expect(treads).toHaveLength(ROOM2_STAIRS.steps);
    // 二重の台座: 範囲が重なる位置にある2つの台座
    expect(
      Math.hypot(
        ...([0, 1, 2].map((i) => (a.center[i] ?? 0) - (b.center[i] ?? 0)) as [number, number, number]),
      ),
    ).toBeLessThan(2 * MAIN_ORB_RADIUS - 2);
  });

  it('A’s sphere holds the whole stair (you climb to the balcony) and reaches none of the wall, nor the drop', () => {
    for (const seg of treads) {
      expect(sphereOverlapsBox(a, seg), seg.id).toBe(true);
      for (const f of feetOn(seg))
        expect(dist(f, a.center), `${seg.id} at ${f}`).toBeLessThan(MAIN_ORB_RADIUS - 0.3);
    }
    for (const seg of wallSegments) expect(sphereOverlapsBox(a, seg), seg.id).toBe(false);
    expect(dist(ROOM2_DROP.at, a.center)).toBeGreaterThan(MAIN_ORB_RADIUS + 0.3);
  });

  it('B’s sphere holds the whole stair, every segment of the wall (cut, S-28) and the drop (両方に届く)', () => {
    for (const seg of treads)
      for (const f of feetOn(seg))
        expect(dist(f, b.center), `${seg.id} at ${f}`).toBeLessThan(MAIN_ORB_RADIUS - 0.3);
    expect(wallSegments.length).toBeGreaterThan(8);
    expect(cutSurfaceIds(wallSegments, [b])).toEqual(wallSegments.map((s) => s.id));
    expect(boxInsideSphere(ROOM2_WALL.box, { ...b, radius: MAIN_ORB_RADIUS - 0.25 })).toBe(true);
    expect(dist(ROOM2_DROP.at, b.center)).toBeLessThan(MAIN_ORB_RADIUS - 0.3);
  });

  it('the stair is the only way up: the balcony stands more than a step above the courtyard and the slope', () => {
    expect(ROOM2_BALCONY.y - COURT_Y).toBeGreaterThan(STEP_HEIGHT * 3);
    // each tread a step up from the last (the balcony one more), climbable
    expect(ROOM2_STAIRS.rise).toBeLessThan(STEP_HEIGHT);
    expect(treads[0]?.min[2]).toBeCloseTo(ROOM2_STAIRS_FOOT_Z, 9);
    expect(treads.at(-1)?.max[2]).toBeCloseTo(ROOM2_BALCONY.minZ, 9);
    expect(ROOM2_BALCONY.y - (treads.at(-1)?.max[1] ?? 0)).toBeCloseTo(ROOM2_STAIRS.rise, 9);
    // the balcony's back and east end are houses
    for (let x = ROOM2_BALCONY.minX + 0.2; x < ROOM2_BALCONY.maxX; x += 0.25)
      expect(blocks(x, ROOM2_BALCONY.maxZ + 0.05), `back at x ${x}`).toBe(true);
    expect(blocks(ROOM2_BALCONY.maxX + 0.05, (ROOM2_BALCONY.minZ + ROOM2_BALCONY.maxZ) / 2)).toBe(true);
  });

  it('the wall closes the balcony from its railing to the house behind, taller than the body; the drop behind it, in reach', () => {
    const w = ROOM2_WALL.box;
    expect(w.min[2]).toBe(ROOM2_BALCONY.minZ);
    expect(w.max[2]).toBe(ROOM2_BALCONY.maxZ);
    expect(w.min[1]).toBe(ROOM2_BALCONY.y);
    expect(w.max[1] - ROOM2_BALCONY.y).toBeGreaterThan(EYE_HEIGHT + 0.2);
    // the stair arrives on the wall's east side; the drop is on its west side
    expect(eastOf(ROOM2_STAIRS.minX)).toBeGreaterThan(eastOf(w.max[0]));
    expect(eastOf(ROOM2_DROP.at[0])).toBeLessThan(eastOf(w.min[0]));
    const behind: Vec3 = [
      eastX(eastOf(w.min[0]) - BODY_RADIUS - SKIN - 0.05),
      ROOM2_BALCONY.y + EYE_HEIGHT,
      ROOM2_DROP.at[2],
    ];
    expect(dist(behind, ROOM2_DROP.at)).toBeLessThan(DROP_REACH - 0.3);
  });

  it('from nowhere on the balcony is either pedestal in reach (the vidro cannot be taken up there, 原則3)', () => {
    const fromRail = ROOM2_BALCONY.minZ + ROOM2_RAIL.thickness / 2 + BODY_RADIUS + SKIN;
    // at the stair's top there is no railing: the body may stand at the very edge
    for (let x = ROOM2_BALCONY.minX + BODY_RADIUS; x <= ROOM2_BALCONY.maxX - BODY_RADIUS; x += 0.1) {
      const atStair = x >= ROOM2_STAIRS.minX && x <= ROOM2_STAIRS.maxX;
      for (let z = atStair ? ROOM2_BALCONY.minZ : fromRail; z <= ROOM2_BALCONY.maxZ - BODY_RADIUS; z += 0.1) {
        const eye: Vec3 = [x, ROOM2_BALCONY.y + EYE_HEIGHT, z];
        for (const p of [ROOM2_PEDESTAL_A, ROOM2_PEDESTAL_B])
          expect(dist(eye, p.orb), `${p.id} from ${x.toFixed(1)}, ${z.toFixed(2)}`).toBeGreaterThan(
            REACH + 0.1,
          );
      }
    }
  });

  it('both pedestals stand on the courtyard’s floor, in reach from it, clear of the stair', () => {
    for (const p of [ROOM2_PEDESTAL_A, ROOM2_PEDESTAL_B]) {
      expect(p.base[1]).toBe(COURT_Y);
      expect(p.base[0] > ROOM2_COURT.minX && p.base[0] < ROOM2_COURT.maxX).toBe(true);
      expect(p.base[2] > ROOM2_COURT.minZ && p.base[2] < ROOM2_BALCONY.minZ - 1).toBe(true);
      expect(dist([p.base[0], COURT_Y + EYE_HEIGHT, p.base[2] - 0.9], p.orb)).toBeLessThan(REACH);
      // the pedestal's foot (0.27 m) does not stand on the stair
      const nx = Math.min(Math.max(p.base[0], ROOM2_STAIRS.minX), ROOM2_STAIRS.maxX);
      const nz = Math.min(Math.max(p.base[2], ROOM2_STAIRS_FOOT_Z), ROOM2_STAIRS.topZ);
      expect(Math.hypot(p.base[0] - nx, p.base[2] - nz), p.id).toBeGreaterThan(0.27 + 0.2);
    }
  });
});

describe('S-40: 部屋3「煙突の見晴らし」 — a valley between the roofs, a bridge to each, a pedestal by each (置くと先が見えない)', () => {
  const n = sphereOf(ROOM3_PEDESTAL_N);
  const s = sphereOf(ROOM3_PEDESTAL_S);
  const bridge = (id: string) => (ROOM3.footing ?? []).find((f) => f.id === id)?.segments ?? [];
  const north = bridge('area1-bridge-n');
  const south = bridge('area1-bridge-s');

  it('is a room of the area: two pedestals, the drop, the two bridges', () => {
    expect(ROOM3.pedestals.map((p) => p.id)).toEqual([ROOM3_PEDESTAL_N.id, ROOM3_PEDESTAL_S.id]);
    expect(ROOM3.drop).toBe(ROOM3_DROP);
    expect(north.length).toBeGreaterThan(4);
    expect(south.length).toBeGreaterThan(4);
  });

  it('each pedestal’s sphere holds its own bridge all the way across, and none of the other’s', () => {
    for (const [own, other, sp] of [
      [north, south, n],
      [south, north, s],
    ] as const) {
      for (const seg of own)
        for (const f of feetOn(seg))
          expect(dist(f, sp.center), `${seg.id} at ${f}`).toBeLessThan(MAIN_ORB_RADIUS - 0.2);
      for (const seg of other) expect(sphereOverlapsBox(sp, seg), seg.id).toBe(false);
    }
  });

  it('the drop is across the north bridge: inside the north pedestal’s sphere, outside the south one’s, in reach from the north roof', () => {
    expect(dist(ROOM3_DROP.at, n.center)).toBeLessThan(MAIN_ORB_RADIUS - 0.3);
    expect(dist(ROOM3_DROP.at, s.center)).toBeGreaterThan(MAIN_ORB_RADIUS + 1);
    const [x, , z] = ROOM3_DROP.at;
    expect(
      x >= ROOM3_ROOF_N.minX && x <= ROOM3_ROOF_N.maxX && z >= ROOM3_ROOF_N.minZ && z <= ROOM3_ROOF_N.maxZ,
    ).toBe(true);
    const stand: Vec3 = [eastX(eastOf(ROOM3_ROOF_N.maxX) - BODY_RADIUS - 0.1), SUMMIT_Y + EYE_HEIGHT, z];
    expect(dist(stand, ROOM3_DROP.at)).toBeLessThan(DROP_REACH - 0.3);
  });

  it('the valley is no way across but by the bridges: wider than a step’s reach, nothing at the summit’s height in it', () => {
    expect(ROOM3_VALLEY.maxX - ROOM3_VALLEY.minX).toBeGreaterThan(1.5);
    expect(ROOM3_ROOF_N.maxX).toBe(ROOM3_VALLEY.minX);
    expect(ROOM3_ROOF_S.maxX).toBe(ROOM3_VALLEY.minX);
    // and the two roofs apart (the south one a dead end)
    expect(ROOM3_ROOF_N.minZ - ROOM3_ROOF_S.maxZ).toBeGreaterThan(1.5);
    for (const h of AREA1_HOUSES) {
      const inValley =
        h.maxX > ROOM3_VALLEY.minX + 0.01 &&
        h.minX < ROOM3_VALLEY.maxX - 0.01 &&
        h.maxZ > ROOM3_ROOF_S.minZ &&
        h.minZ < ROOM3_TERRACE.maxZ;
      if (inValley) expect(AREA1_Y + h.height, `house at x ${h.minX}`).toBeLessThan(SUMMIT_Y - 3);
    }
    // each bridge lands on a roof on one side and the terrace on the other
    for (const b of [ROOM3_BRIDGE_N, ROOM3_BRIDGE_S]) {
      expect(b.min[0]).toBeLessThan(ROOM3_VALLEY.minX);
      expect(b.max[0]).toBeGreaterThan(ROOM3_VALLEY.maxX);
    }
  });

  it('peeking from the edge (端), both bridges and the drop’s roof are in the picture, nothing in the way', () => {
    const eye: Vec3 = [ROOM3_EDGE[0], ROOM3_EDGE[1] + EYE_HEIGHT, ROOM3_EDGE[2]];
    const v = AREA1_SPAWNS['area1-edge'];
    const cp = Math.cos(v.pitch);
    const look: Vec3 = [-Math.sin(v.yaw) * cp, Math.sin(v.pitch), -Math.cos(v.yaw) * cp];
    const ends: Vec3[] = [
      [ROOM3_BRIDGE_N.min[0], SUMMIT_Y, (ROOM3_BRIDGE_N.min[2] + ROOM3_BRIDGE_N.max[2]) / 2],
      [ROOM3_BRIDGE_S.min[0], SUMMIT_Y, (ROOM3_BRIDGE_S.min[2] + ROOM3_BRIDGE_S.max[2]) / 2],
      ROOM3_DROP.at,
    ];
    for (const p of ends) {
      expect(hidden(eye, p)).toEqual([]);
      const to: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const angle =
        (Math.acos((to[0] * look[0] + to[1] * look[1] + to[2] * look[2]) / Math.hypot(...to)) * 180) /
        Math.PI;
      // inside a 16:9 picture's half width (about 51°), with a margin
      expect(angle, `${p}`).toBeLessThan(45);
    }
    // and the edge is by the terrace's lip, between the two pedestals
    expect(eastOf(ROOM3_EDGE[0]) - eastOf(ROOM3_VALLEY.maxX)).toBeLessThan(3);
    expect(ROOM3_EDGE[2]).toBeLessThan(ROOM3_PEDESTAL_N.base[2]);
    expect(ROOM3_EDGE[2]).toBeGreaterThan(ROOM3_PEDESTAL_S.base[2]);
  });

  it('the south roof is a dead end with a reason (ルール9: 光の揺らぎ)', () => {
    const [cx, cz] = [
      (ROOM3_ROOF_S.minX + ROOM3_ROOF_S.maxX) / 2,
      (ROOM3_ROOF_S.minZ + ROOM3_ROOF_S.maxZ) / 2,
    ];
    expect(AREA1_GLIMMERS.some((g) => Math.hypot(g.at[0] - cx, g.at[2] - cz) < 2.5)).toBe(true);
  });
});

describe('S-40: 近道 — the back layer’s stairs from the summit’s ridge down to the entrance plaza, fixed by the third drop’s light', () => {
  const steps = shortcutSegments();

  it('goes from the north roof’s edge down to the entrance plaza’s floor in climbable steps, not too steep', () => {
    expect(steps).toHaveLength(SHORTCUT_STAIRS.steps);
    expect(steps[0]?.min[2]).toBeCloseTo(ROOM3_ROOF_N.maxZ, 9);
    expect(SHORTCUT_RISE).toBeLessThan(STEP_HEIGHT - 0.05);
    expect((Math.atan(SHORTCUT_RISE / SHORTCUT_TREAD) * 180) / Math.PI).toBeLessThan(MAX_SLOPE_DEG - 5);
    expect(steps.at(-1)?.max[1]).toBeCloseTo(AREA1_Y, 9);
    // its landing runs onto the plaza's floor (no seam: the floor's disc is a little wider than its rim)
    const [cx, , cz] = AREA1_PLAZA.center;
    const landing = steps.at(-1) as Box;
    expect(Math.hypot((landing.min[0] + landing.max[0]) / 2 - cx, landing.max[2] - cz)).toBeLessThan(
      AREA1_PLAZA.radius,
    );
    // and it starts at the ridge's west end, within it
    expect(SHORTCUT_STAIRS.minX).toBeGreaterThanOrEqual(ROOM3_ROOF_N.minX);
  });

  it('comes down in the plaza’s south opening, shut by a gate of the surface layer from rail end to rail end', () => {
    const [cx, , cz] = AREA1_PLAZA.center;
    const half = Math.asin(AREA1_RIM.openingHalf / AREA1_PLAZA.radius);
    const south = Math.atan2(COMPASS.south[1], COMPASS.south[0]);
    const g = SHORTCUT_GATE.box;
    for (const a of [south - half, south + half]) {
      const x = cx + Math.cos(a) * AREA1_PLAZA.radius;
      const z = cz + Math.sin(a) * AREA1_PLAZA.radius;
      expect(x).toBeGreaterThan(g.min[0]);
      expect(x).toBeLessThan(g.max[0]);
      expect(Math.abs(z - (g.min[2] + g.max[2]) / 2)).toBeLessThan(0.4);
    }
    expect(g.max[1] - g.min[1]).toBeGreaterThan(EYE_HEIGHT + 0.5);
    expect(g.min[0]).toBeLessThan(SHORTCUT_STAIRS.minX);
    expect(g.max[0]).toBeGreaterThan(SHORTCUT_STAIRS.maxX);
  });

  it('the light’s way: from the north pedestal over the north bridge and the ridge, then down the stairs to the gate, without a break', () => {
    expect(AREA1.shortcut).toBe(AREA1_SHORTCUT);
    const [first, second] = SHORTCUT_LEGS as [(typeof SHORTCUT_LEGS)[0], (typeof SHORTCUT_LEGS)[0]];
    // it starts by the north pedestal (from the vidro, as the prologue's: S-34) and runs west, then north
    expect(eastOf(first.box.max[0])).toBeGreaterThan(eastOf(ROOM3_VALLEY.maxX));
    expect(eastOf(first.box.max[0])).toBeLessThan(eastOf(ROOM3_PEDESTAL_N.base[0]) + 0.5);
    // the first leg ends where the second begins: the stairs' top, at the ridge's end
    expect(first.box.max[2]).toBe(second.box.min[2]);
    expect(second.box.min[2]).toBe(SHORTCUT_STAIRS.topZ);
    expect(sweepSpan(first)[1] - sweepSpan(first)[0]).toBeGreaterThan(10);
    // what it fixes: the north bridge, every step, the gate — nothing of the south bridge, nor of 部屋1・2
    const fixedBy = (id: string) =>
      SHORTCUT_LEGS.some((leg) => {
        const seg = [
          ...footingOf([AREA1]),
          ...surfaceSegments(SHORTCUT_GATE),
          ...surfaceSegments(ROOM2_WALL),
          ...surfaceSegments(ROOM1_WALL),
        ].find((q) => q.id === id) as Box;
        return (
          seg.min[0] >= leg.box.min[0] &&
          seg.max[0] <= leg.box.max[0] &&
          seg.min[1] >= leg.box.min[1] &&
          seg.max[1] <= leg.box.max[1] &&
          seg.min[2] >= leg.box.min[2] &&
          seg.max[2] <= leg.box.max[2]
        );
      });
    for (const seg of [...north(), ...steps, ...surfaceSegments(SHORTCUT_GATE)])
      expect(fixedBy(seg.id), seg.id).toBe(true);
    for (const seg of [
      ...south(),
      ...room2StairSegments(),
      ...surfaceSegments(ROOM2_WALL),
      ...surfaceSegments(ROOM1_WALL),
    ])
      expect(fixedBy(seg.id), seg.id).toBe(false);
    // and no segment of the area is cut in two by a leg (checkAreas)
    expect(checkAreas([AREA1], MAIN_ORB_RADIUS)).toEqual([]);
  });

  it('before it is fixed, its top and its foot are dead ends with a reason (ルール9: 光の揺らぎ)', () => {
    const top: [number, number] = [(SHORTCUT_STAIRS.minX + SHORTCUT_STAIRS.maxX) / 2, SHORTCUT_STAIRS.topZ];
    const foot: [number, number] = [
      (SHORTCUT_STAIRS.minX + SHORTCUT_STAIRS.maxX) / 2,
      SHORTCUT_GATE.box.min[2],
    ];
    for (const [x, z] of [top, foot])
      expect(AREA1_GLIMMERS.some((g) => Math.hypot(g.at[0] - x, g.at[2] - z) < 3)).toBe(true);
  });
});

const north = () => (ROOM3.footing ?? []).find((f) => f.id === 'area1-bridge-n')?.segments ?? [];
const south = () => (ROOM3.footing ?? []).find((f) => f.id === 'area1-bridge-s')?.segments ?? [];

describe('S-40: the way on (ルール5・6・7): lamps, the next place in sight from each room’s door, the motes', () => {
  it('部屋1’s drop lights the lamps from the alley up the first flight to the courtyard’s corner; 部屋2’s up to the summit', () => {
    const mouth: Vec3 = [(ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2, AREA1_Y + 2, ROOM1_ALLEY.minZ];
    let last = -1;
    for (const p of NEXT_LAMPS_BY_ROOM.room1) {
      const d = dist(p, mouth);
      expect(d).toBeGreaterThan(last);
      last = d;
    }
    const corner = NEXT_LAMPS_BY_ROOM.room1.at(-1) as Vec3;
    expect(Math.abs(corner[0] - ROOM2_COURT.minX)).toBeLessThan(0.6);
    expect(Math.abs(corner[2] - ROOM2_BALCONY.minZ)).toBeLessThan(1);
    // over the slope, so it is seen up the first flight (S-40: not behind the houses' line)
    expect(Math.abs(corner[0] - AREA1_SLOPE.x)).toBeLessThan(AREA1_SLOPE.halfWidth);
    expect(NEXT_LAMPS).toBe(NEXT_LAMPS_BY_ROOM.room1);
    // 部屋2's: from the second flight's foot up to the summit, rising
    const r2 = NEXT_LAMPS_BY_ROOM.room2;
    for (let i = 1; i < r2.length; i++) expect((r2[i] as Vec3)[2]).toBeLessThan((r2[i - 1] as Vec3)[2]);
    expect(Math.abs((r2.at(-1) as Vec3)[2] - AREA1_SLOPE.toZ)).toBeLessThan(1);
    // each hangs out in the open, not inside a house (it is seen)
    for (const p of [...NEXT_LAMPS_BY_ROOM.room1, ...r2])
      for (const h of AREA1_HOUSES) {
        const inside = p[0] > h.minX && p[0] < h.maxX && p[2] > h.minZ && p[2] < h.maxZ;
        expect(inside, `lamp at (${p[0]}, ${p[2]}) in the house at x ${h.minX}`).toBe(false);
      }
  });

  it('from 部屋2’s door on the landing the chimney (目印) stands over the houses; from 部屋3’s arrival the roofs across', () => {
    const court = AREA1_SPAWNS['area1-court'];
    const eye = (f: Vec3): Vec3 => [f[0], f[1] + EYE_HEIGHT, f[2]];
    const top: Vec3 = [AREA1_CHIMNEY.foot[0], TOWN.center[1] + AREA1_CHIMNEY.top, AREA1_CHIMNEY.foot[2]];
    expect(hidden(eye(court.feet), top)).toEqual([]);
    const summit = AREA1_SPAWNS['area1-summit'];
    for (const b of [ROOM3_BRIDGE_N, ROOM3_BRIDGE_S])
      expect(hidden(eye(summit.feet), [b.min[0], SUMMIT_Y + 0.3, (b.min[2] + b.max[2]) / 2])).toEqual([]);
  });

  it('from the shortcut’s top the entrance plaza is in sight down the stairs (帰り道が見える)', () => {
    const v = AREA1_SPAWNS['area1-shortcut'];
    const eye: Vec3 = [v.feet[0], v.feet[1] + EYE_HEIGHT, v.feet[2]];
    expect(hidden(eye, [AREA1_PLAZA.center[0], AREA1_Y + 0.5, AREA1_PLAZA.center[2]])).toEqual([]);
  });

  it('the motes drift from room to room in the open (over ground or air, never inside a house)', () => {
    expect(MOTE_PATHS.length).toBe(4);
    for (const path of MOTE_PATHS)
      for (let u = 0; u <= 1; u += 0.02) {
        const [x, z] = motePathAt(path, u);
        // (they drift past the houses' corners, a little to either side: never a step deep into one)
        // (over a roof you walk on is over ground)
        const deep = AREA1_HOUSES.some(
          (h) =>
            h.roof !== 'flat' && x > h.minX + 0.3 && x < h.maxX - 0.3 && z > h.minZ + 0.3 && z < h.maxZ - 0.3,
        );
        expect(deep, `mote at (${x.toFixed(1)}, ${z.toFixed(1)})`).toBe(false);
      }
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
