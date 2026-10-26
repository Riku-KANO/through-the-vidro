import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  attribute,
  clamp,
  dot,
  float,
  mix,
  normalView,
  output,
  positionView,
  positionViewDirection,
  pow,
  smoothstep,
  step,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { createBrassMaterial, createGlass } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import type { LayerField } from '../../layers/field';
import type { Box } from '../../layers/footing';
import type { LayerKind } from '../../layers/layers';
import type { SurfaceDecl } from '../area';
import type { MeshData } from '../player/walk-lab-field';
import { stoneMaterial } from '../prologue/room-art';
import {
  AREA1_GLIMMERS,
  AREA1_HOUSES,
  AREA1_PLAZA,
  AREA1_RIM,
  AREA1_SLOPE,
  AREA1_STREET,
  AREA1_Y,
  area1Ground,
  area1RimArcs,
  COURT_Y,
  eastX,
  HOUSE_ROUND,
  type House,
  MOTE_PATHS,
  motePathAt,
  NEXT_LAMPS_BY_ROOM,
  ROOM1_ALLEY,
  ROOM1_DROP,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
  ROOM2_BALCONY,
  ROOM2_COURT,
  ROOM2_DROP,
  ROOM2_PEDESTAL_A,
  ROOM2_PEDESTAL_B,
  ROOM2_RAIL,
  ROOM2_STAIRS,
  ROOM2_STAIRS_FOOT_Z,
  ROOM2_WALL,
  ROOM3_BRIDGE_N,
  ROOM3_BRIDGE_S,
  ROOM3_DROP,
  ROOM3_PEDESTAL_N,
  ROOM3_PEDESTAL_S,
  ROOM3_ROOF_N,
  ROOM3_ROOF_S,
  ROOM3_TERRACE,
  room2StairSegments,
  SHORTCUT_GATE,
  SHORTCUT_STAIRS,
  STREET_NORTH_Z,
  STREET_SOUTH_Z,
  SUMMIT_Y,
  shortcutSegments,
} from './layout';
import { area1SlopeDeckShape, balconyRails } from './physics';

/**
 * エリア1's look (S-36, S-40; 仮): grey boxes from code — the houses of the workshop street with their roofs as bubbles, stone
 * floors, brass balustrades, railings and lamps (形のルール: 泡と曲面、直線と細い線は真鍮の枠だけ); the rooms' crumbled walls on the
 * surface layer; their pedestals; on the back layer the courtyard's stair, the bridges over the summit's valley, the shortcut's
 * stairs (frosted glass with a thin-film sheen, as the prologue's bridge), the light drops; the shortcut's gate on the surface
 * layer; and the motes that lead on (ルール7) and the glimmers at the dead ends (ルール9). 色の進行: エリア1まではほぼ無色 — greys,
 * the brass's dull gold, the milky lamps. Blender takes it over later (焼き込みも).
 *
 * Built a step at a time (`buildArea1` yields between its parts) so the room can build it behind the scenes from the slope's
 * brow (S-36), a part per frame; then the room adds `root` to the scene and shows its `entries` one by one, warming each
 * (S-38: drawn uncut by the view) before the next. S-40 (発案者 2026-10-26: 視界の中で足すときは霞の奥から現れる): every material
 * of it (but the prologue's shared glass) can be drawn as far in the haze as the haze's own colour (`appear` 0) and come out of
 * it (`appear` to 1), so what is added in view is not seen to pop in.
 */

/** What the drawn drops are made of: the prologue's (room-art.ts) geometry and glass, so their pipelines are the ones warmed. */
export interface DropParts {
  coreGeometry: THREE.BufferGeometry;
  shellGeometry: THREE.BufferGeometry;
  /** The prologue's shell material (iridescent glass): shared, not disposed here. */
  shellMaterial: THREE.Material;
}

export interface Area1ArtOptions {
  /**
   * S-40: the scene's haze colour where a fragment is (the scene fog's colour: area1/art.ts hazeOf). With it, `appear` mixes
   * everything toward it; without it, `appear` does nothing (what is added pops in).
   */
  haze?: THREE.Node | null;
}

export interface Area1Art {
  /** Everything, under one group (the room adds it to the scene). */
  readonly root: THREE.Group;
  /**
   * The parts, each a group under `root` (S-40): the room shows them one at a time as it adds エリア1, so no frame makes all
   * of their pipelines or nodes at once. `warm[i]` holds the meshes of `entries[i]`.
   */
  readonly entries: readonly THREE.Group[];
  /** What to warm, one entry per frame: each entry's meshes are drawn uncut by the view that frame (core/glass/warm.ts). */
  readonly warm: readonly THREE.Object3D[][];
  /**
   * Boxes that hold what is drawn (each floor, each house with its roof, the courtyard, the summit, the shortcut): the room
   * adds エリア1 at once (appear 1) at a frame none of them is in the camera's view, out of the haze otherwise.
   */
  readonly bounds: readonly THREE.Box3[];
  /** The light drops by id (back layer). The room poses each: hovering, flying into the vidro, gone. */
  readonly drops: Readonly<Record<string, THREE.Object3D>>;
  /** 部屋1's (S-36's name). */
  readonly drop: THREE.Object3D;
  /** 0..1: out of the haze (S-40). */
  readonly appear: { value: number };
  /**
   * 0..1 eased focus (調べられる物に近づくと縁が淡く光る) of the targeted pedestal's cup and drop; which ones by setFocus.
   */
  readonly focus: { pedestal: { value: number }; drop: { value: number } };
  /** Which pedestal's cup and which drop the focus lights (null: none). */
  setFocus(pedestal: string | null, drop: string | null): void;
  /**
   * How many of the lamps toward the next room have lit, after 部屋1's drop (`room1`) and after 部屋2's (`room2`); 0 … their
   * count, fractional while one comes up (layout.ts NEXT_LAMPS_BY_ROOM).
   */
  setNext(room1: number, room2?: number): void;
  /**
   * Ambient motion (scene clock, seconds): the motes along MOTE_PATHS (`stage` 0..3: which way they lead, fractional while
   * they turn), the glimmers (`shortcut` 0..1: the shortcut's light has passed, and its dead ends' glimmers fade).
   */
  animate(t: number, stage: number, shortcut?: number): void;
  dispose(): void;
}

