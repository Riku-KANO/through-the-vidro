import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  dot,
  exp,
  float,
  mix,
  normalize,
  normalView,
  positionLocal,
  positionView,
  pow,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { SceneFactory } from '../core/scene';
import { segment } from '../core/transition';
import { AudioGate } from '../ui/audio-gate';
import { AUTOPLAY, parsePauseSpec } from '../ui/autoplay';
import { ScreenFlow, TRANSITIONS } from '../ui/flow';
import { diveChoreography, HOME_COMPOSITION, openingChoreography } from '../ui/home/choreography';
import { createLensUniforms } from '../ui/home/lens';
import { createMembrane } from '../ui/home/membrane';
import { HomeMenu } from '../ui/home/menu';
import { HOME_ITEMS, menuPitchHz } from '../ui/home/menu-logic';
import { createMist } from '../ui/home/mist';
import { createHomeOrb } from '../ui/home/orb';
import { pickLang, STRINGS, type StringKey } from '../ui/lang';
import { LoadingScreen } from '../ui/loading-screen';
import type { HomeDiveProbe, PhaseName } from '../ui/probe';
import { createUiRoot } from '../ui/styles';

export const title = 'S-04 loading → home → dive into the orb (?autoplay=1 plays the script)';

/** 操作とカメラ > カメラ: 目の高さ1.6m、視野角70度 */
const EYE_HEIGHT = 1.6;
const GAME_FOV = 70;
/** Game camera field of view while it shows the miniature city inside the home orb. M0 tuning value. */
const MINIATURE_FOV = 44;
const TILT_SMOOTH_SECONDS = 0.4;

// ---------------------------------------------------------------------------------------------
// Placeholder game world: the city as bubbles, the workshop (序章「工房」) at its edge.
// S-06 replaces this with the prologue scene; the home orb always shows whatever this scene is.
// ---------------------------------------------------------------------------------------------

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

interface GameWorld {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Game camera pose along the dive (0 = the miniature view, 1 = standing in the workshop). */
  pose(u: number, outPos: THREE.Vector3, outTarget: THREE.Vector3): void;
  /** Point the miniature view turns around when the orb tilts. */
  pivot: THREE.Vector3;
  skyScene: THREE.Scene;
  dispose(): void;
}

