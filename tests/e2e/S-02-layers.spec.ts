import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-02 sensor: drives layers-lab with real input and checks the probe.
 *  - peek: right button held → peekAmount 0→1 in 0.25 s, FOV -6°, back image at peekScale
 *  - place: E at the pedestal → sphere radius 0→4 m in 0.8 s, peeking blocked while placed
 *  - walk: the dead end stops you until the bridge is materialized; pickup refused on the bridge
 *  - demo: ?demo=1 screenshots at the script's marks → artifacts/screens/layers-lab-demo-<mark>[-webgl].png
 *  - bench while peeking → artifacts/bench/layers-lab-peek[-webgl].json
 */
interface LabProbe {
  ready: boolean;
  peeking: boolean;
  peekAmount: number;
  fov: number;
  baseFov: number;
  moveSpeed: number;
  spheres: { orbId: string; kind: string; center: [number, number, number]; radius: number }[];
  orb: 'hand' | 'pedestal';
  activeSegments: string[];
  segmentCount: number;
  player: { x: number; y: number; z: number };
  onBackFooting: boolean;
  shaking: boolean;
  facingPedestal: boolean;
  lastAction: string | null;
  backPassFrames: number;
  backTarget: { width: number; height: number };
  renderSize: { width: number; height: number };
  peekScale: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  demo: { time: number; holding: boolean; marks: Record<string, number> } | null;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
mkdirSync(join(root, 'artifacts/screens'), { recursive: true });
mkdirSync(join(root, 'artifacts/bench'), { recursive: true });

const GPU_VALIDATION =
  /GPUValidationError|Destroyed texture|used in a submit|Invalid (Texture|BindGroup|CommandBuffer)/i;

const lab = (page: Page): Promise<LabProbe> =>
  page.evaluate(() => window.__vidro.sceneProbe as unknown as LabProbe);

async function open(page: Page, backend: string, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && !/GPU stall|powerPreference/i.test(text)) errors.push(text);
    // WebGPU validation failures (e.g. "Destroyed texture … used in a submit") can arrive as warnings
    // and silently drop the frame, so they fail the sensor at any level.
    else if (GPU_VALIDATION.test(text)) errors.push(text);
  });
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  await page.goto(`/?scene=layers-lab${webgl}${extra}`);
  await page.waitForFunction(
    () =>
      window.__vidro?.status === 'error' ||
      (window.__vidro?.sceneProbe as { ready?: boolean })?.ready === true,
    undefined,
    { timeout: 60_000 },
  );
  expect(await page.evaluate(() => window.__vidro.errors)).toEqual([]);
  // let the first GPU pipeline compiles settle so wall-clock timings measure the transitions
  await page.waitForTimeout(1200);
  return errors;
}

/** Records one numeric probe value on every animation frame for `ms`, in page time. */
async function sample(page: Page, key: string, ms: number, start: () => Promise<void>) {
  await page.evaluate(
    ({ key, ms }) => {
      const out: [number, number][] = [];
      (window as unknown as { __samples: [number, number][] }).__samples = out;
      const t0 = performance.now();
      const read = (): number => {
        const probe = window.__vidro.sceneProbe as Record<string, unknown>;
        if (key === 'radius') {
          const s = (probe.spheres as { radius: number }[])[0];
          return s ? s.radius : 0;
        }
        return Number(probe[key]);
      };
      const tick = (): void => {
        out.push([performance.now() - t0, read()]);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { key, ms },
  );
  await start();
  await page.waitForTimeout(ms + 100);
  return page.evaluate(() => (window as unknown as { __samples: [number, number][] }).__samples);
}

/** Seconds between the value first leaving `from` and first reaching `to`. */
function transitionSeconds(samples: [number, number][], from: number, to: number): number {
  const eps = Math.abs(to - from) * 0.002;
  const startIdx = samples.findIndex(([, v]) => Math.abs(v - from) > eps);
  const endIdx = samples.findIndex(([, v]) => Math.abs(v - to) <= eps);
  const trace = samples.map(([t, v]) => `${Math.round(t)}:${v.toFixed(3)}`).join(' ');
  expect(startIdx, `value never changed: ${trace}`).toBeGreaterThanOrEqual(0);
  expect(endIdx, `value never reached the target: ${trace}`).toBeGreaterThan(startIdx);
  // the frame before the first change is the last frame at rest
  const t0 = samples[Math.max(0, startIdx - 1)]?.[0] ?? 0;
  return ((samples[endIdx]?.[0] ?? 0) - t0) / 1000;
}

/** Holds ← until the pedestal is within the lab's facing angle. */
async function turnUntilFacing(page: Page): Promise<void> {
  if ((await lab(page)).facingPedestal) return;
  await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(
    () => (window.__vidro.sceneProbe as { facingPedestal?: boolean }).facingPedestal === true,
    undefined,
    { timeout: 6_000 },
  );
  await page.keyboard.up('ArrowLeft');
}

/** Mean absolute RGB difference (0–255) of two PNG screenshots, decoded by the page. */
async function meanDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([a64, b64]) => {
      const load = async (b64: string): Promise<Uint8ClampedArray> => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const [da, db] = await Promise.all([load(a64), load(b64)]);
      let sum = 0;
      for (let i = 0; i < da.length; i += 4) {
        sum += Math.abs((da[i] ?? 0) - (db[i] ?? 0));
        sum += Math.abs((da[i + 1] ?? 0) - (db[i + 1] ?? 0));
        sum += Math.abs((da[i + 2] ?? 0) - (db[i + 2] ?? 0));
      }
      return sum / (da.length / 4) / 3;
    },
    [a.toString('base64'), b.toString('base64')] as const,
  );
}

