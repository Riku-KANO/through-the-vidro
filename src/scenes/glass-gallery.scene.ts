import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  color,
  dot,
  fract,
  max,
  mix,
  normalWorldGeometry,
  oneMinus,
  positionLocal,
  pow,
  smoothstep,
  uv,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import {
  type Bubble,
  buildFusedBubbleSurface,
  createBrassMaterial,
  createFrostedFloorMaterial,
  createGlass,
  createInnerBubbleMaterial,
  findTransmissionOverlaps,
  fusedBubbleGeometry,
  fusedBubbleSilhouette,
  type GlassFeatures,
  type GlassKind,
  type GlassPlacement,
  type GlassRole,
  type GlassSilhouette,
  type HazeSpec,
  innerBubbleMesh,
  scatterInnerBubbles,
  surfaceLine,
} from '../core/glass';
import type { SceneFactory } from '../core/scene';

export const title =
  'S-01 glass gallery: every glass kind, a fused-bubble house, brass frames, frosted floor';

/**
 * 見本のシーン for the glass library. A morning plaza (アートディレクション: 静けさ・温度のある透明・朝の光):
 * seven glass specimens on thin brass stands in an arc, a fused-bubble house on a frosted dais, milky
 * lamps, far bubble towers fading into the haze on the cheap path, and a brass arcade behind the viewer
 * that the glass reflects (形は縁で伝える: the edges need something to reflect).
 *
 * Layout rule (技術設計 > ガラスの描画 > 対策1): from the camera path no transmissive glass stands behind
 * other transmissive glass. Specimen tops stay below the house's base on screen; far towers stay outside
 * the house's silhouette. sceneProbe.sightlines checks the whole camera path.
 *
 * The camera depends only on t (or ?at=<seconds> to freeze it), so screenshots are reproducible.
 */

/** 操作とカメラ > カメラ: 目の高さ1.6m、視野角70度 */
const EYE_HEIGHT = 1.6;
const FOV = 70;
/** One loop of the camera sway, seconds (仮). */
const PERIOD = 40;

const SKY = {
  zenith: 0x4a74a8,
  horizon: 0xeee6da,
  ground: 0xb9c3c9,
  sun: 0xffe6c4,
};
/** 空間の可読性と導線 > 8 奥ほど霞ませる (仮 distances). Same haze for scene fog and far glass. */
const HAZE: HazeSpec = { color: SKY.horizon, near: 10, far: 80 };
/** Morning sun, high enough to stay just above the frame, front-left. */
const SUN_DIR = new THREE.Vector3(-0.5, 0.62, -0.6).normalize();

/** Terrace (dais) the house stands on. */
const TERRACE = { x: 0, z: -12.2, radius: 6.5, height: 0.8 };
/** Arc of specimens around the camera's rest point. */
const ARC = { cx: 0, cz: 6, radius: 3.0 };
/** Brass arcade around the back half of the plaza, behind the viewer (angles from straight ahead). */
const ARCADE = { radius: 15, from: 112, to: 248, columns: 11, height: 5.2 };

interface GlassEntry {
  id: string;
  kind: GlassKind;
  placement: GlassPlacement;
  role: GlassRole;
  path: GlassFeatures['path'];
  dispersion: boolean;
  thinFilm: GlassFeatures['thinFilm'];
}

interface Specimen {
  id: string;
  kind: GlassKind;
  role: GlassRole;
  /** Angle along the arc, degrees (0 = straight ahead). */
  angle: number;
  stand: number;
  shape: 'drop' | 'orb' | 'shell' | 'cloche';
  size: number;
}

/** Tops stay below ~1.15 m so they never reach the house's base on screen (see layout rule). */
const SPECIMENS: Specimen[] = [
  { id: 'specimen-jade', kind: 'jade', role: 'scenery', angle: -39, stand: 0.5, shape: 'drop', size: 0.22 },
  {
    id: 'specimen-frosted',
    kind: 'frosted',
    role: 'scenery',
    angle: -26,
    stand: 0.5,
    shape: 'cloche',
    size: 0.2,
  },
  { id: 'specimen-amber', kind: 'amber', role: 'scenery', angle: -13, stand: 0.5, shape: 'drop', size: 0.22 },
  { id: 'specimen-orb', kind: 'bubble', role: 'orb', angle: 0, stand: 0.55, shape: 'orb', size: 0.28 },
  { id: 'specimen-clear', kind: 'clear', role: 'scenery', angle: 13, stand: 0.5, shape: 'shell', size: 0.28 },
  { id: 'specimen-lapis', kind: 'lapis', role: 'scenery', angle: 26, stand: 0.5, shape: 'drop', size: 0.22 },
  { id: 'specimen-drop', kind: 'iridescent', role: 'drop', angle: 39, stand: 0.5, shape: 'drop', size: 0.18 },
];

