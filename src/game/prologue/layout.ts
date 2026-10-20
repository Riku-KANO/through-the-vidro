import type { Box, Vec3 } from '../../layers/footing';

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

/** 作業台: a wooden bench, top at 0.9 m, along the wall left of the door. */
export const BENCH = { center: [-1.55, 0, -2.45] as Vec3, size: [2.1, 0.9, 0.8] as Vec3 };
/** 作業台に一つだけ残っていたビードロ (世界観 > 主人公): where the orb rests on the bench. */
export const BENCH_ORB: Vec3 = [-1.55, 0.99, -2.28];
/** The furnace (炉) on the right, a warm light in the blue (光と時間帯: 夜明け前の青). */
export const FURNACE = { center: [2.35, 0, -1.4] as Vec3, radius: 0.95 };

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

/** 台座 at the dead end, left of where the bridge will be (行き止まりには必ず理由を置く: 台座). */
export const PEDESTAL_ID = 'dead-end';
export const PEDESTAL_BASE: Vec3 = [-0.95, 0, -13.5];
/** Where a placed orb sits: the centre of the materialized sphere. */
export const PEDESTAL_ORB: Vec3 = [-0.95, 1.05, -13.5];
/** Collision radius of the pedestal's foot (the drawn foot is 0.26 m). */
export const PEDESTAL_RADIUS = 0.26;

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
