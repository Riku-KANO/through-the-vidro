import * as THREE from 'three/webgpu';
import type { SceneContext } from '../../core/scene';
import type { FieldSphere } from '../../layers/field';
import { LayerField } from '../../layers/field';
import { segmentsUnder, splitFooting, type Vec3 } from '../../layers/footing';
import { boundaryGlow, MAIN_ORB_RADIUS, materializedRadius } from '../../layers/materialize';
import { glassEase } from '../../layers/tween';
import type { DiveWorld } from '../../ui/home/dive-host';
import { pickLang } from '../../ui/lang';
import { type InputEvent, InputSystem } from '../input/input-system';
import { HAND_ORB_RADIUS, handOrbCenter, orbScreenCircle } from '../orb/hand-pose';
import { PeekPipeline } from '../orb/peek-pipeline';
import { EYE_HEIGHT, FOV_DEFAULT } from '../player/constants';
import { combineModifiers } from '../player/motion';
import { createWorld, initPhysics } from '../player/physics';
import { PlayerController, type PlayerIntent } from '../player/player';
import type { Autopilot } from './autopilot';
import { createDivePath } from './dive-path';
import type { EventBus, PrologueEvent } from './events';
import {
  BENCH_ORB,
  BRIDGE,
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
} from './layout';
import { addRoomColliders, BackFooting } from './physics';
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
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  autoplay: { step: string; done: boolean } | null;
  layout: { edgeZ: number; farZ: number; pedestalOrb: Vec3; drop: Vec3 };
}

export interface PrologueRoom extends DiveWorld {
  readonly probe: RoomProbe;
  /** The orb's and the room's events (覗く・置く・拾う・震える, 雫): the port for S-09's sounds. */
  readonly events: EventBus<PrologueEvent>;
}

/** 仮: how long the vidro glows after the light drop reaches it. */
const DROP_ARRIVAL_GLOW_SECONDS = 0.9;
const MAX_EVENTS = 40;
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

