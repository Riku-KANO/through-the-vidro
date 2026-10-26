import type { FloorMaterial } from '../../audio/footsteps';
import { type Box, type FootingSegment, splitFooting, type Vec3 } from '../../layers/footing';
import type { SettleSweep } from '../../layers/settle';
import type { AreaDecl } from '../area';
import { COMPASS } from '../area/compass';
import { AREA1_CHIMNEY, AREA1_FLOOR_ZONES, AREA1_ROAD, AREA1_SPAWNS } from '../area1/layout';

export { AREA1_CHIMNEY };

/**
 * 序章「工房」 (進行構造とエリア設計): the workshop at the edge of the town, before dawn.
 * パズル設計 > 難易度の曲線: a one way with no way to fail, to learn 覗く → 置く → 渡る by doing it.
 *
 * Plain data shared by the scene (meshes), the physics (Rapier colliders) and the tests, so what is
 * drawn is what is walked on (空間の可読性と導線 4: 当たり判定は見た目に正直に).
 * Frame: the one way runs toward -Z, every walkable top is at y = 0. Lengths in metres.
 * Values without a design-doc section are 仮 (listed in process/slices/S-06.md).
 */

export interface Spawn {
  feet: Vec3;
  /** Radians; 0 looks down -Z, positive turns left (S-03 PlayerController). */
  yaw: number;
  /** Radians; positive looks up. */
  pitch: number;
}

/**
 * The workshop: a glass dome cut from a sphere whose centre lies below the floor, so the wall rises
 * steeply from the floor. Open at the top (天窓: the dive from the home orb passes through it) and at
 * a door toward the way out.
 */
export const WORKSHOP = {
  sphereCenterY: -0.8,
  radius: 4.7,
  /** Radius of the skylight at the top. */
  oculus: 0.8,
  /** Door toward -Z: half width at the floor (rounded to whole dome columns), and height. */
  door: { halfWidth: 0.85, height: 2.4 },
} as const;
/** Radius of the dome where it meets the floor. */
export const WORKSHOP_FLOOR_RADIUS = Math.sqrt(WORKSHOP.radius ** 2 - WORKSHOP.sphereCenterY ** 2);
/** Highest point of the dome (the rim of the skylight is a little lower). */
export const WORKSHOP_TOP = WORKSHOP.sphereCenterY + WORKSHOP.radius;

/** Radius of the dome's wall at height y (the wall leans in as it rises: furniture against it follows it). */
export function domeWallRadius(y: number): number {
  return Math.sqrt(Math.max(0, WORKSHOP.radius ** 2 - (y - WORKSHOP.sphereCenterY) ** 2));
}

/*
 * The workshop's interior (S-24, the plan the designer approved on 2026-10-22): 職人がついさっきまで仕事をしていた工房.
 * 世界観 > 語り口: 寂しさではなく見つける喜び、まだそこで暮らしている気配. Furniture keeps to the walls; the walk from where
 * you wake to the bench and out of the door, and the floor under the skylight, stay clear (空間の可読性と導線).
 * Modelled in Blender by script (blender/scripts/make_workshop.py, the same numbers) and loaded from WORKSHOP_ASSET;
 * src/game/assets/workshop-asset.test.ts checks that the exported objects stand where these say. Positions are 仮
 * (the plan allows moving them while keeping its rules).
 */

/** 作業台: a frosted-glass top on a brass frame, top at 0.9 m, along the wall left of the door (it was wood until S-24). */
export const BENCH = { center: [-1.55, 0, -2.45] as Vec3, size: [2.1, 0.9, 0.8] as Vec3 };
/** 作業台に一つだけ残っていたビードロ (世界観 > 主人公): where the orb rests on the bench. */
export const BENCH_ORB: Vec3 = [-1.55, 0.99, -2.28];
/**
 * The furnace (炉) on the right, the only warm light of the workshop (光と時間帯: 夜明け前の青). S-31: a low, wide bubble dome
 * of thick glass in the words of the annealer at the back (形のルール: 泡の集合), bigger than it; its mouth an opening in the
 * dome's front rimmed with a brass ring, the fire burning red deep in it (S-27), the chimney a brass pipe straight up. The
 * glass is sooty frosted glass in the prologue's pale blue-grey, the soot only licking up from the mouth (色の進行; S-30). `radius` is the dome's at the floor; its axis stands 0.12 m toward the wall from `center`, so its foot
 * stays short of the grate (make_workshop.py KILN).
 */
export const FURNACE = { center: [2.35, 0, -1.4] as Vec3, radius: 1.0 };
/** Unit (x, z) the furnace's mouth faces: the centre of the dome, where the grate is. */
export const FURNACE_FACING: readonly [number, number] = (() => {
  const l = Math.hypot(FURNACE.center[0], FURNACE.center[2]);
  return [-FURNACE.center[0] / l, -FURNACE.center[2] / l] as const;
})();
/**
 * Distance from the furnace's centre to its glowing mouth — the fire in the cave behind the opening in the dome's front (the
 * opening's middle is 0.79 m out, the cave's bottom 0.4 m: make_workshop.py) — and its height.
 */
const MOUTH_REACH = 0.62;
/** The fire in the furnace's mouth: where its light stands (S-25: the furnace's burning sound). */
export const FURNACE_MOUTH: Vec3 = [
  FURNACE.center[0] + FURNACE_FACING[0] * MOUTH_REACH,
  0.46,
  FURNACE.center[2] + FURNACE_FACING[1] * MOUTH_REACH,
];
/**
 * 真鍮の格子 on the floor in front of the furnace (空間の可読性と導線 1: 床と道は曇りガラス・石畳・真鍮の格子): `depth` along
 * the furnace's facing, from `near` metres off its centre, `width` across. Footsteps there are brass (FLOOR_ZONES).
 */
