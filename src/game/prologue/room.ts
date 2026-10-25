import * as THREE from 'three/webgpu';
import { readsBackdrop, withGlassUnculled } from '../../core/glass';
import type { SceneContext } from '../../core/scene';
import type { FieldSphere } from '../../layers/field';
import { LayerField } from '../../layers/field';
import { segmentsUnder, type Vec3 } from '../../layers/footing';
import { boundaryGlow, MAIN_ORB_RADIUS, materializedRadius } from '../../layers/materialize';
import { SURFACE_SEGMENT, splitSurface } from '../../layers/surface';
import { glassEase } from '../../layers/tween';
import { type AreaAsset, addAssetColliders, loadAreaAsset } from '../assets';
import type { DiveWorld } from '../dive-world';
import { type InputEvent, InputSystem } from '../input/input-system';
import { HAND_ORB_RADIUS, handOrbCenter, orbScreenCircle } from '../orb/hand-pose';
import { peekMoveSpeedMultiplier } from '../orb/peek';
import { finishModeFrom, PeekPipeline } from '../orb/peek-pipeline';
import { EYE_HEIGHT, FOV_DEFAULT } from '../player/constants';
import { createWorld, initPhysics } from '../player/physics';
import { PlayerController, type PlayerIntent } from '../player/player';
import type { Autopilot } from './autopilot';
import { createDivePath } from './dive-path';
import { EventBus, eventName, type PrologueEvent } from './events';
import { buildFinale, gateAngle, settleGlow } from './finale';
import {
  BENCH_ORB,
  BRIDGE,
  BRIDGE_SETTLE,
  bridgeFooting,
  COMPASS,
  DROP,
  DROP_REACH,
  EAST_ROAD_END_X,
  EDGE_Z,
  FACING_DEG,
  FAR,
  GATE,
  GATE_OPEN_DEG,
  groundHeight,
  LIGHTHOUSE,
  LIGHTHOUSE_HEIGHT,
  lookDirection,
  MEMBRANE,
  PEDESTAL_ID,
  PEDESTAL_ORB,
  PLAZA,
  plazaGateAt,
  REACH,
  ROAD,
  SLOPE,
  SPAWNS,
  type SpawnName,
  TRIAL_SURFACE_WALL,
  WORKSHOP_ASSET,
  WORKSHOP_OBJECTS,
} from './layout';
import {
  addRoomColliders,
  BackFooting,
  deckSegmentShape,
  FallGuard,
  GateLeaves,
  insideAnySphere,
  SurfaceColliders,
  withMembrane,
} from './physics';
import { buildPlaza, fogRangeAt } from './plaza';
import { buildRoomArt } from './room-art';
import {
  type FinaleEvent,
  finaleFront,
  type InteractTarget,
  PrologueSession,
  peekModifier,
  SHAKE_AMPLITUDE,
} from './session';
import { buildSlope, slopeGroundNode } from './slope';
import { pickTarget, type TargetCandidate } from './targets';

/**
 * 序章「工房」, playable: S-03's body and input, S-02's layers, orb and peek pipeline, S-01's glass, glued by
 * the prologue session. Plays as a DiveWorld inside S-04's home → dive (createHomeDive), or on its own.
 */
export interface RoomOptions {
  spawn: SpawnName;
  /** Where the vidro starts. The prologue starts with it on the workbench. */
  orbStart: 'bench' | 'hand';
  peekMode: 'hold' | 'toggle';
  /** ?peek=hold: keep peeking (heaviest view, for measuring). */
  forcePeek: boolean;
  /** Dev switches for exact screenshots: freeze the peek amount / the growth of a placed orb (0..1). */
  peekHold: number | null;
  growHold: number | null;
  /** Scripted play (?autoplay=1). */
  autopilot: Autopilot | null;
  /** Language of the prompts (the scene picks it from the browser: 英語版 > 言語の初期値). */
  lang: 'ja' | 'en';
}

export type TargetKind = 'bench' | 'pedestal' | 'drop';

/** What the room publishes on window.__vidro.sceneProbe.room (tests/e2e/S-06-*.spec.ts). */
export interface RoomProbe {
  ready: boolean;
  playing: boolean;
  /** Scene clock, seconds. */
  time: number;
  position: { x: number; y: number; z: number };
  grounded: boolean;
  speed: number;
  /** Metres walked on the ground, and the footfalls in them (S-22: a footstep sounds when this goes up). */
  walked: number;
  footfalls: number;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  fov: number;
  locked: boolean;
  peeking: boolean;
  peekAmount: number;
  /** Walking speed multiplier from the peek (S-03 modifiers). */
  moveSpeed: number;
  orb: 'bench' | 'hand' | 'pedestal';
  pedestal: string | null;
  handPresence: number;
  /** Radius of the main orb's materialized sphere (0 when none). */
  sphereRadius: number;
  /** Back-layer footing colliders switched on, out of all of them. */
  bridgeColliders: number;
  bridgeSegments: number;
  onBackFooting: boolean;
  shaking: boolean;
  target: TargetKind | null;
  drop: 'waiting' | 'flying' | 'taken';
  dropTaken: boolean;
  dropMaterialized: boolean;
  /** The last events, e.g. 'pickup:bench', 'peekStart', 'shake:peek', 'dropTaken'. */
  events: string[];
  lastAction: string | null;
  backPassFrames: number;
  /** Render counters of the last frame (all passes). */
  drawCalls: number;
  /** Times the fall guard had to put the body back (must stay 0: 落下死はない should hold without it). */
  fallRescues: number;
  triangles: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  /**
   * The script's step, whether it is done, and (S-34 review: where a long frame falls) the longest frame of the play so
   * far, in which step it fell and when (room clock), and the longest frame of each step. A frame is the time between two
   * updates of the room while it is played, so it counts the rendering of the frame before; it is put down to the step
   * that frame was in.
   */
  autoplay: {
    step: string;
    done: boolean;
    worstMs: number;
    worstStep: string;
    worstAt: number;
    steps: Record<string, number>;
  } | null;
  /** S-34: the close — the drop's light settling the bridge, the gate opening (as drawn and collided now). */
  finale: FinaleProbe;
  /**
   * S-35: the film at the slope's entrance — whether it holds the body now (the vidro not in hand, on the shore's side),
   * how much it shows (0..1) and how much the vidro left behind is calling (0..1, its faint glow).
   */
  membrane: { holding: boolean; film: number; call: number };
  layout: {
    edgeZ: number;
    farZ: number;
    pedestalOrb: Vec3;
    drop: Vec3;
    /** S-34: the gate and the road's end past it (S-35: the slope's brow). */
    gateZ: number;
    roadEndZ: number;
    /** S-35: the film (in the gate's arch), the slope's foot, the plaza, its open east gate and the road's end past it. */
    membraneZ: number;
    slopeEndZ: number;
    plaza: { center: Vec3; radius: number };
    lighthouseTop: Vec3;
    eastGate: Vec3;
    eastRoadEndX: number;
  };
  /** The workshop's interior from its glb (S-24), once the room is built. */
  workshop: WorkshopProbe | null;
  /**
   * The surface-only wall on the dead end's lip (?trial=surface-wall, S-24's trial wall): its segments, and those whose
   * collider a placed orb has cut away (S-28). null without the wall.
   */
  trial: { segments: number; off: number } | null;
}

