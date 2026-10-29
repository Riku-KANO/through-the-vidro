import * as THREE from 'three/webgpu';
import { drawsGlass, readsBackdrop, withGlassUnculled } from '../../core/glass';
import type { QualityLevel, QualityPreset } from '../../core/quality';
import type { SceneContext } from '../../core/scene';
import { glassEaseInverse } from '../../core/transition';
import type { FieldSphere } from '../../layers/field';
import { LayerField } from '../../layers/field';
import type { Box, FootingSegment, Vec3 } from '../../layers/footing';
import { viewMask } from '../../layers/layers';
import { boundaryGlow, MAIN_ORB_RADIUS, materializedRadius } from '../../layers/materialize';
import { sweepGlowFor, sweepSpan } from '../../layers/settle';
import { glassEase } from '../../layers/tween';
import {
  type AreaCount,
  type AreaDecl,
  type DropState,
  dropsOf,
  footingOf,
  type SurfaceDecl,
  surfaceSegments,
  surfaceWallsOf,
} from '../area';
import { CALM, calmedWave, orbFlash, WORLD_ACCESS } from '../area/access';
import { type Area1Art, buildArea1, hazeOf } from '../area1/art';
import {
  AREA1,
  AREA1_CHIMNEY,
  AREA1_GATES,
  AREA1_PLAZA,
  AREA1_ROAD,
  AREA1_SLOPE,
  area1GateAngle,
  area1Ground,
  COURT_Y,
  daylightAt,
  NEXT_LAMPS_BY_ROOM,
  NEXT_LIGHTS,
  ROOM1_ALLEY,
  ROOM1_DROP,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
  ROOM2_BALCONY,
  ROOM2_COURT,
  ROOM2_DROP,
  ROOM2_PEDESTAL_A,
  ROOM2_PEDESTAL_B,
  ROOM2_STAIRS,
  ROOM2_STAIRS_FOOT_Z,
  ROOM2_WALL,
  ROOM3_BRIDGE_N,
  ROOM3_BRIDGE_S,
  ROOM3_DROP,
  ROOM3_EDGE,
  ROOM3_PEDESTAL_N,
  ROOM3_PEDESTAL_S,
  ROOM3_RAILING,
  ROOM3_ROOF_N,
  ROOM3_ROOF_S,
  ROOM3_SHADE,
  ROOM3_TERRACE,
  SHORTCUT_GATE,
  SHORTCUT_SECONDS,
  SHORTCUT_STAIRS,
  SUMMIT_Y,
  TOWN,
} from '../area1/layout';
import { type Area1Colliders, Area1Gates, addArea1Colliders, area1Footing } from '../area1/physics';
import { type AreaAsset, addAssetColliders, loadAreaAsset } from '../assets';
import type { DiveWorld, WorldSettings } from '../dive-world';
import { cloneBindings } from '../input/bindings';
import { type InputEvent, InputSystem } from '../input/input-system';
import { controlWords } from '../input/key-labels';
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
  PROLOGUE_AREA,
  plazaGateAt,
  REACH,
  ROAD,
  SLOPE,
  SPAWNS,
  type SpawnName,
  TRIAL_SURFACE_WALL,
  WORKSHOP_ASSET,
  WORKSHOP_FLOOR_RADIUS,
  WORKSHOP_OBJECTS,
  WORKSHOP_TOP,
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
import { buildPlaza, FOG_WAY, fogRangeAt } from './plaza';
import { buildRoomArt } from './room-art';
import {
  type AreaGateEvent,
  type FinaleEvent,
  finaleFront,
  type HintEvent,
  type InteractTarget,
  PrologueSession,
  peekModifier,
  type SettleLegState,
  SHAKE_AMPLITUDE,
  type ShortcutEvent,
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

/**
 * S-36: エリア1 as the room builds it behind the scenes — waiting (not yet over the slope's brow), building (a part a frame),
 * compiling (its shaders compiled in the background, three's compileAsync: no frame waits on them), built (waiting to be
 * added while it is out of view), warming (its pipelines, one entry a frame, before it is seen), ready.
 */
export interface Area1Probe {
  state: 'waiting' | 'building' | 'compiling' | 'built' | 'warming' | 'ready';
  /** Seconds the background compile took (null before it is done). */
  compileSeconds: number | null;
  /** The room's clock (s) when it started building, when it was added to the scene, when it was ready. */
  startedAt: number | null;
  addedAt: number | null;
  readyAt: number | null;
  /** Whether its box was in the camera's view when it was added (it waits until it is not, unless you are on the road). */
  addedInView: boolean;
  /** Frames from building to ready, and the longest of them (ms, between two updates of the room). */
  frames: number;
  worstMs: number;
  /** Entries warmed (its meshes, one a frame, drawn uncut by the view). */
  warmed: number;
  /**
   * ms of each frame from building to ready (between two updates of the room), of each build step (inside the room's
   * update), and of each warm frame's drawing (inside its render).
   */
  frameMs: number[];
  buildMs: number[];
  warmMs: number[];
  /** 部屋1's crumbled wall: its segments, and how many of their colliders a placed vidro's sphere cuts now (S-28). */
  wall: { segments: number; off: number };
  /** 0..1: the lamps toward the next room, lit once 部屋1's drop is taken (次の部屋の方向が見える). */
  next: number;
  /** S-40: 0..1, the lamps toward 部屋3, lit once 部屋2's drop is taken. */
  next2: number;
  /** S-40: 0..1, out of the haze (1 at once when it was added out of view; 視界の中で足すときは霞の奥から現れる). */
  appear: number;
  /** S-40: its parts shown so far (one at a time while it is added in view), out of all. */
  shown: number;
  entries: number;
  /** S-40: every surface-only wall of it (部屋1's, 部屋2's, the shortcut's gate): segments, and how many are cut now. */
  walls: Record<string, { segments: number; off: number }>;
  /** S-40: its back-layer footing (the courtyard's stair, the bridges, the shortcut): segments, on now, fixed by the light. */
  footing: { segments: number; active: number; settled: number };
  /** S-40: 0..3, which way the motes lead (MOTE_PATHS; fractional while they turn). */
  motes: number;
  /**
   * S-40: the shortcut home — how far its light has run (0..1, linear in time), where its front is now (null while it does
   * not run: before, and once it is through), which leg (0, 1), and its events (session ShortcutEvent).
   */
  shortcut: { settle: number; front: Vec3 | null; leg: number | null; events: string[] };
  /**
   * S-41: the room of it to play next (0..3: the first whose drop waits; game/area nextRoom), and its gates between the rooms —
   * how far each is open (0..1, linear in time), its leaves' angle (radians), and their events ('open', 'opened').
   */
  nextRoom: number;
  gates: Record<string, { progress: number; angle: number; events: string[] }>;
}

/** What the room publishes on window.__vidro.sceneProbe.room (tests/e2e/S-06-*.spec.ts). */
export interface RoomProbe {
  ready: boolean;
  playing: boolean;
  /** Scene clock, seconds. */
  time: number;
  /** S-42: the game's time speed (the pause stops it): the room's sounds of its time follow it (sound.ts). */
  timeScale: number;
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
  /** S-36: the pedestal or the drop targeted (its id), null for none or the bench. */
  targetId: string | null;
  /** The prologue's drop (the first room's). */
  drop: 'waiting' | 'flying' | 'taken';
  dropTaken: boolean;
  dropMaterialized: boolean;
  /** S-36: every drop of the areas (game/area) and its state; how many each area has and has taken. */
  drops: { id: string; area: string; state: DropState }[];
  areas: Record<string, AreaCount>;
  /** S-36: 0 (夜明け前) … 1 (朝), where the body stands (area1/layout.ts daylightAt). */
  daylight: number;
  /** S-36: エリア1, built behind the scenes. */
  area1: Area1Probe;
  /** S-36: where the vidro stands on its pedestal now (the sound's 'orb'), and the drop last touched (its 'drop'). */
  orbAt: Vec3;
  dropAt: Vec3;
  /** The last events, e.g. 'pickup:bench', 'peekStart', 'shake:peek', 'dropTaken'. */
  events: string[];
  lastAction: string | null;
  backPassFrames: number;
  /** Render counters of the last frame (all passes). */
  drawCalls: number;
  /** Times the fall guard had to put the body back (must stay 0: 落下死はない should hold without it). */
  fallRescues: number;
  /**
   * S-41: the peek image's far end (metres of view depth), and what the last peek image left out past it — things, and of them
   * those on the back layer alone (must stay 0: 玉越しの裏の層の見た目は変えない) — and the back layer's things past it it drew all
   * the same; S-44: and the landmarks' (常に見える目印).
   */
  peekFar: { far: number; leftOut: number; leftOutBack: number; keptBack: number; keptLandmarks: number };
  /** S-48: the peek image's scale and size and the finishing's anti-aliasing, as the preset in use makes them now. */
  peekQuality: PeekPipeline['quality'];
  triangles: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  /** S-45: the accessibility settings as the room took them (歩行の揺れ, 歪み, 点滅を抑える, コントラスト強化). */
  access: { headBob: number; distortion: number; calm: boolean; contrast: boolean; bloom: number | null };
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
   * how much it shows (0..1) and how much the vidro left behind is calling (0..1, its faint glow). S-39: when it whispered
   * (the room's clock, s; the last 16), each a hint on room.hints.
   */
  membrane: { holding: boolean; film: number; call: number; whispers: number[] };
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
    /** S-36: エリア1's way in and its first room. */
    area1: {
      plaza: { center: Vec3; radius: number };
      roadFromX: number;
      roadToX: number;
      pedestalOrb: Vec3;
      drop: Vec3;
      wall: { min: Vec3; max: Vec3 };
      alley: { minX: number; maxX: number; minZ: number; maxZ: number };
      chimneyTop: Vec3;
      /** S-40: the slope (its line, its landing and where it reaches the summit). */
      slope: { x: number; fromZ: number; landingFromZ: number; landingToZ: number; toZ: number };
      /** S-40: 部屋2 — the courtyard, the balcony, the stair, the pedestals, the wall, the drop. */
      room2: {
        court: Rect;
        courtY: number;
        balcony: Rect & { y: number };
        stairs: { minX: number; maxX: number; footZ: number; topZ: number };
        pedestals: { a: Vec3; b: Vec3 };
        ids: { a: string; b: string; drop: string };
        wall: { min: Vec3; max: Vec3 };
        drop: Vec3;
      };
      /** S-40: 部屋3 — the terrace, the edge to peek from, the bridges, the roofs, the pedestals, the drop. */
      room3: {
        terrace: Rect;
        summitY: number;
        edge: Vec3;
        bridges: { n: Box; s: Box };
        roofs: { n: Rect; s: Rect };
        pedestals: { n: Vec3; s: Vec3 };
        ids: { n: string; s: string; drop: string };
        drop: Vec3;
        /** S-41: the roof's walls the drop hovers behind, the crumbled wall on the lip (表だけ) the edge peeks past. */
        shade: { minX: number; maxX: number; minZ: number; maxZ: number; top: number }[];
        railing: Box;
      };
      /** S-41: the gates between the rooms — where each stands, its half width, which way its leaves swing (z). */
      gates: { id: string; after: string; at: Vec3; halfWidth: number; swing: number }[];
      /** S-40: the shortcut — its stairs (x, top, foot), the gate, how long its light takes. */
      shortcut: { minX: number; maxX: number; topZ: number; footZ: number; gate: Box; seconds: number };
    };
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
  /** S-39: the hints (the vidro left behind whispering), apart from `events` and the close's. */
  readonly hints: EventBus<HintEvent>;
  /** S-40: エリア1's shortcut settling (its light starts, is through), apart from the others. */
  readonly shortcut: EventBus<ShortcutEvent>;
  /** S-41: エリア1's gates between its rooms opening, apart from the others. */
  readonly gates: EventBus<AreaGateEvent>;
  /** S-42: the pause's port (src/ui/pause/port.ts): the input asks for it (Esc, the mouse let go, Start). */
  onPauseRequest(listener: () => void): () => void;
  /** S-42: the game's time speed (0..1): the body, the orb, the light's sweeps and the ambient motion run at it. */
  setTimeScale(scale: number): void;
  /** S-42: the input held back while the pause is up (the mouse let go, no prompt). */
  setHeld(held: boolean): void;
  /** S-42: asks for the mouse lock again (inside the click or key press that resumes). */
  relock(): void;
  /** S-43: the player's settings (視野角, 覗く, マウスの感度, 上下の反転; the prompt's language, size, contrast), at once. */
  applySettings(settings: WorldSettings): void;
  /** S-48: another preset in play (core/quality.ts QualityScene): the peek image's scale and the anti-aliasing, at once. */
  applyQuality(level: QualityLevel, preset: Readonly<QualityPreset>): void;
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
/** S-39: the whispers kept on the probe (their times). */
const MAX_WHISPERS = 16;
/** S-36: frames of エリア1's building kept on the probe (it may wait a while to be out of view). */
const MAX_AREA1_FRAMES = 300;
/**
 * 仮 (S-40; 発案者 2026-10-26: 視界の中で足すときは霞の奥からゆっくり現れる): seconds エリア1 takes to come out of the haze when it is
 * added in view (on the game's one curve, glassEase).
 */
const APPEAR_SECONDS = 3.5;
/**
 * 仮 (S-40): the band of light at the shortcut's front: how much brighter and how many times wider than the prologue's (it runs
 * in the morning, over 40 m, and is seen from the summit and the plaza: a thin bright line there reads as a white thread).
 */
const SHORTCUT_GLOW = 2;
const SHORTCUT_BAND_WIDTH = 5;
/**
 * S-41, S-44 (発案者 2026-10-28: 覗く像の遠端は 150m、ただし目印は遠くても描く): how far the peek image reaches — the way's haze's far
 * end (plaza.ts FOG_WAY.far, 150 m), never past the haze where the body stands (fogRangeAt: 150 m on the way, 300 m in the town).
 * In the town that leaves out the workshop's furniture, the slope and the town's houses 150–300 m off, inside the haze; the
 * landmarks (plaza.ts markLandmark: the lighthouse, エリア1's chimney, the drop towers, the greenhouse) and the back layer are
 * drawn however far (PeekPipeline). Dev: ?peekFar=<m>, the probe's setPeekFar.
 */
const peekFarOf = (fogFar: number): number => Math.min(fogFar, FOG_WAY.far);
/** 仮: how long the one-line controls hint stays while the mouse is free. */
const HINT_SECONDS = 8;
/** UI/UX設計 > ゲーム中: 0.2秒で現れ、離れると消える (the prompt, and the rims of what you can act on). */
const FOCUS_SECONDS = 0.2;
/** S-42: a camera pose (where it stands, a point it looks at). */
export type Pose = { pos: THREE.Vector3; target: THREE.Vector3 };
const smoothSpan = (u: number, from: number, to: number): number => {
  const t = Math.min(1, Math.max(0, (u - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
/** Yaw and pitch of a direction (layout.ts lookDirection's angles). */
function anglesOf(x: number, y: number, z: number, out: { yaw: number; pitch: number }): void {
  const len = Math.hypot(x, y, z) || 1;
  out.yaw = Math.atan2(-x, -z);
  out.pitch = Math.asin(Math.min(1, Math.max(-1, y / len)));
}
/** `a` moved by whole turns to lie within half a turn of `near`. */
const turnNear = (a: number, near: number): number =>
  a - 2 * Math.PI * Math.round((a - near) / (2 * Math.PI));
/**
 * S-42 (仮): where the dive's time (its share, 0..1) leaves its own way for where play stands: in the workshop the eye's turn
 * starts above it (u 0.3) and its place from the skylight's crossing on (u 0.62: dive-path.ts, the moment the home camera
 * passes the orb's surface); out of it the camera leaves above the workshop (u 0.15) and is over the eye a little before
 * the end. The dive's u is its eased value (glassEase of its time: ui/flow), so these are times along it.
 */
const TURN_FROM = glassEaseInverse(0.3);
const SKYLIGHT_FROM = glassEaseInverse(0.62);
const LEAVE_FROM = glassEaseInverse(0.15);
const OVER_EYE_AT = 0.92;
/** 仮: the arc over the town rises this share of the way to go, within these heights (m). */
const ARC_RISE = 0.2;
const ARC_MIN = 6;
const ARC_MAX = 50;
const path = { yaw: 0, pitch: 0 };
const eyeAngles = { yaw: 0, pitch: 0 };
const landingAngles = { yaw: 0, pitch: 0 };
/**
 * S-42: bends the dive's camera (`pos`, `target`: its pose at the dive's eased value u) toward where play stands (`eye`), so
 * that the dive back from the pause's タイトルへ leaves from that eye and the dive in again ends there. Returns how far
 * (0..1) its place has gone over (the haze follows it). `landing` is the dive's own end (the landing pose).
 *  - in the workshop: the dive's own way in through the skylight, moved over by how far the eye stands from the landing
 *    pose, and its view turned by how far the eye looks away from the landing's. The landing pose (the first dive) bends
 *    nothing
 *  - out of it (仮): from above the workshop the camera leaves the dive in an arc high over the town, is over the eye a
 *    little before the end and comes down onto it; its view turns from the dive's (down onto the workshop) to the eye's.
 *    It passes through neither the dome nor the town (for a roof right over the eye, see S-42 残件)
 * Both run on the dive's time, not its eased value, so the way is spread over the dive (no leap in its fast middle).
 */
export function towardEye(
  u: number,
  landing: Pose,
  eye: Pose,
  pos: THREE.Vector3,
  target: THREE.Vector3,
): number {
  const t = glassEaseInverse(Math.min(1, Math.max(0, u)));
  anglesOf(target.x - pos.x, target.y - pos.y, target.z - pos.z, path);
  anglesOf(eye.target.x - eye.pos.x, eye.target.y - eye.pos.y, eye.target.z - eye.pos.z, eyeAngles);
  const l = landing;
  anglesOf(l.target.x - l.pos.x, l.target.y - l.pos.y, l.target.z - l.pos.z, landingAngles);
  // how far the eye looks round from the landing pose, the short way
  const turnAway = turnNear(eyeAngles.yaw - landingAngles.yaw, 0);
  const inWorkshop =
    Math.hypot(eye.pos.x, eye.pos.z) < WORKSHOP_FLOOR_RADIUS - 0.4 && eye.pos.y < WORKSHOP_TOP - 1;
  let placed: number;
  let yaw: number;
  let pitch: number;
  if (inWorkshop) {
    placed = smoothSpan(t, SKYLIGHT_FROM, 1);
    pos.x += (eye.pos.x - l.pos.x) * placed;
    pos.y += (eye.pos.y - l.pos.y) * placed;
    pos.z += (eye.pos.z - l.pos.z) * placed;
    // the dive's own view, turned by the eye's turn from the landing's (over the end of the dive, not at its end)
    const turn = smoothSpan(t, TURN_FROM, 1);
    yaw = path.yaw + turnAway * turn;
    pitch = path.pitch + (eyeAngles.pitch - landingAngles.pitch) * turn;
  } else {
    placed = smoothSpan(t, LEAVE_FROM, 1);
    if (placed <= 0) return 0;
    const across = smoothSpan(t, LEAVE_FROM, OVER_EYE_AT);
    const rise = Math.min(
      ARC_MAX,
      Math.max(ARC_MIN, ARC_RISE * Math.hypot(eye.pos.x - pos.x, eye.pos.z - pos.z)),
    );
    pos.x += (eye.pos.x - pos.x) * across;
    pos.z += (eye.pos.z - pos.z) * across;
    pos.y += (eye.pos.y - pos.y) * placed + rise * Math.sin(Math.PI * placed);
    // from the dive's view to the eye's (its yaw taken on the side the landing's turn says, as the dive's own view turns)
    yaw = path.yaw + turnNear(eyeAngles.yaw - path.yaw, turnAway) * placed;
    pitch = path.pitch + (eyeAngles.pitch - path.pitch) * placed;
  }
  const c = Math.cos(pitch);
  target.set(pos.x - Math.sin(yaw) * c, pos.y + Math.sin(pitch), pos.z - Math.cos(yaw) * c);
  return placed;
}
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
  hints: EventBus<HintEvent>;
  shortcut: EventBus<ShortcutEvent>;
  gates: EventBus<AreaGateEvent>;
  /** S-42: the input's asks for the pause. */
  pauses: EventBus<'pause'>;
}

/** A rectangle on the ground (x and z). */
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** The built room: everything heavy (Rapier, the art, the pipelines). */
interface BuiltRoom {
  scene: THREE.Scene;
  fogRange: { near: { value: number }; far: { value: number } };
  warm(): void;
  setPlaying(on: boolean): void;
  setHeld(held: boolean): void;
  relock(): void;
  applySettings(settings: WorldSettings): void;
  /** S-48: the peek image's scale and the anti-aliasing of another preset. */
  applyQuality(preset: Readonly<QualityPreset>): void;
  /** S-42: where play stands — the eye, a point it looks at, and the haze there. */
  eyePose(outPos: THREE.Vector3, outTarget: THREE.Vector3, outFog: { near: number; far: number }): void;
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
  const hints = new EventBus<HintEvent>();
  const shortcut = new EventBus<ShortcutEvent>();
  const gates = new EventBus<AreaGateEvent>();
  const pauses = new EventBus<'pause'>();
  const probe: RoomProbe = {
    ready: false,
    playing: false,
    time: 0,
    timeScale: 1,
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
    bridgeSegments: footingOf([PROLOGUE_AREA]).length,
    onBackFooting: false,
    shaking: false,
    target: null,
    targetId: null,
    drop: 'waiting',
    dropTaken: false,
    dropMaterialized: false,
    drops: [],
    areas: {},
    daylight: daylightAt(s.feet[0]),
    area1: {
      state: 'waiting',
      compileSeconds: null,
      startedAt: null,
      addedAt: null,
      readyAt: null,
      addedInView: false,
      frames: 0,
      worstMs: 0,
      warmed: 0,
      frameMs: [],
      buildMs: [],
      warmMs: [],
      wall: { segments: surfaceSegments(ROOM1_WALL).length, off: 0 },
      next: 0,
      next2: 0,
      appear: 0,
      shown: 0,
      entries: 0,
      walls: Object.fromEntries(
        surfaceWallsOf(AREA1).map((w) => [w.id, { segments: surfaceSegments(w).length, off: 0 }]),
      ),
      footing: { segments: footingOf([AREA1]).length, active: 0, settled: 0 },
      motes: 0,
      shortcut: { settle: 0, front: null, leg: null, events: [] },
      nextRoom: 0,
      gates: Object.fromEntries(AREA1_GATES.map((g) => [g.id, { progress: 0, angle: 0, events: [] }])),
    },
    orbAt: PEDESTAL_ORB,
    dropAt: DROP,
    events: [],
    lastAction: null,
    backPassFrames: 0,
    drawCalls: 0,
    triangles: 0,
    fallRescues: 0,
    peekFar: { far: 0, leftOut: 0, leftOutBack: 0, keptBack: 0, keptLandmarks: 0 },
    peekQuality: { peekScale: 0, antialias: 'none', backWidth: 0, backHeight: 0 },
    orbScreen: { x: 0, y: 0, r: 0, visible: false },
    access: { headBob: 1, distortion: 1, calm: false, contrast: false, bloom: null },
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
    membrane: { holding: false, film: 0, call: 0, whispers: [] },
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
      area1: {
        plaza: { center: AREA1_PLAZA.center, radius: AREA1_PLAZA.radius },
        roadFromX: AREA1_ROAD.fromX,
        roadToX: AREA1_ROAD.toX,
        pedestalOrb: ROOM1_PEDESTAL.orb,
        drop: ROOM1_DROP.at,
        wall: { min: ROOM1_WALL.box.min, max: ROOM1_WALL.box.max },
        alley: { ...ROOM1_ALLEY },
        chimneyTop: [AREA1_CHIMNEY.foot[0], TOWN.center[1] + AREA1_CHIMNEY.top, AREA1_CHIMNEY.foot[2]],
        slope: {
          x: AREA1_SLOPE.x,
          fromZ: AREA1_SLOPE.fromZ,
          landingFromZ: AREA1_SLOPE.landingFromZ,
          landingToZ: AREA1_SLOPE.landingToZ,
          toZ: AREA1_SLOPE.toZ,
        },
        room2: {
          court: { ...ROOM2_COURT },
          courtY: COURT_Y,
          balcony: { ...ROOM2_BALCONY },
          stairs: {
            minX: ROOM2_STAIRS.minX,
            maxX: ROOM2_STAIRS.maxX,
            footZ: ROOM2_STAIRS_FOOT_Z,
            topZ: ROOM2_STAIRS.topZ,
          },
          pedestals: { a: ROOM2_PEDESTAL_A.orb, b: ROOM2_PEDESTAL_B.orb },
          ids: { a: ROOM2_PEDESTAL_A.id, b: ROOM2_PEDESTAL_B.id, drop: ROOM2_DROP.id },
          wall: { min: ROOM2_WALL.box.min, max: ROOM2_WALL.box.max },
          drop: ROOM2_DROP.at,
        },
        room3: {
          terrace: { ...ROOM3_TERRACE },
          summitY: SUMMIT_Y,
          edge: ROOM3_EDGE,
          bridges: { n: ROOM3_BRIDGE_N, s: ROOM3_BRIDGE_S },
          roofs: { n: { ...ROOM3_ROOF_N }, s: { ...ROOM3_ROOF_S } },
          pedestals: { n: ROOM3_PEDESTAL_N.orb, s: ROOM3_PEDESTAL_S.orb },
          ids: { n: ROOM3_PEDESTAL_N.id, s: ROOM3_PEDESTAL_S.id, drop: ROOM3_DROP.id },
          drop: ROOM3_DROP.at,
          shade: ROOM3_SHADE.map((w) => ({ ...w })),
          railing: ROOM3_RAILING.box,
        },
        gates: AREA1_GATES.map((g) => ({
          id: g.id,
          after: g.after,
          at: g.at,
          halfWidth: g.halfWidth,
          swing: g.swing,
        })),
        shortcut: {
          minX: SHORTCUT_STAIRS.minX,
          maxX: SHORTCUT_STAIRS.maxX,
          topZ: SHORTCUT_STAIRS.topZ,
          footZ: SHORTCUT_STAIRS.footZ,
          gate: SHORTCUT_GATE.box,
          seconds: SHORTCUT_SECONDS,
        },
      },
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
  // S-42: the game's time speed (the pause stops it) and the game's own clock, which runs at it
  let timeScale = 1;
  let clock: number | null = null;
  let held = false;
  // S-43: the player's settings, kept for the room once it is built
  let settings: WorldSettings | null = null;
  // S-48: a preset switched to in play before the room was built
  let quality: Readonly<QualityPreset> | null = null;
  const eye = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fog: { near: 0, far: 0 } };
  const landing: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  dive.pose(1, landing.pos, landing.target);
  const shell: Shell = { camera, probe, events, finale, hints, shortcut, gates, pauses };
  return {
    get scene() {
      return built?.scene ?? placeholder;
    },
    camera,
    pivot: dive.pivot,
    miniatureFov,
    get standingFov() {
      return settings?.fovDeg ?? FOV_DEFAULT;
    },
    probe,
    events,
    finale,
    hints,
    shortcut,
    gates,
    pose(u, outPos, outTarget) {
      dive.pose(u, outPos, outTarget);
      if (!built) return;
      // S-42: the dive ends where play stands (back from the pause's タイトルへ, and in again, it passes through that eye
      // and its haze; the first time that is the landing pose itself, and the dive is as it was)
      let w = 0;
      if (u > 0) {
        built.eyePose(eye.pos, eye.target, eye.fog);
        w = towardEye(u, landing, eye, outPos, outTarget);
      }
      // the haze is set for standing in the room; seen from afar (the miniature) it moves out with the camera
      const away = Math.max(0, outPos.length() - 25);
      const near = 18 + away;
      const far = 150 + away * 3;
      built.fogRange.near.value = near + (eye.fog.near - near) * w;
      built.fogRange.far.value = far + (eye.fog.far - far) * w;
    },
    prepare() {
      building ??= buildRoom(ctx, opts, shell).then((b) => {
        if (disposed) {
          b.dispose();
          return;
        }
        built = b;
        b.setPlaying(playing);
        b.setHeld(held);
        if (settings) b.applySettings(settings);
        if (quality) b.applyQuality(quality);
      });
      return building;
    },
    warm: () => built?.warm(),
    setPlaying(on) {
      playing = on;
      built?.setPlaying(on);
    },
    update(dt, t) {
      const d = dt * timeScale;
      clock = clock === null ? t : clock + d;
      built?.update(d, clock);
    },
    render: () => built?.render(),
    resize: () => built?.resize(),
    onPauseRequest: (listener) => pauses.on(listener),
    setTimeScale(scale) {
      timeScale = Number.isFinite(scale) ? Math.min(1, Math.max(0, scale)) : 1;
      probe.timeScale = timeScale;
    },
    setHeld(on) {
      held = on;
      built?.setHeld(on);
    },
    relock: () => built?.relock(),
    applySettings(s) {
      settings = s;
      built?.applySettings(s);
    },
    applyQuality(_level, preset) {
      quality = preset;
      built?.applyQuality(preset);
    },
    dispose() {
      disposed = true;
      built?.dispose();
      built = null;
      events.clear();
      finale.clear();
      hints.clear();
      shortcut.clear();
      gates.clear();
      pauses.clear();
    },
  };
}

async function buildRoom(ctx: SceneContext, opts: RoomOptions, shell: Shell): Promise<BuiltRoom> {
  const { renderer, canvas, overlay, quality } = ctx;
  const { camera, probe, events, finale, hints, shortcut, gates } = shell;
  // the workshop's interior (S-24): modelled in Blender, exported by `pnpm assets`; its furniture collides as its _col.
  // Loaded alongside Rapier, before anything that would need releasing if the file failed to load.
  const [R, workshop] = await Promise.all([
    initPhysics(),
    loadAreaAsset(renderer, quality, `${import.meta.env.BASE_URL}${WORKSHOP_ASSET}`),
  ]);
  const world = createWorld();
  addRoomColliders(R, world);
  // A surface-only wall on the dead end's lip (?trial=surface-wall; S-24's trial wall, not in the prologue's design): its
  // segments lose their collider while wholly inside a placed orb's sphere, and picking the orb up while standing in
  // one is refused (S-28, process/slices/S-28.md). S-36: declared in the prologue's room (game/area), like エリア1's wall.
  const trialWall = ctx.params.get('trial') === 'surface-wall';
  const trialDecl: SurfaceDecl | null = trialWall ? { id: 'trial-wall', box: TRIAL_SURFACE_WALL } : null;
  const prologueArea: AreaDecl = trialDecl
    ? { ...PROLOGUE_AREA, rooms: PROLOGUE_AREA.rooms.map((r) => ({ ...r, surface: [trialDecl] })) }
    : PROLOGUE_AREA;
  // S-36 エリアの仕組み: the prologue's workshop and エリア1, played by one session (game/area)
  const areas: readonly AreaDecl[] = [prologueArea, AREA1];
  const footing = new BackFooting(R, world, footingOf([prologueArea]), deckSegmentShape);
  const furniture = addAssetColliders(R, world, workshop.assembled.colliders);
  const trial = trialDecl ? new SurfaceColliders(R, world, surfaceSegments(trialDecl)) : null;
  // S-34: the gate's leaves, shut until the drop is taken
  const gateLeaves = new GateLeaves(R, world);
  world.step();

  const shadowsBefore = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  // S-34: the field also draws what the drop's light has settled (the bridge, fixed onto the surface); S-40: and エリア1's
  // shortcut — a slot for each leg of light (the session's settleLegs, in its order)
  const settleSlots =
    areas.reduce((n, a) => n + a.rooms.filter((r) => r.settle && r.drop).length, 0) +
    areas.reduce((n, a) => n + (a.shortcut?.legs.length ?? 0), 0);
  const field = new LayerField({ settle: settleSlots });
  const art = buildRoomArt(renderer, quality, field, {
    ...(trialWall ? { trialWall: TRIAL_SURFACE_WALL } : {}),
    // the gate is the close's (finale.ts): its leaves open
    gate: false,
    // S-35: the mist lies under the slope's ground (the town and its lighthouse are the plaza's: plaza.ts)
    mistFloor: slopeGroundNode(),
  });
  const finaleArt = buildFinale(quality, field, art.scene);
  // S-41 dev (?peekFar=<m>, or the probe's setPeekFar for the sensors: null for the room's own)
  let peekFarOverride = holdSeconds(ctx.params.get('peekFar'));
  Object.defineProperty(probe, 'setPeekFar', {
    enumerable: false,
    configurable: true,
    value: (m: number | null): void => {
      peekFarOverride = m;
    },
  });
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
    // S-41: the peek image ends where the haze does (peekFarOf; dev: ?peekFar=<m>, for measuring)
    peekFar: () => peekFarOverride ?? peekFarOf(art.fogRange.far.value),
  });
  probe.peekQuality = pipeline.quality;

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

  const session = new PrologueSession({ orbStart: opts.orbStart, areas, membrane: MEMBRANE });
  // S-36: ?autoplay=1&autoplayTo=area1 plays on into エリア1 (to 部屋1's drop; the script alone ends at the east gate)
  if (ctx.params.get('autoplayTo') === 'area1') opts.autopilot?.extendToArea1();
  // S-36 dev hold (?area1Drop=taken, with a spawn): 部屋1's drop as if taken just before (the lamps toward the next room light).
  // S-40: or a list of the rooms whose drops are taken (?area1Drop=1,2), and the shortcut held fixed `?shortcutHold` seconds
  // after the last drop (every drop of エリア1 taken: 3 and more is fixed for good)
  if (ctx.params.has('spawn')) {
    const held = ctx.params.get('area1Drop');
    const rooms = held === 'taken' ? ['1'] : (held?.split(',') ?? []);
    const byRoom: Record<string, string> = { '1': ROOM1_DROP.id, '2': ROOM2_DROP.id, '3': ROOM3_DROP.id };
    for (const r of rooms) {
      const id = byRoom[r.trim()];
      if (id) session.holdDropTaken(id);
    }
    const hold = holdSeconds(ctx.params.get('shortcutHold'));
    if (hold !== null) session.holdShortcut(AREA1.id, hold);
  }
  const { pedestals } = session;
  // the morning where the body starts (0 in the workshop and the central plaza: the sky as it was)
  art.setDaylight(daylightAt(SPAWNS[opts.spawn].feet[0]));
  const spawn = SPAWNS[opts.spawn];
  /** Where the feet stood when last read (the film asks which side of it the body is on). */
  let feetZ = spawn.feet[2];
  /** S-40: エリア1's back-layer footing, once エリア1 is added (the player's ground asks it). */
  let a1Footing: BackFooting | null = null;
  const player = new PlayerController(world, {
    feet: { x: spawn.feet[0], y: spawn.feet[1], z: spawn.feet[2] },
    yaw: spawn.yaw,
    pitch: spawn.pitch,
    // S-35: past the film at the slope's entrance there is no ground for whoever left the vidro behind
    // S-40: エリア1's back-layer footing is ground on the same terms as the prologue's (it is there once エリア1 is added)
    allowGround: withMembrane(
      (x, y, z, c) => footing.allowGround(x, y, z, c) && (a1Footing?.allowGround(x, y, z, c) ?? true),
      () => session.holdsAtMembrane(feetZ),
    ),
  });
  player.applyToCamera(camera);

  const input = new InputSystem(canvas, { settings: { peekMode: opts.peekMode } });
  input.canPeek = () => session.canPeek;
  input.suspended = true;
  const queue: InputEvent['type'][] = [];
  const offInput = input.on((e) => queue.push(e.type));

  // the prompt's words, with the keys bound (S-45: ゲーム中の操作表示が割り当てたキーを示す; on the pad, its buttons)
  let text = controlWords(opts.lang, input.bindings, 'keyboardMouse');
  let padText = controlWords(opts.lang, input.bindings, 'gamepad');
  /** S-45 点滅を抑える: the room's own flashes calmer (the placing wave, the vidro's flash, the sweep's band). */
  let calm = false;
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
  // S-39: the hints on theirs (the vidro's whisper: its sound is src/audio/whisper.ts, played by sound.ts)
  const offHints = session.hintEvents.on((e) => {
    if (e.type === 'whisper') {
      probe.membrane.whispers.push(time);
      if (probe.membrane.whispers.length > MAX_WHISPERS) probe.membrane.whispers.shift();
    }
    hints.emit(e);
  });
  // S-40: エリア1's shortcut on its own bus (its sound: sound.ts, from the light's front)
  const offShortcut = session.shortcutEvents.on((e) => {
    probe.area1.shortcut.events.push(e.type);
    shortcut.emit(e);
  });
  // S-41: エリア1's gates between its rooms on theirs (their sound: sound.ts, the prologue gate's, from each gate)
  const offGates = session.gateEvents.on((e) => {
    probe.area1.gates[e.gate]?.events.push(e.type);
    gates.emit(e);
  });

  let playing = false;
  /** S-42: the pause is up: the input is held (playing stays true: the body keeps the camera). */
  let held = false;
  const holdInput = (): void => {
    input.suspended = !playing || held || opts.autopilot !== null;
  };
  let time = 0;
  let frames = 0;
  let prewarm = false;
  let arrivalGlow = 0;
  let target: TargetKind | null = null;
  /** S-36: the id of the pedestal or the drop targeted (null for none or the bench). */
  let targetId: string | null = null;
  let promptText = '';
  let mainRadius = 0;
  let onBackFooting = false;
  // the guard's floor a metre under the ground, down the slope too (S-35), up エリア1's slope too (S-36)
  const guard = new FallGuard((x, z) => Math.max(groundHeight(x, z), area1Ground(x, z) ?? -Infinity) - 1);
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
  const focusNow = { orb: 0, pedestal: 0, drop: 0, area1Pedestal: 0, area1Drop: 0 };
  /** S-40: the pedestal and the drop of エリア1 last targeted (its cup's rim and its drop fade in and out on them). */
  const focusIds = { pedestal: null as string | null, drop: null as string | null };
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
  /** S-36: what can be acted on, by key ('bench', 'pedestal:<id>', 'drop:<id>'): every pedestal and drop of the areas. */
  type Target = { kind: TargetKind; id: string | null };
  const candidates: TargetCandidate<Target>[] = [];
  const benchTarget: TargetCandidate<Target> = {
    target: { kind: 'bench', id: null },
    point: BENCH_ORB,
    reach: REACH,
  };
  const pedestalTargetList: TargetCandidate<Target>[] = Object.entries(pedestals).map(([id, point]) => ({
    target: { kind: 'pedestal', id },
    point,
    reach: REACH,
  }));
  const dropTargetList: TargetCandidate<Target>[] = session.dropList.map((d) => ({
    target: { kind: 'drop', id: d.id },
    point: d.at,
    reach: DROP_REACH,
  }));
  const pedestalTargets = new Map(pedestalTargetList.map((t) => [t.target.id as string, t]));
  const dropTargets = new Map(dropTargetList.map((t) => [t.target.id as string, t]));
  /** Whether a room's things are there to act on: the prologue's always, エリア1's once it is in the scene. */
  const roomOf = new Map<string, string>(session.dropList.map((d) => [d.id, d.area]));
  for (const a of areas) for (const r of a.rooms) for (const p of r.pedestals) roomOf.set(p.id, a.id);
  const present = (id: string): boolean => roomOf.get(id) !== AREA1.id || area1Here();
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
  const dropFrom = new THREE.Vector3();
  const feetAt: [number, number, number] = [0, 0, 0];
  const dropTo = new THREE.Vector3();

  const interactTarget = (): InteractTarget | null =>
    target === 'pedestal'
      ? { kind: 'pedestal', id: targetId ?? PEDESTAL_ID }
      : target === 'drop'
        ? { kind: 'drop', id: targetId ?? undefined }
        : target
          ? { kind: target }
          : null;

  const handle = (type: InputEvent['type']): void => {
    feetAt[0] = body.fx;
    feetAt[1] = body.fy;
    feetAt[2] = body.fz;
    // S-36: the sound of a drop touched comes from that drop (sound.ts reads it as the event is answered)
    if (type === 'interact' && target === 'drop' && targetId) {
      const d = dropTargets.get(targetId);
      if (d) probe.dropAt = d.point;
    }
    if (type === 'interact') probe.lastAction = session.interact(interactTarget(), feetAt);
    else if (type === 'peekDenied') {
      session.refusePeek();
      probe.lastAction = 'peek-denied';
    } else if (type === 'pause') shell.pauses.emit('pause');
  };

  // S-34: the close as the session says (or as held): the settled bridge and its band of light, the gate. S-40: every leg of
  // light the session has in its own slot of the field (the prologue's bridge first, then エリア1's shortcut, leg by leg)
  const openRad = (GATE_OPEN_DEG * Math.PI) / 180;
  const close = { settle: 0, gate: 0, angle: 0, front: null as number | null };
  const legsNow: SettleLegState[] = [];
  const legViews = Array.from({ length: settleSlots }, () => ({
    sweep: BRIDGE_SETTLE,
    front: 0,
    glow: 0,
    width: 1,
  }));
  const stageFinale = (): void => {
    const elapsed = session.finaleElapsed;
    // the light from the drop taken; the gate from when the light has reached the far shore (session.ts)
    close.settle = session.settleProgress;
    close.gate = session.gateProgress;
    close.front = elapsed === null ? null : finaleFront(BRIDGE_SETTLE, elapsed);
    session.settleLegs(legsNow);
    const sc = probe.area1.shortcut;
    sc.front = null;
    sc.leg = null;
    let area1Leg = 0;
    for (let i = 0; i < legViews.length; i++) {
      const leg = legsNow[i];
      const view = legViews[i];
      const ofArea1 = leg?.area === AREA1.id;
      if (ofArea1) area1Leg++;
      if (!leg || !view || leg.front === null) {
        field.setSettled(null, i);
        continue;
      }
      // the band of light only where the front is on its way through this leg (the prologue's: settleGlow, S-34)
      const [lo, hi] = sweepSpan(leg.sweep);
      const running = leg.front > lo + 1e-9 && leg.front < hi - 1e-9;
      view.sweep = leg.sweep;
      view.front = leg.front;
      // (the shortcut's in the morning, over 40 m: brighter than the bridge's at dawn, so it reads from the summit)
      view.glow = running
        ? sweepGlowFor(settleGlow(leg.progress) * (leg.area !== null ? SHORTCUT_GLOW : 1), calm)
        : 0;
      view.width = leg.area !== null ? SHORTCUT_BAND_WIDTH : 1;
      field.setSettled(view, i);
      if (running && ofArea1) {
        sc.leg = area1Leg - 1;
        sc.front = frontPoint(leg.sweep, leg.front);
      }
    }
    sc.settle = session.shortcutProgress(AREA1.id);
    const fixedFooting = session.settledFooting();
    const fixedSurface = session.settledSurface();
    footing.settle(fixedFooting);
    a1Footing?.settle(fixedFooting);
    for (const w of a1.walls) w.colliders.settle(fixedSurface);
    if (trial?.settle(fixedSurface) && probe.trial) probe.trial.off = trial.cutCount;
    close.angle = gateAngle(close.gate);
    finaleArt.setGate(close.angle);
    gateLeaves.sync(close.angle);
    // the keystone lamp lights as the gate starts to open (the light has come to it), on the game's one curve
    finaleArt.setKeystone(glassEase(Math.min(1, close.gate / KEYSTONE_LIGHTS)));
  };

  /** A drop is real where it is drawn (the same as the session's rule, but also under the dev holds). */
  const dropDrawn = (at: Vec3 = DROP): boolean => insideAnySphere(at[0], at[1], at[2], fieldList);

  const chooseTarget = (): void => {
    candidates.length = 0;
    const place = session.orbPlace;
    if (place === 'bench') candidates.push(benchTarget);
    else if (place === 'pedestal') {
      const t = pedestalTargets.get(session.pedestal ?? '');
      if (t) candidates.push(t);
    } else for (const t of pedestalTargetList) if (present(t.target.id as string)) candidates.push(t);
    for (const t of dropTargetList) {
      const id = t.target.id as string;
      if (present(id) && session.dropStateOf(id) === 'waiting' && dropDrawn(t.point)) candidates.push(t);
    }
    eye[0] = body.fx;
    eye[1] = body.ey;
    eye[2] = body.fz;
    const picked = pickTarget(eye, lookDirection(player.yaw, player.pitch, forward), candidates, FACING_DEG);
    target = picked?.kind ?? null;
    targetId = picked?.id ?? null;
  };

  const updatePrompt = (): void => {
    let next = '';
    // the controls hint shows only for a few seconds while the mouse is free (ゲーム中は常時表示なし), and
    // never in the dev holds (clean screenshots)
    const hint = !opts.autopilot && opts.peekHold === null && opts.growHold === null;
    const words = input.lastDevice === 'gamepad' ? padText : text;
    // S-42: nothing under the pause
    if (held) next = '';
    // (S-45: not to a player on the pad: the hint is about the mouse)
    else if (playing && !input.locked && hint && hintFor < HINT_SECONDS && input.lastDevice !== 'gamepad')
      next = text.lock;
    else if (playing && target === 'bench') next = words.take;
    else if (playing && target === 'drop') next = words.touch;
    else if (playing && target === 'pedestal')
      next = session.orbPlace === 'pedestal' ? words.pickup : words.place;
    if (next !== promptText) {
      if (next) prompt.textContent = next;
      prompt.style.opacity = next ? '1' : '0';
      promptText = next;
    }
  };

  /** A drop as the session says: hovering at `home`, flying into the vidro at `to`, or gone. */
  const poseDrop = (obj: THREE.Object3D, id: string | undefined, home: Vec3, to: Vec3): void => {
    const d = session.dropStateOf(id);
    obj.visible = d !== 'taken';
    if (d === 'waiting') {
      obj.position.set(home[0], home[1] + 0.03 * Math.sin(time * 1.6), home[2]);
      obj.rotation.y = time * 0.5;
      obj.scale.setScalar(1);
    } else if (d === 'flying') {
      const u = glassEase(session.dropProgressOf(id));
      dropFrom.set(home[0], home[1], home[2]);
      dropTo.set(to[0], to[1], to[2]);
      obj.position.lerpVectors(dropFrom, dropTo, u);
      obj.position.y += Math.sin(Math.PI * u) * 0.9;
      obj.scale.setScalar(1 - 0.75 * u);
      obj.rotation.y = time * 2;
    }
  };

  /*
   * S-36 エリア1, built behind the scenes (発案者 2026-10-25: エリアは広場にいる間に裏で組み立てる; 遷移のルール2: 待ち時間を演出の中に
   * 隠す). Once the body is over the slope's brow, coming down into the town, it is built a part a frame (area1/art.ts
   * buildArea1) and compiled in the background, then added to the scene with its colliders. S-40 (発案者 2026-10-26: 視界の外で
   * 足し、視界の中で足すときは霞の奥から現れる; 足す作業を数フレームに分ける): added at once at a frame its boxes are out of the camera's
   * view; in view (looking east down the slope: the summit and the shortcut are in the picture now), its parts are shown one
   * at a time and the whole of it comes out of the haze over APPEAR_SECONDS. Its colliders are made over the next frames
   * (the floors and houses, then the back-layer footing, then the surface-only walls). Each part is drawn uncut by the view
   * over two frames, in the scene pass and the peek image alike (a hair of peek the composite does not show), so its
   * pipelines are made before it is seen (S-38).
   */
  /** False once the room is let go of: a background compile still under way stops at its next step. */
  let alive = true;
  const a1 = {
    gen: null as Generator<void, Area1Art> | null,
    /** Frames the warm drew the peek image in (its counter is the peeks': these are taken off it). */
    peekWarms: 0,
    art: null as Area1Art | null,
    colliders: null as Area1Colliders | null,
    /** S-40: each surface-only wall of it (部屋1's, 部屋2's, the shortcut's gate), by id. */
    walls: [] as { id: string; colliders: SurfaceColliders }[],
    /** S-41: the leaves of its gates between the rooms (their posts are with its colliders). */
    gates: null as Area1Gates | null,
    /** S-40: what is left to add of its colliders, a step a frame (S-40: 足す作業を数フレームに分ける). */
    pending: [] as (() => void)[],
    warmAt: 0,
    lastFrame: null as number | null,
    /** S-40: added in view: its parts are shown one at a time and it comes out of the haze from `appearFrom` (room clock). */
    appearFrom: null as number | null,
    /** The room clock when 部屋1's / 部屋2's drop was taken (the lamps toward the next room light from then). */
    nextSince: null as number | null,
    next2Since: null as number | null,
    /** 0..3: which way the motes lead (eased toward the first room whose drop waits). */
    stage: 0,
  };
  const area1Here = (): boolean => a1.colliders !== null;
  const dropShell = art.drop.children[1] as THREE.Mesh | undefined;
  const dropCore = art.drop.children[0] as THREE.Mesh | undefined;
  /** S-40: where each of エリア1's drops hovers (they are posed from it). */
  const area1Drops = dropsOf([AREA1]);
  /** S-40: the field's slots of エリア1's shortcut (its materials read only these). */
  const area1Slots = ((): [number, number] => {
    const legs = session.settleLegs();
    let from = -1;
    let to = -2;
    for (let i = 0; i < legs.length; i++)
      if (legs[i]?.area === AREA1.id) {
        if (from < 0) from = i;
        to = i;
      }
    return [from, to];
  })();
  const startArea1 = (): void => {
    if (a1.gen || a1.art || !dropShell || !dropCore) return;
    a1.gen = buildArea1(
      quality,
      field,
      {
        coreGeometry: dropCore.geometry,
        shellGeometry: dropShell.geometry,
        shellMaterial: dropShell.material as THREE.Material,
      },
      // S-40: what is added in view comes out of the haze: the scene fog's own colour
      // S-40: and its materials read only its shortcut's slots of light (the prologue's keep S-34's one: layers/field.ts)
      { haze: hazeOf(art.scene), settleSlots: area1Slots },
    );
    probe.area1.state = 'building';
    probe.area1.startedAt = time;
  };
  /** The colliders of エリア1, in the steps they are made (S-40: a step a frame after it is added). */
  const area1ColliderSteps = (): (() => void)[] => [
    () => {
      a1.colliders = addArea1Colliders(R, world);
      // S-41: and its gates' leaves, as open as the session says
      a1.gates = new Area1Gates(R, world);
      for (const g of AREA1_GATES) a1.gates.sync(g.id, area1GateAngle(session.areaGateProgress(g.id)));
    },
    () => {
      a1Footing = area1Footing(R, world);
      a1Footing.sync(session.spheres());
    },
    () => {
      for (const w of surfaceWallsOf(AREA1)) {
        const c = new SurfaceColliders(R, world, surfaceSegments(w));
        c.sync(session.spheres());
        a1.walls.push({ id: w.id, colliders: c });
      }
    },
  ];
  /**
   * Adds the built エリア1 to the scene and its first colliders to the world: out of view, all of it at once; in view, its
   * parts hidden until each is warmed, the whole of it out of the haze from now (S-40).
   */
  const addArea1 = (inView: boolean): void => {
    const built = a1.art;
    if (!built || a1.colliders || a1.pending.length > 0) return;
    for (const e of built.entries) e.visible = !inView;
    a1.appearFrom = inView ? time : null;
    built.appear.value = inView ? 0 : 1;
    art.scene.add(built.root);
    a1.pending = area1ColliderSteps();
    (a1.pending.shift() as () => void)();
    probe.area1.state = 'warming';
    probe.area1.addedAt = time;
    probe.area1.addedInView = inView;
  };
  /** Builds a part (one a frame), adds it once compiled, makes the rest of its colliders; times the frames meanwhile. */
  const stepArea1 = (): void => {
    const st = probe.area1.state;
    if (st === 'waiting' || st === 'ready') {
      a1.lastFrame = null;
      return;
    }
    const now = performance.now();
    if (a1.lastFrame !== null) {
      probe.area1.frames++;
      probe.area1.worstMs = Math.max(probe.area1.worstMs, now - a1.lastFrame);
      if (probe.area1.frameMs.length < MAX_AREA1_FRAMES)
        probe.area1.frameMs.push(Math.round(now - a1.lastFrame));
    }
    a1.lastFrame = now;
    if (st === 'building' && a1.gen) {
      const t0 = performance.now();
      const r = a1.gen.next();
      probe.area1.buildMs.push(Math.round((performance.now() - t0) * 10) / 10);
      if (r.done) {
        a1.art = r.value;
        a1.gen = null;
        probe.area1.state = 'compiling';
        probe.area1.entries = r.value.entries.length;
        compileArea1(r.value);
      }
      return;
    }
    if (st === 'built') {
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(
        viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        camera.coordinateSystem,
      );
      // S-40: added now whatever the view: in view it comes out of the haze
      addArea1(a1.art?.bounds.some((b) => frustum.intersectsBox(b)) ?? false);
      return;
    }
    // the rest of its colliders, a step a frame
    const next = a1.pending.shift();
    if (next) {
      const t0 = performance.now();
      next();
      probe.area1.buildMs.push(Math.round((performance.now() - t0) * 10) / 10);
    }
  };
  /**
   * Compiles エリア1's shaders in the background (three's compileAsync: each pipeline made asynchronously, a yield between
   * objects), before it is added: the peek image's into the peek image's own target (the same render context as the peek
   * pass: those pipelines are the very ones it draws with), and the scene pass's into a target of its formats (three makes
   * the scene pass's again when it first draws them, nested in the finishing, but the GPU has compiled their shaders by
   * then: S-36 measured 150–220 ms frames without this). The glass (the drops: the prologue's, compiled while loading)
   * stays out of it: no transmission is drawn into a target of another size than the screen (AGENTS.md).
   */
  const compileArea1 = (built: Area1Art): void => {
    const started = performance.now();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);
    const scenePassLike = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType });
    scenePassLike.depthTexture = new THREE.DepthTexture(w, h);
    const lens = camera.clone();
    const compileInto = (target: THREE.RenderTarget, layers: number): Promise<void> => {
      const unculled: THREE.Object3D[] = [];
      const hidden: THREE.Object3D[] = [];
      built.root.traverse((o) => {
        if (drawsGlass(o) && o.visible) {
          o.visible = false;
          hidden.push(o);
        }
        if (o.frustumCulled) {
          o.frustumCulled = false;
          unculled.push(o);
        }
      });
      const previous = renderer.getRenderTarget();
      lens.layers.mask = layers;
      renderer.setRenderTarget(target);
      try {
        // three gathers what to compile synchronously, before its first await
        return renderer.compileAsync(built.root, lens, art.scene);
      } finally {
        renderer.setRenderTarget(previous);
        for (const o of unculled) o.frustumCulled = true;
        for (const o of hidden) o.visible = true;
      }
    };
    void compileInto(pipeline.backTarget, viewMask('peek'))
      .then(() => (alive ? compileInto(scenePassLike, viewMask('main')) : undefined))
      .catch((err: unknown) => {
        if (alive) console.error('S-36: エリア1 could not be compiled in the background:', err);
      })
      .finally(() => {
        scenePassLike.dispose();
        if (!alive || probe.area1.state !== 'compiling') return;
        probe.area1.compileSeconds = (performance.now() - started) / 1000;
        probe.area1.state = 'built';
      });
  };
  /** How many lamps of a room's way on have lit `since` seconds after its drop was taken (0 before). */
  const litLamps = (since: number | null): number =>
    since === null || time - since < NEXT_LIGHTS.first
      ? 0
      : (time - since - NEXT_LIGHTS.first) / NEXT_LIGHTS.each + 1;
  /**
   * S-40: which way the motes lead: to the first room whose drop waits, or (all taken) down the shortcut. S-41: the area's order
   * (game/area nextRoom), which the lamps and the gates follow too.
   */
  const motesTarget = (): number => session.nextRoom(AREA1.id);
  /** S-41: how far each gate is open (0..1) and its leaves' angle, by id (written each frame, read by the art and the probe). */
  const gateOpen: Record<string, number> = Object.fromEntries(AREA1_GATES.map((g) => [g.id, 0]));
  const gateAngles: Record<string, number> = Object.fromEntries(AREA1_GATES.map((g) => [g.id, 0]));
  /** エリア1's walls and footing, its lamps toward the next rooms, the motes, its appearance (stage, every frame). */
  const stageArea1 = (dt: number): void => {
    const built = a1.art;
    if (!built) return;
    const spheres = opts.growHold === null ? session.spheres() : fieldList;
    for (const w of a1.walls) {
      w.colliders.sync(spheres);
      const p = probe.area1.walls[w.id];
      if (p) p.off = w.colliders.cutCount;
    }
    probe.area1.wall.off = probe.area1.walls[ROOM1_WALL.id]?.off ?? 0;
    if (a1Footing) {
      a1Footing.sync(
        opts.growHold === null ? spheres : fieldList.map((s) => ({ center: s.center, radius: s.radius })),
      );
      probe.area1.footing.active = a1Footing.activeCount;
      probe.area1.footing.settled = a1Footing.settledCount;
    }
    // 次の部屋の方向が見える: once 部屋1's drop is taken, the lamps up the first flight to the courtyard light one after the other;
    // once 部屋2's, those up the second flight to the summit (S-40). S-41: always toward the next room in the area's order (the
    // first whose drop waits): a room's lamps light once the rooms up to it have given their drops
    const next = session.nextRoom(AREA1.id);
    probe.area1.nextRoom = next;
    if (a1.nextSince === null && next > 0) a1.nextSince = time;
    if (a1.next2Since === null && next > 1) a1.next2Since = time;
    const lit1 = litLamps(a1.nextSince);
    const lit2 = litLamps(a1.next2Since);
    built.setNext(lit1, lit2);
    probe.area1.next = Math.min(1, lit1 / NEXT_LAMPS_BY_ROOM.room1.length);
    probe.area1.next2 = Math.min(1, lit2 / NEXT_LAMPS_BY_ROOM.room2.length);
    // the motes turn toward the next room over 2.5 s
    const target = motesTarget();
    a1.stage =
      a1.stage < target ? Math.min(target, a1.stage + dt / 2.5) : Math.max(target, a1.stage - dt / 2.5);
    probe.area1.motes = a1.stage;
    // S-41: the gates between the rooms, as open as the session says: drawn and collided at one angle
    for (const g of AREA1_GATES) {
      const progress = session.areaGateProgress(g.id);
      const angle = area1GateAngle(progress);
      gateOpen[g.id] = progress;
      gateAngles[g.id] = angle;
      a1.gates?.sync(g.id, angle);
      const p = probe.area1.gates[g.id];
      if (p) {
        p.progress = progress;
        p.angle = angle;
      }
    }
    built.setGates(gateAngles);
    // out of the haze (S-40): from when it was added in view
    if (a1.appearFrom !== null) {
      const u = Math.min(1, (time - a1.appearFrom) / APPEAR_SECONDS);
      built.appear.value = glassEase(u);
      if (u >= 1) a1.appearFrom = null;
    }
    probe.area1.appear = built.appear.value;
    built.focus.pedestal.value = focusNow.area1Pedestal;
    built.focus.drop.value = focusNow.area1Drop;
    built.setFocus(focusIds.pedestal, focusIds.drop);
  };
  /**
   * Draws the next of エリア1's parts uncut by the view this frame (render): each over two frames, the scene pass first (S-40:
   * shown from that frame on when it was added in view), then the peek image too (each frame makes at most one part's
   * pipelines for one pass). Returns the undo and whether to draw the peek image, or null.
   */
  const warmArea1 = (): { undo: () => void; peek: boolean } | null => {
    const built = a1.art;
    if (!built || probe.area1.state !== 'warming') return null;
    const k = a1.warmAt >> 1;
    const entry = built.warm[k];
    if (!entry) {
      if (a1.pending.length > 0) return null;
      probe.area1.state = 'ready';
      probe.area1.readyAt = time;
      return null;
    }
    const peekToo = (a1.warmAt & 1) === 1;
    const part = built.entries[k];
    if (part && !part.visible) part.visible = true;
    probe.area1.shown = built.entries.reduce((n, e) => n + (e.visible ? 1 : 0), 0);
    a1.warmAt++;
    probe.area1.warmed = a1.warmAt >> 1;
    const unculled: THREE.Object3D[] = [];
    for (const root of entry)
      root.traverse((o) => {
        if (!o.frustumCulled) return;
        o.frustumCulled = false;
        unculled.push(o);
      });
    return {
      peek: peekToo,
      undo: () => {
        for (const o of unculled) o.frustumCulled = true;
      },
    };
  };

  /** Spheres, the placed orb, its light and the drop as the session says (plus the dev holds). */
  const stage = (dt = 0): void => {
    const spheres = session.spheres();
    const shake = session.shake;
    // (S-45 点滅を抑える: a faint glow instead; the vidro still trembles, the drop still flies into it)
    const flash = orbFlash(shake, arrivalGlow / DROP_ARRIVAL_GLOW_SECONDS, calm);
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
      f.glow = calmedWave(boundaryGlow(m), calm) + (sp.kind === 'main' ? flash + calling * CALL_FILM : 0);
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
    // S-36: on whichever pedestal it stands (the prologue's, or エリア1's)
    const standing = (session.pedestal !== null ? pedestals[session.pedestal] : undefined) ?? PEDESTAL_ORB;
    const at = place === 'bench' ? BENCH_ORB : standing;
    if (place === 'pedestal') probe.orbAt = standing;
    const jitter = shake > 0 ? Math.sin(time * 70) * SHAKE_AMPLITUDE * shake : 0;
    art.orb.visible = place !== 'hand' || prewarm;
    art.orb.position.set(at[0] + jitter, at[1] + jitter * 0.3, at[2] - jitter * 0.6);
    art.orbLight.position.set(standing[0], standing[1] + 0.1, standing[2]);
    art.orbGlow.value = (place === 'pedestal' ? mainGlow * 1.2 : 0) + flash * (place === 'pedestal' ? 0 : 1);
    art.orbLight.intensity = place === 'pedestal' ? mainGlow * 2.2 + call * CALL_LIGHT : 0;
    slopeArt.setFilm(session.film);
    slopeArt.setPress(call);

    // the light drops hover; once touched each rises and flies into the vidro, then is gone
    poseDrop(art.drop, session.dropList[0]?.id, DROP, at);
    const drops = a1.art?.drops;
    if (drops)
      for (const d of area1Drops) {
        const obj = drops[d.id];
        if (obj) poseDrop(obj, d.id, d.at, at);
      }
    stageFinale();
    stageArea1(dt);
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
    probe.targetId = targetId;
    probe.drop = session.dropState;
    probe.dropTaken = session.dropState === 'taken';
    probe.dropMaterialized = dropDrawn();
    // S-36: every drop and the count by area
    const list = session.dropList;
    if (probe.drops.length !== list.length)
      probe.drops = list.map((d) => ({ id: d.id, area: d.area, state: session.dropStateOf(d.id) }));
    for (const d of probe.drops) d.state = session.dropStateOf(d.id);
    probe.areas = session.areaCounts();
    probe.backPassFrames = pipeline.backPassFrames - a1.peekWarms;
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

  // S-36: straight into the town (a dev spawn: ?spawn=east, area1-…), エリア1 is there from the first frame — built before it,
  // its pipelines made in the first frames (through the home the body comes down the slope, and it is built behind the scenes;
  // ?area1=lazy builds it so in a dev spawn too, for measuring)
  if (spawn.feet[2] < SLOPE.toZ && ctx.params.get('area1') !== 'lazy') {
    startArea1();
    const gen = a1.gen as Generator<void, Area1Art> | null;
    for (let r = gen?.next(); gen && r; r = r.done ? undefined : gen.next()) if (r.done) a1.art = r.value;
    a1.gen = null;
    // compiled with everything else in the first frames (a dev view: nothing to keep smooth there)
    probe.area1.state = 'built';
    if (a1.art) probe.area1.entries = a1.art.entries.length;
    addArea1(false);
    for (let step = a1.pending.shift(); step; step = a1.pending.shift()) step();
  }

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
      holdInput();
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
    setHeld(on) {
      held = on;
      holdInput();
      if (on) input.exitLock();
    },
    relock() {
      if (playing && !opts.autopilot && !input.locked) input.requestLock();
    },
    applySettings(s) {
      input.settings.peekMode = s.peekMode;
      input.settings.mouseSensitivity = s.mouseSensitivity;
      input.settings.invertY = s.invertY;
      // S-45: the keys bound, the walking bob, the orb's distortion, the world's rims and flashes (uniforms: no shader)
      input.bindings = cloneBindings(s.bindings);
      player.settings = { fovDeg: s.fovDeg, headBob: s.headBob };
      text = controlWords(s.lang, s.bindings, 'keyboardMouse');
      padText = controlWords(s.lang, s.bindings, 'gamepad');
      calm = s.reduceFlashes;
      WORLD_ACCESS.contrast.value = s.contrast ? 1 : 0;
      WORLD_ACCESS.calm.value = calm ? 1 : 0;
      pipeline.setAccess({ distortion: s.distortion, contrast: s.contrast, calm, calmBloom: CALM.bloom });
      probe.access = {
        headBob: s.headBob,
        distortion: s.distortion,
        calm,
        contrast: s.contrast,
        bloom: pipeline.bloomStrength,
      };
      // the prompt's frosted label follows the UI's text size and contrast (アクセシビリティ)
      prompt.style.fontSize = `calc(max(18px, 1.85vh) * ${s.textScale})`;
      prompt.style.fontFamily = s.fontFamily;
      prompt.style.background = s.contrast ? 'rgba(16,22,30,.62)' : 'rgba(255,255,255,.14)';
      prompt.style.border = s.contrast
        ? '2px solid rgba(255,255,255,.82)'
        : '1px solid rgba(255,255,255,.28)';
    },
    applyQuality(preset) {
      pipeline.setQuality(preset);
      // S-45: the bloom as the settings left it, read again after the switch (sensor)
      probe.access.bloom = pipeline.bloomStrength;
    },
    eyePose(outPos, outTarget, outFog) {
      const e = player.eye;
      outPos.set(e.x, e.y, e.z);
      const d = lookDirection(player.yaw, player.pitch, forward);
      outTarget.set(e.x + d[0], e.y + d[1], e.z + d[2]);
      fogRangeAt(e.z, outFog);
    },
    update(dt, t) {
      time += dt;
      timeFrame();
      art.animate(t);
      slopeArt.animate(t);
      plazaArt.animate(t);
      a1.art?.animate(t, a1.stage, session.shortcutProgress(AREA1.id), gateOpen);
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
            taken: Object.values(session.areaCounts()).reduce((n, c) => n + c.taken, 0),
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
      stage(dt);
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
          (body.fz < BRIDGE.max[2] + 0.5 && body.fz > BRIDGE.min[2] - 0.5 && standsOnHeld(footing, feetAt)) ||
          (a1Footing !== null && body.fz < AREA1_SLOPE.fromZ && standsOnHeld(a1Footing, feetAt));
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
      // S-36: エリア1 is built once the body is over the slope's brow, the town in sight (built and compiled within a second,
      // ready before the central plaza: added on the first frame it is out of view, which walking down the slope gives —
      // from the plaza's rim the way on faces it, S-36 measured an add only on the road, in view); the sky moves toward
      // its morning
      if (probe.area1.state === 'waiting' && body.fz < SLOPE.fromZ) startArea1();
      stepArea1();
      probe.daylight = daylightAt(body.fx);
      art.setDaylight(probe.daylight);
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
      const area1Target = targetId !== null && roomOf.get(targetId) === AREA1.id;
      if (area1Target && target === 'pedestal') focusIds.pedestal = targetId;
      if (area1Target && target === 'drop') focusIds.drop = targetId;
      focusNow.pedestal = ease(focusNow.pedestal, playing && target === 'pedestal' && !area1Target, k);
      focusNow.drop = ease(focusNow.drop, playing && target === 'drop' && !area1Target, k);
      focusNow.area1Pedestal = ease(
        focusNow.area1Pedestal,
        playing && target === 'pedestal' && area1Target,
        k,
      );
      focusNow.area1Drop = ease(focusNow.area1Drop, playing && target === 'drop' && area1Target, k);
      art.focus.orb.value = focusNow.orb;
      art.focus.pedestal.value = Math.max(focusNow.pedestal, session.call * CALL_CUP);
      art.focus.drop.value = focusNow.drop;
      handOrbCenter(amount, session.handPresence, time, orbCenter);
      frame.peek = amount;
      frame.visible = session.handPresence > 0.001;
      publish();
    },
    render() {
      // S-36: one of エリア1's meshes drawn uncut by the view, also in the peek image (a hair of peek the composite does not show)
      const warming = warmArea1();
      if (warming) {
        const peekWas = frame.peek;
        if (warming.peek) frame.peek = Math.max(peekWas, 1e-4);
        const t0 = performance.now();
        try {
          pipeline.render(frame);
        } finally {
          frame.peek = peekWas;
          warming.undo();
          // counted only when the back pass was drawn for the warming alone (a player peeking draws it anyway)
          if (warming.peek && peekWas <= 0) a1.peekWarms++;
          probe.area1.warmMs.push(Math.round((performance.now() - t0) * 10) / 10);
        }
      } else pipeline.render(frame);
      frames++;
      if (frames >= 3) probe.ready = true;
      probe.backPassFrames = pipeline.backPassFrames - a1.peekWarms;
      // renderer.info is reset once per animation frame, so this is the whole frame so far
      probe.drawCalls = renderer.info.render.drawCalls;
      probe.triangles = renderer.info.render.triangles;
      probe.peekFar.far = peekFarOverride ?? peekFarOf(art.fogRange.far.value);
      probe.peekFar.leftOut = pipeline.farLeftOut;
      probe.peekFar.leftOutBack = pipeline.farLeftOutBack;
      probe.peekFar.keptBack = pipeline.farKeptBack;
      probe.peekFar.keptLandmarks = pipeline.farKeptLandmarks;
    },
    resize() {
      pipeline.resize();
    },
    dispose() {
      offInput();
      offEvents();
      offFinale();
      offHints();
      offShortcut();
      offGates();
      session.events.clear();
      session.finaleEvents.clear();
      session.hintEvents.clear();
      session.shortcutEvents.clear();
      session.gateEvents.clear();
      input.dispose();
      prompt.remove();
      player.dispose();
      footing.dispose();
      furniture.dispose();
      trial?.dispose();
      alive = false;
      for (const w of a1.walls) w.colliders.dispose();
      a1Footing?.dispose();
      a1.gates?.dispose();
      a1.colliders?.dispose();
      a1.art?.dispose();
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

/** S-40: a point of a sweep's front (where the light is): the box's middle, moved along the direction to the front. */
function frontPoint(sweep: { box: Box; direction: Vec3 }, front: number): Vec3 {
  const { min, max } = sweep.box;
  const d = sweep.direction;
  const c: Vec3 = [(min[0] + max[0]) / 2, min[1] + 0.6, (min[2] + max[2]) / 2];
  const k = front - (d[0] * c[0] + d[1] * c[1] + d[2] * c[2]);
  return [c[0] + d[0] * k, c[1] + d[1] * k, c[2] + d[2] * k];
}

/** How far above a deck the feet may be and still stand on it (layers/footing.ts segmentsUnder's). */
const STAND_TOLERANCE = 0.25;

/**
 * Do the feet stand on back-layer footing that a sphere holds now (switched on, not fixed by the light)? The same test as
 * 拾う前の安全確認 (S-02 segmentsUnder), without allocating (asked every frame).
 */
function standsOnHeld(footing: BackFooting, feet: Vec3): boolean {
  const [x, y, z] = feet;
  const segments: readonly FootingSegment[] = footing.segments;
  for (const s of segments) {
    if (x < s.min[0] || x >= s.max[0] || z < s.min[2] || z >= s.max[2]) continue;
    if (y < s.max[1] - STAND_TOLERANCE || y > s.max[1] + STAND_TOLERANCE) continue;
    if (footing.activeIds.includes(s.id) && !footing.isSettled(s.id)) return true;
  }
  return false;
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
