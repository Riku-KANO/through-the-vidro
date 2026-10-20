import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { HomeDiveProbe } from '../../src/ui/probe';

/**
 * S-04: loading → home → dive into the orb.
 *  - autoplay with pause checkpoints: screenshots in the middle of each transition (both backends)
 *  - real-time autoplay: per-phase worst frame time and render counters (budget, compile stalls)
 *  - input: click / hover / tilt / keyboard only / Esc during a transition plays it back
 * Screens → artifacts/screens/S-04/<backend>/, timeline → artifacts/S-04/timeline-<backend>.json
 */
// Japanese is the first language of the game (and the Mincho type is what the screenshots should show)
test.use({ locale: 'ja-JP' });

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };

const CHECKPOINTS = {
  'loading-home': [0, 0.75, 1.5],
  'home-game': [0, 0.5, 0.8, 0.9, 1.0, 1.5, 2.0],
} as const;
const pauseParam = Object.entries(CHECKPOINTS)
  .map(([id, ts]) => `${id}:${ts.join(',')}`)
  .join('/');

const probe = (page: Page): Promise<HomeDiveProbe> =>
  page.evaluate(() => window.__vidro.sceneProbe as unknown as HomeDiveProbe);

async function waitProbe(page: Page, fn: string, timeout = 30_000): Promise<void> {
  // the probe is filled in once per frame by the scene; until then fields may be missing
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

/** Mean luminance and share of near-black pixels of a PNG, decoded by the browser. */
async function luminance(page: Page, png: Buffer): Promise<{ mean: number; dark: number }> {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let sum = 0;
    let dark = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 5) {
      const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      sum += l;
      if (l < 0.06) dark++;
      n++;
    }
    return { mean: sum / n, dark: dark / n };
  }, png.toString('base64'));
}

async function waitFrames(page: Page, n = 3): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = (): void => {
          if (--left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-04', backend);

  test(`S-04 autoplay timeline with mid-transition screenshots [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=home-dive&autoplay=1&pause=${pauseParam}${webgl}`);

    const shots: Record<string, { mean: number; dark: number }> = {};
    const snap = async (name: string): Promise<void> => {
      await waitFrames(page);
      const png = await page.screenshot({ path: join(shotDir, `${name}.png`) });
      shots[name] = await luminance(page, png);
    };

    await waitProbe(page, 'p.load.ready === true && p.load.fill >= 1', 60_000);
    await page.waitForTimeout(700);
    await snap('loading-ready');

    for (const [id, times] of Object.entries(CHECKPOINTS)) {
      for (const at of times) {
        await waitProbe(page, `p.paused && p.paused.id === '${id}' && Math.abs(p.paused.at - ${at}) < 1e-6`);
        const p = await probe(page);
        expect(p.transition?.id).toBe(id);
        expect(p.transition?.elapsed ?? -1).toBeCloseTo(at, 3);
        await snap(`${id}-${at.toFixed(2)}s`);
        await page.evaluate(() => {
          (window.__vidro.sceneProbe as unknown as HomeDiveProbe).release = true;
        });
      }
      if (id === 'loading-home') {
        await waitProbe(page, "p.screen === 'home' && p.transition === null");
        await snap('home');
      }
    }
    await waitProbe(page, "p.screen === 'game' && p.transition === null");
    await snap('game');

    writeFileSync(join(shotDir, 'luminance.json'), JSON.stringify(shots, null, 2));
    for (const [name, s] of Object.entries(shots)) {
      expect(s.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(s.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
    }
    const p = await probe(page);
    expect(p.dive.inner).toBe(1);
    expect(errors.filter((e) => !/GPU stall|powerPreference/i.test(e))).toEqual([]);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
  });

  test(`S-04 real-time autoplay stays in budget [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(join(root, 'artifacts/S-04'), { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=home-dive&autoplay=1${webgl}`);
    await waitProbe(page, "p.screen === 'game' && p.transition === null", 60_000);
    await page.waitForTimeout(500);
    const p = await probe(page);
    const backendUsed = await page.evaluate(() => window.__vidro.backend);
    writeFileSync(
      join(root, `artifacts/S-04/timeline-${backend}.json`),
      JSON.stringify({ backend: backendUsed, phases: p.phases, load: p.load, errors }, null, 2),
    );
    expect(backendUsed).toBe(backend);
    for (const [phase, s] of Object.entries(p.phases)) {
      expect(s.frames, `frames in ${phase}`).toBeGreaterThan(0);
      expect(s.maxDrawCalls, `draw calls in ${phase}`).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(s.maxTriangles, `triangles in ${phase}`).toBeLessThanOrEqual(BUDGET.triangles);
    }
    // A pipeline compile in the middle of a transition shows up as a long frame (S-00 saw 1.2 s).
    for (const phase of ['loading-home', 'home', 'home-game', 'game'] as const) {
      expect(p.phases[phase]?.maxFrameMs ?? 0, `worst frame in ${phase}`).toBeLessThan(500);
    }
    expect(errors.filter((e) => !/GPU stall|powerPreference/i.test(e))).toEqual([]);
  });
}