export const GRATE = { near: 0.9, depth: 1.0, width: 1.3 } as const;
/** Centre (x, z) of the grate. */
export const GRATE_CENTER: readonly [number, number] = [
  FURNACE.center[0] + FURNACE_FACING[0] * (GRATE.near + GRATE.depth / 2),
  FURNACE.center[2] + FURNACE_FACING[1] * (GRATE.near + GRATE.depth / 2),
];
/** One blowpipe left in the furnace's mouth reaches this far from the furnace's centre (it rests on a brass yoke). */
export const MOUTH_PIPE_REACH = 1.75;
/** 吹き竿の立て掛け: brass blowpipes leaning on a rail along the wall, right of the furnace. */
export const BLOWPIPE_RACK = { center: [3.45, 0, 0.55] as Vec3, fromDeg: -3, toDeg: 19 };
/** マーバー台 (a brass slab on frosted-glass legs) with a vessel half made on it; long side along the wall. */
export const MARVER = { center: [2.3, 0, 1.6] as Vec3, size: [0.9, 0.85, 0.5] as Vec3 };
/** 水桶: a frosted-glass tub with brass hoops, left of the marver (S-25: a drop falls into it). Water surface at `water`. */
export const WATER_TUB = { center: [1.45, 0, 1.85] as Vec3, radius: 0.33, height: 0.46, water: 0.36 };
/**
 * S-25: where a drop falls into the tub — from the wet brass ladle hung on its rim, onto the water. The ladle's bowl
 * hangs 0.08 m from the tub's middle toward the room's centre and 0.03 m to the right of that (make_workshop.py
 * water_tub, its Frame); the drop meets the water straight below it.
 */
export const TUB_DRIP: Vec3 = (() => {
  const [cx, , cz] = WATER_TUB.center;
  const l = Math.hypot(cx, cz);
  const [fx, fz] = [-cx / l, -cz / l];
  // make_workshop.py Frame: right of the facing is (-fz, fx)
  return [cx + fx * 0.08 - fz * 0.03, WATER_TUB.water, cz + fz * 0.08 + fx * 0.03];
})();
/**
 * 徐冷炉: a frosted-glass bubble at the back, warm inside (finished pieces cooling), with an arched mouth toward the centre
 * `mouthHalfDeg` either side and `mouthHeight` high.
 */
export const ANNEALER = {
  center: [0.3, 0, 3.4] as Vec3,
  radius: 0.66,
  height: 1.0,
  mouthHalfDeg: 36,
  mouthHeight: 0.6,
};
/**
 * 作品の棚: three tiers in an arc along the wall, from the left side round to the back (azimuth from +X toward +Z, the
 * dome's own). Each tier follows the leaning wall: its back stays `wallGap` off the glass at its height.
 */
export const WORKS_SHELF = {
  fromDeg: 115,
  toDeg: 165,
  tiers: [0.42, 0.88, 1.34] as readonly number[],
  depth: 0.3,
  wallGap: 0.06,
} as const;
/** Radius of the front edge of a shelf tier at height y. */
export function shelfFrontRadius(y: number): number {
  return domeWallRadius(y) - WORKS_SHELF.wallGap - WORKS_SHELF.depth;
}
/** 椅子: a stool left of the bench, pushed back as if someone just stood up. */
export const CHAIR = { center: [-3.0, 0, -1.4] as Vec3, radius: 0.24, seat: 0.46 };
/** 飲みかけの湯のみ on the left end of the bench. */
export const TEA_CUP: Vec3 = [-2.38, 0.9, -2.2];
/** 風鈴 above the door, inside (S-25: the wind from the door rings it). The bell's centre. */
export const WIND_CHIME: Vec3 = [0, 2.22, -3.22];

/** The workshop's glb (`pnpm assets`, job "workshop"), under the app's base URL. */
export const WORKSHOP_ASSET = 'assets/workshop/a0.glb';
/** Where S-27's pipe bucket stands by the marver and the cart by the annealer (make_workshop.py PIPE_BUCKET, ANNEAL_CART). */
const PIPE_BUCKET_AT = { a: 0.5, s: 0.25 } as const;
const ANNEAL_CART_AT = { a: 0.06, s: 1.12 } as const;
/**
 * The shelf's back board (make_workshop.py SHELF_BOARD): from 0.3 m up to 0.44 m above the top tier, 8 mm off the glass,
 * 2 cm thick.
 */
const SHELF_BOARD_AT = { fromY: 0.3, aboveTop: 0.44, gap: 0.008, thick: 0.02 } as const;

/**
 * The objects of WORKSHOP_ASSET (設計書 命名規則: <area>_<kind>_<id>, A0 = 序章) and where each stands (x, z). `col`: it has a
 * collider (_col) shaped like it (空間の可読性と導線 4); the grate is floor, the chime hangs above the head, the pieces
 * stand on furniture. Every object of the file is here (S-30), so the unit tests (place, budget, collider size, the rays
 * both ways) and room.ts's `missing` see them all: the last nine are what S-27 left about the bench, the marver and the
 * annealer, and the shelf's back board (世界観 > まだそこで暮らしている気配); make_workshop.py holds where they stand.
 */
