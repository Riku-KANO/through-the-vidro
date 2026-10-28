import type * as THREE from 'three/webgpu';
import {
  checkBudget,
  type FrameStats,
  type GpuStats,
  type RenderCounters,
  summarizeFrameTimes,
  summarizeGpuTimes,
} from './core/bench';
import { parseParams } from './core/params';
import { PerfGovernor } from './core/perf/governor';
import { GpuSpanTimer, type GpuTimeSource } from './core/perf/gpu-span';
import type { QualityDecision } from './core/perf/quality-select';
import {
  QUALITY_PRESETS,
  type QualityChoice,
  type QualityLevel,
  type QualityPort,
  type QualityScene,
  startQuality,
} from './core/quality';
import { type Backend, createRenderer } from './core/renderer';
import type { SandboxScene, SceneContext, SceneModule } from './core/scene';
import type { BackdropReport } from './dev/backdrop-risks';
import { type StatsExtras, StatsOverlay } from './dev/stats';
import { PassTimestampDrain } from './dev/timestamp-drain';
import { loadScene, sceneNames } from './scenes/registry';
import { browserStorage, readSavedQuality } from './ui/settings/settings-store';

/**
 * Machine-readable probe for the browser sensor (tests/e2e) and the dev loop.
 * Status flow: booting → running → (benchmarking → done) | error
 */
export interface BenchResult extends FrameStats {
  seconds: number;
  /**
   * three's per-pass GPU timestamp sum (reference only: passes overlap on Apple/Metal and read ~10× too high);
   * null when the backend cannot measure it.
   */
  gpu: GpuStats | null;
  /** GPU frame span (first pass start → last pass end, S-08); null without WebGPU timestamp queries. */
  gpuSpan: GpuStats | null;
  /**
   * CPU time of the scene's render() in JS (encoding and submitting the passes), on the frames whose GPU time is
   * sampled. Tells a span stretched by waiting for submits from one stretched by the GPU itself (S-08).
   */
  cpuRenderMs: GpuStats | null;
  maxDrawCalls: number;
  maxTriangles: number;
  budgetViolations: ReturnType<typeof checkBudget>;
}

export interface VidroProbe {
  status: 'booting' | 'running' | 'benchmarking' | 'done' | 'error';
  scene: string | null;
  backend: Backend | null;
  /** Preset in use: the one the scene was created with, or switched to in place (S-43). */
  quality: QualityLevel;
  /** What is chosen: a preset or 自動 (the URL's ?quality, the player's saved choice or the settings; S-43). */
  qualityChoice: QualityChoice;
  /** Where the starting preset came from: the URL, the player's saved settings, or the default (mid). */
  qualityOrigin: 'url' | 'saved' | 'default';
  /** Presets switched without making the scene again (the settings, or 自動 chosen there: S-43). */
  qualitySwitchesInPlace: number;
  /** Frames whose picture stood still (the pause): none of them, nor their GPU time, went to the governor (S-43). */
  idleFrames: number;
  /** Current render scale (preset × dynamic resolution), relative to the device pixel ratio. */
  renderScale: number;
  gpuName: string;
  /** The backend can read three's per-pass GPU timestamps (bench reference). */
  gpuTiming: boolean;
  /** GPU time that feeds the governor and the overlay: the frame span on WebGPU, else three's per-pass sum. */
  gpuSource: GpuTimeSource;
  /** That GPU time may drive decisions (the span everywhere; the per-pass sum not on Apple/Metal). */
  gpuTimingTrusted: boolean;
  /** False once GPU timestamps proved implausible or untrusted; the governor then keeps the preset scale. */
  gpuReliable: boolean;
  /** Latest GPU time (ms) from gpuSource, as fed to the governor; null before the first reading. */
  gpuMs: number | null;
  /** Latest CPU time of render() (ms) on a frame whose GPU time was sampled; null before the first. */
  cpuRenderMs: number | null;
  /** Why dynamic resolution is stopped (back at the preset scale); null while it runs. */
  dynresStopped: string | null;
  /** While stopped and watching for a new load (S-11): the GPU time (ms) that would resume it; else null. */
  dynresResumeAtMs: number | null;
  /** Why it resumed the last time after a stop (a new load, S-11); null when it never did. */
  dynresResumed: string | null;
  /** How many times dynamic resolution stopped and resumed this session. */
  dynresStops: number;
  dynresResumes: number;
  /** Set once ?quality=auto has measured its window. */
  qualityDecision: QualityDecision | null;
  /** Whether the auto-selected preset held its headroom when re-measured (null = not verified). */
  qualityVerified: boolean | null;
  /** Window errors, unhandled rejections and console.error (includes uncaptured WebGPU validation errors). */
  errors: string[];
  bench: BenchResult | null;
  /** How many scene instances were created (a quality switch recreates the scene). */
  sceneInstances: number;
  /** Scenes may publish their own sensor values here (e.g. peek state, player position). */
  sceneProbe: Record<string, unknown>;
}

