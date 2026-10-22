import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  dot,
  float,
  floor,
  fog,
  fract,
  hash,
  max,
  min,
  mix,
  normalView,
  normalWorld,
  positionView,
  positionViewDirection,
  positionWorld,
  positionWorldDirection,
  pow,
  rangeFogFactor,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import {
  createBrassMaterial,
  createFrostedFloorMaterial,
  createGlass,
  createInnerBubbleMaterial,
  type HazeSpec,
  innerBubbleMesh,
  scatterInnerBubbles,
} from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import type { LayerField } from '../../layers/field';
import type { Box } from '../../layers/footing';
import type { LayerKind } from '../../layers/layers';
import { HAND_ORB_RADIUS } from '../orb/hand-pose';
import type { MeshData } from '../player/walk-lab-field';
import {
  BENCH_ORB,
  BRIDGE,
  DROP,
  deckHeight,
  EDGE_Z,
  FAR,
  FOOTING_SEGMENT,
  FURNACE_FACING,
  FURNACE_MOUTH,
  GATE,
  LAMP_HEIGHT,
  LAMP_POST_RADIUS,
  LAMPS,
  LIGHTHOUSE,
  PATH,
  PEDESTAL_BASE,
  PEDESTAL_ORB,
  WORKSHOP,
  WORKSHOP_FLOOR_RADIUS,
  WORKSHOP_TOP,
} from './layout';
import { deckMesh, domePoint, domeWall } from './shapes';

/**
 * The look of 序章「工房」 (アートディレクション): 夜明け前の青, almost colourless glass with the green of
 * its edges and dull brass, warm light only from the furnace, the lamps and the back layer (光があった頃の
 * 街の名残). Built from code for M0; the workshop's interior is Blender's since S-24 (room.ts loads its glb and this
 * file only lights it); the rest moves to Blender as the areas are modelled.
 *
 * Every object goes through LayerField.assign (surface / back / shared), which keeps transmissive glass
 * out of the smaller peek image and pins the shadow camera to the normal view (AGENTS.md).
 * Walkable surfaces are never transparent (空間の可読性と導線 1).
 */
export interface RoomArt {
  scene: THREE.Scene;
  environment: THREE.Texture;
  /** World direction toward the dawn light (for the hand orb's highlight). */
  sunDirection: THREE.Vector3;
  /** The vidro when it is not in the hand: on the workbench or on the pedestal. */
  orb: THREE.Object3D;
  /** Warm flash of the vidro (refusal, the drop arriving), linear. */
  orbGlow: FloatUniform;
  /**
   * 調べられる物に近づくと縁が淡く光る (UI/UX設計 > 画面ごとの設計 > ゲーム中): 0..1 per thing you can act on,
   * eased by the room (0.2 s).
   */
  focus: { orb: FloatUniform; pedestal: FloatUniform; drop: FloatUniform };
  /** Light of the placed vidro. */
  orbLight: THREE.PointLight;
  /** The light drop (back layer). */
  drop: THREE.Object3D;
  /** Fog distances, moved out while the camera is far away (the miniature in the home orb). */
  fogRange: { near: FloatUniform; far: FloatUniform };
  /** Ambient motion: light motes over the gap, the lamps, the furnace. */
  animate(t: number): void;
  dispose(): void;
}

/** A float uniform node (only its value is touched from outside). */
export interface FloatUniform {
  value: number;
}

/** 夜明け前の青: the sky (アートディレクション > 光と時間帯). */
const ZENITH = new THREE.Color(0.014, 0.03, 0.09);
const HORIZON_COOL = new THREE.Color(0.21, 0.28, 0.41);
const HORIZON_WARM = new THREE.Color(0.98, 0.6, 0.38);
/** The sea of mist in the valley, close by; far away it pales into the horizon. */
const MIST_DEEP = new THREE.Color(0.1, 0.14, 0.24);
/** Where the sun is about to rise: low, ahead and to the right of the way. */
const DAWN = new THREE.Vector3(0.78, 0, -0.62).normalize();
/** 奥ほど霞ませる (空間の可読性と導線 8): the fog in the colour of the cool horizon. 仮 distances. */
const FOG_NEAR = 18;
const FOG_FAR = 150;
/** Far glass haze (S-01 cheap path), long enough that the town still reads from the home orb's view. */
const TOWN_HAZE: HazeSpec = { color: HORIZON_COOL, near: 35, far: 240 };
/**
 * The workshop's lights (S-24, 仮 values for the designer's eye). 光と時間帯: 夜明け前の青 through the skylight onto the
 * vidro; the furnace is the only warm light (the lamp over the bench is gone), flickering a little like a fire.
 * S-27: the fire's light is a deeper orange, weaker, and stands out over the grate (FIRE_REACH past the mouth) — at the
 * mouth (S-24: 9, 0xff8a3c, 0.38 m out) it lit the inside of the brass collar and the floor to a cream glow
 * (画面の仕上げ: ブルームは控えめに; the fire deep in the mouth is the light source that blooms).
 */