/** The fused-bubble house on the terrace (泡が溶け合った形). */
const T = TERRACE.height;
const HOUSE: Bubble[] = [
  { x: 0, y: T + 2.3, z: -12.5, r: 3.0 },
  { x: -3.3, y: T + 1.3, z: -11.6, r: 1.8 },
  { x: 3.0, y: T + 1.6, z: -11.9, r: 2.1 },
  { x: 0.8, y: T + 5.0, z: -12.9, r: 1.4 },
  { x: -1.5, y: T + 4.0, z: -13.2, r: 1.2 },
  { x: 2.2, y: T + 1.2, z: -14.6, r: 1.9 },
  { x: -1.3, y: T + 0.7, z: -9.9, r: 0.9 },
];

/**
 * Far bubble towers, by angle (degrees) and distance from the camera's rest point. Spaced so that even
 * on high (farGlassTransmission: they become transmissive) none stands behind another or the house.
 */
const FAR: {
  id: string;
  kind: GlassKind;
  angle: number;
  distance: number;
  scale: number;
  variant: number;
}[] = [
  { id: 'far-west', kind: 'clear', angle: -27, distance: 46, scale: 1.2, variant: 2 },
  { id: 'far-west-amber', kind: 'amber', angle: -44, distance: 58, scale: 1.6, variant: 1 },
  { id: 'far-east', kind: 'clear', angle: 27, distance: 48, scale: 1.3, variant: 1 },
  { id: 'far-east-frosted', kind: 'frosted', angle: 44, distance: 62, scale: 1.8, variant: 0 },
];

const TOWER_VARIANTS: readonly (readonly [number, number, number, number])[][] = [
  [
    [0, 2.6, 0, 3.0],
    [1.8, 5.6, 0.4, 1.8],
    [-1.6, 1.4, 1.2, 1.6],
    [0.4, 7.6, -0.3, 1.1],
  ],
  [
    [0, 2.4, 0, 2.6],
    [-1.2, 5.2, -0.2, 2.0],
    [-0.6, 8.2, 0.2, 1.4],
    [2.2, 1.6, 0.6, 1.4],
  ],
  [
    [0, 2.2, 0, 2.4],
    [2.0, 2.0, -0.8, 1.9],
    [0.9, 4.8, -0.2, 1.5],
  ],
];

function farTower(cx: number, cz: number, s: number, variant: number): Bubble[] {
  const v = TOWER_VARIANTS[variant % TOWER_VARIANTS.length] ?? [];
  return v.map(([x, y, z, r]) => ({ x: cx + x * s, y: y * s, z: cz + z * s, r: r * s }));
}

function polar(angleDeg: number, distance: number): [number, number] {
  const a = THREE.MathUtils.degToRad(angleDeg);
  return [ARC.cx + Math.sin(a) * distance, ARC.cz - Math.cos(a) * distance];
}

/** Camera pose at time t: a slow sway around the rest point, looking past the specimens to the house. */
function cameraPose(t: number, position: THREE.Vector3, target: THREE.Vector3): void {
  const a = (t / PERIOD) * Math.PI * 2;
  position.set(0.45 * Math.sin(a), EYE_HEIGHT, ARC.cz - 0.25 * (1 - Math.cos(a)));
  target.set(0.25 * Math.sin(a + 0.8), 0.45, -6);
}

/** Sky colour for a direction (shared by the background and the environment capture). */
function skyNode(dir: THREE.Node<'vec3'>) {
  const y = dir.y;
  const up = mix(color(SKY.horizon), color(SKY.zenith), pow(smoothstep(0, 1, y), 0.45));
  const down = mix(color(SKY.horizon), color(SKY.ground), smoothstep(0, 0.25, y.negate()));
  const base = mix(down, up, smoothstep(-0.02, 0.02, y));
  const s = max(dot(dir, vec3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z)), 0);
  const glow = pow(s, 1200).mul(60).add(pow(s, 40).mul(0.5)).add(pow(s, 6).mul(0.22));
  return base.add(color(SKY.sun).mul(glow));
}