/**
 * The scene fog's colour node (S-40): three's `fog(color, factor)` call's first input (three r186 wraps the call in a VarNode),
 * or null for another kind of fog. area1/art.test.ts checks it against three's own `fog`, so a three that builds it otherwise
 * is caught there (エリア1 then pops in where it is added in view, as before S-40).
 */
export function hazeOf(scene: THREE.Scene): THREE.Node | null {
  type Wrapped = { isVarNode?: boolean; node?: unknown; rawInputs?: unknown[] };
  let n = scene.fogNode as unknown as Wrapped | null;
  for (let i = 0; n?.isVarNode && i < 4; i++) n = n.node as Wrapped | null;
  const color = n?.rawInputs?.[0] as { isNode?: boolean } | undefined;
  return color?.isNode ? (color as THREE.Node) : null;
}

/** The pedestals of エリア1 in the order their cups carry (the cup's index attribute). */
export const AREA1_PEDESTALS = [
  ROOM1_PEDESTAL,
  ROOM2_PEDESTAL_A,
  ROOM2_PEDESTAL_B,
  ROOM3_PEDESTAL_N,
  ROOM3_PEDESTAL_S,
] as const;
const DROPS = [ROOM1_DROP, ROOM2_DROP, ROOM3_DROP] as const;

/** 仮: the lamps' milky glow (a light source: blooms a little), dimmer than at night (it is morning). */
const LAMP_GLOW = { color: 0xffc896, intensity: 0.9 } as const;
/** 仮: the lamps toward the next room once lit (brighter, the way on). */
const NEXT_GLOW = { color: 0xffc58a, intensity: 3.2 } as const;
/** 仮: grey of the houses (灰色の箱) and of the crumbled walls (a little warmer, broken stone). Linear. */
const GREY = new THREE.Color(0.5, 0.52, 0.55);
const RUBBLE = new THREE.Color(0.56, 0.55, 0.53);
/** Motes along the way, and the glimmers of the back layer at the dead ends (ルール9: 光の揺らぎ). */
const MOTES = 36;
const GLIMMERS = 30;
/**
 * 仮 (S-36): the halo of a drop — a ball of warm light (linear) round its core, so that its light reads through the vidro against
 * the morning's grey (the core and the shell are the prologue's). Its middle crosses the bloom's threshold a little (光の雫は
 * 滲む: 画面の仕上げ). Gathered to its core (S-36 review: a wide even halo read like a lamp's milk globe).
 */
const DROP_HALO = { radius: 0.28, falloff: 3, color: [1.0, 0.78, 0.5] as const, strength: 1.1 };
/**
 * 仮 (S-36): a dark window, barred in brass, in the house that closes 部屋1's alley, right behind where its drop hovers (the drop's
 * light against shade). Its width, its sill and top above the floor, its bars.
 */
const WINDOW = { width: 1.3, sill: 0.6, top: 2.2, bars: 5, shade: new THREE.Color(0.045, 0.05, 0.06) };
/** Metres the boxes the room tests against the view (`bounds`) reach past what they hold. */
const BOUNDS_MARGIN = 0.5;
/** Thickness of the back layer's glass stair treads, bridge decks and steps. */
const DECK = 0.14;

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

function meshDataGeometry(data: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return g;
}

/** Only position and normal (so pieces of different kinds merge). */
function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes))
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  return g;
}

/** A box geometry filling a Box (min/max corners). */
function boxGeometry(b: Box): THREE.BufferGeometry {
  return bare(
    new THREE.BoxGeometry(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]).translate(
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ),
  );
}

/** A brass rod from a to b. */
function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, radial = 6): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(radius, radius, d.length(), radial);
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()),
  );
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/**
 * Builds エリア1 into a group, a part per step (yield: the room goes on to its next frame). Returns the art.
 */