const SKYLIGHT_COLOR = new THREE.Color(0.52, 0.66, 1.0);
const SKYLIGHT_INTENSITY = 26;
const SKYLIGHT_ANGLE = 0.13;
const FIRE_COLOR = 0xff6a2a;
const FIRE_INTENSITY = 5;
/** How far in front of the fire (FURNACE_MOUTH, toward the room) its light stands, and how much higher. */
const FIRE_REACH = 0.6;
const FIRE_LIFT = 0.08;
/** How much the fire's light breathes (± of its intensity). */
const FIRE_FLICKER = 0.08;
/** The valley floor, far below the mist. */
const VALLEY_Y = -32;
/** The mist rises to just below the walkable tops. */
const MIST_FROM = -1.5;
const MIST_TO = 0.0;

const c3 = (c: THREE.Color) => vec3(c.r, c.g, c.b);

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

/** 石畳 on top, darker rock on the sides, so every lip reads sharply against the valley. */
function stoneMaterial(tile: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0 });
  const p = positionWorld.xz.div(tile);
  // running bond: every other row shifts by half a stone
  const row = floor(p.y);
  const q = vec2(p.x.add(row.mul(0.5)), p.y);
  const cell = fract(q);
  const edge = min(min(cell.x, float(1).sub(cell.x)), min(cell.y, float(1).sub(cell.y)));
  const grout = smoothstep(0.0, 0.05, edge);
  const n = hash(floor(q).dot(vec2(1, 57)));
  const stone = vec3(0.47, 0.5, 0.55).mul(n.mul(0.16).add(0.84));
  const top = mix(vec3(0.21, 0.23, 0.27), stone, grout);
  // rock faces: layered, streaked downwards, dark against the mist
  const layer = hash(floor(positionWorld.y.mul(2.2)));
  const streak = hash(floor(positionWorld.x.add(positionWorld.z).mul(3.0)));
  const side = vec3(0.11, 0.13, 0.18).mul(layer.mul(0.18).add(streak.mul(0.1)).add(0.82));
  m.colorNode = vec4(mix(side, top, smoothstep(0.45, 0.75, normalWorld.y)), 1);
  return m;
}

