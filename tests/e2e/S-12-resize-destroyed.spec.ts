import { expect, type Page, test } from '@playwright/test';

/**
 * S-12: after the render scale changes and comes back (what dynamic resolution does during play), the GPU must
 * never be handed a destroyed texture.
 *
 * The bug (S-11's report): stress on high, setScale(0.95) → setScale(1), and about 20 s later every frame failed
 * with "Destroyed texture [… RGBA16Float] used in a submit" (the whole submit is dropped).
 * Cause (three r186; process/slices/S-12.md, src/core/glass/backdrop.ts): a transmissive material without any node
 * property is not refreshed while nothing about its object changed (NodeMaterialObserver). The transmission
 * backdrop is recreated whenever the render size changes, so an object that was off screen while the size went
 * A → B → A comes back with bindings that still point at the destroyed backdrop. WebGL2 shows the same as
 * "bindTexture: attempt to use a deleted object". The delay is the camera path: on high the far glass comes back
 * into view after ~18 s, on mid the near glass after the camera loops (~34 s).
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

interface Case {
  name: string;
  query: string;
  backend: 'webgpu' | 'webgl2';
  /** Scales to go through, ending where it started (A → B → A). */
  scales: number[];
  /** How long to keep rendering after the change, long enough for off-screen glass to come back. */
  waitMs: number;
  /** Wait for the prologue room to be ready as well (beyond status 'running'). */
  ready?: 'room';
}

const cases: Case[] = [
  {
    // The reported steps; the far glass (transmissive on high only) comes back after ~18 s.
    name: 'stress high',
    query: '?scene=stress&quality=high&dynres=0&debug=1',
    backend: 'webgpu',
    scales: [0.95, 1],
    waitMs: 27_000,
  },
  {
    name: 'stress high',
    // gpuPasses=0: three's per-pass timer queries warn on WebGL2 for another reason (beginQuery, S-11's slice).
    query: '?scene=stress&quality=high&dynres=0&debug=1&webgl=1&gpuPasses=0',
    backend: 'webgl2',
    scales: [0.95, 1],
    waitMs: 27_000,
  },
  {
    // Not only high: the near glass is transmissive on every preset and comes back when the camera loops.
    name: 'stress mid',
    query: '?scene=stress&quality=mid&dynres=0&debug=1',
    backend: 'webgpu',
    scales: [0.8, 0.85],
    waitMs: 40_000,
  },
  {
    // The prologue room played by the autopilot (the camera walks, turns and peeks), started in the room.
    name: 'prologue-proto high',
    query: '?scene=prologue-proto&quality=high&dynres=0&debug=1&direct=1&autoplay=1',
    backend: 'webgpu',
    scales: [0.95, 1],
    waitMs: 27_000,
    ready: 'room',
  },
  {
    name: 'glass-gallery high',
    query: '?scene=glass-gallery&quality=high&dynres=0&debug=1',
    backend: 'webgpu',
    scales: [0.95, 1],
    waitMs: 27_000,
  },
];

for (const c of cases) {
  test(`S-12 ${c.name}: no destroyed texture after the render scale goes ${c.scales.join(' → ')} [${c.backend}]`, async ({
    page,
  }) => {
    test.setTimeout(c.waitMs + 60_000);
    const seen = collectConsole(page);
    await page.goto(c.query);
    await page.waitForFunction(
      (ready) => {
        const v = window.__vidro;
        if (v?.status === 'error') return true;
        if (v?.status !== 'running') return false;
        return ready !== 'room' || (v.sceneProbe.room as { ready?: boolean } | undefined)?.ready === true;
      },
      c.ready ?? null,
      { timeout: 45_000 },
    );
    expect(await page.evaluate(() => window.__vidro.status)).toBe('running');
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(c.backend);
    // Let every object of the starting view be drawn once at the starting size (bind groups created).
    await page.waitForTimeout(2_000);
    for (const scale of c.scales) {
      await page.evaluate((s) => {
        (window as unknown as { __vidroDebug: { setScale(v: number): void } }).__vidroDebug.setScale(s);
      }, scale);
      // A few frames at each size, so the render targets and the backdrop are really recreated.
      await frames(page, 12);
    }
    const scale = await page.evaluate(() => window.__vidro.renderScale);
    expect(scale).toBe(c.scales[c.scales.length - 1]);
    await page.waitForTimeout(c.waitMs);
    expect(await page.evaluate(() => window.__vidro.status)).toBe('running');
    const destroyed = seen.filter((m) => DESTROYED.test(m.text));
    expect(summarize(destroyed), 'destroyed textures used after the scale change').toEqual([]);
    expect(summarize(seen), 'console errors and warnings').toEqual([]);
    expect(await page.evaluate(() => window.__vidro.errors), 'probe errors').toEqual([]);
  });
}
