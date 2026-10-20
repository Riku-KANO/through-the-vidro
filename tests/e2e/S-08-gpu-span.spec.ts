import { expect, type Page, test } from '@playwright/test';

/**
 * S-08: the GPU frame span (first pass start → last pass end, from our own timestamps) is measured on WebGPU,
 * kept apart from three's per-pass sum, and drives the governor even on Apple/Metal.
 * Whether the span matches the real per-frame cost is checked on hardware with scripts/bench-headed.mjs
 * (vsync off, quiet machine); headless frame time is capped by vsync, so here only plausibility is checked.
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

test('WebGPU measures the frame span separately from the per-pass sum [webgpu]', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?scene=stress&bench=3&warmup=1');
  await page.waitForFunction(() => ['done', 'error'].includes(window.__vidro?.status), undefined, {
    timeout: 60_000,
  });
  const probe = await page.evaluate(() => window.__vidro);
  expect(probe.status).toBe('done');
  expect(probe.backend).toBe('webgpu');
  expect(probe.gpuSource).toBe('span');
  const bench = probe.bench;
  const span = bench?.gpuSpan;
  expect(span?.samples ?? 0).toBeGreaterThanOrEqual(3);
  expect(span?.avgMs ?? 0).toBeGreaterThan(0);
  // Under vsync a reading above the frame time is unusable (the governor's plausibility check uses the same bound).
  expect(span?.p50Ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((bench?.avgMs ?? 0) * 1.1 + 0.5);
  // The per-pass sum stays available as a separate reference value while a bench records.
  expect(bench?.gpu?.samples ?? 0).toBeGreaterThan(0);
  // The CPU time of render() is sampled alongside, to tell waiting for submits from GPU work.
  expect(bench?.cpuRenderMs?.samples ?? 0).toBeGreaterThan(0);
  expect(probe.gpuTimingTrusted).toBe(true);
  expect(probe.gpuReliable).toBe(true);
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
});

test('dynamic resolution runs on the frame span without ?gpuTrust, also on Apple [webgpu]', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // A 0.1 ms target cannot be met, so the controller steps down. Whether the span then follows the resolution
  // depends on the GPU (under vsync it may clock down instead): it either keeps stepping down towards its floor,
  // or stops and goes back to the preset scale with a reason. Both are correct; a stuck lowered scale is not.
  await page.goto('/?scene=hello&dynresTarget=0.1');
  await page.waitForFunction(() => window.__vidro?.status === 'running');
  const before = await page.evaluate(() => document.querySelector('canvas')?.width ?? 0);
  await page.waitForFunction(() => window.__vidro.renderScale < 0.85, undefined, { timeout: 20_000 });
  const lowered = await page.evaluate(() => document.querySelector('canvas')?.width ?? 0);
  expect(lowered).toBeLessThan(before);
  await page.waitForFunction(
    () => window.__vidro.renderScale <= 0.6 || window.__vidro.dynresStopped !== null,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(300);
  const probe = await page.evaluate(() => window.__vidro);
  expect(probe.gpuSource).toBe('span');
  expect(probe.gpuReliable).toBe(true);
  if (probe.dynresStopped !== null) {
    expect(probe.dynresStopped).toMatch(/follow/);
    expect(probe.renderScale).toBe(0.85);
    expect(await page.evaluate(() => document.querySelector('canvas')?.width ?? 0)).toBe(before);
  } else {
    expect(probe.renderScale).toBeGreaterThanOrEqual(0.5);
  }
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
});

test("three's per-pass timestamps run only while a bench records, where the span drives decisions [webgpu]", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/?scene=hello&debug=1&stats=1');
  await page.waitForFunction(() => window.__vidro?.status === 'running');
  await page.waitForTimeout(500);
  type Backend = { trackTimestamp: boolean; timestampQueryPool: { render: unknown } };
  const backend = () =>
    page.evaluate(() => {
      const b = (window as unknown as { __vidroDebug: { renderer: { backend: Backend } } }).__vidroDebug
        .renderer.backend;
      return { tracking: b.trackTimestamp, pool: b.timestampQueryPool.render !== null };
    });
  expect(await page.evaluate(() => window.__vidro.gpuSource)).toBe('span');
  expect(await backend()).toEqual({ tracking: false, pool: false });
  // The overlay and the governor get the span meanwhile.
  await page.waitForFunction(() => window.__vidro.gpuMs !== null, undefined, { timeout: 10_000 });
  // Not even the renders while the scene was created (environment maps) wrote per-pass timestamps: no query pool.
  expect(await backend()).toEqual({ tracking: false, pool: false });
  await page.goto('/?scene=hello&debug=1&bench=3&warmup=1');
  await page.waitForFunction(() => ['done', 'error'].includes(window.__vidro?.status), undefined, {
    timeout: 30_000,
  });
  const probe = await page.evaluate(() => window.__vidro);
  expect(probe.bench?.gpu?.samples ?? 0).toBeGreaterThan(0);
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
});

test('WebGL2 has no frame span and keeps the per-pass rule [webgl2]', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?scene=hello&bench=2&warmup=1&webgl=1');
  await page.waitForFunction(() => ['done', 'error'].includes(window.__vidro?.status), undefined, {
    timeout: 60_000,
  });
  const probe = await page.evaluate(() => window.__vidro);
  expect(probe.status).toBe('done');
  expect(probe.backend).toBe('webgl2');
  expect(probe.gpuSource).toBe(probe.gpuTiming ? 'passes' : 'none');
  expect(probe.bench?.gpuSpan).toBeNull();
  if (/apple|metal/i.test(probe.gpuName)) {
    // The per-pass sum is not trusted on Apple: without ?gpuTrust dynamic resolution stays off.
    expect(probe.gpuTimingTrusted).toBe(false);
    expect(probe.gpuReliable).toBe(false);
  }
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
});
