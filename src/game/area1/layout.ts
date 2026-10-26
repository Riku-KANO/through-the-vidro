import type { Box, FootingSegment, Vec3 } from '../../layers/footing';
import { splitFooting } from '../../layers/footing';
import type { SettleSweep } from '../../layers/settle';
import type { AreaDecl, PedestalDecl, RoomDecl, ShortcutDecl, SurfaceDecl } from '../area';
import { COMPASS } from '../area/compass';

/**
 * エリア1「泡の工房街」 (進行構造とエリア設計: 泡が連なる住居群と坂道、朝; S-36, S-40): its way in, its three rooms and the
 * shortcut home. Plain data shared by the drawing (art.ts), the colliders (physics.ts), the game's session (AREA1) and the
 * tests, so what is drawn is what is walked on (空間の可読性と導線 4). Shapes are 仮: grey boxes from code (泡と曲面と真鍮の枠),
 * Blender takes them over later.
 *
 * Frame and compass are the town's (area/compass.ts COMPASS, S-39): east is +X (the side of the dawn, 朝), north +Z. Every
 * east–west position is written as metres east of the central plaza's centre and placed along COMPASS (eastX, xSpan), so
 * turning the compass turns エリア1 with the town (AGENTS.md). This file imports nothing from the prologue (prologue/layout.ts
 * builds its spawns and its east road from it), so the few numbers of the central plaza it hangs off are mirrored in TOWN,
 * and the unit test checks they agree.
 *
 *   中央広場 ─(東の門)── 東の道 約 60m ──▶ 入口の広場 ──▶ 坂の下の通り ──▶ 坂（南へ上る）── 踊り場 ──▶ 坂 ──▶ 頂
 *                                          ▲     │                     │              │                  │
 *                                          │     │                     │              └▶ 部屋2「二つの台座の中庭」（東）
 *                                          │     │                     └▶ 部屋1「崩れた壁の路地」（北）
 *                                          │     │                                              部屋3「煙突の見晴らし」（頂の西）
 *                                          └─────┴── 近道: 頂の屋根から入口の広場へ下りる裏の階段（3つ目の雫で表に定着）
 *
 * 街の配置 (設計書 rev 53): 各エリアの入口の広場まで約 60m、1エリアは約 80×80m; エリア1の部屋: 入口の広場から東へ坂を上り、通りの端で
 * 南へ折れて頂の煙突へ (発案者 2026-10-26)。坂の下「崩れた壁の路地」（表だけの壁を単独で）、中ほど「二つの台座の中庭」（二重の台座＋表だけ
 * の壁）、頂「煙突の見晴らし」（置くと先が見えない）。3つ目の雫で頂から入口の広場への裏の階段が表に定着して近道になる（序章の橋と同じ
 * 見せ方）。部屋の中身は作って遊んでから詰める — every number of the rooms below is 仮 (S-40), checked by area1/layout.test.ts.
 */

/** The central plaza (prologue/layout.ts PLAZA; checked equal by area1/layout.test.ts): its centre on its floor and radius. */
export const TOWN = { center: [0, -12, -125.6] as Vec3, radius: 25 } as const;
/** The floor of the town where エリア1 starts: the central plaza's, its road, the entrance plaza, the street and the alley. */
export const AREA1_Y = TOWN.center[1];

/** East along x (COMPASS: +1, or −1 were the compass turned round). */
const EAST = COMPASS.east[0];
/** x of the point `d` metres east of the central plaza's centre. */
export function eastX(d: number): number {
  return TOWN.center[0] + EAST * d;
}
/** Metres east of the central plaza's centre of an x (eastX's inverse). */
export function eastOf(x: number): number {
  return (x - TOWN.center[0]) * EAST;
}
/** The x span between two distances east, lower first whichever way east points. */
function xSpan(d0: number, d1: number): { minX: number; maxX: number } {
  const a = eastX(d0);
  const b = eastX(d1);
  return { minX: Math.min(a, b), maxX: Math.max(a, b) };
}
/** A box from two distances east, two heights and two z. */
function boxAt(e0: number, e1: number, y0: number, y1: number, z0: number, z1: number): Box {
  const { minX, maxX } = xSpan(e0, e1);
  return { min: [minX, Math.min(y0, y1), Math.min(z0, z1)], max: [maxX, Math.max(y0, y1), Math.max(z0, z1)] };
}
/** A rectangle on the ground from two distances east and two z. */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
const rectAt = (e0: number, e1: number, z0: number, z1: number): Rect => ({
  ...xSpan(e0, e1),
  minZ: Math.min(z0, z1),
  maxZ: Math.max(z0, z1),
});
const inRect = (r: Rect, x: number, z: number): boolean =>
  x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/**
 * 東の道 (S-35 the first metres, S-36 all of it): from the central plaza's east gate on its rim to the entrance plaza's rim,
 * about 60 m (街の配置: 各エリアの入口の広場まで約 60m), as wide as the slope down from the workshop (prologue/layout.ts EAST_ROAD).
 */
export const AREA1_ROAD = {
  /** x where it leaves the central plaza's rim, and where it meets the entrance plaza's (`length` metres east). */
  fromX: eastX(TOWN.radius),
  toX: eastX(85),
  length: 85 - TOWN.radius,
  z: TOWN.center[2],
  halfWidth: 1.4,
} as const;

/**
 * 朝へ移る (発案者 2026-10-25: 道を進むにつれて空が次のエリアの時間帯へ移る): along the road the sky and the light go from the plaza's
 * 夜明け前 to エリア1's 朝 — none of it before `fromX` (a few metres past the gate), all of it from `toX` (a few metres before the
 * entrance plaza). By where you stand only: walk back and it is before dawn again (no switch, no black screen).
 */
export const DAY = { fromX: eastX(TOWN.radius + 6), toX: eastX(85 - 6) } as const;