function createGameWorld(): GameWorld {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const up = new THREE.Vector3(0, 1, 0);
  // 序章「工房」: 街外れの吹きガラス工房。夜明け前の青 (進行構造とエリア設計, 光と時間帯)
  const W = new THREE.Vector3(Math.sin(0.62) * 28, 0, Math.cos(0.62) * 28);
  const f = W.clone().setY(0).normalize().negate(); // workshop → city centre
  const side = new THREE.Vector3().crossVectors(f, up).normalize();
  const at = (fwd: number, s: number, h: number): THREE.Vector3 =>
    W.clone().addScaledVector(f, fwd).addScaledVector(side, s).addScaledVector(up, h);

  // sky: pre-dawn blue with a faint glow low over the city (the way the player looks when standing)
  const dawn = f.clone().setY(0.08).normalize();
  const skyMat = keep(
    new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  {
    const d = normalize(positionLocal);
    const zenith = vec3(0.012, 0.03, 0.085);
    const horizon = vec3(0.3, 0.38, 0.5);
    const below = vec3(0.12, 0.15, 0.2);
    const h = d.y;
    const skyCol = mix(horizon, zenith, pow(smoothstep(0, 1, h.max(0)), 0.55));
    const glowAmt = pow(dot(d, vec3(dawn.x, dawn.y, dawn.z)).max(0), 6).mul(exp(abs(h).mul(-6)));
    skyMat.colorNode = mix(below, skyCol, smoothstep(-0.08, 0.02, h)).add(vec3(0.42, 0.3, 0.26).mul(glowAmt));
  }
  const skyGeo = keep(new THREE.SphereGeometry(500, 48, 24));
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(keep(new THREE.SphereGeometry(50, 32, 16)), skyMat));

  const fog = new THREE.Fog(new THREE.Color(0.3, 0.38, 0.5), 45, 230);
  scene.fog = fog;
  scene.add(new THREE.HemisphereLight(0xa9c1de, 0x2a313d, 1.7));
  const moon = new THREE.DirectionalLight(0xe2e8ff, 1.2);
  moon.position.copy(at(120, -40, 45));
  moon.target.position.copy(W);
  scene.add(moon, moon.target);

  // ground: pale stone, fades into the fog at the edge of the city
  const groundMat = keep(
    new THREE.MeshStandardNodeMaterial({ color: 0x8796a4, roughness: 0.93, metalness: 0 }),
  );
  const ground = new THREE.Mesh(keep(new THREE.CircleGeometry(160, 96)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const brass = keep(new THREE.MeshStandardNodeMaterial({ color: 0xb08d57, metalness: 1, roughness: 0.34 }));

  // cheap far glass: reflections + fresnel opacity, no transmission (品質プリセット: 遠景のガラスは安価な表現)
  const cheapGlass = (color: number, rim: number): THREE.MeshStandardNodeMaterial => {
    const m = keep(
      new THREE.MeshStandardNodeMaterial({
        color,
        roughness: 0.06,
        metalness: 0,
        transparent: true,
        depthWrite: false,
      }),
    );
    const facing = abs(dot(normalView, positionView.normalize().negate()));
    const fres = pow(float(1).sub(facing), 2.2);
    m.opacityNode = mix(float(0.2), float(0.88), fres);
    m.emissiveNode = vec3(0.32, 0.42, 0.5).mul(fres.mul(rim));
    return m;
  };

  // the city: bubble clusters (形のルール: 建物は泡の集合) around the lighthouse
  const rand = rng(20261021);
  const bubbles: { p: THREE.Vector3; r: number }[] = [];
  const clusters = 26;
  for (let k = 0; k < clusters; k++) {
    const a = (k / clusters) * Math.PI * 2 + rand() * 0.2;
    const rad = 11 + rand() * 25;
    const c = new THREE.Vector3(Math.sin(a) * rad, 0, Math.cos(a) * rad);
    if (c.distanceTo(W) < 11) continue;
    const main = 2.2 + rand() * 2.6;
    const count = 2 + Math.floor(rand() * 4);
    bubbles.push({ p: c.clone().setY(main * (0.3 + rand() * 0.25)), r: main });
    for (let i = 0; i < count; i++) {
      const r = main * (0.35 + rand() * 0.45);
      const o = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5)
        .normalize()
        .multiplyScalar(main * (0.55 + rand() * 0.4));
      bubbles.push({
        p: c
          .clone()
          .add(o)
          .setY(r * (0.3 + rand() * 0.7) + (rand() < 0.3 ? main * 0.7 : 0)),
        r,
      });
    }
  }
  // the lighthouse (灯塔): stacked bubbles, a brass spire, the great orb on top
  const tower = [
    [4.2, 2.0],
    [3.1, 6.1],
    [2.3, 9.3],
    [1.7, 11.9],
  ] as const;
  for (const [r, y] of tower) bubbles.push({ p: new THREE.Vector3(0, y, 0), r });
  // draw far → near as seen from the miniature view, so the transparent bubbles blend in order
  const viewFrom = at(-99, 0, 79.5);
  bubbles.sort((x, y) => y.p.distanceToSquared(viewFrom) - x.p.distanceToSquared(viewFrom));
  const bubbleGeo = keep(new THREE.SphereGeometry(1, 32, 20));
  const city = new THREE.InstancedMesh(bubbleGeo, cheapGlass(0xdce8f0, 0.9), bubbles.length);
  const m4 = new THREE.Matrix4();
  const noTurn = new THREE.Quaternion();
  bubbles.forEach((b, i) => {
    city.setMatrixAt(i, m4.compose(b.p, noTurn, new THREE.Vector3(b.r, b.r, b.r)));
  });
  city.computeBoundingSphere();
  scene.add(city);
  // brass rings where the bubbles meet the ground
  const grounded = bubbles.filter((b) => b.p.y < b.r * 0.95 && b.p.y > 0);
  const ringGeo = keep(new THREE.TorusGeometry(1, 0.02, 6, 64));
  const rings = new THREE.InstancedMesh(ringGeo, brass, grounded.length);
  const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  grounded.forEach((b, i) => {
    const rr = Math.sqrt(b.r * b.r - b.p.y * b.p.y);
    rings.setMatrixAt(
      i,
      m4.compose(new THREE.Vector3(b.p.x, 0.04, b.p.z), flat, new THREE.Vector3(rr, rr, rr * 3)),
    );
  });
  rings.computeBoundingSphere();
  scene.add(rings);
  const spire = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.16, 0.3, 4.4, 12)), brass);
  spire.position.set(0, 14.6, 0);
  scene.add(spire);
  const great = new THREE.Mesh(keep(new THREE.SphereGeometry(2.5, 48, 32)), cheapGlass(0xeaf3f8, 1.6));
  great.position.set(0, 19.2, 0);
  scene.add(great);
  const greatRing = new THREE.Mesh(keep(new THREE.TorusGeometry(2.75, 0.05, 8, 96)), brass);
  greatRing.position.copy(great.position);
  greatRing.rotation.set(1.2, 0.3, 0);
  scene.add(greatRing);

  // the workshop: a glass dome with an open oculus, brass ribs, a workbench, a furnace, a milk-glass lamp
  const domeCentre = at(0, 0, 1);
  const domeR = 6;
  const oculus = 0.2;
  const domeGeo = keep(
    new THREE.SphereGeometry(domeR, 72, 36, 0, Math.PI * 2, oculus, Math.PI / 2 + 0.2 - oculus),
  );
  const domeMat = cheapGlass(0xe4eef4, 0.6);
  domeMat.side = THREE.DoubleSide;
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.position.copy(domeCentre);
  scene.add(dome);
  {
    const ribs: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 24; j++) {
        const phi = oculus + ((Math.PI / 2 + 0.18 - oculus) * j) / 24;
        pts.push(new THREE.Vector3(Math.sin(phi) * domeR, Math.cos(phi) * domeR, 0));
      }
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.04, 6, false);
      // keep the ribs off the line of sight from the bench to the lighthouse
      g.rotateY(Math.atan2(-f.z, f.x) + Math.PI / 8 + (i / 8) * Math.PI * 2);
      ribs.push(g);
    }
    const ribGeo = keep(mergeGeometries(ribs));
    for (const g of ribs) g.dispose();
    const ribMesh = new THREE.Mesh(ribGeo, brass);
    ribMesh.position.copy(domeCentre);
    scene.add(ribMesh);
    const ocR = Math.sin(oculus) * domeR;
    const ocRing = new THREE.Mesh(keep(new THREE.TorusGeometry(ocR, 0.06, 8, 48)), brass);
    ocRing.position.copy(domeCentre).add(new THREE.Vector3(0, Math.cos(oculus) * domeR, 0));
    ocRing.rotation.x = Math.PI / 2;
    scene.add(ocRing);
    const baseR = Math.sqrt(domeR * domeR - 1);
    const baseRing = new THREE.Mesh(keep(new THREE.TorusGeometry(baseR, 0.07, 8, 96)), brass);
    baseRing.position.copy(W).setY(0.05);
    baseRing.rotation.x = Math.PI / 2;
    scene.add(baseRing);
    const floor = new THREE.Mesh(
      keep(new THREE.CircleGeometry(baseR, 64)),
      keep(new THREE.MeshStandardNodeMaterial({ color: 0xa3afb9, roughness: 0.55, metalness: 0 })),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.copy(W).setY(0.02);
    scene.add(floor);
  }
  const wood = keep(new THREE.MeshStandardNodeMaterial({ color: 0x5f4a3b, roughness: 0.78, metalness: 0 }));
  const bench = new THREE.Group();
  const top = new THREE.Mesh(keep(new RoundedBoxGeometry(2.6, 0.1, 0.95, 3, 0.04)), wood);
  top.position.y = 0.9;
  bench.add(top);
  for (const sx of [-1.05, 1.05]) {
    const leg = new THREE.Mesh(keep(new RoundedBoxGeometry(0.12, 0.86, 0.78, 2, 0.04)), wood);
    leg.position.set(sx, 0.43, 0);
    bench.add(leg);
  }
  const pipe = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.018, 0.018, 1.5, 8)), brass);
  pipe.rotation.z = Math.PI / 2 - 0.08;
  pipe.position.set(-0.15, 0.97, 0.28);
  bench.add(pipe);
  // a few blown vessels on the bench: near transmission glass, kept to a handful (性能の目標と予算)
  const vesselMat = keep(
    new THREE.MeshPhysicalNodeMaterial({
      color: 0xffffff,
      roughness: 0,
      metalness: 0,
      transmission: 1,
      ior: 1.5,
      thickness: 0.08,
      attenuationColor: new THREE.Color(0xdaf2e6),
      attenuationDistance: 0.5,
    }),
  );
  const profiles: [number, number][][] = [
    [
      [0.001, 0],
      [0.13, 0.02],
      [0.16, 0.12],
      [0.12, 0.24],
      [0.05, 0.3],
      [0.045, 0.42],
      [0.06, 0.44],
    ],
    [
      [0.001, 0],
      [0.09, 0.01],
      [0.15, 0.09],
      [0.14, 0.18],
      [0.06, 0.24],
      [0.04, 0.36],
    ],
    [
      [0.001, 0],
      [0.07, 0.005],
      [0.09, 0.12],
      [0.06, 0.3],
      [0.08, 0.52],
      [0.1, 0.56],
    ],
  ];
  [-0.75, -0.2, 0.62].forEach((x, i) => {
    const prof = profiles[i % profiles.length] ?? [];
    const g = keep(
      new THREE.LatheGeometry(
        prof.map(([px, py]) => new THREE.Vector2(px, py)),
        40,
      ),
    );
    const v = new THREE.Mesh(g, vesselMat);
    v.position.set(x, 0.95, -0.12 + (i % 2) * 0.12);
    bench.add(v);
  });
  bench.position.copy(at(1.7, 0.2, 0));
  bench.lookAt(bench.position.clone().add(f));
  scene.add(bench);

  const furnace = new THREE.Group();
  const kiln = new THREE.Mesh(
    keep(new THREE.SphereGeometry(1.05, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2)),
    keep(new THREE.MeshStandardNodeMaterial({ color: 0x4a4440, roughness: 0.9, metalness: 0 })),
  );
  kiln.scale.set(1, 1.2, 1);
  furnace.add(kiln);
  const mouth = new THREE.Mesh(
    keep(new THREE.CircleGeometry(0.3, 32)),
    keep(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(3.2, 1.4, 0.45) })),
  );
  mouth.position.set(0, 0.5, 1.07);
  mouth.rotation.x = -0.2;
  furnace.add(mouth);
  const fire = new THREE.PointLight(0xff8a40, 18, 9, 2);
  fire.position.set(0, 0.7, 1.3);
  furnace.add(fire);
  furnace.position.copy(at(2.4, -3.3, 0));
  furnace.lookAt(at(-0.5, 0, 0).setY(0));
  scene.add(furnace);

  const lamp = new THREE.Mesh(
    keep(new THREE.SphereGeometry(0.2, 32, 16)),
    keep(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(2.4, 2.1, 1.7) })),
  );
  lamp.position.copy(at(0.2, 3.1, 2.6));
  scene.add(lamp);
  const lampRod = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.01, 0.01, 2.0, 6)), brass);
  lampRod.position.copy(lamp.position).add(new THREE.Vector3(0, 1.1, 0));
  scene.add(lampRod);
  const lampLight = new THREE.PointLight(0xffe0b8, 6, 9, 2);
  lampLight.position.copy(lamp.position);
  scene.add(lampLight);

  // the dive path: from the miniature view over the city, down through the oculus, to standing at the bench
  const posCurve = new THREE.CatmullRomCurve3(
    [at(-99, 0, 79.5), at(-38, 1.5, 33), at(-0.5, 0.1, 10.2), at(-1.1, 0.1, 3.7), at(-1.8, 0.25, EYE_HEIGHT)],
    false,
    'centripetal',
  );
  const lookCurve = new THREE.CatmullRomCurve3(
    [new THREE.Vector3(0, 2, 0), at(9, 0, 0), at(3.5, 0, -2.2), at(6, 0, 0.9), at(8, 0, 1.4)],
    false,
    'centripetal',
  );

  const camera = new THREE.PerspectiveCamera(MINIATURE_FOV, 1, 0.05, 1200);

  return {
    scene,
    camera,
    skyScene,
    pivot: new THREE.Vector3(0, 0, 0),
    pose(u, outPos, outTarget) {
      const t = Math.min(1, Math.max(0, u));
      posCurve.getPoint(t, outPos);
      lookCurve.getPoint(t, outTarget);
      // the haze is set for standing in the town; seen from afar (the miniature) it moves out with the camera
      const away = Math.max(0, outPos.length() - 40);
      fog.near = 45 + away;
      fog.far = 230 + away * 1.6;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      city.dispose();
      rings.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------

const create: SceneFactory = async ({ renderer, overlay, params }) => {
  const autoplay = params.get('autoplay') === '1' ? 'full' : params.has('bench') ? 'home' : 'off';
  const pauses = autoplay === 'full' ? parsePauseSpec(params.get('pause')) : new Map<string, number[]>();
  const lang = pickLang(navigator.languages);
  const t = (k: StringKey): string => STRINGS[lang][k];

  const world = createGameWorld();
  const gameCam = world.camera;

  // the game scene is drawn into this image, which the orb (and later the whole screen) shows
  const drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const innerRT = new THREE.RenderTarget(Math.max(1, drawSize.x), Math.max(1, drawSize.y), {
    type: THREE.HalfFloatType,
    depthBuffer: true,
  });

  // home scene: background, orb (added when compiled), the dive's full-screen image, the fog
  const home = new THREE.Scene();
  const orbScreen = uniform(new THREE.Vector2(0.44, 0.5));
  {
    const y = screenUV.y;
    const top = vec3(0.003, 0.008, 0.028);
    const mid = vec3(0.06, 0.095, 0.15);
    const low = vec3(0.025, 0.035, 0.055);
    const aspect = screenSize.x.div(screenSize.y);
    const d = screenUV.sub(orbScreen).mul(vec2(aspect, 1));
    const halo = exp(dot(d, d).mul(-4.5)).mul(vec3(0.11, 0.15, 0.2));
    home.backgroundNode = mix(mix(top, mid, smoothstep(0, 0.62, y)), low, smoothstep(0.62, 1, y)).add(halo);
  }
  const outerCam = new THREE.PerspectiveCamera(HOME_COMPOSITION.fovDeg, 1, 0.01, 60);
  outerCam.position.set(0, 0, HOME_COMPOSITION.cameraDistance);
  const lens = createLensUniforms();
  const orb = createHomeOrb(innerRT.texture, lens);
  const membrane = createMembrane(innerRT.texture, lens);
  const mist = createMist();
  home.add(mist.mesh);
  const late = new THREE.Group();
  late.add(orb.group, membrane.mesh);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTargets: THREE.RenderTarget[] = [];
  const ui = createUiRoot(overlay, lang);
  const gate = new AudioGate();
  if (autoplay !== 'off') gate.skip();
  const flow = new ScreenFlow();

  // ---- probe ----
  const probe: HomeDiveProbe = {
    screen: 'loading',
    transition: null,
    load: { progress: 0, fill: 0, ready: false, seconds: 0, steps: [] },
    audio: gate.state,
    focused: null,
    hovered: null,
    selected: null,
    tilt: { x: 0, y: 0 },
    tiltMax: HOME_COMPOSITION.tiltMax,
    dive: { cameraDistance: HOME_COMPOSITION.cameraDistance, fullscreen: 0, distortion: 0, inner: 0 },
    paused: null,
    release: false,
    phases: {},
  };
  window.__vidro.sceneProbe = probe as unknown as Record<string, unknown>;

  // ---- screens ----
  const startOpening = (byUser: boolean): void => {
    if (!flow.start()) return;
    if (byUser) gate.unlock(); // inside the click / key handler: the browser now lets us play sound
    loading.press();
    gate.ping(menuPitchHz(0), 0.05, 1.4);
    gate.ping(menuPitchHz(3), 0.03, 1.6);
  };
  const loading = new LoadingScreen(ui.root, t, () => startOpening(true));
  const menu = new HomeMenu(ui.root, t, {
    onFocus: (_item, index) => gate.ping(menuPitchHz(index), 0.035, 0.8),
    onSelect: (item) => {
      probe.selected = item;
      if (flow.select(item)) gate.ping(menuPitchHz(0) / 2, 0.05, 1.8);
      else gate.ping(menuPitchHz(HOME_ITEMS.indexOf(item)) / 2, 0.03, 0.5);
    },
  });

  // Esc is always accepted during long transitions (遷移のルール 4) and plays them back.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (flow.escape()) gate.ping(menuPitchHz(4) / 2, 0.03, 0.7);
    else if (flow.rewindFromGame()) gate.ping(menuPitchHz(0) / 2, 0.04, 1.2);
  };
  window.addEventListener('keydown', onKey);

  // mouse tilt target (−1..1)
  const mouse = new THREE.Vector2();
  const onMove = (e: PointerEvent): void => {
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  };
  window.addEventListener('pointermove', onMove);

  // ---- loading: build environment maps, compile every pipeline while the vessel fills ----
  let orbReady = false;
  let gameReady = false;
  let warmInner = false;
  const loadStart = performance.now();
  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
  const steps = 5;
  let stepsDone = 0;
  const progressOf = (e: ProgressEvent): void => {
    probe.load.progress = (stepsDone + (e.total ? e.loaded / e.total : 0)) / steps;
  };
  let stepStart = performance.now();
  let stepMaxFrame = 0;
  const done = (name: string): void => {
    stepsDone++;
    probe.load.progress = stepsDone / steps;
    const now = performance.now();
    probe.load.steps.push({ name, seconds: (now - stepStart) / 1000, maxFrameMs: stepMaxFrame });
    stepStart = now;
    stepMaxFrame = 0;
  };
  const compileWith = async (
    target: THREE.RenderTarget | null,
    object: THREE.Object3D,
    camera: THREE.Camera,
    scene: THREE.Scene,
    showDuring: THREE.Object3D[] = [],
  ): Promise<void> => {
    // compileAsync collects objects synchronously; hidden ones are shown just for that moment
    const was = showDuring.map((o) => o.visible);
    for (const o of showDuring) o.visible = true;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    const p = renderer.compileAsync(object, camera, scene, progressOf);
    renderer.setRenderTarget(prev);
    showDuring.forEach((o, i) => {
      o.visible = was[i] ?? true;
    });
    await p;
  };
  const load = async (): Promise<void> => {
    await nextFrame();
    envTargets.push(pmrem.fromScene(world.skyScene, 0.02));
    world.scene.environment = envTargets[0]?.texture ?? null;
    const room = new RoomEnvironment();
    envTargets.push(pmrem.fromScene(room, 0.04));
    home.environment = envTargets[1]?.texture ?? null;
    room.dispose();
    done('environment maps');
    await compileWith(null, late, outerCam, home, [membrane.mesh]);
    home.add(late);
    orbReady = true;
    done('compile home orb');
    await compileWith(innerRT, world.scene, gameCam, world.scene);
    done('compile game (orb image)');
    await compileWith(null, world.scene, gameCam, world.scene);
    done('compile game (screen)');
    warmInner = true; // one real draw into the orb's image (transmission buffers etc.)
    await nextFrame();
    await nextFrame();
    warmInner = false;
    gameReady = true;
    flow.setGameReady(true);
    done('first draw of the game');
    probe.load.seconds = (performance.now() - loadStart) / 1000;
    probe.load.ready = true;
    flow.markLoaded();
  };
  flow.setGameReady(false);
  load().catch((err: unknown) => {
    window.__vidro.errors.push(err instanceof Error ? err.message : String(err));
  });

  // ---- per frame ----
  const tilt = new THREE.Vector2();
  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const qAz = new THREE.Quaternion();
  const qEl = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0);
  const axisR = new THREE.Vector3();
  const orbCenter = new THREE.Vector3();
  let viewW = 1;
  let viewH = 1;
  let hadTransition = false;
  let loadingWasSeen = true;
  const trProbe: NonNullable<HomeDiveProbe['transition']> = {
    id: '',
    seconds: 0,
    elapsed: 0,
    progress: 0,
    value: 0,
    direction: 1,
    holding: false,
  };
  let lastTransition: unknown = null;
  let visited = new Set<number>();
  let paused: { id: string; at: number } | null = null;
  let dwell = 0;
  let dived = false;
  let elapsed = 0;
  let lastNow = performance.now();
  let lastPhase: PhaseName = 'loading';
  let firstFrameDrawn = false;

  const phaseOf = (): PhaseName => (flow.transition ? (flow.transition.spec.id as PhaseName) : flow.screen);

  /** Autoplay checkpoints: hand out just enough time to land exactly on the next one, then wait. */
  const feed = (dt: number): number => {
    const tr = flow.transition;
    if (tr !== lastTransition) {
      lastTransition = tr;
      visited = new Set();
      paused = null;
    }
    if (!tr) return dt;
    if (paused) {
      if (!probe.release) return 0;
      probe.release = false;
      paused = null;
    }
    const cps = tr.direction === 1 ? pauses.get(tr.spec.id) : undefined;
    if (!cps) return dt;
    for (const c of cps) {
      if (visited.has(c)) continue;
      const target = Math.min(c, tr.spec.seconds - 1e-4);
      if (tr.elapsed + dt >= target - 1e-9) {
        visited.add(c);
        paused = { id: tr.spec.id, at: c };
        return Math.max(0, target - tr.elapsed);
      }
      break;
    }
    return dt;
  };

  const runAutoplay = (dt: number): void => {
    if (autoplay === 'off' || flow.transition) return;
    if (flow.screen === 'loading' && flow.isLoaded && loading.full) {
      dwell += dt;
      if (dwell >= AUTOPLAY.loadingDwell) {
        dwell = 0;
        startOpening(false);
      }
    } else if (autoplay === 'full' && flow.screen === 'home' && !dived) {
      dwell += dt;
      if (dwell >= AUTOPLAY.homeDwell) {
        dwell = 0;
        dived = true;
        menu.press('start');
        probe.selected = 'start';
        flow.select('start');
      }
    }
  };

  const recordFrame = (): void => {
    const now = performance.now();
    const ms = now - lastNow;
    lastNow = now;
    if (!probe.load.ready) stepMaxFrame = Math.max(stepMaxFrame, ms);
    if (!firstFrameDrawn) return;
    const s = probe.phases[lastPhase] ?? { frames: 0, maxFrameMs: 0, maxDrawCalls: 0, maxTriangles: 0 };
    probe.phases[lastPhase] = s;
    s.frames++;
    s.maxFrameMs = Math.max(s.maxFrameMs, ms);
    s.maxDrawCalls = Math.max(s.maxDrawCalls, renderer.info.render.drawCalls);
    s.maxTriangles = Math.max(s.maxTriangles, renderer.info.render.triangles);
  };

  // several render passes per frame: count them all, reset once per frame in render()
  const prevAutoReset = renderer.info.autoReset;
  renderer.info.autoReset = false;

  return {
    scene: home,
    camera: outerCam,
    update(dt) {
      recordFrame();
      elapsed += dt;
      runAutoplay(dt);
      flow.update(feed(dt));
      const tr = flow.transition;

      // back at rest on the home screen (arrived, or played back there): the keyboard focus returns
      if (hadTransition && !tr && flow.screen === 'home')
        menu.focusItem(menu.focused ?? probe.selected ?? 'start');
      hadTransition = tr !== null;

      // where each transition stands
      const openingP =
        tr?.spec.id === TRANSITIONS.loadingToHome.id ? tr.value : flow.screen === 'loading' ? 0 : 1;
      const diveP = tr?.spec.id === TRANSITIONS.homeToGame.id ? tr.value : flow.screen === 'game' ? 1 : 0;
      const op = openingChoreography(openingP);
      const dv = diveChoreography(diveP);

      // tilt (mouse), fading out as the dive starts
      const k = 1 - Math.exp(-dt / TILT_SMOOTH_SECONDS);
      const tm = HOME_COMPOSITION.tiltMax;
      const interactiveHome = flow.screen === 'home' && !tr;
      tilt.x += ((interactiveHome ? THREE.MathUtils.clamp(mouse.x, -1, 1) * tm : tilt.x) - tilt.x) * k;
      tilt.y += ((interactiveHome ? THREE.MathUtils.clamp(mouse.y, -1, 1) * tm : tilt.y) - tilt.y) * k;
      const look = dv.homeLook;

      // outer camera and the orb
      outerCam.position.set(0, 0, dv.cameraDistance);
      const shift = HOME_COMPOSITION.lensShiftX * viewW * look;
      outerCam.setViewOffset(viewW, viewH, shift, 0, viewW, viewH);
      const pe = outerCam.projectionMatrix.elements;
      lens.proj.value.set(pe[0] ?? 1, pe[5] ?? 1);
      lens.refraction.value = dv.refraction;
      const rise = op.orbRise;
      orb.group.position.set(0, -1.6 * (1 - rise), -7.5 * (1 - rise));
      orb.group.rotation.set(tilt.y * look, tilt.x * look, 0);
      orb.group.visible = orbReady && dv.fullscreen < 1;
      membrane.mesh.visible = dv.fullscreen > 0;
      membrane.opacity.value = dv.fullscreen;
      membrane.cameraDistance.value = dv.cameraDistance;
      membrane.surface.value = dv.surface;
      membrane.ripple.value = dv.ripple;
      membrane.ringRadius.value = dv.ringRadius;

      // the fog: white-out while loading, the vessel's light spills into it, then it clears
      mist.fog.value = op.fog * (1 - segment(diveP, 0, 0.3));
      mist.glow.value =
        flow.screen === 'loading'
          ? 0.12 + 0.35 * loading.fill * (1 - op.overflow) + 1.6 * Math.sin(Math.PI * op.overflow)
          : 0;
      mist.glowSpread.value = 0.09 + 0.75 * op.overflow;
      mist.glowCenter.value.set(0.5, 0.445);
      mist.mesh.visible = mist.fog.value > 0.001 || mist.glow.value > 0.001;

      // game camera: from the miniature view (turning with the tilt) down into the workshop
      world.pose(dv.inner, camPos, camTarget);
      if (look > 0) {
        qAz.setFromAxisAngle(axisY, -tilt.x * 1.5 * look);
        tmpV.subVectors(camPos, world.pivot).applyQuaternion(qAz);
        axisR.crossVectors(axisY, tmpV).normalize();
        qEl.setFromAxisAngle(axisR, tilt.y * 1.5 * look);
        camPos.copy(world.pivot).add(tmpV.applyQuaternion(qEl));
      }
      gameCam.position.copy(camPos);
      gameCam.lookAt(camTarget);
      gameCam.fov = MINIATURE_FOV + (GAME_FOV - MINIATURE_FOV) * segment(dv.inner, 0.35, 0.92) ** 1.5;
      // same lens shift as the home camera, so the town sits in the middle of the orb
      if (look > 0) gameCam.setViewOffset(viewW, viewH, shift, 0, viewW, viewH);
      else gameCam.clearViewOffset();
      gameCam.updateProjectionMatrix();

      // DOM (the loading screen only while it can be seen, plus one more frame to hide it)
      const loadingSeen = flow.screen === 'loading' || tr?.spec.id === TRANSITIONS.loadingToHome.id;
      if (loadingSeen || loadingWasSeen) {
        loading.update(dt, {
          progress: probe.load.progress,
          ready: probe.load.ready,
          overflow: loadingSeen ? op.overflow : 1,
          interactive: flow.screen === 'loading' && !tr,
        });
      }
      loadingWasSeen = loadingSeen;
      menu.setInteractive(interactiveHome);
      orb.group.updateMatrixWorld();
      orbCenter.setFromMatrixPosition(orb.group.matrixWorld);
      outerCam.updateMatrixWorld();
      const d = orbCenter.distanceTo(outerCam.position);
      orbCenter.project(outerCam);
      const halfTan = Math.tan((HOME_COMPOSITION.fovDeg * Math.PI) / 360);
      const rPx =
        d > HOME_COMPOSITION.orbRadius
          ? (Math.tan(Math.asin(HOME_COMPOSITION.orbRadius / d)) / halfTan) * (viewH / 2)
          : viewH;
      orbScreen.value.set((orbCenter.x + 1) / 2, (1 - orbCenter.y) / 2);
      menu.update(dt, {
        cx: ((orbCenter.x + 1) / 2) * viewW,
        cy: ((1 - orbCenter.y) / 2) * viewH,
        r: rPx,
        appear: Math.min(op.menu, dv.menu),
        time: elapsed,
      });

      // probe
      probe.screen = flow.screen;
      if (tr) {
        trProbe.id = tr.spec.id;
        trProbe.seconds = tr.spec.seconds;
        trProbe.elapsed = tr.elapsed;
        trProbe.progress = tr.progress;
        trProbe.value = tr.value;
        trProbe.direction = tr.direction;
        trProbe.holding = tr.holding;
      }
      probe.transition = tr ? trProbe : null;
      probe.load.fill = loading.fill;
      probe.audio = gate.state;
      probe.focused = menu.focused;
      probe.hovered = menu.hovered;
      probe.tilt.x = tilt.x;
      probe.tilt.y = tilt.y;
      probe.dive.cameraDistance = dv.cameraDistance;
      probe.dive.fullscreen = dv.fullscreen;
      probe.dive.distortion = dv.distortion;
      probe.dive.inner = dv.inner;
      probe.paused = paused;
    },
    render() {
      renderer.info.reset();
      lastPhase = phaseOf();
      const tr = flow.transition;
      if (flow.screen === 'game' && !tr) {
        // standing in the workshop: the game scene is the whole picture now
        renderer.setRenderTarget(null);
        renderer.render(world.scene, gameCam);
      } else {
        const orbOnScreen = orbReady && (flow.screen !== 'loading' || tr !== null);
        if (gameReady ? orbOnScreen : warmInner) {
          renderer.setRenderTarget(innerRT);
          renderer.render(world.scene, gameCam);
        }
        renderer.setRenderTarget(null);
        renderer.render(home, outerCam);
      }
      if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        loading.hideBackdrop();
      }
    },
    resize(width, height) {
      viewW = width;
      viewH = height;
      gameCam.aspect = width / Math.max(1, height);
      gameCam.updateProjectionMatrix();
      renderer.getDrawingBufferSize(drawSize);
      innerRT.setSize(Math.max(1, drawSize.x), Math.max(1, drawSize.y));
      menu.invalidate();
    },
    dispose() {
      renderer.info.autoReset = prevAutoReset;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onMove);
      loading.dispose();
      menu.dispose();
      ui.dispose();
      gate.dispose();
      orb.dispose();
      membrane.dispose();
      mist.dispose();
      world.dispose();
      innerRT.dispose();
      pmrem.dispose();
      for (const rt of envTargets) rt.dispose();
    },
  };
};

export default create;
