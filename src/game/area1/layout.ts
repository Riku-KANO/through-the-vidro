import type { Box, Vec3 } from '../../layers/footing';
import type { AreaDecl, PedestalDecl, RoomDecl, SurfaceDecl } from '../area';

/**
 * エリア1「泡の工房街」 (進行構造とエリア設計: 泡が連なる住居群と坂道、朝; S-36), its way in and its first room. Plain data shared
 * by the drawing (art.ts), the colliders (physics.ts), the game's session (AREA1) and the tests, so what is drawn is what
 * is walked on (空間の可読性と導線 4). Shapes are 仮: grey boxes from code (泡と曲面と真鍮の枠), Blender takes them over later.
 *
 * Frame and compass are the town's (prologue/layout.ts COMPASS, S-39): east is +X (the side of the dawn, 朝), north +Z.
 * This file imports nothing from the prologue (prologue/layout.ts builds its spawns and its east road from it), so the few
 * numbers of the central plaza it hangs off are mirrored in TOWN, and the unit test checks they agree.
 *
 *   中央広場 ─(東の門)── 東の道 約 60m ──▶ 入口の広場 ──▶ 坂の下の通り ──▶ 坂（南へ上る、S-40 で頂へ）
 *                                                            │
 *                                                            └▶ 部屋1「崩れた壁の路地」（北へ）
 *
 * 街の配置 (設計書): 各エリアの入口の広場まで約 60m、1エリアは約 80×80m; エリア1の部屋: 入口の広場から東へ坂を上り、坂の下「崩れた壁の
 * 路地」（表だけの壁を単独で）、中ほど「二つの台座の中庭」、頂「煙突の見晴らし」. S-36 builds the way in and the first room; the
 * slope stops at a shut gate (仮の行き止まり, the reason beyond it) until S-40 builds rooms 2 and 3. The summit, with the workshop
 * street's chimney (ルール5), stands where S-35 / S-39 put the landmark in the views from the slope's brow and the plaza.
 */

/** The central plaza (prologue/layout.ts PLAZA; checked equal by area1/layout.test.ts): its centre on its floor and radius. */
export const TOWN = { center: [0, -12, -125.6] as Vec3, radius: 25 } as const;
/** The floor of the town where エリア1 starts: the central plaza's, its road, the entrance plaza, the street and the alley. */
export const AREA1_Y = TOWN.center[1];

/**
 * 東の道 (S-35 the first metres, S-36 all of it): from the central plaza's east gate on its rim to the entrance plaza's rim,
 * about 60 m (街の配置: 各エリアの入口の広場まで約 60m), as wide as the slope down from the workshop (prologue/layout.ts EAST_ROAD).
 */
export const AREA1_ROAD = {
  fromX: TOWN.center[0] + TOWN.radius,
  toX: 85,
  z: TOWN.center[2],
  halfWidth: 1.4,
} as const;

/**
 * 朝へ移る (発案者 2026-10-25: 道を進むにつれて空が次のエリアの時間帯へ移る): along the road the sky and the light go from the plaza's
 * 夜明け前 to エリア1's 朝 — none of it before `fromX` (a few metres past the gate), all of it from `toX` (a few metres before the
 * entrance plaza). By where you stand only: walk back and it is before dawn again (no switch, no black screen).
 */
export const DAY = { fromX: AREA1_ROAD.fromX + 6, toX: AREA1_ROAD.toX - 6 } as const;

/** 0 (夜明け前) … 1 (朝) where you stand at x, eased (遷移のルール5: ゆっくり始まって粘りながら止まる). */
export function daylightAt(x: number): number {
  const t = Math.min(1, Math.max(0, (x - DAY.fromX) / (DAY.toX - DAY.fromX)));
  return t * t * (3 - 2 * t);
}

/**
 * 入口の広場: a round stone terrace at the road's end (仮: radius 11 m), its rim a brass balustrade like the central plaza's, open
 * to the west (the road) and to the east (the street on to the slope). The houses of the street stand round it.
 */
