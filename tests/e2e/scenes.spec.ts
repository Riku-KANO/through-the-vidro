import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Sensor for every sandbox scene:
 *  - the scene boots without page errors
 *  - a screenshot lands in artifacts/screens/<scene>[-webgl].png
 *  - frame stats land in artifacts/bench/<scene>[-webgl].json
 * Headless fps is not the gate (see AGENTS.md); budgets for draw calls / triangles are.
 * SCENES=a,b limits the run. BACKENDS=webgpu,webgl2 picks the paths (default: both).
 */
const root = process.cwd();
const all = readdirSync(join(root, 'src/scenes'))
  .filter((f) => f.endsWith('.scene.ts'))
  .map((f) => f.replace(/\.scene\.ts$/, ''))
  .sort();
const only = process.env.SCENES?.split(',').filter(Boolean);
const scenes = only ? all.filter((s) => only.includes(s)) : all;
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const benchSeconds = Number(process.env.BENCH_SECONDS ?? 3);

mkdirSync(join(root, 'artifacts/screens'), { recursive: true });
mkdirSync(join(root, 'artifacts/bench'), { recursive: true });

for (const scene of scenes) {
  for (const backend of backends) {
    const suffix = backend === 'webgl2' ? '-webgl' : '';
    test(`${scene} [${backend}]`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
      });
      const webgl = backend === 'webgl2' ? '&webgl=1' : '';
      await page.goto(`/?scene=${scene}&bench=${benchSeconds}&warmup=2&stats=1${webgl}`);
      await page.waitForFunction(
        () => window.__vidro && (window.__vidro.status === 'done' || window.__vidro.status === 'error'),
        undefined,
        { timeout: 60_000 },
      );
      const probe = await page.evaluate(() => window.__vidro);
      await page.screenshot({ path: join(root, `artifacts/screens/${scene}${suffix}.png`) });
      writeFileSync(
        join(root, `artifacts/bench/${scene}${suffix}.json`),
        JSON.stringify({ sceneFile: scene, requestedBackend: backend, ...probe, pageErrors }, null, 2),
      );
      expect(probe.errors, 'probe errors').toEqual([]);
      expect(probe.status).toBe('done');
      expect(
        pageErrors.filter((e) => !/GPU stall|powerPreference/i.test(e)),
        'page errors',
      ).toEqual([]);
      expect(probe.bench?.frames ?? 0).toBeGreaterThan(0);
      expect(probe.bench?.budgetViolations ?? [], 'render budget').toEqual([]);
    });
  }
}
