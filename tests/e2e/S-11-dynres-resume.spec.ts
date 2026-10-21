import { expect, test } from '@playwright/test';

/**
 * S-11: a dynamic-resolution stop for lack of response is no longer final: the probe says how many times it stopped
 * and resumed, why it is stopped, and what would resume it. Whether a new load really resumes it is covered by the
 * governor's unit tests and checked on hardware with scripts/bench-dynres.mjs (GROW_AT); headless GPU time under
 * vsync does not grow reliably with the window, so here only the wiring and the stopped state are checked.
 */
test('the probe reports stops and resumes of dynamic resolution [webgpu]', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?scene=hello&dynresTarget=0.1');
  await page.waitForFunction(() => window.__vidro?.status === 'running');
  let probe = await page.evaluate(() => window.__vidro);
  expect(probe.dynresStops).toBe(0);
  expect(probe.dynresResumes).toBe(0);
  expect(probe.dynresResumed).toBeNull();
  expect(probe.dynresResumeAtMs).toBeNull();
  // A 0.1 ms target cannot be met: the controller either steps down towards its floor, or stops for lack of response
  // (S-08) and then watches for a new load at the preset scale.
  await page.waitForFunction(
    () => window.__vidro.renderScale <= 0.6 || window.__vidro.dynresStopped !== null,
    undefined,
    { timeout: 20_000 },
  );
  probe = await page.evaluate(() => window.__vidro);
  if (probe.dynresStopped !== null) {
    expect(probe.dynresStops).toBeGreaterThanOrEqual(1);
    expect(probe.dynresStopped).toMatch(/follow.*resumes on a new load/);
    expect(probe.dynresResumeAtMs).toBeGreaterThan(0);
  } else {
    expect(probe.dynresStops).toBe(0);
    expect(probe.dynresResumeAtMs).toBeNull();
  }
  expect(probe.dynresResumes).toBeLessThanOrEqual(3);
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
});