export const AREA1_PLAZA = {
  center: [AREA1_ROAD.toX + 11, AREA1_Y, TOWN.center[2]] as Vec3,
  radius: 11,
} as const;
/** The rim (仮, the central plaza's PLAZA_RIM): rail height, thickness, the half width of an opening along it. */
export const AREA1_RIM = { height: 1.0, thickness: 0.2, openingHalf: 1.75 } as const;
/** Angles (radians from +X toward +Z) of the rim's openings: the street (east) and the road (west). */
export const AREA1_RIM_OPENINGS: readonly number[] = [0, Math.PI];

/** The rim's balustrade as arcs between its openings (from < to, radians from +X toward +Z). */
export function area1RimArcs(): { from: number; to: number }[] {
  const half = Math.asin(AREA1_RIM.openingHalf / AREA1_PLAZA.radius);
  const open = [...AREA1_RIM_OPENINGS].sort((a, b) => a - b);
  return open.map((a, i) => {
    const next = i + 1 < open.length ? (open[i + 1] as number) : (open[0] as number) + 2 * Math.PI;
    return { from: a + half, to: next - half };
  });
}

/**
 * 坂の下の通り: from the entrance plaza's east opening on east between the houses, to where the slope turns south up the hill.
 * Level (the foot of the slope). `fromX` runs a little in under the plaza's rim (no seam to catch on).
 */
export const AREA1_STREET = {
  fromX: AREA1_PLAZA.center[0] + AREA1_PLAZA.radius - 0.6,
  toX: 123,
  z: TOWN.center[2],
  halfWidth: 1.6,
} as const;
/** The street's edges (z): the houses on its north side stand on the first, those on its south side on the second. */
export const STREET_NORTH_Z = AREA1_STREET.z + AREA1_STREET.halfWidth;
export const STREET_SOUTH_Z = AREA1_STREET.z - AREA1_STREET.halfWidth;

/*
 * 部屋1「崩れた壁の路地」 (パズル設計 > ギミック一覧: 表だけの壁、安全な場所で単独で): an alley off the street's north side at the
 * slope's foot, a crumbled wall (表の層だけ) across it, a pedestal before it. 覗くと玉越しでは壁が消え、奥に雫の光; 置くと球の中で壁が
 * 消え (S-28)、通り抜けて雫に触れる; 玉を拾えば壁は戻る. Laid out so that
 *  - the whole wall lies inside the placed vidro's sphere (every segment is cut: layers/surface boxInsideSphere), with room
 *  - the drop hovers behind the wall, inside the sphere, within reach from just behind the wall
 *  - nowhere behind the wall is the pedestal within reach (REACH): the vidro cannot be picked up from there, so nobody is
 *    shut in behind the wall when it comes back (原則3: 罰がない)
 * (area1/layout.test.ts checks all three.)
 */

/** The alley (its floor, x and z): from the street's north edge to the house at its end. */
export const ROOM1_ALLEY = { minX: 112.7, maxX: 115.3, minZ: STREET_NORTH_Z, maxZ: -117.0 } as const;
/** 台座: on the alley's left as you go in (as the prologue's at its dead end), 1.2 m in. Its orb at the prologue's height. */
export const ROOM1_PEDESTAL: PedestalDecl = {
  id: 'area1-alley',
  base: [114.7, AREA1_Y, -122.8],
  orb: [114.7, AREA1_Y + 1.05, -122.8],
};
/** 崩れた壁 (表にだけあるもの): wall to wall across the alley, taller than the body (no seeing over it, no climbing it). */
export const ROOM1_WALL: SurfaceDecl = {
  id: 'area1-wall',
  box: {
    min: [ROOM1_ALLEY.minX, AREA1_Y, -120.6],
    max: [ROOM1_ALLEY.maxX, AREA1_Y + 2.4, -120.2],
  },
};
/** 光の雫 (裏の層にしかない): behind the wall, a little right of the alley's middle. */
export const ROOM1_DROP = { id: 'area1-room1', at: [113.8, AREA1_Y + 1.2, -119.4] as Vec3 } as const;

/** 部屋1 as the game's session plays it (game/area). */
export const ROOM1: RoomDecl = {
  id: 'area1-room1',
  pedestals: [ROOM1_PEDESTAL],
  drop: ROOM1_DROP,
  surface: [ROOM1_WALL],
};

/** エリア1 (S-36: its first room; S-40 adds rooms 2 and 3 and the shortcut). */
export const AREA1: AreaDecl = { id: 'area1', rooms: [ROOM1] };