export function* buildArea1(
  quality: QualityPreset,
  field: LayerField,
  dropParts: DropParts,
  options: Area1ArtOptions = {},
): Generator<void, Area1Art> {
  const root = new THREE.Group();
  root.name = 'area1';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const merged = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    // pieces of different kinds (RoundedBoxGeometry and the polyhedra come without an index): merge them all unindexed
    const flat = parts.some((p) => !p.index) ? parts.map((p) => (p.index ? p.toNonIndexed() : p)) : parts;
    const g = mergeGeometries(flat);
    for (const p of parts) p.dispose();
    for (const p of flat) p.dispose();
    if (!g) throw new Error('area1: mergeGeometries failed');
    g.computeBoundingSphere();
    return keep(g);
  };
  const warm: THREE.Object3D[][] = [];
  const entries: THREE.Group[] = [];
  const put = (o: THREE.Object3D, name: string, kind: LayerKind = 'shared'): THREE.Object3D => {
    o.name = name;
    field.assign(o, kind);
    const entry = new THREE.Group();
    entry.name = `${name}:entry`;
    entry.add(o);
    root.add(entry);
    entries.push(entry);
    warm.push([o]);
    return o;
  };

  // ---- S-40: out of the haze. Every material of エリア1 drawn toward the haze's own colour while `appear` is short of 1 ----
  const appear = uniform(1);
  const hidden = float(1).sub(appear);
  const haze = options.haze ?? null;
  const appearing = <T extends THREE.NodeMaterial>(m: T): T => {
    if (haze) m.outputNode = vec4(mix(output.rgb, haze as THREE.Node<'vec3'>, hidden), output.a);
    return m;
  };

  // ---- materials ---------------------------------------------------------------------------------------------------
  const stone = keep(appearing(stoneMaterial(0.62)));
  const grey = keep(
    appearing(new THREE.MeshStandardNodeMaterial({ color: GREY, roughness: 0.88, metalness: 0 })),
  );
  // each stone of the walls a little lighter or darker (its colour attribute)
  const rubble = keep(
    appearing(
      new THREE.MeshStandardNodeMaterial({
        color: RUBBLE,
        roughness: 0.95,
        metalness: 0,
        vertexColors: true,
      }),
    ),
  );
  const brass = keep(appearing(createBrassMaterial()));
  const lampMilk = keep(
    appearing(createGlass('milky', quality, { glow: LAMP_GLOW }).material as THREE.NodeMaterial),
  );
  // the lamps toward the next room: dark until lit, one after the other (each globe carries its index and its group)
  const nextMilk = keep(
    appearing(createGlass('milky', quality, { glow: NEXT_GLOW }).material as THREE.NodeMaterial),
  ) as THREE.MeshPhysicalNodeMaterial;
  const nextLit = { room1: uniform(0), room2: uniform(0) };
  const lampIndex = attribute<'float'>('lamp', 'float');
  const lampGroup = attribute<'float'>('lampGroup', 'float');
  const litNow = mix(
    clamp(nextLit.room1.sub(lampIndex), 0, 1),
    clamp(nextLit.room2.sub(lampIndex), 0, 1),
    lampGroup,
  );
  nextMilk.emissiveNode = (nextMilk.emissiveNode as THREE.Node<'vec3'>).mul(litNow.mul(0.92).add(0.08));
  // the pedestals' milky cups: a warm rim while one can be acted on (as the prologue's); the focused one by its index
  const focus = { pedestal: uniform(0), drop: uniform(0) };
  const focusCup = uniform(-1);
  const cupIndex = attribute<'float'>('cup', 'float');
  const cupMilk = keep(
    appearing(
      createGlass('milky', quality, { glow: { color: 0xffd2a0, intensity: 1.1 } })
        .material as THREE.NodeMaterial,
    ),
  ) as THREE.MeshPhysicalNodeMaterial;
  const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5);
  const isFocused = float(1).sub(step(0.5, abs(cupIndex.sub(focusCup))));
  cupMilk.emissiveNode = (cupMilk.emissiveNode as THREE.Node<'vec3'>).add(
    vec3(1.0, 0.82, 0.58).mul(rim.mul(focus.pedestal).mul(isFocused).mul(1.6)),
  );
  // the back layer's glass: frosted, a faint thin-film sheen, a faint warmth (as the prologue's bridge deck, room-art.ts)
  const deck = keep(
    appearing(
      new THREE.MeshPhysicalNodeMaterial({
        color: 0xe4ecf2,
        roughness: 0.46,
        metalness: 0,
        iridescence: 1,
        iridescenceIOR: 1.3,
        iridescenceThicknessRange: [180, 520],
      }),
    ),
  );
  // a cool glass, darker than the stone round it (it reads as the back layer, and the light that fixes it shows on it)
  deck.colorNode = vec4(0.42, 0.5, 0.6, 1);
  deck.emissiveNode = vec3(0.95, 0.74, 0.46).mul(0.04);
  yield;

  // ---- floors: the entrance plaza, the street, the alley, the slope's deck, the courtyard and its balcony, the summit's
  // terrace, the roofs across the valley (one stone, rock down their sides) ----------------------------------------------
  {
    const [cx, , cz] = AREA1_PLAZA.center;
    const parts: THREE.BufferGeometry[] = [];
    parts.push(
      bare(
        new THREE.CylinderGeometry(AREA1_PLAZA.radius + 0.3, AREA1_PLAZA.radius + 0.9, 6, 96, 1),
      ).translate(cx, AREA1_Y - 3.003, cz),
    );
    parts.push(
      boxGeometry({
        min: [AREA1_STREET.minX, AREA1_Y - 6.002, STREET_SOUTH_Z],
        max: [AREA1_STREET.maxX, AREA1_Y - 0.002, STREET_NORTH_Z],
      }),
    );
    parts.push(
      boxGeometry({
        min: [ROOM1_ALLEY.minX, AREA1_Y - 6.001, ROOM1_ALLEY.minZ - 0.3],
        max: [ROOM1_ALLEY.maxX, AREA1_Y - 0.001, ROOM1_ALLEY.maxZ],
      }),
    );
    parts.push(meshDataGeometry(area1SlopeDeckShape(6, -0.004)));
    parts.push(
      boxGeometry({
        min: [ROOM2_COURT.minX - 0.3, COURT_Y - 6.002, ROOM2_COURT.minZ],
        max: [ROOM2_COURT.maxX, COURT_Y - 0.002, ROOM2_BALCONY.minZ + 0.3],
      }),
    );
    parts.push(
      boxGeometry({
        min: [ROOM2_BALCONY.minX, COURT_Y - 0.5, ROOM2_BALCONY.minZ],
        max: [ROOM2_BALCONY.maxX, ROOM2_BALCONY.y - 0.001, ROOM2_BALCONY.maxZ],
      }),
    );
    parts.push(
      boxGeometry({
        min: [ROOM3_TERRACE.minX, SUMMIT_Y - 6.002, ROOM3_TERRACE.minZ],
        max: [ROOM3_TERRACE.maxX, SUMMIT_Y - 0.002, ROOM3_TERRACE.maxZ + 0.3],
      }),
    );
    for (const r of [ROOM3_ROOF_N, ROOM3_ROOF_S])
      parts.push(
        boxGeometry({ min: [r.minX, SUMMIT_Y - 0.3, r.minZ], max: [r.maxX, SUMMIT_Y - 0.002, r.maxZ] }),
      );
    put(new THREE.Mesh(merged(parts), stone), 'area1-floor');
  }
  yield;

  // ---- brass: the entrance plaza's balustrade, its lamps' posts, the eaves of the houses, the window, the pedestals' stems,
  // the balcony's railing, the brackets of the lamps toward the next room -----------------------------------------------
  const brassParts: THREE.BufferGeometry[] = [];
  const globes: THREE.BufferGeometry[] = [];
  const nextGlobes: THREE.BufferGeometry[] = [];
  {
    const [cx, , cz] = AREA1_PLAZA.center;
    const R = AREA1_PLAZA.radius;
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
        .translate(cx, AREA1_Y + y, cz);
    for (const { from, to } of area1RimArcs()) {
      brassParts.push(arcTorus(R, 0.028, AREA1_RIM.height, from, to, 8));
      brassParts.push(arcTorus(R, 0.018, 0.55, from, to));
      brassParts.push(arcTorus(R, 0.05, 0.03, from, to, 6));
      const posts = Math.max(1, Math.round(((to - from) * R) / 2.2));
      for (let i = 0; i <= posts; i++) {
        const a = from + ((to - from) * i) / posts;
        const [x, z] = [cx + Math.cos(a) * R, cz + Math.sin(a) * R];
        brassParts.push(
          new THREE.CylinderGeometry(0.022, 0.03, AREA1_RIM.height, 8).translate(
            x,
            AREA1_Y + AREA1_RIM.height / 2,
            z,
          ),
        );
        if (i < posts && i % 2 === 0) {
          const m = a + (to - from) / posts / 2;
          brassParts.push(
            new THREE.TorusGeometry(0.16, 0.011, 6, 28)
              .rotateY(Math.PI / 2 - m)
              .translate(cx + Math.cos(m) * R, AREA1_Y + (AREA1_RIM.height + 0.55) / 2, cz + Math.sin(m) * R),
          );
        }
      }
    }
    // 街灯 on the rim, between the openings
    for (const deg of [50, 130, 230, 310]) {
      const a = (deg * Math.PI) / 180;
      const [x, z] = [cx + Math.cos(a) * (R + 0.05), cz + Math.sin(a) * (R + 0.05)];
      brassParts.push(new THREE.CylinderGeometry(0.042, 0.063, 2.7, 8).translate(x, AREA1_Y + 1.35, z));
      brassParts.push(
        new THREE.TorusGeometry(0.14, 0.014, 6, 24).rotateX(Math.PI / 2).translate(x, AREA1_Y + 2.64, z),
      );
      globes.push(new THREE.SphereGeometry(0.16, 24, 12).translate(x, AREA1_Y + 2.84, z));
    }
    // 部屋2's balcony railing: a handrail, a mid rail and posts (the same lines as its colliders: physics.ts balconyRails)
    const y = ROOM2_BALCONY.y;
    for (const r of balconyRails()) {
      const a = new THREE.Vector3(
        r.at[0] - (r.along[0] * r.length) / 2,
        0,
        r.at[1] - (r.along[1] * r.length) / 2,
      );
      const b = new THREE.Vector3(
        r.at[0] + (r.along[0] * r.length) / 2,
        0,
        r.at[1] + (r.along[1] * r.length) / 2,
      );
      for (const [h, radius] of [
        [ROOM2_RAIL.height, 0.026],
        [ROOM2_RAIL.height * 0.5, 0.016],
      ] as const)
        brassParts.push(rod(a.clone().setY(y + h), b.clone().setY(y + h), radius, 8));
      const posts = Math.max(1, Math.round(r.length / 1.1));
      for (let i = 0; i <= posts; i++) {
        const p = a.clone().lerp(b, i / posts);
        brassParts.push(
          new THREE.CylinderGeometry(0.022, 0.028, ROOM2_RAIL.height, 8).translate(
            p.x,
            y + ROOM2_RAIL.height / 2,
            p.z,
          ),
        );
      }
    }
  }
  yield;

  // ---- the houses of the workshop street: grey boxes with rounded edges, their roofs bubbles (or flat where they are walked
  // on), a brass line at the eaves ------------------------------------------------------------------------------------
  const houseMesh = (zone: House['zone']): void => {
    const parts: THREE.BufferGeometry[] = [];
    for (const h of AREA1_HOUSES) {
      if (h.zone !== zone) continue;
      const w = h.maxX - h.minX;
      const d = h.maxZ - h.minZ;
      const bottom = AREA1_Y - 6;
      const top = AREA1_Y + h.height;
      const cx = (h.minX + h.maxX) / 2;
      const cz = (h.minZ + h.maxZ) / 2;
      parts.push(
        bare(new RoundedBoxGeometry(w, top - bottom, d, 2, HOUSE_ROUND)).translate(
          cx,
          (top + bottom) / 2,
          cz,
        ),
      );
      // the roof: a bubble on the house (泡の集合), as high as half the narrower side
      if (h.roof === 'bubble') {
        const roof = Math.min(w, d) / 2;
        parts.push(
          bare(new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2))
            .scale(w / 2 - 0.05, roof, d / 2 - 0.05)
            .translate(cx, top - 0.02, cz),
        );
      }
      // the brass line along the eaves
      for (const [x0, z0, x1, z1] of [
        [h.minX, h.minZ, h.maxX, h.minZ],
        [h.minX, h.maxZ, h.maxX, h.maxZ],
        [h.minX, h.minZ, h.minX, h.maxZ],
        [h.maxX, h.minZ, h.maxX, h.maxZ],
      ] as const) {
        const len = Math.hypot(x1 - x0, z1 - z0) - 2 * HOUSE_ROUND;
        const g = new THREE.CylinderGeometry(0.03, 0.03, len, 6).rotateZ(Math.PI / 2);
        if (x0 === x1) g.rotateY(Math.PI / 2);
        brassParts.push(g.translate((x0 + x1) / 2, top - 0.12, (z0 + z1) / 2));
      }
    }
    if (parts.length > 0) put(new THREE.Mesh(merged(parts), grey), `area1-houses-${zone}`);
  };
  for (const zone of ['plaza', 'street', 'slope', 'court', 'summit', 'hill'] as const) {
    houseMesh(zone);
    yield;
  }

  // ---- 部屋1: a dark window, barred in brass, in the house at the alley's end (behind the drop) -------------------------
  {
    const shade = keep(
      appearing(new THREE.MeshStandardNodeMaterial({ color: WINDOW.shade, roughness: 1, metalness: 0 })),
    );
    const x = ROOM1_DROP.at[0];
    const face = ROOM1_ALLEY.maxZ;
    const half = WINDOW.width / 2;
    // round-topped: the arch's centre is half a width under the top
    const archY = AREA1_Y + WINDOW.top - half;
    const pane = new THREE.Shape();
    pane.moveTo(-half, WINDOW.sill);
    pane.lineTo(half, WINDOW.sill);
    pane.lineTo(half, WINDOW.top - half);
    pane.absarc(0, WINDOW.top - half, half, 0, Math.PI, false);
    pane.lineTo(-half, WINDOW.sill);
    const g = bare(new THREE.ShapeGeometry(pane, 16));
    g.rotateY(Math.PI); // facing the alley, which lies south of the house's face (−Z)
    g.translate(x, AREA1_Y, face - 0.02);
    put(new THREE.Mesh(keep(g), shade), 'area1-window');
    const frame = 0.035;
    const arch = new THREE.TorusGeometry(half + 0.05, frame, 8, 32, Math.PI);
    arch.translate(x, archY, face - 0.05);
    brassParts.push(arch);
    for (const side of [-1, 1])
      brassParts.push(
        new THREE.CylinderGeometry(frame, frame, WINDOW.top - half - WINDOW.sill, 8).translate(
          x + side * (half + 0.05),
          AREA1_Y + (WINDOW.sill + WINDOW.top - half) / 2,
          face - 0.05,
        ),
      );
    // the sill, and the bars from it up to the arch
    brassParts.push(
      new THREE.CylinderGeometry(frame * 1.4, frame * 1.4, WINDOW.width + 0.24, 8)
        .rotateZ(Math.PI / 2)
        .translate(x, AREA1_Y + WINDOW.sill, face - 0.07),
    );
    for (let i = 0; i < WINDOW.bars; i++) {
      const dx = -half + ((i + 1) * WINDOW.width) / (WINDOW.bars + 1);
      const top = archY + Math.sqrt(half * half - dx * dx);
      const bottom = AREA1_Y + WINDOW.sill;
      brassParts.push(
        new THREE.CylinderGeometry(0.018, 0.018, top - bottom, 6).translate(
          x + dx,
          (top + bottom) / 2,
          face - 0.06,
        ),
      );
    }
  }
  yield;

  // ---- the crumbled walls (表にだけあるもの): 部屋1's across the alley, 部屋2's across the balcony; within their colliders' boxes
  {
    const rand = rng(36);
    const parts: THREE.BufferGeometry[] = [];
    /** One wall of stones in courses along its longer side (x or z), the upper courses broken; fallen pieces at its foot. */
    const crumbled = (wall: SurfaceDecl): void => {
      const { min, max } = wall.box;
      const alongX = max[0] - min[0] >= max[2] - min[2];
      const a0 = alongX ? min[0] : min[2];
      const a1 = alongX ? max[0] : max[2];
      const depth = alongX ? max[2] - min[2] : max[0] - min[0];
      const mid = alongX ? (min[2] + max[2]) / 2 : (min[0] + max[0]) / 2;
      const at = (along: number, across: number): [number, number] =>
        alongX ? [along, across] : [across, along];
      /** One stone of the wall, shaded a little apart from its neighbours (a colour per stone). */
      const stoneAt = (s0: number, s1: number, y0: number, h: number, shade: number): void => {
        const w = s1 - s0;
        const d = depth * (0.84 + 0.14 * rand());
        const g = bare(
          new RoundedBoxGeometry(alongX ? w * 0.97 : d, h * 0.96, alongX ? d : w * 0.97, 2, 0.035),
        );
        g.rotateY((rand() - 0.5) * 0.05);
        const [x, z] = at((s0 + s1) / 2, mid + (rand() - 0.5) * 0.03);
        g.translate(x, y0 + h / 2, z);
        const n = g.getAttribute('position').count;
        const c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) c.set([shade, shade, shade * 0.98], i * 3);
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        parts.push(g);
      };
      // courses of stones, each course shifted from the one below; the upper courses broken (崩れた: stones missing, the top
      // ragged), all inside the collider's box and none of the gaps low enough for the body to pass
      const rows = Math.max(3, Math.round((max[1] - min[1]) / 0.6));
      const course = (max[1] - min[1]) / rows;
      for (let r = 0; r < rows; r++) {
        const keepShare = r < rows - 2 ? 1 : r === rows - 2 ? 0.86 : 0.5;
        let s = a0 - (r % 2 === 1 ? 0.22 : 0);
        while (s < a1 - 0.05) {
          const s1 = Math.min(a1, s + 0.42 + rand() * 0.34);
          const s0 = Math.max(a0, s);
          const sag = r === rows - 1 ? rand() * 0.25 : 0;
          if (s1 - s0 > 0.12 && rand() < keepShare)
            stoneAt(s0, s1, min[1] + r * course, course - sag, 0.82 + rand() * 0.3);
          s = s1;
        }
      }
      // fallen pieces on the wall's line, low (the body walks over where the wall is cut)
      for (let i = 0; i < 9; i++) {
        const g = bare(new THREE.DodecahedronGeometry(0.05 + rand() * 0.07, 0));
        g.scale(1, 0.55, 1);
        const [x, z] = at(a0 + 0.2 + rand() * (a1 - a0 - 0.4), mid + (rand() - 0.5) * (depth - 0.1));
        g.translate(x, min[1] + 0.03, z);
        const n = g.getAttribute('position').count;
        const shade = 0.8 + rand() * 0.25;
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(shade), 3));
        parts.push(g);
      }
    };
    crumbled(ROOM1_WALL);
    crumbled(ROOM2_WALL);
    put(new THREE.Mesh(merged(parts), rubble), 'area1-wall', 'surface');
  }
  yield;

  // ---- the pedestals (brass stems, milky cups), the lamps toward the next room ------------------------------------------
  {
    const cups: THREE.BufferGeometry[] = [];
    AREA1_PEDESTALS.forEach((p, i) => {
      const [bx, by, bz] = p.base;
      brassParts.push(
        new THREE.LatheGeometry(
          [
            [0.0, 0],
            [0.26, 0],
            [0.27, 0.05],
            [0.13, 0.14],
            [0.06, 0.3],
            [0.05, 0.86],
            [0.09, 0.94],
            [0.0, 0.94],
          ].map(([x = 0, y = 0]) => new THREE.Vector2(x, y)),
          40,
        ).translate(bx, by, bz),
      );
      const cup = bare(
        new THREE.SphereGeometry(0.12, 32, 12, 0, Math.PI * 2, Math.PI * 0.56, Math.PI * 0.44),
      ).translate(bx, p.orb[1] - 0.02, bz);
      cup.setAttribute(
        'cup',
        new THREE.Float32BufferAttribute(new Float32Array(cup.getAttribute('position').count).fill(i), 1),
      );
      cups.push(cup);
    });
    put(new THREE.Mesh(merged(cups), cupMilk), 'area1-pedestal-cups');

    // the lamps toward the next room: wall brackets on the houses, the last of 部屋1's on the balcony's railing post
    const groups = [NEXT_LAMPS_BY_ROOM.room1, NEXT_LAMPS_BY_ROOM.room2];
    for (let group = 0; group < groups.length; group++) {
      const lamps = groups[group] ?? [];
      for (let i = 0; i < lamps.length; i++) {
        const p = lamps[i] as readonly [number, number, number];
        const g = new THREE.SphereGeometry(0.17, 24, 12).translate(p[0], p[1], p[2]);
        const count = g.getAttribute('position').count;
        g.setAttribute('lamp', new THREE.Float32BufferAttribute(new Float32Array(count).fill(i), 1));
        g.setAttribute('lampGroup', new THREE.Float32BufferAttribute(new Float32Array(count).fill(group), 1));
        nextGlobes.push(g);
        brassParts.push(
          new THREE.TorusGeometry(0.1, 0.012, 6, 24).rotateX(Math.PI / 2).translate(p[0], p[1] - 0.12, p[2]),
        );
        brassParts.push(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 6).translate(p[0], p[1] - 0.4, p[2]));
      }
    }
  }
  put(new THREE.Mesh(merged(brassParts), brass), 'area1-brass');
  put(new THREE.Mesh(merged(globes), lampMilk), 'area1-lamps');
  put(new THREE.Mesh(merged(nextGlobes), nextMilk), 'area1-next-lamps');
  yield;

  // ---- the back layer: 部屋2's stair, 部屋3's bridges, the shortcut's stairs (frosted glass), and their brass rails --------
  {
    const glass: THREE.BufferGeometry[] = [];
    const rails: THREE.BufferGeometry[] = [];
    for (const t of room2StairSegments())
      glass.push(
        boxGeometry({
          min: [t.min[0], COURT_Y - 0.002, t.min[2]],
          max: [t.max[0], t.max[1] - 0.003, t.max[2]],
        }),
      );
    for (const b of [ROOM3_BRIDGE_N, ROOM3_BRIDGE_S])
      glass.push(
        boxGeometry({
          min: [b.min[0], SUMMIT_Y - DECK, b.min[2]],
          max: [b.max[0], SUMMIT_Y - 0.003, b.max[2]],
        }),
      );
    const steps = shortcutSegments();
    for (const s of steps)
      glass.push(
        boxGeometry({
          min: [s.min[0], s.max[1] - DECK - 0.06, s.min[2]],
          max: [s.max[0], s.max[1] - 0.006, s.max[2]],
        }),
      );
    // rails: along each side of the stair, the bridges and the shortcut, a handrail on posts
    const railAlong = (x: number, zs: readonly number[], top: (z: number) => number): void => {
      for (let i = 1; i < zs.length; i++) {
        const z0 = zs[i - 1] as number;
        const z1 = zs[i] as number;
        rails.push(
          rod(new THREE.Vector3(x, top(z0) + 0.88, z0), new THREE.Vector3(x, top(z1) + 0.88, z1), 0.018),
        );
      }
      for (const z of zs)
        rails.push(new THREE.CylinderGeometry(0.016, 0.02, 0.88, 6).translate(x, top(z) + 0.44, z));
    };
    const ramp = (z0: number, z1: number, n: number): number[] =>
      Array.from({ length: n + 1 }, (_, i) => z0 + ((z1 - z0) * i) / n);
    const stairTop = (z: number): number => {
      const i = Math.min(
        ROOM2_STAIRS.steps - 1,
        Math.max(0, Math.floor((z - ROOM2_STAIRS_FOOT_Z) / ROOM2_STAIRS.tread)),
      );
      return COURT_Y + (i + 1) * ROOM2_STAIRS.rise;
    };
    for (const x of [ROOM2_STAIRS.minX + 0.03, ROOM2_STAIRS.maxX - 0.03])
      railAlong(x, ramp(ROOM2_STAIRS_FOOT_Z + 0.1, ROOM2_STAIRS.topZ - 0.05, 3), stairTop);
    for (const b of [ROOM3_BRIDGE_N, ROOM3_BRIDGE_S])
      for (const z of [b.min[2] + 0.03, b.max[2] - 0.03]) {
        const at = (x: number) => new THREE.Vector3(x, SUMMIT_Y + 0.88, z);
        rails.push(rod(at(b.min[0] + 0.15), at(b.max[0] - 0.15), 0.018));
        for (const x of [b.min[0] + 0.15, (b.min[0] + b.max[0]) / 2, b.max[0] - 0.15])
          rails.push(new THREE.CylinderGeometry(0.016, 0.02, 0.88, 6).translate(x, SUMMIT_Y + 0.44, z));
      }
    const stepTop = (z: number): number =>
      area1Ground((SHORTCUT_STAIRS.minX + SHORTCUT_STAIRS.maxX) / 2, z) ?? AREA1_Y;
    for (const x of [SHORTCUT_STAIRS.minX + 0.03, SHORTCUT_STAIRS.maxX - 0.03])
      railAlong(x, ramp(SHORTCUT_STAIRS.topZ + 0.2, SHORTCUT_STAIRS.footZ - 0.2, 12), stepTop);
    put(new THREE.Mesh(merged(glass), deck), 'area1-back-glass', 'back');
    put(new THREE.Mesh(merged(rails), brass), 'area1-back-rails', 'back');
  }
  yield;

  // ---- the shortcut's gate (閉ざされた扉, surface layer): posts, an arch, bars, crossbars across the plaza's south opening ----
  {
    const parts: THREE.BufferGeometry[] = [];
    const { min, max } = SHORTCUT_GATE.box;
    const z = (min[2] + max[2]) / 2;
    const x0 = min[0] + 0.08;
    const x1 = max[0] - 0.08;
    const hw = (x1 - x0) / 2;
    const xc = (x0 + x1) / 2;
    const height = max[1] - min[1];
    const springs = height - hw * 0.45;
    for (const x of [x0, x1])
      parts.push(new THREE.CylinderGeometry(0.07, 0.085, springs, 12).translate(x, AREA1_Y + springs / 2, z));
    const arch = new THREE.TorusGeometry(hw, 0.06, 10, 64, Math.PI);
    arch.scale(1, 0.45, 1);
    arch.translate(xc, AREA1_Y + springs, z);
    parts.push(arch);
    const bars = 17;
    for (let i = 1; i < bars; i++) {
      const dx = -hw + (2 * hw * i) / bars;
      const h = springs + 0.45 * Math.sqrt(Math.max(0, hw * hw - dx * dx)) - 0.05;
      parts.push(new THREE.CylinderGeometry(0.016, 0.016, h, 6).translate(xc + dx, AREA1_Y + h / 2, z));
    }
    for (const y of [0.15, 1.15])
      parts.push(
        new THREE.CylinderGeometry(0.022, 0.022, 2 * hw, 8)
          .rotateZ(Math.PI / 2)
          .translate(xc, AREA1_Y + y, z),
      );
    put(new THREE.Mesh(merged(parts), brass), 'area1-shortcut-gate', 'surface');
  }
  yield;

  // ---- the light drops (裏の層): the prologue's shape and glass, a bright core and a halo of warm light each; in the morning's
  // grey the drop alone reads as a dull bead (S-36 review 1 P1-2): its light is what shows through the vidro ---------------
  const drops: Record<string, THREE.Object3D> = {};
  const dropFocus = new Map<string, { value: number }>();
  for (const d of DROPS) {
    const drop = new THREE.Group();
    const lit = uniform(0);
    dropFocus.set(d.id, lit);
    const amount = focus.drop.mul(lit);
    const coreMat = keep(appearing(new THREE.MeshBasicNodeMaterial()));
    coreMat.colorNode = vec4(vec3(2.4, 1.9, 1.25).mul(amount.mul(0.5).add(1)), 1);
    drop.add(new THREE.Mesh(dropParts.coreGeometry, coreMat));
    drop.add(new THREE.Mesh(dropParts.shellGeometry, dropParts.shellMaterial));
    // the halo: a ball of warm light added over what is behind, strongest through its middle, gone at its rim and near the eye
    const haloMat = keep(
      new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    haloMat.fog = false;
    const facing = abs(dot(normalView, positionViewDirection));
    haloMat.colorNode = vec4(
      vec3(...DROP_HALO.color).mul(
        pow(facing, DROP_HALO.falloff).mul(DROP_HALO.strength).mul(amount.mul(0.3).add(1)).mul(appear),
      ),
      1,
    );
    haloMat.opacityNode = smoothstep(0.4, 1.2, positionView.length());
    const halo = new THREE.Mesh(keep(new THREE.SphereGeometry(DROP_HALO.radius, 24, 16)), haloMat);
    halo.name = `${d.id}-halo`;
    halo.renderOrder = 6;
    drop.add(halo);
    drop.position.set(...d.at);
    put(drop, `area1-drop:${d.id}`, 'back');
    drops[d.id] = drop;
  }

  // ---- motes: along the way to the room whose drop waits, on to the next; the glimmers of the back layer at the dead ends --
  const moteMat = keep(
    new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  moteMat.colorNode = vec4(vec3(1.1, 0.8, 0.46).mul(appear), 1);
  moteMat.opacityNode = smoothstep(0.8, 3.0, positionView.length());
  moteMat.fog = false;
  // One mesh whose vertices are written every frame, not an InstancedMesh: three r186 writes an InstancedMesh's matrices
  // into a uniform buffer named after the node (NodeBuffer_<id>), so its shader is new in every render context and
  // compileAsync (render context of call depth 0) cannot make the scene pass's (call depth 1) — S-36 measured 125 ms on
  // WebGL2 the first time the scene pass drew them. A plain mesh's shader is the same in both and is compiled ahead.
  const moteShape = new THREE.IcosahedronGeometry(0.022, 0); // non-indexed: 60 vertices
  const moteCorner = moteShape.getAttribute('position').array as Float32Array;
  const moteNormal = moteShape.getAttribute('normal').array as Float32Array;
  const MOTE_FLOATS = moteCorner.length;
  const moteXyz = new Float32Array(MOTE_FLOATS * (MOTES + GLIMMERS));
  const moteNormals = new Float32Array(moteXyz.length);
  for (let i = 0; i < MOTES + GLIMMERS; i++) moteNormals.set(moteNormal, i * MOTE_FLOATS);
  moteShape.dispose();
  const moteGeometry = keep(new THREE.BufferGeometry());
  const motePosition = new THREE.BufferAttribute(moteXyz, 3).setUsage(THREE.DynamicDrawUsage);
  moteGeometry.setAttribute('position', motePosition);
  moteGeometry.setAttribute('normal', new THREE.BufferAttribute(moteNormals, 3));
  // where they drift, from the road's end to the summit and down the shortcut (written once: the vertices move, the sphere stays)
  moteGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(eastX(110), AREA1_Y + 6, -142), 32);
  const motes = new THREE.Mesh(moteGeometry, moteMat);
  put(motes, 'area1-motes');
  const seeds = Array.from({ length: MOTES + GLIMMERS }, (_, i) => {
    const r = rng(3600 + i);
    return {
      side: (r() - 0.5) * 2.4,
      y: 0.4 + r() * 2.0,
      phase: r(),
      speed: 0.03 + r() * 0.03,
      wobble: r() * 6,
      spot: i % AREA1_GLIMMERS.length,
    };
  });
  const along: [number, number] = [0, 0];
  const alongNext: [number, number] = [0, 0];
  const pos = new THREE.Vector3();
  /** Writes mote `i` at `pos`, `size` times its shape. */
  const placeMote = (i: number, size: number): void => {
    const at = i * MOTE_FLOATS;
    for (let k = 0; k < MOTE_FLOATS; k += 3) {
      moteXyz[at + k] = pos.x + size * (moteCorner[k] ?? 0);
      moteXyz[at + k + 1] = pos.y + size * (moteCorner[k + 1] ?? 0);
      moteXyz[at + k + 2] = pos.z + size * (moteCorner[k + 2] ?? 0);
    }
  };
  yield;

  // what is drawn, as boxes (for the room's test of the view before it adds エリア1)
  const bounds: THREE.Box3[] = [];
  // with a margin for what is drawn at their faces (the eaves' brass, the rims' stones: area1/art.test.ts)
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    bounds.push(
      new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)).expandByScalar(
        BOUNDS_MARGIN,
      ),
    );
  };
  {
    const [cx, , cz] = AREA1_PLAZA.center;
    const r = AREA1_PLAZA.radius + 1;
    box(cx - r, AREA1_Y - 6, cz - r, cx + r, AREA1_Y + 3.2, cz + r);
    box(AREA1_STREET.minX, AREA1_Y - 6, STREET_SOUTH_Z, AREA1_STREET.maxX, AREA1_Y + 3, STREET_NORTH_Z);
    box(ROOM1_ALLEY.minX, AREA1_Y - 6, ROOM1_ALLEY.minZ, ROOM1_ALLEY.maxX, AREA1_Y + 3, ROOM1_ALLEY.maxZ);
    const hw = AREA1_SLOPE.halfWidth;
    box(
      AREA1_SLOPE.x - hw,
      AREA1_Y - 6,
      AREA1_SLOPE.toZ - 0.3,
      AREA1_SLOPE.x + hw,
      SUMMIT_Y + 3,
      AREA1_SLOPE.fromZ,
    );
    // the courtyard with its balcony, stair, wall, pedestals, drop and motes
    box(
      ROOM2_COURT.minX - 0.3,
      COURT_Y - 6,
      ROOM2_COURT.minZ,
      ROOM2_COURT.maxX,
      ROOM2_BALCONY.y + 2.6,
      ROOM2_BALCONY.maxZ,
    );
    // the summit's terrace, the valley's bridges, the roofs across (their glimmers), the shortcut's stairs with the gate
    box(
      ROOM3_TERRACE.minX,
      SUMMIT_Y - 6,
      ROOM3_TERRACE.minZ,
      ROOM3_TERRACE.maxX,
      SUMMIT_Y + 3,
      ROOM3_TERRACE.maxZ + 0.3,
    );
    box(
      ROOM3_BRIDGE_S.min[0],
      SUMMIT_Y - 1,
      ROOM3_BRIDGE_S.min[2],
      ROOM3_BRIDGE_N.max[0],
      SUMMIT_Y + 1.5,
      ROOM3_BRIDGE_N.max[2],
    );
    for (const r of [ROOM3_ROOF_N, ROOM3_ROOF_S])
      box(r.minX, SUMMIT_Y - 1, r.minZ, r.maxX, SUMMIT_Y + 3.2, r.maxZ);
    box(
      SHORTCUT_GATE.box.min[0],
      AREA1_Y - 0.5,
      SHORTCUT_STAIRS.topZ,
      SHORTCUT_GATE.box.max[0],
      SUMMIT_Y + 2.4,
      SHORTCUT_GATE.box.max[2] + 0.3,
    );
    for (const h of AREA1_HOUSES)
      box(
        h.minX,
        AREA1_Y - 6,
        h.minZ,
        h.maxX,
        AREA1_Y + h.height + (h.roof === 'bubble' ? Math.min(h.maxX - h.minX, h.maxZ - h.minZ) / 2 : 0),
        h.maxZ,
      );
  }

  /** Where the motes float over at (x, z): the ground there, or the town's floor off it. */
  const groundAt = (x: number, z: number): number => area1Ground(x, z) ?? AREA1_Y;
  const art: Area1Art = {
    root,
    entries,
    warm,
    bounds,
    drops,
    drop: drops[ROOM1_DROP.id] as THREE.Object3D,
    appear,
    focus,
    setFocus(pedestal, drop) {
      const i = AREA1_PEDESTALS.findIndex((p) => p.id === pedestal);
      focusCup.value = i;
      for (const [id, u] of dropFocus) u.value = id === drop ? 1 : 0;
    },
    setNext(room1, room2 = 0) {
      nextLit.room1.value = Math.max(0, Math.min(NEXT_LAMPS_BY_ROOM.room1.length, room1));
      nextLit.room2.value = Math.max(0, Math.min(NEXT_LAMPS_BY_ROOM.room2.length, room2));
    },
    animate(t, stage, shortcut = 0) {
      const last = MOTE_PATHS.length - 1;
      const st = Math.max(0, Math.min(last, stage));
      const from = Math.floor(st);
      const to = Math.min(last, from + 1);
      const turn = st - from;
      for (let i = 0; i < MOTES + GLIMMERS; i++) {
        const s = seeds[i];
        if (!s) continue;
        const u = (s.phase + t * s.speed) % 1;
        const fade = Math.sin(Math.PI * u);
        if (i < MOTES) {
          // along the way to the room whose drop waits, turning to the way on as its drop is taken
          const [ax, az] = motePathAt(MOTE_PATHS[from] ?? MOTE_PATHS[0] ?? [], u, along);
          const [bx, bz] = motePathAt(MOTE_PATHS[to] ?? MOTE_PATHS[0] ?? [], u, alongNext);
          const x = ax + (bx - ax) * turn + 0.25 * Math.sin(t * 0.6 + s.wobble);
          const z = az + (bz - az) * turn + s.side * 0.4;
          const y = groundAt(x, z) + s.y + 0.2 * Math.sin(t * 0.8 + s.wobble * 2);
          pos.set(x, y, z);
          placeMote(i, 0.3 + 0.9 * fade);
        } else {
          // a slow glimmer drifting up at a dead end (行き止まりの理由: 裏の層の気配); the shortcut's go once its light has passed
          const spot = AREA1_GLIMMERS[s.spot] ?? AREA1_GLIMMERS[0];
          if (!spot) continue;
          const gone = s.spot === 0 ? 1 : 1 - Math.min(1, Math.max(0, shortcut));
          pos.set(
            spot.at[0] + s.side * 0.5 * spot.spread + 0.2 * Math.sin(t * 0.5 + s.wobble),
            spot.at[1] + u * spot.rise + 0.1 * Math.sin(t * 0.9 + s.wobble),
            spot.at[2] + (s.y - 1.4) * 0.5 * spot.spread,
          );
          placeMote(i, (0.6 + 1.2 * fade) * (0.7 + 0.3 * Math.sin(t * 1.3 + s.wobble)) * gone);
        }
      }
      motePosition.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
  return art;
}
