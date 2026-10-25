import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  atan,
  float,
  floor,
  fract,
  hash,
  length,
  max,
  min,
  mix,
  mod,
  normalWorld,
  positionView,
  positionWorld,
  smoothstep,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { createBrassMaterial, createGlass, type HazeSpec } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import type { LayerField } from '../../layers/field';
import { AREA1_KEEP_OUT } from '../area1/layout';
import {
  AREA1_CHIMNEY,
  CANAL,
  COMPASS,
  DROP_TOWER_FOOT,
  DROP_TOWERS,
  EAST_ROAD,
  EAST_ROAD_END_X,
  eastRoadBox,
  GATE,
  GATE_OPEN_DEG,
  GREENHOUSE,
  LAMP_POST_RADIUS,
  LIGHTHOUSE,
  LIGHTHOUSE_BASE,
  LIGHTHOUSE_HEIGHT,
  PLAZA,
  PLAZA_GATE,
  PLAZA_GATES,
  PLAZA_RIM,
  PLAZA_Y,
  plazaGateAt,
  SLOPE,
  slopeHeight,
} from './layout';
import { stoneMaterial } from './room-art';

/**
 * 中央広場 (S-35; 進行構造とエリア設計 > 街の配置と序章の締め, 世界観とストーリー): the round stone plaza at the slope's foot, the
 * broken lighthouse in its middle (its great orb burst open, its shards fallen at its foot: 台詞は使わず景色で), the rim's
 * balustrade with its lamps, the three gates (east open onto a few metres of road, south and west shut with the canal and
 * the greenhouse glimpsed through their bars), the town of glass bubbles round about, and エリア1's hill with the chimneys of
 * the workshop street to the east — on the dawn's side (S-39: COMPASS, layout.ts). 夜明け前 (the plaza keeps the time of the
 * area last left: the prologue's). Light motes drift across the plaza toward the open gate (ルール7: 光の粒の流れ).
 * What lies east or west is placed along COMPASS (`E`, `W` below: ±1 on x), so turning the compass turns the town with it.
 *
 * Built from code (仮; Blender takes it over with the area's art) from layout.ts, the same numbers as the colliders
 * (physics.ts): the rim's arcs and the gates' posts and bars stop the body where they are drawn (空間の可読性と導線 4).
 * アートディレクション > 形のルール: straight and thin lines only as brass (the rails, bars, bands), all else round — the
 * houses are bubbles fused together, the lighthouse stacked bubbles, the gates arches.
 */

/* ---------- the plaza's shape, shared with its colliders ---------- */

/** The floor's disc reaches under the rim (its collider: a little wider than the rim, so no seam at the gates). */
export const PLAZA_FLOOR_RADIUS = PLAZA.radius + 0.3;

/** Unit (x, z) → its angle on the rim (radians from +X toward +Z, 0..2π: arcWallMesh's convention). */
function angleOf(dir: readonly [number, number]): number {
  const a = Math.atan2(dir[1], dir[0]);
  return a < 0 ? a + 2 * Math.PI : a;
}

/** Angles (as above) of the rim's openings: where the slope comes in (north) and the three gates. */
export function rimOpenings(): number[] {
  return [angleOf(COMPASS.north), ...PLAZA_GATES.map((g) => angleOf(g.dir))].sort((a, b) => a - b);
}

/** The rim's balustrade as arcs between its openings (radians from +X toward +Z, from < to). */
export function rimArcs(): { from: number; to: number }[] {
  const half = Math.asin(PLAZA_RIM.openingHalf / PLAZA.radius);
  const open = rimOpenings();
  return open.map((a, i) => {
    const next = i + 1 < open.length ? (open[i + 1] as number) : (open[0] as number) + 2 * Math.PI;
    return { from: a + half, to: next - half };
  });
}

/** Unit (x, z) along the rim at a gate, to the left seen from inside the plaza (the gate's local +X; its +Z points out). */
export function gateTangent(dir: readonly [number, number]): [number, number] {
  return [dir[1], -dir[0]];
}

/** The two posts of a plaza gate (x, z), on the rim either side of its middle. */
export function plazaGatePosts(dir: readonly [number, number]): [[number, number], [number, number]] {
  const [gx, gz] = plazaGateAt(dir);
  const [tx, tz] = gateTangent(dir);
  const hw = PLAZA_GATE.halfWidth;
  return [
    [gx - tx * hw, gz - tz * hw],
    [gx + tx * hw, gz + tz * hw],
  ];
}

/**
 * The low brass railing round the lighthouse's foot (仮): the great orb's shards lie fallen inside it. It keeps you off the
 * shards, and walking round it you walk round the lighthouse.
 */
export const LIGHTHOUSE_RAIL = { radius: LIGHTHOUSE_BASE.radius + 1.4, height: 0.7 } as const;

/** The road past the east gate as a box on x and z (its slab runs a little in under the rim). */
export const EAST_ROAD_BOX = eastRoadBox(0.6);
/** The east road's railings (仮): along both sides, `inset` inside the stone's edges. */
export const EAST_ROAD_RAIL = { inset: 0.08, height: EAST_ROAD.railing, thickness: 0.06 } as const;
/**
 * x where the side railings end (S-36: on into エリア1's entrance plaza a little, where its rim's balustrade takes over: no gap
 * for the body between the two) and where they start, just outside the central plaza's rim.
 */
export const EAST_ROAD_END_RAIL_X = EAST_ROAD_END_X + COMPASS.east[0] * 0.3;
export const EAST_ROAD_RIM_X = PLAZA.center[0] + COMPASS.east[0] * (PLAZA.radius + 0.25);
/** S-36: 街灯 along the road, alternating sides (+1: the north side), metres out from the central plaza's rim. */
export const EAST_ROAD_LAMPS: readonly { along: number; side: 1 | -1 }[] = [12, 24, 36, 48].map(
  (along, i) => ({
    along,
    side: i % 2 === 0 ? 1 : -1,
  }),
);

/* ---------- the far town (S-35; S-36: out of エリア1's way) ---------- */

/**
 * エリア1's hill (仮, S-35; S-36: its summit where the workshop street's chimney stands, AREA1_CHIMNEY): no ground of its own is
 * drawn — the street's houses, bubbles piled up it (泡が連なる住居群と坂道), make its shape over the mist. Half axes on x, up, z.
 */
