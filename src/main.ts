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
import { QUALITY_PRESETS, type QualityLevel } from './core/quality';
import { type Backend, createRenderer } from './core/renderer';
import type { SandboxScene, SceneModule } from './core/scene';
import { type StatsExtras, StatsOverlay } from './dev/stats';
import { loadScene, sceneNames } from './scenes/registry';

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
  /** Preset the current scene instance was created with. */
  quality: QualityLevel;
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

declare global {
  interface Window {
    __vidro: VidroProbe;
  }
}

const MAX_ERRORS = 50;
const GPU_POLL_EVERY_FRAMES = 8;
/** A quality switch that has not produced a scene by then is treated as failed. */
const SWITCH_TIMEOUT_MS = 15_000;

const params = parseParams(window.location.search);
const probe: VidroProbe = {
  status: 'booting',
  scene: params.scene,
  backend: null,
  quality: params.quality,
  renderScale: QUALITY_PRESETS[params.quality].renderScale,
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
      renderScale: QUALITY_PRESETS[params.quality].renderScale,
      frameSpan: params.gpuSpan,
    });
  probe.backend = backend;
  probe.gpuName = gpuName;
  probe.gpuTiming = gpuTiming;
  probe.gpuSource = gpuSource;
  probe.gpuTimingTrusted = gpuTimingTrusted;
  // three's per-pass timestamps cost a query pair per pass and a readback every 1024 passes (inside render()).
  // Where the span drives decisions they are only a bench reference, so they run only while a bench records.
  // Set before the scene is created: a pass descriptor cached while they are on keeps its timestampWrites.
  const backendTiming = renderer.backend as { trackTimestamp?: boolean };
  backendTiming.trackTimestamp = gpuTiming && params.gpuPasses && gpuSource === 'passes';

  const mod: SceneModule = await loadScene(params.scene);
  let overlay: HTMLDivElement | null = null;
  let sandbox: SandboxScene | null = null;
  let sceneGeneration = 0;

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
    quality: params.quality,
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

  /** Creates (or recreates, for a quality switch) the scene with a whole preset. A late result is discarded. */
  const createScene = async (level: QualityLevel): Promise<void> => {
    const generation = ++sceneGeneration;
    if (sandbox) sandbox.dispose();
    overlay?.remove();
    sandbox = null;
    const nextOverlay = document.createElement('div');
    nextOverlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5';
    document.body.appendChild(nextOverlay);
    overlay = nextOverlay;
    const next = await mod.default({
      renderer,
      backend,
      canvas: renderer.domElement,
      overlay: nextOverlay,
      quality: QUALITY_PRESETS[level],
      qualityLevel: level,
      params: params.raw,
    });
    if (generation !== sceneGeneration) {
      next.dispose();
      nextOverlay.remove();
      return;
    }
    sandbox = next;
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

  await createScene(params.quality);
  window.addEventListener('resize', resize);
  // ?debug=1 exposes internals to page scripts (Playwright, DevTools): one-off investigations and tests that
  // must drive the render scale directly, independent of the governor.
  if (params.raw.get('debug') === '1')
    Object.assign(window, { __vidroDebug: { renderer, setScale: applyScale } });

  const governor = new PerfGovernor({
    level: params.quality,
    auto: params.autoQuality,
    autoWindowSec: params.autoWindowSeconds,
    dynres: params.dynres,
    gpuTiming: gpuTimingTrusted || (params.gpuTrust && gpuTiming),
    dynresTargetMs: params.dynresTargetMs ?? undefined,
    dynresRequireResponse: params.dynresResponse,
    forceLevel: params.autoForce ?? undefined,
  });

  // GPU timing: sample every few frames, one readback in flight per source, only while something uses the value.
  // The frame span (WebGPU) feeds the governor and the overlay; three's per-pass sum is kept as a bench reference
  // and feeds them only where there is no span. Samples carry the governor epoch so readings from before a change
  // are dropped.
  const spanTimer = spanDevice ? new GpuSpanTimer(spanDevice) : null;
  const benchGpu: number[] = [];
  const benchSpan: number[] = [];
  const benchCpu: number[] = [];
  let benchRecording = false;
  let gpuInFlight = false;
  let gpuEpoch = 0;
  let spanEpoch = 0;
  const feedGovernor = (ms: number, epoch: number): void => {
    extras.gpuMs = ms;
    probe.gpuMs = ms;
    governor.gpu(ms, epoch);
  };
  const onGpu = (ms: number | undefined): void => {
    gpuInFlight = false;
    if (typeof ms !== 'number' || ms <= 0) return;
    if (gpuSource === 'passes') feedGovernor(ms, gpuEpoch);
    if (benchRecording) benchGpu.push(ms);
  };
  const onGpuFailed = (): void => {
    gpuInFlight = false;
  };
  const onSpan = (ms: number | null): void => {
    if (ms === null) return;
    feedGovernor(ms, spanEpoch);
    if (benchRecording) benchSpan.push(ms);
  };

  let switching = false;
  const switchQuality = (level: QualityLevel): void => {
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
    const pollFrame = frameIndex++ % GPU_POLL_EVERY_FRAMES === 0;
    const sampleGpu = pollFrame && (governor.gpuReliable || stats.visible || benchRecording);
    const wantPasses = gpuTiming && params.gpuPasses && (gpuSource === 'passes' || benchRecording);
    backendTiming.trackTimestamp = wantPasses;
    // The span brackets only the rendering: CPU work in update() is not GPU time.
    const timingSpan = sampleGpu && (spanTimer?.begin() ?? false);
    if (timingSpan) spanEpoch = governor.epoch;
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
    // active" (S-06, S-11). Resolving empties the pool between frames.
    if (pollFrame && wantPasses && !gpuInFlight) {
      gpuInFlight = true;
      gpuEpoch = governor.epoch;
      renderer.resolveTimestampsAsync('render').then(onGpu, onGpuFailed);
    }

    counters.drawCalls = renderer.info.render.drawCalls;
    counters.triangles = renderer.info.render.triangles;
    extras.texturesBytes = renderer.info.memory.texturesSize;
    extras.buffersBytes = renderer.info.memory.attributesSize + renderer.info.memory.indexAttributesSize;
    extras.gpuReliable = governor.gpuReliable;
    stats.tick(dt, counters, extras);

    const action = governor.frame(dtMs);
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