/** Teardrop standing on its round end (雫). Local origin at the bottom. */
function dropGeometry(radius: number, height: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  const a = 0.38 * height;
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const y = (i / n) * height;
    const r =
      y <= a
        ? radius * Math.sqrt(Math.max(0, 1 - ((a - y) / a) ** 2))
        : radius * Math.cos((Math.PI / 2) * ((y - a) / (height - a))) ** 1.4;
    pts.push(new THREE.Vector2(Math.max(r, 1e-4), y));
  }
  return new THREE.LatheGeometry(pts, 72);
}

/** Bell jar: straight wall and a round dome (形のルール: 角を作らない). Local origin at the rim. */
function clocheGeometry(radius: number, wall: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(radius, 0), new THREE.Vector2(radius, wall)];
  for (let i = 1; i <= 16; i++) {
    const a = (i / 16) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(radius * Math.cos(a), 1e-4), wall + radius * Math.sin(a)));
  }
  return new THREE.LatheGeometry(pts, 72);
}

/** Dais with a large rounded edge. */
function terraceGeometry(): THREE.LatheGeometry {
  const { radius: R, height: H } = TERRACE;
  const b = 0.32;
  const pts: THREE.Vector2[] = [new THREE.Vector2(R, 0), new THREE.Vector2(R, H - b)];
  for (let i = 1; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - b + Math.cos(a) * b, H - b + Math.sin(a) * b));
  }
  pts.push(new THREE.Vector2(0.001, H));
  return new THREE.LatheGeometry(pts.reverse(), 128);
}

/** Blue-grey wall behind the arcade with a row of warm, round-topped windows. */
function arcadeWallMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x84919c, roughness: 0.8, side: THREE.BackSide });
  const u = fract(uv().x.mul(22));
  const v = uv().y;
  const across = oneMinus(smoothstep(0.26, 0.3, abs(u.sub(0.5))));
  const up = smoothstep(0.22, 0.24, v).mul(oneMinus(smoothstep(0.54, 0.56, v)));
  m.emissiveNode = color(0xffd39c).mul(across.mul(up).mul(1.6));
  return m;
}

