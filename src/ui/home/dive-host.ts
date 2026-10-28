import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { dot, exp, mix, screenSize, screenUV, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { ownBackdropImage } from '../../core/glass';
import { qualityPortOf } from '../../core/quality';
import type { SandboxScene, SceneContext } from '../../core/scene';
import { segment } from '../../core/transition';
import type { DiveWorld } from '../../game/dive-world';
import { readFirstPad } from '../../game/input/gamepad';
import { AudioGate } from '../audio-gate';
import { AUTOPLAY, parsePauseSpec } from '../autoplay';
import { ScreenFlow, TRANSITIONS } from '../flow';
import { FONT_STACK, type Lang, pickLang, STRINGS, type StringKey } from '../lang';
import { LoadingScreen } from '../loading-screen';
import { PauseHost } from '../pause/pause-host';
import { pausableOf } from '../pause/port';
import type { HomeDiveProbe, PhaseName, PhaseStats } from '../probe';
import { SettingsHost } from '../settings/settings-host';
import { defaultSettings } from '../settings/settings-model';
import { browserStorage, SettingsStore } from '../settings/settings-store';
import { createUiRoot } from '../styles';
import { diveChoreography, HOME_COMPOSITION, openingChoreography } from './choreography';
import { createLensUniforms } from './lens';
import { createMembrane } from './membrane';
import { HomeMenu } from './menu';
import { HOME_ITEMS, menuPitchHz, padMenuKey } from './menu-logic';
import { createMist } from './mist';
import { createHomeOrb } from './orb';

/**
 * 読み込み → ホーム → 玉の中へ潜る (S-04) around any game world: the home orb shows the world drawn with
 * its own camera (トランジション設計 > 遷移の一覧: 玉の中身は序章のシーンそのもの), the dive flies that
 * camera along the world's path, and once landed the world plays and draws itself.
 *
 * The world is a DiveWorld (src/game/dive-world.ts): the prologue room (S-06) or S-04's placeholder city
 * (src/scenes/home-dive.scene.ts). Made pluggable from the S-04 home-dive scene in S-06.
 */

export interface HomeDiveOptions {
  /** Sandbox only: Esc in the game plays the dive back to home (the real game opens the pause screen). */
  rewindFromGame: boolean;
  /** Published on the probe next to the home/dive state (e.g. `{ room: worldProbe }`). */
  probeExtras?: Record<string, unknown>;
  /**
   * The page's audio, when the caller shares it with the world (S-18: one AudioContext). 「はじめる」 still starts it;
   * the caller disposes it after the world's sound let go of it. Default: the host makes and disposes its own.
   */
  audio?: AudioGate;
}

const TILT_SMOOTH_SECONDS = 0.4;
const NO_BUTTONS: ReadonlySet<string> = new Set();

export function createHomeDive(ctx: SceneContext, world: DiveWorld, opts: HomeDiveOptions): SandboxScene {
  const { renderer, overlay, params } = ctx;
  const autoplay = params.get('autoplay') === '1' ? 'full' : params.has('bench') ? 'home' : 'off';
  const pauses = autoplay === 'full' ? parsePauseSpec(params.get('pause')) : new Map<string, number[]>();
  // S-43: the player's settings, kept in the browser (the language among them: 初期値はブラウザの言語設定)
  const store = new SettingsStore(
    browserStorage,
    defaultSettings({
      lang: pickLang(navigator.languages),
      peekMode: params.get('peek') === 'toggle' ? 'toggle' : 'hold',
    }),
  );
  let lang: Lang = store.settings.lang;
  const t = (k: StringKey): string => STRINGS[lang][k];
  const gameCam = world.camera;

  // the game scene is drawn into this image, which the orb (and later the whole screen) shows
  const drawSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const innerRT = new THREE.RenderTarget(Math.max(1, drawSize.x), Math.max(1, drawSize.y), {
    type: THREE.HalfFloatType,
    depthBuffer: true,
  });
  // The world's glass is drawn here on the home and into the world's own target once landed (or the canvas): with
  // one shared backdrop record (three r186), a render scale change in between left the second one's backdrop at the
  // old size; on WebGPU every frame after the dive was black (S-29).
  ownBackdropImage(innerRT);

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
  let homeEnv: THREE.RenderTarget | null = null;
  const ui = createUiRoot(overlay, lang);
  const gate = opts.audio ?? new AudioGate();
  const ownsGate = !opts.audio;
  if (autoplay !== 'off') gate.skip();
  const flow = new ScreenFlow();
  // S-42: the pause, over a world that has its port (the prologue room); its タイトルへ plays the dive back to the home
  const pausable = pausableOf(world);
  const pause = pausable
    ? new PauseHost({
        root: ui.root,
        t,
        gate,
        world: pausable,
        leave: () => flow.rewindFromGame(),
        // S-43: 設定 among the pause's items opens the panel over it
        openSettings: () => settings.open('pause'),
      })
    : null;
  // S-43: the shell's quality. This host takes another preset in place (the world keeps everything: where the body
  // stands, the orb, the drops taken, the gates, what the light settled): the shell sets the render scale, the held picture
  // is drawn again. While the pause holds the picture, the shell gives the governor none of its frames.
  const qualityPort = qualityPortOf(ctx);
  const detachQuality =
    qualityPort?.attach({
      applyQuality: () => pause?.redraw(),
      get idle() {
        return pause?.still ?? false;
      },
    }) ?? null;
  // S-43: 設定, from the home's drop and the pause's item, over the picture behind
  const settings = new SettingsHost({
    root: ui.root,
    t,
    gate,
    world,
    quality: qualityPort,
    store,
    onLang: (next) => {
      lang = next;
      ui.root.lang = next;
      ui.root.style.fontFamily = FONT_STACK[next];
      menu.relabel(t);
      pause?.relabel(t);
      settings.relabel(t);
    },
    onLayout: () => menu.invalidate(),
    onPicture: () => pause?.redraw(),
    onClosed: (from, back) => {
      // (from the home, a second Esc has nowhere further back to go)
      if (from === 'pause') pause?.settingsClosed(back);
      else if (flow.screen === 'home' && !flow.transition) menu.focusItem('settings');
      homePad = null;
    },
  });

  // ---- probe ----
  const probe: HomeDiveProbe = {
    screen: 'loading',
    transition: null,
    load: { progress: 0, fill: 0, ready: false, seconds: 0, steps: [] },
    audio: gate.state,
    audioGate: gate.probe,
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
  window.__vidro.sceneProbe = Object.assign(
    probe,
    pause ? { pause: pause.probe } : {},
    { settings: settings.probe },
    opts.probeExtras ?? {},
  ) as unknown as Record<string, unknown>;

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
    onHover: (_item, index) => gate.ping(menuPitchHz(index), 0.035, 0.8),
    onSelect: (item) => {
      probe.selected = item;
      if (flow.select(item)) gate.ping(menuPitchHz(0) / 2, 0.05, 1.8);
      else if (item === 'settings' && flow.screen === 'home' && !flow.transition) settings.open('home');
      else gate.ping(menuPitchHz(HOME_ITEMS.indexOf(item)) / 2, 0.03, 0.5);
    },
  });

  // Esc is always accepted during long transitions (遷移のルール 4) and plays them back.
  const onKey = (e: KeyboardEvent): void => {
    // the settings panel has the keys while it is up (its own listener: Esc closes it)
    if (e.key !== 'Escape' || e.repeat || settings.isUp) return;
    if (flow.escape()) gate.ping(menuPitchHz(4) / 2, 0.03, 0.7);
    else if (opts.rewindFromGame && flow.rewindFromGame()) gate.ping(menuPitchHz(0) / 2, 0.04, 1.2);
  };
  window.addEventListener('keydown', onKey);

  // mouse tilt target (−1..1)
  const mouse = new THREE.Vector2();
  const onMove = (e: PointerEvent): void => {
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  };
  window.addEventListener('pointermove', onMove);

  // ---- loading: build environment maps, compile every pipeline while the vessel fills ----
  let disposed = false;
  let orbReady = false;
  let gameReady = false;
  let warmInner = false;
  let warmPlay = false;
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
    if (disposed) return; // the scene was closed while loading
    await world.prepare();
    if (disposed) return;
    const room = new RoomEnvironment();
    homeEnv = pmrem.fromScene(room, 0.04);
    home.environment = homeEnv.texture;
    room.dispose();
    done('build the world, environment maps');
    await compileWith(null, late, outerCam, home, [membrane.mesh]);
    if (disposed) return;
    home.add(late);
    orbReady = true;
    done('compile home orb');
    await compileWith(innerRT, world.scene, gameCam, world.scene);
    if (disposed) return;
    done('compile game (orb image)');
    warmPlay = true; // one real draw of the playing view (its own passes), hidden under the home frame
    await nextFrame();
    await nextFrame();
    if (disposed) return;
    done('compile game (screen)');
    warmInner = true; // one real draw into the orb's image (transmission buffers etc.)
    await nextFrame();
    await nextFrame();
    if (disposed) return;
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
  let phaseStart = performance.now();
  let firstFrameDrawn = false;
  let playing = false;
  /** The pad's buttons held at the last reading on the home; null when the home did not read it (S-43). */
  let homePad: ReadonlySet<string> | null = null;

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
    if (flow.screen === 'loading' && flow.isLoaded && (loading.full || autoplay === 'home')) {
      dwell += dt;
      if (autoplay === 'home' || dwell >= AUTOPLAY.loadingDwell) {
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

  const statsOf = (phase: PhaseName): PhaseStats => {
    const s = probe.phases[phase] ?? {
      frames: 0,
      maxFrameMs: 0,
      maxAtSeconds: 0,
      maxDrawCalls: 0,
      maxTriangles: 0,
    };
    probe.phases[phase] = s;
    return s;
  };
  /** Frame time of the frame that was just shown, booked to the phase it showed. */
  const recordFrame = (): void => {
    const now = performance.now();
    const ms = now - lastNow;
    lastNow = now;
    if (!probe.load.ready) stepMaxFrame = Math.max(stepMaxFrame, ms);
    if (!firstFrameDrawn) return;
    const s = statsOf(lastPhase);
    s.frames++;
    if (ms > s.maxFrameMs) {
      s.maxFrameMs = ms;
      s.maxAtSeconds = (now - phaseStart) / 1000;
    }
  };

  return {
    scene: home,
    camera: outerCam,
    update(dt, time) {
      recordFrame();
      elapsed += dt;
      runAutoplay(dt);
      flow.update(feed(dt));
      const tr = flow.transition;
      const nowPlaying = flow.screen === 'game' && !tr;
      if (nowPlaying !== playing) {
        playing = nowPlaying;
        world.setPlaying(playing);
      }
      // S-42: before the world's update, so that the time speed it sets is this frame's
      pause?.update(dt, playing);
      // S-43: and the settings, so that what they change (the field of view) is in this frame's picture
      settings.update(dt);

      // back at rest on the home screen (arrived, or played back there): the keyboard focus returns
      if (hadTransition && !tr && flow.screen === 'home' && !settings.isUp)
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
      lens.warp.value = dv.warp;
      lens.ripple.value = dv.ripple;
      lens.ringRadius.value = dv.ringRadius;

      // the fog: white-out while loading, the vessel's light spills into it, then it clears
      mist.fog.value = op.fog * (1 - segment(diveP, 0, 0.3));
      mist.glow.value =
        flow.screen === 'loading'
          ? 0.12 + 0.35 * loading.fill * (1 - op.overflow) + 1.6 * Math.sin(Math.PI * op.overflow)
          : 0;
      mist.glowSpread.value = 0.09 + 0.75 * op.overflow;
      mist.glowCenter.value.set(0.5, 0.445);
      mist.mesh.visible = mist.fog.value > 0.001 || mist.glow.value > 0.001;

      // the world runs every frame (ambient motion); while playing it owns its camera
      world.update(dt, time);
      if (!playing) {
        // game camera: from the miniature view (turning with the tilt) down to where play begins
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
        gameCam.fov =
          world.miniatureFov +
          (world.standingFov - world.miniatureFov) * segment(dv.inner, 0.35, 0.92) ** 1.5;
        // same lens shift as the home camera, so the town sits in the middle of the orb
        if (look > 0) gameCam.setViewOffset(viewW, viewH, shift, 0, viewW, viewH);
        else gameCam.clearViewOffset();
        gameCam.updateProjectionMatrix();
        gameCam.updateMatrixWorld();
      }

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
      // the drops step aside while the settings are open over the home (and come back as the panel shrinks); the keys and
      // the pad are the panel's until it has closed
      const homeSettings = settings.isUp && flow.screen === 'home';
      menu.setVeiled(settings.covering && flow.screen === 'home');
      menu.setInteractive(interactiveHome && !homeSettings);
      // S-43: the pad on the home (マウスなしでもすべての画面を操作できる): 十字 between the drops, A chooses
      if (interactiveHome && !homeSettings) {
        const held = readFirstPad(homePad ?? NO_BUTTONS);
        // the first reading only notes what is held (a button held from before is not a new press)
        if (homePad) {
          for (const code of held) {
            if (homePad.has(code)) continue;
            const key = padMenuKey(code);
            if (key === 'choose') menu.chooseFocused();
            else if (key) menu.moveFocus(key);
          }
        }
        homePad = held;
      } else homePad = null;
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
      const phase = phaseOf();
      if (phase !== lastPhase) {
        lastPhase = phase;
        phaseStart = performance.now();
      }
      const tr = flow.transition;
      if (playing) {
        // standing in the world: it draws the whole picture now — but not again while the pause holds it (S-42)
        const held = pause?.holdsFrame ?? false;
        if (!held) {
          renderer.setRenderTarget(null);
          world.render();
        }
        pause?.frameDrawn(!held);
      } else {
        if (warmPlay) {
          // compile the playing view's passes; the home frame below draws over it
          warmPlay = false;
          renderer.setRenderTarget(null);
          world.warm();
        }
        const orbOnScreen = orbReady && (flow.screen !== 'loading' || tr !== null);
        if (gameReady ? orbOnScreen : warmInner) {
          // The orb's image always matches the drawing buffer, also when the render scale changes
          // without a window resize (dynamic resolution). On WebGPU, transmission drawn into a
          // target of another size than the canvas in the same frame invalidates the frame (S-05).
          renderer.getDrawingBufferSize(drawSize);
          if (innerRT.width !== drawSize.x || innerRT.height !== drawSize.y) {
            innerRT.setSize(Math.max(1, drawSize.x), Math.max(1, drawSize.y));
          }
          renderer.setRenderTarget(innerRT);
          renderer.render(world.scene, gameCam);
        }
        renderer.setRenderTarget(null);
        renderer.render(home, outerCam);
      }
      // renderer.info is reset once per animation frame, so here it holds every pass of this frame
      const s = statsOf(phase);
      s.maxDrawCalls = Math.max(s.maxDrawCalls, renderer.info.render.drawCalls);
      s.maxTriangles = Math.max(s.maxTriangles, renderer.info.render.triangles);
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
      world.resize(width, height);
      pause?.resize(width, height);
    },
    dispose() {
      disposed = true;
      window.__vidro.sceneProbe = {};
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onMove);
      detachQuality?.();
      loading.dispose();
      menu.dispose();
      settings.dispose();
      pause?.dispose();
      ui.dispose();
      if (ownsGate) gate.dispose();
      orb.dispose();
      membrane.dispose();
      mist.dispose();
      world.dispose();
      innerRT.dispose();
      pmrem.dispose();
      homeEnv?.dispose();
    },
  };
}