/**
 * ?debug=1 only: internals for page scripts (Playwright, DevTools).
 * Exists from before the first scene is created: use it only once window.__vidro.status is 'running'
 * (a setScale() before that is overwritten when the scene applies its preset). Code that wraps renderer.render again
 * must call the previous function with apply(renderer, args): the sensor replaced it on the instance.
 */
export interface VidroDebug {
  renderer: THREE.WebGPURenderer;
  /** Sets the render scale directly, past the governor. */
  setScale(scale: number): void;
  /**
   * Materials of the current scene that need followBackdropResize() (S-14, src/dev/backdrop-risks.ts): those of
   * sandbox.scene (the first of the roots listed) and of every root the scene has drawn or compiled since it was
   * created; and, per root, how many materials read the backdrop (roots[i].backdropReaders, S-15).
   */
  backdropRisks(): BackdropReport;
}

declare global {
  interface Window {
    __vidro: VidroProbe;
    __vidroDebug?: VidroDebug;
  }
}

const MAX_ERRORS = 50;
const GPU_POLL_EVERY_FRAMES = 8;
/** A quality switch that has not produced a scene by then is treated as failed. */
const SWITCH_TIMEOUT_MS = 15_000;

const params = parseParams(window.location.search);
// S-43: the URL's ?quality (a dev and sensor switch) wins; else the preset the player chose in the settings, kept in the
// browser; else mid. The saved choice is read only for a scene (the scene list keeps nothing), and never for a bench
// (計測は固定のプリセットで: a 自動 kept from playing must not switch presets in the middle of a measurement).
const startPreset = startQuality({
  url: params.raw.has('quality') ? { level: params.quality, auto: params.autoQuality } : null,
  saved: params.scene && params.benchSeconds === null ? readSavedQuality(browserStorage) : null,
});
const probe: VidroProbe = {
  status: 'booting',
  scene: params.scene,
  backend: null,
  quality: startPreset.level,
  qualityChoice: startPreset.auto ? 'auto' : startPreset.level,
  qualityOrigin: startPreset.origin,
  qualitySwitchesInPlace: 0,
  idleFrames: 0,
  renderScale: QUALITY_PRESETS[startPreset.level].renderScale,
  gpuName: '',
  gpuTiming: false,
  gpuSource: 'none',
  gpuTimingTrusted: false,
  gpuReliable: false,
  gpuMs: null,
  cpuRenderMs: null,
  dynresStopped: null,
  dynresResumeAtMs: null,
  dynresResumed: null,
  dynresStops: 0,
  dynresResumes: 0,
  qualityDecision: null,
  qualityVerified: null,
  errors: [],
  bench: null,
  sceneInstances: 0,
  sceneProbe: {},
};
window.__vidro = probe;

const recordError = (message: string): void => {
  if (probe.errors.length < MAX_ERRORS) probe.errors.push(message);
};
window.addEventListener('error', (e) => recordError(String(e.message)));
window.addEventListener('unhandledrejection', (e) => recordError(String(e.reason)));
// three.js reports uncaptured WebGPU validation errors through console.error; make them visible to sensors.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (probe.errors.length < MAX_ERRORS) {
    recordError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  }
  consoleError(...args);
};