export const WORKSHOP_OBJECTS = {
  bench: { name: 'A0_bnch_work01', at: [BENCH.center[0], BENCH.center[2]], col: true },
  benchWares: { name: 'A0_ware_bench01', at: [BENCH.center[0], BENCH.center[2]], col: false },
  furnace: { name: 'A0_frn_furnace01', at: [FURNACE.center[0], FURNACE.center[2]], col: true },
  grate: { name: 'A0_grt_floor01', at: GRATE_CENTER, col: false },
  rack: { name: 'A0_pipe_rack01', at: [BLOWPIPE_RACK.center[0], BLOWPIPE_RACK.center[2]], col: true },
  marver: { name: 'A0_mrv_marver01', at: [MARVER.center[0], MARVER.center[2]], col: true },
  marverWare: { name: 'A0_ware_marver01', at: [MARVER.center[0], MARVER.center[2]], col: false },
  tub: { name: 'A0_tub_water01', at: [WATER_TUB.center[0], WATER_TUB.center[2]], col: true },
  annealer: { name: 'A0_anl_annealer01', at: [ANNEALER.center[0], ANNEALER.center[2]], col: true },
  annealerWares: { name: 'A0_ware_anneal01', at: [ANNEALER.center[0], ANNEALER.center[2]], col: false },
  shelf: { name: 'A0_shlf_works01', at: shelfPoint(), col: true },
  shelfClear: { name: 'A0_ware_clear01', at: shelfPoint(), col: false },
  shelfBubble: { name: 'A0_ware_bubble01', at: shelfPoint(), col: false },
  shelfFrost: { name: 'A0_ware_frost01', at: shelfPoint(), col: false },
  chair: { name: 'A0_chr_stool01', at: [CHAIR.center[0], CHAIR.center[2]], col: true },
  cup: { name: 'A0_cup_tea01', at: [TEA_CUP[0], TEA_CUP[2]], col: false },
  chime: { name: 'A0_chim_door01', at: [WIND_CHIME[0], WIND_CHIME[2]], col: false },
  // S-27 (make_workshop.py bench_tools, bench_shelf_wares, marver_tools, pipe_bucket, anneal_cart, anneal_tools,
  // cart_wares, shelf_wares, shelf_board)
  benchTools: { name: 'A0_tool_bench01', at: [BENCH.center[0], BENCH.center[2]], col: false },
  benchShelfWares: { name: 'A0_ware_bench02', at: [BENCH.center[0], BENCH.center[2]], col: false },
  marverTools: { name: 'A0_tool_marver01', at: [MARVER.center[0], MARVER.center[2]], col: false },
  pipeBucket: { name: 'A0_bkt_marver01', at: beside(MARVER.center, PIPE_BUCKET_AT), col: true },
  cart: { name: 'A0_cart_anneal01', at: beside(ANNEALER.center, ANNEAL_CART_AT), col: true },
  cartTools: { name: 'A0_tool_anneal01', at: beside(ANNEALER.center, ANNEAL_CART_AT), col: false },
  cartWares: { name: 'A0_ware_cart01', at: beside(ANNEALER.center, ANNEAL_CART_AT), col: false },
  shelfOpal: { name: 'A0_ware_opal01', at: shelfPoint(), col: false },
  shelfBoard: { name: 'A0_shlf_board01', at: shelfBoardPoint(), col: true },
  // S-26 (make_workshop.py floor, dome_frame): moved from room-art.ts into the glb to be baked with the rest
  floor: { name: 'A0_flr_floor01', at: [0, 0], col: false },
  frame: { name: 'A0_bld_frame01', at: [0, 0], col: false },
} as const satisfies Record<string, { name: string; at: readonly [number, number]; col: boolean }>;

/** The middle of the shelf's arc at its lowest tier (x, z). */
function shelfPoint(): [number, number] {
  const a = (((WORKS_SHELF.fromDeg + WORKS_SHELF.toDeg) / 2) * Math.PI) / 180;
  const r = shelfFrontRadius(WORKS_SHELF.tiers[0] ?? 0) + WORKS_SHELF.depth / 2;
  return [r * Math.cos(a), r * Math.sin(a)];
}

/** The middle of the shelf's back board (x, z): on the leaning wall at the board's middle height (SHELF_BOARD_AT). */
function shelfBoardPoint(): [number, number] {
  const { fromY, aboveTop, gap, thick } = SHELF_BOARD_AT;
  const a = (((WORKS_SHELF.fromDeg + WORKS_SHELF.toDeg) / 2) * Math.PI) / 180;
  const y = (fromY + (WORKS_SHELF.tiers[WORKS_SHELF.tiers.length - 1] ?? 0) + aboveTop) / 2;
  const r = domeWallRadius(y) - gap - thick / 2;
  return [r * Math.cos(a), r * Math.sin(a)];
}

/**
 * A point (x, z) by a piece of furniture standing at `c`: `a` metres toward the centre of the dome and `s` to the right of
 * that (make_workshop.py Frame).
 */
function beside(c: Vec3, { a, s }: { a: number; s: number }): [number, number] {
  const l = Math.hypot(c[0], c[2]);
  const [fx, fz] = [-c[0] / l, -c[2] / l];
  return [c[0] + fx * a - fz * s, c[2] + fz * a + fx * s];
}