/** S-34: the close as the room shows it (tests/e2e/S-34-*.spec.ts). */
export interface FinaleProbe {
  /**
   * 0..1, linear in time: the light across the bridge (from the drop taken, SETTLE_SECONDS), the gate's opening (from when
   * the light has reached the far shore, GATE_OPEN_SECONDS; session.ts).
   */
  settle: number;
  gate: number;
  /** Footing segments of the bridge the light has fixed (solid for good). */
  settledSegments: number;
  /** Degrees the gate's leaves have swung, and whether that is open (all but the last tenth of the swing). */
  gateDeg: number;
  gateOpen: boolean;
  /** World z of the light's front over the bridge; null before the drop is taken. */
  frontZ: number | null;
  /** The close's events (session.ts FinaleEvent): 'settle', 'gateOpen', 'settled', 'gateOpened'. */
  events: string[];
}

/** What the room built from the workshop's glb (tests/e2e/S-24-*.spec.ts). */
export interface WorkshopProbe {
  loaded: boolean;
  /** Names of the objects put on a layer. */
  objects: string[];
  /** Pieces of the plan (layout.ts WORKSHOP_OBJECTS) that are not in the file. */
  missing: string[];
  colliders: string[];
  problems: { object: string; code: string }[];
  glass: { object: string; material: string; kind: string; path: string }[];
  /** Triangles of what is drawn (all pieces). */
  triangles: number;
  /** Objects on a layer the camera does not draw (must be none). */
  hiddenFromCamera: string[];
}

export interface PrologueRoom extends DiveWorld {
  readonly probe: RoomProbe;
  /** The orb's and the room's events (覗く・置く・拾う・震える, 雫): the port for S-09's sounds. */
  readonly events: EventBus<PrologueEvent>;
  /** S-34: the close's events (the light settling the bridge, the gate opening), apart from `events`. */
  readonly finale: EventBus<FinaleEvent>;
}

/** 仮: how long the vidro glows after the light drop reaches it. */
const DROP_ARRIVAL_GLOW_SECONDS = 0.9;
/**
 * 仮 (S-35): the vidro left behind calls — glows faintly, breathing (そのとき台座の玉がかすかに光って知らせる): the call's strength
 * at its full, how much it breathes and how fast. It shows on the vidro's sphere's film (CALL_FILM of it on top of the film's
 * calm glow of 0.45, materialize.ts), and so in the vidro (its glow follows its sphere's), in its light (CALL_LIGHT more) and
 * on its cup's rim (CALL_CUP). Below the bloom's threshold: a glimmer, not a light.
 */
const CALL_GLOW = 0.42;
const CALL_BREATH = 0.16;
const CALL_RATE = (2 * Math.PI) / 1.6;
const CALL_FILM = 0.8;
const CALL_LIGHT = 1.0;
/**
 * 仮 (S-35): and the rim of the pedestal's milky cup lights up with it (the same warm rim as when you can act on it): the
 * cup is opaque, so it shows from the gate even where the bridge's glass stands between (透過は不透明な物しか映さない).
 */
const CALL_CUP = 0.8;
/** 仮 (S-34): the keystone lamp is lit by the time the gate is this far (0..1) into its opening. */
const KEYSTONE_LIGHTS = 0.25;
const MAX_EVENTS = 40;
/** 仮: how long the one-line controls hint stays while the mouse is free. */
const HINT_SECONDS = 8;
/** UI/UX設計 > ゲーム中: 0.2秒で現れ、離れると消える (the prompt, and the rims of what you can act on). */
const FOCUS_SECONDS = 0.2;
const STRINGS = {
  ja: {
    lock: 'クリックで視点を固定 ・ WASD 歩く ・ 右クリック 覗く ・ E 置く／拾う／調べる ・ Esc 解除',
    take: 'E　手に取る',
    place: 'E　置く',
    pickup: 'E　拾う',
    touch: 'E　触れる',
  },
  en: {
    lock: 'Click to look around · WASD walk · Right click peek · E place / pick up / touch · Esc release',
    take: 'E  Take',
    place: 'E  Place',
    pickup: 'E  Pick up',
    touch: 'E  Touch',
  },
} as const;

