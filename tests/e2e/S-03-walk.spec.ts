import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-03: first-person movement and input in the walk-lab scene.
 * Sends real key and mouse input and reads window.__vidro.sceneProbe.
 * Movement does not depend on the render backend, so this runs on the default path only;
 * tests/e2e/scenes.spec.ts covers both backends for errors and budgets.
 */
interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface WalkProbe {
  ready: boolean;
  /** Scene time in seconds: the clock the movement runs on (it lags wall time when frames stall). */
  time: number;
  spawn: string;
  position: Vec3;
  velocity: Vec3;
  speed: number;
  grounded: boolean;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  fov: number;
  locked: boolean;
  lockRequests: number;
  peeking: boolean;
  events: string[];
  ledge: { minX: number; maxX: number; minZ: number; maxZ: number; top: number } | null;
}

const root = process.cwd();

async function boot(page: Page, spawn: string, extra = ''): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?scene=walk-lab&spawn=${spawn}${extra}`);
  await page.waitForFunction(
    () => window.__vidro?.status === 'error' || (window.__vidro?.sceneProbe as { ready?: boolean })?.ready,
    undefined,
    { timeout: 60_000 },
  );
  expect(await page.evaluate(() => window.__vidro.errors)).toEqual([]);
  expect(errors).toEqual([]);
}

const probe = (page: Page) => page.evaluate(() => window.__vidro.sceneProbe as unknown as WalkProbe);

/** Samples the probe until `done` holds (or the time limit passes); returns every sample. */
async function sampleUntil(
  page: Page,
  done: (p: WalkProbe) => boolean,
  limitMs: number,
): Promise<WalkProbe[]> {
  const out: WalkProbe[] = [];
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    const p = await probe(page);
    out.push(p);
    if (done(p)) break;
    await page.waitForTimeout(40);
  }
  return out;
}

/** Waits until the body has been at rest for 0.3 s of scene time. */
async function settle(page: Page): Promise<WalkProbe> {
  let stillSince: number | null = null;
  const path = await sampleUntil(
    page,
    (p) => {
      if (p.speed > 0.01) stillSince = null;
      else stillSince ??= p.time;
      return stillSince !== null && p.time - stillSince > 0.3;
    },
    5000,
  );
  return path[path.length - 1] ?? probe(page);
}

const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

test.describe('S-03 walk-lab', () => {
  test('W を2秒押すと約2.8m進む（目の高さ1.6m、歩行1.4m/s）', async ({ page }) => {
    await boot(page, 'start');
    const p0 = await probe(page);
    expect(p0.grounded).toBe(true);
    expect(p0.eyeHeight).toBeCloseTo(1.6, 1);
    await page.keyboard.down('KeyW');
    const down = await probe(page);
    await page.waitForTimeout(1500);
    const mid = await probe(page);
    await page.waitForTimeout(500);
    const up = await probe(page);
    await page.keyboard.up('KeyW');
    const p1 = await settle(page);
    expect(mid.speed).toBeGreaterThan(1.3);
    expect(mid.speed).toBeLessThan(1.5);
    // Judged on the scene's own clock: 1.4 m/s for as long as W was held, give or take the short inertia.
    const held = up.time - down.time;
    expect(held, 'frames stalled: W was held much less than 2 s of scene time').toBeGreaterThan(1.6);
    const distance = flat(p0.position, p1.position);
    expect(distance).toBeGreaterThan(1.4 * held - 0.2);
    expect(distance).toBeLessThan(1.4 * held + 0.3);
    expect(Math.abs(p1.position.y - p0.position.y)).toBeLessThan(0.02);
  });

  test('Shift で早歩き 2.2m/s', async ({ page }) => {
    await boot(page, 'start');
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    const p = await probe(page);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    expect(p.speed).toBeGreaterThan(2.1);
    expect(p.speed).toBeLessThan(2.3);
  });

  test('高台の縁へ歩き続けても落ちず、やわらかく止まる', async ({ page }) => {
    await boot(page, 'edge');
    const p0 = await probe(page);
    const ledge = p0.ledge;
    expect(ledge).not.toBeNull();
    await page.screenshot({ path: join(root, 'artifacts/screens/walk-lab-edge-approach.png') });
    await page.keyboard.down('KeyW');
    // Keep pushing for 4 s of scene time.
    const path = await sampleUntil(page, (p) => p.time - p0.time > 4, 15_000);
    await page.keyboard.up('KeyW');
    await page.screenshot({ path: join(root, 'artifacts/screens/walk-lab-edge.png') });
    for (const p of path) {
      expect(p.grounded).toBe(true);
      expect(Math.abs(p.position.y - (ledge?.top ?? 0))).toBeLessThan(0.03);
      expect(p.position.x).toBeGreaterThan(ledge?.minX ?? 0);
    }
    const end = path[path.length - 1];
    expect(end?.speed).toBeLessThan(0.05);
    expect((end?.position.x ?? 0) - (ledge?.minX ?? 0)).toBeLessThan(0.5);
    // Soft: the slowdown is visible over several samples, not a dead stop.
    expect(path.some((p) => p.speed > 0.2 && p.speed < 1.1)).toBe(true);
  });

  test('段差（0.2m×6段）を上れる', async ({ page }) => {
    await boot(page, 'steps');
    const p0 = await probe(page);
    await page.keyboard.down('KeyW');
    await sampleUntil(page, (p) => p.position.y - p0.position.y > 1.15 && p.position.z < -3.5, 15_000);
    await page.keyboard.up('KeyW');
    const p1 = await settle(page);
    expect(p1.grounded).toBe(true);
    expect(p1.position.y - p0.position.y).toBeGreaterThan(1.15);
    expect(p1.position.y - p0.position.y).toBeLessThan(1.25);
    expect(p1.eyeHeight).toBeCloseTo(1.6, 1);
  });

  test('斜面を上って高台へ行ける', async ({ page }) => {
    await boot(page, 'slope');
    const p0 = await probe(page);
    await page.keyboard.down('KeyW');
    await sampleUntil(page, (p) => p.position.y - p0.position.y > 1.15 && p.position.x < -4.5, 15_000);
    await page.keyboard.up('KeyW');
    const p1 = await settle(page);
    expect(p1.grounded).toBe(true);
    expect(p1.position.y - p0.position.y).toBeGreaterThan(1.15);
  });

  test('丸い柱に沿って滑らかに流れ、引っかからない', async ({ page }) => {
    await boot(page, 'pillar');
    const p0 = await probe(page);
    await page.keyboard.down('KeyW');
    const path = await sampleUntil(page, (p) => p0.position.z - p.position.z > 4.5, 15_000);
    await page.keyboard.up('KeyW');
    // From 0.5 s of scene time on (after speeding up) until past the pillar, the body never stalls.
    const moving = path.filter((p) => p.time - p0.time > 0.5);
    expect(moving.length).toBeGreaterThan(10);
    expect(Math.min(...moving.map((p) => p.speed))).toBeGreaterThan(0.5);
    const end = path[path.length - 1];
    expect(p0.position.z - (end?.position.z ?? 0)).toBeGreaterThan(4.5);
  });

  test('橋を渡って見晴らし台に立てる', async ({ page }) => {
    await boot(page, 'bridge');
    const p0 = await probe(page);
    await page.keyboard.down('KeyW');
    const path = await sampleUntil(page, (p) => p.position.z < -13.8, 15_000);
    await page.keyboard.up('KeyW');
    expect(path.every((p) => p.grounded && Math.abs(p.position.y - p0.position.y) < 0.03)).toBe(true);
    expect(path[path.length - 1]?.position.z).toBeLessThan(-13.8);
  });

  test('視点: クリックで Pointer Lock、マウスで向きが変わり、Esc で解除', async ({ page }) => {
    await boot(page, 'start');
    const p0 = await probe(page);
    // The first click only takes the mouse; dragging also turns the view while the lock is pending.
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.move(740, 360, { steps: 10 });
    await page.mouse.move(840, 400, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => (window.__vidro.sceneProbe as { locked?: boolean }).locked === true);
    const p1 = await probe(page);
    expect(p1.lockRequests).toBe(1);
    expect(p1.yaw).toBeLessThan(p0.yaw - 0.1);
    expect(p1.pitch).toBeLessThan(p0.pitch);
    expect(p1.events).not.toContain('interact');
    // Locked: mouse movement turns the view, a left click is 置く・拾う・調べる.
    await page.mouse.move(700, 360, { steps: 5 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(100);
    const p2 = await probe(page);
    expect(p2.yaw).not.toBeCloseTo(p1.yaw, 3);
    expect(p2.events).toContain('interact');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window.__vidro.sceneProbe as { locked?: boolean }).locked === false);
    expect((await probe(page)).events).toContain('pause');
  });

  test('覗く（右クリック長押し）: 速度0.5倍・視野角-6度、離すと戻る', async ({ page }) => {
    await boot(page, 'start');
    const fov0 = (await probe(page)).fov;
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    const p = await probe(page);
    await page.keyboard.up('KeyW');
    expect(p.peeking).toBe(true);
    expect(p.speed).toBeGreaterThan(0.65);
    expect(p.speed).toBeLessThan(0.75);
    expect(p.fov).toBeCloseTo(fov0 - 6, 1);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(500);
    const q = await probe(page);
    expect(q.peeking).toBe(false);
    expect(q.fov).toBeCloseTo(fov0, 1);
    await page.keyboard.press('KeyE');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const events = (await probe(page)).events;
    expect(events).toEqual(expect.arrayContaining(['peekStart', 'peekEnd', 'interact', 'pause']));
  });

  test('見る: 各所の一人称の見え方を残す', async ({ page }) => {
    for (const spawn of ['overview', 'steps', 'slope', 'pillar', 'curve', 'bridge']) {
      await boot(page, spawn);
      await page.screenshot({ path: join(root, `artifacts/screens/walk-lab-${spawn}.png`) });
    }
  });

  test('覗く（切り替え）: 押すたびに切り替わる', async ({ page }) => {
    await boot(page, 'start', '&peek=toggle');
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(100);
    expect((await probe(page)).peeking).toBe(true);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(100);
    expect((await probe(page)).peeking).toBe(false);
  });
});