const HILL = { rx: 50, ry: 14, rz: 42 } as const;
/** The hill's ground height at (x, z) (its top is the chimney's foot; under the mist off it). */
export function hillY(x: number, z: number): number {
  const [hx, hy, hz] = AREA1_CHIMNEY.foot;
  const u = (x - hx) / HILL.rx;
  const w = (z - hz) / HILL.rz;
  return hy - HILL.ry + HILL.ry * Math.sqrt(Math.max(0, 1 - u * u - w * w));
}

/** Does a circle (x, z, r) on the ground stand clear of エリア1's way (its keep-out boxes)? */
function clearOfArea1(x: number, z: number, r: number): boolean {
  return AREA1_KEEP_OUT.every((b) => {
    const nx = Math.min(Math.max(x, b.minX), b.maxX);
    const nz = Math.min(Math.max(z, b.minZ), b.maxZ);
    return Math.hypot(x - nx, z - nz) >= r;
  });
}

/** One bubble of the town: its centre, radius, and which part of the town (each its own instanced mesh). */
export interface TownBubble {
  x: number;
  y: number;
  z: number;
  r: number;
  zone: 'plaza' | 'slope' | 'hill' | 'far';
}

let bubbles: TownBubble[] | null = null;

/**
 * The town of glass bubbles fused in clusters (形のルール: 建物は泡の集合): round the plaza, below the slope, on エリア1's hill
 * and far off — each the same every call. On the hill none stands on エリア1's way (S-36: AREA1_KEEP_OUT): the road's end,
 * the entrance plaza, the street and the alley with their grey houses, the slope up to the summit.
 */
export function townBubbles(): readonly TownBubble[] {
  if (bubbles) return bubbles;
  const out: TownBubble[] = [];
  const rand = rng(20261023);
  const [cx, , cz] = PLAZA.center;
  const W = COMPASS.west[0];
  let zone: TownBubble['zone'] = 'plaza';
  /**
   * A cluster of bubbles round (x, z) on `base`; with `maxTop`, sunk so that none of it rises above that height. With
   * `clear`, the cluster is left out when any of it would stand on エリア1's way.
   */
  const cluster = (
    x: number,
    base: number,
    z: number,
    main: number,
    maxTop?: number,
    clear = false,
  ): void => {
    const parts: { x: number; y: number; z: number; r: number }[] = [];
    const c = { x, y: base + main * (0.4 + rand() * 0.3), z };
    parts.push({ ...c, r: main });
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const r = main * (0.35 + rand() * 0.45);
      const ox = rand() - 0.5;
      const oz = rand() - 0.5;
      const l = Math.hypot(ox, oz) || 1;
      const k = main * (0.55 + rand() * 0.4);
      parts.push({
        x: c.x + (ox / l) * k,
        y: base + r * (0.3 + rand() * 0.9) + (rand() < 0.3 ? main * 0.8 : 0),
        z: c.z + (oz / l) * k,
        r,
      });
    }
    if (clear && !parts.every((b) => clearOfArea1(b.x, b.z, b.r))) return;
    const top = Math.max(...parts.map((b) => b.y + b.r));
    const sink = maxTop !== undefined ? Math.max(0, top - maxTop) : 0;
    for (const b of parts) out.push({ x: b.x, y: b.y - sink, z: b.z, r: b.r, zone });
  };
  // round the plaza, leaving the slope and the gates their views. On the slope's side they stand lower than the plaza
  // (the plaza is a terrace): from the slope's brow they do not hide it (ルール6: 次に行く場所が先に見えている)
  const corridors = rimOpenings();
  const north = Math.atan2(COMPASS.north[1], COMPASS.north[0]);
  for (let k = 0; k < 34; k++) {
    const a = (k / 34) * Math.PI * 2 + rand() * 0.15;
    const off = corridors.some((o) => Math.abs(Math.atan2(Math.sin(a - o), Math.cos(a - o))) < 0.26);
    if (off) continue;
    const rad = PLAZA.radius + 7 + rand() * 26;
    const slopeSide = Math.abs(Math.atan2(Math.sin(a - north), Math.cos(a - north))) < 1.3;
    cluster(
      cx + Math.cos(a) * rad,
      PLAZA_Y - 1.5 - rand() * 1.5,
      cz + Math.sin(a) * rad,
      2.6 + rand() * 3.2,
      slopeSide ? PLAZA_Y - 0.4 : undefined,
    );
  }
  // below the slope on both sides as it comes down into the town: glass roofs under its railings, out of the mist
  zone = 'slope';
  for (let k = 0; k < 14; k++) {
    const z = -48 - k * 3.6 - rand() * 2;
    const side = k % 2 === 0 ? 1 : -1;
    const x = side * (5.5 + rand() * 14);
    cluster(x, slopeHeight(z) - 6, z, 2.2 + rand() * 2.4, slopeHeight(z) - 0.3);
  }
  // エリア1's hill: the workshop street's houses on its flanks and round its summit, each on bigger ones below it down into
  // the mist (the hill is the houses), out of エリア1's way (S-36)
  zone = 'hill';
  const [hx, , hz] = AREA1_CHIMNEY.foot;
  for (let k = 0; k < 44; k++) {
    const a = (k / 44) * Math.PI * 2 + rand() * 0.4;
    const reach = 0.18 + rand() * 0.8;
    const x = hx + Math.cos(a) * reach * HILL.rx;
    const z = hz + Math.sin(a) * reach * HILL.rz;
    const ground = hillY(x, z);
    const main = 2.4 + rand() * 2.4;
    if (!clearOfArea1(x, z, main * 2)) continue;
    cluster(x, ground - main * 0.6, z, main, undefined, true);
    // what it stands on: wider bubbles stepping down to the mist
    for (let y = ground - main * 1.4; y > PLAZA_Y - 3; y -= 4.5)
      cluster(x + (rand() - 0.5) * 3, y - 3, z + (rand() - 0.5) * 3, 3.2 + rand() * 1.8, undefined, true);
  }
  // far to the south and the west, round the canal and the greenhouse: silhouettes in the haze
  zone = 'far';
  for (let k = 0; k < 8; k++) {
    const south = k < 4;
    const x = south ? cx + (rand() - 0.5) * 60 : cx + W * (70 + rand() * 30);
    const z = south ? cz - 70 - rand() * 40 : cz + (rand() - 0.5) * 70;
    if (south && Math.abs(x - cx) < 6) continue;
    cluster(x, PLAZA_Y - 3, z, 3 + rand() * 3);
  }
  bubbles = out;
  return out;
}

/**
 * 工房街の煙突 (ルール5): the landmark on エリア1's summit (AREA1_CHIMNEY) first, then the street's lower chimneys round the hill,
 * out of エリア1's way (S-36). Where each stands (x, z), its height and radius.
 */
