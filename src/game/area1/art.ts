import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  attribute,
  clamp,
  dot,
  float,
  normalView,
  positionView,
  positionViewDirection,
  pow,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { createBrassMaterial, createGlass } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import type { LayerField } from '../../layers/field';
import type { LayerKind } from '../../layers/layers';
import type { MeshData } from '../player/walk-lab-field';
import { stoneMaterial } from '../prologue/room-art';
import { sweptSlab } from '../prologue/slope';
import {
  AREA1_GATE,
  AREA1_HOUSES,
  AREA1_PLAZA,
  AREA1_RIM,
  AREA1_SLOPE,
  AREA1_STREET,
  AREA1_Y,
  area1RimArcs,
  area1SlopeHeight,
  eastX,
  HOUSE_ROUND,
  type House,
  MOTES_TO_NEXT,
  MOTES_TO_ROOM,
  NEXT_LAMPS,
  ROOM1_ALLEY,
  ROOM1_DROP,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
  STREET_NORTH_Z,
  STREET_SOUTH_Z,
} from './layout';
import { area1SlopeDeckShape } from './physics';

/**
 * エリア1's look (S-36, 仮): grey boxes from code — the houses of the workshop street with their roofs as bubbles, stone floors,
 * brass balustrades, railings, lamps and the slope's shut gate (形のルール: 泡と曲面、直線と細い線は真鍮の枠だけ), 部屋1's crumbled
 * wall on the surface layer, its pedestal and its light drop on the back layer, and the motes that lead on (ルール7). 色の進行:
 * エリア1まではほぼ無色 — greys, the brass's dull gold, the milky lamps. Blender takes it over later (焼き込みも).
 *
 * Built a step at a time (`buildArea1` yields between its parts) so the room can build it behind the scenes while the body is
 * in the central plaza (S-36: 中央広場にいる間に裏で組み立てる), one part per frame; then the room adds `root` to the scene while
 * it is out of view and warms `warm` (one entry per frame) before it is seen.
 */

/** What the drawn drop is made of: the prologue's (room-art.ts) geometry and glass, so its pipelines are the ones warmed. */
export interface DropParts {
  coreGeometry: THREE.BufferGeometry;
  shellGeometry: THREE.BufferGeometry;
  /** The prologue's shell material (iridescent glass): shared, not disposed here. */
  shellMaterial: THREE.Material;
}

export interface Area1Art {
  /** Everything, under one group (the room adds it to the scene). */
  readonly root: THREE.Group;
  /** What to warm, one entry per frame: each entry's meshes are drawn uncut by the view that frame (core/glass/warm.ts). */
  readonly warm: readonly THREE.Object3D[][];
  /**
   * Boxes that hold what is drawn (each floor, each house with its roof, the gate): the room adds エリア1 to the scene at a
   * frame none of them is in the camera's view.
   */
  readonly bounds: readonly THREE.Box3[];
  /** 部屋1's light drop (back layer). The room poses it: hovering, flying into the vidro, gone. */
  readonly drop: THREE.Object3D;
  /** 0..1 eased focus of the pedestal's cup and of the drop (調べられる物に近づくと縁が淡く光る). */
  readonly focus: { pedestal: { value: number }; drop: { value: number } };
  /** How many of the lamps toward the next room have lit (0 … NEXT_LAMPS.length, fractional while one comes up). */
  setNext(lit: number): void;
  /** Ambient motion: the motes (scene clock, seconds). `toNext` 0..1 turns their path from the room to the next one. */
  animate(t: number, toNext: number): void;
  dispose(): void;
}

/** 仮: the lamps' milky glow (a light source: blooms a little), dimmer than at night (it is morning). */
const LAMP_GLOW = { color: 0xffc896, intensity: 0.9 } as const;
/** 仮: the lamps toward the next room once lit (brighter, the way on), and the gate's keystone among them. */
const NEXT_GLOW = { color: 0xffc58a, intensity: 3.2 } as const;
/** 仮: grey of the houses (灰色の箱) and of the crumbled wall (a little warmer, broken stone). Linear. */
const GREY = new THREE.Color(0.5, 0.52, 0.55);
const RUBBLE = new THREE.Color(0.56, 0.55, 0.53);
/** Motes: on the way to the room, and the glimmer of the back layer beyond the gate (ルール9: 光の揺らぎ). */
const MOTES = 36;
const GLIMMERS = 26;
/**
 * 仮 (S-36): the halo of 部屋1's drop — a ball of warm light (linear) round its core, so that its light reads through the
 * vidro against the morning's grey (the core and the shell are the prologue's). Its middle crosses the bloom's threshold a
 * little (光の雫は滲む: 画面の仕上げ). Gathered to its core (S-36 review: a wide even halo read like a lamp's milk globe).
 */