/** 0 (夜明け前) … 1 (朝) where you stand at x, eased (遷移のルール5: ゆっくり始まって粘りながら止まる). */
export function daylightAt(x: number): number {
  const from = eastOf(DAY.fromX);
  const t = Math.min(1, Math.max(0, (eastOf(x) - from) / (eastOf(DAY.toX) - from)));
  return t * t * (3 - 2 * t);
}

/**
 * 入口の広場: a round stone terrace at the road's end (仮: radius 11 m), its rim a brass balustrade like the central plaza's, open
 * to the west (the road) and to the east (the street on to the slope). The houses of the street stand round it. S-40: and to
 * the south, where the shortcut's stairs come down from the summit — shut by a gate on the surface layer until the third drop's
 * light fixes the stairs (and takes the gate away: SHORTCUT_GATE).
 */
export const AREA1_PLAZA = {
  center: [eastX(85 + 11), AREA1_Y, TOWN.center[2]] as Vec3,
  radius: 11,
} as const;
/** The rim (仮, the central plaza's PLAZA_RIM): rail height, thickness, the half width of an opening along it. */
export const AREA1_RIM = { height: 1.0, thickness: 0.2, openingHalf: 1.75 } as const;
/**
 * Angles (radians from +X toward +Z) of the rim's openings: the street (east), the road (west) and (S-40) the shortcut's foot
 * (south), along COMPASS.
 */
export const AREA1_RIM_OPENINGS: readonly number[] = [COMPASS.east, COMPASS.west, COMPASS.south].map((d) => {
  const a = Math.atan2(d[1], d[0]);
  return a < 0 ? a + 2 * Math.PI : a;
});

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
 * Level (the foot of the slope). It starts a little in under the plaza's rim (no seam to catch on); `endX` is its east end.
 */