export function streetChimneys(): { x: number; z: number; h: number; r: number }[] {
  const [hx, hy, hz] = AREA1_CHIMNEY.foot;
  const E = COMPASS.east[0];
  return [
    { x: hx, z: hz, h: AREA1_CHIMNEY.top - (hy - PLAZA_Y) + 3, r: 1.3 },
    { x: hx + E * 13, z: hz + 9, h: 13, r: 0.75 },
    { x: hx + E * 18, z: hz - 9, h: 12, r: 0.7 },
    { x: hx - E * 7, z: hz - 13, h: 14, r: 0.8 },
    { x: hx + E * 6, z: hz - 22, h: 11, r: 0.7 },
    { x: hx + E * 26, z: hz + 4, h: 12, r: 0.7 },
  ];
}

/**
 * 光の粒の流れ (ルール7): the curve the plaza's motes drift along, as (x, z) control points of a quadratic — from the slope's
 * foot, round the lighthouse's north side, to the open east gate and on along its road (S-36: 12 m out, toward エリア1; they
 * fade at both ends), so they lead on through the gate. Laid along COMPASS (S-39).
 */
export const MOTE_PATH: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
] = (() => {
  const [cx, , cz] = PLAZA.center;
  const E = COMPASS.east[0];
  const W = COMPASS.west[0];
  const [ex, ez] = plazaGateAt(COMPASS.east);
  return [
    [cx + W * 2, cz + PLAZA.radius - 2],
    [cx + E * 12, cz + 12],
    [ex + E * 12, ez],
  ] as const;
})();

/**
 * 光の粒の流れ on the east road (S-36, ルール7): a thinner stream down the road's length, from just out of the gate to a few
 * metres into エリア1's entrance plaza, where エリア1's own motes take the way on (area1/layout.ts MOTES_TO_ROOM). The
 * plaza's stream (MOTE_PATH) fades 12 m out; this one carries it the 60 m. Two (x, z) points, along COMPASS.east.
 */
export const ROAD_MOTE_PATH: readonly [readonly [number, number], readonly [number, number]] = (() => {
  const E = COMPASS.east[0];
  const [ex, ez] = plazaGateAt(COMPASS.east);
  return [
    [ex + E * 4, ez],
    [EAST_ROAD_END_X + E * 4, ez],
  ] as const;
})();
/** How far across the road (either side of its middle) the road's motes drift: within its railings. */
export const ROAD_MOTE_SPREAD = EAST_ROAD.halfWidth - 0.5;

/** A point (x, z) of the motes' curve, `u` 0..1 along it. */
export function motePathAt(u: number): [number, number] {
  const [a, b, c] = MOTE_PATH;
  const v = 1 - u;
  return [v * v * a[0] + 2 * v * u * b[0] + u * u * c[0], v * v * a[1] + 2 * v * u * b[1] + u * u * c[1]];
}

/* ---------- the fog as you go down into the town ---------- */

/** room-art.ts's fog distances, set for the workshop and the way (奥ほど霞ませる). */
export const FOG_WAY = { near: 18, far: 150 } as const;
/**
 * 仮 (S-35): out in the town the haze reaches further, so that the plaza reads from the slope's brow and the lighthouse from
 * anywhere in a town of about 300 m (ルール5: 灯塔は街のどこからでも見える; ルール8 still: the far gates' glimpses stay hazy).
 */
export const FOG_TOWN = { near: 30, far: 300 } as const;

/**
 * The fog's distances for someone standing at z: the way's in the workshop and up to the gate, the town's past its brow.
 * Written into `out` (the room asks every frame).
 */
export function fogRangeAt(
  z: number,
  out: { near: number; far: number } = { near: 0, far: 0 },
): { near: number; far: number } {
  // it clears as you go through the gate, to the town's by the slope's brow
  const from = GATE.z + 2;
  const to = SLOPE.fromZ;
  const t = Math.min(1, Math.max(0, (from - z) / (from - to)));
  const s = t * t * (3 - 2 * t);
  out.near = FOG_WAY.near + (FOG_TOWN.near - FOG_WAY.near) * s;
  out.far = FOG_WAY.far + (FOG_TOWN.far - FOG_WAY.far) * s;
  return out;
}

/* ---------- the drawing ---------- */

/** 夜明け前の青: the cool horizon the far glass fades into (room-art.ts HORIZON_COOL and TOWN_HAZE). */
const TOWN_HAZE: HazeSpec = { color: new THREE.Color(0.21, 0.28, 0.41), near: 35, far: 240 };

/**
 * 仮: the lamps (乳白ガラス, a light source: blooms) and the gates' keystones — lit over the open gate (the way on, like the
 * workshop gate's once it opened, S-34), a faint ember over the shut ones.
 */
const LAMP_GLOW = { color: 0xffbf80, intensity: 1.5 } as const;
const KEYSTONE_OPEN = { color: 0xffc58a, intensity: 2.4 } as const;
const KEYSTONE_SHUT = { color: 0xffc58a, intensity: 0.3 } as const;
/** Motes of light drifting from the slope's foot across the plaza to the open east gate (ルール7). */
const MOTES = 48;
/** And on down the east road to エリア1 (S-36). */
const ROAD_MOTES = 24;

export interface PlazaArt {
  /** Ambient motion: the motes' drift (scene clock, seconds). */
  animate(t: number): void;
  dispose(): void;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 石畳 laid in rings round the lighthouse (the plaza's own pattern), the rock of its sides going down into the mist. */
function plazaStoneMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0 });
  const d = positionWorld.xz.sub(vec2(PLAZA.center[0], PLAZA.center[2]));
  const r = length(d);
  const tile = 0.62;
  const ring = floor(r.div(tile));
  // along each ring the stones keep about their size, a whole number of them round it (so no seam where the angle wraps);
  // every other ring is shifted by half a stone
  const count = max(
    float(1),
    floor(
      ring
        .add(0.5)
        .mul(Math.PI * 2)
        .add(0.5),
    ),
  );
  const along = atan(d.y, d.x)
    .div(Math.PI * 2)
    .add(0.5)
    .mul(count)
    .add(ring.mul(0.5));
  const cell = vec2(fract(along), fract(r.div(tile)));
  const edge = min(min(cell.x, float(1).sub(cell.x)), min(cell.y, float(1).sub(cell.y)));
  const grout = smoothstep(0.0, 0.05, edge);
  const n = hash(vec2(mod(floor(along), count), ring).dot(vec2(1, 57)));
  const stone = vec3(0.47, 0.5, 0.55).mul(n.mul(0.16).add(0.84));
  const top = mix(vec3(0.21, 0.23, 0.27), stone, grout);
  const side = vec3(0.11, 0.13, 0.18).mul(
    hash(floor(positionWorld.y.mul(2.2)))
      .mul(0.18)
      .add(0.82),
  );
  m.colorNode = vec4(mix(side, top, smoothstep(0.45, 0.75, normalWorld.y)), 1);
  return m;
}