/** ゲーム中の操作表示: a small frosted label at the bottom, 0.2 s in and out (UI/UX設計 > 画面ごとの設計). */
function createPrompt(overlay: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.dataset.ui = 'prompt';
  el.style.cssText =
    'position:absolute;left:50%;bottom:7%;transform:translateX(-50%);padding:7px 18px 8px;border-radius:999px;' +
    'font:max(18px,1.85vh)/1.4 "Shippori Mincho","Hiragino Mincho ProN",serif;color:#f2ede5;letter-spacing:.06em;' +
    'background:rgba(255,255,255,.14);backdrop-filter:blur(14px) brightness(.86);-webkit-backdrop-filter:blur(14px) brightness(.86);' +
    'border:1px solid rgba(255,255,255,.28);opacity:0;transition:opacity .2s;white-space:nowrap;pointer-events:none';
  overlay.appendChild(el);
  return el;
}

/** What exists before the room is built: the host needs the camera and the probe at once. */
interface Shell {
  camera: THREE.PerspectiveCamera;
  probe: RoomProbe;
  events: EventBus<PrologueEvent>;
  finale: EventBus<FinaleEvent>;
}

/** The built room: everything heavy (Rapier, the art, the pipelines). */
interface BuiltRoom {
  scene: THREE.Scene;
  fogRange: { near: { value: number }; far: { value: number } };
  warm(): void;
  setPlaying(on: boolean): void;
  update(dt: number, t: number): void;
  render(): void;
  resize(): void;
  dispose(): void;
}

/**
 * The room as a DiveWorld. Creating it is cheap; `prepare()` builds it (Rapier, art, pipelines), so the host
 * can show its loading screen first and count the build into the loading (遷移のルール 2). Direct mode awaits
 * `prepare()` itself.
 */
export function createPrologueRoom(ctx: SceneContext, opts: RoomOptions): PrologueRoom {
  // S-04 home-dive's MINIATURE_FOV (the game camera while the home orb shows the town)
  const miniatureFov = 44;
  const camera = new THREE.PerspectiveCamera(FOV_DEFAULT, 1, 0.05, 420);
  const s = SPAWNS[opts.spawn];
  // until the body exists, the camera stands where the player will
  camera.position.set(s.feet[0], s.feet[1] + EYE_HEIGHT, s.feet[2]);
  const events = new EventBus<PrologueEvent>();
  const finale = new EventBus<FinaleEvent>();
  const probe: RoomProbe = {
    ready: false,
    playing: false,
    time: 0,
    position: { x: s.feet[0], y: s.feet[1], z: s.feet[2] },
    grounded: false,
    speed: 0,
    walked: 0,
    footfalls: 0,
    eyeHeight: EYE_HEIGHT,
    yaw: s.yaw,
    pitch: s.pitch,
    fov: FOV_DEFAULT,
    locked: false,
    peeking: false,
    peekAmount: 0,
    moveSpeed: 1,
    orb: opts.orbStart,
    pedestal: null,
    handPresence: 0,
    sphereRadius: 0,
    bridgeColliders: 0,
    bridgeSegments: bridgeFooting().length,
    onBackFooting: false,
    shaking: false,
    target: null,
    drop: 'waiting',
    dropTaken: false,
    dropMaterialized: false,
    events: [],
    lastAction: null,
    backPassFrames: 0,
    drawCalls: 0,
    triangles: 0,
    fallRescues: 0,
    orbScreen: { x: 0, y: 0, r: 0, visible: false },
    autoplay: opts.autopilot
      ? { step: '', done: false, worstMs: 0, worstStep: '', worstAt: 0, steps: {} }
      : null,
    finale: {
      settle: 0,
      gate: 0,
      settledSegments: 0,
      gateDeg: 0,
      gateOpen: false,
      frontZ: null,
      events: [],
    },
    membrane: { holding: false, film: 0, call: 0 },
    layout: {
      edgeZ: EDGE_Z,
      farZ: FAR.maxZ,
      pedestalOrb: PEDESTAL_ORB,
      drop: DROP,
      gateZ: GATE.z,
      roadEndZ: ROAD.minZ,
      membraneZ: MEMBRANE.z,
      slopeEndZ: SLOPE.toZ,
      plaza: { center: PLAZA.center, radius: PLAZA.radius },
      lighthouseTop: [LIGHTHOUSE[0], LIGHTHOUSE[1] + LIGHTHOUSE_HEIGHT, LIGHTHOUSE[2]],
      eastGate: (() => {
        const [x, z] = plazaGateAt(COMPASS.east);
        return [x, PLAZA.center[1], z] as Vec3;
      })(),
      eastRoadEndX: EAST_ROAD_END_X,
    },
    workshop: null,
    trial: null,
  };
  const dive = createDivePath();
  const placeholder = new THREE.Scene();
  let built: BuiltRoom | null = null;
  let building: Promise<void> | null = null;
  let disposed = false;
  let playing = false;
  return {
    get scene() {
      return built?.scene ?? placeholder;
    },
    camera,
    pivot: dive.pivot,
    miniatureFov,
    standingFov: FOV_DEFAULT,
    probe,
    events,
    finale,
    pose(u, outPos, outTarget) {
      dive.pose(u, outPos, outTarget);
      if (!built) return;
      // the haze is set for standing in the room; seen from afar (the miniature) it moves out with the camera
      const away = Math.max(0, outPos.length() - 25);
      built.fogRange.near.value = 18 + away;
      built.fogRange.far.value = 150 + away * 3;
    },
    prepare() {
      building ??= buildRoom(ctx, opts, { camera, probe, events, finale }).then((b) => {
        if (disposed) {
          b.dispose();
          return;
        }
        built = b;
        b.setPlaying(playing);
      });
      return building;
    },
    warm: () => built?.warm(),
    setPlaying(on) {
      playing = on;
      built?.setPlaying(on);
    },
    update: (dt, t) => built?.update(dt, t),
    render: () => built?.render(),
    resize: () => built?.resize(),
    dispose() {
      disposed = true;
      built?.dispose();
      built = null;
      events.clear();
      finale.clear();
    },
  };
}