export async function createPrologueRoom(ctx: SceneContext, opts: RoomOptions): Promise<PrologueRoom> {
  const { renderer, canvas, overlay, quality } = ctx;
  const R = await initPhysics();
  const world = createWorld();
  addRoomColliders(R, world);
  const footing = new BackFooting(R, world, splitFooting('bridge', BRIDGE, FOOTING_SEGMENT));
  world.step();

  const shadowsBefore = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = true;
  const field = new LayerField();
  const art = buildRoomArt(renderer, quality, field);
  for (const m of field.membranes) art.scene.add(m);
  const camera = new THREE.PerspectiveCamera(FOV_DEFAULT, 1, 0.05, 420);
  const pipeline = new PeekPipeline({
    renderer,
    scene: art.scene,
    camera,
    field,
    peekScale: quality.peekScale,
    environment: art.environment,
  });
  const dive = createDivePath();

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

  const lang = pickLang(navigator.languages);
  const text = STRINGS[lang];
  const prompt = createPrompt(overlay);

  // dev holds (screenshots): a placed orb frozen mid-growth
  if (opts.growHold !== null) {
    session.interact({ kind: 'pedestal', id: PEDESTAL_ID }, spawn.feet);
  }

  const probe: RoomProbe = {
    ready: false,
    playing: false,
    time: 0,
    position: { x: 0, y: 0, z: 0 },
    grounded: false,
    speed: 0,
    eyeHeight: EYE_HEIGHT,
    yaw: 0,
    pitch: 0,
    fov: FOV_DEFAULT,
    locked: false,
    peeking: false,
    peekAmount: 0,
    moveSpeed: 1,
    orb: session.orbPlace,
    pedestal: null,
    handPresence: 0,
    sphereRadius: 0,
    bridgeColliders: 0,
    bridgeSegments: footing.segments.length,
    onBackFooting: false,
    shaking: false,
    target: null,
    drop: 'waiting',
    dropTaken: false,
    dropMaterialized: false,
    events: [],
    lastAction: null,
    backPassFrames: 0,
    orbScreen: { x: 0, y: 0, r: 0, visible: false },
    autoplay: opts.autopilot ? { step: '', done: false } : null,
    layout: { edgeZ: EDGE_Z, farZ: FAR.maxZ, pedestalOrb: PEDESTAL_ORB, drop: DROP },
  };
  const offEvents = session.events.on((e) => {
    const name = e.type === 'pickup' ? `pickup:${e.from}` : e.type === 'shake' ? `shake:${e.reason}` : e.type;
    probe.events.push(name);
    if (probe.events.length > MAX_EVENTS) probe.events.shift();
    if (e.type === 'dropTaken') arrivalGlow = DROP_ARRIVAL_GLOW_SECONDS;
  });

  let playing = false;
  let time = 0;
  let frames = 0;
  let prewarm = false;
  let arrivalGlow = 0;
  let target: TargetKind | null = null;
  let promptText = '';
  const idle: PlayerIntent = { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 };
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
  const dropFrom = new THREE.Vector3(...DROP);
  const feetAt: [number, number, number] = [0, 0, 0];
  const dropTo = new THREE.Vector3();

  const interactTarget = (): InteractTarget | null =>
    target === 'pedestal' ? { kind: 'pedestal', id: PEDESTAL_ID } : target ? { kind: target } : null;

  const handle = (type: InputEvent['type']): void => {
    const f = player.feet;
    if (type === 'interact') probe.lastAction = session.interact(interactTarget(), [f.x, f.y, f.z]);
    else if (type === 'peekDenied') {
      session.refusePeek();
      probe.lastAction = 'peek-denied';
    }
  };

  const chooseTarget = (): void => {
    candidates.length = 0;
    const place = session.orbPlace;
    if (place === 'bench') candidates.push({ target: 'bench', point: BENCH_ORB, reach: REACH });
    else candidates.push({ target: 'pedestal', point: PEDESTAL_ORB, reach: REACH });
    if (session.dropState === 'waiting' && session.dropMaterialized())
      candidates.push({ target: 'drop', point: DROP, reach: DROP_REACH });
    const e = player.eye;
    eye[0] = e.x;
    eye[1] = e.y;
    eye[2] = e.z;
    target = pickTarget(eye, lookDirection(player.yaw, player.pitch), candidates, FACING_DEG);
  };

  const updatePrompt = (): void => {
    let next = '';
    if (playing && !input.locked && !opts.autopilot) next = text.lock;
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
    fieldList.length = 0;
    for (let i = 0; i < spheres.length; i++) {
      const sp = spheres[i];
      const f = fieldSpheres[i];
      if (!sp || !f) continue;
      const held = opts.growHold !== null && sp.kind === 'main';
      const m = held ? { progress: opts.growHold ?? 1, target: 1 as const } : sp.materialize;
      f.center = sp.center;
      f.radius = held ? materializedRadius(m, MAIN_ORB_RADIUS) : sp.radius;
      f.glow = boundaryGlow(m) + (sp.kind === 'main' ? flash : 0);
      if (sp.kind === 'main') mainGlow = f.glow;
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
    // colliders follow the session's spheres (the same array until the orbs change); the dev hold its own
    footing.sync(
      opts.growHold === null ? spheres : fieldList.map((s) => ({ center: s.center, radius: s.radius })),
    );

    const place = session.orbPlace;
    const at = place === 'bench' ? BENCH_ORB : PEDESTAL_ORB;
    const jitter = shake > 0 ? Math.sin(time * 70) * SHAKE_AMPLITUDE * shake : 0;
    art.orb.visible = place !== 'hand' || prewarm;
    art.orb.position.set(at[0] + jitter, at[1] + jitter * 0.3, at[2] - jitter * 0.6);
    art.orbGlow.value = (place === 'pedestal' ? mainGlow * 1.2 : 0) + flash * (place === 'pedestal' ? 0 : 1);
    art.orbLight.intensity = place === 'pedestal' ? mainGlow * 4.5 : 0;

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
    const f = player.feet;
    const v = player.velocity;
    const e = player.eye;
    probe.time = time;
    probe.playing = playing;
    probe.position.x = f.x;
    probe.position.y = f.y;
    probe.position.z = f.z;
    probe.grounded = player.grounded;
    probe.speed = Math.hypot(v.x, v.z);
    probe.eyeHeight = e.y - f.y;
    probe.yaw = player.yaw;
    probe.pitch = player.pitch;
    probe.fov = camera.fov;
    probe.locked = input.locked;
    probe.peeking = session.peeking;
    probe.peekAmount = frame.peek;
    probe.moveSpeed = combineModifiers(player.modifiers.values()).speedMultiplier;
    probe.orb = session.orbPlace;
    probe.pedestal = session.pedestal;
    probe.handPresence = session.handPresence;
    const main = session.spheres().find((s) => s.kind === 'main');
    probe.sphereRadius = main?.radius ?? 0;
    probe.bridgeColliders = footing.activeCount;
    // the same test as 拾う前の安全確認 (S-02 segmentsUnder), on the segments that are solid now
    feetAt[0] = f.x;
    feetAt[1] = f.y;
    feetAt[2] = f.z;
    probe.onBackFooting = segmentsUnder(feetAt, footing.segments).some((seg) =>
      footing.activeIds.includes(seg.id),
    );
    probe.shaking = session.shake > 0;
    probe.target = target;
    probe.drop = session.dropState;
    probe.dropTaken = session.dropState === 'taken';
    probe.dropMaterialized = session.dropMaterialized();
    probe.backPassFrames = pipeline.backPassFrames;
    orbScreenCircle(frame.center, HAND_ORB_RADIUS, camera.fov, camera.aspect, probe.orbScreen);
    probe.orbScreen.visible = frame.visible;
    if (probe.autoplay && opts.autopilot) {
      probe.autoplay.step = opts.autopilot.current;
      probe.autoplay.done = opts.autopilot.done;
    }
  };

  const room: PrologueRoom = {
    scene: art.scene,
    camera,
    pivot: dive.pivot,
    miniatureFov: 44,
    standingFov: FOV_DEFAULT,
    probe,
    events: session.events,
    pose(u, outPos, outTarget) {
      dive.pose(u, outPos, outTarget);
      // the haze is set for standing in the room; seen from afar (the miniature) it moves out with the camera
      const away = Math.max(0, outPos.length() - 25);
      art.fogRange.near.value = 18 + away;
      art.fogRange.far.value = 150 + away * 3;
    },
    prepare() {},
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
        intent = { move: input.move, sprint: input.sprint, lookYaw: look.yaw, lookPitch: look.pitch };
        wantPeek = input.peeking || opts.forcePeek;
        const pilot = opts.autopilot;
        if (pilot) {
          const f = player.feet;
          const order = pilot.step(dt, {
            feet: [f.x, f.y, f.z],
            yaw: player.yaw,
            pitch: player.pitch,
            speed: Math.hypot(player.velocity.x, player.velocity.z),
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
      session.step(dt, { wantPeek });
      arrivalGlow = Math.max(0, arrivalGlow - dt);
      const amount = opts.peekHold ?? session.peekAmount;
      if (amount > 0) player.modifiers.set('peek', peekModifier(amount));
      else player.modifiers.delete('peek');
      stage();
      world.step();
      if (playing) {
        player.update(dt, intent);
        player.applyToCamera(camera);
        camera.updateMatrixWorld();
      }
      chooseTarget();
      updatePrompt();
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
      world.free();
      pipeline.dispose();
      field.dispose();
      art.dispose();
      renderer.shadowMap.enabled = shadowsBefore;
    },
  };
  return room;
}