/**
 * 坂 (S-36 its foot; S-40 the rest): from the street's end it turns south (−Z) and climbs toward the summit, where the
 * workshop street's chimney stands (AREA1_CHIMNEY). On a cosine (level where it leaves the street); `rise` metres over it.
 */
export const AREA1_SLOPE = {
  x: 121,
  halfWidth: AREA1_STREET.halfWidth,
  fromZ: STREET_SOUTH_Z,
  toZ: -158,
  rise: 12,
} as const;

/** Height of the slope's top at z (the street's floor at its foot, the summit's at its top). */
export function area1SlopeHeight(z: number): number {
  const { fromZ, toZ, rise } = AREA1_SLOPE;
  if (z >= fromZ) return AREA1_Y;
  if (z <= toZ) return AREA1_Y + rise;
  const t = (fromZ - z) / (fromZ - toZ);
  return AREA1_Y + (rise * (1 - Math.cos(Math.PI * t))) / 2;
}

/**
 * 仮の行き止まり (until S-40 builds 部屋2): a shut brass gate across the slope, a little way up (ルール9: 行き止まりには必ず理由を
 * 置く — beyond its bars the slope climbs on toward the chimney, and the back layer glimmers there, 光の揺らぎ). Once 部屋1's drop
 * is taken, the lamps up to it and its keystone light (次の部屋の方向が見える). `z` of its bars, `height` of its arch.
 */
export const AREA1_GATE = { z: -134.5, halfWidth: AREA1_SLOPE.halfWidth, height: 3.2 } as const;

/**
 * 工房街の煙突 (空間の可読性と導線 5: 各エリアにも固有の目印): on エリア1's summit, the top of its slope (S-40: 頂「煙突の見晴らし」).
 * Where S-35 / S-39 put the landmark: from the slope's brow by the workshop it stands right of the lighthouse in the dawn's
 * warm horizon, inside the picture, and from the central plaza it rises over the open east gate (prologue/layout.test.ts);
 * from the entrance plaza it stands up the hill (area1/layout.test.ts). `foot` on the summit, `top` above the central
 * plaza's floor.
 */
export const AREA1_CHIMNEY = { foot: [135, AREA1_Y + 12, -158] as Vec3, top: 34 } as const;

/**
 * The houses of the workshop street round the entrance plaza, along the street and the alley and up the slope (仮: grey
 * boxes with rounded edges, their roofs bubbles; 形のルール: 泡の集合 when Blender makes them). A box on x and z, standing
 * from below the floor (down into the mist) to `height` above AREA1_Y. `collide`: it bounds a walkable floor and stops
 * the body (its collider is the same rounded box: 当たり判定は見た目に正直に). `zone`: which instanced mesh draws it (区域ごと
 * に InstancedMesh を分ける, AGENTS.md S-35), so what is out of view is left out.
 */
export interface House {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  collide: boolean;
  zone: 'plaza' | 'street' | 'slope';
}

/** Rounding of a house's edges (its collider's too). */
export const HOUSE_ROUND = 0.25;

const house = (
  zone: House['zone'],
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  height: number,
  collide = true,
): House => ({ minX, maxX, minZ, maxZ, height, collide, zone });

