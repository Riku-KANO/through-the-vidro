import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-06: the prologue prototype, played from the home screen to the light drop with real input on both
 * render paths: 潜る → 作業台の玉を手にする → 歩く → 行き止まりで止まる → 覗く → 置く → 渡る → 雫.
 * Also with real input: 置いている間は覗けない, 橋の上では拾えない.
 * Screens → artifacts/screens/S-06/<backend>/, the event log → artifacts/S-06/run-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface RoomProbe {
  ready: boolean;
  playing: boolean;
  time: number;
  position: V3;
  grounded: boolean;
  speed: number;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  fov: number;
  locked: boolean;
  peeking: boolean;
  peekAmount: number;
  moveSpeed: number;
  orb: 'bench' | 'hand' | 'pedestal';
  pedestal: string | null;
  handPresence: number;
  sphereRadius: number;
  bridgeColliders: number;
  bridgeSegments: number;
  onBackFooting: boolean;
  shaking: boolean;
  target: 'bench' | 'pedestal' | 'drop' | null;
  drop: 'waiting' | 'flying' | 'taken';
  dropTaken: boolean;
  events: string[];
  backPassFrames: number;
  autoplay: { step: string; done: boolean } | null;
  layout: {
    edgeZ: number;
    farZ: number;
    pedestalOrb: [number, number, number];
    drop: [number, number, number];
  };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
/** S-03 mouse sensitivity (rad per pixel). */
const SENSITIVITY = 0.0022;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (/GPU stall|powerPreference/i.test(text)) return;
    // warnings count too: WebGPU validation errors can arrive as warnings and silently drop frames
    if (m.type() === 'error' || m.type() === 'warning' || GPU_VALIDATION.test(text)) errors.push(text);
  });
  return errors;
}

const room = (page: Page): Promise<RoomProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { room: RoomProbe }).room);

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<RoomProbe> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return room(page);
}

async function waitHome(page: Page, fn: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

/** Mouse position, tracked so look moves are relative (the page is pointer-locked). */
const cursor = { x: 640, y: 360 };

async function look(page: Page, dYaw: number, dPitch: number): Promise<void> {
  const dx = -dYaw / SENSITIVITY;
  const dy = -dPitch / SENSITIVITY;
  const steps = Math.max(2, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 60));
  cursor.x += dx;
  cursor.y += dy;
  await page.mouse.move(cursor.x, cursor.y, { steps });
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Turns the view (mouse) until it looks at `p` (world point). */
async function lookAt(page: Page, p: [number, number, number]): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const r = await room(page);
    const eye = { x: r.position.x, y: r.position.y + r.eyeHeight, z: r.position.z };
    const dx = p[0] - eye.x;
    const dy = p[1] - eye.y;
    const dz = p[2] - eye.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const dYaw = wrap(yaw - r.yaw);
    const dPitch = pitch - r.pitch;
    if (Math.abs(dYaw) < 0.01 && Math.abs(dPitch) < 0.01) return;
    await look(page, dYaw, dPitch);
    await page.waitForTimeout(60);
  }
}

