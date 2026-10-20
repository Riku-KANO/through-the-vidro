import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  densityFogFactor,
  dot,
  float,
  floor,
  fog,
  fract,
  min,
  mix,
  normalView,
  normalWorld,
  pmremTexture,
  positionViewDirection,
  positionWorld,
  positionWorldDirection,
  pow,
  reflectVector,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { SceneFactory } from '../core/scene';
import { HAND_ORB_RADIUS, handOrbCenter, orbScreenCircle } from '../game/orb/hand-pose';
import {
  createOrbs,
  type Orb,
  type OrbSphere,
  orbSpheres,
  placeOn,
  stepOrbs,
  takeBack,
} from '../game/orb/orbs';
import {
  PEEK_SECONDS,
  type PeekState,
  peekAmount,
  peekFovOffset,
  peekMoveSpeedMultiplier,
  stepPeek,
} from '../game/orb/peek';
import { PeekPipeline } from '../game/orb/peek-pipeline';
import { canPeek, canPickUp, canPlace } from '../game/orb/rules';
import { LayerField } from '../layers/field';
import {
  activeSegmentIds,
  type FootingSegment,
  segmentsUnder,
  splitFooting,
  type Vec3,
} from '../layers/footing';
import { boundaryGlow } from '../layers/materialize';
import { glassEase, stepTween, type Tween } from '../layers/tween';

export const title = 'S-02 layers: peek through the hand orb, place it to materialize the back-layer bridge';

/** 操作とカメラ > カメラ: 目の高さ1.6m、視野角70度、歩行1.4m/s. */
const EYE_HEIGHT = 1.6;
const BASE_FOV = 70;
const WALK_SPEED = 1.4;
/** 加速と減速に短い慣性. */
const INERTIA_SECONDS = 0.12;
/** 足場の縁ではやわらかく止まる: keep the feet this far from an edge. */
const EDGE_MARGIN = 0.3;
/** 仮: interaction reach is not in the design doc (decide in S-06). */
const REACH = 2.5;
/** 仮: how long the hand takes to bring the orb back into view after a pickup. */
const HAND_SECONDS = PEEK_SECONDS;
/** 仮: 玉が小さく震えて知らせる. */
const SHAKE_SECONDS = 0.45;
const LOOK_SPEED = 1.4;
const START_X = -2.0;

// Room layout (metres): the near ledge ends at x = 0, the gap runs to x = 2.8, the far ledge beyond.
const NEAR_LEDGE: [number, number] = [-6.8, 0];
const FAR_LEDGE: [number, number] = [2.8, 8.8];
const BRIDGE_BOX = { min: [0, -0.14, -0.6] as Vec3, max: [2.8, 0, 0.6] as Vec3 };
/** The pedestal stands at the edge; the orb sits at this point when placed. */
const PEDESTAL_ID = 'edge';
const PEDESTAL_ORB: Vec3 = [-0.5, 1.05, -0.9];

interface DemoScript {
  end: number;
  peek: [number, number][];
  walk: [number, number, number][];
  interact: number[];
  look: [number, number, number][];
  marks: Record<string, number>;
}

/** ?demo=1: 行き止まりを見る → 覗く → 台座に置く → 渡る → 橋の上で拾えない → 戻って拾う. */
const DEMO: DemoScript = {
  end: 12.6,
  peek: [[0.6, 2.8]],
  walk: [
    [5.4, 7.8, 1],
    [8.6, 10.4, -1],
  ],
  interact: [3.6, 8.1, 10.9],
  look: [
    [0, 6, -5],
    [0.6, 6, -7],
    [1.4, 3, -10],
    [2.8, -5, -9],
    [3.1, 24, -16],
    [3.6, 26, -17],
    [4.3, 26, -15],
    [5.0, 3, -6],
    [5.4, 0, -6],
    [7.8, 2, -8],
    [8.3, 12, -10],
    [8.6, 4, -7],
    [10.4, 4, -7],
    [10.8, 34, -14],
    [12.6, 34, -12],
  ],
  marks: {
    'dead-end': 0.5,
    'peek-mid': 0.72,
    'peek-full': 1.7,
    'grow-start': 3.74,
    'grow-mid': 3.82,
    materialized: 5.3,
    'on-bridge': 7.9,
    refused: 8.3,
    'shrink-mid': 11.25,
    restored: 12.4,
  },
};