export const AREA1_STREET = {
  ...xSpan(85 + 11 + 11 - 0.6, 123),
  endX: eastX(123),
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
export const ROOM1_ALLEY = { ...xSpan(112.7, 115.3), minZ: STREET_NORTH_Z, maxZ: -117.0 } as const;
/** 台座: on the alley's left as you go in (as the prologue's at its dead end), 1.2 m in. Its orb at the prologue's height. */
export const ROOM1_PEDESTAL: PedestalDecl = {
  id: 'area1-alley',
  base: [eastX(114.7), AREA1_Y, -122.8],
  orb: [eastX(114.7), AREA1_Y + 1.05, -122.8],
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
export const ROOM1_DROP = { id: 'area1-room1', at: [eastX(113.8), AREA1_Y + 1.2, -119.4] as Vec3 } as const;

/** 部屋1 as the game's session plays it (game/area). */
export const ROOM1: RoomDecl = {
  id: 'area1-room1',
  pedestals: [ROOM1_PEDESTAL],
  drop: ROOM1_DROP,
  surface: [ROOM1_WALL],
};

/**
 * 坂 (S-36 its foot; S-40 all of it, 発案者 2026-10-26: 通りの端で南へ折れて頂の煙突へ): from the street's end it turns south (−Z) and
 * climbs to the summit in two flights of `rise / 2` each, with a level landing between them where 部屋2's courtyard opens off it
 * (中ほど「二つの台座の中庭」). Each flight on a cosine (level where it meets the street, the landing and the summit), no steeper than
 * the body likes (MAX_SLOPE_DEG less 5°: area1/layout.test.ts).
 */
export const AREA1_SLOPE = {
  x: eastX(121),
  halfWidth: AREA1_STREET.halfWidth,
  fromZ: STREET_SOUTH_Z,
  /** Where the first flight reaches the landing, and where the second flight leaves it. */
  landingFromZ: -141.0,
  landingToZ: -144.6,
  /** Where the second flight reaches the summit (頂). */
  toZ: -158.4,
  rise: 12,
} as const;
/** The landing's floor (部屋2's courtyard is on it) and the summit's (部屋3, the shortcut's top). */
export const COURT_Y = AREA1_Y + AREA1_SLOPE.rise / 2;
export const SUMMIT_Y = AREA1_Y + AREA1_SLOPE.rise;

/** Height of the slope's top at z (the street's floor at its foot, the landing's, the summit's at its top). */
export function area1SlopeHeight(z: number): number {
  const { fromZ, landingFromZ, landingToZ, toZ } = AREA1_SLOPE;
  const flight = (from: number, to: number, base: number): number => {
    const t = (from - z) / (from - to);
    return base + ((COURT_Y - AREA1_Y) * (1 - Math.cos(Math.PI * t))) / 2;
  };
  if (z >= fromZ) return AREA1_Y;
  if (z > landingFromZ) return flight(fromZ, landingFromZ, AREA1_Y);
  if (z >= landingToZ) return COURT_Y;
  if (z > toZ) return flight(landingToZ, toZ, COURT_Y);
  return SUMMIT_Y;
}

/*
 * 部屋2「二つの台座の中庭」 (パズル設計 > ギミック一覧: 二重の台座 — 範囲が重なる位置にある2つの台座、どちらに置くかで開く道が変わる;
 * 表だけの壁と組み合わせて, 難易度の曲線: 置く場所の選択). A courtyard off the landing, east. Along its north side a balcony (1.6 m up,
 * shared); up to it, at its east end, a stair of the back layer (裏の階段); along the balcony, west of the stair's top, a crumbled
 * wall of the surface layer (表だけの壁) across it, and behind that the drop. Two pedestals whose spheres overlap:
 *  - A, by the stair: its sphere holds the whole stair (you climb to the balcony) but reaches none of the wall: it stands
 *  - B, between the stair and the wall: its sphere holds the stair and the whole wall (every segment cut), and the drop
 * 両方から覗いて、どちらの球が両方に届くかを見極める. And so that nobody is shut in (原則3): from nowhere on the balcony is either
 * pedestal within reach (the vidro cannot be taken up there, leaving you above a stair that is gone); on the stair or in the
 * cut wall the pickup is refused as ever (S-02, S-28). area1/layout.test.ts checks every one of these.
 */

/** The courtyard's floor (the landing's height): from the landing's east edge to the house closing it. */
export const ROOM2_COURT: Rect = rectAt(121 + 1.6, 133.2, -146.4, -141.7);
/** The balcony along its north side: its floor's height, and its edge (z of its south face, where the railing runs). */
export const ROOM2_BALCONY = { ...rectAt(121 + 1.6, 133.2, -141.7, -140.5), y: COURT_Y + 1.6 } as const;
/** The balcony's railing (brass, shared): its height, thickness; it runs along the edge but where the stair arrives. */
export const ROOM2_RAIL = { height: 1.0, thickness: 0.06 } as const;
/**
 * 裏の階段: from the courtyard's floor north up to the balcony's edge, `steps` treads of `tread` m, each `rise` m up (the
 * balcony one riser above the last tread). Its footing segments are its treads (solid down to the floor: a stair).
 */
export const ROOM2_STAIRS = {
  ...xSpan(130.2, 131.6),
  topZ: ROOM2_BALCONY.minZ,
  steps: 7,
  tread: 0.4,
  rise: (ROOM2_BALCONY.y - COURT_Y) / 8,
} as const;
/** z of the stair's foot (its lowest tread's south edge). */
export const ROOM2_STAIRS_FOOT_Z = ROOM2_STAIRS.topZ - ROOM2_STAIRS.steps * ROOM2_STAIRS.tread;

/** The stair's treads as back-layer footing, from its foot up (each a box from the floor to its top). */
export function room2StairSegments(): FootingSegment[] {
  const s = ROOM2_STAIRS;
  return Array.from({ length: s.steps }, (_, i) => ({
    id: `area1-court-stairs:${i}`,
    min: [s.minX, COURT_Y, ROOM2_STAIRS_FOOT_Z + i * s.tread] as Vec3,
    max: [s.maxX, COURT_Y + (i + 1) * s.rise, ROOM2_STAIRS_FOOT_Z + (i + 1) * s.tread] as Vec3,
  }));
}

/** 台座 A: by the stair's foot, east of it. */
export const ROOM2_PEDESTAL_A: PedestalDecl = {
  id: 'area1-court-a',
  base: [eastX(132.6), COURT_Y, -143.9],
  orb: [eastX(132.6), COURT_Y + 1.05, -143.9],
};
/** 台座 B: between the stair and the wall, a step back from the balcony's face (out of reach from the balcony). */
export const ROOM2_PEDESTAL_B: PedestalDecl = {
  id: 'area1-court-b',
  base: [eastX(128.6), COURT_Y, -143.16],
  orb: [eastX(128.6), COURT_Y + 1.05, -143.16],
};
/** 表だけの壁: across the balcony, from its edge to the house behind, taller than the body. */
export const ROOM2_WALL: SurfaceDecl = {
  id: 'area1-court-wall',
  box: boxAt(128.4, 128.8, ROOM2_BALCONY.y, ROOM2_BALCONY.y + 1.9, ROOM2_BALCONY.minZ, ROOM2_BALCONY.maxZ),
};
/** 光の雫: on the balcony behind the wall. */
export const ROOM2_DROP = {
  id: 'area1-room2',
  at: [eastX(126.8), ROOM2_BALCONY.y + 1.2, -141.1] as Vec3,
} as const;
/** 部屋2 as the game's session plays it. */
export const ROOM2: RoomDecl = {
  id: 'area1-room2',
  pedestals: [ROOM2_PEDESTAL_A, ROOM2_PEDESTAL_B],
  drop: ROOM2_DROP,
  surface: [ROOM2_WALL],
  footing: [{ id: 'area1-court-stairs', segments: room2StairSegments() }],
};

/*
 * 部屋3「煙突の見晴らし」 (難易度の曲線: 最後の部屋で初めて「置くと先が見えない」問題に向き合う; 3部屋目は前の2部屋の組み合わせ). On the
 * summit, west of where the slope arrives: the summit's terrace ends at a valley between the roofs (屋根の間の谷), and across it
 * two roofs, the north one long — a ridge running west to where the shortcut's stairs go down to the entrance plaza — the south
 * one short (a dead end, its reason a glimmer of the back layer: ルール9). Two bridges of the back layer cross the valley, one
 * to each (裏の橋が左右に分かれて架かり), and on the terrace a pedestal by each (台座は左右の屋根に1つずつ): each pedestal's sphere
 * holds its own bridge and none of the other's. The drop hovers on the north roof just across its bridge: inside the north
 * pedestal's sphere, outside the south one's. Placed, the vidro cannot peek — so you peek first, from the edge (the lip
 * between the bridges), and remember which bridge goes on to the drop. Placed on the wrong one, you walk out to an empty roof
 * and back, and pick the vidro up (原則3: 罰がない).
 */

/** The summit's terrace (頂): where the slope arrives (its north edge), down to the valley's lip (its west edge). */
export const ROOM3_TERRACE: Rect = rectAt(113.0, 121 + 1.6, -168.4, AREA1_SLOPE.toZ);
/** The valley between the roofs (east–west span): nothing walkable in it. */
export const ROOM3_VALLEY = xSpan(111.2, 113.0);
/** Across the valley: the north roof (a ridge on west to the shortcut's top) and the south roof (a dead end). */
export const ROOM3_ROOF_N: Rect = rectAt(94.4, 111.2, -164.0, -158.7);
export const ROOM3_ROOF_S: Rect = rectAt(106.4, 111.2, -170.0, -166.0);
/** The two bridges of the back layer, each from 0.3 m onto the terrace to 0.3 m onto its roof, `width` across. */
export const ROOM3_BRIDGE_N: Box = boxAt(110.9, 113.3, SUMMIT_Y - 0.3, SUMMIT_Y, -160.1, -158.7);
export const ROOM3_BRIDGE_S: Box = boxAt(110.9, 113.3, SUMMIT_Y - 0.3, SUMMIT_Y, -168.1, -166.7);
/** The pedestals by each bridge, on the terrace, just in from the lip. */
export const ROOM3_PEDESTAL_N: PedestalDecl = {
  id: 'area1-summit-n',
  base: [eastX(113.75), SUMMIT_Y, -160.9],
  orb: [eastX(113.75), SUMMIT_Y + 1.05, -160.9],
};
export const ROOM3_PEDESTAL_S: PedestalDecl = {
  id: 'area1-summit-s',
  base: [eastX(113.75), SUMMIT_Y, -165.9],
  orb: [eastX(113.75), SUMMIT_Y + 1.05, -165.9],
};
/** 光の雫: on the north roof, just across its bridge. */
export const ROOM3_DROP = {
  id: 'area1-room3',
  at: [eastX(110.45), SUMMIT_Y + 1.25, -159.4] as Vec3,
} as const;
/** "端": where to peek from — at the terrace's west side between the bridges, both bridges and the drop's roof ahead. */
export const ROOM3_EDGE: Vec3 = [eastX(115.5), SUMMIT_Y, -163.4];
/** 部屋3 as the game's session plays it. */
export const ROOM3: RoomDecl = {
  id: 'area1-room3',
  pedestals: [ROOM3_PEDESTAL_N, ROOM3_PEDESTAL_S],
  drop: ROOM3_DROP,
  footing: [
    { id: 'area1-bridge-n', segments: splitFooting('area1-bridge-n', ROOM3_BRIDGE_N, 0.4) },
    { id: 'area1-bridge-s', segments: splitFooting('area1-bridge-s', ROOM3_BRIDGE_S, 0.4) },
  ],
};

/*
 * 近道 (エリアの内部構造: 3つ目の雫を得ると、入口の広場への近道が実体化して戻れる; 発案者 2026-10-26: 頂から入口の広場への裏の階段が表に
 * 定着して近道になる、序章の橋と同じ見せ方). The back layer's stairs from the north roof's west end straight down north to the entrance
 * plaza's south opening, where a gate of the surface layer (閉ざされた扉: 表にだけあるもの) shuts them out until then. Once the
 * area's third drop is taken, light runs from the north pedestal across the north bridge, along the ridge to the stairs' top
 * (the first leg), then down them to the plaza (the second): behind it the bridge and the stairs are fixed onto the surface
 * (solid for good, picking the vidro up on them allowed) and the gate is gone (S-34's sweep; layers/settle.ts).
 */

/** The stairs: across x, from the north roof's edge (y SUMMIT_Y) down `steps` steps to their foot, then a landing into the plaza. */
export const SHORTCUT_STAIRS = {
  ...xSpan(94.6, 97.4),
  topZ: ROOM3_ROOF_N.maxZ,
  footZ: -137.6,
  /** The landing at the plaza's level runs on to here (over the plaza's floor). */
  landingZ: -136.4,
  steps: 56,
} as const;
/** One step's tread and rise. */
export const SHORTCUT_TREAD = (SHORTCUT_STAIRS.footZ - SHORTCUT_STAIRS.topZ) / SHORTCUT_STAIRS.steps;
export const SHORTCUT_RISE = (SUMMIT_Y - AREA1_Y) / SHORTCUT_STAIRS.steps;

/** The stairs' top's height at z (SUMMIT_Y at the roof, AREA1_Y at the foot), stepped; null off its length. */
export function shortcutHeight(z: number): number | null {
  const s = SHORTCUT_STAIRS;
  if (z < s.topZ - 1e-9 || z > s.landingZ + 1e-9) return null;
  const k = Math.min(s.steps - 1, Math.floor((z - s.topZ) / SHORTCUT_TREAD));
  return SUMMIT_Y - (k + 1) * SHORTCUT_RISE;
}

/** The stairs as back-layer footing: each step a slab under its tread, the last running on as the landing. */
export function shortcutSegments(): FootingSegment[] {
  const s = SHORTCUT_STAIRS;
  return Array.from({ length: s.steps }, (_, k) => {
    const top = SUMMIT_Y - (k + 1) * SHORTCUT_RISE;
    const z1 = k === s.steps - 1 ? s.landingZ : s.topZ + (k + 1) * SHORTCUT_TREAD;
    return {
      id: `area1-shortcut:${k}`,
      min: [s.minX, top - 0.4, s.topZ + k * SHORTCUT_TREAD] as Vec3,
      max: [s.maxX, top, z1] as Vec3,
    };
  });
}

/** 閉ざされた扉 (表にだけあるもの): across the plaza's south opening, at the stairs' foot. */
export const SHORTCUT_GATE: SurfaceDecl = {
  id: 'area1-shortcut-gate',
  box: boxAt(96 - 1.85, 96 + 1.85, AREA1_Y, AREA1_Y + 2.6, -136.75, -136.35),
};
/**
 * The light's way (S-34's sweeps, one after the other): west from the north pedestal across the north bridge and along the
 * ridge to the stairs' top, then north down the stairs to the plaza. Every footing and surface-only segment lies wholly in or
 * out of each box (layers/settle.ts segmentsCutByBox; area1/layout.test.ts).
 */
export const SHORTCUT_LEGS: readonly SettleSweep[] = [
  {
    box: boxAt(94.2, 113.5, SUMMIT_Y - 0.6, SUMMIT_Y + 2.4, -160.8, SHORTCUT_STAIRS.topZ),
    direction: [COMPASS.west[0], 0, COMPASS.west[1]],
  },
  {
    box: boxAt(94.0, 98.0, AREA1_Y - 0.6, SUMMIT_Y + 0.6, SHORTCUT_STAIRS.topZ, -136.2),
    direction: [COMPASS.north[0], 0, COMPASS.north[1]],
  },
];
/** 仮 (S-40): seconds the light takes over both legs (about 42 m; the prologue's bridge took 1.6 s over 6 m). */
export const SHORTCUT_SECONDS = 4.5;
export const AREA1_SHORTCUT: ShortcutDecl = {
  id: 'area1-shortcut',
  legs: SHORTCUT_LEGS,
  seconds: SHORTCUT_SECONDS,
  footing: [{ id: 'area1-shortcut', segments: shortcutSegments() }],
  surface: [SHORTCUT_GATE],
};

/** エリア1: its three rooms and the shortcut (S-36 the first room; S-40 the rest). */
export const AREA1: AreaDecl = { id: 'area1', rooms: [ROOM1, ROOM2, ROOM3], shortcut: AREA1_SHORTCUT };

/**
 * 工房街の煙突 (空間の可読性と導線 5: 各エリアにも固有の目印): on エリア1's summit, east of where the slope arrives. Where S-35 / S-39 put
 * the landmark: from the slope's brow by the workshop it stands right of the lighthouse in the dawn's warm horizon, inside the
 * picture, and from the central plaza it rises over the open east gate (prologue/layout.test.ts); from the entrance plaza it
 * stands up the hill (area1/layout.test.ts). `foot` on the summit, `top` above the central plaza's floor.
 */
export const AREA1_CHIMNEY = { foot: [eastX(135), SUMMIT_Y, -158] as Vec3, top: 34 } as const;

/**
 * The houses of the workshop street round the entrance plaza, along the street and the alley, up the slope, round the courtyard
 * and the summit (仮: grey boxes with rounded edges, their roofs bubbles; 形のルール: 泡の集合 when Blender makes them). A box on x
 * and z, standing from below the floor (down into the mist) to `height` above AREA1_Y. `collide`: it bounds a walkable floor and
 * stops the body (its collider is the same rounded box: 当たり判定は見た目に正直に). `zone`: which mesh draws it (区域ごとに分けて
 * 描く, AGENTS.md S-35: one merged mesh per zone), so what is out of view is left out. `roof`: a bubble (the default), or flat
 * (S-40: the roofs you walk on across the valley carry a floor on top).
 */
export interface House {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  collide: boolean;
  zone: 'plaza' | 'street' | 'slope' | 'court' | 'summit' | 'hill';
  roof: 'bubble' | 'flat';
}

/** Rounding of a house's edges (its collider's too; 形のルール: 角を作らない). */
export const HOUSE_ROUND = 0.4;

/** A house between two distances east (e0, e1) and two z. */
const house = (
  zone: House['zone'],
  e0: number,
  e1: number,
  minZ: number,
  maxZ: number,
  height: number,
  collide = true,
  roof: House['roof'] = 'bubble',
): House => ({ ...xSpan(e0, e1), minZ, maxZ, height, collide, zone, roof });

/** The slope's edges (metres east): its west side and its east side. */
const SLOPE_W = 121 - 1.6;
const SLOPE_E = 121 + 1.6;
/** Heights above AREA1_Y of the summit's floor (the roofs across the valley carry theirs on top). */
const SUMMIT_H = SUMMIT_Y - AREA1_Y;

export const AREA1_HOUSES: readonly House[] = [
  // the street's north side: west of the alley, east of it (the alley's walls), on to the street's end; the house closing
  // the alley at its end
  house('street', 106.9, 112.7, STREET_NORTH_Z, -115.5, 4.2),
  house('street', 115.3, 120.6, STREET_NORTH_Z, -115.5, 4.8),
  house('street', 120.6, 127.0, STREET_NORTH_Z, -118.0, 3.8),
  house('street', 112.1, 115.9, ROOM1_ALLEY.maxZ, -113.0, 5.4),
  // the street's south side up to the slope, the corner past it, and the house closing the street's east end
  house('street', 106.9, 113.2, -133.0, STREET_SOUTH_Z, 3.6),
  house('street', 113.2, SLOPE_W, -133.0, STREET_SOUTH_Z, 4.6),
  house('street', SLOPE_E, 127.0, -133.0, STREET_SOUTH_Z, 4.4),
  house('street', 123, 127.0, STREET_SOUTH_Z, STREET_NORTH_Z, 4.0),
  // up the first flight on both sides (the east one backs the balcony), then the landing's west side and the second flight's
  // west side up to the summit's terrace (its south face the terrace's north edge)
  house('slope', 114.5, SLOPE_W, AREA1_SLOPE.landingFromZ, -133.0, 8.8),
  house('slope', SLOPE_E, 128.5, ROOM2_BALCONY.maxZ, -133.0, 10.4),
  house('slope', 113.6, SLOPE_W, -150.0, AREA1_SLOPE.landingFromZ, 11.4),
  house('slope', 113.0, SLOPE_W, AREA1_SLOPE.toZ, -150.0, SUMMIT_H + 1.8),
  // 部屋2's courtyard: behind the balcony's east part, its east end, its south side (which bounds the second flight's east
  // side too, rising with it)
  house('court', 128.5, 135.0, ROOM2_BALCONY.maxZ, -134.0, 10.4),
  house('court', 133.2, 137.0, ROOM2_COURT.minZ - 0.6, ROOM2_BALCONY.maxZ, 10.4),
  house('court', SLOPE_E, 128.0, -150.6, ROOM2_COURT.minZ, 9.6),
  house('court', 128.0, 133.6, -150.6, ROOM2_COURT.minZ, 8.2),
  house('court', SLOPE_E, 129.0, AREA1_SLOPE.toZ, -150.6, SUMMIT_H + 1.8),
  // the summit: east of the terrace, the house under the chimney, south of the terrace
  house('summit', SLOPE_E, 131.0, -170.0, AREA1_SLOPE.toZ, SUMMIT_H + 1.8),
  house('summit', 131.0, 139.0, -162.0, -154.0, SUMMIT_H + 1.6, false),
  house('summit', 113.0, SLOPE_E, -173.0, ROOM3_TERRACE.minZ, SUMMIT_H + 1.8),
  // across the valley: the north roof (the ridge) and the south roof, walked on (flat, a floor on top); the houses round them
  house('summit', 94.4, 111.2, ROOM3_ROOF_N.minZ, ROOM3_ROOF_N.maxZ, SUMMIT_H - 0.05, true, 'flat'),
  house('summit', 106.4, 111.2, ROOM3_ROOF_S.minZ, ROOM3_ROOF_S.maxZ, SUMMIT_H - 0.05, true, 'flat'),
  house('summit', 88.0, 94.4, -166.0, -156.0, SUMMIT_H + 2.4),
  house('summit', 94.4, 106.0, -170.0, ROOM3_ROOF_N.minZ, SUMMIT_H - 2.2, false),
  house('summit', 97.8, 106.0, ROOM3_ROOF_N.maxZ, -151.0, SUMMIT_H - 4.8, false),
  house('summit', 106.0, 112.6, ROOM3_ROOF_N.maxZ, -152.0, SUMMIT_H - 4.2, false),
  // down the hill beside the shortcut's stairs (they pass between)
  house('hill', 88.0, 94.2, -156.0, -145.0, 6.4, false),
  house('hill', 97.8, 106.0, -151.0, -144.0, 5.6, false),
  house('hill', 106.6, 113.4, -150.0, -138.0, 6.0, false),
  // round the entrance plaza, outside its rim (the balustrade stops the body first), leaving the road's, the street's and
  // (S-40) the shortcut's ways open
  house('plaza', 88.0, 94.2, -144.0, -138.0, 4.8, false),
  house('plaza', 97.8, 104.0, -143.0, -138.5, 5.6, false),
  house('plaza', 104.5, 106.6, -140.0, -133.5, 4.0, false),
  house('plaza', 88.5, 95.5, -113.0, -108.0, 5.2, false),
  house('plaza', 97.0, 103.5, -112.5, -107.5, 4.4, false),
  house('plaza', 103.8, 106.6, -117.5, -111.0, 3.8, false),
  house('plaza', 80.0, 84.5, -140.0, -131.0, 3.4, false),
  house('plaza', 80.0, 84.5, -120.0, -111.0, 3.6, false),
];

/**
 * The lamps that light, one after the other, toward the next room once a room's drop is taken (次の部屋の方向が見える): from 部屋1
 * (the alley) up the first flight to 部屋2's courtyard (`room1`), from 部屋2 up the second flight to the summit (`room2`).
 */
export const NEXT_LAMPS_BY_ROOM: Readonly<Record<'room1' | 'room2', readonly Vec3[]>> = {
  room1: [
    // on the house at the alley's mouth (east of it), hung out over the street
    [eastX(115.3 + 0.45), AREA1_Y + 2.3, STREET_NORTH_Z - 0.3],
    // on the corner where the slope turns off the street, over the street
    [eastX(SLOPE_W - 0.45), AREA1_Y + 2.3, STREET_SOUTH_Z + 0.3],
    // up the first flight, on the house along its east side
    [eastX(SLOPE_E - 0.3), area1SlopeHeight(-134) + 2.3, -134],
    // the courtyard's corner on the landing: on the balcony's side, hung out over the landing (seen up the first flight)
    [eastX(SLOPE_E - 0.3), COURT_Y + 2.6, ROOM2_BALCONY.minZ + 0.6],
  ],
  room2: [
    // the second flight's foot, on the courtyard's south house
    [eastX(SLOPE_E - 0.3), COURT_Y + 2.3, ROOM2_COURT.minZ - 0.4],
    // up the second flight, on its west house
    [eastX(SLOPE_W + 0.3), area1SlopeHeight(-152) + 2.3, -152],
    // the summit, on the house at the terrace's north edge (over the terrace)
    [eastX(SLOPE_W - 0.8), SUMMIT_Y + 2.3, AREA1_SLOPE.toZ - 0.3],
  ],
};
/** S-36's name: 部屋1's lamps (toward 部屋2 since S-40). */
export const NEXT_LAMPS: readonly Vec3[] = NEXT_LAMPS_BY_ROOM.room1;
/** 仮: seconds after the drop is taken that the first of them lights, and between one and the next. */
export const NEXT_LIGHTS = { first: 0.6, each: 0.45 } as const;

/** A way through (x, z) points (S-40: as many as its turns need; S-36's first had three, a quadratic's). */
export type MotePath = readonly (readonly [number, number])[];
/**
 * 光の粒の流れ (ルール7): the motes drift from the entrance plaza along the street into the alley (where 部屋1 is) while its drop
 * waits; once a room's drop is taken they turn toward the next: up the first flight into the courtyard, up the second flight to
 * the summit's terrace, and (S-40) once the third is taken, along the ridge to the shortcut's top and down it. Each a way
 * through (x, z) points, drifted along at an even pace (motePathAt).
 */
export const MOTES_TO_ROOM: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = [
  [eastX(85 + 11 - 4), AREA1_PLAZA.center[2]],
  [eastX(113.4), AREA1_STREET.z - 0.4],
  [eastX(114), ROOM1_PEDESTAL.base[2] + 0.4],
];
export const MOTE_PATHS: readonly MotePath[] = [
  MOTES_TO_ROOM,
  [
    [eastX(114), STREET_NORTH_Z + 0.4],
    [eastX(120.4), AREA1_STREET.z - 0.2],
    [AREA1_SLOPE.x, -138.5],
    [eastX(125.5), -143.4],
  ],
  [
    [eastX(124.0), -143.4],
    [AREA1_SLOPE.x, -146.2],
    [AREA1_SLOPE.x, -157.0],
    [eastX(116.5), -163.4],
  ],
  [
    [eastX(115.5), -159.4],
    [eastX(104.0), -159.4],
    [eastX(96.0), -159.2],
    [eastX(96.0), -140.0],
  ],
];

/** A point (x, z) of a way, `u` 0..1 along it at an even pace, written into `out`. */
export function motePathAt(path: MotePath, u: number, out: [number, number] = [0, 0]): [number, number] {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as readonly [number, number];
    const b = path[i] as readonly [number, number];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  let left = Math.min(1, Math.max(0, u)) * total;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as readonly [number, number];
    const b = path[i] as readonly [number, number];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= l || i === path.length - 1) {
      const t = l > 0 ? Math.min(1, left / l) : 0;
      out[0] = a[0] + (b[0] - a[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      return out;
    }
    left -= l;
  }
  const p = path[0] as readonly [number, number];
  out[0] = p[0];
  out[1] = p[1];
  return out;
}

/**
 * 光の揺らぎ (ルール9: 行き止まりには必ず理由を置く — 裏の層の気配): where the back layer glimmers in the air before it is there to
 * walk on: over 部屋3's south roof (the bridge that leads nowhere else), at the shortcut's top over the ridge's edge, and at its
 * foot behind the plaza's gate, drifting up the stairs' line (until the light fixes them). Each a spot and how far it drifts.
 */
export const AREA1_GLIMMERS: readonly { at: Vec3; spread: number; rise: number }[] = [
  { at: [eastX(108.8), SUMMIT_Y + 0.9, -168.0], spread: 1.4, rise: 1.2 },
  { at: [eastX(96), SUMMIT_Y - 0.4, ROOM3_ROOF_N.maxZ + 1.4], spread: 1.0, rise: 1.6 },
  { at: [eastX(96), AREA1_Y + 1.0, -138.6], spread: 1.0, rise: 2.4 },
];

/** 床の材質 (S-22): every floor of エリア1 is 石畳, the back layer's stairs and bridges 曇りガラス (as the prologue's). Boxes or a disc. */
type FloorZoneDecl =
  | { name: string; material: 'stone' | 'frosted'; radius: number; center: readonly [number, number] }
  | { name: string; material: 'stone' | 'frosted'; box: Rect };
const zoneBox = (b: Box): Rect => ({ minX: b.min[0], maxX: b.max[0], minZ: b.min[2], maxZ: b.max[2] });
export const AREA1_FLOOR_ZONES: readonly FloorZoneDecl[] = [
  {
    name: 'area1-plaza',
    material: 'stone',
    radius: AREA1_PLAZA.radius,
    center: [AREA1_PLAZA.center[0], AREA1_PLAZA.center[2]],
  },
  {
    name: 'area1-street',
    material: 'stone',
    box: { minX: AREA1_STREET.minX, maxX: AREA1_STREET.maxX, minZ: STREET_SOUTH_Z, maxZ: STREET_NORTH_Z },
  },
  {
    name: 'area1-alley',
    material: 'stone',
    box: { minX: ROOM1_ALLEY.minX, maxX: ROOM1_ALLEY.maxX, minZ: ROOM1_ALLEY.minZ, maxZ: ROOM1_ALLEY.maxZ },
  },
  {
    name: 'area1-slope',
    material: 'stone',
    box: {
      minX: AREA1_SLOPE.x - AREA1_SLOPE.halfWidth,
      maxX: AREA1_SLOPE.x + AREA1_SLOPE.halfWidth,
      minZ: AREA1_SLOPE.toZ,
      maxZ: AREA1_SLOPE.fromZ,
    },
  },
  {
    name: 'area1-court-stairs',
    material: 'frosted',
    box: rectAt(130.2, 131.6, ROOM2_STAIRS_FOOT_Z, ROOM2_STAIRS.topZ),
  },
  { name: 'area1-court', material: 'stone', box: ROOM2_COURT },
  { name: 'area1-balcony', material: 'stone', box: ROOM2_BALCONY },
  { name: 'area1-summit', material: 'stone', box: ROOM3_TERRACE },
  { name: 'area1-bridge-n', material: 'frosted', box: zoneBox(ROOM3_BRIDGE_N) },
  { name: 'area1-bridge-s', material: 'frosted', box: zoneBox(ROOM3_BRIDGE_S) },
  { name: 'area1-roof-n', material: 'stone', box: ROOM3_ROOF_N },
  { name: 'area1-roof-s', material: 'stone', box: ROOM3_ROOF_S },
  {
    name: 'area1-shortcut',
    material: 'frosted',
    box: rectAt(94.6, 97.4, SHORTCUT_STAIRS.topZ, SHORTCUT_STAIRS.landingZ),
  },
];

/**
 * The height of the walkable ground at (x, z) in エリア1, or null off it (落下死はない: the fall guard's floor follows it). The road
 * is the town's (prologue/layout.ts groundHeight). Under the courtyard's stair (back layer) its floor. Where only the back layer is
 * walkable over nothing (the bridges over the valley, the shortcut's stairs), the height of that footing: the fall guard then
 * holds the body a metre under it, never many metres down (nobody walks there unless it is there).
 */
export function area1Ground(x: number, z: number): number | null {
  const [cx, , cz] = AREA1_PLAZA.center;
  if (Math.hypot(x - cx, z - cz) <= AREA1_PLAZA.radius + 0.3) return AREA1_Y;
  if (x >= AREA1_STREET.minX && x <= AREA1_STREET.maxX && z >= STREET_SOUTH_Z && z <= STREET_NORTH_Z)
    return AREA1_Y;
  if (inRect(ROOM1_ALLEY, x, z)) return AREA1_Y;
  if (Math.abs(x - AREA1_SLOPE.x) <= AREA1_SLOPE.halfWidth && z <= AREA1_SLOPE.fromZ && z >= AREA1_SLOPE.toZ)
    return area1SlopeHeight(z);
  if (inRect(ROOM2_BALCONY, x, z)) return ROOM2_BALCONY.y;
  // (the courtyard's stair stands on its floor: the floor is the ground under it, there or not)
  if (inRect(ROOM2_COURT, x, z)) return COURT_Y;
  if (inRect(ROOM3_TERRACE, x, z)) return SUMMIT_Y;
  // the valley: its bridges' height (nothing else is walkable there)
  if (x >= ROOM3_VALLEY.minX && x <= ROOM3_VALLEY.maxX && z >= ROOM3_ROOF_S.minZ && z <= ROOM3_ROOF_N.maxZ)
    return SUMMIT_Y;
  if (inRect(ROOM3_ROOF_N, x, z) || inRect(ROOM3_ROOF_S, x, z)) return SUMMIT_Y;
  if (x >= SHORTCUT_STAIRS.minX && x <= SHORTCUT_STAIRS.maxX) {
    const h = shortcutHeight(z);
    if (h !== null) return h;
  }
  return null;
}

/**
 * Where the far town's bubbles (plaza.ts: エリア1's hill, built with the town while loading) must not stand: the road's end,
 * the entrance plaza and the street with their houses, the slope up to the summit, (S-40) the courtyard and the summit with its
 * roofs and the shortcut's stairs (they would stand in the way, or show through the grey houses). Clear of the street's
 * chimneys (plaza.ts streetChimneys: the landmark's foot stands east of the summit's houses).
 */
export const AREA1_KEEP_OUT: readonly Rect[] = [
  rectAt(60, 86, -131, -120),
  rectAt(78, 131, -150, -106),
  rectAt(112, 131, -162, -126),
  rectAt(86, 131, -169.8, -145),
  rectAt(122, 133.4, -153, -130),
];

/** Yaw that looks along (dx, dz) (S-03: 0 looks down −Z, positive turns left). */
const yawToward = (dx: number, dz: number): number => Math.atan2(-dx, -dz);
/** A view from `feet` at the eye looking at `at`. */
function viewAt(feet: Vec3, at: Vec3): { feet: Vec3; yaw: number; pitch: number } {
  const dx = at[0] - feet[0];
  const dz = at[2] - feet[2];
  return { feet, yaw: yawToward(dx, dz), pitch: Math.atan2(at[1] - (feet[1] + 1.6), Math.hypot(dx, dz)) };
}

/**
 * 見る位置 (?spawn=…): on the road where the sky moves toward morning, in the entrance plaza looking up at the chimney, before
 * 部屋1's alley (the wall and the pedestal ahead), before its wall looking at the drop behind it; (S-40) at the slope's foot
 * looking up the first flight, at 部屋2's courtyard and before each of its pedestals, at the summit where the slope arrives, at
 * 部屋3's edge (both bridges ahead), at the shortcut's top looking down to the plaza, and at its foot in the plaza.
 */
export const AREA1_SPAWNS = {
  'area1-road': {
    feet: [(DAY.fromX + DAY.toX) / 2, AREA1_Y, AREA1_ROAD.z] as Vec3,
    // looking east, along the road (yaw: 0 looks down −Z, positive turns left)
    yaw: Math.atan2(-COMPASS.east[0], -COMPASS.east[1]),
    pitch: 0.1,
  },
  'area1-plaza': (() => {
    const feet: Vec3 = [eastX(85 + 11 - 4), AREA1_Y, AREA1_PLAZA.center[2] + 4];
    const top: Vec3 = [AREA1_CHIMNEY.foot[0], TOWN.center[1] + AREA1_CHIMNEY.top - 9, AREA1_CHIMNEY.foot[2]];
    return viewAt(feet, top);
  })(),
  'area1-alley': {
    feet: [eastX(113.9), AREA1_Y, AREA1_STREET.z + 0.4] as Vec3,
    yaw: Math.PI,
    pitch: -0.1,
  },
  /** 部屋1, before the crumbled wall, the vidro in hand, looking at where the drop hovers behind it (覗けば見える). */
  'area1-wall': viewAt([eastX(113.6), AREA1_Y, ROOM1_WALL.box.min[2] - 1.0], ROOM1_DROP.at),
  /** At the slope's foot looking up the first flight, toward the courtyard's corner (the last of 部屋1's lamps). */
  'area1-slope': (() => {
    const lamp = NEXT_LAMPS_BY_ROOM.room1.at(-1) as Vec3;
    return viewAt([eastX(121 - 0.4), area1SlopeHeight(-130), -130], [lamp[0], lamp[1] - 1.2, lamp[2]]);
  })(),
  /** 部屋2: on the landing at the courtyard's opening, the balcony, the stair and both pedestals ahead. */
  'area1-court': viewAt(
    [AREA1_SLOPE.x + 0.6, COURT_Y, -143.6],
    [eastX(129.5), ROOM2_BALCONY.y + 0.6, -141.2],
  ),
  /** Before 台座 A (by the stair), looking at where the drop hovers on the balcony. */
  'area1-court-a': viewAt([eastX(132.0), COURT_Y, -145.6], ROOM2_DROP.at),
  /** Before 台座 B, looking at where the drop hovers behind the wall. */
  'area1-court-b': viewAt([eastX(128.2), COURT_Y, -145.0], ROOM2_DROP.at),
  /** 部屋3: where the slope arrives on the summit, the valley and the roofs across it ahead (west). */
  'area1-summit': viewAt(
    [AREA1_SLOPE.x, SUMMIT_Y, AREA1_SLOPE.toZ - 1.2],
    [eastX(108), SUMMIT_Y + 0.6, -163.4],
  ),
  /** 部屋3's edge (端), between the bridges, looking across the valley (覗いてから置く). */
  'area1-edge': viewAt(ROOM3_EDGE, [eastX(109.5), SUMMIT_Y + 0.4, -163.4]),
  /** The shortcut's top on the north roof, looking down the stairs to the entrance plaza. */
  'area1-shortcut': viewAt([eastX(96), SUMMIT_Y, ROOM3_ROOF_N.maxZ - 0.8], [eastX(96), AREA1_Y + 1, -128]),
  /** The shortcut's foot in the entrance plaza, looking up the stairs to the summit. */
  'area1-shortcut-foot': viewAt([eastX(96), AREA1_Y, -131.5], [eastX(96), SUMMIT_Y + 2, -159]),
} as const;