export const AREA1_HOUSES: readonly House[] = [
  // the street's north side: west of the alley, east of it (the alley's walls), on to the street's end; the house closing
  // the alley at its end
  house('street', 106.9, ROOM1_ALLEY.minX, STREET_NORTH_Z, -115.5, 4.2),
  house('street', ROOM1_ALLEY.maxX, 120.6, STREET_NORTH_Z, -115.5, 4.8),
  house('street', 120.6, 127.0, STREET_NORTH_Z, -118.0, 3.8),
  house('street', ROOM1_ALLEY.minX - 0.6, ROOM1_ALLEY.maxX + 0.6, ROOM1_ALLEY.maxZ, -113.0, 5.4),
  // the street's south side up to the slope, the corner past it, and the house closing the street's east end
  house('street', 106.9, 113.2, -133.0, STREET_SOUTH_Z, 3.6),
  house('street', 113.2, AREA1_SLOPE.x - AREA1_SLOPE.halfWidth, -133.0, STREET_SOUTH_Z, 4.6),
  house('street', AREA1_SLOPE.x + AREA1_SLOPE.halfWidth, 127.0, -133.0, STREET_SOUTH_Z, 4.4),
  house('street', AREA1_STREET.toX, 127.0, STREET_SOUTH_Z, STREET_NORTH_Z, 4.0),
  // up the slope on both sides, to the gate and a little past it
  house('slope', 114.5, AREA1_SLOPE.x - AREA1_SLOPE.halfWidth, -140.5, -133.0, 6.4),
  house('slope', AREA1_SLOPE.x + AREA1_SLOPE.halfWidth, 128.5, -140.5, -133.0, 6.0),
  // beyond the gate, the street climbing on (seen through the bars; never reached until S-40)
  house('slope', 113.5, AREA1_SLOPE.x - AREA1_SLOPE.halfWidth - 0.4, -148.0, -141.0, 9.0, false),
  house('slope', AREA1_SLOPE.x + AREA1_SLOPE.halfWidth + 0.4, 129.0, -149.0, -141.0, 9.4, false),
  // round the entrance plaza, outside its rim (the balustrade stops the body first), leaving the road's and the street's
  // ways open
  house('plaza', 88.0, 95.0, -144.0, -138.0, 4.8, false),
  house('plaza', 97.0, 104.0, -143.0, -138.5, 5.6, false),
  house('plaza', 104.5, 106.6, -140.0, -133.5, 4.0, false),
  house('plaza', 88.5, 95.5, -113.0, -108.0, 5.2, false),
  house('plaza', 97.0, 103.5, -112.5, -107.5, 4.4, false),
  house('plaza', 103.8, 106.6, -117.5, -111.0, 3.8, false),
  house('plaza', 80.0, 84.5, -140.0, -131.0, 3.4, false),
  house('plaza', 80.0, 84.5, -120.0, -111.0, 3.6, false),
];

/** The street lamps that light, one after the other, toward the next room once 部屋1's drop is taken (次の部屋の方向が見える). */
export const NEXT_LAMPS: readonly Vec3[] = [
  [ROOM1_ALLEY.maxX + 0.25, AREA1_Y + 2.3, STREET_NORTH_Z - 0.25],
  [AREA1_SLOPE.x - AREA1_SLOPE.halfWidth - 0.2, AREA1_Y + 2.3, STREET_SOUTH_Z - 0.4],
  [AREA1_SLOPE.x + AREA1_SLOPE.halfWidth + 0.2, area1SlopeHeight(-131) + 2.3, -131],
  [AREA1_SLOPE.x, area1SlopeHeight(AREA1_GATE.z) + AREA1_GATE.height + 0.17, AREA1_GATE.z],
];
/** 仮: seconds after the drop is taken that the first of them lights, and between one and the next. */
export const NEXT_LIGHTS = { first: 0.6, each: 0.45 } as const;

/**
 * 光の粒の流れ (ルール7): the motes drift from the entrance plaza along the street into the alley (where the room is) while its
 * drop waits, and up the slope to the gate once it is taken. Quadratic curves through three (x, z) points.
 */