const smooth = (t: number): number => t * t * (3 - 2 * t);

function demoLook(t: number): [number, number] {
  const keys = DEMO.look;
  const first = keys[0] ?? [0, 0, 0];
  if (t <= first[0]) return [first[1], first[2]];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] ?? first;
    const b = keys[i] ?? first;
    if (t <= b[0]) {
      const u = smooth((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    }
  }
  const last = keys.at(-1) ?? first;
  return [last[1], last[2]];
}

// ---------------------------------------------------------------------------------------------
// Materials (lab stand-ins; S-01's glass library replaces them at integration)

function stoneFloor(): THREE.MeshStandardNodeMaterial {
  // 歩ける面は透明にしない: matte stone tiles with soft grout, so the walkable surface reads at a glance.
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  const p = positionWorld.xz.mul(1.25);
  const cell = fract(p);
  const edge = min(min(cell.x, float(1).sub(cell.x)), min(cell.y, float(1).sub(cell.y)));
  const grout = smoothstep(0.0, 0.04, edge);
  const n = fract(sin(dot(floor(p), vec2(12.9898, 78.233))).mul(43758.5453));
  const stone = vec3(0.5, 0.53, 0.57).mul(n.mul(0.1).add(0.9));
  const tile = mix(vec3(0.3, 0.32, 0.36), stone, grout);
  // cliff faces: plain darker stone, so the lip of every ledge reads sharply against the gap
  const side = vec3(0.2, 0.22, 0.27).mul(n.mul(0.1).add(0.9));
  m.colorNode = vec4(mix(side, tile, smoothstep(0.4, 0.7, normalWorld.y)), 1);
  return m;
}

/** Cheap glass (遠景のガラス): environment reflection with a Fresnel-shaped opacity, no transmission. */
function cheapGlass(env: THREE.Texture, tint: THREE.Color, strength = 1): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const facing = abs(dot(normalView, positionViewDirection));
  const fres = pow(float(1).sub(facing), 3);
  const refl = pmremTexture(env, reflectVector, float(0.03)).rgb;
  m.colorNode = vec4(refl.mul(vec3(tint.r, tint.g, tint.b)).mul(strength), 1);
  m.opacityNode = fres.mul(0.85).add(0.07).mul(strength).min(1);
  return m;
}

// ---------------------------------------------------------------------------------------------

function bubbleCluster(
  at: Vec3,
  spread: Vec3,
  count: number,
  seed: number,
): { glass: THREE.BufferGeometry; rings: THREE.BufferGeometry } {
  let s = seed;
  const rnd = (): number => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const spheres: THREE.BufferGeometry[] = [];
  const rings: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const r = 0.7 + rnd() * 1.5;
    const x = at[0] + (rnd() - 0.5) * spread[0];
    const stacked = i > 0 && rnd() < spread[1] / 4;
    const y = at[1] + r * 0.75 + (stacked ? r * 1.1 : 0);
    const z = at[2] + (rnd() - 0.5) * spread[2];
    const g = new THREE.SphereGeometry(r, 40, 24);
    g.translate(x, y, z);
    spheres.push(g);
    // 直線と細い線は真鍮の枠だけ: a thin brass band around each bubble
    const ring = new THREE.TorusGeometry(r * 1.002, 0.018, 8, 64);
    ring.rotateX(Math.PI / 2 + (rnd() - 0.5) * 0.08);
    ring.translate(x, y - r * 0.45, z);
    if (i % 2 === 0) rings.push(ring);
    else ring.dispose();
  }
  return { glass: mergeGeometries(spheres), rings: mergeGeometries(rings) };
}