/** A rotation about +Y and a place: a plaza gate's local frame (+X along the rim to the left seen from inside it, +Z out of it). */
function gateMatrix(dir: readonly [number, number]): THREE.Matrix4 {
  const [gx, gz] = plazaGateAt(dir);
  const [tx, tz] = gateTangent(dir);
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(tx, 0, tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(dir[0], 0, dir[1]))
    .setPosition(gx, PLAZA_Y, gz);
}

/** Builds the plaza and the town round it into `scene`, every piece on the shared layer. */
export function buildPlaza(quality: QualityPreset, field: LayerField, scene: THREE.Object3D): PlazaArt {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const instanced: THREE.InstancedMesh[] = [];
  const merged = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!g) throw new Error('mergeGeometries failed');
    return keep(g);
  };
  const put = (o: THREE.Object3D): THREE.Object3D => {
    field.assign(o, 'shared');
    scene.add(o);
    return o;
  };
  const glass = (
    kind: Parameters<typeof createGlass>[0],
    opts: Parameters<typeof createGlass>[2] = {},
  ): THREE.Material =>
    // far, or behind other glass on the main sightlines: the cheap path on every preset (ガラスの描画 > 対策1)
    keep(createGlass(kind, quality, { placement: 'behind-glass', haze: TOWN_HAZE, ...opts }).material);
  const brass = keep(createBrassMaterial());
  const stone = keep(stoneMaterial(0.62));
  const rock = keep(stoneMaterial(1.4));
  const plazaStone = keep(plazaStoneMaterial());
  const clear = glass('clear', { thickness: 0.06 });
  const frosted = glass('frosted', { thickness: 0.08 });
  const lampMilk = keep(createGlass('milky', quality, { glow: LAMP_GLOW }).material);
  const chimneyMilk = keep(
    createGlass('milky', quality, { glow: { color: 0xffb46a, intensity: 1.2 } }).material,
  );
  const keystoneLit = keep(createGlass('milky', quality, { glow: KEYSTONE_OPEN }).material);
  const keystoneDim = keep(createGlass('milky', quality, { glow: KEYSTONE_SHUT }).material);
  const water = keep(
    new THREE.MeshStandardNodeMaterial({ color: 0x0c1826, roughness: 0.06, metalness: 0.2 }),
  );
  const brassParts: THREE.BufferGeometry[] = [];
  // the far brass apart from the plaza's, so each is left out of the views it is not in: the chimneys' bands, the dome's ribs
  const hillBrass: THREE.BufferGeometry[] = [];
  const westBrass: THREE.BufferGeometry[] = [];
  const globes: THREE.BufferGeometry[] = [];
  const keystones: THREE.BufferGeometry[] = [];
  const embers: THREE.BufferGeometry[] = [];
  const [cx, , cz] = PLAZA.center;
  // east along x (S-39: the compass turned round; layout.ts COMPASS)
  const E = COMPASS.east[0];

  // ---- the floor: a round terrace of stone, its sides going down into the mist; the roads past the gates -----------
  {
    const floorMesh = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(PLAZA_FLOOR_RADIUS, PLAZA_FLOOR_RADIUS + 0.6, 6, 128, 1)),
      plazaStone,
    );
    floorMesh.position.set(cx, PLAZA_Y - 3, cz);
    put(floorMesh);
    const roads: THREE.BufferGeometry[] = [];
    // east: the few metres to the railing; south and west: a stub on past the shut gate, the way on beyond the bars
    roads.push(
      new THREE.BoxGeometry(
        EAST_ROAD_BOX.maxX - EAST_ROAD_BOX.minX,
        6,
        EAST_ROAD_BOX.maxZ - EAST_ROAD_BOX.minZ,
      ).translate((EAST_ROAD_BOX.minX + EAST_ROAD_BOX.maxX) / 2, PLAZA_Y - 3.003, cz),
    );
    for (const g of PLAZA_GATES.filter((q) => !q.open)) {
      const stub = new THREE.BoxGeometry(2 * EAST_ROAD.halfWidth, 6, 5.6);
      stub.applyMatrix4(gateMatrix(g.dir).multiply(new THREE.Matrix4().makeTranslation(0, -3.003, 2.5)));
      roads.push(stub);
    }
    put(new THREE.Mesh(merged(roads), stone));
  }

  // ---- the rim: a brass balustrade on a stone curb, between the openings; lamps on it --------------------------------
  {
    const curbs: THREE.BufferGeometry[] = [];
    const arcTorus = (radius: number, tube: number, y: number, from: number, to: number, radial = 6) =>
      new THREE.TorusGeometry(
        radius,
        tube,
        radial,
        Math.max(8, Math.round((to - from) * radius * 1.5)),
        to - from,
      )
        .rotateX(Math.PI / 2)
        .rotateY(-from)
        .translate(cx, PLAZA_Y + y, cz);
    const R = PLAZA.radius;
    for (const { from, to } of rimArcs()) {
      curbs.push(arcTorus(R, 0.16, 0.0, from, to, 8));
      brassParts.push(arcTorus(R, 0.028, PLAZA_RIM.height, from, to, 8));
      brassParts.push(arcTorus(R, 0.018, 0.55, from, to));
      const posts = Math.max(1, Math.round(((to - from) * R) / 2.2));
      for (let i = 0; i <= posts; i++) {
        const a = from + ((to - from) * i) / posts;
        const [x, z] = [cx + Math.cos(a) * R, cz + Math.sin(a) * R];
        brassParts.push(
          new THREE.CylinderGeometry(0.022, 0.03, PLAZA_RIM.height, 8).translate(
            x,
            PLAZA_Y + PLAZA_RIM.height / 2,
            z,
          ),
        );
        if (i < posts && i % 2 === 0) {
          const m = a + (to - from) / posts / 2;
          brassParts.push(
            new THREE.TorusGeometry(0.16, 0.011, 6, 28)
              .rotateY(Math.PI / 2 - m)
              .translate(cx + Math.cos(m) * R, PLAZA_Y + (PLAZA_RIM.height + 0.55) / 2, cz + Math.sin(m) * R),
          );
        }
      }
    }
    put(new THREE.Mesh(merged(curbs), rock));
    // 街灯 on the rim, on either side of every opening and between (the plaza is lit round its edge, not in its middle)
    for (const deg of [30, 60, 120, 150, 210, 240, 300, 330]) {
      const a = (deg * Math.PI) / 180;
      const [x, z] = [cx + Math.cos(a) * (R + 0.05), cz + Math.sin(a) * (R + 0.05)];
      brassParts.push(
        new THREE.CylinderGeometry(LAMP_POST_RADIUS * 1.2, LAMP_POST_RADIUS * 1.8, 2.7, 8).translate(
          x,
          PLAZA_Y + 1.35,
          z,
        ),
      );
      brassParts.push(
        new THREE.TorusGeometry(0.14, 0.014, 6, 24).rotateX(Math.PI / 2).translate(x, PLAZA_Y + 2.64, z),
      );
      globes.push(new THREE.SphereGeometry(0.16, 24, 12).translate(x, PLAZA_Y + 2.84, z));
    }
  }

  // ---- the three gates: brass arches in the rim; the east one open, its leaves swung out along its road --------------
  {
    const hw = PLAZA_GATE.halfWidth;
    const springs = PLAZA_GATE.height - hw * 0.6;
    const archAt = (x: number): number => springs + 0.6 * Math.sqrt(Math.max(0, hw * hw - x * x));
    for (const g of PLAZA_GATES) {
      const local: THREE.BufferGeometry[] = [];
      for (const x of [-hw, hw]) {
        local.push(new THREE.CylinderGeometry(0.07, 0.085, springs, 12).translate(x, springs / 2, 0));
        for (const y of [0.4, 1.9])
          local.push(new THREE.CylinderGeometry(0.04, 0.04, 0.15, 10).translate(x, y, 0));
      }
      const arch = new THREE.TorusGeometry(hw, 0.06, 10, 64, Math.PI);
      arch.scale(1, 0.6, 1);
      arch.translate(0, springs, 0);
      local.push(arch);
      // the keystone's brass cup and its lamp (lit over the open gate: the way on; a faint ember over the shut ones)
      local.push(
        new THREE.LatheGeometry(
          [
            [0.0, 0],
            [0.04, 0],
            [0.06, 0.035],
            [0.09, 0.08],
            [0.085, 0.085],
          ].map(([x = 0, y = 0]) => new THREE.Vector2(x, y)),
          24,
        ).translate(0, PLAZA_GATE.height + 0.04, 0),
      );
      const leaf = (side: 1 | -1, angle: number): void => {
        // in the hinge's frame: the leaf runs from the post toward the middle (−side·x), swung `angle` out of the plaza
        const parts: THREE.BufferGeometry[] = [];
        const top = (u: number): number => archAt(hw - u) - 0.07;
        const bar = (u: number, r: number): void => {
          const h = top(u) - 0.06;
          parts.push(new THREE.CylinderGeometry(r, r, h, 8).translate(-side * u, 0.06 + h / 2, 0));
        };
        bar(0.04, 0.024);
        bar(hw - 0.02, 0.022);
        for (let i = 1; i < 6; i++) bar((hw * i) / 6, 0.021);
        for (const [y, r] of [
          [0.12, 0.02],
          [1.15, 0.022],
        ] as const)
          parts.push(
            new THREE.CylinderGeometry(r, r, hw - 0.06, 8)
              .rotateZ(Math.PI / 2)
              .translate(-side * (hw / 2), y, 0),
          );
        parts.push(
          new THREE.TubeGeometry(
            new THREE.CatmullRomCurve3(
              Array.from({ length: 25 }, (_, i) => {
                const u = 0.04 + ((hw - 0.06) * i) / 24;
                return new THREE.Vector3(-side * u, top(u), 0);
              }),
            ),
            48,
            0.018,
            6,
            false,
          ),
        );
        parts.push(new THREE.TorusGeometry(0.15, 0.013, 8, 40).translate(-side * hw * 0.5, 1.75, 0));
        const m = new THREE.Matrix4()
          .makeTranslation(side * hw, 0, 0)
          .multiply(new THREE.Matrix4().makeRotationY(side * angle));
        for (const p of parts) local.push(p.applyMatrix4(m));
      };
      // shut, the two leaves meet in the middle; open (east), they have swung out of the plaza along its road's sides
      const open = g.open ? (GATE_OPEN_DEG * Math.PI) / 180 : 0;
      leaf(1, open);
      leaf(-1, open);
      const m = gateMatrix(g.dir);
      for (const p of local) brassParts.push(p.applyMatrix4(m));
      const lamp = new THREE.SphereGeometry(0.085, 24, 12)
        .translate(0, PLAZA_GATE.height + 0.17, 0)
        .applyMatrix4(m);
      (g.open ? keystones : embers).push(lamp);
    }
  }

  // ---- the road past the east gate (S-36: on to エリア1's entrance plaza): railings along its sides, lamps along it -----
  {
    const { inset, height } = EAST_ROAD_RAIL;
    // x0: where the railings end, a little into the entrance plaza (its balustrade takes over); x1: by the central plaza's rim
    const x0 = EAST_ROAD_END_RAIL_X;
    const x1 = EAST_ROAD_RIM_X;
    const length = Math.abs(x1 - x0);
    const bays = Math.round(length / 2.4);
    for (const zSide of [EAST_ROAD_BOX.minZ + inset, EAST_ROAD_BOX.maxZ - inset]) {
      const side = zSide > cz ? 1 : -1;
      for (const [y, r] of [
        [height, 0.026],
        [0.55, 0.013],
        [0.12, 0.013],
      ] as const)
        brassParts.push(
          new THREE.CylinderGeometry(r, r, length, 8)
            .rotateZ(Math.PI / 2)
            .translate((x0 + x1) / 2, PLAZA_Y + y, zSide),
        );
      // posts every 2.4 m or so, a ring in every other bay between the rails (the slope's railing's motif)
      for (let i = 0; i <= bays; i++) {
        const x = x1 + ((x0 - x1) * i) / bays;
        const lampHere = EAST_ROAD_LAMPS.some((l) => l.side === side && Math.abs(x1 + E * l.along - x) < 1.2);
        if (!lampHere)
          brassParts.push(
            new THREE.CylinderGeometry(0.02, 0.026, height, 8).translate(x, PLAZA_Y + height / 2, zSide),
          );
        if (i < bays && i % 2 === 0) {
          const mid = x + (x0 - x1) / bays / 2;
          brassParts.push(
            new THREE.TorusGeometry(0.15, 0.01, 6, 28).translate(mid, PLAZA_Y + (height + 0.55) / 2, zSide),
          );
        }
      }
    }
    // 街灯: a lamp's post in the railing's line, its milky globe over the stone
    for (const l of EAST_ROAD_LAMPS) {
      const x = x1 + E * l.along;
      const z = l.side > 0 ? EAST_ROAD_BOX.maxZ - inset : EAST_ROAD_BOX.minZ + inset;
      brassParts.push(
        new THREE.CylinderGeometry(LAMP_POST_RADIUS, LAMP_POST_RADIUS * 1.5, 2.25, 8).translate(
          x,
          PLAZA_Y + 1.125,
          z,
        ),
      );
      brassParts.push(
        new THREE.TorusGeometry(0.11, 0.012, 6, 24).rotateX(Math.PI / 2).translate(x, PLAZA_Y + 2.19, z),
      );
      globes.push(new THREE.SphereGeometry(0.12, 24, 12).translate(x, PLAZA_Y + 2.29, z));
    }
  }

  // ---- the lighthouse: stacked bubbles with brass bands, a brass spire, the great orb broken open in its cage ---------
  {
    const [lx, ly, lz] = LIGHTHOUSE;
    // [radius, height of its centre over the plaza]: the bottom one is LIGHTHOUSE_BASE (the walk-round ball)
    const bubbles: [number, number][] = [
      [LIGHTHOUSE_BASE.radius, LIGHTHOUSE_BASE.lift],
      [4.0, 8.6],
      [3.1, 14.2],
      [2.4, 18.6],
      [1.8, 21.9],
    ];
    const tower = new THREE.InstancedMesh(keep(new THREE.SphereGeometry(1, 48, 32)), frosted, bubbles.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    bubbles.forEach(([r, y], i) => {
      tower.setMatrixAt(i, m4.compose(new THREE.Vector3(lx, ly + y, lz), q, new THREE.Vector3(r, r, r)));
      brassParts.push(
        new THREE.TorusGeometry(r * 0.985, 0.08, 8, 72)
          .rotateX(Math.PI / 2)
          .translate(lx, ly + y - r * 0.17, lz),
      );
    });
    tower.computeBoundingSphere();
    tower.renderOrder = 1;
    instanced.push(tower);
    put(tower);
    const orbY = ly + LIGHTHOUSE_HEIGHT - 4.2;
    // the spire up to the cage
    brassParts.push(
      new THREE.CylinderGeometry(0.2, 0.55, orbY - 4 - (ly + 22.5), 12).translate(
        lx,
        (ly + 22.5 + orbY - 4) / 2,
        lz,
      ),
    );
    brassParts.push(
      new THREE.TorusGeometry(0.7, 0.07, 8, 32).rotateX(Math.PI / 2).translate(lx, orbY - 4.05, lz),
    );
    // the cage round the great orb: three rings, and the cup it sat in
    for (let i = 0; i < 3; i++)
      brassParts.push(
        new THREE.TorusGeometry(4.45, 0.08, 8, 112)
          .rotateX(Math.PI / 2)
          .rotateZ((i * Math.PI) / 3 + 0.3)
          .translate(lx, orbY, lz),
      );
    // the ring it sat on, and the struts from the spire's head up to it
    brassParts.push(
      new THREE.TorusGeometry(2.2, 0.08, 8, 64).rotateX(Math.PI / 2).translate(lx, orbY - 3.35, lz),
    );
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + 0.4;
      const from = new THREE.Vector3(lx, orbY - 4.05, lz);
      const to = new THREE.Vector3(lx + Math.cos(a) * 2.2, orbY - 3.35, lz + Math.sin(a) * 2.2);
      brassParts.push(new THREE.TubeGeometry(new THREE.LineCurve3(from, to), 1, 0.05, 6, false));
    }
    // 大玉が割れて光が散った: the great orb with a gaping hole, turned toward the slope and a little down — seen from the
    // brow as you come, and from the plaza looking up. In its own frame the hole is round -X (SphereGeometry's phi 0)
    const hole = 0.95;
    const orbTurn = new THREE.Euler(0.35, Math.PI / 2, 0);
    const great = new THREE.Mesh(
      keep(new THREE.SphereGeometry(4.0, 56, 36, hole, Math.PI * 2 - 2 * hole, 0.05, Math.PI * 0.86)),
      frosted,
    );
    great.position.set(lx, orbY, lz);
    great.rotation.copy(orbTurn);
    great.renderOrder = 1;
    put(great);
    const rand = rng(35);
    const shards: THREE.BufferGeometry[] = [];
    // its broken rim: jagged pieces of the shell still standing into the hole
    {
      const onOrb = new THREE.Matrix4().makeRotationFromEuler(orbTurn).setPosition(lx, orbY, lz);
      for (let k = 0; k < 9; k++) {
        const left = k % 2 === 0;
        const width = 0.12 + rand() * 0.16;
        const phi = left
          ? hole - width * (0.3 + rand() * 0.5)
          : Math.PI * 2 - hole - width * (0.2 + rand() * 0.5);
        const theta = 0.25 + (k / 8) * 2.2 + rand() * 0.15;
        shards.push(
          new THREE.SphereGeometry(4.0, 3, 3, phi, width, theta, 0.16 + rand() * 0.22).applyMatrix4(onOrb),
        );
      }
    }
    // a few shards still caught in the cage, most fallen at the foot inside the railing (表の層: what is left)
    const shard = (r: number): THREE.BufferGeometry =>
      new THREE.SphereGeometry(
        r,
        6,
        4,
        rand() * 6,
        0.35 + rand() * 0.4,
        0.9 + rand() * 0.6,
        0.3 + rand() * 0.35,
      );
    for (let i = 0; i < 5; i++) {
      const a = 1.2 + i * 0.5 + rand() * 0.2;
      const g = shard(4.0);
      g.rotateZ((rand() - 0.5) * 0.8);
      g.translate(lx + Math.cos(a) * 0.6, orbY + 0.4 + rand() * 1.2, lz + Math.sin(a) * 0.6);
      shards.push(g);
    }
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.4;
      const r = LIGHTHOUSE_BASE.radius + 0.25 + rand() * 0.85;
      const g = shard(2.2 + rand() * 1.2);
      g.center();
      g.rotateX((rand() - 0.5) * 1.6);
      g.rotateZ((rand() - 0.5) * 1.6);
      g.translate(lx + Math.cos(a) * r, ly + 0.15 + rand() * 0.25, lz + Math.sin(a) * r);
      shards.push(g);
    }
    const shardMesh = new THREE.Mesh(merged(shards), frosted);
    shardMesh.renderOrder = 2;
    put(shardMesh);
    // the railing round the foot
    const rr = LIGHTHOUSE_RAIL.radius;
    brassParts.push(
      new THREE.TorusGeometry(rr, 0.026, 8, 128)
        .rotateX(Math.PI / 2)
        .translate(lx, ly + LIGHTHOUSE_RAIL.height, lz),
    );
    brassParts.push(
      new THREE.TorusGeometry(rr, 0.013, 6, 128).rotateX(Math.PI / 2).translate(lx, ly + 0.3, lz),
    );
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      brassParts.push(
        new THREE.CylinderGeometry(0.02, 0.026, LIGHTHOUSE_RAIL.height, 8).translate(
          lx + Math.cos(a) * rr,
          ly + LIGHTHOUSE_RAIL.height / 2,
          lz + Math.sin(a) * rr,
        ),
      );
    }
  }

  // ---- the town round the plaza, below the slope, on エリア1's hill and far off: bubbles of glass fused in clusters --------
  {
    // each part of the town is its own instanced mesh, so what is out of the view is left out (the bubbles round the plaza,
    // below the slope, on エリア1's hill, and far off); the hill's and the far ones, seen only from afar, have fewer facets
    // (空間の可読性と導線 8: 遠景のガラスは単純な表現に)
    const spheres = townBubbles().map((b) => ({ p: new THREE.Vector3(b.x, b.y, b.z), r: b.r, zone: b.zone }));
    // far → near from the slope's middle, so the bubbles blend in order from where the town is first seen
    const from = new THREE.Vector3(0, -4, -60);
    spheres.sort((a, b) => b.p.distanceToSquared(from) - a.p.distanceToSquared(from));
    const near = keep(new THREE.SphereGeometry(1, 24, 16));
    const coarse = keep(new THREE.SphereGeometry(1, 16, 10));
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const z of ['plaza', 'slope', 'hill', 'far'] as const) {
      const mine = spheres.filter((b) => b.zone === z);
      if (mine.length === 0) continue;
      const town = new THREE.InstancedMesh(z === 'hill' || z === 'far' ? coarse : near, clear, mine.length);
      town.name = `town-${z}`;
      mine.forEach((b, i) => {
        town.setMatrixAt(i, m4.compose(b.p, q, scale.setScalar(b.r)));
      });
      town.computeBoundingSphere();
      town.renderOrder = 1;
      instanced.push(town);
      put(town);
    }
  }

  // ---- 工房街の煙突 on エリア1's hill (the area's landmark, ルール5): frosted stacks ringed with brass, the tallest at the top -
  {
    const stacks: THREE.BufferGeometry[] = [];
    const tops: THREE.BufferGeometry[] = [];
    // the landmark on the summit first, then the street's lower chimneys round the hill (streetChimneys)
    const chimneys = streetChimneys();
    chimneys.forEach(({ x, z, h, r }, i) => {
      // the stack goes down among the houses it stands on
      const y0 = hillY(x, z) - 3;
      stacks.push(
        new THREE.LatheGeometry(
          [
            [0, 0],
            [r * 1.4, 0],
            [r * 1.12, h * 0.12],
            [r, h * 0.3],
            [r * 0.9, h * 0.92],
            [r * 1.18, h],
            [r * 0.8, h * 1.02],
          ].map(([a = 0, b = 0]) => new THREE.Vector2(a, b)),
          24,
        ).translate(x, y0, z),
      );
      for (const f of [0.3, 0.62, 0.95])
        hillBrass.push(
          new THREE.TorusGeometry(r * 1.02, Math.max(0.07, r * 0.09), 6, 32)
            .rotateX(Math.PI / 2)
            .translate(x, y0 + h * f, z),
        );
      // the workshop street is waking: a warm glow in the landmark's mouth (まだそこで暮らしている気配)
      if (i === 0)
        tops.push(new THREE.SphereGeometry(r * 0.85, 24, 12).scale(1, 0.45, 1).translate(x, y0 + h * 1.0, z));
    });
    put(new THREE.Mesh(merged(stacks), frosted));
    put(new THREE.Mesh(merged(tops), chimneyMilk));
  }

  // ---- beyond the shut gates: the canal and its drop towers (south), the greenhouse's dome (west): 気配だけ --------------
  {
    // 水路: dark water sunk between low stone banks, running south from just past the gate into the mist
    const [sx, sz] = plazaGateAt(COMPASS.south);
    const len = CANAL.to - CANAL.from;
    const midZ = sz - (CANAL.from + CANAL.to) / 2;
    const canal = new THREE.Mesh(keep(new THREE.PlaneGeometry(2 * CANAL.halfWidth, len)), water);
    canal.rotation.x = -Math.PI / 2;
    canal.position.set(sx, PLAZA_Y - CANAL.drop, midZ);
    put(canal);
    const banks: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1])
      banks.push(
        new THREE.BoxGeometry(0.7, 3, len).translate(
          sx + side * (CANAL.halfWidth + 0.35),
          PLAZA_Y - CANAL.drop + 0.3 - 1.5,
          midZ,
        ),
      );
    put(new THREE.Mesh(merged(banks), stone));
    // 雫塔 (水路の目印): tall drops of glass along it
    const drops: THREE.BufferGeometry[] = [];
    for (const [dx, along, h] of DROP_TOWERS) {
      const pts = Array.from({ length: 22 }, (_, i) => {
        const t = i / 21;
        // a drop: round at the foot, drawn out to a point at the top
        const r = Math.sin(Math.PI * Math.min(1, t * 1.6)) * (1 - t) * h * 0.22;
        return new THREE.Vector2(Math.max(0, r), t * h);
      });
      drops.push(new THREE.LatheGeometry(pts, 24).translate(sx + dx, PLAZA_Y - DROP_TOWER_FOOT, sz - along));
    }
    put(new THREE.Mesh(merged(drops), clear));
    // 温室のドーム (温室の目印), far to the west, its brass ribs
    const R = GREENHOUSE.radius;
    const domeAt = new THREE.Vector3(...GREENHOUSE.center);
    const dome = new THREE.Mesh(
      keep(new THREE.SphereGeometry(R, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2)),
      clear,
    );
    dome.position.copy(domeAt);
    dome.renderOrder = 1;
    put(dome);
    for (let i = 0; i < 6; i++)
      westBrass.push(
        new THREE.TorusGeometry(R + 0.05, 0.12, 6, 96, Math.PI)
          .rotateY((i * Math.PI) / 6)
          .translate(domeAt.x, domeAt.y, domeAt.z),
      );
    for (const f of [0.35, 0.7]) {
      const y = R * f;
      westBrass.push(
        new THREE.TorusGeometry(Math.sqrt(R * R - y * y), 0.1, 6, 96)
          .rotateX(Math.PI / 2)
          .translate(domeAt.x, domeAt.y + y, domeAt.z),
      );
    }
  }

  put(new THREE.Mesh(merged(brassParts), brass));
  put(new THREE.Mesh(merged(hillBrass), brass));
  put(new THREE.Mesh(merged(westBrass), brass));
  put(new THREE.Mesh(merged(globes), lampMilk));
  put(new THREE.Mesh(merged(keystones), keystoneLit));
  put(new THREE.Mesh(merged(embers), keystoneDim));

  // ---- motes of light drifting across the plaza to the open east gate (光の粒の流れ, ルール7) --------------------------
  const moteMat = keep(
    new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  moteMat.colorNode = vec4(1.1, 0.78, 0.42, 1);
  moteMat.opacityNode = smoothstep(0.8, 3.0, positionView.length());
  moteMat.fog = false;
  // S-36: the plaza's motes and, after them in the same mesh, the east road's (ROAD_MOTE_PATH). One mesh, not one more
  // InstancedMesh for the road: three r186 compiles each InstancedMesh's shader anew (its matrices' buffer is named
  // after its node), and the loading frame on WebGL2 grew by half a second with a second one (S-36)
  const [r0, r1] = ROAD_MOTE_PATH;
  const motes = new THREE.InstancedMesh(
    keep(new THREE.IcosahedronGeometry(0.022, 0)),
    moteMat,
    MOTES + ROAD_MOTES,
  );
  // they drift over the plaza and down the road: left out of the view's work wherever neither is in it
  motes.boundingSphere = new THREE.Box3()
    .union(
      new THREE.Sphere(new THREE.Vector3(cx + E * 6, PLAZA_Y + 2, cz + 6), PLAZA.radius + 9).getBoundingBox(
        new THREE.Box3(),
      ),
    )
    .union(
      new THREE.Box3(
        new THREE.Vector3(Math.min(r0[0], r1[0]) - 3, PLAZA_Y - 1, Math.min(r0[1], r1[1]) - 3),
        new THREE.Vector3(Math.max(r0[0], r1[0]) + 3, PLAZA_Y + 4, Math.max(r0[1], r1[1]) + 3),
      ),
    )
    .getBoundingSphere(new THREE.Sphere());
  instanced.push(motes);
  put(motes);
  // each mote runs a gentle curve from the slope's foot round the lighthouse's north side to the gate and a little beyond
  const [a0, a1, a2] = MOTE_PATH.map(([x, z]) => new THREE.Vector3(x, 0, z)) as [
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3,
  ];
  const seeds = Array.from({ length: MOTES }, (_, i) => {
    const r = rng(900 + i);
    return {
      side: (r() - 0.5) * 7,
      y: 0.4 + r() * 2.4,
      phase: r(),
      speed: 0.006 + r() * 0.006,
      wobble: r() * 6,
    };
  });
  // S-36: and on down the east road
  const roadLength = Math.hypot(r1[0] - r0[0], r1[1] - r0[1]);
  // along the road, and across it (a quarter turn)
  const roadX = (r1[0] - r0[0]) / roadLength;
  const roadZ = (r1[1] - r0[1]) / roadLength;
  const roadSeeds = Array.from({ length: ROAD_MOTES }, (_, i) => {
    const r = rng(1900 + i);
    return {
      side: (r() - 0.5) * 2 * ROAD_MOTE_SPREAD,
      y: 0.5 + r() * 1.8,
      phase: r(),
      speed: 0.006 + r() * 0.005,
      wobble: r() * 6,
    };
  });
  const moteMatrix = new THREE.Matrix4();
  const motePos = new THREE.Vector3();
  const moteRot = new THREE.Quaternion();
  const moteScale = new THREE.Vector3();
  const along = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const quad = (u: number, out: THREE.Vector3): THREE.Vector3 => {
    const v = 1 - u;
    return out
      .copy(a0)
      .multiplyScalar(v * v)
      .addScaledVector(a1, 2 * v * u)
      .addScaledVector(a2, u * u);
  };

  return {
    animate(t) {
      for (let i = 0; i < MOTES; i++) {
        const s = seeds[i];
        if (!s) continue;
        const u = (s.phase + t * s.speed) % 1;
        const fade = Math.sin(Math.PI * u);
        quad(u, along);
        // across the path: the tangent turned a quarter round
        quad(Math.min(1, u + 0.01), tangent)
          .sub(along)
          .normalize();
        motePos.set(
          along.x - tangent.z * s.side + 0.3 * Math.sin(t * 0.6 + s.wobble),
          PLAZA_Y + s.y + 0.25 * Math.sin(t * 0.8 + s.wobble * 2),
          along.z + tangent.x * s.side,
        );
        moteScale.setScalar(0.3 + 0.9 * fade);
        motes.setMatrixAt(i, moteMatrix.compose(motePos, moteRot, moteScale));
      }
      // the road's: straight along it (east), drifting a little across, fading in and out at its ends
      for (let i = 0; i < ROAD_MOTES; i++) {
        const s = roadSeeds[i];
        if (!s) continue;
        const u = (s.phase + t * s.speed) % 1;
        const fade = Math.sin(Math.PI * u);
        const off = Math.max(
          -ROAD_MOTE_SPREAD,
          Math.min(ROAD_MOTE_SPREAD, s.side + 0.2 * Math.sin(t * 0.6 + s.wobble)),
        );
        const on = 0.3 * Math.sin(t * 0.5 + s.wobble * 3);
        motePos.set(
          r0[0] + roadX * (u * roadLength + on) - roadZ * off,
          PLAZA_Y + s.y + 0.2 * Math.sin(t * 0.8 + s.wobble * 2),
          r0[1] + roadZ * (u * roadLength + on) + roadX * off,
        );
        moteScale.setScalar(0.3 + 0.9 * fade);
        motes.setMatrixAt(MOTES + i, moteMatrix.compose(motePos, moteRot, moteScale));
      }
      motes.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const m of instanced) m.dispose();
    },
  };
}
