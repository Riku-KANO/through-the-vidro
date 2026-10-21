import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Sensor for every sandbox scene:
 *  - the scene boots without page errors, and without console warnings other than the known ones below
 *  - a screenshot lands in artifacts/screens/<scene>[-webgl].png
 *  - frame stats land in artifacts/bench/<scene>[-webgl].json (with every warning seen, known or not)
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

/**
 * Console warnings the sensor accepts (S-11). Anything else fails the scene: a warning is how the browser reports a
 * WebGL/WebGPU call that did nothing, and those went unnoticed while only errors were counted (S-06).
 * Each entry says why it cannot be fixed here and which slice owns it; keep the pattern narrow, limit it to the
 * scenes and backends where it shows up, and delete the entry once the cause is gone.
 */
interface KnownWarning {
  pattern: RegExp;
  reason: string;
  slice: string;
  scenes?: string[];
  backends?: string[];
}
const KNOWN_WARNINGS: KnownWarning[] = [];

const isKnown = (text: string, scene: string, backend: string): boolean =>
  KNOWN_WARNINGS.some(
    (k) =>
      k.pattern.test(text) &&
      (!k.scenes || k.scenes.includes(scene)) &&
      (!k.backends || k.backends.includes(backend)),
  );

mkdirSync(join(root, 'artifacts/screens'), { recursive: true });
mkdirSync(join(root, 'artifacts/bench'), { recursive: true });

for (const scene of scenes) {
  for (const backend of backends) {
    const suffix = backend === 'webgl2' ? '-webgl' : '';
    test(`${scene} [${backend}]`, async ({ page }) => {
      const pageErrors: string[] = [];
      const pageWarnings: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
        if (m.type() === 'warning') pageWarnings.push(m.text());
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
      const unknownWarnings = pageWarnings.filter((w) => !isKnown(w, scene, backend));
      writeFileSync(
        join(root, `artifacts/bench/${scene}${suffix}.json`),
        JSON.stringify(
          {
            sceneFile: scene,
            requestedBackend: backend,
            ...probe,
            pageErrors,
            pageWarnings,
            unknownWarnings,
          },
          null,
          2,
        ),
      );
      expect(probe.errors, 'probe errors').toEqual([]);
      expect(probe.status).toBe('done');
      expect(
        pageErrors.filter((e) => !/GPU stall|powerPreference/i.test(e)),
        'page errors',
      ).toEqual([]);
      expect(unknownWarnings, 'console warnings not in KNOWN_WARNINGS').toEqual([]);
      expect(probe.bench?.frames ?? 0).toBeGreaterThan(0);
      expect(probe.bench?.budgetViolations ?? [], 'render budget').toEqual([]);
    });
  }
}