/** Walks (W) toward a point on the ground, steering with the mouse, until within `within` metres. */
async function walkTo(page: Page, x: number, z: number, within = 0.3, timeout = 20_000): Promise<RoomProbe> {
  const end = Date.now() + timeout;
  await lookAt(page, [x, 1.5, z]);
  await page.keyboard.down('KeyW');
  try {
    for (;;) {
      const r = await room(page);
      const d = Math.hypot(x - r.position.x, z - r.position.z);
      if (d < within) return r;
      if (Date.now() > end)
        throw new Error(`walkTo(${x}, ${z}) did not arrive: at ${JSON.stringify(r.position)}`);
      const yaw = Math.atan2(-(x - r.position.x), -(z - r.position.z));
      const dYaw = wrap(yaw - r.yaw);
      if (Math.abs(dYaw) > 0.05) await look(page, dYaw, 0);
      await page.waitForTimeout(50);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
}

/** Holds a key until the body has been at rest for 0.4 s of scene time (or the limit). */
async function pushUntilStopped(page: Page, key: string, limitMs = 8_000): Promise<RoomProbe[]> {
  const out: RoomProbe[] = [];
  await page.keyboard.down(key);
  let stillSince: number | null = null;
  const end = Date.now() + limitMs;
  try {
    while (Date.now() < end) {
      const r = await room(page);
      out.push(r);
      if (r.speed > 0.03) stillSince = null;
      else stillSince ??= r.time;
      if (stillSince !== null && r.time - stillSince > 0.4 && out.length > 10) break;
      await page.waitForTimeout(40);
    }
  } finally {
    await page.keyboard.up(key);
  }
  return out;
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-06', backend);

  test(`S-06 prologue: dive → walk → dead end → peek → place → cross → drop [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-06'), { recursive: true });
    const errors = collectErrors(page);
    const snap = (name: string) => page.screenshot({ path: join(shotDir, `${name}.png`) });
    await page.goto(`/?scene=prologue-proto${webgl}`);

    // 潜る: loading → home → dive, by the same clicks a player makes
    await waitHome(page, 'p.load.ready === true', 90_000);
    await page.locator('[data-ui="loading-start"]').click();
    await waitHome(page, "p.screen === 'home' && p.transition === null");
    await snap('home');
    await page.locator('[data-item="start"]').click();
    await waitHome(page, "p.transition && p.transition.id === 'home-game' && p.transition.elapsed > 1.0");
    await snap('dive');
    await waitHome(page, "p.screen === 'game' && p.transition === null");
    const landed = await waitRoom(page, 'r.ready && r.playing');
    await snap('landed');
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);

    // standing in front of the workbench: eye 1.6 m, 70 degrees, the orb on the bench in view
    expect(landed.eyeHeight).toBeCloseTo(1.6, 1);
    expect(landed.fov).toBeCloseTo(70, 1);
    expect(landed.grounded).toBe(true);
    expect(landed.orb).toBe('bench');
    expect(landed.target).toBe('bench');

    // take the mouse (the first click only locks), then take the orb from the bench
    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    expect((await room(page)).orb).toBe('bench');
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand' && r.handPresence > 0.99");
    await snap('orb-in-hand');

    // the one way: round the bench, out of the door, down to the broken edge
    await walkTo(page, 0.1, -3.6, 0.35);
    await walkTo(page, 0, -11.5, 0.4);
    await lookAt(page, [0, 1.4, -30]);
    const push = await pushUntilStopped(page, 'KeyW');
    const stop = push.at(-1) as RoomProbe;
    const { edgeZ, farZ, pedestalOrb, drop } = stop.layout;
    expect(push.every((r) => r.grounded && Math.abs(r.position.y) < 0.03)).toBe(true);
    expect(stop.position.z).toBeGreaterThan(edgeZ);
    expect(stop.position.z).toBeLessThan(edgeZ + 0.6);
    expect(stop.bridgeColliders).toBe(0);
    await snap('dead-end');

    // 覗く: right button held; speed ×0.5 and FOV −6° blend in; the back image is drawn
    const passes0 = stop.backPassFrames;
    await page.mouse.down({ button: 'right' });
    const peeked = await waitRoom(page, 'r.peekAmount > 0.999');
    await page.waitForTimeout(400);
    await snap('peek-full');
    const peekFull = await room(page);
    expect(peeked.peeking).toBe(true);
    expect(peekFull.fov).toBeCloseTo(64, 1);
    expect(peekFull.moveSpeed).toBeCloseTo(0.5, 2);
    expect(peekFull.backPassFrames).toBeGreaterThan(passes0 + 5);
    await page.mouse.up({ button: 'right' });
    const unpeeked = await waitRoom(page, 'r.peekAmount === 0');
    expect(unpeeked.fov).toBeCloseTo(70, 1);

    // 置く: face the pedestal and press E; the bridge materializes in 0.8 s and its colliders switch on
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const growing = await waitRoom(page, "r.orb === 'pedestal' && r.sphereRadius > 0");
    expect(growing.pedestal).not.toBeNull();
    const t0 = growing.time;
    const grown = await waitRoom(page, 'r.sphereRadius > 3.99');
    expect(grown.time - t0).toBeGreaterThan(0.55);
    expect(grown.time - t0).toBeLessThan(1.0);
    const full = await waitRoom(page, 'r.bridgeColliders === r.bridgeSegments && r.bridgeSegments > 0');
    expect(full.bridgeSegments).toBeGreaterThan(3);
    await snap('materialized');

    // 置いている間は覗けない: the right button only makes the placed orb tremble
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.shaking === true', 3_000);
    await page.waitForTimeout(300);
    expect((await room(page)).peekAmount).toBe(0);
    await page.mouse.up({ button: 'right' });
    expect((await room(page)).events).toContain('shake:peek');

    // 橋の上では拾えない: step sideways onto the bridge, still facing the pedestal, press E
    await page.keyboard.down('KeyD');
    await waitRoom(page, `r.onBackFooting && r.position.z < ${edgeZ - 0.45}`, 8_000);
    await page.keyboard.up('KeyD');
    await waitRoom(page, 'r.speed < 0.03');
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const refused = await waitRoom(page, 'r.shaking === true', 3_000);
    expect(refused.orb).toBe('pedestal');
    expect(refused.onBackFooting).toBe(true);
    expect(refused.events).toContain('shake:pickup');
    await snap('refused');

    // 渡る: across the bridge to the far shore
    const onBridge = await walkTo(page, 0, edgeZ - 1.4, 0.3);
    expect(onBridge.onBackFooting).toBe(true);
    await snap('on-bridge');
    const crossed = await walkTo(page, 0.45, farZ - 0.6, 0.3);
    expect(crossed.position.z).toBeLessThan(farZ);
    expect(crossed.grounded).toBe(true);
    expect(Math.abs(crossed.position.y)).toBeLessThan(0.03);

    // 雫: touch the light drop
    await lookAt(page, drop);
    await waitRoom(page, "r.target === 'drop'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.drop === 'flying'", 3_000);
    await page.waitForTimeout(350);
    await snap('drop-flying');
    const taken = await waitRoom(page, 'r.dropTaken === true', 5_000);
    expect(taken.events).toEqual(
      expect.arrayContaining(['pickup:bench', 'peekStart', 'peekEnd', 'place', 'shake:peek', 'shake:pickup']),
    );
    expect(taken.events).toContain('dropTaken');
    // looking back over the bridge (渡った後)
    await lookAt(page, [pedestalOrb[0], 1.2, pedestalOrb[2] + 2]);
    await page.waitForTimeout(300);
    await snap('after');

    writeFileSync(
      join(root, `artifacts/S-06/run-${backend}.json`),
      JSON.stringify({ backend, final: await room(page), errors }, null, 2),
    );
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-06 key frames in the middle of the transitions (held) [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    // ?peekHold / ?growHold freeze the peek and a placed orb's growth, so the frame is exactly mid-way
    const frames: [string, string][] = [
      ['hold-peek-0.5', 'spawn=dead-end&peekHold=0.5'],
      ['hold-peek-1.0', 'spawn=dead-end&peekHold=1'],
      ['hold-grow-0.35', 'spawn=dead-end&growHold=0.35'],
      ['hold-grow-1.0', 'spawn=dead-end&growHold=1'],
      ['hold-far', 'spawn=far&growHold=1'],
    ];
    for (const [name, q] of frames) {
      await page.goto(`/?scene=prologue-proto&${q}${webgl}`);
      await waitRoom(page, 'r.ready === true', 60_000);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(shotDir, `${name}.png`) });
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-06 ?autoplay=1 plays home → dive → the drop by script [${backend}]`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&autoplay=1${webgl}`);
    await waitHome(page, "p.screen === 'game' && p.transition === null", 90_000);
    const done = await waitRoom(page, 'r.autoplay && r.autoplay.done && r.dropTaken', 90_000);
    expect(done.events).toEqual(
      expect.arrayContaining(['pickup:bench', 'peekStart', 'peekEnd', 'place', 'dropTouched', 'dropTaken']),
    );
    expect(done.position.z).toBeLessThan(done.layout.farZ);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