function meshDataGeometry(data: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** A strip along z between two edges given as (x, y) per z (the bridge's glass panels). */
function ribbon(
  z0: number,
  z1: number,
  steps: number,
  a: (z: number) => [number, number],
  b: (z: number) => [number, number],
  normal: [number, number, number],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const z = z0 + ((z1 - z0) * i) / steps;
    const [ax, ay] = a(z);
    const [bx, by] = b(z);
    positions.push(ax, ay, z, bx, by, z);
    normals.push(...normal, ...normal);
    uvs.push(0, i / steps, 1, i / steps);
    if (i < steps) {
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

/** The back-layer bridge deck: frosted, a faint thin-film sheen, joints glowing every footing segment. */
function deckMaterial(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({
    color: 0xe4ecf2,
    roughness: 0.46,
    metalness: 0,
    iridescence: 1,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [180, 520],
  });
  const joint = float(1).sub(
    smoothstep(
      0.0,
      0.03,
      abs(fract(positionWorld.z.div(FOOTING_SEGMENT)).sub(0.5))
        .sub(0.5)
        .abs(),
    ),
  );
  m.colorNode = vec4(mix(vec3(0.7, 0.75, 0.8), vec3(0.74, 0.62, 0.44), joint), 1);
  m.emissiveNode = vec3(0.95, 0.74, 0.46).mul(joint.mul(0.5).add(0.04));
  return m;
}

export function buildRoomArt(
  renderer: THREE.WebGPURenderer,
  quality: QualityPreset,
  field: LayerField,
  options: { trialWall?: Box } = {},
): RoomArt {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const put = (o: THREE.Object3D, kind: LayerKind, opts?: { inPeek?: boolean }): THREE.Object3D => {
    field.assign(o, kind, opts);
    scene.add(o);
    return o;
  };
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh => new THREE.Mesh(keep(g), m);
  const instanced: THREE.InstancedMesh[] = [];
  const merged = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!g) throw new Error('mergeGeometries failed');
    return keep(g);
  };

  // ---- sky, fog, environment -------------------------------------------------------------
  const dirY = positionWorldDirection.y;
  const flat = positionWorldDirection.mul(vec3(1, 0, 1)).normalize();
  const towardDawn = pow(dot(flat, vec3(DAWN.x, 0, DAWN.z)).max(0), 5);
  const horizon = mix(
    c3(HORIZON_COOL),
    c3(HORIZON_WARM),
    towardDawn.mul(float(1).sub(smoothstep(0, 0.28, dirY))),
  );
  // below the horizon the sky is the far mist (no hard line where the mist sea meets the sky)
  const sky = mix(
    mix(horizon, c3(ZENITH), smoothstep(0.0, 0.62, dirY)),
    horizon.mul(0.86),
    float(1).sub(smoothstep(-0.12, 0.0, dirY)),
  );
  scene.backgroundNode = sky;
  const fogNear = uniform(FOG_NEAR);
  const fogFar = uniform(FOG_FAR);
  // the valley fills with mist: everything below the way sinks into a deeper blue, so the gap reads as depth;
  // far away the mist pales into the horizon (空間の可読性と導線 8: 奥ほど霞ませる)
  const mist = float(1)
    .sub(smoothstep(MIST_FROM, MIST_TO, positionWorld.y))
    .mul(0.97);
  const mistColor = mix(c3(MIST_DEEP), horizon.mul(0.86), rangeFogFactor(fogNear.mul(0.7), fogFar.mul(1.1)));
  scene.fogNode = fog(mix(horizon.mul(0.92), mistColor, mist), max(rangeFogFactor(fogNear, fogFar), mist));

  // reflections: the same sky, the dawn glow and a dark band of the town around the horizon, so the edges
  // of the glass have something to mirror (S-01: ガラスの縁は、映る物がないと読めない)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  envSky.colorNode = vec4(sky, 1);
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), envSky));
  const envBand = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0.05, 0.07, 0.12),
    side: THREE.BackSide,
  });
  const band = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 6, 48, 1, true), envBand);
  band.position.y = 1;
  envScene.add(band);
  const envGlow = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(5, 3.6, 2.4) });
  const glowBall = new THREE.Mesh(new THREE.SphereGeometry(3.5, 16, 8), envGlow);
  glowBall.position.copy(DAWN).multiplyScalar(38).setY(4);
  envScene.add(glowBall);
  const envTarget = keep(pmrem.fromScene(envScene, 0.02));
  for (const o of envScene.children) if (o instanceof THREE.Mesh) o.geometry.dispose();
  envSky.dispose();
  envBand.dispose();
  envGlow.dispose();
  pmrem.dispose();
  scene.environment = envTarget.texture;

  // ---- lights (one dawn light + the sky; the skylight and the furnace below, the placed orb) ------------
  const hemi = new THREE.HemisphereLight(0x7890c0, 0x181c28, 0.8);
  put(hemi, 'shared');
  const sun = new THREE.DirectionalLight(0xffbd86, 2.5);
  sun.position
    .copy(DAWN)
    .multiplyScalar(30)
    .setY(7)
    .add(new THREE.Vector3(0, 0, -8));
  sun.target.position.set(0, 0, -8);
  scene.add(sun.target);
  {
    // 静止した光と影は焼き込み (光と時間帯): until the Blender bake exists, the static room's shadow map is
    // drawn once (like S-01's gallery). Nothing that moves casts a live shadow here (the vidro, the drop and
    // the materializing bridge are small or come and go), and a shadow map drawn every frame is a render
    // nested inside the main one, which trips three r186's WebGL2 timestamp pool (process/slices/S-06.md).
    // Drawn once, with the layer state of that moment: only shared objects may cast (no sphere exists
    // yet, so back objects would cast nothing and surface objects would keep casting after they vanish).
    const size = quality.dynamicShadowSize || 1024;
    sun.castShadow = true;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    sun.shadow.mapSize.set(size, size);
    const cam = sun.shadow.camera;
    cam.left = -15;
    cam.right = 15;
    cam.top = 15;
    cam.bottom = -15;
    cam.near = 1;
    cam.far = 70;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 1;
  }
  put(keep(sun), 'shared');
  const sunDirection = sun.position.clone().sub(sun.target.position).normalize();

  // ---- materials -----------------------------------------------------------------------------
  const brass = keep(createBrassMaterial());
  const stone = keep(stoneMaterial(0.62));
  const rock = keep(stoneMaterial(1.4));
  const frostFloor = keep(createFrostedFloorMaterial({ tileSize: 0.9, frostColor: 0xa7b1bc }));
  const dark = keep(new THREE.MeshStandardNodeMaterial({ color: 0x1b2433, roughness: 1, metalness: 0 }));
  const glass = (
    kind: Parameters<typeof createGlass>[0],
    opts: Parameters<typeof createGlass>[2],
  ): THREE.Material => keep(createGlass(kind, quality, opts).material);
  // the dome stands behind the bench glass from where you stand: cheap on every preset (ガラスの描画 > 対策1)
  const domeGlass = glass('clear', { placement: 'behind-glass', haze: TOWN_HAZE, thickness: 0.05 });
  domeGlass.side = THREE.DoubleSide;
  const shardGlass = glass('clear', { placement: 'behind-glass', haze: TOWN_HAZE, thickness: 0.03 });
  const townGlass = glass('clear', { placement: 'far', haze: TOWN_HAZE, thickness: 0.06 });
  const panelGlass = glass('clear', { placement: 'near', thickness: 0.03 });
  const lampMilk = glass('milky', { glow: { color: 0xffbf80, intensity: 1.5 } });
  const cupMilk = glass('milky', { glow: { color: 0xffd2a0, intensity: 1.1 } });
  const focus = { orb: uniform(0), pedestal: uniform(0), drop: uniform(0) };
  // a soft warm rim, strongest edge-on, for whatever can be acted on right now
  const rimLight = (strength: typeof focus.orb) =>
    vec3(1.0, 0.82, 0.58).mul(
      pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 2.5).mul(strength),
    );
  const cupNode = cupMilk as THREE.MeshPhysicalNodeMaterial;
  cupNode.emissiveNode = (cupNode.emissiveNode as THREE.Node<'vec3'>).add(rimLight(focus.pedestal).mul(1.6));
  const lanternMilk = glass('milky', { glow: { color: 0xffb46a, intensity: 1.2 } });
  const fire = new THREE.PointLight(FIRE_COLOR, FIRE_INTENSITY, 7, 2);

  // ---- the workshop (序章「工房」) ---------------------------------------------------------------
  {
    const floorDisc = mesh(
      new THREE.CylinderGeometry(WORKSHOP_FLOOR_RADIUS + 0.05, WORKSHOP_FLOOR_RADIUS + 0.05, 0.2, 72),
      frostFloor,
    );
    floorDisc.position.y = -0.096;
    floorDisc.receiveShadow = true;
    put(floorDisc, 'shared');
    const plinth = mesh(new THREE.CylinderGeometry(5.0, 6.2, 7, 64), rock);
    plinth.position.y = -3.504;
    put(plinth, 'shared');

    const wall = domeWall();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(wall.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(wall.normals, 3));
    g.setIndex(new THREE.BufferAttribute(wall.indices, 1));
    const dome = mesh(g, domeGlass);
    dome.renderOrder = 2;
    put(dome, 'shared');

    // brass ribs on meridians (clear of the door), the skylight ring, the foot ring and the door frame
    const ribs: THREE.BufferGeometry[] = [];
    const { oculus, doorTop, floor: thetaFloor } = wall.theta;
    const [doorA, doorB] = wall.doorPhi;
    const tube = (pts: THREE.Vector3[], r: number) =>
      ribs.push(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(8, pts.length * 2), r, 6, false),
      );
    const meridian = (phi: number, from: number, to: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 20; i++)
        pts.push(new THREE.Vector3(...domePoint(from + ((to - from) * i) / 20, phi, 0.02)));
      tube(pts, 0.035);
    };
    // 12 meridians clear of the door: the glass itself is faint, the brass gives the dome its shape (ルール2)
    for (let i = 0; i < 12; i++) {
      const phi = -Math.PI / 2 + Math.PI / 12 + (i * Math.PI) / 6;
      meridian(phi, oculus, thetaFloor);
    }
    meridian(doorA, doorTop, thetaFloor);
    meridian(doorB, doorTop, thetaFloor);
    const parallel = (theta: number, from: number, to: number, r: number) => {
      const pts: THREE.Vector3[] = [];
      const n = Math.max(6, Math.ceil(((to - from) / (2 * Math.PI)) * 96));
      for (let i = 0; i <= n; i++)
        pts.push(new THREE.Vector3(...domePoint(theta, from + ((to - from) * i) / n, 0.02)));
      tube(pts, r);
    };
    parallel(doorTop, doorA, doorB, 0.04);
    const ringAt = (theta: number, r: number) => {
      const rr = Math.sin(theta) * WORKSHOP.radius;
      const ring = new THREE.TorusGeometry(rr, r, 8, 128);
      ring.rotateX(Math.PI / 2);
      ring.translate(0, WORKSHOP.sphereCenterY + Math.cos(theta) * WORKSHOP.radius, 0);
      ribs.push(ring);
    };
    ringAt(oculus, 0.05);
    ringAt(thetaFloor - 0.004, 0.06);
    ringAt((oculus + doorTop) / 2, 0.022);
    const frame = mesh(merged(ribs), brass);
    frame.castShadow = true;
    put(frame, 'shared');

    // The interior (the bench, its vessels, the furnace, the shelf…) is the workshop's glb (S-24, room.ts loads it).
    // Here only its lights, which the game places (the glb carries no lights):
    //  - 光と時間帯 夜明け前の青: the cool light of the sky through the skylight, falling on the vidro on the bench (the
    //    first picture: 目覚めて最初に見る絵)
    //  - the furnace, the only warm light of the workshop: at its mouth, toward the room and the grate
    const sky = new THREE.SpotLight(SKYLIGHT_COLOR, SKYLIGHT_INTENSITY, 0, SKYLIGHT_ANGLE, 0.75, 1.4);
    sky.position.set(0, WORKSHOP_TOP - 0.2, 0);
    sky.target.position.set(...BENCH_ORB);
    // A shadow drawn once like the sun's, so the bench top keeps the light off its lower shelf (the vidro casts none: it
    // is taken away). A stand-in until the bake (光と時間帯: 静止した光と影は焼き込み; S-26). A cutoff distance was tried
    // instead and dropped: its falloff turned the round pool into a lopsided one (review round 2 of S-24).
    sky.castShadow = true;
    sky.shadow.autoUpdate = false;
    sky.shadow.needsUpdate = true;
    sky.shadow.mapSize.set(512, 512);
    sky.shadow.camera.near = 0.5;
    sky.shadow.camera.far = 6;
    sky.shadow.bias = -0.0005;
    sky.shadow.normalBias = 0.02;
    scene.add(sky.target);
    put(keep(sky), 'shared');
    fire.position.set(
      FURNACE_MOUTH[0] + FURNACE_FACING[0] * FIRE_REACH,
      FURNACE_MOUTH[1] + FIRE_LIFT,
      FURNACE_MOUTH[2] + FURNACE_FACING[1] * FIRE_REACH,
    );
    put(keep(fire), 'shared');
  }

  // ---- the way, the broken edge, the far shore, the gate -------------------------------------------
  {
    const slab = (
      minX: number,
      maxX: number,
      minZ: number,
      maxZ: number,
      depth: number,
      m: THREE.Material,
    ) => {
      const s = mesh(new RoundedBoxGeometry(maxX - minX, depth, maxZ - minZ, 3, 0.05), m);
      s.position.set((minX + maxX) / 2, -depth / 2, (minZ + maxZ) / 2);
      s.receiveShadow = true;
      return s;
    };
    put(slab(PATH.minX, PATH.maxX, PATH.minZ, PATH.maxZ, 7, stone), 'shared');
    put(slab(FAR.minX, FAR.maxX, FAR.minZ, FAR.maxZ, 7, stone), 'shared');
    // beyond the gate the way goes on toward the town (seen, not walked: the gate is closed)
    put(slab(FAR.minX, FAR.maxX, -46, FAR.minZ - 0.02, 7, stone), 'shared');
    const valley = mesh(new THREE.PlaneGeometry(600, 600), dark);
    valley.rotation.x = -Math.PI / 2;
    valley.position.y = VALLEY_Y;
    put(valley, 'shared');

    // brass lips along every edge you can walk to (形は縁で伝える)
    const lips: THREE.BufferGeometry[] = [];
    const lipZ = (x: number, z0: number, z1: number) =>
      lips.push(
        new THREE.CylinderGeometry(0.018, 0.018, z0 - z1, 6)
          .rotateX(Math.PI / 2)
          .translate(x, 0.0, (z0 + z1) / 2),
      );
    const lipX = (z: number, x0: number, x1: number) =>
      lips.push(
        new THREE.CylinderGeometry(0.018, 0.018, x1 - x0, 6)
          .rotateZ(Math.PI / 2)
          .translate((x0 + x1) / 2, 0.0, z),
      );
    lipZ(PATH.minX - 0.01, -4.6, PATH.minZ);
    lipZ(PATH.maxX + 0.01, -4.6, PATH.minZ);
    lipZ(FAR.minX - 0.01, FAR.maxZ, -40);
    lipZ(FAR.maxX + 0.01, FAR.maxZ, -40);
    lipX(FAR.maxZ + 0.01, FAR.minX, FAR.maxX);
    put(mesh(merged(lips), brass), 'shared');

    // 街灯: milky globes on thin brass posts
    const posts: THREE.BufferGeometry[] = [];
    const globes: THREE.BufferGeometry[] = [];
    for (const l of LAMPS) {
      posts.push(
        new THREE.CylinderGeometry(LAMP_POST_RADIUS, LAMP_POST_RADIUS * 1.5, LAMP_HEIGHT, 8).translate(
          l.x,
          LAMP_HEIGHT / 2,
          l.z,
        ),
      );
      posts.push(
        new THREE.TorusGeometry(0.11, 0.012, 6, 24)
          .rotateX(Math.PI / 2)
          .translate(l.x, LAMP_HEIGHT - 0.06, l.z),
      );
      globes.push(new THREE.SphereGeometry(0.12, 24, 12).translate(l.x, LAMP_HEIGHT + 0.04, l.z));
    }
    const postMesh = mesh(merged(posts), brass);
    postMesh.castShadow = true;
    put(postMesh, 'shared');
    put(mesh(merged(globes), lampMilk), 'shared');

    // the gate: brass arch and bars, closed; the town is seen through it
    const gate: THREE.BufferGeometry[] = [];
    const hw = GATE.halfWidth;
    const springs = GATE.height - hw * 0.6;
    for (const x of [-hw, hw])
      gate.push(new THREE.CylinderGeometry(0.06, 0.07, springs, 10).translate(x, springs / 2, GATE.z));
    const arch = new THREE.TorusGeometry(hw, 0.05, 10, 64, Math.PI);
    arch.scale(1, 0.6, 1);
    arch.translate(0, springs, GATE.z);
    gate.push(arch);
    for (let i = 1; i < 12; i++) {
      const x = -hw + (2 * hw * i) / 12;
      const h = springs + 0.6 * Math.sqrt(Math.max(0, hw * hw - x * x)) - 0.04;
      gate.push(new THREE.CylinderGeometry(0.014, 0.014, h, 6).translate(x, h / 2, GATE.z));
    }
    gate.push(
      new THREE.CylinderGeometry(0.02, 0.02, 2 * hw, 6).rotateZ(Math.PI / 2).translate(0, 1.05, GATE.z),
    );
    const gateMesh = mesh(merged(gate), brass);
    gateMesh.castShadow = true;
    put(gateMesh, 'shared');

    // the pedestal (台座): brass stem, a milky cup that glows a little (行き止まりには理由を置く)
    const stem = mesh(
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
      ),
      brass,
    );
    stem.position.set(PEDESTAL_BASE[0], 0, PEDESTAL_BASE[2]);
    stem.castShadow = true;
    put(stem, 'shared');
    const cup = mesh(
      new THREE.SphereGeometry(0.12, 32, 12, 0, Math.PI * 2, Math.PI * 0.56, Math.PI * 0.44),
      cupMilk,
    );
    cup.position.set(PEDESTAL_BASE[0], PEDESTAL_ORB[1] - 0.02, PEDESTAL_BASE[2]);
    put(cup, 'shared');

    // the broken edge (表にだけあるもの: 崩れた壁、割れた破片): low shards and fallen stones on the lip.
    // They stand where the bridge will be and melt away inside the sphere.
    const rand = rng(61);
    const shards: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) {
      const w = 0.16 + rand() * 0.2;
      const h = 0.12 + rand() * 0.26;
      const g = new RoundedBoxGeometry(w, h, 0.02, 1, 0.008);
      g.rotateY((rand() - 0.5) * 0.8);
      g.rotateZ((rand() - 0.5) * 0.5);
      g.translate(-0.7 + (i / 4) * 1.4 + (rand() - 0.5) * 0.12, h * 0.42, EDGE_Z + 0.04 - rand() * 0.08);
      shards.push(g);
    }
    // S-24's trial (?trial=surface-wall): a broken glass wall on the surface layer across the way onto the bridge
    const w = options.trialWall;
    if (w) {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const width = (w.max[0] - w.min[0]) / n;
        const h = (w.max[1] - w.min[1]) * (0.7 + 0.3 * rand());
        const g = new RoundedBoxGeometry(width * 0.92, h, w.max[2] - w.min[2], 2, 0.02);
        g.rotateZ((rand() - 0.5) * 0.12);
        g.translate(w.min[0] + width * (i + 0.5), w.min[1] + h / 2, (w.min[2] + w.max[2]) / 2);
        shards.push(g);
      }
    }
    const shardMesh = mesh(merged(shards), shardGlass);
    shardMesh.renderOrder = 3;
    put(shardMesh, 'surface');
    const rubble: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.DodecahedronGeometry(0.05 + rand() * 0.07, 0);
      g.scale(1, 0.5, 1);
      const side = i % 2 === 0 ? -1 : 1;
      g.translate(side * (0.9 + rand() * 0.35), 0.02, EDGE_Z + 0.06 - rand() * 0.16);
      rubble.push(g);
    }
    put(mesh(merged(rubble), rock), 'surface');
  }

  // ---- the back layer: the arched bridge, its rails, glass panels and lanterns, the light drop -------
  {
    const len = BRIDGE.max[2] - BRIDGE.min[2];
    const fromZ = BRIDGE.max[2] + 0.15;
    const toZ = BRIDGE.min[2] - 0.15;
    // swept from the same curve as its colliders (shapes.deckMesh, sampled more finely), 3 mm under the shores
    // where it overlaps them
    const deck = mesh(meshDataGeometry(deckMesh(fromZ, toZ, 48, 0.14, -0.003)), keep(deckMaterial()));
    deck.receiveShadow = true;
    put(deck, 'back');
    const along = (x: number, lift: number, n = 24): THREE.Vector3[] =>
      Array.from({ length: n + 1 }, (_, i) => {
        const z = fromZ + ((toZ - fromZ) * i) / n;
        return new THREE.Vector3(x, deckHeight(z) + lift, z);
      });
    const rails: THREE.BufferGeometry[] = [];
    for (const x of [BRIDGE.min[0] - 0.02, BRIDGE.max[0] + 0.02]) {
      rails.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(along(x, 0.88)), 48, 0.018, 8, false));
      for (let i = 0; i <= 4; i++) {
        const z = BRIDGE.max[2] - (len * i) / 4;
        rails.push(new THREE.CylinderGeometry(0.016, 0.02, 0.88, 8).translate(x, deckHeight(z) + 0.44, z));
      }
    }
    for (const z of [BRIDGE.max[2] - len * 0.25, BRIDGE.max[2] - len * 0.75]) {
      rails.push(
        new THREE.TorusGeometry(BRIDGE.max[0] + 0.02, 0.02, 8, 48, Math.PI).translate(
          0,
          deckHeight(z) + 0.88,
          z,
        ),
      );
    }
    put(mesh(merged(rails), brass), 'back');
    // 橋は透明ガラス (アートディレクション > ガラスの種類), but only as the balustrade: the deck you walk on is frosted
    panelGlass.side = THREE.DoubleSide;
    // one pass for both faces (three would draw a double-sided transparent material twice)
    panelGlass.forceSinglePass = true;
    const panels: THREE.BufferGeometry[] = [];
    for (const x of [BRIDGE.min[0] - 0.02, BRIDGE.max[0] + 0.02])
      panels.push(
        ribbon(
          BRIDGE.max[2] - 0.05,
          BRIDGE.min[2] + 0.05,
          32,
          (z) => [x, deckHeight(z) + 0.19],
          (z) => [x, deckHeight(z) + 0.81],
          [Math.sign(x), 0, 0],
        ),
      );
    put(mesh(merged(panels), panelGlass), 'back');
    const lanterns: THREE.BufferGeometry[] = [];
    for (const x of [BRIDGE.min[0] - 0.02, BRIDGE.max[0] + 0.02])
      for (const z of [BRIDGE.max[2], BRIDGE.min[2]])
        lanterns.push(new THREE.SphereGeometry(0.055, 20, 10).translate(x, 0.95, z));
    // the lanterns fade when they pass right by the eye (no big white ball on the screen)
    lanternMilk.transparent = true;
    (lanternMilk as THREE.MeshPhysicalNodeMaterial).opacityNode = smoothstep(
      0.35,
      1.2,
      positionView.length(),
    );
    put(mesh(merged(lanterns), lanternMilk), 'back');
  }
  // 行き止まりの理由: 裏の層の気配 (空間の可読性と導線 9, 光の揺らぎ). Faint, broken lines of light that drift
  // along where the bridge's handrails will be: from the dead end the outline of something spanning the gap,
  // never brighter than the gate. Surface layer: the real bridge replaces them inside the sphere, and the
  // peek image (the back layer) does not show them — through the orb the bridge itself is there.
  // (A flat veil at deck height was tried and dropped: from the dead end it lies below the view.)
  const ghostTime = uniform(0);
  {
    const ghostMat = keep(
      new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ghostMat.fog = false;
    // gaps between the glints (pow), no floor, and gone near the eye like the motes
    const flow = sin(uv().x.mul(30).sub(ghostTime.mul(2.2)))
      .mul(0.5)
      .add(0.5)
      .pow(3);
    const ends = smoothstep(0, 0.12, uv().x).mul(smoothstep(1, 0.88, uv().x));
    const near = smoothstep(0.8, 2.6, positionView.length());
    ghostMat.colorNode = vec4(vec3(1.0, 0.8, 0.52).mul(flow.mul(ends).mul(near).mul(0.3)), 1);
    const ghosts: THREE.BufferGeometry[] = [];
    for (const x of [BRIDGE.min[0] - 0.02, BRIDGE.max[0] + 0.02]) {
      const pts = Array.from({ length: 25 }, (_, i) => {
        const z = EDGE_Z - 0.05 + ((FAR.maxZ - EDGE_Z + 0.1) * i) / 24;
        return new THREE.Vector3(x, deckHeight(z) + 0.88, z);
      });
      ghosts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.008, 6, false));
    }
    const ghostRails = mesh(merged(ghosts), ghostMat);
    ghostRails.renderOrder = 4;
    put(ghostRails, 'surface');
  }
  // 光の雫 (虹色ガラス＋発光): a bright core inside an iridescent shell
  const drop = new THREE.Group();
  {
    const shape = (k: number) =>
      new THREE.LatheGeometry(
        Array.from({ length: 14 }, (_, i) => {
          const a = (i / 13) * Math.PI;
          return new THREE.Vector2(
            Math.sin(a) * 0.07 * k * (1 - 0.5 * (i / 13)),
            (-Math.cos(a) * 0.09 + (i / 13) * 0.06) * k,
          );
        }),
        28,
      );
    const coreMat = keep(new THREE.MeshBasicNodeMaterial());
    coreMat.colorNode = vec4(vec3(2.4, 1.9, 1.25).mul(focus.drop.mul(0.5).add(1)), 1);
    drop.add(mesh(shape(0.55), coreMat));
    drop.add(mesh(shape(1), glass('iridescent', { role: 'drop', placement: 'near', thickness: 0.06 })));
    drop.position.set(...DROP);
    put(drop, 'back');
  }

  // ---- the vidro (on the bench, later on the pedestal) ---------------------------------------
  const orb = new THREE.Group();
  const orbGlow = uniform(0);
  {
    const orbMat = createGlass('bubble', quality, {
      role: 'orb',
      placement: 'near',
      thickness: 0.15,
    }).material;
    keep(orbMat);
    orbMat.emissiveNode = vec3(1.0, 0.8, 0.52).mul(orbGlow).add(rimLight(focus.orb).mul(1.2));
    const ball = mesh(new THREE.SphereGeometry(HAND_ORB_RADIUS, 48, 32), orbMat);
    orb.add(ball);
    const bubbles = innerBubbleMesh(
      scatterInnerBubbles({
        seed: 7,
        count: 24,
        containerRadius: HAND_ORB_RADIUS * 0.92,
        sizeRange: [0.002, 0.009],
      }),
      keep(createInnerBubbleMaterial()),
    );
    keep(bubbles.geometry);
    orb.add(bubbles);
    orb.position.set(...BENCH_ORB);
    // transmission stays out of the smaller peek image (AGENTS.md); in hand it is the composite's orb instead
    put(orb, 'shared', { inPeek: false });
  }
  const orbLight = new THREE.PointLight(0xffcf8a, 0, 5, 2);
  orbLight.position.set(PEDESTAL_ORB[0], PEDESTAL_ORB[1] + 0.1, PEDESTAL_ORB[2]);
  put(orbLight, 'shared');

  // ---- the town and its lighthouse across the valley, rising out of the mist (遠景: cheap glass, 灯塔) -----
  {
    const rand = rng(20261021);
    const spheres: { p: THREE.Vector3; r: number }[] = [];
    const rings: THREE.BufferGeometry[] = [];
    const [lx, , lz] = LIGHTHOUSE;
    for (let k = 0; k < 34; k++) {
      const a = (k / 34) * Math.PI * 2 + rand() * 0.25;
      const rad = 9 + rand() * 32;
      const c = new THREE.Vector3(lx + Math.sin(a) * rad, 0, lz + Math.cos(a) * rad);
      const main = 2.4 + rand() * 3.4;
      const base = -2.5 + rand() * 2.0;
      spheres.push({ p: c.clone().setY(base + main * (0.35 + rand() * 0.3)), r: main });
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) {
        const r = main * (0.35 + rand() * 0.45);
        const o = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5)
          .normalize()
          .multiplyScalar(main * (0.55 + rand() * 0.4));
        spheres.push({
          p: c
            .clone()
            .add(o)
            .setY(base + r * (0.3 + rand() * 0.9) + (rand() < 0.3 ? main * 0.8 : 0)),
          r,
        });
      }
    }
    // 灯塔: stacked bubbles, brass bands, a brass spire and the great orb, broken (光が失われた理由: 大玉が割れ)
    const tower: [number, number][] = [
      [5.0, 1.0],
      [3.9, 7.0],
      [3.0, 11.8],
      [2.3, 15.6],
      [1.7, 18.6],
    ];
    for (const [r, y] of tower) {
      spheres.push({ p: new THREE.Vector3(lx, y, lz), r });
      rings.push(
        new THREE.TorusGeometry(r * 0.99, 0.07, 8, 72).rotateX(Math.PI / 2).translate(lx, y - r * 0.15, lz),
      );
    }
    // far → near from the way, so the transparent bubbles blend in order
    const from = new THREE.Vector3(0, 1.6, -14);
    spheres.sort((a, b) => b.p.distanceToSquared(from) - a.p.distanceToSquared(from));
    const town = new THREE.InstancedMesh(
      keep(new THREE.SphereGeometry(1, 28, 18)),
      townGlass,
      spheres.length,
    );
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    spheres.forEach((b, i) => {
      town.setMatrixAt(i, m4.compose(b.p, q, new THREE.Vector3(b.r, b.r, b.r)));
    });
    town.computeBoundingSphere();
    town.renderOrder = 1;
    instanced.push(town);
    put(town, 'shared');
    const spireY = 23;
    rings.push(new THREE.CylinderGeometry(0.16, 0.34, 6.4, 12).translate(lx, spireY - 1.4, lz));
    // a brass cage round the great orb, the orb itself cracked open
    for (let i = 0; i < 3; i++)
      rings.push(
        new THREE.TorusGeometry(3.15, 0.07, 8, 96)
          .rotateX(Math.PI / 2)
          .rotateZ((i * Math.PI) / 3 + 0.3)
          .translate(lx, spireY + 4.2, lz),
      );
    put(mesh(merged(rings), brass), 'shared');
    const great = mesh(
      new THREE.SphereGeometry(2.9, 48, 32, 0.4, Math.PI * 2 - 1.1, 0, Math.PI * 0.82),
      townGlass,
    );
    great.position.set(lx, spireY + 4.2, lz);
    great.rotation.z = 0.25;
    great.renderOrder = 1;
    put(great, 'shared');
  }

  // ---- light motes over the gap, drifting toward the far shore (光の粒の流れ, ルール7) ---------------
  // They hint at the back layer at the dead end (行き止まりの理由: 裏の層の気配) and fade near the eye.
  const MOTES = 28;
  const moteMat = keep(
    new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  moteMat.colorNode = vec4(1.3, 1.0, 0.62, 1);
  moteMat.opacityNode = smoothstep(0.8, 2.6, positionView.length());
  moteMat.fog = false;
  const motes = new THREE.InstancedMesh(keep(new THREE.IcosahedronGeometry(0.011, 0)), moteMat, MOTES);
  motes.frustumCulled = false;
  instanced.push(motes);
  // surface layer like the veil: a hint of the bridge that the bridge itself replaces
  put(motes, 'surface');
  const moteSeeds = Array.from({ length: MOTES }, (_, i) => {
    const r = rng(500 + i);
    return {
      x: (r() - 0.5) * 0.9,
      y: 0.12 + r() * 1.0,
      phase: r(),
      speed: 0.04 + r() * 0.05,
      wobble: r() * 6,
    };
  });
  const moteMatrix = new THREE.Matrix4();
  const motePos = new THREE.Vector3();
  const moteRot = new THREE.Quaternion();
  const moteScale = new THREE.Vector3();
  const span = EDGE_Z - FAR.maxZ + 1.2; // from just over the edge to the far shore

  return {
    scene,
    environment: envTarget.texture,
    sunDirection,
    orb,
    orbGlow,
    focus,
    orbLight,
    drop,
    fogRange: { near: fogNear, far: fogFar },
    animate(t) {
      ghostTime.value = t;
      // a fire breathes: a few slow, unrelated waves (no strobe)
      fire.intensity =
        FIRE_INTENSITY *
        (1 +
          FIRE_FLICKER *
            (0.5 * Math.sin(t * 2.3) + 0.3 * Math.sin(t * 5.9 + 1.3) + 0.2 * Math.sin(t * 11.7 + 0.4)));
      for (let i = 0; i < MOTES; i++) {
        const s = moteSeeds[i];
        if (!s) continue;
        const u = (s.phase + t * s.speed) % 1;
        const fade = Math.sin(Math.PI * u);
        motePos.set(
          s.x + 0.15 * Math.sin(t * 0.7 + s.wobble),
          s.y + 0.12 * Math.sin(t * 0.9 + s.wobble * 2),
          EDGE_Z + 0.2 - u * span,
        );
        motePos.y += deckHeight(motePos.z);
        moteScale.setScalar(0.4 + 0.9 * fade);
        motes.setMatrixAt(i, moteMatrix.compose(motePos, moteRot, moteScale));
      }
      motes.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const m of instanced) m.dispose();
    },
  };
}