test.describe('S-04 input', () => {
  test('click starts (and unlocks audio), Esc plays the opening back, hover swells a drop, the mouse tilts the orb', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.goto('/?scene=home-dive');
    await waitProbe(page, 'p.load.ready === true', 60_000);
    const startDrop = page.locator('[data-ui="loading-start"]');
    await expect(startDrop).toBeVisible();
    expect((await probe(page)).audio).toBe('locked');

    await startDrop.click();
    await waitProbe(page, "p.transition && p.transition.id === 'loading-home' && p.transition.elapsed > 0.6");
    expect((await probe(page)).audio).toBe('running');
    await page.keyboard.press('Escape');
    await waitProbe(page, 'p.transition && p.transition.direction === -1', 2_000);
    await waitProbe(page, "p.screen === 'loading' && p.transition === null");

    await startDrop.click();
    await waitProbe(page, "p.screen === 'home' && p.transition === null");

    const drop = page.locator('[data-item="continue"]');
    const scaleOf = (): Promise<number> =>
      drop.evaluate((el) => {
        const bead = el.querySelector('[data-part="bead"]') ?? el;
        return new DOMMatrix(getComputedStyle(bead).transform).a;
      });
    const before = await scaleOf();
    await drop.hover();
    await page.waitForTimeout(450);
    expect((await probe(page)).hovered).toBe('continue');
    expect(await scaleOf()).toBeGreaterThan(before * 1.05);

    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.move(vp.width * 0.95, vp.height * 0.08);
    await page.waitForTimeout(900);
    const tilted = await probe(page);
    expect(Math.abs(tilted.tilt.x) + Math.abs(tilted.tilt.y)).toBeGreaterThan(0.01);
    expect(Math.abs(tilted.tilt.x)).toBeLessThanOrEqual(tilted.tiltMax + 1e-6);
    expect(Math.abs(tilted.tilt.y)).toBeLessThanOrEqual(tilted.tiltMax + 1e-6);
    expect(errors).toEqual([]);
  });

  test('keyboard only: Enter starts, arrows move between drops, Enter dives, Esc during the dive returns home', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.goto('/?scene=home-dive');
    await waitProbe(page, 'p.load.ready === true', 60_000);
    // 「はじめる」 floats up once the vessel is full and takes the keyboard focus
    await expect(page.locator('[data-ui="loading-start"]')).toBeFocused({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    await waitProbe(page, "p.screen === 'home' && p.transition === null");
    await waitProbe(page, "p.focused === 'start'", 2_000);
    await page.keyboard.press('ArrowDown');
    await waitProbe(page, "p.focused === 'continue'", 2_000);
    await page.keyboard.press('ArrowUp');
    await waitProbe(page, "p.focused === 'start'", 2_000);

    await page.keyboard.press('Enter');
    await waitProbe(page, "p.transition && p.transition.id === 'home-game' && p.transition.elapsed > 0.8");
    await page.keyboard.press('Escape');
    await waitProbe(page, 'p.transition && p.transition.direction === -1', 2_000);
    await waitProbe(page, "p.screen === 'home' && p.transition === null");
    await waitProbe(page, "p.focused === 'start'", 2_000);

    await page.keyboard.press('Enter');
    await waitProbe(page, "p.screen === 'game' && p.transition === null");
    expect(errors).toEqual([]);
  });
});
