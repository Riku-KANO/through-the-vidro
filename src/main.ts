import { checkBudget, type FrameStats, type RenderCounters, summarizeFrameTimes } from './core/bench';
import { parseParams } from './core/params';
import { QUALITY_PRESETS, type QualityLevel } from './core/quality';
import { type Backend, createRenderer } from './core/renderer';
import type { SandboxScene } from './core/scene';
import { StatsOverlay } from './dev/stats';
import { loadScene, sceneNames } from './scenes/registry';

/**
 * Machine-readable probe for the browser sensor (tests/e2e) and the dev loop.
 * Status flow: booting → running → (benchmarking → done) | error
 */
export interface BenchResult extends FrameStats {
  seconds: number;
  maxDrawCalls: number;
  maxTriangles: number;
  budgetViolations: ReturnType<typeof checkBudget>;
}

export interface VidroProbe {
  status: 'booting' | 'running' | 'benchmarking' | 'done' | 'error';
  scene: string | null;
  backend: Backend | null;
  quality: QualityLevel;
  errors: string[];
  bench: BenchResult | null;
  /** Scenes may publish their own sensor values here (e.g. peek state, player position). */
  sceneProbe: Record<string, unknown>;
}

declare global {
  interface Window {
    __vidro: VidroProbe;
  }
}

const params = parseParams(window.location.search);
const probe: VidroProbe = {
  status: 'booting',
  scene: params.scene,
  backend: null,
  quality: params.quality,
  errors: [],
  bench: null,
  sceneProbe: {},
};
window.__vidro = probe;
window.addEventListener('error', (e) => probe.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => probe.errors.push(String(e.reason)));

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

  const quality = QUALITY_PRESETS[params.quality];
  const { renderer, backend } = await createRenderer(app, {
    forceWebGL: params.forceWebGL,
    renderScale: quality.renderScale,
  });
  probe.backend = backend;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5';
  document.body.appendChild(overlay);

  const mod = await loadScene(params.scene);
  const sandbox: SandboxScene = await mod.default({
    renderer,
    backend,
    canvas: renderer.domElement,
    overlay,
    quality,
    qualityLevel: params.quality,
    params: params.raw,
  });

  const resize = (): void => {
    const w = app.clientWidth;
    const h = app.clientHeight;
    renderer.setSize(w, h);
    sandbox.camera.aspect = w / Math.max(1, h);
    sandbox.camera.updateProjectionMatrix();
    sandbox.resize?.(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  const stats = new StatsOverlay(document.body, backend);
  stats.visible = params.stats;
  window.addEventListener('keydown', (e) => {
    if (e.key === '`') stats.visible = !stats.visible;
  });

  const frameTimes: number[] = [];
  let maxDrawCalls = 0;
  let maxTriangles = 0;
  const start = performance.now();
  let last = start;
  probe.status = params.benchSeconds ? 'benchmarking' : 'running';

  await renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dtMs = now - last;
    last = now;
    const dt = Math.min(dtMs / 1000, 0.1);
    const t = (now - start) / 1000;

    sandbox.update(dt, t);
    if (sandbox.render) sandbox.render();
    else renderer.render(sandbox.scene, sandbox.camera);

    const counters: RenderCounters = {
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
    };
    stats.tick(dt, counters);

    if (params.benchSeconds && probe.status === 'benchmarking' && t > params.warmupSeconds) {
      frameTimes.push(dtMs);
      maxDrawCalls = Math.max(maxDrawCalls, counters.drawCalls);
      maxTriangles = Math.max(maxTriangles, counters.triangles);
      if (t > params.warmupSeconds + params.benchSeconds) {
        probe.bench = {
          ...summarizeFrameTimes(frameTimes),
          seconds: params.benchSeconds,
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
  console.error(err);
});