/** The way from the door to the broken edge (一本道). Starts inside the door, under the floor disc. */
export const PATH = { minX: -1.3, maxX: 1.3, minZ: -14, maxZ: -4.4 };
/** The collapsed floor ends here; beyond is the valley (崩れた床の先の谷). */
export const EDGE_Z = PATH.minZ;
/** The far shore: a landing as wide as the path, closed by a gate at its back. */
export const FAR = { minX: -1.4, maxX: 1.4, minZ: -21.2, maxZ: -16.8 };
/** The back-layer bridge over the gap (裏にだけあるもの: 橋). Deck top at 0. */
export const BRIDGE: Box = { min: [-0.6, -0.14, FAR.maxZ], max: [0.6, 0, EDGE_Z] };
/** 仮 (S-02): length of a back-layer footing segment (技術設計 > 裏の層の実装: 細かい区画). */
export const FOOTING_SEGMENT = 0.4;
/**
 * The bridge deck is a gentle arch (no corners: a cosine bump, level where it meets the shores), so that
 * from the dead end, peeking and looking across, its floor rises into the hand orb (体験の核 2: 行き止まりに
 * 見えた場所に、玉越しにだけ橋が架かっている). The steepest part is atan(π·rise/length) (≈24° for 0.4 m over
 * 2.8 m), well inside what the body climbs (S-03: 40°). 仮.
 */
export const BRIDGE_RISE = 0.4;

/** Height of the deck's top at z (0 on the shores). */
export function deckHeight(z: number): number {
  const lo = BRIDGE.min[2];
  const hi = BRIDGE.max[2];
  if (z <= lo || z >= hi) return 0;
  const s = (2 * (z - lo)) / (hi - lo) - 1; // -1..1 along the bridge
  return (BRIDGE_RISE / 2) * (1 + Math.cos(Math.PI * s));
}

/**
 * S-02's footing segments of the bridge, each box tall enough for the arch over its length (so 拾う前の
 * 安全確認 and the sphere overlap see the deck where it is).
 */
export function bridgeFooting(): FootingSegment[] {
  return splitFooting('bridge', BRIDGE, FOOTING_SEGMENT).map((seg) => {
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 8; i++) {
      const h = deckHeight(seg.min[2] + ((seg.max[2] - seg.min[2]) * i) / 8);
      top = Math.max(top, h);
      bottom = Math.min(bottom, h);
    }
    return {
      ...seg,
      min: [seg.min[0], bottom + BRIDGE.min[1], seg.min[2]],
      max: [seg.max[0], top, seg.max[2]],
    };
  });
}

/** 台座 at the dead end, left of where the bridge will be (行き止まりには必ず理由を置く: 台座). */
export const PEDESTAL_ID = 'dead-end';
export const PEDESTAL_BASE: Vec3 = [-0.95, 0, -13.5];
/** Where a placed orb sits: the centre of the materialized sphere. */
export const PEDESTAL_ORB: Vec3 = [-0.95, 1.05, -13.5];
/** Collision radius of the pedestal's foot (the drawn foot is 0.26 m). */
export const PEDESTAL_RADIUS = 0.26;

/**
 * S-24's trial only (?trial=surface-wall; S-23 判断待ち9): a broken glass wall on the surface layer (裏の層のルール: 表にだけ
 * あるもの: 崩れた壁) standing on the lip of the dead end, across the way onto the bridge, inside the placed orb's sphere.
 * Its collider is cut inside a placed orb's sphere (S-28, physics.ts SurfaceColliders).
 */
export const TRIAL_SURFACE_WALL: Box = { min: [-0.68, 0, EDGE_Z + 0.04], max: [0.78, 1.0, EDGE_Z + 0.16] };

/** 光の雫 (裏の層にしかない): hovering just past the bridge, over the far shore. */
export const DROP: Vec3 = [-0.2, 1.2, -17.0];

/**
 * A closed gate at the back of the far shore: the way on, with the town seen through its bars
 * (ルール6: 次に行く場所が先に見えている, ルール9: 理由のない行き止まりは作らない).
 * S-34: it opens once the light of the taken drop has run across the bridge to the far shore (発案者 2026-10-23,
 * session.ts GATE_OPENS_AT_SECONDS) — two brass leaves hinged at its posts, swinging away from the far shore (finale.ts
 * draws them, physics.ts GateLeaves collides as them).
 */
export const GATE = { z: -20.6, halfWidth: FAR.maxX, height: 2.7, depth: 0.2 };
/** Height where the gate's arch springs from its posts (the arch rises 0.6 of its half width above it). */
export const GATE_SPRINGS = GATE.height - GATE.halfWidth * 0.6;
/**
 * 仮 (S-34): how far the leaves swing open. A little past square, so that open they lie just outside the road's edges, out of
 * the way (out over the drop, like a balcony's doors).
 */
export const GATE_OPEN_DEG = 96;

/**
 * S-34: the unit (x, z) along a leaf of the gate from its hinge, `angle` radians from shut; `side` is +1 for the leaf hinged
 * at the right post (+X), -1 for the left. Shut, the leaves run toward the middle; open, away from the far shore (-Z).
 */
export function gateLeafDirection(side: 1 | -1, angle: number): [number, number] {
  return [-side * Math.cos(angle), -Math.sin(angle)];
}

/**
 * 門の先の道 (S-34): past the gate the way goes on as a slope of about 80 m down to the central plaza (進行構造とエリア設計 >
 * 街の配置と序章の締め, 2026-10-23). This is its first 4 m, level — the far shore's stone going on, one slab with it — and
 * the brow where the slope starts to go down (S-35: SLOPE).
 */
export const ROAD = { minX: FAR.minX, maxX: FAR.maxX, minZ: -24.6, maxZ: FAR.minZ };

