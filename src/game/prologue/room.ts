import * as THREE from 'three/webgpu';
import type { SceneContext } from '../../core/scene';
import type { FieldSphere } from '../../layers/field';
import { LayerField } from '../../layers/field';
import { segmentsUnder, splitFooting, type Vec3 } from '../../layers/footing';
import { boundaryGlow, MAIN_ORB_RADIUS, materializedRadius } from '../../layers/materialize';
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
import {
  BENCH_ORB,
  BRIDGE,
  bridgeFooting,
  DROP,
  DROP_REACH,
  EDGE_Z,
  FACING_DEG,
  FAR,
  FOOTING_SEGMENT,
  lookDirection,
  PEDESTAL_ID,
  PEDESTAL_ORB,
  REACH,
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
  insideAnySphere,
  SurfaceColliders,
} from './physics';
import { buildRoomArt } from './room-art';
import { type InteractTarget, PrologueSession, peekModifier, SHAKE_AMPLITUDE } from './session';
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
  autoplay: { step: string; done: boolean } | null;
  layout: { edgeZ: number; farZ: number; pedestalOrb: Vec3; drop: Vec3 };
  /** The workshop's interior from its glb (S-24), once the room is built. */
  workshop: WorkshopProbe | null;
  /** S-24's trial of a surface-only wall in the sphere (?trial=surface-wall&surfaceCol=keep|cut), or null. */
  trial: { mode: 'keep' | 'cut'; segments: number; off: number } | null;
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
}

/** 仮: how long the vidro glows after the light drop reaches it. */
const DROP_ARRIVAL_GLOW_SECONDS = 0.9;
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
    autoplay: opts.autopilot ? { step: '', done: false } : null,
    layout: { edgeZ: EDGE_Z, farZ: FAR.maxZ, pedestalOrb: PEDESTAL_ORB, drop: DROP },
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
    pose(u, outPos, outTarget) {
      dive.pose(u, outPos, outTarget);
      if (!built) return;
      // the haze is set for standing in the room; seen from afar (the miniature) it moves out with the camera
      const away = Math.max(0, outPos.length() - 25);
      built.fogRange.near.value = 18 + away;
      built.fogRange.far.value = 150 + away * 3;
    },
    prepare() {
      building ??= buildRoom(ctx, opts, { camera, probe, events }).then((b) => {
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
    },
  };
}

async function buildRoom(ctx: SceneContext, opts: RoomOptions, shell: Shell): Promise<BuiltRoom> {
  const { renderer, canvas, overlay, quality } = ctx;
  const { camera, probe, events } = shell;
  const R = await initPhysics();
  const world = createWorld();
  addRoomColliders(R, world);
  const footing = new BackFooting(R, world, bridgeFooting(), deckSegmentShape);
  // the workshop's interior (S-24): modelled in Blender, exported by `pnpm assets`; its furniture collides as its _col
  const workshop = await loadAreaAsset(renderer, quality, `${import.meta.env.BASE_URL}${WORKSHOP_ASSET}`);
  const furniture = addAssetColliders(R, world, workshop.assembled.colliders);
  // S-24's trial (S-23 判断待ち9, process/slices/S-24.md): a surface-only wall on the dead end's lip, whose collider stays
  // (keep, as assets do today) or goes while it is wholly inside a placed orb's sphere (cut). Off unless asked for.
  const trialWall = ctx.params.get('trial') === 'surface-wall';
  const trial = trialWall
    ? new SurfaceColliders(
        R,
        world,
        splitFooting('trial-wall', TRIAL_SURFACE_WALL, FOOTING_SEGMENT),
        ctx.params.get('surfaceCol') === 'cut' ? 'cut' : 'keep',
      )
    : null;
  world.step();

  const shadowsBefore = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  const field = new LayerField();
  const art = buildRoomArt(renderer, quality, field, trialWall ? { trialWall: TRIAL_SURFACE_WALL } : {});
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

  const pedestals: Record<string, Vec3> = { [PEDESTAL_ID]: PEDESTAL_ORB };
  const session = new PrologueSession({
    orbStart: opts.orbStart,
    pedestals,
    footing: footing.segments,
    drop: DROP,
  });
  const spawn = SPAWNS[opts.spawn];
  const player = new PlayerController(world, {
    feet: { x: spawn.feet[0], y: spawn.feet[1], z: spawn.feet[2] },
    yaw: spawn.yaw,
    pitch: spawn.pitch,
    allowGround: footing.allowGround,
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

  probe.orb = session.orbPlace;
  probe.bridgeSegments = footing.segments.length;
  const offEvents = session.events.on((e) => {
    probe.events.push(eventName(e));
    if (probe.events.length > MAX_EVENTS) probe.events.shift();
    if (e.type === 'dropTaken') arrivalGlow = DROP_ARRIVAL_GLOW_SECONDS;
    events.emit(e);
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
  const guard = new FallGuard();
  const idle: PlayerIntent = { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 };
  const live: PlayerIntent = { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 };
  const peekInput = { wantPeek: false };
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
  const body = { fx: 0, fy: 0, fz: 0, ey: 0, vx: 0, vy: 0, vz: 0 };
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
      f.glow = boundaryGlow(m) + (sp.kind === 'main' ? flash : 0);
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
    // the fence itself (physics.holdsGround). The dev hold uses what it draws.
    const footingSpheres =
      opts.growHold === null ? spheres : fieldList.map((s) => ({ center: s.center, radius: s.radius }));
    footing.sync(footingSpheres);
    if (trial) {
      trial.sync(footingSpheres);
      probe.trial = { mode: trial.mode, segments: trial.segments.length, off: trial.offCount };
    }

    const place = session.orbPlace;
    const at = place === 'bench' ? BENCH_ORB : PEDESTAL_ORB;
    const jitter = shake > 0 ? Math.sin(time * 70) * SHAKE_AMPLITUDE * shake : 0;
    art.orb.visible = place !== 'hand' || prewarm;
    art.orb.position.set(at[0] + jitter, at[1] + jitter * 0.3, at[2] - jitter * 0.6);
    art.orbGlow.value = (place === 'pedestal' ? mainGlow * 1.2 : 0) + flash * (place === 'pedestal' ? 0 : 1);
    art.orbLight.intensity = place === 'pedestal' ? mainGlow * 2.2 : 0;

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
      pipeline.render(frame);
      prewarm = false;
      stage();
    },
    setPlaying(on) {
      playing = on;
      input.suspended = !on || opts.autopilot !== null;
      if (on) {
        hintFor = 0;
        art.fogRange.near.value = 18;
        art.fogRange.far.value = 150;
        // the dive ends exactly at the player's eye; from here the body owns the camera
        player.applyToCamera(camera);
      } else {
        input.exitLock();
      }
    },
    update(dt, t) {
      time += dt;
      art.animate(t);
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
        onBackFooting =
          body.fz < BRIDGE.max[2] + 0.5 &&
          body.fz > BRIDGE.min[2] - 0.5 &&
          segmentsUnder(feetAt, footing.segments).some((seg) => footing.activeIds.includes(seg.id));
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
      art.focus.pedestal.value = focusNow.pedestal;
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
      session.events.clear();
      input.dispose();
      prompt.remove();
      player.dispose();
      footing.dispose();
      furniture.dispose();
      trial?.dispose();
      world.free();
      workshop.dispose();
      pipeline.dispose();
      field.dispose();
      art.dispose();
      renderer.shadowMap.enabled = shadowsBefore;
    },
  };
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