const create: SceneFactory = async ({ renderer, canvas, quality, params }) => {
  const scene = new THREE.Scene();

  // 序章は夜明け前の青 (アートディレクション > 光と時間帯): deep blue above, a cool pale horizon,
  // and the first warmth only low on the side where the sun will rise.
  const SUN_AZIMUTH = new THREE.Vector3(14, 0, -6).normalize();
  const zenith = vec3(0.05, 0.09, 0.2);
  const horizonCool = vec3(0.36, 0.44, 0.58);
  const horizonWarm = vec3(0.95, 0.66, 0.46);
  const dirY = positionWorldDirection.y;
  const flat = positionWorldDirection.mul(vec3(1, 0, 1)).normalize();
  const towardSun = pow(dot(flat, vec3(SUN_AZIMUTH.x, 0, SUN_AZIMUTH.z)).max(0), 4);
  const horizon = mix(horizonCool, horizonWarm, towardSun.mul(float(1).sub(smoothstep(0.0, 0.3, dirY))));
  const skyNode = mix(
    mix(horizon, zenith, smoothstep(0.0, 0.6, dirY)),
    horizonCool,
    float(1).sub(smoothstep(-0.2, 0.0, dirY)),
  );
  scene.backgroundNode = skyNode;
  // 奥ほど霞ませる: distance haze in the colour of the cool horizon, plus a mist that rises out of the
  // chasm so the cliff faces and the far town sink into it and the gap reads as depth.
  const mist = float(1)
    .sub(smoothstep(-6, -0.3, positionWorld.y))
    .mul(0.96);
  const deep = vec3(0.05, 0.08, 0.16);
  scene.fogNode = fog(mix(horizonCool, deep, mist.mul(0.85)), densityFogFactor(float(0.045)).max(mist));

  // Reflection environment from the same sky plus a warm glow where the sun will rise.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  skyMat.colorNode = vec4(skyNode, 1);
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
  const sunGlowMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(6, 4.6, 3.2) });
  const sunGlow = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 8), sunGlowMat);
  sunGlow.position.set(40, 8, -18);
  envScene.add(sunGlow);
  const envTarget = pmrem.fromScene(envScene, 0);
  const env = envTarget.texture;
  scene.environment = env;
  for (const o of envScene.children) if (o instanceof THREE.Mesh) o.geometry.dispose();
  skyMat.dispose();
  sunGlowMat.dispose();

  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 120);
  const field = new LayerField();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const keep = <G extends THREE.BufferGeometry>(g: G): G => {
    geometries.push(g);
    return g;
  };
  const mat = <M extends THREE.Material>(m: M): M => {
    materials.push(m);
    return m;
  };
  const add = (mesh: THREE.Object3D, kind: 'surface' | 'back' | 'shared'): void => {
    field.assign(mesh, kind);
    scene.add(mesh);
  };

  // ---- shared: ledges, chasm, pedestal, the town around, lights --------------------------------
  const floorMat = mat(stoneFloor());
  const nearLen = NEAR_LEDGE[1] - NEAR_LEDGE[0];
  const near = new THREE.Mesh(keep(new RoundedBoxGeometry(nearLen, 0.9, 10, 4, 0.12)), floorMat);
  near.position.set((NEAR_LEDGE[0] + NEAR_LEDGE[1]) / 2, -0.45, 0);
  add(near, 'shared');
  const farLen = FAR_LEDGE[1] - FAR_LEDGE[0];
  const far = new THREE.Mesh(keep(new RoundedBoxGeometry(farLen, 0.9, 10, 4, 0.12)), floorMat);
  far.position.set((FAR_LEDGE[0] + FAR_LEDGE[1]) / 2, -0.45, 0);
  add(far, 'shared');
  const chasm = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(40, 40)),
    mat(new THREE.MeshStandardNodeMaterial({ color: 0x23324a, roughness: 1 })),
  );
  chasm.rotation.x = -Math.PI / 2;
  chasm.position.set(1.4, -30, 0);
  add(chasm, 'shared');

  const brass = mat(new THREE.MeshStandardNodeMaterial({ color: 0xb08d57, metalness: 1, roughness: 0.32 }));
  // brass edge strips along both ledge lips: 形は縁で伝える
  const lipGeo = keep(
    mergeGeometries([
      new THREE.CylinderGeometry(0.025, 0.025, 9.9, 8).rotateX(Math.PI / 2).translate(-0.02, 0.0, 0),
      new THREE.CylinderGeometry(0.025, 0.025, 9.9, 8).rotateX(Math.PI / 2).translate(2.82, 0.0, 0),
    ]),
  );
  add(new THREE.Mesh(lipGeo, brass), 'shared');

  // Pedestal (台座): brass stem and a frosted cup; it glows faintly so the dead end has a reason (ルール9).
  const pedestalGroup = new THREE.Group();
  const stem = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, 0),
      new THREE.Vector2(0.24, 0),
      new THREE.Vector2(0.26, 0.05),
      new THREE.Vector2(0.12, 0.14),
      new THREE.Vector2(0.06, 0.3),
      new THREE.Vector2(0.05, 0.8),
      new THREE.Vector2(0.09, 0.9),
      new THREE.Vector2(0.0, 0.9),
    ],
    40,
  );
  pedestalGroup.add(new THREE.Mesh(keep(stem), brass));
  const cupMat = mat(
    new THREE.MeshPhysicalNodeMaterial({
      color: 0xe9eef2,
      roughness: 0.5,
      metalness: 0,
      emissive: new THREE.Color(0.9, 0.7, 0.45),
      emissiveIntensity: 0.25,
    }),
  );
  const cup = new THREE.Mesh(
    keep(new THREE.SphereGeometry(0.13, 32, 12, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45)),
    cupMat,
  );
  cup.position.y = 1.02;
  pedestalGroup.add(cup);
  pedestalGroup.position.set(PEDESTAL_ORB[0], 0, PEDESTAL_ORB[2]);
  add(pedestalGroup, 'shared');

  // The orb on the pedestal (shared: it is real in both layers). Glass with transmission.
  const placedOrbMat = mat(
    new THREE.MeshPhysicalNodeMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0,
      transmission: 1,
      ior: 1.5,
      thickness: 0.12,
      attenuationColor: new THREE.Color(0xeafff4),
      attenuationDistance: 0.6,
    }),
  );
  const orbGlow = uniform(0);
  placedOrbMat.emissiveNode = vec3(1.0, 0.78, 0.5).mul(orbGlow);
  const placedOrb = new THREE.Mesh(keep(new THREE.SphereGeometry(HAND_ORB_RADIUS, 48, 32)), placedOrbMat);
  placedOrb.position.set(...PEDESTAL_ORB);
  add(placedOrb, 'shared');

  // The town around: bubble buildings of cheap glass with brass bands, on both sides and across.
  const townGlass = mat(cheapGlass(env, new THREE.Color(0.92, 0.97, 1.0)));
  const clusters = [
    bubbleCluster([-3.4, 0, -4.4], [4.5, 1.5, 0.6], 4, 7),
    bubbleCluster([-3.6, 0, 4.4], [4.5, 1.5, 0.6], 4, 19),
    bubbleCluster([6.0, 0, -3.9], [4, 2.0, 0.8], 4, 31),
    bubbleCluster([6.4, 0, 4.1], [4, 1.5, 0.8], 3, 43),
    bubbleCluster([17, -9, 1], [8, 3, 16], 9, 59),
  ];
  const townGeo = keep(mergeGeometries(clusters.map((c) => c.glass)));
  const ringGeo = keep(mergeGeometries(clusters.map((c) => c.rings)));
  for (const c of clusters) {
    c.glass.dispose();
    c.rings.dispose();
  }
  const town = new THREE.Mesh(townGeo, townGlass);
  town.renderOrder = 1;
  add(town, 'shared');
  add(new THREE.Mesh(ringGeo, brass), 'shared');

  // The way on (ルール6: 次に行く場所がガラス越しに先に見えている): a brass arch on the far ledge.
  const archGeo = keep(new THREE.TorusGeometry(1.5, 0.05, 12, 96, Math.PI));
  const arch = new THREE.Mesh(archGeo, brass);
  arch.rotation.y = Math.PI / 2;
  arch.position.set(6.4, 0, 0);
  add(arch, 'shared');

  const hemi = new THREE.HemisphereLight(0x8fa6cc, 0x2a3040, 1.0);
  add(hemi, 'shared');
  const sun = new THREE.DirectionalLight(0xffc89a, 1.6);
  sun.position.set(14, 7, -6);
  add(sun, 'shared');
  const sunDirection = sun.position.clone().normalize();
  const orbLight = new THREE.PointLight(0xffcf8a, 0, 9, 2);
  orbLight.position.set(PEDESTAL_ORB[0], PEDESTAL_ORB[1] + 0.1, PEDESTAL_ORB[2]);
  add(orbLight, 'shared');

  // ---- surface only: the broken glass wall that makes the ledge a dead end --------------------
  const shardGeos: THREE.BufferGeometry[] = [];
  const shards: [number, number, number, number, number, number][] = [
    // x, z, height, width, tiltX, tiltZ
    [-0.12, -0.55, 1.25, 0.5, 0.1, -0.08],
    [-0.1, -0.05, 0.75, 0.45, -0.18, 0.12],
    [-0.14, 0.42, 1.05, 0.5, 0.06, 0.16],
    [-0.1, 0.9, 0.55, 0.4, -0.1, -0.2],
    [-0.12, -1.05, 0.65, 0.4, 0.2, 0.1],
  ];
  for (const [x, z, h, w, tx, tz] of shards) {
    const g = new RoundedBoxGeometry(0.03, h, w, 2, 0.012);
    g.rotateX(tx);
    g.rotateZ(tz);
    g.translate(x, h / 2, z);
    shardGeos.push(g);
  }
  for (let i = 0; i < 9; i++) {
    const g = new THREE.TetrahedronGeometry(0.06 + (i % 3) * 0.03, 0);
    g.rotateY(i * 1.7);
    g.translate(-0.35 - (i % 4) * 0.12, 0.03, -0.6 + i * 0.16);
    shardGeos.push(g);
  }
  const shardGeo = keep(mergeGeometries(shardGeos.map((g) => (g.index ? g.toNonIndexed() : g))));
  for (const g of shardGeos) g.dispose();
  const brokenWall = new THREE.Mesh(shardGeo, mat(cheapGlass(env, new THREE.Color(0.85, 0.95, 0.92), 1.15)));
  brokenWall.renderOrder = 2;
  add(brokenWall, 'surface');

  // ---- back only: the bridge, its rails and lanterns, and a light drop ------------------------
  const deckMat = mat(
    new THREE.MeshPhysicalNodeMaterial({
      color: 0xe4ecf2,
      roughness: 0.48,
      metalness: 0,
      iridescence: 1,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [180, 520],
    }),
  );
  // 曇りガラスの床板: frosted panels with thin bright joints every 0.4 m (the collision segments),
  // lit faintly from within so the bridge reads as 裏の層 (光があった頃の街の名残).
  {
    const joint = float(1).sub(
      smoothstep(
        0.0,
        0.035,
        abs(fract(positionWorld.x.div(0.4)).sub(0.5))
          .sub(0.5)
          .abs(),
      ),
    );
    deckMat.colorNode = vec4(mix(vec3(0.86, 0.88, 0.9), vec3(0.72, 0.6, 0.42), joint), 1);
    deckMat.emissiveNode = vec3(0.9, 0.75, 0.5).mul(joint.mul(0.6).add(0.05));
  }
  const deckLen = BRIDGE_BOX.max[0] - BRIDGE_BOX.min[0];
  const deck = new THREE.Mesh(keep(new RoundedBoxGeometry(deckLen + 0.3, 0.14, 1.2, 3, 0.05)), deckMat);
  deck.position.set(deckLen / 2, -0.07, 0);
  add(deck, 'back');

  const railParts: THREE.BufferGeometry[] = [];
  for (const z of [-0.62, 0.62]) {
    railParts.push(
      new THREE.CylinderGeometry(0.02, 0.02, deckLen + 0.3, 8)
        .rotateZ(Math.PI / 2)
        .translate(deckLen / 2, 0.85, z),
    );
    for (let i = 0; i <= 4; i++) {
      railParts.push(
        new THREE.CylinderGeometry(0.018, 0.022, 0.85, 8).translate((deckLen * i) / 4, 0.425, z),
      );
    }
  }
  // two arches over the bridge so its silhouette reads through the orb
  for (const x of [0.7, 2.1]) {
    railParts.push(
      new THREE.TorusGeometry(0.62, 0.022, 8, 48, Math.PI).rotateY(Math.PI / 2).translate(x, 0.85, 0),
    );
  }
  const rails = new THREE.Mesh(keep(mergeGeometries(railParts)), brass);
  for (const g of railParts) g.dispose();
  add(rails, 'back');

  const lanternMat = mat(
    new THREE.MeshStandardNodeMaterial({
      color: 0xfff6ea,
      roughness: 0.6,
      emissive: new THREE.Color(1.0, 0.78, 0.5),
      emissiveIntensity: 2.2,
    }),
  );
  const lanternParts: THREE.BufferGeometry[] = [];
  for (const z of [-0.62, 0.62]) {
    for (const x of [0, deckLen])
      lanternParts.push(new THREE.SphereGeometry(0.075, 20, 12).translate(x, 0.95, z));
  }
  const lanterns = new THREE.Mesh(keep(mergeGeometries(lanternParts)), lanternMat);
  for (const g of lanternParts) g.dispose();
  add(lanterns, 'back');

  // 光の雫 (裏の層にしかない): a small bright drop hovering over the far end of the bridge.
  const dropMat = mat(new THREE.MeshBasicNodeMaterial());
  dropMat.colorNode = vec4(vec3(5.0, 4.1, 2.8), 1);
  const drop = new THREE.Mesh(
    keep(
      new THREE.LatheGeometry(
        Array.from({ length: 12 }, (_, i) => {
          const a = (i / 11) * Math.PI;
          return new THREE.Vector2(
            Math.sin(a) * 0.06 * (1 - 0.55 * (i / 11)),
            -Math.cos(a) * 0.08 + (i / 11) * 0.05,
          );
        }),
        24,
      ),
    ),
    dropMat,
  );
  drop.position.set(2.45, 1.15, 0);
  add(drop, 'back');

  for (const m of field.membranes) scene.add(m);

  // ---- frame pipeline ------------------------------------------------------------------------
  const pipeline = new PeekPipeline({
    renderer,
    scene,
    camera,
    field,
    peekScale: quality.peekScale,
    environment: env,
  });

  // ---- state ---------------------------------------------------------------------------------
  const pedestals: Record<string, Vec3> = { [PEDESTAL_ID]: PEDESTAL_ORB };
  const footing: FootingSegment[] = splitFooting('bridge', BRIDGE_BOX, 0.4);
  let orbs: readonly Orb[] = createOrbs(0);
  let spheres: OrbSphere[] = [];
  let spheresFor: readonly Orb[] | null = null;
  let active = new Set<string>();
  let peek: PeekState = { progress: 0, peeking: false };
  let hand: Tween = { progress: 1, target: 1 };
  let shake = 0;
  let lastAction: string | null = null;
  let x = START_X;
  let velocity = 0;
  let yaw = THREE.MathUtils.degToRad(6);
  let pitch = THREE.MathUtils.degToRad(-5);
  let simTime = 0;
  let frames = 0;
  let peekDeniedLatched = false;

  const input = { peek: false, forward: 0, back: 0, left: 0, right: 0, up: 0, down: 0 };
  const forcePeek = params.get('peek') === 'hold';
  const demo = params.get('demo') === '1';
  const demoHoldRaw = Number(params.get('demoHold'));
  const demoHold = demo && Number.isFinite(demoHoldRaw) && params.has('demoHold') ? demoHoldRaw : null;
  const demoRateRaw = Number(params.get('demoRate'));
  const demoRate = Number.isFinite(demoRateRaw) && demoRateRaw > 0 ? Math.min(demoRateRaw, 8) : 1;
  let demoTime = 0;

  const solidAt = (px: number): boolean => {
    if (px >= NEAR_LEDGE[0] && px <= NEAR_LEDGE[1]) return true;
    if (px >= FAR_LEDGE[0] && px <= FAR_LEDGE[1]) return true;
    return footing.some((s) => active.has(s.id) && px >= s.min[0] && px <= s.max[0]);
  };
  const feetPos: [number, number, number] = [START_X, 0, 0];
  const feet = (): Vec3 => {
    feetPos[0] = x;
    return feetPos;
  };
  const pedestalDistance = (): number => Math.hypot(x - PEDESTAL_ORB[0], PEDESTAL_ORB[2]);
  const mainOrb = (): Orb | undefined => orbs.find((o) => o.kind === 'main');

  const refreshSpheres = (): void => {
    if (spheresFor === orbs) return;
    spheresFor = orbs;
    spheres = orbSpheres(orbs, pedestals);
    active = new Set(activeSegmentIds(footing, spheres));
    field.setSpheres(
      spheres.map((s) => ({ center: s.center, radius: s.radius, glow: boundaryGlow(s.materialize) })),
    );
  };

  const interact = (): void => {
    const main = mainOrb();
    if (!main) return;
    if (pedestalDistance() > REACH) {
      lastAction = main.pedestal === null ? 'place-denied' : 'pickup-denied';
      return;
    }
    if (main.pedestal === null) {
      if (!canPlace(orbs, main.id, PEDESTAL_ID, { peeking: peek.peeking })) {
        lastAction = 'place-denied';
        return;
      }
      orbs = placeOn(orbs, main.id, PEDESTAL_ID);
      hand = { progress: hand.progress, target: 0 };
      lastAction = 'place';
    } else if (canPickUp(orbs, main.id, { pedestals, footing, feet: feet() })) {
      orbs = takeBack(orbs, main.id);
      hand = { progress: hand.progress, target: 1 };
      lastAction = 'pickup';
    } else {
      shake = SHAKE_SECONDS;
      lastAction = 'pickup-denied';
    }
  };

  const step = (dt: number): void => {
    simTime += dt;
    // demo drives the same inputs a player would
    let wantPeek = input.peek || forcePeek;
    let walk = input.forward - input.back;
    if (demo) {
      const before = demoTime;
      demoTime += dt;
      wantPeek = DEMO.peek.some(([a, b]) => demoTime >= a && demoTime < b);
      walk = DEMO.walk.find(([a, b]) => demoTime >= a && demoTime < b)?.[2] ?? 0;
      for (const t of DEMO.interact) if (before < t && demoTime >= t) interact();
      const [yd, pd] = demoLook(demoTime);
      yaw = THREE.MathUtils.degToRad(yd);
      pitch = THREE.MathUtils.degToRad(pd);
    } else {
      yaw += (input.left - input.right) * LOOK_SPEED * dt;
      pitch = THREE.MathUtils.clamp(pitch + (input.up - input.down) * LOOK_SPEED * dt, -1.2, 1.2);
    }

    const allowed = canPeek(orbs);
    if (wantPeek && !allowed && !peekDeniedLatched) lastAction = 'peek-denied';
    peekDeniedLatched = wantPeek && !allowed;
    peek = stepPeek(peek, { wantPeek, allowed }, dt);
    orbs = stepOrbs(orbs, dt);
    hand = stepTween(hand, dt, HAND_SECONDS);
    shake = Math.max(0, shake - dt);
    refreshSpheres();

    // rail walking with a short inertia; the edge stops you unless footing is solid ahead
    const amount = peekAmount(peek);
    const targetV = walk * WALK_SPEED * peekMoveSpeedMultiplier(amount);
    velocity += (targetV - velocity) * (1 - Math.exp(-dt / INERTIA_SECONDS));
    const nx = x + velocity * dt;
    if (Math.abs(velocity) > 1e-4 && !solidAt(nx + Math.sign(velocity) * EDGE_MARGIN)) velocity = 0;
    else x = nx;
  };

  // ---- input ---------------------------------------------------------------------------------
  const onPointerDown = (e: PointerEvent): void => {
    if (demo) return;
    if (e.button === 2) input.peek = true;
    if (e.button === 0) interact();
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (e.button === 2) input.peek = false;
  };
  const onContextMenu = (e: Event): void => e.preventDefault();
  const keys: Record<string, keyof typeof input> = {
    KeyW: 'forward',
    KeyS: 'back',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (demo || e.repeat) return;
    if (e.code === 'KeyE') interact();
    const k = keys[e.code];
    if (k && k !== 'peek') input[k] = 1;
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    const k = keys[e.code];
    if (k && k !== 'peek') input[k] = 0;
  };
  const onBlur = (): void => {
    input.peek = false;
    input.forward = input.back = input.left = input.right = input.up = input.down = 0;
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ---- probe ---------------------------------------------------------------------------------
  const sphereProbe = Array.from({ length: 3 }, () => ({
    orbId: '',
    kind: '',
    center: [0, 0, 0] as [number, number, number],
    radius: 0,
  }));
  const probe = {
    ready: false,
    peeking: false,
    peekAmount: 0,
    fov: BASE_FOV,
    baseFov: BASE_FOV,
    moveSpeed: 1,
    spheres: [] as typeof sphereProbe,
    orb: 'hand' as 'hand' | 'pedestal',
    activeSegments: [] as string[],
    segmentCount: footing.length,
    player: { x, y: 0, z: 0 },
    onBackFooting: false,
    lastAction: null as string | null,
    backPassFrames: 0,
    backTarget: { width: 0, height: 0 },
    renderSize: { width: 0, height: 0 },
    peekScale: quality.peekScale,
    orbScreen: { x: 0, y: 0, r: 0, visible: true },
    demo: demo ? { time: 0, holding: false, marks: DEMO.marks } : null,
  };
  window.__vidro.sceneProbe = probe as unknown as Record<string, unknown>;

  const lookTarget = new THREE.Vector3();
  const orbCenter: [number, number, number] = [0, 0, 0];
  const orbCircle = { x: 0, y: 0, r: 0 };
  let probeActiveFor: Set<string> | null = null;
  const frame = {
    center: [0, 0, 0] as Vec3,
    radius: HAND_ORB_RADIUS,
    peek: 0,
    visible: true,
    sunDirection,
  };

  return {
    scene,
    camera,
    update(dt) {
      const holding = demoHold !== null && demoTime >= demoHold;
      let remaining = holding ? 0 : demo ? dt * demoRate : dt;
      if (demoHold !== null) remaining = Math.min(remaining, Math.max(0, demoHold - demoTime));
      while (remaining > 1e-9) {
        const h = Math.min(remaining, 1 / 60);
        step(h);
        remaining -= h;
      }

      const amount = peekAmount(peek);
      const presence = glassEase(hand.progress);
      camera.fov = BASE_FOV + peekFovOffset(amount);
      camera.updateProjectionMatrix();
      camera.position.set(x, EYE_HEIGHT, 0);
      lookTarget.set(
        x + Math.cos(yaw) * Math.cos(pitch),
        EYE_HEIGHT + Math.sin(pitch),
        -Math.sin(yaw) * Math.cos(pitch),
      );
      camera.lookAt(lookTarget);
      camera.updateMatrixWorld();

      const main = mainOrb();
      const mainSphere = spheres.find((s) => s.kind === 'main');
      const glow = mainSphere ? boundaryGlow(mainSphere.materialize) : 0;
      placedOrb.visible = main?.pedestal != null || frames < 2;
      const jitter = shake > 0 ? Math.sin(simTime * 90) * 0.004 * (shake / SHAKE_SECONDS) : 0;
      placedOrb.position.set(PEDESTAL_ORB[0] + jitter, PEDESTAL_ORB[1], PEDESTAL_ORB[2] - jitter * 0.6);
      orbGlow.value = glow * 1.4;
      orbLight.intensity = glow * 4.5;
      if (frames < 2) {
        // prewarm: compile the membrane and the placed-orb pipelines before the first placement
        field.setSpheres([{ center: PEDESTAL_ORB, radius: 0.01, glow: 0 }]);
        spheresFor = null;
      }

      const c = handOrbCenter(amount, presence, simTime, orbCenter);
      frame.center = c;
      frame.peek = amount;
      frame.visible = presence > 0.001;

      // probe
      probe.peeking = peek.peeking;
      probe.peekAmount = amount;
      probe.fov = camera.fov;
      probe.moveSpeed = peekMoveSpeedMultiplier(amount);
      probe.spheres.length = 0;
      spheres.forEach((s, i) => {
        const p = sphereProbe[i];
        if (!p) return;
        p.orbId = s.orbId;
        p.kind = s.kind;
        p.center[0] = s.center[0];
        p.center[1] = s.center[1];
        p.center[2] = s.center[2];
        p.radius = s.radius;
        probe.spheres.push(p);
      });
      probe.orb = main?.pedestal != null ? 'pedestal' : 'hand';
      if (probeActiveFor !== active) {
        probeActiveFor = active;
        probe.activeSegments = [...active];
      }
      probe.player.x = x;
      probe.onBackFooting = segmentsUnder(feet(), footing).some((s) => active.has(s.id));
      probe.lastAction = lastAction;
      const circle = orbScreenCircle(c, HAND_ORB_RADIUS, camera.fov, camera.aspect, orbCircle);
      probe.orbScreen.x = circle.x;
      probe.orbScreen.y = circle.y;
      probe.orbScreen.r = circle.r;
      probe.orbScreen.visible = frame.visible;
      if (probe.demo) {
        probe.demo.time = demoTime;
        probe.demo.holding = demoHold !== null && demoTime >= demoHold - 1e-9;
      }
    },
    render() {
      pipeline.render(frame);
      frames++;
      probe.backPassFrames = pipeline.backPassFrames;
      const size = pipeline.renderSize;
      probe.renderSize.width = size.width;
      probe.renderSize.height = size.height;
      probe.backTarget.width = pipeline.backTarget.width;
      probe.backTarget.height = pipeline.backTarget.height;
      if (frames >= 3) probe.ready = true;
    },
    resize() {
      pipeline.resize();
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      pipeline.dispose();
      field.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      envTarget.dispose();
      pmrem.dispose();
    },
  };
};

export default create;