const DROP_HALO = { radius: 0.28, falloff: 3, color: [1.0, 0.78, 0.5] as const, strength: 1.1 };
/**
 * 仮 (S-36): a dark window, barred in brass, in the house that closes the alley, right behind where the drop hovers: the
 * drop's light is seen against shade (コントラスト), through the vidro as well (the house is on both layers). A window with
 * bars, not a door (S-36 review: a dark doorway read as a way on, ルール9 — the alley ends at the house). Its width, its sill
 * and top above the floor, its bars.
 */
const WINDOW = { width: 1.3, sill: 0.6, top: 2.2, bars: 5, shade: new THREE.Color(0.045, 0.05, 0.06) };
/** Metres the boxes the room tests against the view (`bounds`) reach past what they hold. */
const BOUNDS_MARGIN = 0.5;
/** How far up the slope past the shut gate its stone is drawn (z): it is seen climbing on through the bars (ルール6・9). */
const BEYOND_GATE_Z = -156;

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

/**
 * Builds エリア1 into a group, a part per step (yield: the room goes on to its next frame). Returns the art.
 */
export function* buildArea1(
  quality: QualityPreset,
  field: LayerField,
  dropParts: DropParts,
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
  const put = (o: THREE.Object3D, name: string, kind: LayerKind = 'shared'): THREE.Object3D => {
    o.name = name;
    field.assign(o, kind);
    root.add(o);
    warm.push([o]);
    return o;
  };

  // ---- materials ---------------------------------------------------------------------------------------------------
  const stone = keep(stoneMaterial(0.62));
  const grey = keep(new THREE.MeshStandardNodeMaterial({ color: GREY, roughness: 0.88, metalness: 0 }));
  // each stone of the wall a little lighter or darker (its colour attribute)
  const rubble = keep(
    new THREE.MeshStandardNodeMaterial({ color: RUBBLE, roughness: 0.95, metalness: 0, vertexColors: true }),
  );
  const brass = keep(createBrassMaterial());
  const lampMilk = keep(createGlass('milky', quality, { glow: LAMP_GLOW }).material);
  // the lamps toward the next room: dark until lit, one after the other (each globe carries its index)
  const nextMilk = keep(
    createGlass('milky', quality, { glow: NEXT_GLOW }).material,
  ) as THREE.MeshPhysicalNodeMaterial;
  const nextLit = uniform(0);
  const lampIndex = attribute<'float'>('lamp', 'float');
  nextMilk.emissiveNode = (nextMilk.emissiveNode as THREE.Node<'vec3'>).mul(
    clamp(nextLit.sub(lampIndex), 0, 1).mul(0.92).add(0.08),
  );
  // the pedestal's milky cup: a warm rim while it can be acted on (as the prologue's)
  const focus = { pedestal: uniform(0), drop: uniform(0) };
  const cupMilk = keep(
    createGlass('milky', quality, { glow: { color: 0xffd2a0, intensity: 1.1 } }).material,
  ) as THREE.MeshPhysicalNodeMaterial;
  const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5);
  cupMilk.emissiveNode = (cupMilk.emissiveNode as THREE.Node<'vec3'>).add(
    vec3(1.0, 0.82, 0.58).mul(rim.mul(focus.pedestal).mul(1.6)),
  );
  yield;

  // ---- floors: the entrance plaza, the street, the alley, the slope's deck (one stone, rock down their sides) ----------
  {
    const [cx, , cz] = AREA1_PLAZA.center;
    const parts: THREE.BufferGeometry[] = [];
    parts.push(
      bare(
        new THREE.CylinderGeometry(AREA1_PLAZA.radius + 0.3, AREA1_PLAZA.radius + 0.9, 6, 96, 1),
      ).translate(cx, AREA1_Y - 3.003, cz),
    );
    parts.push(
      bare(
        new THREE.BoxGeometry(AREA1_STREET.maxX - AREA1_STREET.minX, 6, STREET_NORTH_Z - STREET_SOUTH_Z),
      ).translate((AREA1_STREET.minX + AREA1_STREET.maxX) / 2, AREA1_Y - 3.002, AREA1_STREET.z),
    );
    parts.push(
      bare(
        new THREE.BoxGeometry(
          ROOM1_ALLEY.maxX - ROOM1_ALLEY.minX,
          6,
          ROOM1_ALLEY.maxZ - ROOM1_ALLEY.minZ + 0.3,
        ),
      ).translate(
        (ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2,
        AREA1_Y - 3.001,
        (ROOM1_ALLEY.minZ + ROOM1_ALLEY.maxZ - 0.3) / 2,
      ),
    );
    parts.push(meshDataGeometry(area1SlopeDeckShape(6, -0.004)));
    // past the shut gate the slope climbs on toward the summit, drawn only (no one walks there until S-40)
    const { x, halfWidth } = AREA1_SLOPE;
    const z0 = AREA1_GATE.z - 1.0;
    const z1 = BEYOND_GATE_Z;
    parts.push(
      meshDataGeometry(
        sweptSlab(
          z0,
          z1,
          Math.round((z0 - z1) * 2),
          x - halfWidth,
          x + halfWidth,
          (z) => area1SlopeHeight(z) - 0.006,
          (z) => area1SlopeHeight(z) - 6,
        ),
      ),
    );
    put(new THREE.Mesh(merged(parts), stone), 'area1-floor');
  }
  yield;

  // ---- brass: the entrance plaza's balustrade, its lamps' posts, the eaves of the houses, the slope's gate, the brackets --
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
  }
  yield;

  // ---- the houses of the workshop street: grey boxes with rounded edges, their roofs bubbles, a brass line at the eaves --
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
      const roof = Math.min(w, d) / 2;
      parts.push(
        bare(new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2))
          .scale(w / 2 - 0.05, roof, d / 2 - 0.05)
          .translate(cx, top - 0.02, cz),
      );
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
  houseMesh('plaza');
  yield;
  houseMesh('street');
  yield;
  houseMesh('slope');
  yield;

  // ---- 部屋1: a dark window, barred in brass, in the house at the alley's end (behind the drop) -------------------------
  {
    const shade = keep(
      new THREE.MeshStandardNodeMaterial({ color: WINDOW.shade, roughness: 1, metalness: 0 }),
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

  // ---- 部屋1: the crumbled wall (表にだけあるもの), a little rubble at its foot; within its collider's box ------------------
  {
    const rand = rng(36);
    const { min, max } = ROOM1_WALL.box;
    const parts: THREE.BufferGeometry[] = [];
    const depth = max[2] - min[2];
    const midZ = (min[2] + max[2]) / 2;
    /** One stone of the wall, shaded a little apart from its neighbours (a colour per stone). */
    const stoneAt = (x0: number, x1: number, y0: number, h: number, shade: number): void => {
      const w = x1 - x0;
      const g = bare(new RoundedBoxGeometry(w * 0.97, h * 0.96, depth * (0.84 + 0.14 * rand()), 2, 0.035));
      g.rotateY((rand() - 0.5) * 0.05);
      g.translate((x0 + x1) / 2, y0 + h / 2, midZ + (rand() - 0.5) * 0.03);
      const n = g.getAttribute('position').count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.set([shade, shade, shade * 0.98], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      parts.push(g);
    };
    // courses of stones, each course shifted from the one below; the upper courses broken (崩れた: stones missing, the top
    // ragged), all inside the collider's box and none of the gaps low enough for the body to pass
    const rows = 4;
    const course = (max[1] - min[1]) / rows;
    for (let r = 0; r < rows; r++) {
      const keepShare = r < 2 ? 1 : r === 2 ? 0.86 : 0.5;
      let x = min[0] - (r % 2 === 1 ? 0.22 : 0);
      while (x < max[0] - 0.05) {
        const x1 = Math.min(max[0], x + 0.42 + rand() * 0.34);
        const x0 = Math.max(min[0], x);
        const sag = r === rows - 1 ? rand() * 0.25 : 0;
        if (x1 - x0 > 0.12 && rand() < keepShare)
          stoneAt(x0, x1, min[1] + r * course, course - sag, 0.82 + rand() * 0.3);
        x = x1;
      }
    }
    // fallen pieces on the wall's line, low (the body walks over where the wall is cut)
    for (let i = 0; i < 9; i++) {
      const g = bare(new THREE.DodecahedronGeometry(0.05 + rand() * 0.07, 0));
      g.scale(1, 0.55, 1);
      g.translate(
        min[0] + 0.2 + rand() * (max[0] - min[0] - 0.4),
        min[1] + 0.03,
        min[2] + 0.05 + rand() * (depth - 0.1),
      );
      const n = g.getAttribute('position').count;
      const shade = 0.8 + rand() * 0.25;
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(shade), 3));
      parts.push(g);
    }
    put(new THREE.Mesh(merged(parts), rubble), 'area1-wall', 'surface');
  }
  yield;

  // ---- the pedestal (brass stem, milky cup), the slope's shut gate, the lamps toward the next room ----------------------
  {
    const [bx, by, bz] = ROOM1_PEDESTAL.base;
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
    const cup = new THREE.Mesh(
      keep(new THREE.SphereGeometry(0.12, 32, 12, 0, Math.PI * 2, Math.PI * 0.56, Math.PI * 0.44)),
      cupMilk,
    );
    cup.position.set(bx, ROOM1_PEDESTAL.orb[1] - 0.02, bz);
    put(cup, 'area1-pedestal-cup');

    // the shut gate across the slope: posts, an arch, bars, a crossbar (as the central plaza's shut gates)
    const hw = AREA1_GATE.halfWidth;
    const gy = area1SlopeHeight(AREA1_GATE.z);
    const springs = AREA1_GATE.height - hw * 0.6;
    const gz = AREA1_GATE.z;
    for (const x of [-hw, hw])
      brassParts.push(
        new THREE.CylinderGeometry(0.07, 0.085, springs, 12).translate(
          AREA1_SLOPE.x + x,
          gy + springs / 2,
          gz,
        ),
      );
    const arch = new THREE.TorusGeometry(hw, 0.06, 10, 64, Math.PI);
    arch.scale(1, 0.6, 1);
    arch.translate(AREA1_SLOPE.x, gy + springs, gz);
    brassParts.push(arch);
    for (let i = 1; i < 16; i++) {
      const x = -hw + (2 * hw * i) / 16;
      const h = springs + 0.6 * Math.sqrt(Math.max(0, hw * hw - x * x)) - 0.05;
      brassParts.push(
        new THREE.CylinderGeometry(0.016, 0.016, h, 6).translate(AREA1_SLOPE.x + x, gy + h / 2, gz),
      );
    }
    for (const y of [0.15, 1.15])
      brassParts.push(
        new THREE.CylinderGeometry(0.022, 0.022, 2 * hw, 8)
          .rotateZ(Math.PI / 2)
          .translate(AREA1_SLOPE.x, gy + y, gz),
      );
    brassParts.push(
      new THREE.LatheGeometry(
        [
          [0.0, 0],
          [0.04, 0],
          [0.06, 0.035],
          [0.09, 0.08],
          [0.085, 0.085],
        ].map(([x = 0, y = 0]) => new THREE.Vector2(x, y)),
        24,
      ).translate(AREA1_SLOPE.x, gy + AREA1_GATE.height + 0.04, gz),
    );

    // the lamps toward the next room: wall brackets on the houses, the last the gate's keystone
    NEXT_LAMPS.forEach((p, i) => {
      const g = new THREE.SphereGeometry(i === NEXT_LAMPS.length - 1 ? 0.1 : 0.17, 24, 12).translate(
        p[0],
        p[1],
        p[2],
      );
      const count = g.getAttribute('position').count;
      g.setAttribute('lamp', new THREE.Float32BufferAttribute(new Float32Array(count).fill(i), 1));
      nextGlobes.push(g);
      if (i < NEXT_LAMPS.length - 1) {
        brassParts.push(
          new THREE.TorusGeometry(0.1, 0.012, 6, 24).rotateX(Math.PI / 2).translate(p[0], p[1] - 0.12, p[2]),
        );
        brassParts.push(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 6).translate(p[0], p[1] - 0.4, p[2]));
      }
    });
  }
  put(new THREE.Mesh(merged(brassParts), brass), 'area1-brass');
  put(new THREE.Mesh(merged(globes), lampMilk), 'area1-lamps');
  put(new THREE.Mesh(merged(nextGlobes), nextMilk), 'area1-next-lamps');
  yield;

  // ---- 部屋1's light drop (裏の層): the prologue's shape and glass, its own bright core, and a halo of its light — in the
  // morning's grey the drop alone reads as a dull bead (S-36 review 1 P1-2); its light is what shows through the vidro
  const drop = new THREE.Group();
  {
    const coreMat = keep(new THREE.MeshBasicNodeMaterial());
    coreMat.colorNode = vec4(vec3(2.4, 1.9, 1.25).mul(focus.drop.mul(0.5).add(1)), 1);
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
        pow(facing, DROP_HALO.falloff).mul(DROP_HALO.strength).mul(focus.drop.mul(0.3).add(1)),
      ),
      1,
    );
    haloMat.opacityNode = smoothstep(0.4, 1.2, positionView.length());
    const halo = new THREE.Mesh(keep(new THREE.SphereGeometry(DROP_HALO.radius, 24, 16)), haloMat);
    halo.name = 'area1-drop-halo';
    halo.renderOrder = 6;
    drop.add(halo);
    drop.position.set(...ROOM1_DROP.at);
    put(drop, 'area1-drop', 'back');
  }

  // ---- motes: on the way to the room, then on to the next; a faint glimmer of the back layer beyond the gate ------------
  const moteMat = keep(
    new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  moteMat.colorNode = vec4(1.1, 0.8, 0.46, 1);
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
  // where they drift, from the road's end to beyond the gate (written once: the vertices move, the sphere stays)
  moteGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(eastX(110), AREA1_Y + 2, -128), 22);
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
    };
  });
  /** A point (x, z) of a quadratic curve, `u` 0..1 along it, written into `out` (every frame, for every mote). */
  const quad = (
    path: readonly (readonly [number, number])[],
    u: number,
    out: [number, number],
  ): [number, number] => {
    const [a, b, c] = path as [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
    ];
    const v = 1 - u;
    out[0] = v * v * a[0] + 2 * v * u * b[0] + u * u * c[0];
    out[1] = v * v * a[1] + 2 * v * u * b[1] + u * u * c[1];
    return out;
  };
  const toRoom: [number, number] = [0, 0];
  const toNextAt: [number, number] = [0, 0];
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
      BEYOND_GATE_Z,
      AREA1_SLOPE.x + hw,
      // up to where its drawn stone ends past the gate, and the glimmers over it
      Math.max(area1SlopeHeight(AREA1_GATE.z) + AREA1_GATE.height, area1SlopeHeight(BEYOND_GATE_Z)) + 3,
      AREA1_SLOPE.fromZ,
    );
    for (const h of AREA1_HOUSES)
      box(
        h.minX,
        AREA1_Y - 6,
        h.minZ,
        h.maxX,
        AREA1_Y + h.height + Math.min(h.maxX - h.minX, h.maxZ - h.minZ) / 2,
        h.maxZ,
      );
  }

  return {
    root,
    warm,
    bounds,
    drop,
    focus,
    setNext(lit) {
      nextLit.value = Math.max(0, Math.min(NEXT_LAMPS.length, lit));
    },
    animate(t, toNext) {
      for (let i = 0; i < MOTES + GLIMMERS; i++) {
        const s = seeds[i];
        if (!s) continue;
        const u = (s.phase + t * s.speed) % 1;
        const fade = Math.sin(Math.PI * u);
        if (i < MOTES) {
          // along the way to the room, turning to the way on as the next lamps light
          const [ax, az] = quad(MOTES_TO_ROOM, u, toRoom);
          const [bx, bz] = quad(MOTES_TO_NEXT, u, toNextAt);
          const x = ax + (bx - ax) * toNext + 0.25 * Math.sin(t * 0.6 + s.wobble);
          const z = az + (bz - az) * toNext + s.side * 0.4;
          const y = Math.max(AREA1_Y, area1SlopeHeight(z)) + s.y + 0.2 * Math.sin(t * 0.8 + s.wobble * 2);
          pos.set(x, y, z);
          placeMote(i, 0.3 + 0.9 * fade);
        } else {
          // beyond the gate: a slow glimmer drifting up the slope (行き止まりの理由: 裏の層の気配)
          const z = AREA1_GATE.z - 1 - u * 7;
          pos.set(
            AREA1_SLOPE.x + s.side * 0.6 + 0.2 * Math.sin(t * 0.5 + s.wobble),
            area1SlopeHeight(z) + 0.5 + s.y * 0.8,
            z,
          );
          placeMote(i, (0.6 + 1.2 * fade) * (0.7 + 0.3 * Math.sin(t * 1.3 + s.wobble)));
        }
      }
      motePosition.needsUpdate = true;
    },
    dispose() {
      root.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}
