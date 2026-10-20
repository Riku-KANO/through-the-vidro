import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-02 peek cost: layers-lab benched with the frame rate uncapped, so the frame time shows the extra
 * back-layer pass instead of the 60 Hz vsync. Rest and peek alternate (2 rounds) to share any GPU
 * contention evenly. Headless numbers are a reference only (AGENTS.md); the gate is measured headed.
 * Results → artifacts/bench/layers-lab-uncapped-{rest,peek}[-webgl].json
 * Opt-in (PEEK_COST=1) so the regular sensor run stays short.
 */
test.skip(process.env.PEEK_COST !== '1', 'set PEEK_COST=1 to measure the peek cost');
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

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
mkdirSync(join(root, 'artifacts/bench'), { recursive: true });

async function bench(page: Page, backend: string, peek: boolean) {
  const errors: string[] = [];
  const onError = (e: Error): void => {
    errors.push(e.message);
  };
  page.on('pageerror', onError);
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  await page.goto(`/?scene=layers-lab&bench=3&warmup=2${webgl}${peek ? '&peek=hold' : ''}`);
  await page.waitForFunction(
    () => window.__vidro?.status === 'done' || window.__vidro?.status === 'error',
    undefined,
    { timeout: 60_000 },
  );
  page.off('pageerror', onError);
  const probe = await page.evaluate(() => window.__vidro);
  expect(probe.errors).toEqual([]);
  expect(errors).toEqual([]);
  expect(probe.status).toBe('done');
  expect(probe.bench?.budgetViolations ?? []).toEqual([]);
  return probe;
}

for (const backend of backends) {
  const suffix = backend === 'webgl2' ? '-webgl' : '';
  test(`S-02 frame time at rest vs while peeking, uncapped [${backend}]`, async ({ page }) => {
    test.setTimeout(150_000);
    const runs: Record<'rest' | 'peek', number[]> = { rest: [], peek: [] };
    for (let round = 0; round < 2; round++) {
      for (const mode of ['rest', 'peek'] as const) {
        const probe = await bench(page, backend, mode === 'peek');
        runs[mode].push(probe.bench?.p50Ms ?? 0);
        if (mode === 'peek') expect((probe.sceneProbe as { peekAmount?: number }).peekAmount).toBe(1);
        if (round === 1) {
          writeFileSync(
            join(root, `artifacts/bench/layers-lab-uncapped-${mode}${suffix}.json`),
            JSON.stringify(
              { sceneFile: 'layers-lab', requestedBackend: backend, mode, runs, ...probe },
              null,
              2,
            ),
          );
        }
      }
    }
    const fmt = (xs: number[]): string => xs.map((v) => v.toFixed(2)).join(' / ');
    console.log(
      `[S-02 peek cost] ${backend}: rest ${fmt(runs.rest)} ms, peek ${fmt(runs.peek)} ms (median frame)`,
    );
  });
}