async function buildRoom(ctx: SceneContext, opts: RoomOptions, shell: Shell): Promise<BuiltRoom> {
  const { renderer, canvas, overlay, quality } = ctx;
  const { camera, probe, events, finale } = shell;
  // the workshop's interior (S-24): modelled in Blender, exported by `pnpm assets`; its furniture collides as its _col.
  // Loaded alongside Rapier, before anything that would need releasing if the file failed to load.
  const [R, workshop] = await Promise.all([
    initPhysics(),
    loadAreaAsset(renderer, quality, `${import.meta.env.BASE_URL}${WORKSHOP_ASSET}`),
  ]);
  const world = createWorld();
  addRoomColliders(R, world);
  const footing = new BackFooting(R, world, bridgeFooting(), deckSegmentShape);
  const furniture = addAssetColliders(R, world, workshop.assembled.colliders);
  // A surface-only wall on the dead end's lip (?trial=surface-wall; S-24's trial wall, not in the prologue's design): its
  // segments lose their collider while wholly inside a placed orb's sphere, and picking the orb up while standing in
  // one is refused (S-28, process/slices/S-28.md).
  const trialWall = ctx.params.get('trial') === 'surface-wall';
  const trial = trialWall
    ? new SurfaceColliders(R, world, splitSurface('trial-wall', TRIAL_SURFACE_WALL, SURFACE_SEGMENT))
    : null;
  // S-34: the gate's leaves, shut until the drop is taken
  const gateLeaves = new GateLeaves(R, world);
  world.step();

  const shadowsBefore = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  // S-34: the field also draws what the drop's light has settled (the bridge, fixed onto the surface)
  const field = new LayerField({ settle: true });
  const art = buildRoomArt(renderer, quality, field, {
    ...(trialWall ? { trialWall: TRIAL_SURFACE_WALL } : {}),
    // the gate is the close's (finale.ts): its leaves open
    gate: false,
    // S-35: the town and its lighthouse are the plaza's (plaza.ts); the mist lies under the slope's ground
    town: false,
    mistFloor: slopeGroundNode(),
  });
  const finaleArt = buildFinale(quality, field, art.scene);
  // S-35: the slope down from the gate (and the film in its arch), the central plaza and the town round it
  const slopeArt = buildSlope(quality, field, art.scene);
  const plazaArt = buildPlaza(quality, field, art.scene);
  const workshopTriangles = triangleCount(workshop.assembled.root);
  for (const { object, layer } of workshop.assembled.layered) field.assign(object, layer);
  art.scene.add(workshop.assembled.root);
  for (const m of field.membranes) art.scene.add(m);
  const pipeline = new PeekPipeline({
    renderer,
    scene: art.scene,
    camera,
    field,
    peekScale: quality.peekScale,
    antialias: quality.antialias,
    environment: art.environment,
    finish: finishModeFrom(ctx.params),
  });

  probe.workshop = workshopProbe(workshop, workshopTriangles, camera);
  if (trial) probe.trial = { segments: trial.segments.length, off: 0 };
  // 技術設計 > 性能の目標と予算: 透過ガラスの同時表示は近景で20個程度まで. On demand for the sensors (not enumerable, so a
  // copied probe does not carry it): the meshes the camera draws now whose material reads the backdrop.
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  Object.defineProperty(probe, 'transmissiveInView', {
    enumerable: false,
    configurable: true,
    value: (): number => {
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(
        viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      let n = 0;
      art.scene.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !o.layers.test(camera.layers)) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!mats.some(readsBackdrop)) return;
        if (mesh.frustumCulled && !frustum.intersectsObject(mesh)) return;
        n++;
      });
      return n;
    },
  });

  const pedestals: Record<string, Vec3> = { [PEDESTAL_ID]: PEDESTAL_ORB };
  const session = new PrologueSession({
    orbStart: opts.orbStart,
    pedestals,
    footing: footing.segments,
    surface: trial?.segments ?? [],
    drop: DROP,
    settle: BRIDGE_SETTLE,
    membrane: MEMBRANE,
  });
  const spawn = SPAWNS[opts.spawn];
  /** Where the feet stood when last read (the film asks which side of it the body is on). */
  let feetZ = spawn.feet[2];
  const player = new PlayerController(world, {
    feet: { x: spawn.feet[0], y: spawn.feet[1], z: spawn.feet[2] },
    yaw: spawn.yaw,
    pitch: spawn.pitch,
    // S-35: past the film at the slope's entrance there is no ground for whoever left the vidro behind
    allowGround: withMembrane(footing.allowGround, () => session.holdsAtMembrane(feetZ)),
  });
  player.applyToCamera(camera);

  const input = new InputSystem(canvas, { settings: { peekMode: opts.peekMode } });
  input.canPeek = () => session.canPeek;
  input.suspended = true;
  const queue: InputEvent['type'][] = [];
  const offInput = input.on((e) => queue.push(e.type));

  const text = STRINGS[opts.lang];
  const prompt = createPrompt(overlay);

  // dev holds (screenshots): a placed orb frozen mid-growth
  if (opts.growHold !== null) {
    session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, spawn.feet);
  }
  // S-34 dev hold (?finaleHold=<seconds since the drop was taken>, with a spawn): the orb on its pedestal, the drop taken
  // that long ago, and the close held at that moment (the light, the settled segments, the gate: drawn, collided and asked
  // by the pickup alike). &finaleOrb=hand: the vidro then taken back (from where it stands: the light must have fixed the
  // footing there), so what is left of the bridge is what the light fixed.
  const finaleHold = ctx.params.has('spawn') ? holdSeconds(ctx.params.get('finaleHold')) : null;
  if (finaleHold !== null) {
    if (session.orbPlace !== 'pedestal') session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, spawn.feet);
    session.holdFinale(finaleHold);
    if (ctx.params.get('finaleOrb') === 'hand')
      session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, spawn.feet);
  }

  probe.orb = session.orbPlace;
  probe.bridgeSegments = footing.segments.length;
  const offEvents = session.events.on((e) => {
    probe.events.push(eventName(e));
    if (probe.events.length > MAX_EVENTS) probe.events.shift();
    if (e.type === 'dropTaken') arrivalGlow = DROP_ARRIVAL_GLOW_SECONDS;
    events.emit(e);
  });
  // S-34: the close on its own bus (its names are not S-16's sounds)
  const offFinale = session.finaleEvents.on((e) => {
    probe.finale.events.push(e.type);
    finale.emit(e);
  });

  let playing = false;
  let time = 0;
  let frames = 0;
  let prewarm = false;
  let arrivalGlow = 0;
  let target: TargetKind | null = null;
  let promptText = '';
  let mainRadius = 0;
  let onBackFooting = false;
  // the guard's floor a metre under the ground, down the slope too (S-35)
  const guard = new FallGuard((x, z) => groundHeight(x, z) - 1);
  const idle: PlayerIntent = { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 };
  const live: PlayerIntent = { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 };
  // the session's input each frame, reused: the peek asked for, and (S-35) where the feet stand (feetNow)
  const peekInput: { wantPeek: boolean; feet?: Vec3; pushing?: boolean } = { wantPeek: false };
  const peek = peekModifier(0);
  const forward: [number, number, number] = [0, 0, -1];
  /** Seconds the one-line controls hint has been up since the mouse was last free. */
  let hintFor = 0;
  let wasLocked = false;
  /** Eased focus (0..1) of the things that can be acted on: their rims glow while targeted. */
  const focusNow = { orb: 0, pedestal: 0, drop: 0 };
  const eye: [number, number, number] = [0, 0, 0];
  const fieldSpheres: FieldSphere[] = Array.from({ length: 3 }, () => ({
    center: PEDESTAL_ORB,
    radius: 0,
    glow: 0,
  }));
  const fieldList: FieldSphere[] = [];
  const orbCenter: [number, number, number] = [0, 0, 0];
  const frame = {
    center: orbCenter as Vec3,
    radius: HAND_ORB_RADIUS,
    peek: 0,
    visible: false,
    sunDirection: art.sunDirection,
  };
  const candidates: TargetCandidate<TargetKind>[] = [];
  const benchTarget: TargetCandidate<TargetKind> = { target: 'bench', point: BENCH_ORB, reach: REACH };
  const pedestalTarget: TargetCandidate<TargetKind> = {
    target: 'pedestal',
    point: PEDESTAL_ORB,
    reach: REACH,
  };
  const dropTarget: TargetCandidate<TargetKind> = { target: 'drop', point: DROP, reach: DROP_REACH };
  /** The body as read once per frame (S-03's getters return new objects each time). */
  const body = { fx: spawn.feet[0], fy: spawn.feet[1], fz: spawn.feet[2], ey: 0, vx: 0, vy: 0, vz: 0 };
  const readBody = (): void => {
    const f = player.feet;
    const v = player.velocity;
    body.fx = f.x;
    body.fy = f.y;
    body.fz = f.z;
    body.ey = player.eye.y;
    body.vx = v.x;
    body.vy = v.y;
    body.vz = v.z;
    feetZ = f.z;
  };
  const feetNow: [number, number, number] = [spawn.feet[0], spawn.feet[1], spawn.feet[2]];
  /** S-35: the haze's distances where the body stands (plaza.ts fogRangeAt), written each frame. */
  const fogNow = { near: 0, far: 0 };
  peekInput.feet = feetNow;
  /** S-34 review: the longest frames of the scripted play, by step (probe.autoplay). */
  let frameAt: number | null = null;
  let frameStep = '';
  const timeFrame = (): void => {
    const a = probe.autoplay;
    const pilot = opts.autopilot;
    if (!a || !pilot || !playing) {
      frameAt = null;
      return;
    }
    const now = performance.now();
    if (frameAt !== null) {
      const ms = now - frameAt;
      if (ms > (a.steps[frameStep] ?? 0)) a.steps[frameStep] = ms;
      if (ms > a.worstMs) {
        a.worstMs = ms;
        a.worstStep = frameStep;
        a.worstAt = time;
      }
    }
    frameAt = now;
    frameStep = pilot.current;
  };
  /** Moves an eased 0..1 toward 0 or 1 by at most `k`. */
  const ease = (now: number, on: boolean, k: number): number =>
    on ? Math.min(1, now + k) : Math.max(0, now - k);
  const dropFrom = new THREE.Vector3(...DROP);
  const feetAt: [number, number, number] = [0, 0, 0];
  const dropTo = new THREE.Vector3();

  const interactTarget = (): InteractTarget | null =>
    target === 'pedestal' ? { kind: 'pedestal', id: PEDESTAL_ID } : target ? { kind: target } : null;

  const handle = (type: InputEvent['type']): void => {
    feetAt[0] = body.fx;
    feetAt[1] = body.fy;
    feetAt[2] = body.fz;
    if (type === 'interact') probe.lastAction = session.interact(interactTarget(), feetAt);
    else if (type === 'peekDenied') {
      session.refusePeek();
      probe.lastAction = 'peek-denied';
    }
  };

  // S-34: the close as the session says (or as held): the settled bridge and its band of light, the gate
  const settledView = { sweep: BRIDGE_SETTLE, front: 0, glow: 0 };
  const openRad = (GATE_OPEN_DEG * Math.PI) / 180;
  const close = { settle: 0, gate: 0, angle: 0, front: null as number | null };
  const stageFinale = (): void => {
    const elapsed = session.finaleElapsed;
    // the light from the drop taken; the gate from when the light has reached the far shore (session.ts)
    close.settle = session.settleProgress;
    close.gate = session.gateProgress;
    if (elapsed === null) {
      close.front = null;
      field.setSettled(null);
    } else {
      settledView.front = finaleFront(BRIDGE_SETTLE, elapsed);
      settledView.glow = settleGlow(close.settle);
      close.front = settledView.front;
      field.setSettled(settledView);
    }
    footing.settle(session.settledFooting());
    if (trial?.settle(session.settledSurface()) && probe.trial) probe.trial.off = trial.cutCount;
    close.angle = gateAngle(close.gate);
    finaleArt.setGate(close.angle);
    gateLeaves.sync(close.angle);
    // the keystone lamp lights as the gate starts to open (the light has come to it), on the game's one curve
    finaleArt.setKeystone(glassEase(Math.min(1, close.gate / KEYSTONE_LIGHTS)));
  };

  /** The drop is real where it is drawn (the same as the session's rule, but also under the dev holds). */
  const dropDrawn = (): boolean => insideAnySphere(DROP[0], DROP[1], DROP[2], fieldList);

  const chooseTarget = (): void => {
    candidates.length = 0;
    const place = session.orbPlace;
    candidates.push(place === 'bench' ? benchTarget : pedestalTarget);
    if (session.dropState === 'waiting' && dropDrawn()) candidates.push(dropTarget);
    eye[0] = body.fx;
    eye[1] = body.ey;
    eye[2] = body.fz;
    target = pickTarget(eye, lookDirection(player.yaw, player.pitch, forward), candidates, FACING_DEG);
  };

  const updatePrompt = (): void => {
    let next = '';
    // the controls hint shows only for a few seconds while the mouse is free (ゲーム中は常時表示なし), and
    // never in the dev holds (clean screenshots)
    const hint = !opts.autopilot && opts.peekHold === null && opts.growHold === null;
    if (playing && !input.locked && hint && hintFor < HINT_SECONDS) next = text.lock;
    else if (playing && target === 'bench') next = text.take;
    else if (playing && target === 'drop') next = text.touch;
    else if (playing && target === 'pedestal')
      next = session.orbPlace === 'pedestal' ? text.pickup : text.place;
    if (next !== promptText) {
      if (next) prompt.textContent = next;
      prompt.style.opacity = next ? '1' : '0';
      promptText = next;
    }
  };

  /** Spheres, the placed orb, its light and the drop as the session says (plus the dev holds). */
  const stage = (): void => {
    const spheres = session.spheres();
    const shake = session.shake;
    const flash = shake * shake * 1.6 + (arrivalGlow / DROP_ARRIVAL_GLOW_SECONDS) * 1.4;
    // S-35: left behind while the film holds you at the gate, the vidro calls: a faint glow, breathing — in the vidro, its
    // cup and its light, and on its sphere's film, which shows from the gate whatever stands in front of the vidro itself
    const call = session.call;
    const calling = call > 0 ? call * (CALL_GLOW + CALL_BREATH * Math.sin(time * CALL_RATE)) : 0;
    let mainGlow = 0;
    mainRadius = 0;
    fieldList.length = 0;
    for (let i = 0; i < spheres.length; i++) {
      const sp = spheres[i];
      const f = fieldSpheres[i];
      if (!sp || !f) continue;
      const frozen = opts.growHold !== null && sp.kind === 'main';
      const m = frozen ? { progress: opts.growHold ?? 1, target: 1 as const } : sp.materialize;
      f.center = sp.center;
      f.radius = frozen ? materializedRadius(m, MAIN_ORB_RADIUS) : sp.radius;
      f.glow = boundaryGlow(m) + (sp.kind === 'main' ? flash + calling * CALL_FILM : 0);
      if (sp.kind === 'main') {
        mainGlow = f.glow;
        mainRadius = f.radius;
      }
      fieldList.push(f);
    }
    if (prewarm) {
      // compile the membrane and the placed-orb pipelines before the first placement
      const f = fieldSpheres[0];
      if (f) {
        f.center = PEDESTAL_ORB;
        f.radius = 0.01;
        f.glow = 0;
        fieldList.length = 0;
        fieldList.push(f);
      }
    }
    field.setSpheres(fieldList);
    // The footing takes the session's spheres as they are (the same array until the orbs change) and decides
    // the fence itself (holdsGround), and so does the surface-only wall. The dev hold uses what it draws.
    const footingSpheres =
      opts.growHold === null ? spheres : fieldList.map((s) => ({ center: s.center, radius: s.radius }));
    footing.sync(footingSpheres);
    if (trial?.sync(footingSpheres) && probe.trial) probe.trial.off = trial.cutCount;

    const place = session.orbPlace;
    const at = place === 'bench' ? BENCH_ORB : PEDESTAL_ORB;
    const jitter = shake > 0 ? Math.sin(time * 70) * SHAKE_AMPLITUDE * shake : 0;
    art.orb.visible = place !== 'hand' || prewarm;
    art.orb.position.set(at[0] + jitter, at[1] + jitter * 0.3, at[2] - jitter * 0.6);
    art.orbGlow.value = (place === 'pedestal' ? mainGlow * 1.2 : 0) + flash * (place === 'pedestal' ? 0 : 1);
    art.orbLight.intensity = place === 'pedestal' ? mainGlow * 2.2 + call * CALL_LIGHT : 0;
    slopeArt.setFilm(session.film);
    slopeArt.setPress(call);

    // the light drop hovers; once touched it rises and flies into the vidro, then is gone
    const d = session.dropState;
    art.drop.visible = d !== 'taken';
    if (d === 'waiting') {
      art.drop.position.set(DROP[0], DROP[1] + 0.03 * Math.sin(time * 1.6), DROP[2]);
      art.drop.rotation.y = time * 0.5;
      art.drop.scale.setScalar(1);
    } else if (d === 'flying') {
      const u = glassEase(session.dropProgress);
      dropTo.set(at[0], at[1], at[2]);
      art.drop.position.lerpVectors(dropFrom, dropTo, u);
      art.drop.position.y += Math.sin(Math.PI * u) * 0.9;
      art.drop.scale.setScalar(1 - 0.75 * u);
      art.drop.rotation.y = time * 2;
    }
    stageFinale();
  };

  const publish = (): void => {
    probe.time = time;
    probe.playing = playing;
    probe.position.x = body.fx;
    probe.position.y = body.fy;
    probe.position.z = body.fz;
    probe.grounded = player.grounded;
    probe.speed = Math.hypot(body.vx, body.vz);
    probe.walked = player.walked;
    probe.footfalls = player.footfalls;
    probe.eyeHeight = body.ey - body.fy;
    probe.yaw = player.yaw;
    probe.pitch = player.pitch;
    probe.fov = camera.fov;
    probe.locked = input.locked;
    probe.peeking = session.peeking;
    probe.peekAmount = frame.peek;
    probe.moveSpeed = peekMoveSpeedMultiplier(frame.peek);
    probe.orb = session.orbPlace;
    probe.pedestal = session.pedestal;
    probe.handPresence = session.handPresence;
    probe.sphereRadius = mainRadius;
    probe.bridgeColliders = footing.activeCount;
    probe.onBackFooting = onBackFooting;
    probe.shaking = session.shake > 0;
    probe.target = target;
    probe.drop = session.dropState;
    probe.dropTaken = session.dropState === 'taken';
    probe.dropMaterialized = dropDrawn();
    probe.backPassFrames = pipeline.backPassFrames;
    const f = probe.finale;
    f.settle = close.settle;
    f.gate = close.gate;
    f.settledSegments = footing.settledCount;
    f.gateDeg = (close.angle * 180) / Math.PI;
    f.gateOpen = close.angle >= openRad * 0.9;
    // the front is measured along the sweep's direction (straight down -Z over the bridge)
    f.frontZ = close.front === null ? null : close.front / BRIDGE_SETTLE.direction[2];
    probe.membrane.holding = session.holdsAtMembrane(body.fz);
    probe.membrane.film = session.film;
    probe.membrane.call = session.call;
    orbScreenCircle(frame.center, HAND_ORB_RADIUS, camera.fov, camera.aspect, probe.orbScreen);
    probe.orbScreen.visible = frame.visible;
    if (probe.autoplay && opts.autopilot) {
      probe.autoplay.step = opts.autopilot.current;
      probe.autoplay.done = opts.autopilot.done;
    }
  };

  return {
    scene: art.scene,
    fogRange: art.fogRange,
    warm() {
      prewarm = true;
      stage();
      // S-38: the glass all around compiles in this draw, not only what this pose sees (the workshop's wares behind the
      // landing pose were compiled when first looked back at, one frame each): the game's own pipeline (scene pass, its
      // backdrop, the layer masks) draws them with the view's culling lifted for the glass alone (core/glass/warm.ts)
      withGlassUnculled(art.scene, () => pipeline.render(frame));
      prewarm = false;
      stage();
    },
    setPlaying(on) {
      playing = on;
      input.suspended = !on || opts.autopilot !== null;
      if (on) {
        hintFor = 0;
        // the way's haze in the workshop, the town's out on the slope (S-35: plaza.ts fogRangeAt)
        const fog = fogRangeAt(feetZ, fogNow);
        art.fogRange.near.value = fog.near;
        art.fogRange.far.value = fog.far;
        // the dive ends exactly at the player's eye; from here the body owns the camera
        player.applyToCamera(camera);
      } else {
        input.exitLock();
      }
    },
    update(dt, t) {
      time += dt;
      timeFrame();
      art.animate(t);
      slopeArt.animate(t);
      plazaArt.animate(t);
      let intent = idle;
      let wantPeek = false;
      if (playing) {
        input.update(dt);
        const look = input.consumeLook();
        intent = live;
        live.move = input.move;
        live.sprint = input.sprint;
        live.lookYaw = look.yaw;
        live.lookPitch = look.pitch;
        wantPeek = input.peeking || opts.forcePeek;
        const pilot = opts.autopilot;
        if (pilot) {
          const order = pilot.step(dt, {
            feet: [body.fx, body.fy, body.fz],
            yaw: player.yaw,
            pitch: player.pitch,
            speed: Math.hypot(body.vx, body.vz),
            target,
            orb: session.orbPlace,
            sphereRadius: session.spheres().find((s) => s.kind === 'main')?.radius ?? 0,
            drop: session.dropState,
          });
          intent = order.intent;
          wantPeek = order.peek;
          if (order.interact) queue.push('interact');
        }
        for (const type of queue) handle(type);
      }
      queue.length = 0;
      peekInput.wantPeek = wantPeek;
      // S-35: walking toward the slope (the wished direction along -Z, as the body turns it: PlayerController's yaw)
      peekInput.pushing = -Math.cos(player.yaw) * intent.move.y - Math.sin(player.yaw) * intent.move.x < -0.2;
      feetNow[0] = body.fx;
      feetNow[1] = body.fy;
      feetNow[2] = body.fz;
      session.step(dt, peekInput);
      arrivalGlow = Math.max(0, arrivalGlow - dt);
      // the hint comes back for a few seconds whenever the mouse is freed again
      if (wasLocked && !input.locked) hintFor = 0;
      wasLocked = input.locked;
      if (playing && !input.locked) hintFor += dt;
      const amount = opts.peekHold ?? session.peekAmount;
      if (amount > 0) {
        peek.weight = amount;
        player.modifiers.set('peek', peek);
      } else player.modifiers.delete('peek');
      stage();
      world.step();
      if (playing) {
        player.update(dt, intent);
        readBody();
        feetAt[0] = body.fx;
        feetAt[1] = body.fy;
        feetAt[2] = body.fz;
        // the same test as 拾う前の安全確認 (S-02 segmentsUnder), on the segments that are solid now;
        // only looked up near the bridge, so most frames allocate nothing
        // (S-34: a segment the drop's light has settled is solid for good: not footing the orb holds any more)
        onBackFooting =
          body.fz < BRIDGE.max[2] + 0.5 &&
          body.fz > BRIDGE.min[2] - 0.5 &&
          segmentsUnder(feetAt, footing.segments).some(
            (seg) => footing.activeIds.includes(seg.id) && !footing.isSettled(seg.id),
          );
        // 落下死はない: the last line of defence if the body ever drops below the walkways. It should never
        // act; when it does it says so (the e2e counts console warnings) and counts on the probe.
        guard.observe(feetAt, player.grounded, onBackFooting);
        const back = guard.rescue(feetAt);
        if (back) {
          probe.fallRescues++;
          console.warn(
            `S-06: the body fell below the walkways at (${body.fx.toFixed(2)}, ${body.fy.toFixed(2)}, ${body.fz.toFixed(2)}); put back at (${back.join(', ')})`,
          );
          player.teleport({ x: back[0], y: back[1], z: back[2] });
          readBody();
        }
        player.applyToCamera(camera);
        camera.updateMatrixWorld();
        // S-35: the haze reaches further out in the town than on the way
        const fog = fogRangeAt(body.fz, fogNow);
        art.fogRange.near.value = fog.near;
        art.fogRange.far.value = fog.far;
      } else readBody();
      chooseTarget();
      updatePrompt();
      // 調べられる物に近づくと縁が淡く光る: 0.2 s in and out, like the prompt
      const k = Math.min(1, dt / FOCUS_SECONDS);
      const onPedestal = session.orbPlace === 'pedestal';
      focusNow.orb = ease(
        focusNow.orb,
        playing && (target === 'bench' || (target === 'pedestal' && onPedestal)),
        k,
      );
      focusNow.pedestal = ease(focusNow.pedestal, playing && target === 'pedestal', k);
      focusNow.drop = ease(focusNow.drop, playing && target === 'drop', k);
      art.focus.orb.value = focusNow.orb;
      art.focus.pedestal.value = Math.max(focusNow.pedestal, session.call * CALL_CUP);
      art.focus.drop.value = focusNow.drop;
      handOrbCenter(amount, session.handPresence, time, orbCenter);
      frame.peek = amount;
      frame.visible = session.handPresence > 0.001;
      publish();
    },
    render() {
      pipeline.render(frame);
      frames++;
      if (frames >= 3) probe.ready = true;
      probe.backPassFrames = pipeline.backPassFrames;
      // renderer.info is reset once per animation frame, so this is the whole frame so far
      probe.drawCalls = renderer.info.render.drawCalls;
      probe.triangles = renderer.info.render.triangles;
    },
    resize() {
      pipeline.resize();
    },
    dispose() {
      offInput();
      offEvents();
      offFinale();
      session.events.clear();
      session.finaleEvents.clear();
      input.dispose();
      prompt.remove();
      player.dispose();
      footing.dispose();
      furniture.dispose();
      trial?.dispose();
      gateLeaves.dispose();
      world.free();
      slopeArt.dispose();
      plazaArt.dispose();
      workshop.dispose();
      pipeline.dispose();
      field.dispose();
      finaleArt.dispose();
      art.dispose();
      renderer.shadowMap.enabled = shadowsBefore;
    },
  };
}