function renderSceneList(root: HTMLElement): void {
  const list = document.createElement('nav');
  list.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;' +
    'font:16px/1.6 "Shippori Mincho",serif;color:#e8eef2';
  const title = document.createElement('h1');
  title.textContent = 'ビードロの向こう — sandbox';
  title.style.cssText = 'font-weight:400;font-size:22px;margin:0 0 12px';
  list.appendChild(title);
  for (const name of sceneNames) {
    const a = document.createElement('a');
    a.href = `?scene=${name}&stats=1`;
    a.textContent = name;
    a.style.color = '#cfe3f0';
    list.appendChild(a);
  }
  root.appendChild(list);
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  if (!params.scene) {
    renderSceneList(app);
    probe.status = 'done';
    return;
  }

  const { renderer, backend, baseDpr, gpuName, gpuTiming, gpuSource, gpuTimingTrusted, spanDevice } =
    await createRenderer(app, {
      forceWebGL: params.forceWebGL,
      renderScale: QUALITY_PRESETS[startPreset.level].renderScale,
      frameSpan: params.gpuSpan,
    });
  probe.backend = backend;
  probe.gpuName = gpuName;
  probe.gpuTiming = gpuTiming;
  probe.gpuSource = gpuSource;
  probe.gpuTimingTrusted = gpuTimingTrusted;
  // three's per-pass timestamps cost a query pair per pass and a readback; left unread, three resets its full pool
  // (1024 passes) inside render(), which passDrain below prevents by reading from out here.
  // Where the span drives decisions they are only a bench reference, so they run only while a bench records.
  // Set before the scene is created: a pass descriptor cached while they are on keeps its timestampWrites.
  const backendTiming = renderer.backend as { trackTimestamp?: boolean };
  backendTiming.trackTimestamp = gpuTiming && params.gpuPasses && gpuSource === 'passes';
  // Which frames write them and when they are read out (S-20): on WebGL2 none are written while a readback is in
  // flight, so three's pool cannot fill however fast the frames come (src/dev/timestamp-drain.ts).
  const passDrain = new PassTimestampDrain({
    pauseWhileReading: backend === 'webgl2',
    tracking: backendTiming.trackTimestamp,
    renderCalls: renderer.info.render.calls,
  });

  const mod: SceneModule = await loadScene(params.scene);
  let overlay: HTMLDivElement | null = null;
  let sandbox: SandboxScene | null = null;
  let sceneGeneration = 0;
  /** ?debug=1: every root drawn or compiled since the current scene instance was created (backdropRisks). */
  const drawnRoots = new Set<THREE.Object3D>();

  const stats = new StatsOverlay(document.body, backend);
  stats.visible = params.stats;
  window.addEventListener('keydown', (e) => {
    if (e.key === '`') stats.visible = !stats.visible;
  });
  const extras: StatsExtras = {
    gpuMs: null,
    gpuReliable: gpuTimingTrusted,
    texturesBytes: 0,
    buffersBytes: 0,
    renderScale: probe.renderScale,
    quality: startPreset.level,
  };
  const counters: RenderCounters = { drawCalls: 0, triangles: 0 };

  /** Camera and scene targets follow the canvas; renderer.setPixelRatio already resized the canvas. */
  const updateViewport = (): void => {
    if (!sandbox) return;
    const w = app.clientWidth;
    const h = app.clientHeight;
    sandbox.camera.aspect = w / Math.max(1, h);
    sandbox.camera.updateProjectionMatrix();
    sandbox.resize?.(w, h);
  };
  const resize = (): void => {
    renderer.setSize(app.clientWidth, app.clientHeight);
    updateViewport();
  };
  const applyScale = (scale: number): void => {
    probe.renderScale = scale;
    extras.renderScale = scale;
    renderer.setPixelRatio(baseDpr * scale);
    updateViewport();
  };

  // S-43: the scene's side of the quality (a scene that takes presets in place attaches itself through the port)
  let attached: QualityScene | null = null;
  /** The preset the current scene instance was made with (an in-place switch leaves it). */
  let sceneLevel: QualityLevel = startPreset.level;
  /** Set once the governor exists: the player's choice of quality (the settings). */
  let requestQuality: ((choice: QualityChoice) => void) | null = null;
  let pendingChoice: QualityChoice | null = null;
  /**
   * The port handed to the scene instance of `generation`: one made late (a quality switch overtook it, and it is
   * disposed unseen) cannot attach over the live one.
   */
  const portFor = (generation: number): QualityPort => ({
    get choice() {
      return probe.qualityChoice;
    },
    get level() {
      return probe.quality;
    },
    get sceneLevel() {
      return sceneLevel;
    },
    request(choice) {
      if (generation !== sceneGeneration) return;
      if (requestQuality) requestQuality(choice);
      else pendingChoice = choice;
    },
    attach(scene) {
      if (generation !== sceneGeneration) return () => undefined;
      attached = scene;
      return () => {
        if (attached === scene) attached = null;
      };
    },
  });

  /** Creates (or recreates, for a quality switch) the scene with a whole preset. A late result is discarded. */
  const createScene = async (level: QualityLevel): Promise<void> => {
    const generation = ++sceneGeneration;
    if (sandbox) sandbox.dispose();
    overlay?.remove();
    sandbox = null;
    attached = null;
    drawnRoots.clear();
    const nextOverlay = document.createElement('div');
    nextOverlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5';
    document.body.appendChild(nextOverlay);
    overlay = nextOverlay;
    // the scene contract (core/scene.ts) and the quality port beside it (S-43: core/quality.ts qualityPortOf)
    const sceneContext: SceneContext & { qualityPort: QualityPort } = {
      renderer,
      backend,
      canvas: renderer.domElement,
      overlay: nextOverlay,
      quality: QUALITY_PRESETS[level],
      qualityLevel: level,
      params: params.raw,
      qualityPort: portFor(generation),
    };
    const next = await mod.default(sceneContext);
    if (generation !== sceneGeneration) {
      next.dispose();
      nextOverlay.remove();
      return;
    }
    sandbox = next;
    sceneLevel = level;
    probe.quality = level;
    probe.sceneInstances++;
    extras.quality = probe.qualityDecision ? `auto→${level}` : level;
    applyScale(QUALITY_PRESETS[level].renderScale);
  };
  const createSceneWithTimeout = (level: QualityLevel): Promise<void> => {
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`scene creation exceeded ${SWITCH_TIMEOUT_MS} ms`)),
        SWITCH_TIMEOUT_MS,
      );
    });
    return Promise.race([createScene(level), timeout]).finally(() => window.clearTimeout(timer));
  };

  // ?debug=1 exposes internals to page scripts (Playwright, DevTools): one-off investigations and tests that
  // must drive the render scale directly, independent of the governor. Set up before the first scene is created,
  // so that what it compiles while it loads is recorded too.
  if (params.raw.get('debug') === '1') {
    // A scene may draw more than sandbox.scene (the dive world into the home orb's image, a world built later):
    // note every root handed to render() and compileAsync(). Passes, shadow maps, renderAsync() and compile() go
    // through these two as well. Every argument is passed on as it came.
    const render = renderer.render.bind(renderer);
    renderer.render = (...args: Parameters<typeof render>) => {
      drawnRoots.add(args[0]);
      return render(...args);
    };
    const compileAsync = renderer.compileAsync.bind(renderer);
    renderer.compileAsync = (...args: Parameters<typeof compileAsync>) => {
      drawnRoots.add(args[0]);
      if (args[2]) drawnRoots.add(args[2]);
      return compileAsync(...args);
    };
    // Loaded only here: the sandbox without ?debug=1 does not evaluate it.
    const { backdropRisks } = await import('./dev/backdrop-risks');
    window.__vidroDebug = {
      renderer,
      setScale: applyScale,
      backdropRisks: () => backdropRisks(sandbox ? [sandbox.scene, ...drawnRoots] : drawnRoots),
    };
  }

  await createScene(startPreset.level);
  window.addEventListener('resize', resize);

  const makeGovernor = (level: QualityLevel, auto: boolean): PerfGovernor =>
    new PerfGovernor({
      level,
      auto,
      autoWindowSec: params.autoWindowSeconds,
      dynres: params.dynres,
      gpuTiming: gpuTimingTrusted || (params.gpuTrust && gpuTiming),
      dynresTargetMs: params.dynresTargetMs ?? undefined,
      dynresRequireResponse: params.dynresResponse,
      forceLevel: params.autoForce ?? undefined,
    });
  let governor = makeGovernor(startPreset.level, startPreset.auto);
  /**
   * Whose governor this is: the URL's ?quality=auto switches by making the scene again (M0's path, which the sensors of
   * S-16 and S-18 use to see a scene let go); the player's (the settings, or 自動 kept from them) switches in place when
   * the scene has attached, so that the game keeps its state (S-43).
   */
  let governorOrigin: 'url' | 'player' = startPreset.origin === 'url' ? 'url' : 'player';
  /** Bumped with each new governor: GPU samples requested for an old one are dropped. */
  let governorGeneration = 0;

  // GPU timing: sample every few frames, one readback in flight per source, only while something uses the value.
  // The frame span (WebGPU) feeds the governor and the overlay; three's per-pass sum is kept as a bench reference
  // and feeds them only where there is no span. Samples carry the governor epoch so readings from before a change
  // are dropped.
  const spanTimer = spanDevice ? new GpuSpanTimer(spanDevice) : null;
  const benchGpu: number[] = [];
  const benchSpan: number[] = [];
  const benchCpu: number[] = [];
  let benchRecording = false;
  let gpuEpoch = 0;
  let spanEpoch = 0;
  let gpuGeneration = 0;
  let spanGeneration = 0;
  const feedGovernor = (ms: number, epoch: number, generation: number): void => {
    extras.gpuMs = ms;
    probe.gpuMs = ms;
    if (generation === governorGeneration) governor.gpu(ms, epoch);
  };
  const onGpu = (ms: number | undefined): void => {
    passDrain.settled();
    if (typeof ms !== 'number' || ms <= 0) return;
    if (gpuSource === 'passes') feedGovernor(ms, gpuEpoch, gpuGeneration);
    if (benchRecording) benchGpu.push(ms);
  };
  const onGpuFailed = (): void => {
    passDrain.settled();
  };
  const onSpan = (ms: number | null): void => {
    if (ms === null) return;
    feedGovernor(ms, spanEpoch, spanGeneration);
    if (benchRecording) benchSpan.push(ms);
  };

  let switching = false;
  const switchQuality = (level: QualityLevel): void => {
    // S-43: the player's switch, to a scene that takes presets in place: the render scale now, the scene kept
    const inPlace = governorOrigin === 'player' ? attached : null;
    if (inPlace && sandbox) {
      probe.qualityDecision = governor.decision;
      probe.quality = level;
      probe.qualitySwitchesInPlace++;
      extras.quality = probe.qualityChoice === 'auto' ? `auto→${level}` : level;
      applyScale(QUALITY_PRESETS[level].renderScale);
      inPlace.applyQuality(level, QUALITY_PRESETS[level]);
      governor.sceneReady();
      return;
    }
    switching = true;
    probe.qualityDecision = governor.decision;
    createSceneWithTimeout(level)
      .then(() => governor.sceneReady())
      .catch(async (err: unknown) => {
        recordError(`quality switch to ${level} failed: ${String(err)}`);
        governor.sceneFailed();
        try {
          await createSceneWithTimeout(governor.level);
        } catch (again: unknown) {
          recordError(`restoring ${governor.level} failed: ${String(again)}`);
          probe.status = 'error';
        }
      })
      .finally(() => {
        switching = false;
      });
  };

  // S-43: the player's choice (the settings): a new governor for it — a preset holds (dynamic resolution within it), 自動
  // measures again from the preset in use — and the preset switched in place when the scene can take it
  requestQuality = (choice: QualityChoice): void => {
    const level = choice === 'auto' ? governor.level : choice;
    probe.qualityChoice = choice;
    probe.qualityDecision = null;
    probe.qualityVerified = null;
    governor = makeGovernor(level, choice === 'auto');
    governorOrigin = 'player';
    governorGeneration++;
    if (level !== probe.quality) switchQuality(level);
    else applyScale(QUALITY_PRESETS[level].renderScale);
  };
  if (pendingChoice) requestQuality(pendingChoice);
  pendingChoice = null;

  const frameTimes: number[] = [];
  let maxDrawCalls = 0;
  let maxTriangles = 0;
  let frameIndex = 0;
  const start = performance.now();
  let last = start;
  probe.status = params.benchSeconds ? 'benchmarking' : 'running';

  await renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dtMs = now - last;
    last = now;
    const dt = Math.min(dtMs / 1000, 0.1);
    const t = (now - start) / 1000;
    const current = sandbox;
    if (switching || !current || probe.status === 'error') return;

    current.update(dt, t);
    // S-43 (S-42's 提案4): while the scene's picture stands still (the pause holds it), its frames and their GPU time
    // go to no governor: no new render scale while nothing moves
    const idle = attached?.idle === true;
    if (idle) probe.idleFrames++;
    const pollFrame = frameIndex++ % GPU_POLL_EVERY_FRAMES === 0;
    const sampleGpu = pollFrame && !idle && (governor.gpuReliable || stats.visible || benchRecording);
    const wantPasses = gpuTiming && params.gpuPasses && (gpuSource === 'passes' || benchRecording);
    backendTiming.trackTimestamp = passDrain.beginFrame(wantPasses, renderer.info.render.calls);
    // The span brackets only the rendering: CPU work in update() is not GPU time.
    const timingSpan = sampleGpu && (spanTimer?.begin() ?? false);
    if (timingSpan) {
      spanEpoch = governor.epoch;
      spanGeneration = governorGeneration;
    }
    const cpuStart = sampleGpu ? performance.now() : 0;
    if (current.render) current.render();
    else renderer.render(current.scene, current.camera);
    if (sampleGpu) {
      probe.cpuRenderMs = performance.now() - cpuStart;
      if (benchRecording) benchCpu.push(probe.cpuRenderMs);
    }
    if (timingSpan) spanTimer?.end()?.then(onSpan);

    // Whenever three's per-pass timestamps are on, resolve them out here every few frames, also when nothing reads
    // the value (Apple WebGL2 without the overlay): three r186 resets a full pool (1024 render contexts) even inside
    // a nested render (a RenderPipeline pass, a shadow map), and the next beginQuery then warns "a query is already
    // active" (S-06, S-11). Resolving empties the pool between frames; on WebGL2 also early when a quarter of it is
    // in use, and no frame writes any while it is in flight (uncapped, a readback outlasted 50+ frames, S-20).
    if (passDrain.endFrame(renderer.info.render.calls, pollFrame)) {
      gpuEpoch = governor.epoch;
      // a reading of a still frame (the pause) is not the game's: its generation never matches (no governor gets it)
      gpuGeneration = idle ? -1 : governorGeneration;
      renderer.resolveTimestampsAsync('render').then(onGpu, onGpuFailed);
      // After the call: three checks trackTimestamp when it is made (and warns if off), not later.
      backendTiming.trackTimestamp = passDrain.writing;
    }

    counters.drawCalls = renderer.info.render.drawCalls;
    counters.triangles = renderer.info.render.triangles;
    extras.texturesBytes = renderer.info.memory.texturesSize;
    extras.buffersBytes = renderer.info.memory.attributesSize + renderer.info.memory.indexAttributesSize;
    extras.gpuReliable = governor.gpuReliable;
    stats.tick(dt, counters, extras);

    const action = idle ? null : governor.frame(dtMs);
    probe.qualityVerified = governor.verified;
    probe.gpuReliable = governor.gpuReliable;
    probe.dynresStopped = governor.dynresStopReason;
    probe.dynresResumeAtMs = governor.dynresResumeAtMs;
    probe.dynresResumed = governor.dynresResumeReason;
    probe.dynresStops = governor.dynresStops;
    probe.dynresResumes = governor.dynresResumes;
    if (governor.decision && !probe.qualityDecision) probe.qualityDecision = governor.decision;
    if (action?.kind === 'scale') applyScale(action.scale);
    if (action?.kind === 'quality') switchQuality(action.level);

    if (params.benchSeconds && probe.status === 'benchmarking' && t > params.warmupSeconds) {
      benchRecording = true;
      if (dtMs <= 250) frameTimes.push(dtMs);
      maxDrawCalls = Math.max(maxDrawCalls, counters.drawCalls);
      maxTriangles = Math.max(maxTriangles, counters.triangles);
      if (t > params.warmupSeconds + params.benchSeconds) {
        benchRecording = false;
        probe.bench = {
          ...summarizeFrameTimes(frameTimes),
          seconds: params.benchSeconds,
          gpu: summarizeGpuTimes(benchGpu),
          gpuSpan: summarizeGpuTimes(benchSpan),
          cpuRenderMs: summarizeGpuTimes(benchCpu),
          maxDrawCalls,
          maxTriangles,
          budgetViolations: checkBudget({ drawCalls: maxDrawCalls, triangles: maxTriangles }),
        };
        probe.status = 'done';
      }
    }
  });
}

main().catch((err: unknown) => {
  probe.status = 'error';
  probe.errors.push(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  consoleError(err);
});
