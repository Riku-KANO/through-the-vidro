import { expect, test } from '@playwright/test';

/**
 * S-20: three r186's WebGL2 timestamp pool (2048 queries, two per render context) is emptied only when a readback
 * settles. Without vsync (~600 fps) a readback took 20 to 1000+ frames, and with the finishing passes (~20 render
 * contexts a frame, S-17) the pool filled while main.ts's readback was still in flight: three reset it inside a nested
 * render and the browser warned "beginQuery: a query is already active" (S-17's proposal 2). The pass sums stalled too
 * (a reset hands the pending readback's queries to new passes). The scene sensor runs at 60 fps, so it cannot see this.
 *
 * Each case runs one scene uncapped and samples, every animation frame, how full the pool is (three's internals,
 * through ?debug=1 like S-11's test; review them when three is upgraded).
 */
const POOL_QUERIES = 2048;
const SECONDS = 6;

// The sensor's GPU flags (playwright.config.ts) plus the uncapped ones (scripts/lib/preview-server.mjs UNCAPPED_ARGS).
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--use-angle=metal',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  },
});

const CASES = [
  // The heaviest view of the workshop (what ?bench measures): peeking at the dead end, with the finishing passes.
  { name: 'prologue-proto', query: 'scene=prologue-proto&direct=1&spawn=dead-end&peek=hold' },
  { name: 'stress', query: 'scene=stress' },
];

interface PoolTrace {
  fps: number;
  /** Most queries handed out at once since the pool was last emptied, sampled every frame. */
  maxFill: number;
  /** Readbacks of the per-pass sum that settled in the window. */
  reads: number;
  contextsPerFrame: number;
}

for (const c of CASES) {
  test(`timestamp pool keeps up without vsync: ${c.name} [webgl2]`, async ({ page }) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await page.goto(`/?${c.query}&webgl=1&debug=1`);
    await page.waitForFunction(() => ['running', 'error'].includes(window.__vidro?.status), undefined, {
      timeout: 60_000,
    });
    test.skip(!(await page.evaluate(() => window.__vidro.gpuTiming)), 'no WebGL2 timer queries here');

    const trace: PoolTrace = await page.evaluate(async (seconds) => {
      type Pool = { currentQueryIndex: number } | null;
      type Debugged = {
        resolveTimestampsAsync(type?: string): Promise<number | undefined>;
        info: { frame: number; render: { calls: number } };
        backend: { timestampQueryPool: { render: Pool } };
      };
      const renderer = (window as unknown as { __vidroDebug: { renderer: Debugged } }).__vidroDebug.renderer;
      let reads = 0;
      const resolve = renderer.resolveTimestampsAsync.bind(renderer);
      renderer.resolveTimestampsAsync = (type) => {
        const p = resolve(type);
        p.then(() => reads++);
        return p;
      };
      const frame0 = renderer.info.frame;
      const calls0 = renderer.info.render.calls;
      const t0 = performance.now();
      let maxFill = 0;
      await new Promise<void>((done) => {
        const tick = () => {
          maxFill = Math.max(maxFill, renderer.backend.timestampQueryPool.render?.currentQueryIndex ?? 0);
          if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      const frames = renderer.info.frame - frame0;
      return {
        fps: Math.round((frames * 1000) / (performance.now() - t0)),
        maxFill,
        reads,
        contextsPerFrame: Math.round((renderer.info.render.calls - calls0) / Math.max(1, frames)),
      };
    }, SECONDS);
    test.info().annotations.push({ type: 'pool', description: JSON.stringify(trace) });
    console.log(`S-20 ${c.name}: ${JSON.stringify(trace)}`);

    // Main's code warned here at 530 to 610 fps (Apple M5 Pro). A machine that cannot render well above a 60 Hz display
    // cannot show what this test is about (the unit tests' pool model covers the logic at any rate).
    test.skip(trace.fps <= 75, `renders at ${trace.fps} fps here: vsync not lifted, or the GPU too slow`);
    const probe = await page.evaluate(() => window.__vidro);
    expect(probe.backend).toBe('webgl2');
    expect(probe.status).toBe('running');
    expect(warnings.filter((w) => /beginQuery|query is already active/i.test(w))).toEqual([]);
    expect(trace.maxFill, 'the pool is emptied long before it is full').toBeLessThan(POOL_QUERIES / 2);
    expect(trace.reads, 'the pass sums keep coming').toBeGreaterThanOrEqual(SECONDS * 2);
    expect(probe.errors).toEqual([]);
    expect(errors).toEqual([]);
  });
}