const create: SceneFactory = async (ctx) => {
  const { renderer, quality, params } = ctx;
  const atParam = params.get('at');
  const frozenAt = atParam !== null && Number.isFinite(Number(atParam)) ? Number(atParam) : null;

  const scene = new THREE.Scene();
  scene.backgroundNode = skyNode(normalWorldGeometry);
  scene.fog = new THREE.Fog(HAZE.color, HAZE.near, HAZE.far);

  const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.05, 300);

  const disposables: { dispose(): void }[] = [];
  const own = <D extends { dispose(): void }>(x: D): D => {
    disposables.push(x);
    return x;
  };

  // Static sun shadow (stands for the baked shadows of 光と時間帯; rendered once).
  const previousShadowMap = { enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type };
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const sun = new THREE.DirectionalLight(SKY.sun, 2.1);
  sun.target.position.set(0, 0, -6.5);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Covers the specimens, the lamps and the dais only (±12 m), for crisp texels.
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 80 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun, sun.target);

  // --- opaque: floor, dais, brass, lamps, arcade (drawn first; every glass refracts them) ---
  const floorMat = own(createFrostedFloorMaterial({ frostColor: 0xb9c3ca, tileSize: 1.6 }));
  const floor = new THREE.Mesh(own(new THREE.CircleGeometry(90, 96)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const terrace = new THREE.Mesh(own(terraceGeometry()), floorMat);
  terrace.position.set(TERRACE.x, 0, TERRACE.z);
  terrace.receiveShadow = true;
  terrace.castShadow = true;
  scene.add(terrace);

  const brass = own(createBrassMaterial());
  const brassParts: THREE.BufferGeometry[] = [];
  const addBrass = (g: THREE.BufferGeometry, m: THREE.Matrix4) => brassParts.push(g.applyMatrix4(m));
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  const flat = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const opaqueGlass: THREE.Mesh[] = [];

  addBrass(
    new THREE.TorusGeometry(TERRACE.radius - 0.1, 0.03, 8, 160),
    at(TERRACE.x, T, TERRACE.z).multiply(flat),
  );

  // Arcade behind the viewer: columns, arches, and the windowed wall.
  const cols: THREE.Vector3[] = [];
  for (let i = 0; i < ARCADE.columns; i++) {
    const a = ARCADE.from + (i * (ARCADE.to - ARCADE.from)) / (ARCADE.columns - 1);
    const [x, z] = polar(a, ARCADE.radius);
    cols.push(new THREE.Vector3(x, 0, z));
    addBrass(new THREE.CylinderGeometry(0.07, 0.09, ARCADE.height, 12), at(x, ARCADE.height / 2, z));
  }
  for (let i = 0; i + 1 < cols.length; i++) {
    const p = cols[i] as THREE.Vector3;
    const q = cols[i + 1] as THREE.Vector3;
    const span = p.distanceTo(q);
    const turn = new THREE.Matrix4().makeRotationY(-Math.atan2(q.z - p.z, q.x - p.x));
    addBrass(
      new THREE.TorusGeometry(span / 2, 0.05, 8, 40, Math.PI),
      at((p.x + q.x) / 2, ARCADE.height, (p.z + q.z) / 2).multiply(turn),
    );
  }
  const wallMat = own(arcadeWallMaterial());
  const span = THREE.MathUtils.degToRad(ARCADE.to - ARCADE.from + 12);
  const wall = new THREE.Mesh(
    own(
      new THREE.CylinderGeometry(ARCADE.radius + 1.6, ARCADE.radius + 1.6, 8, 96, 1, true, -span / 2, span),
    ),
    wallMat,
  );
  wall.position.set(ARC.cx, 4, ARC.cz);
  scene.add(wall);

  // --- glass ---
  const glassEntries: GlassEntry[] = [];
  const silhouettes = new Map<string, GlassSilhouette>();
  const register = (
    id: string,
    kind: GlassKind,
    placement: GlassPlacement,
    role: GlassRole,
    options: Parameters<typeof createGlass>[2] = {},
  ) => {
    const { material, features } = createGlass(kind, quality, { placement, role, haze: HAZE, ...options });
    own(material);
    glassEntries.push({ id, kind, placement, role, ...features });
    return material;
  };
  const milkyGlobe = (id: string, radius: number, x: number, y: number, z: number) => {
    const globe = new THREE.Mesh(
      own(new THREE.SphereGeometry(radius, 48, 32)),
      register(id, 'milky', 'near', 'scenery'),
    );
    globe.position.set(x, y, z);
    globe.castShadow = true;
    opaqueGlass.push(globe);
    scene.add(globe);
  };

  // Specimens on thin brass stands
  const innerBubbleMat = own(createInnerBubbleMaterial());
  const specimenMeshes: { id: string; mesh: THREE.Mesh; margin: number }[] = [];
  let floating: { mesh: THREE.Object3D; baseY: number } | null = null;
  for (const s of SPECIMENS) {
    const [x, z] = polar(s.angle, ARC.radius);
    const ring = s.shape === 'drop' ? s.size * 0.62 : s.size * 0.55;
    addBrass(new THREE.CylinderGeometry(0.11, 0.14, 0.03, 40), at(x, 0.015, z));
    addBrass(new THREE.CylinderGeometry(0.012, 0.016, s.stand, 12), at(x, s.stand / 2, z));
    const cradle = s.shape === 'cloche' ? s.size : ring;
    addBrass(new THREE.TorusGeometry(cradle, 0.01, 8, 64), at(x, s.stand, z).multiply(flat));

    const material = register(s.id, s.kind, 'near', s.role);
    let geometry: THREE.BufferGeometry;
    let y: number;
    if (s.shape === 'drop') {
      const h = s.size * 2.9;
      geometry = dropGeometry(s.size, h);
      // rests in the ring where its radius matches the ring's
      y = s.stand - 0.38 * h * (1 - Math.sqrt(1 - (ring / s.size) ** 2));
      if (s.role === 'drop') y += 0.1; // the light drop floats above its stand
    } else if (s.shape === 'cloche') {
      geometry = clocheGeometry(s.size, 0.26);
      y = s.stand + 0.01;
      // a brass ball in rings under the bell, softened by the frost; a brass knob on top
      const cy = s.stand + 0.2;
      addBrass(new THREE.CylinderGeometry(0.01, 0.014, 0.12, 8), at(x, s.stand + 0.06, z));
      addBrass(new THREE.SphereGeometry(0.075, 32, 20), at(x, cy, z));
      for (const turn of [flat, new THREE.Matrix4().makeRotationY(Math.PI / 4)]) {
        addBrass(new THREE.TorusGeometry(0.12, 0.012, 8, 48), at(x, cy, z).multiply(turn));
      }
      addBrass(new THREE.SphereGeometry(0.022, 16, 12), at(x, s.stand + 0.26 + s.size + 0.02, z));
    } else {
      geometry = new THREE.SphereGeometry(s.size, 72, 48);
      y = s.stand + Math.sqrt(s.size ** 2 - ring ** 2);
    }
    const mesh = new THREE.Mesh(own(geometry), material);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    specimenMeshes.push({ id: s.id, mesh, margin: s.role === 'drop' ? 0.03 : 0 });
    if (s.role === 'drop') floating = { mesh, baseY: y };
    if (s.kind === 'bubble') {
      const inner = innerBubbleMesh(
        scatterInnerBubbles({ seed: 11, count: 90, containerRadius: s.size, sizeRange: [0.005, 0.03] }),
        innerBubbleMat,
      );
      own(inner.geometry);
      mesh.add(inner);
    }
  }

  // The house, its brass ribs (traced on the glass, meeting at the crown) and what is inside.
  const houseSurface = buildFusedBubbleSurface(HOUSE, { blend: 0.9, columns: 144, rows: 96 });
  scene.add(
    new THREE.Mesh(
      own(fusedBubbleGeometry(houseSurface)),
      register('house', 'clear', 'near', 'scenery', { thicknessScale: 1.2 }),
    ),
  );
  silhouettes.set('house', { id: 'house', spheres: fusedBubbleSilhouette(HOUSE, houseSurface) });
  const ribs: THREE.Vector3[][] = [];
  for (let k = 0; k < 12; k++) {
    ribs.push(surfaceLine(houseSurface, { column: Math.round((k * houseSurface.columns) / 12) }, 0.02));
  }
  ribs.push(surfaceLine(houseSurface, { row: Math.round(houseSurface.rows * 0.5) }, 0.02));
  for (const pts of ribs) {
    const above = pts.filter((p) => p.y > T - 0.05);
    if (above.length < 4) continue;
    const curve = new THREE.CatmullRomCurve3(above, false, 'centripetal');
    addBrass(new THREE.TubeGeometry(curve, above.length * 2, 0.028, 6, false), new THREE.Matrix4());
  }
  // spiral stair: pole, helical rail, radial treads
  const stair = { x: 0.6, z: -12.8, radius: 1.1, rise: 3.6, turns: 2.2 };
  addBrass(
    new THREE.CylinderGeometry(0.05, 0.05, stair.rise + 0.4, 12),
    at(stair.x, T + (stair.rise + 0.4) / 2, stair.z),
  );
  const helix: THREE.Vector3[] = [];
  for (let i = 0; i <= 120; i++) {
    const s = i / 120;
    const a = s * stair.turns * Math.PI * 2;
    helix.push(
      new THREE.Vector3(
        stair.x + Math.cos(a) * stair.radius,
        T + 0.9 + s * stair.rise,
        stair.z + Math.sin(a) * stair.radius,
      ),
    );
  }
  addBrass(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 240, 0.025, 6), new THREE.Matrix4());
  for (let i = 0; i < 36; i++) {
    const s = (i + 0.5) / 36;
    const a = s * stair.turns * Math.PI * 2;
    const tread = new THREE.Matrix4()
      .makeTranslation(
        stair.x + Math.cos(a) * stair.radius * 0.5,
        T + s * stair.rise,
        stair.z + Math.sin(a) * stair.radius * 0.5,
      )
      .multiply(new THREE.Matrix4().makeRotationY(-a))
      .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    addBrass(new THREE.CylinderGeometry(0.03, 0.03, stair.radius, 8), tread);
  }
  // hanging milky lamp
  addBrass(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 8), at(-1.0, T + 4.75, -12.2));
  milkyGlobe('lamp-house', 0.42, -1.0, T + 3.8, -12.2);

  // Milky street lamps flanking the dais
  for (const side of [-1, 1]) {
    const lx = side * 5.4;
    const lz = -6.6;
    addBrass(new THREE.CylinderGeometry(0.14, 0.18, 0.04, 32), at(lx, 0.02, lz));
    addBrass(new THREE.CylinderGeometry(0.025, 0.035, 2.8, 12), at(lx, 1.4, lz));
    addBrass(new THREE.TorusGeometry(0.16, 0.012, 8, 48), at(lx, 2.84, lz).multiply(flat));
    milkyGlobe(`lamp-${side < 0 ? 'west' : 'east'}`, 0.3, lx, 3.08, lz);
  }

  // Far towers: cheap path on low/mid, transmission on high
  for (const f of FAR) {
    const [x, z] = polar(f.angle, f.distance);
    const bubbles = farTower(x, z, f.scale, f.variant);
    const surface = buildFusedBubbleSurface(bubbles, { blend: 1.2 * f.scale, columns: 64, rows: 40 });
    const material = register(f.id, f.kind, 'far', 'scenery', {
      thickness: 0.06,
      thicknessScale: 2.5 * f.scale,
    });
    scene.add(new THREE.Mesh(own(fusedBubbleGeometry(surface)), material));
    silhouettes.set(f.id, { id: f.id, spheres: fusedBubbleSilhouette(bubbles, surface) });
  }

  const brassMesh = new THREE.Mesh(own(mergeGeometries(brassParts)), brass);
  for (const g of brassParts) g.dispose();
  brassMesh.castShadow = true;
  scene.add(brassMesh);

  // Silhouettes of the specimens from their world bounds.
  scene.updateMatrixWorld(true);
  const sphere = new THREE.Sphere();
  for (const { id, mesh, margin } of specimenMeshes) {
    mesh.geometry.computeBoundingSphere();
    sphere.copy(mesh.geometry.boundingSphere as THREE.Sphere).applyMatrix4(mesh.matrixWorld);
    silhouettes.set(id, { id, spheres: [{ ...sphere.center, r: sphere.radius + margin }] });
  }

  // --- environment: the plaza itself, captured near the specimens (光と時間帯: ガラスに街そのものが映る) ---
  const envScene = new THREE.Scene();
  const skyMat = own(new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false }));
  skyMat.colorNode = skyNode(positionLocal.normalize());
  envScene.add(new THREE.Mesh(own(new THREE.SphereGeometry(150, 48, 24)), skyMat));
  const envSun = sun.clone();
  envSun.castShadow = false;
  envScene.add(envSun, new THREE.HemisphereLight(SKY.zenith, SKY.ground, 1.2));
  for (const o of [floor, terrace, brassMesh, wall, ...opaqueGlass]) envScene.add(o.clone());
  envScene.fog = scene.fog;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = own(
    pmrem.fromScene(envScene, 0.02, 0.1, 200, { position: new THREE.Vector3(0, 1.2, 2.5) }),
  );
  pmrem.dispose(); // its ping-pong targets and blur material are only needed for the capture
  scene.environment = envTarget.texture;

  // --- sensors ---
  const transmissive = glassEntries.filter((g) => g.path === 'transmission');
  const scratch = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.05, 300);
  const pos = new THREE.Vector3();
  const target = new THREE.Vector3();
  const sightlines = (aspect: number) => {
    const samples = 80;
    const overlaps: { t: number; front: string; back: string }[] = [];
    const objects = transmissive.map((g) => silhouettes.get(g.id)).filter((s): s is GlassSilhouette => !!s);
    scratch.aspect = aspect;
    scratch.updateProjectionMatrix();
    for (let i = 0; i < samples; i++) {
      const t = (i / samples) * PERIOD;
      cameraPose(t, pos, target);
      scratch.position.copy(pos);
      scratch.lookAt(target);
      scratch.updateMatrixWorld();
      const found = findTransmissionOverlaps(objects, {
        viewMatrix: scratch.matrixWorldInverse.elements,
        tanHalfFovY: Math.tan(THREE.MathUtils.degToRad(FOV / 2)),
        aspect,
        near: scratch.near,
      });
      for (const o of found) overlaps.push({ t, front: o.front, back: o.back });
    }
    return { samples, period: PERIOD, overlaps };
  };

  const probe = {
    frames: 0,
    t: 0,
    glass: glassEntries,
    nearTransmissive: transmissive.filter((g) => g.placement === 'near').length,
    sightlines: sightlines(camera.aspect),
  };
  Object.assign(window.__vidro.sceneProbe, probe);
  const sceneProbe = window.__vidro.sceneProbe as typeof probe;

  return {
    scene,
    camera,
    update(_dt, t) {
      const tt = frozenAt ?? t;
      cameraPose(tt, camera.position, target);
      camera.lookAt(target);
      if (floating) floating.mesh.position.y = floating.baseY + 0.025 * Math.sin(tt * 1.3);
      sceneProbe.frames++;
      sceneProbe.t = tt;
    },
    resize(width, height) {
      sceneProbe.sightlines = sightlines(width / Math.max(1, height));
    },
    dispose() {
      for (const d of disposables) d.dispose();
      sun.shadow.dispose();
      renderer.shadowMap.enabled = previousShadowMap.enabled;
      renderer.shadowMap.type = previousShadowMap.type;
    },
  };
};

export default create;
