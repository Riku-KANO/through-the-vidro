import type { FloorMaterial } from '../../audio/footsteps';
import { type Box, type FootingSegment, splitFooting, type Vec3 } from '../../layers/footing';

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
 * The furnace (炉) on the right, the only warm light of the workshop (光と時間帯: 夜明け前の青). A cluster of milky-glass
 * bubbles (形のルール: 泡の集合) glowing from inside; `radius` is its footprint.
 */
export const FURNACE = { center: [2.35, 0, -1.4] as Vec3, radius: 0.95 };
/** Unit (x, z) the furnace's mouth faces: the centre of the dome, where the grate is. */
export const FURNACE_FACING: readonly [number, number] = (() => {
  const l = Math.hypot(FURNACE.center[0], FURNACE.center[2]);
  return [-FURNACE.center[0] / l, -FURNACE.center[2] / l] as const;
})();
/** Distance from the furnace's centre to its glowing mouth (the fire at the back of the opening), and its height. */
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
/**
 * The objects of WORKSHOP_ASSET (設計書 命名規則: <area>_<kind>_<id>, A0 = 序章) and where each stands (x, z). `col`: it has a
 * collider (_col) shaped like it (空間の可読性と導線 4); the grate is floor, the chime hangs above the head, the pieces
 * stand on furniture.
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
} as const satisfies Record<string, { name: string; at: readonly [number, number]; col: boolean }>;

/** The middle of the shelf's arc at its lowest tier (x, z). */
function shelfPoint(): [number, number] {
  const a = (((WORKS_SHELF.fromDeg + WORKS_SHELF.toDeg) / 2) * Math.PI) / 180;
  const r = shelfFrontRadius(WORKS_SHELF.tiers[0] ?? 0) + WORKS_SHELF.depth / 2;
  return [r * Math.cos(a), r * Math.sin(a)];
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
 */
export const GATE = { z: -20.6, halfWidth: FAR.maxX, height: 2.7, depth: 0.2 };

/** 街灯 (乳白ガラス) along the way, on thin brass posts at its edges. Height of the globe's centre. */
export const LAMPS: readonly { x: number; z: number }[] = [
  { x: 1.12, z: -6.2 },
  { x: -1.12, z: -9.4 },
  { x: 1.12, z: -12.6 },
];
export const LAMP_HEIGHT = 2.25;
export const LAMP_POST_RADIUS = 0.035;

/** The town and the lighthouse across the valley (ルール5: 灯塔は街のどこからでも見える). */
export const LIGHTHOUSE: Vec3 = [3, 0, -82];

/**
 * 床の材質 (S-22: 足音は床の材質ごとに変える — 石畳・曇りガラス・真鍮の格子), as S-06 drew and built the floors:
 *  - the workshop's floor disc is frosted glass (room-art.ts createFrostedFloorMaterial; its walk collider has the same
 *    radius). It lies over the start of the way, so inside the door it is still glass.
 *  - the one way and the far shore are 石畳 (room-art.ts stoneMaterial; S-06: 一本道は縁の真鍮の線と石畳で読める).
 *  - the back layer's bridge deck is frosted glass (room-art.ts deckMaterial: 歩く床は曇り、手すりだけ透明).
 *  - 真鍮の格子: the grate in front of the furnace (S-24, GRATE; the workshop's glb draws it on the glass floor). It is
 *    the only brass underfoot: what you hear is what you see (空間の可読性 4). Listed first, so it wins over the disc.
 * The first zone that holds a point decides; off every floor the answer is 石畳, the town's ground.
 */
export interface FloorZone {
  readonly name: string;
  readonly material: FloorMaterial;
  /** A disc around the origin (the workshop), a box on x and z, or a rectangle turned to face `axis`. */
  readonly radius?: number;
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
];

function inZone(f: FloorZone, x: number, z: number): boolean {
  if (f.radius !== undefined) return Math.hypot(x, z) <= f.radius;
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
