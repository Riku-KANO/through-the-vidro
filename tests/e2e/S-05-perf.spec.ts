import { expect, type Page, test } from '@playwright/test';
import { QUALITY_PRESETS } from '../../src/core/quality';

/**
 * S-05: auto quality and dynamic resolution are wired into the running app, on both backends.
 * Pure decision logic is covered by src/core/perf/*.test.ts; this checks the app applies it without errors.
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';

  test(`auto quality switches the whole preset by recreating the scene [${backend}]`, async ({ page }) => {
    const errors = collectErrors(page);
    // Start low and pin the recommendation to high, so the switch and verification path always runs.
    await page.goto(`/?scene=hello&quality=auto&autoFrom=low&autoForce=high&autoWindow=2&dynres=0${webgl}`);
    await page.waitForFunction(() => window.__vidro?.qualityDecision != null, undefined, { timeout: 30_000 });
    const decided = await page.evaluate(() => window.__vidro.qualityDecision);
    expect(decided?.measuredAt).toBe('low');
    expect(decided?.level).toBe('high');
    await page.waitForFunction(() => window.__vidro.sceneInstances >= 2, undefined, { timeout: 15_000 });
    // The cheap scene passes verification and stays on high.
    await page.waitForFunction(() => window.__vidro.qualityVerified !== null, undefined, { timeout: 15_000 });
    const probe = await page.evaluate(() => window.__vidro);
    expect(probe.quality).toBe('high');
    expect(probe.qualityVerified).toBe(true);
    expect(probe.sceneInstances).toBe(2);
    expect(probe.renderScale).toBe(QUALITY_PRESETS[probe.quality].renderScale);
    expect(probe.errors).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`auto quality on the stress scene ends on a valid preset without errors [${backend}]`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto(`/?scene=stress&quality=auto&autoWindow=2&dynres=0${webgl}`);
    await page.waitForFunction(() => window.__vidro?.qualityDecision != null, undefined, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const probe = await page.evaluate(() => window.__vidro);
    expect(['gpu', 'frame']).toContain(probe.qualityDecision?.basis);
    expect(probe.renderScale).toBe(QUALITY_PRESETS[probe.quality].renderScale);
    expect(probe.errors).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`dynamic resolution lowers the render scale under load [${backend}]`, async ({ page }) => {
    const errors = collectErrors(page);
    // A 0.1 ms target cannot be met even at the lowest scale, so the controller must step down to its floor.
    // gpuTrust: on Apple/Metal timestamps do not drive decisions by default; the plausibility check still applies.
    // dynresResponse=0: this checks the wiring, not whether the GPU time follows the resolution (S-08).
    await page.goto(`/?scene=hello&dynresTarget=0.1&gpuTrust=1&dynresResponse=0${webgl}`);
    await page.waitForFunction(() => window.__vidro?.status === 'running');
    const before = await page.evaluate(() => document.querySelector('canvas')?.width ?? 0);
    await page.waitForFunction(() => window.__vidro.renderScale <= 0.6, undefined, { timeout: 20_000 });
    const after = await page.evaluate(() => document.querySelector('canvas')?.width ?? 0);
    expect(after).toBeLessThan(before);
    const probe = await page.evaluate(() => window.__vidro);
    expect(probe.renderScale).toBeGreaterThanOrEqual(0.5);
    expect(probe.errors).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`changing the scale in the stress scene (peek target, transmission, post) raises no errors [${backend}]`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto(`/?scene=stress&dynres=0&debug=1${webgl}`);
    await page.waitForFunction(() => window.__vidro?.status === 'running');
    for (const scale of [0.6, 0.75, 0.5, 0.85]) {
      await page.evaluate((s) => {
        (window as unknown as { __vidroDebug: { setScale(v: number): void } }).__vidroDebug.setScale(s);
      }, scale);
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => window.__vidro.renderScale)).toBe(scale);
    }
    const probe = await page.evaluate(() => window.__vidro);
    expect(probe.errors).toEqual([]);
    expect(errors).toEqual([]);
  });
}