async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

for (const backend of backends) {
  const suffix = backend === 'webgl2' ? '-webgl' : '';

  test.describe(`S-02 layers-lab [${backend}]`, () => {
    test('peek: holding the right button raises the orb in 0.25 s and shows the back layer', async ({
      page,
    }) => {
      const errors = await open(page, backend);
      const before = await lab(page);
      expect(before.peeking).toBe(false);
      expect(before.peekAmount).toBe(0);
      expect(before.orbScreen.visible).toBe(true);
      expect(before.orbScreen.y, 'orb rests low in the view').toBeGreaterThan(0.75);
      const framesBefore = before.backPassFrames;

      await page.mouse.move(640, 360);
      const rise = await sample(page, 'peekAmount', 600, () => page.mouse.down({ button: 'right' }));
      const up = transitionSeconds(rise, 0, 1);
      console.log(`[S-02 timing] ${backend} peek start ${up.toFixed(3)} s`);
      expect(up).toBeGreaterThan(0.2);
      expect(up).toBeLessThan(0.3);

      const full = await lab(page);
      expect(full.peeking).toBe(true);
      expect(full.peekAmount).toBe(1);
      expect(full.fov).toBeCloseTo(full.baseFov - 6, 5);
      expect(full.moveSpeed).toBeCloseTo(0.5, 5);
      expect(Math.abs(full.orbScreen.y - 0.5), 'orb is raised to the middle of the view').toBeLessThan(0.08);
      expect(full.backPassFrames).toBeGreaterThan(framesBefore);
      // the back image is drawn at peekScale of the render size
      expect(full.backTarget.width).toBe(Math.floor(full.renderSize.width * full.peekScale));
      expect(full.backTarget.height).toBe(Math.floor(full.renderSize.height * full.peekScale));

      const fall = await sample(page, 'peekAmount', 600, () => page.mouse.up({ button: 'right' }));
      const down = transitionSeconds(fall, 1, 0);
      console.log(`[S-02 timing] ${backend} peek end ${down.toFixed(3)} s`);
      expect(down).toBeGreaterThan(0.2);
      expect(down).toBeLessThan(0.3);
      const after = await lab(page);
      expect(after.peeking).toBe(false);
      expect(after.fov).toBeCloseTo(after.baseFov, 5);
      // no back pass while not peeking
      await page.waitForTimeout(200);
      expect((await lab(page)).backPassFrames).toBe(after.backPassFrames);
      expect(errors).toEqual([]);
    });

    test('place: E at the pedestal grows the sphere 0→4 m in 0.8 s, then peeking is blocked', async ({
      page,
    }) => {
      const errors = await open(page, backend);
      expect((await lab(page)).spheres).toEqual([]);
      expect((await lab(page)).activeSegments).toEqual([]);

      const grow = await sample(page, 'radius', 1300, () => page.keyboard.press('KeyE'));
      const seconds = transitionSeconds(grow, 0, 4);
      console.log(`[S-02 timing] ${backend} materialize ${seconds.toFixed(3)} s`);
      expect(seconds).toBeGreaterThan(0.7);
      expect(seconds).toBeLessThan(0.9);

      const placed = await lab(page);
      expect(placed.orb).toBe('pedestal');
      expect(placed.lastAction).toBe('place');
      expect(placed.spheres).toHaveLength(1);
      expect(placed.spheres[0]).toMatchObject({ kind: 'main', radius: 4 });
      expect(placed.activeSegments).toHaveLength(placed.segmentCount);
      expect(placed.orbScreen.visible, 'the hand is empty').toBe(false);

      await page.mouse.move(640, 360);
      await page.mouse.down({ button: 'right' });
      await page.waitForTimeout(400);
      const blocked = await lab(page);
      expect(blocked.peeking).toBe(false);
      expect(blocked.peekAmount).toBe(0);
      await page.mouse.up({ button: 'right' });
      expect(errors).toEqual([]);
    });

    test('walk: the dead end holds until the bridge is real; no pickup on the bridge; pickup from the ledge reverses', async ({
      page,
    }) => {
      const errors = await open(page, backend);
      await holdKey(page, 'KeyW', 2500);
      const stuck = await lab(page);
      expect(stuck.player.x, 'stops at the edge of the ledge').toBeLessThan(0);
      expect(stuck.player.x).toBeGreaterThan(-0.8);

      // at the edge the pedestal is off to the left: face it, then place
      await turnUntilFacing(page);
      await page.keyboard.press('KeyE');
      await page.waitForFunction(
        () => (window.__vidro.sceneProbe as { spheres: { radius: number }[] }).spheres[0]?.radius === 4,
        undefined,
        { timeout: 5_000 },
      );
      await holdKey(page, 'KeyW', 1100);
      const onBridge = await lab(page);
      expect(onBridge.player.x).toBeGreaterThan(0.3);
      expect(onBridge.player.x).toBeLessThan(2.6);
      expect(onBridge.onBackFooting).toBe(true);

      // turn round until the pedestal is in view, then try to pick up while standing on the bridge
      await turnUntilFacing(page);
      await page.keyboard.press('KeyE');
      await page.waitForTimeout(120);
      const refused = await lab(page);
      expect(refused.lastAction).toBe('pickup-denied');
      expect(refused.shaking, 'the placed orb trembles to say no').toBe(true);
      expect(refused.orb).toBe('pedestal');
      expect(refused.spheres[0]?.radius).toBe(4);

      await holdKey(page, 'KeyW', 2600);
      const across = await lab(page);
      expect(across.player.x, 'crossed to the far ledge').toBeGreaterThan(3.2);
      expect(across.onBackFooting).toBe(false);

      // walk back across to the pedestal side, then pick up from the shared floor
      await holdKey(page, 'KeyS', 4400);
      const back = await lab(page);
      expect(back.player.x).toBeLessThan(-0.4);
      expect(back.onBackFooting).toBe(false);
      await turnUntilFacing(page);

      const shrink = await sample(page, 'radius', 1300, () => page.keyboard.press('KeyE'));
      const seconds = transitionSeconds(shrink, 4, 0);
      console.log(`[S-02 timing] ${backend} pickup ${seconds.toFixed(3)} s`);
      expect(seconds).toBeGreaterThan(0.7);
      expect(seconds).toBeLessThan(0.9);
      for (let i = 1; i < shrink.length; i++) {
        expect(shrink[i]?.[1] ?? 0).toBeLessThanOrEqual(shrink[i - 1]?.[1] ?? 0);
      }
      const done = await lab(page);
      expect(done.lastAction).toBe('pickup');
      expect(done.orb).toBe('hand');
      expect(done.spheres).toEqual([]);
      expect(done.activeSegments).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('peek: the back layer really shows through the orb, and only there', async ({ page }) => {
      // Guards the first S-02 bug (the peek image came out without the back objects): compare the
      // frame while peeking with a frame whose peek image leaves the back layer out (?hideBack=1).
      const grab = async (extra: string) => {
        await open(page, backend, `&peek=hold${extra}`);
        await page.waitForFunction(
          () => (window.__vidro.sceneProbe as { peekAmount?: number }).peekAmount === 1,
        );
        await page.waitForTimeout(200);
        const o = (await lab(page)).orbScreen;
        const vw = 1280;
        const vh = 720;
        const half = o.r * vh * 0.6;
        const inside = await page.screenshot({
          clip: { x: o.x * vw - half, y: o.y * vh - half, width: half * 2, height: half * 2 },
        });
        const outside = await page.screenshot({ clip: { x: 16, y: 16, width: 240, height: 140 } });
        return { inside, outside };
      };
      const withBack = await grab('');
      const withoutBack = await grab('&hideBack=1');
      const inside = await meanDiff(page, withBack.inside, withoutBack.inside);
      const outside = await meanDiff(page, withBack.outside, withoutBack.outside);
      console.log(
        `[S-02 pixels] ${backend} back layer through the orb: inside ${inside.toFixed(2)}, outside ${outside.toFixed(2)}`,
      );
      expect(inside, 'the back layer changes what the orb shows').toBeGreaterThan(4);
      expect(outside, 'outside the orb the back layer stays hidden').toBeLessThan(1);
    });

    test('three spheres at once: main 4 m and two small 2 m orbs (?orbs=3)', async ({ page }) => {
      const errors = await open(page, backend, '&orbs=3');
      const p = await lab(page);
      expect(p.spheres.map((s) => s.radius).sort()).toEqual([2, 2, 4]);
      expect(p.spheres.map((s) => s.kind).sort()).toEqual(['main', 'small', 'small']);
      await page.screenshot({ path: join(root, `artifacts/screens/layers-lab-orbs3${suffix}.png`) });
      expect(errors).toEqual([]);
    });

    test('demo: ?demo=1 plays peek → place; screenshots at the script marks', async ({ page }) => {
      await open(page, backend, '&demo=1');
      const marks = (await lab(page)).demo?.marks ?? {};
      expect(Object.keys(marks).length).toBeGreaterThanOrEqual(4);
      for (const [mark, at] of Object.entries(marks)) {
        // fast-forward the script to each mark; the held state does not depend on the rate
        const errors = await open(page, backend, `&demo=1&demoRate=3&demoHold=${at}`);
        await page.waitForFunction(
          (at) => {
            const d = (window.__vidro.sceneProbe as { demo?: { time: number; holding: boolean } }).demo;
            return !!d && d.holding && d.time >= at - 1e-6;
          },
          at,
          { timeout: 30_000 },
        );
        await page.waitForTimeout(150);
        const probe = await lab(page);
        await page.screenshot({ path: join(root, `artifacts/screens/layers-lab-demo-${mark}${suffix}.png`) });
        if (mark.startsWith('peek-full')) expect(probe.peekAmount).toBe(1);
        if (mark.startsWith('peek-mid')) {
          expect(probe.peekAmount).toBeGreaterThan(0);
          expect(probe.peekAmount).toBeLessThan(1);
        }
        if (mark.startsWith('grow-mid')) {
          expect(probe.spheres[0]?.radius ?? 0).toBeGreaterThan(0);
          expect(probe.spheres[0]?.radius ?? 4).toBeLessThan(4);
        }
        if (mark.startsWith('materialized')) expect(probe.spheres[0]?.radius).toBe(4);
        if (mark === 'refused') {
          expect(probe.lastAction).toBe('pickup-denied');
          expect(probe.shaking).toBe(true);
          expect(probe.facingPedestal).toBe(true);
        }
        expect(errors).toEqual([]);
      }
    });

    test('bench while peeking stays within the render budget', async ({ page }) => {
      const errors = await open(page, backend, '&bench=3&warmup=2&stats=1&peek=hold');
      await page.waitForFunction(
        () => window.__vidro.status === 'done' || window.__vidro.status === 'error',
        undefined,
        { timeout: 60_000 },
      );
      const probe = await page.evaluate(() => window.__vidro);
      await page.screenshot({ path: join(root, `artifacts/screens/layers-lab-peek${suffix}.png`) });
      writeFileSync(
        join(root, `artifacts/bench/layers-lab-peek${suffix}.json`),
        JSON.stringify(
          { sceneFile: 'layers-lab', requestedBackend: backend, ...probe, pageErrors: errors },
          null,
          2,
        ),
      );
      const lp = probe.sceneProbe as unknown as LabProbe;
      expect(probe.status).toBe('done');
      expect(lp.peekAmount).toBe(1);
      expect(lp.backPassFrames).toBeGreaterThan(0);
      expect(probe.bench?.budgetViolations ?? [], 'render budget').toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