/** A dev hold in seconds (?finaleHold), or null. */
function holdSeconds(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Triangles drawn under `root` (indexed or not). */
function triangleCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const index = mesh.geometry.getIndex();
    n += (index ? index.count : (mesh.geometry.getAttribute('position')?.count ?? 0)) / 3;
  });
  return n;
}

function workshopProbe(area: AreaAsset, triangles: number, camera: THREE.Camera): WorkshopProbe {
  const name = (o: THREE.Object3D): string =>
    typeof o.userData.name === 'string' ? o.userData.name : o.name;
  const objects = area.assembled.layered.map((l) => name(l.object));
  return {
    loaded: true,
    objects,
    missing: Object.values(WORKSHOP_OBJECTS)
      .map((o) => o.name)
      .filter((n) => !objects.includes(n)),
    colliders: area.assembled.colliders.map((c) => c.name),
    problems: area.problems.map((p) => ({ object: p.object, code: p.code })),
    glass: area.glass.map((g) => ({ object: g.object, material: g.material, kind: g.kind, path: g.path })),
    triangles,
    hiddenFromCamera: area.assembled.layered
      .filter(({ object }) => {
        let seen = false;
        object.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && o.layers.test(camera.layers)) seen = true;
        });
        return !seen;
      })
      .map((l) => name(l.object)),
  };
}
