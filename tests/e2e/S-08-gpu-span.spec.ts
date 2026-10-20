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
  // A span longer than the real frame is physically impossible (the per-pass sum on Apple was).
  expect(span?.p50Ms ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((bench?.avgMs ?? 0) * 1.1 + 0.5);
  // The per-pass sum stays available as a separate reference value.
  expect(bench).toHaveProperty('gpu');
  expect(probe.gpuTimingTrusted).toBe(true);
  expect(probe.gpuReliable).toBe(true);
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
});

test('dynamic resolution runs on the frame span without ?gpuTrust, also on Apple [webgpu]', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // A 0.1 ms target cannot be met even at the lowest scale, so the controller must step down to its floor.
  await page.goto('/?scene=hello&dynresTarget=0.1');
  await page.waitForFunction(() => window.__vidro?.status === 'running');
  const before = await page.evaluate(() => document.querySelector('canvas')?.width ?? 0);
  await page.waitForFunction(() => window.__vidro.renderScale <= 0.6, undefined, { timeout: 20_000 });
  const after = await page.evaluate(() => document.querySelector('canvas')?.width ?? 0);
  expect(after).toBeLessThan(before);
  const probe = await page.evaluate(() => window.__vidro);
  expect(probe.gpuSource).toBe('span');
  expect(probe.gpuReliable).toBe(true);
  expect(probe.renderScale).toBeGreaterThanOrEqual(0.5);
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
  if (/apple|metal/i.test(probe.gpuName)) expect(probe.gpuTimingTrusted).toBe(false);
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
});