/*
 * S-35 坂道と中央広場 (進行構造とエリア設計 > 街の配置と序章の締め, 2026-10-23; ハリノの地図 設計案): through the gate, about 80 m
 * of slope down to the central plaza (radius about 25 m) with the broken lighthouse (about 40 m) in its middle; of the
 * plaza's three gates only the east one (エリア1) is open. 序章の後の広場は夜明け前 (the plaza keeps the time of the area
 * last left). Shapes are 仮 (code-made, 泡と曲面と真鍮の枠): what is settled here is where things stand, how the way leads,
 * what is seen from where and what stops the body (process/slices/S-35.md).
 *
 * The town's compass in this frame (S-35; S-39, 発案者 2026-10-25, 設計書 rev 49): the workshop stands due north of the plaza
 * (+Z), so the way down runs south (-Z), and east — エリア1, 朝 — is on its right (+X): the side where the dawn is about to
 * rise in the workshop's sky and where the sun baked into the workshop shines from (room-art.ts DAWN, left as they were).
 * 坂を下りると夜明けの光とエリア1の煙突が同じ東の側に見える. West (エリア3's greenhouse, 夕方) is on the left, south (エリア2's
 * canal) straight on past the plaza. The map's figure has east on the other hand: the town here is its mirror image (left
 * and right swapped), the price of keeping the workshop's sky and bake (S-35 judged east the left, and the dawn read as
 * the west: process/slices/S-35.md 判断待ち1). S-36: the compass itself lives in area/compass.ts (エリア1's layout places along
 * it too).
 */
export { COMPASS };

/** `a`·`u` + `b`·`v` on the ground (x, z): a step off the plaza's centre along two of the compass's directions. */
function along(
  u: readonly [number, number],
  a: number,
  v: readonly [number, number] = [0, 0],
  b = 0,
): [number, number] {
  return [u[0] * a + v[0] * b, u[1] * a + v[1] * b];
}

