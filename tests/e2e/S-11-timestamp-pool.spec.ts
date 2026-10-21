import { expect, test } from '@playwright/test';

/**
 * S-11: three r186's WebGL2 timestamp query pool resets itself when it is full (2048 queries, 1024 render contexts),
 * also in the middle of a nested render (a RenderPipeline pass, a shadow map); the next beginQuery then makes the
 * browser warn "beginQuery: a query is already active". Where nothing reads the per-pass sum (Apple: it is not
 * trusted, and no overlay or bench asks for it), main.ts must still drain the pool from outside any render (S-06
 * found it in the prologue, walk-lab and stress). The scene sensor runs with ?stats=1, which reads the pool, so it
 * cannot see this.
 */
const POOL_QUERIES = 2048;

for (const scene of ['stress', 'walk-lab']) {
  test(`no timestamp-pool warnings without the overlay or a bench: ${scene} [webgl2]`, async ({ page }) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await page.goto(`/?scene=${scene}&webgl=1&debug=1`);
    await page.waitForFunction(() => ['running', 'error'].includes(window.__vidro?.status), undefined, {
      timeout: 60_000,
    });
    test.skip(!(await page.evaluate(() => window.__vidro.gpuTiming)), 'no WebGL2 timer queries here');
    // How full three's pool is (queries handed out since it was last emptied).
    const fill = () =>
      page.evaluate(() => {
        type Pool = { currentQueryIndex: number } | null;
        const debug = (
          window as unknown as {
            __vidroDebug: { renderer: { backend: { timestampQueryPool: { render: Pool } } } };
          }
        ).__vidroDebug;
        return debug.renderer.backend.timestampQueryPool.render?.currentQueryIndex ?? -1;
      });
    // S-06 saw the warning about once a second in stress and once in 6 s in walk-lab.
    let maxFill = -1;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(200);
      maxFill = Math.max(maxFill, await fill());
    }
    const probe = await page.evaluate(() => window.__vidro);
    expect(probe.backend).toBe('webgl2');
    expect(probe.status).toBe('running');
    expect(maxFill, 'the pool is in use').toBeGreaterThanOrEqual(0);
    expect(maxFill, 'the pool is emptied long before it is full').toBeLessThan(POOL_QUERIES / 2);
    expect(warnings.filter((w) => /beginQuery|query is already active/i.test(w))).toEqual([]);
    expect(probe.errors).toEqual([]);
    expect(errors).toEqual([]);
  });
}
