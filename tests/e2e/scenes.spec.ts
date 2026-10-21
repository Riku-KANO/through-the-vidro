import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Sensor for every sandbox scene:
 *  - the scene boots without uncaught exceptions, and without console errors or warnings other than the known ones below
 *  - a screenshot lands in artifacts/screens/<scene>[-webgl].png
 *  - frame stats land in artifacts/bench/<scene>[-webgl].json (with every error and warning seen, known or not, and
 *    how many times each known entry matched)
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

type ConsoleKind = 'error' | 'warning';

/**
 * Console errors and warnings the sensor accepts, in one list (S-11, S-13). Anything else fails the scene: a warning
 * is how the browser reports a WebGL/WebGPU call that did nothing, and those went unnoticed while only errors were
 * counted (S-06). Uncaught exceptions are never accepted.
 * Each entry says why it cannot be fixed here and which slice owns it; keep the pattern narrow, limit it to the
 * scenes and backends (routes) where it shows up, give an example it must match (checked below), and delete the
 * entry once the cause is gone. The bench JSON counts how often each entry matched.
 * No g or y flag: RegExp.test with either keeps lastIndex between calls, so the same message would match only every
 * other time.
 */
interface KnownMessage {
  pattern: RegExp;
  kinds: ConsoleKind[];
  reason: string;
  slice: string;
  example: string;
  scenes?: string[];
  backends?: string[];
}
const KNOWN_CONSOLE: KnownMessage[] = [
  {
    pattern: /GPU stall/i,
    kinds: ['error', 'warning'],
    reason:
      "Chrome's own performance notice from the GL driver when a readback stalls (ReadPixels), not a fault of the page. " +
      'Both routes: the WebGPU route falls back to WebGL2 where WebGPU is missing. Accepted since the scaffold; ' +
      'not seen on the Apple M5 Pro (S-11, S-13: hit counts in the bench JSON)',
    slice: 'S-00',
    example: 'GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels',
  },
  {
    pattern: /powerPreference/i,
    kinds: ['error', 'warning'],
    reason:
      "Chrome's notice that requestAdapter() ignores powerPreference on some platforms (Windows), not a fault of the " +
      'page. Accepted since the scaffold; not seen on the Apple M5 Pro (S-11, S-13: hit counts in the bench JSON)',
    slice: 'S-00',
    example:
      'The powerPreference option is currently ignored when calling requestAdapter() on Windows. ' +
      'See https://crbug.com/369219127',
  },
];
for (const k of KNOWN_CONSOLE) {
  if (/[gy]/.test(k.pattern.flags)) {
    throw new Error(
      `KNOWN_CONSOLE ${k.pattern}: no g or y flag (RegExp.test would keep lastIndex between calls)`,
    );
  }
}

/** Index of the known entry that accepts this message here, or -1. */
const knownIndex = (kind: ConsoleKind, text: string, scene: string, backend: string): number =>
  KNOWN_CONSOLE.findIndex(
    (k) =>
      k.kinds.includes(kind) &&
      k.pattern.test(text) &&
      (!k.scenes || k.scenes.includes(scene)) &&
      (!k.backends || k.backends.includes(backend)),
  );

test.describe('KNOWN_CONSOLE (S-13)', () => {
  for (const [i, k] of KNOWN_CONSOLE.entries()) {
    test(`${k.pattern} (${k.slice}) accepts its example as ${k.kinds.join(' and ')}, every time`, () => {
      const scene = k.scenes?.[0] ?? all[0] ?? 'hello';
      const backend = k.backends?.[0] ?? 'webgpu';
      for (const kind of k.kinds) {
        for (let n = 0; n < 3; n++) expect(knownIndex(kind, k.example, scene, backend)).toBe(i);
      }
    });
  }
});

mkdirSync(join(root, 'artifacts/screens'), { recursive: true });
mkdirSync(join(root, 'artifacts/bench'), { recursive: true });

for (const scene of scenes) {
  for (const backend of backends) {
    const suffix = backend === 'webgl2' ? '-webgl' : '';
    test(`${scene} [${backend}]`, async ({ page }) => {
      const pageExceptions: string[] = [];
      const consoleErrors: string[] = [];
      const pageWarnings: string[] = [];
      const unknownErrors: string[] = [];
      const unknownWarnings: string[] = [];
      const hits = KNOWN_CONSOLE.map(() => ({ error: 0, warning: 0 }));
      page.on('pageerror', (e) => {
        pageExceptions.push(e.message);
        unknownErrors.push(e.message);
      });
      page.on('console', (m) => {
        const kind = m.type() === 'error' ? 'error' : m.type() === 'warning' ? 'warning' : null;
        if (!kind) return;
        const text = m.text();
        (kind === 'error' ? consoleErrors : pageWarnings).push(text);
        const i = knownIndex(kind, text, scene, backend);
        const hit = hits[i];
        if (hit) hit[kind]++;
        else (kind === 'error' ? unknownErrors : unknownWarnings).push(text);
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
        JSON.stringify(
          {
            sceneFile: scene,
            requestedBackend: backend,
            ...probe,
            pageErrors: [...pageExceptions, ...consoleErrors],
            pageWarnings,
            unknownErrors,
            unknownWarnings,
            knownConsole: KNOWN_CONSOLE.map((k, i) => ({
              pattern: String(k.pattern),
              slice: k.slice,
              hits: hits[i],
            })),
          },
          null,
          2,
        ),
      );
      expect(probe.errors, 'probe errors').toEqual([]);
      expect(probe.status).toBe('done');
      expect(unknownErrors, 'uncaught exceptions and console errors not in KNOWN_CONSOLE').toEqual([]);
      expect(unknownWarnings, 'console warnings not in KNOWN_CONSOLE').toEqual([]);
      expect(probe.bench?.frames ?? 0).toBeGreaterThan(0);
      expect(probe.bench?.budgetViolations ?? [], 'render budget').toEqual([]);
    });
  }
}
