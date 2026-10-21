import { expect, type Page, test } from '@playwright/test';

/**
 * S-12: after the render scale changes and comes back (what dynamic resolution does during play), the GPU must
 * never be handed a destroyed texture.
 *
 * The bug (S-11's report): stress on high, setScale(0.95) → setScale(1), and about 20 s later every frame failed
 * with "Destroyed texture [… RGBA16Float] used in a submit" (the whole submit is dropped).
 * Cause (three r186; process/slices/S-12.md, src/core/glass/backdrop.ts): a transmissive material without any node
 * property is not refreshed while nothing about its object changed (NodeMaterialObserver). The transmission
 * backdrop is recreated at each new render size (by the glass still in view), so an object that was off screen
 * while the size went A → B → A comes back with bindings that still point at the destroyed backdrop. WebGL2 shows
 * the same as "bindTexture: attempt to use a deleted object". The delay is the camera path: on high the far glass
 * comes back into view after ~18 s, on mid the near glass after the camera loops (~34 s).
 *
 * Each case waits long enough for those objects to come back. Console errors and warnings both count: WebGPU
 * validation errors arrive as both, and the frame is silently dropped.
 */
const BENIGN = /GPU stall|powerPreference/i;
const DESTROYED = /Destroyed texture|attempt to use a deleted object/i;

function collectConsole(page: Page): { at: number; text: string }[] {
  const seen: { at: number; text: string }[] = [];
  const t0 = Date.now();
  page.on('pageerror', (e) => seen.push({ at: (Date.now() - t0) / 1000, text: e.message }));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !BENIGN.test(m.text()))
      seen.push({ at: (Date.now() - t0) / 1000, text: `[${m.type()}] ${m.text()}` });
  });
  return seen;
}

/** One line per distinct message with its count, so a failure says what, how often and from when. */
function summarize(seen: { at: number; text: string }[]): string[] {
  const byText = new Map<string, { n: number; first: number }>();
  for (const { at, text } of seen) {
    const key = text.replace(/\s+/g, ' ').slice(0, 240);
    const entry = byText.get(key) ?? { n: 0, first: at };
    entry.n++;
    byText.set(key, entry);
  }
  return [...byText].map(([text, { n, first }]) => `${n}× from ${first.toFixed(1)} s: ${text}`);
}

async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/** The scale goes down by this much and back to where it started (A → B → A), like one dynamic resolution step. */
const STEP_DOWN = 0.05;

interface Case {
  name: string;
  query: string;
  backend: 'webgpu' | 'webgl2';
  /**
   * How long to keep rendering after the change, long enough for the off-screen glass to come back into view: set by
   * the stress scene's camera path (update() in src/scenes/stress.scene.ts).
   */
  waitMs: number;
}

// prologue-proto and glass-gallery were green here before the fix as well: all their transmissive glass comes from
// createGlass(), which src/core/glass/backdrop.test.ts covers for every kind, preset, placement and role (S-12 record).
const cases: Case[] = [
  {
    // The reported steps; the far glass (transmissive on high only) comes back after ~18 s.
    name: 'stress high',
    query: '?scene=stress&quality=high&dynres=0&debug=1',
    backend: 'webgpu',
    waitMs: 27_000,
  },
  {
    name: 'stress high',
    query: '?scene=stress&quality=high&dynres=0&debug=1&webgl=1',
    backend: 'webgl2',
    waitMs: 27_000,
  },
  {
    // Not only high: the near glass is transmissive on every preset and comes back when the camera loops (~34 s).
    name: 'stress mid',
    query: '?scene=stress&quality=mid&dynres=0&debug=1',
    backend: 'webgpu',
    waitMs: 40_000,
  },
];

for (const c of cases) {
  test(`S-12 ${c.name}: no destroyed texture after the render scale goes down and back [${c.backend}]`, async ({
    page,
  }) => {
    test.setTimeout(c.waitMs + 60_000);
    const seen = collectConsole(page);
    await page.goto(c.query);
    await page.waitForFunction(() => ['running', 'error'].includes(window.__vidro?.status), undefined, {
      timeout: 45_000,
    });
    expect(await page.evaluate(() => window.__vidro.status)).toBe('running');
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(c.backend);
    // Let every object of the starting view be drawn once at the starting size (bind groups created).
    await page.waitForTimeout(2_000);
    // Back to the very scale it started at, whatever the preset's scale is: A → B → C would not reproduce the bug.
    const start = await page.evaluate(() => window.__vidro.renderScale);
    const scales = [Math.round((start - STEP_DOWN) * 100) / 100, start];
    for (const scale of scales) {
      await page.evaluate((s) => {
        (window as unknown as { __vidroDebug: { setScale(v: number): void } }).__vidroDebug.setScale(s);
      }, scale);
      // A few frames at each size, so the render targets and the backdrop are really recreated.
      await frames(page, 12);
    }
    expect(await page.evaluate(() => window.__vidro.renderScale), `back at ${start}`).toBe(start);
    await page.waitForTimeout(c.waitMs);
    expect(await page.evaluate(() => window.__vidro.status)).toBe('running');
    const destroyed = seen.filter((m) => DESTROYED.test(m.text));
    expect(summarize(destroyed), `destroyed textures used after ${scales.join(' → ')}`).toEqual([]);
    expect(summarize(seen), 'console errors and warnings').toEqual([]);
    expect(await page.evaluate(() => window.__vidro.errors), 'probe errors').toEqual([]);
  });
}
