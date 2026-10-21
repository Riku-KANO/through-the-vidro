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
 *  - 真鍮の格子 is drawn nowhere underfoot here (brass is only the frames, the lips, the gate and the lamp posts), so no
 *    floor of this room is brass: what you hear is what you see (空間の可読性 4). A brass floor drawn later (S-24) adds
 *    a line here.
 * The first zone that holds a point decides; off every floor the answer is 石畳, the town's ground.
 */
export interface FloorZone {
  readonly name: string;
  readonly material: FloorMaterial;
  /** A disc around the origin (the workshop) or a box on x and z. */
  readonly radius?: number;
  readonly box?: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
}

export const FLOOR_ZONES: readonly FloorZone[] = [
  { name: 'workshop', material: 'frosted', radius: WORKSHOP_FLOOR_RADIUS + 0.05 },
  { name: 'path', material: 'stone', box: PATH },
  {
    name: 'bridge',
    material: 'frosted',
    box: { minX: BRIDGE.min[0], maxX: BRIDGE.max[0], minZ: BRIDGE.min[2], maxZ: BRIDGE.max[2] },
  },
  { name: 'far', material: 'stone', box: FAR },
];

/** The floor under a point of the ground: its zone ('none' off every floor) and material. */
export function floorAt(x: number, z: number): { zone: string; material: FloorMaterial } {
  for (const f of FLOOR_ZONES) {
    const inside =
      f.radius !== undefined
        ? Math.hypot(x, z) <= f.radius
        : !!f.box && x >= f.box.minX && x <= f.box.maxX && z >= f.box.minZ && z <= f.box.maxZ;
    if (inside) return { zone: f.name, material: f.material };
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
