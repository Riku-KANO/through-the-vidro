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
  /** GPU time from timestamp queries; null when the backend cannot measure it. */
  gpu: GpuStats | null;
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
  gpuTiming: boolean;
  /** False once GPU timestamps proved implausible (see PerfGovernor); the governor then uses frame time. */
  gpuReliable: boolean;
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
const GPU_POLL_EVERY_FRAMES = 4;

const params = parseParams(window.location.search);
const probe: VidroProbe = {
  status: 'booting',
  scene: params.scene,
  backend: null,
  quality: params.quality,
  renderScale: QUALITY_PRESETS[params.quality].renderScale,
  gpuTiming: false,
  gpuReliable: false,
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
  recordError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
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

  const { renderer, backend, baseDpr, gpuTiming } = await createRenderer(app, {
    forceWebGL: params.forceWebGL,
    renderScale: QUALITY_PRESETS[params.quality].renderScale,
  });
  probe.backend = backend;
  probe.gpuTiming = gpuTiming;
  // ?debug=1 exposes the renderer to page scripts (Playwright, DevTools) for one-off investigations.
  if (params.raw.get('debug') === '1') Object.assign(window, { __vidroDebug: { renderer } });

  const mod: SceneModule = await loadScene(params.scene);
  let overlay: HTMLDivElement | null = null;
  let sandbox: SandboxScene | null = null;

  const resize = (): void => {
    const w = app.clientWidth;
    const h = app.clientHeight;
    renderer.setSize(w, h);
    if (!sandbox) return;
    sandbox.camera.aspect = w / Math.max(1, h);
    sandbox.camera.updateProjectionMatrix();
    sandbox.resize?.(w, h);
  };

  const applyScale = (scale: number): void => {
    probe.renderScale = scale;
    renderer.setPixelRatio(baseDpr * scale);
    resize();
  };

  /** Creates (or recreates, for a quality switch) the scene with a whole preset. */
  const createScene = async (level: QualityLevel): Promise<void> => {
    if (sandbox) sandbox.dispose();
    overlay?.remove();
    sandbox = null;
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5';
    document.body.appendChild(overlay);
    sandbox = await mod.default({
      renderer,
      backend,
      canvas: renderer.domElement,
      overlay,
      quality: QUALITY_PRESETS[level],
      qualityLevel: level,
      params: params.raw,
    });
    probe.quality = level;
    probe.sceneInstances++;
    applyScale(QUALITY_PRESETS[level].renderScale);
  };

  await createScene(params.quality);
  window.addEventListener('resize', resize);

  const governor = new PerfGovernor({
    level: params.quality,
    auto: params.autoQuality,
    autoWindowSec: params.autoWindowSeconds,
    dynres: params.dynres,
    gpuTiming,
    dynresTargetMs: params.dynresTargetMs ?? undefined,
  });

  const stats = new StatsOverlay(document.body, backend);
  stats.visible = params.stats;
  window.addEventListener('keydown', (e) => {
    if (e.key === '`') stats.visible = !stats.visible;
  });
  const extras: StatsExtras = {
    gpuMs: null,
    gpuReliable: gpuTiming,
    texturesBytes: 0,
    buffersBytes: 0,
    renderScale: probe.renderScale,
    quality: params.quality,
  };
  const counters: RenderCounters = { drawCalls: 0, triangles: 0 };

  // GPU timing: resolve every few frames, one request in flight; samples carry the governor epoch.
  const benchGpu: number[] = [];
  let benchRecording = false;
  let gpuInFlight = false;
  let gpuEpoch = 0;
  const onGpu = (ms: number | undefined): void => {
    gpuInFlight = false;
    if (typeof ms !== 'number' || ms <= 0) return;
    extras.gpuMs = ms;
    governor.gpu(ms, gpuEpoch);
    if (benchRecording) benchGpu.push(ms);
  };
  const onGpuFailed = (): void => {
    gpuInFlight = false;
  };

  const frameTimes: number[] = [];
  let maxDrawCalls = 0;
  let maxTriangles = 0;
  let frameIndex = 0;
  let switching = false;
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
    if (switching || !current) return;

    current.update(dt, t);
    if (current.render) current.render();
    else renderer.render(current.scene, current.camera);

    if (gpuTiming && !gpuInFlight && frameIndex++ % GPU_POLL_EVERY_FRAMES === 0) {
      gpuInFlight = true;
      gpuEpoch = governor.epoch;
      renderer.resolveTimestampsAsync('render').then(onGpu, onGpuFailed);
    }

    counters.drawCalls = renderer.info.render.drawCalls;
    counters.triangles = renderer.info.render.triangles;
    extras.texturesBytes = renderer.info.memory.texturesSize;
    extras.buffersBytes = renderer.info.memory.attributesSize + renderer.info.memory.indexAttributesSize;
    extras.renderScale = probe.renderScale;
    extras.quality = probe.qualityDecision ? `auto→${probe.quality}` : probe.quality;
    stats.tick(dt, counters, extras);

    const action = governor.frame(dtMs);
    probe.qualityVerified = governor.verified;
    probe.gpuReliable = governor.gpuReliable;
    extras.gpuReliable = governor.gpuReliable;
    if (action?.kind === 'scale') applyScale(action.scale);
    if (action?.kind === 'quality') {
      probe.qualityDecision = governor.decision;
      switching = true;
      createScene(action.level)
        .then(() => governor.sceneReady())
        .catch((err: unknown) => recordError(`quality switch failed: ${String(err)}`))
        .finally(() => {
          switching = false;
        });
    }
    if (governor.decision && !probe.qualityDecision) probe.qualityDecision = governor.decision;

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