/** Yaw (S-03 PlayerController: 0 looks down -Z, positive turns left) that looks along (dx, dz) on the ground. */
function yawToward(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/**
 * 坂道 (S-35): one straight way from the brow at the road's end down to the plaza's rim, 80 m from the gate (街の配置: 門から
 * 約 80m の坂道), as wide as the road. It goes down on a cosine (level where it meets the road and the plaza, steepest half
 * way: atan(π·drop / 2·length) ≈ 14° for 12 m over 76 m, well inside what the body climbs, S-03: 40°). 仮: the drop (the
 * design gives the hill no height).
 */
export const SLOPE = { minX: ROAD.minX, maxX: ROAD.maxX, fromZ: ROAD.minZ, toZ: GATE.z - 80, drop: 12 };

/** Height of the slope's top at z (0 above the brow, -drop on the plaza's side of its foot). */
export function slopeHeight(z: number): number {
  if (z >= SLOPE.fromZ) return 0;
  if (z <= SLOPE.toZ) return -SLOPE.drop;
  const t = (SLOPE.fromZ - z) / (SLOPE.fromZ - SLOPE.toZ);
  return (-SLOPE.drop * (1 - Math.cos(Math.PI * t))) / 2;
}

/**
 * Height of the ground you walk on at (x, z): 0 in the workshop, on the way and the far shore (the bridge's arch aside), the
 * slope's on it, the plaza's past its foot. The fall guard's floor is a metre under it (落下死はない).
 */
export function groundHeight(_x: number, z: number): number {
  return slopeHeight(z);
}

/** 中央広場 (街の配置: 半径約 25m): a round terrace of stone at the slope's foot. `center` is on its floor. */
export const PLAZA_RADIUS = 25;
export const PLAZA = {
  center: [0, -SLOPE.drop, SLOPE.toZ - PLAZA_RADIUS] as Vec3,
  radius: PLAZA_RADIUS,
} as const;
export const PLAZA_Y = PLAZA.center[1];

/**
 * 灯塔 (世界観: 中央の灯塔の大玉が割れて光が散った; ハリノの地図: 高さ約 40m, 街のどこからも見える, ルール5): in the middle of the
 * plaza, its foot on the plaza's floor. Stacked bubbles of glass with brass bands, a brass spire, and on top the great orb in
 * its brass cage, broken open. `base` is the bottom bubble (a ball of glass the body walks round: its collider is that ball).
 */
export const LIGHTHOUSE: Vec3 = PLAZA.center;
export const LIGHTHOUSE_HEIGHT = 40;
export const LIGHTHOUSE_BASE = { radius: 5, lift: 1 } as const;

/**
 * The plaza's rim (仮): a balustrade of brass and frosted glass on the circle, with an opening where the slope comes in and
 * one for each of the three gates. `openingHalf` is the half width of an opening along the rim; `height` the rail's.
 */
export const PLAZA_RIM = { height: 1.0, thickness: 0.2, openingHalf: 1.75 } as const;

/**
 * The plaza's three gates (街の配置: 広場から出る3つの門のうち、東のエリア1の門だけが開いている): brass arches in the rim, toward
 * エリア1 (east), エリア2 雫の水路 (south) and エリア3 鐘の温室 (west). The south and west ones are shut, their bars letting the
 * canal and the greenhouse be glimpsed beyond (格子越しに水路と温室の気配が少し見える).
 */
export const PLAZA_GATE = { halfWidth: 1.6, height: 3.6, depth: 0.2 } as const;
export const PLAZA_GATES = [
  { name: 'east', dir: COMPASS.east, open: true },
  { name: 'south', dir: COMPASS.south, open: false },
  { name: 'west', dir: COMPASS.west, open: false },
] as const;
export type PlazaGateName = (typeof PLAZA_GATES)[number]['name'];

/** Where a gate of the plaza stands (x, z): on the rim, along its direction. */
export function plazaGateAt(dir: readonly [number, number], radius: number = PLAZA.radius): [number, number] {
  return [PLAZA.center[0] + dir[0] * radius, PLAZA.center[2] + dir[1] * radius];
}

/**
 * 東の道 (S-35 its first metres; S-36 all of it, area1/layout.ts AREA1_ROAD): from the open east gate about 60 m of stone,
 * as wide as the slope, railings along both sides, on to エリア1's entrance plaza (街の配置: 各エリアの入口の広場まで約 60m). The
 * sky moves from before dawn to the morning along it (area1/layout.ts daylightAt). `length` from the rim to the entrance plaza.
 */
export const EAST_ROAD = {
  length: AREA1_ROAD.length,
  halfWidth: AREA1_ROAD.halfWidth,
  railing: 1.0,
} as const;
/** The east road's end (x): where エリア1's entrance plaza begins. */
export const EAST_ROAD_END_X = PLAZA.center[0] + COMPASS.east[0] * (PLAZA.radius + EAST_ROAD.length);
/**
 * The east road's stone as a box on x and z, from its end to `under` metres in under the plaza's rim (the road runs along
 * x: COMPASS.east is ±X).
 */
export function eastRoadBox(under: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const rimX = PLAZA.center[0] + COMPASS.east[0] * (PLAZA.radius - under);
  return {
    minX: Math.min(EAST_ROAD_END_X, rimX),
    maxX: Math.max(EAST_ROAD_END_X, rimX),
    minZ: PLAZA.center[2] - EAST_ROAD.halfWidth,
    maxZ: PLAZA.center[2] + EAST_ROAD.halfWidth,
  };
}

/**
 * Beyond the shut gates (S-35, 仮: 格子越しに水路と温室の気配): エリア2's canal running south from past the south gate, with its
 * landmark the drop towers (雫塔) along it, and エリア3's greenhouse dome (温室のドーム) far to the west. Placed so that from the
 * plaza, on a gate's axis, they show between its posts. `CANAL`: from `from` to `to` metres past the gate, `halfWidth` of
 * water, its surface `drop` below the plaza's floor. A tower: x off the canal's line, metres past the gate, height.
 */
export const CANAL = { from: 6, to: 110, halfWidth: 1.7, drop: 0.9 } as const;
export const DROP_TOWERS: readonly (readonly [number, number, number])[] = [
  [-6, 60, 24],
  [6, 85, 30],
  [0, 115, 22],
] as const;
/** The towers stand on ground this far below the plaza's floor (in the mist). */
export const DROP_TOWER_FOOT = 4;
/** エリア3's greenhouse: its dome's centre (on the ground, in the mist) and radius, west of the plaza. */
export const GREENHOUSE = {
  center: (() => {
    const [dx, dz] = along(COMPASS.west, PLAZA.radius + 120);
    return [PLAZA.center[0] + dx, PLAZA_Y - 5, PLAZA.center[2] + dz] as Vec3;
  })(),
  radius: 24,
} as const;

/**
 * 光の膜 (S-35; 発案者 2026-10-23: 玉を持たずに坂道へは出られない): a film of light in the gate's arch — the slope's entrance,
 * whose first 4 m are the road — that softly holds whoever comes to it from the far shore without the vidro in hand; the vidro
 * left on its pedestal then glows faintly to say where it is. With the vidro in hand there is nothing to it.
 * `callReach`: the vidro calls while the body is this close to the film, held by it.
 */
export const MEMBRANE = { z: GATE.z, callReach: 0.9 } as const;

/**
 * Where the light motes over the gap (surface layer, room-art.ts: a hint of the bridge) end their drift: they rise just over
 * the dead end's lip and fade 1 m out over the far shore.
 */
export const MOTES_END_Z = EDGE_Z + 0.2 - (EDGE_Z - FAR.maxZ + 1.2);

/**
 * Where room-art.ts scatters the broken edge's surface-only shards and stones (表にだけあるもの: 割れた破片) on the dead end's
 * lip, with their own size (the shards stand up to ~0.11 m off their line, the stones are up to 0.12 m across). The shards
 * and stones are made there from the same numbers; keep the two together (process/slices/S-34.md 残件).
 */
export const LIP_HINTS: Box = { min: [-1.4, -0.1, EDGE_Z - 0.22], max: [1.4, 0.5, EDGE_Z + 0.2] };

/**
 * 定着 (S-34): what the light of the taken drop fixes onto the surface, and the way it runs — from the vidro on the
 * dead-end pedestal across the gap and on a little over the far shore. The box holds the whole bridge (the deck drawn
 * 0.15 m onto each shore, its rails, glass and lanterns) and everything that hints at it (the shards and stones on the lip
 * with a margin, LIP_HINTS; the faint lines and the motes all along their drift, so none of them is left coming out of thin
 * air; S-24's trial wall). Its far end is 1 m out over the far shore: anything surface-only put on that first metre of the
 * far shore would be fixed away with the bridge. It leaves out the pedestal (shared: never cut anyway) and the rest of the
 * far shore with the gate. The drop hovers inside it, but it is taken by the time the light runs. Every footing segment
 * lies wholly inside or outside it (settle.ts segmentsCutByBox; layout.test).
 */
export const BRIDGE_SETTLE: SettleSweep = {
  box: { min: [FAR.minX, -0.6, MOTES_END_Z - 0.05], max: [FAR.maxX, 2.0, LIP_HINTS.max[2] + 0.15] },
  direction: [0, 0, -1],
};

/**
 * 序章「工房」 as an area (S-36 エリアの仕組み, game/area): its one room — the dead-end pedestal, the light drop over the far shore,
 * the back-layer bridge, and the light of the drop settling the bridge (S-34). (S-24's trial wall, ?trial=surface-wall, is
 * the room's to add.)
 */
export const PROLOGUE_AREA: AreaDecl = {
  id: 'prologue',
  rooms: [
    {
      id: 'workshop',
      pedestals: [{ id: PEDESTAL_ID, base: PEDESTAL_BASE, orb: PEDESTAL_ORB }],
      drop: { id: 'prologue', at: DROP },
      footing: [{ id: 'bridge', segments: bridgeFooting() }],
      settle: BRIDGE_SETTLE,
    },
  ],
};

/** 街灯 (乳白ガラス) along the way, on thin brass posts at its edges. Height of the globe's centre. */
export const LAMPS: readonly { x: number; z: number }[] = [
  { x: 1.12, z: -6.2 },
  { x: -1.12, z: -9.4 },
  { x: 1.12, z: -12.6 },
];
export const LAMP_HEIGHT = 2.25;
export const LAMP_POST_RADIUS = 0.035;

/**
 * 床の材質 (S-22: 足音は床の材質ごとに変える — 石畳・曇りガラス・真鍮の格子), as S-06 drew and built the floors:
 *  - the workshop's floor disc is frosted glass (room-art.ts createFrostedFloorMaterial; its walk collider has the same
 *    radius). It lies over the start of the way, so inside the door it is still glass.
 *  - the one way and the far shore are 石畳 (room-art.ts stoneMaterial; S-06: 一本道は縁の真鍮の線と石畳で読める).
 *  - the back layer's bridge deck is frosted glass (room-art.ts deckMaterial: 歩く床は曇り、手すりだけ透明).
 *  - 真鍮の格子: the grate in front of the furnace (S-24, GRATE; the workshop's glb draws it on the glass floor). It is
 *    the only brass underfoot: what you hear is what you see (空間の可読性 4). Listed first, so it wins over the disc.
 *  - S-35: the slope, the plaza and the road past its east gate are 石畳 too (slope.ts, plaza.ts draw them as stone).
 * The first zone that holds a point decides; off every floor the answer is 石畳, the town's ground.
 */
export interface FloorZone {
  readonly name: string;
  readonly material: FloorMaterial;
  /**
   * A disc around `center` (x, z; the origin, the workshop, by default), a box on x and z, or a rectangle turned to face
   * `axis`.
   */
  readonly radius?: number;
  readonly center?: readonly [number, number];
  readonly box?: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
  readonly rect?: {
    readonly center: readonly [number, number];
    /** Unit (x, z) of the rectangle's depth. */
    readonly axis: readonly [number, number];
    readonly halfDepth: number;
    readonly halfWidth: number;
  };
}

export const FLOOR_ZONES: readonly FloorZone[] = [
  {
    name: 'grate',
    material: 'brass',
    rect: {
      center: GRATE_CENTER,
      axis: FURNACE_FACING,
      halfDepth: GRATE.depth / 2,
      halfWidth: GRATE.width / 2,
    },
  },
  { name: 'workshop', material: 'frosted', radius: WORKSHOP_FLOOR_RADIUS + 0.05 },
  { name: 'path', material: 'stone', box: PATH },
  {
    name: 'bridge',
    material: 'frosted',
    box: { minX: BRIDGE.min[0], maxX: BRIDGE.max[0], minZ: BRIDGE.min[2], maxZ: BRIDGE.max[2] },
  },
  { name: 'far', material: 'stone', box: FAR },
  // S-34: the road past the gate, the far shore's stone going on
  { name: 'road', material: 'stone', box: ROAD },
  // S-35: the slope down (a little into the plaza, where it lies on its floor), the plaza, the road past its east gate
  {
    name: 'slope',
    material: 'stone',
    box: { minX: SLOPE.minX, maxX: SLOPE.maxX, minZ: SLOPE.toZ, maxZ: SLOPE.fromZ },
  },
  {
    name: 'plaza',
    material: 'stone',
    radius: PLAZA.radius,
    center: [PLAZA.center[0], PLAZA.center[2]],
  },
  { name: 'east-road', material: 'stone', box: eastRoadBox(0.5) },
  // S-36: エリア1's entrance plaza, its street, the alley of 部屋1 and the slope's foot (area1/layout.ts)
  ...AREA1_FLOOR_ZONES,
];

function inZone(f: FloorZone, x: number, z: number): boolean {
  if (f.radius !== undefined)
    return Math.hypot(x - (f.center?.[0] ?? 0), z - (f.center?.[1] ?? 0)) <= f.radius;
  if (f.box) return x >= f.box.minX && x <= f.box.maxX && z >= f.box.minZ && z <= f.box.maxZ;
  if (f.rect) {
    const dx = x - f.rect.center[0];
    const dz = z - f.rect.center[1];
    const [ax, az] = f.rect.axis;
    return (
      Math.abs(dx * ax + dz * az) <= f.rect.halfDepth && Math.abs(-dx * az + dz * ax) <= f.rect.halfWidth
    );
  }
  return false;
}

/** The floor under a point of the ground: its zone ('none' off every floor) and material. */
export function floorAt(x: number, z: number): { zone: string; material: FloorMaterial } {
  for (const f of FLOOR_ZONES) {
    if (inZone(f, x, z)) return { zone: f.name, material: f.material };
  }
  return { zone: 'none', material: 'stone' };
}

/** 仮: reach of 置く・拾う・調べる (S-02 used 2.5 m). */
export const REACH = 2.5;
/** 仮: a light drop is touched from closer. */
export const DROP_REACH = 1.7;
/** 仮: what you interact with must be within this angle of where you look. */
export const FACING_DEG = 40;

export const SPAWNS = {
  /** In front of the workbench, looking at the orb on it (the dive lands here). */
  bench: { feet: [-1.55, 0, -1.05] as Vec3, yaw: 0, pitch: -0.3 },
  /** Halfway along the way, the dead end and the far shore ahead. */
  path: { feet: [0, 0, -8] as Vec3, yaw: 0, pitch: -0.08 },
  /** Near the dead end, the pedestal on the left and the far shore across the gap. */
  'dead-end': { feet: [0.25, 0, -11.9] as Vec3, yaw: 0.16, pitch: -0.14 },
  /** On the far shore, looking back over the bridge to the pedestal and the workshop. */
  far: { feet: [0.2, 0, -18.2] as Vec3, yaw: Math.PI, pitch: -0.12 },
  /** S-24 views of the workshop: in front of the furnace, past the end of the pipe in its mouth, looking into the fire. */
  furnace: {
    feet: [
      FURNACE.center[0] + FURNACE_FACING[0] * 2.55,
      0,
      FURNACE.center[2] + FURNACE_FACING[1] * 2.55,
    ] as Vec3,
    yaw: Math.atan2(FURNACE_FACING[0], FURNACE_FACING[1]),
    pitch: -0.3,
  },
  /** Before the works shelf, its arc from the left side round to the back. */
  shelf: { feet: [-0.9, 0, 0.75] as Vec3, yaw: 2.27, pitch: -0.23 },
  /** Just inside the door, looking back into the workshop. */
  door: { feet: [0, 0, -3.75] as Vec3, yaw: Math.PI, pitch: -0.12 },
  /** S-34: on the far shore before the gate, looking at it (and through it, the road and the town). */
  gate: { feet: [0.3, 0, -17.4] as Vec3, yaw: 0.05, pitch: 0.02 },
  /** S-34: on the road past the gate, the slope (S-35) and the plaza with its lighthouse ahead. */
  road: { feet: [0.3, 0, -21.6] as Vec3, yaw: -0.04, pitch: -0.07 },
  /**
   * S-35: at the slope's brow, looking down it to the plaza and the broken lighthouse (エリア1's chimney on the right, in the
   * dawn's warm horizon: S-39; the town's views are S-35's mirrored with it).
   */
  slope: { feet: [-0.2, 0, -23.8] as Vec3, yaw: -0.02, pitch: -0.07 },
  /** S-35: in the plaza by the slope's foot (a little to the west of it), looking up at the broken lighthouse. */
  plaza: (() => {
    const [dx, dz] = along(COMPASS.west, 5, COMPASS.north, 22);
    return {
      feet: [PLAZA.center[0] + dx, PLAZA_Y, PLAZA.center[2] + dz] as Vec3,
      yaw: yawToward(-dx, -dz),
      pitch: 0.58,
    };
  })(),
  /** S-35: held at the film in the gate's arch (without the vidro, after the close), looking back at its pedestal. */
  film: {
    feet: [0.2, 0, MEMBRANE.z + 0.3] as Vec3,
    yaw: Math.atan2(1.15, -6.8),
    pitch: -0.08,
  },
  /** S-35: in the plaza, looking at the shut south gate: the canal and its drop towers beyond the bars (エリア2). */
  south: {
    feet: [PLAZA.center[0], PLAZA_Y, PLAZA.center[2] - 12.5] as Vec3,
    yaw: 0,
    pitch: 0.06,
  },
  /** S-35: in the plaza, looking at the shut west gate: the greenhouse's dome beyond the bars (エリア3). */
  west: (() => {
    const [dx, dz] = along(COMPASS.west, 12.5);
    return {
      feet: [PLAZA.center[0] + dx, PLAZA_Y, PLAZA.center[2] + dz] as Vec3,
      yaw: yawToward(...COMPASS.west),
      pitch: 0.06,
    };
  })(),
  /**
   * S-35: in the plaza, looking at the open east gate (エリア1), its short road and the chimney's hill beyond (S-39: toward the
   * dawn, its warm sky beside the gate).
   */
  east: (() => {
    const [dx, dz] = along(COMPASS.east, 9, COMPASS.north, 4);
    // to the gate on the rim: 16 m on east, 4 m back south
    const [tx, tz] = along(COMPASS.east, 16, COMPASS.south, 4);
    return {
      feet: [PLAZA.center[0] + dx, PLAZA_Y, PLAZA.center[2] + dz] as Vec3,
      yaw: yawToward(tx, tz),
      pitch: 0.06,
    };
  })(),
  /**
   * S-36: エリア1 — on the road where the sky moves toward morning, in the entrance plaza looking up at the chimney, before
   * 部屋1's alley, before the slope's shut gate (area1/layout.ts AREA1_SPAWNS).
   */
  ...AREA1_SPAWNS,
} as const satisfies Record<string, Spawn>;

export type SpawnName = keyof typeof SPAWNS;

export function isSpawnName(value: unknown): value is SpawnName {
  return typeof value === 'string' && Object.hasOwn(SPAWNS, value);
}

/** Unit vector the camera looks along for a yaw and pitch (three.js: 0 yaw looks down -Z). */
export function lookDirection(yaw: number, pitch: number, out: [number, number, number] = [0, 0, 0]): Vec3 {
  const c = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * c;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * c;
  return out;
}