export const MOTES_TO_ROOM: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = [
  [AREA1_PLAZA.center[0] - 4, AREA1_PLAZA.center[2]],
  [ROOM1_ALLEY.minX - 1, AREA1_STREET.z - 0.4],
  [(ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2, ROOM1_PEDESTAL.base[2] + 0.4],
];
export const MOTES_TO_NEXT: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = [
  [(ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2, STREET_NORTH_Z + 0.4],
  [AREA1_SLOPE.x, AREA1_STREET.z],
  [AREA1_SLOPE.x, AREA1_GATE.z + 0.6],
];

/** 床の材質 (S-22): every floor of エリア1 is 石畳. Boxes on x and z, or a disc. */
export const AREA1_FLOOR_ZONES = [
  {
    name: 'area1-plaza',
    material: 'stone' as const,
    radius: AREA1_PLAZA.radius,
    center: [AREA1_PLAZA.center[0], AREA1_PLAZA.center[2]] as const,
  },
  {
    name: 'area1-street',
    material: 'stone' as const,
    box: { minX: AREA1_STREET.fromX, maxX: AREA1_STREET.toX, minZ: STREET_SOUTH_Z, maxZ: STREET_NORTH_Z },
  },
  {
    name: 'area1-alley',
    material: 'stone' as const,
    box: { minX: ROOM1_ALLEY.minX, maxX: ROOM1_ALLEY.maxX, minZ: ROOM1_ALLEY.minZ, maxZ: ROOM1_ALLEY.maxZ },
  },
  {
    name: 'area1-slope',
    material: 'stone' as const,
    box: {
      minX: AREA1_SLOPE.x - AREA1_SLOPE.halfWidth,
      maxX: AREA1_SLOPE.x + AREA1_SLOPE.halfWidth,
      minZ: AREA1_GATE.z - 0.5,
      maxZ: AREA1_SLOPE.fromZ,
    },
  },
] as const;

/**
 * The height of the walkable ground at (x, z) in エリア1, or null off it (落下死はない: the fall guard's floor follows it). The road
 * is the town's (prologue/layout.ts groundHeight).
 */
export function area1Ground(x: number, z: number): number | null {
  const [cx, , cz] = AREA1_PLAZA.center;
  if (Math.hypot(x - cx, z - cz) <= AREA1_PLAZA.radius + 0.3) return AREA1_Y;
  if (x >= AREA1_STREET.fromX && x <= AREA1_STREET.toX && z >= STREET_SOUTH_Z && z <= STREET_NORTH_Z)
    return AREA1_Y;
  if (x >= ROOM1_ALLEY.minX && x <= ROOM1_ALLEY.maxX && z >= ROOM1_ALLEY.minZ && z <= ROOM1_ALLEY.maxZ)
    return AREA1_Y;
  if (Math.abs(x - AREA1_SLOPE.x) <= AREA1_SLOPE.halfWidth && z <= AREA1_SLOPE.fromZ && z >= AREA1_GATE.z - 1)
    return area1SlopeHeight(z);
  return null;
}

/**
 * What エリア1 builds behind the scenes (S-36: 中央広場にいる間に裏で組み立てる): the box holding all of it, for the room to add it
 * while it is out of view (no pop-in in sight).
 */
export const AREA1_BOUNDS: Box = { min: [78, AREA1_Y - 8, -150], max: [131, AREA1_Y + 14, -106] };

/**
 * Where the far town's bubbles (plaza.ts: エリア1's hill, built with the town while loading) must not stand: the road's end, the
 * entrance plaza and the street with their houses, the slope up to the summit (they would stand in the way, or show
 * through the grey houses).
 */
export const AREA1_KEEP_OUT: readonly { minX: number; maxX: number; minZ: number; maxZ: number }[] = [
  { minX: 60, maxX: 86, minZ: -131, maxZ: -120 },
  { minX: 78, maxX: 131, minZ: -150, maxZ: -106 },
  { minX: 112, maxX: 131, minZ: -162, maxZ: -126 },
];

/**
 * 見る位置 (?spawn=…): on the road where the sky moves toward morning, in the entrance plaza looking up at the chimney, before
 * 部屋1's alley (the wall and the pedestal ahead), before the slope's shut gate.
 */
export const AREA1_SPAWNS = {
  'area1-road': {
    feet: [(DAY.fromX + DAY.toX) / 2, AREA1_Y, AREA1_ROAD.z] as Vec3,
    yaw: -Math.PI / 2,
    pitch: 0.1,
  },
  'area1-plaza': (() => {
    const feet: Vec3 = [AREA1_PLAZA.center[0] - 4, AREA1_Y, AREA1_PLAZA.center[2] + 4];
    const top: Vec3 = [AREA1_CHIMNEY.foot[0], TOWN.center[1] + AREA1_CHIMNEY.top - 9, AREA1_CHIMNEY.foot[2]];
    const dx = top[0] - feet[0];
    const dz = top[2] - feet[2];
    return {
      feet,
      yaw: Math.atan2(-dx, -dz),
      pitch: Math.atan2(top[1] - (feet[1] + 1.6), Math.hypot(dx, dz)),
    };
  })(),
  'area1-alley': {
    feet: [(ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2 - 0.1, AREA1_Y, AREA1_STREET.z + 0.4] as Vec3,
    yaw: Math.PI,
    pitch: -0.1,
  },
  'area1-gate': {
    feet: [AREA1_SLOPE.x, area1SlopeHeight(AREA1_GATE.z + 2), AREA1_GATE.z + 2] as Vec3,
    yaw: 0,
    pitch: 0.12,
  },
} as const;
