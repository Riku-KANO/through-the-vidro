import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-06: the prologue prototype, played from the home screen to the light drop with real input on both
 * render paths: 潜る → 作業台の玉を手にする → 歩く → 行き止まりで止まる → 覗く → 置く → 渡る → 雫.
 * Also with real input: 置いている間は覗けない, 橋の上では拾えない.
 * S-34 carries the play-through on to the close: 雫 → 橋を戻る → 玉を拾う (on the settled bridge) → 門をくぐる.
 * S-35 carries it on down the slope to the central plaza, to the front of its open east gate (real input and autoplay).
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
  drawCalls: number;
  triangles: number;
  fallRescues: number;
  /** S-34: also the longest frame of the play, the step it fell in, and the longest frame of each step. */
  autoplay: {
    step: string;
    done: boolean;
    worstMs?: number;
    worstStep?: string;
    worstAt?: number;
    steps?: Record<string, number>;
  } | null;
  /** S-34: the close (the bridge settled by the drop's light, the gate open). */
  finale: { settle: number; gate: number; settledSegments: number; gateOpen: boolean };
  layout: {
    edgeZ: number;
    farZ: number;
    pedestalOrb: [number, number, number];
    drop: [number, number, number];
    gateZ: number;
    /** S-35: the slope's foot, the plaza, the broken lighthouse's top and the plaza's open east gate. */
    slopeEndZ: number;
    plaza: { center: [number, number, number]; radius: number };
    lighthouseTop: [number, number, number];
    eastGate: [number, number, number];
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

const BUDGET = { drawCalls: 300, triangles: 1_500_000 };

/** Mean luminance and share of near-black pixels of a PNG, decoded by the browser (as in S-04's e2e). */
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

/**
 * Walks (W, with Shift when `sprint`: 早歩き) toward a point on the ground, steering with the mouse, until within `within`
 * metres. The view is kept level with the feet (S-35: down the slope too).
 */
async function walkTo(
  page: Page,
  x: number,
  z: number,
  within = 0.3,
  timeout = 20_000,
  sprint = false,
): Promise<RoomProbe> {
  const end = Date.now() + timeout;
  await lookAt(page, [x, (await room(page)).position.y + 1.5, z]);
  await page.keyboard.down('KeyW');
  if (sprint) await page.keyboard.down('ShiftLeft');
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
    if (sprint) await page.keyboard.up('ShiftLeft');
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

  test(`S-06 prologue: dive → walk → dead end → peek → place → cross → drop → back → pick up → gate → slope → plaza [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(330_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-06'), { recursive: true });
    const errors = collectErrors(page);
    // every shot is also checked for a black screen (黒い画面を使わない)
    const shots: Record<string, { mean: number; dark: number }> = {};
    const snap = async (name: string): Promise<void> => {
      shots[name] = await luminance(page, await page.screenshot({ path: join(shotDir, `${name}.png`) }));
    };
    const navigated = Date.now();
    await page.goto(`/?scene=prologue-proto${webgl}`);

    // the loading screen is up at once: the room is built inside the loading, not before it
    await waitHome(page, 'true', 15_000);
    const loadingShownMs = Date.now() - navigated;
    await snap('loading');

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
    // walking while peeking: really half the speed (0.7 m/s) and a 6° narrower view
    await lookAt(page, [0, 1.4, -30]);
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.peekAmount > 0.999');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1200);
    const peekWalk = await room(page);
    await page.keyboard.up('KeyW');
    await page.mouse.up({ button: 'right' });
    expect(peekWalk.speed).toBeGreaterThan(0.6);
    expect(peekWalk.speed).toBeLessThan(0.8);
    expect(peekWalk.fov).toBeCloseTo(64, 1);
    await waitRoom(page, 'r.peekAmount === 0');
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

    // 覗く: a few steps back from the edge, looking across the gap (pitch −0.15, as in layout.test.ts), the
    // arched deck rises into the orb. Right button held; speed ×0.5 and FOV −6° blend in; the back image is drawn.
    const passes0 = stop.backPassFrames;
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(1400);
    await page.keyboard.up('KeyS');
    const back = await waitRoom(page, 'r.speed < 0.03');
    await look(page, -back.yaw, -0.15 - back.pitch);
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
    // back to the edge
    await lookAt(page, [0, 1.4, -30]);
    await pushUntilStopped(page, 'KeyW');

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
    await lookAt(page, [0, 0.7, farZ]);
    await page.waitForTimeout(200);
    await snap('materialized');

    // 置いている間は覗けない: the right button only makes the placed orb tremble
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.shaking === true', 3_000);
    await page.waitForTimeout(300);
    expect((await room(page)).peekAmount).toBe(0);
    await page.mouse.up({ button: 'right' });
    expect((await room(page)).events).toContain('shake:peek');

    // 橋の上では拾えない: step sideways onto the bridge, still facing the pedestal, press E
    await lookAt(page, pedestalOrb);
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

    // 罰がない (パズル設計 > 原則 3): back on solid ground the vidro comes back and the bridge goes away. Before the drop:
    // since S-34 the drop's light settles the bridge, so this is the last time it can go away.
    await walkTo(page, 0, edgeZ + 0.5, 0.3);
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand'", 3_000);
    // stepping toward the vanishing bridge right away never leaves the shore (落下死はない; parent review P1)
    await page.keyboard.down('KeyD');
    const pushed: RoomProbe[] = [];
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      pushed.push(await room(page));
      await page.waitForTimeout(50);
    }
    await page.keyboard.up('KeyD');
    expect(pushed.length).toBeGreaterThan(10);
    for (const q of pushed) {
      expect(q.grounded).toBe(true);
      expect(Math.abs(q.position.y)).toBeLessThan(0.05);
      expect(q.position.z).toBeGreaterThan(edgeZ - 0.05);
    }
    const restored = await waitRoom(page, 'r.bridgeColliders === 0 && r.sphereRadius === 0', 3_000);
    expect(restored.events).toContain('pickup:pedestal');
    expect(restored.finale.settledSegments).toBe(0);
    // and placed again, for the crossing
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, 'r.sphereRadius > 3.99 && r.bridgeColliders === r.bridgeSegments', 5_000);

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
    // the drop flies into the vidro on the pedestal: look where it goes
    await lookAt(page, [pedestalOrb[0], pedestalOrb[1] + 0.4, pedestalOrb[2]]);
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

    // S-34: the drop's light settles the bridge and the gate opens (発案者 2026-10-22)
    const closed = await waitRoom(
      page,
      'r.finale.settle === 1 && r.finale.gate === 1 && r.finale.gateOpen',
      6_000,
    );
    expect(closed.finale.settledSegments).toBe(closed.bridgeSegments);
    // 橋を戻る → 玉を拾う: on the settled bridge the vidro comes (the exception to 橋の上では拾えない)
    await walkTo(page, 0.1, edgeZ - 0.8, 0.3);
    await waitRoom(page, 'r.speed < 0.03');
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const inHand = await waitRoom(page, "r.orb === 'hand'", 3_000);
    expect(inHand.position.z).toBeLessThan(edgeZ);
    const kept = await waitRoom(page, 'r.sphereRadius === 0', 3_000);
    expect(kept.bridgeColliders).toBe(kept.bridgeSegments);
    expect(kept.grounded).toBe(true);
    // 門をくぐる: back over the bridge with the vidro in hand, through the open gate (its film lets the vidro's bearer by)
    await walkTo(page, 0.2, farZ - 0.8, 0.3);
    const through = await walkTo(page, 0, closed.layout.gateZ - 1.6, 0.3);
    expect(through.position.z).toBeLessThan(closed.layout.gateZ - 1);
    expect(through.grounded).toBe(true);
    await snap('through-gate');
    // S-35: down the slope (早歩き) to the central plaza, the broken lighthouse ahead, then across it to the open east gate
    const { slopeEndZ, plaza, lighthouseTop, eastGate } = closed.layout;
    const foot = await walkTo(page, 0, slopeEndZ - 1.5, 0.5, 90_000, true);
    expect(foot.grounded).toBe(true);
    expect(foot.position.y).toBeCloseTo(plaza.center[1], 1);
    await lookAt(page, lighthouseTop);
    await page.waitForTimeout(200);
    await snap('plaza-lighthouse');
    // the gate's front: a few metres in from the rim, toward the plaza's centre
    const toCentre = [plaza.center[0] - eastGate[0], plaza.center[2] - eastGate[2]];
    const len = Math.hypot(toCentre[0] ?? 0, toCentre[1] ?? 0);
    const front: [number, number] = [
      eastGate[0] + ((toCentre[0] ?? 0) / len) * 3,
      eastGate[2] + ((toCentre[1] ?? 0) / len) * 3,
    ];
    const atGate = await walkTo(page, front[0], front[1], 0.4, 60_000);
    expect(atGate.grounded).toBe(true);
    expect(Math.hypot(atGate.position.x - eastGate[0], atGate.position.z - eastGate[2])).toBeLessThan(3.6);
    await lookAt(page, [eastGate[0], eastGate[1] + 2, eastGate[2]]);
    await page.waitForTimeout(200);
    await snap('east-gate');
    const end = await room(page);
    expect(end.events).toEqual(
      expect.arrayContaining(['pickup:bench', 'place', 'dropTaken', 'pickup:pedestal']),
    );
    expect(end.dropTaken).toBe(true);

    writeFileSync(
      join(root, `artifacts/S-06/run-${backend}.json`),
      JSON.stringify({ backend, loadingShownMs, shots, final: await room(page), errors }, null, 2),
    );
    expect((await room(page)).fallRescues, 'the fall guard never had to act').toBe(0);
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(l.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-06 key frames in the middle of the transitions (held) [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    // ?peekHold / ?growHold freeze the peek and a placed orb's growth, so the frame is exactly mid-way
    const frames: [string, string, (r: RoomProbe) => void][] = [
      [
        'hold-peek-0.5',
        'spawn=dead-end&peekHold=0.5',
        (r) => {
          expect(r.peekAmount).toBe(0.5);
          expect(r.fov).toBeCloseTo(67, 1);
        },
      ],
      ['hold-peek-1.0', 'spawn=dead-end&peekHold=1', (r) => expect(r.fov).toBeCloseTo(64, 1)],
      [
        'hold-grow-0.35',
        'spawn=dead-end&growHold=0.35',
        (r) => {
          expect(r.sphereRadius).toBeGreaterThan(0.5);
          expect(r.sphereRadius).toBeLessThan(3.5);
        },
      ],
      [
        'hold-grow-1.0',
        'spawn=dead-end&growHold=1',
        (r) => {
          expect(r.sphereRadius).toBeCloseTo(4, 3);
          expect(r.bridgeColliders).toBe(r.bridgeSegments);
        },
      ],
      ['hold-far', 'spawn=far&growHold=1', (r) => expect(r.position.z).toBeLessThan(r.layout.farZ)],
    ];
    for (const [name, q, check] of frames) {
      await page.goto(`/?scene=prologue-proto&${q}${webgl}`);
      await waitRoom(page, 'r.ready === true', 60_000);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(shotDir, `${name}.png`) });
      const r = await room(page);
      check(r);
      expect(r.drawCalls, `draw calls in ${name}`).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(r.triangles, `triangles in ${name}`).toBeLessThanOrEqual(BUDGET.triangles);
    }

    // 見えない柵 with real input: half-grown sphere, walk onto the bridge along its right side and keep pushing
    await page.goto(`/?scene=prologue-proto&spawn=dead-end&growHold=0.45${webgl}`);
    const start = await waitRoom(page, 'r.ready === true', 60_000);
    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    await lookAt(page, [start.position.x, 1.4, -40]);
    const push = await pushUntilStopped(page, 'KeyW', 10_000);
    const end = push.at(-1) as RoomProbe;
    // look down at the deck ahead: the cut and the boundary film the body stopped at
    await lookAt(page, [end.position.x, 0, end.position.z - 1.4]);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shotDir, 'fence.png') });
    const [cx, cy, cz] = end.layout.pedestalOrb;
    const inside = (r: RoomProbe) =>
      Math.hypot(r.position.x - cx, r.position.y - cy, r.position.z - cz) <= r.sphereRadius + 0.01;
    expect(end.position.z).toBeLessThan(end.layout.edgeZ - 0.2);
    expect(push.every((r) => r.grounded && r.position.y > -0.03 && r.position.y < 0.45)).toBe(true);
    expect(push.filter((r) => r.onBackFooting).every(inside)).toBe(true);
    expect(end.speed).toBeLessThan(0.05);
    expect((await room(page)).fallRescues, 'the fall guard never had to act').toBe(0);

    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-06 ?autoplay=1 plays home → dive → the drop → through the gate → down to the plaza's east gate by script [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&autoplay=1${webgl}`);
    await waitHome(page, "p.screen === 'game' && p.transition === null", 90_000);
    const done = await waitRoom(page, 'r.autoplay && r.autoplay.done && r.dropTaken', 200_000);
    expect(done.events).toEqual(
      expect.arrayContaining(['pickup:bench', 'peekStart', 'peekEnd', 'place', 'dropTouched', 'dropTaken']),
    );
    expect(done.position.z).toBeLessThan(done.layout.farZ);
    // S-34: the script goes on: back over the settled bridge, the vidro picked up on it, through the open gate
    expect(done.events).toContain('pickup:pedestal');
    expect(done.events).not.toContain('shake:pickup');
    expect(done.orb).toBe('hand');
    expect(done.finale.gateOpen).toBe(true);
    expect(done.bridgeColliders).toBe(done.bridgeSegments);
    expect(done.position.z).toBeLessThan(done.layout.gateZ - 1);
    // S-35: on down the slope and across the plaza, to the front of its open east gate
    const { eastGate, plaza } = done.layout;
    expect(Math.hypot(done.position.x - eastGate[0], done.position.z - eastGate[2])).toBeLessThan(3.6);
    expect(done.position.y).toBeCloseTo(plaza.center[1], 1);
    expect(done.grounded).toBe(true);
    expect(done.fallRescues, 'the fall guard never had to act').toBe(0);
    // every phase in budget (the frame's all passes), and no compile stall in a transition or in play
    const phases = await page.evaluate(
      () =>
        (
          window.__vidro.sceneProbe as {
            phases: Record<
              string,
              { frames: number; maxFrameMs: number; maxDrawCalls: number; maxTriangles: number }
            >;
          }
        ).phases,
    );
    mkdirSync(join(root, 'artifacts/S-06'), { recursive: true });
    // S-34 review: where in the script the longest frames of the play fall (the room times its own frames by step)
    const steps = done.autoplay;
    writeFileSync(
      join(root, `artifacts/S-06/phases-${backend}.json`),
      JSON.stringify({ ...phases, gameSteps: steps }, null, 2),
    );
    for (const [phase, st] of Object.entries(phases)) {
      expect(st.maxDrawCalls, `draw calls in ${phase}`).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(st.maxTriangles, `triangles in ${phase}`).toBeLessThanOrEqual(BUDGET.triangles);
    }
    // 200 ms as in S-04: headless jitter and other sessions sharing the GPU, but a compile stall shows
    for (const phase of ['loading-home', 'home', 'home-game', 'game'])
      expect(phases[phase]?.maxFrameMs ?? 0, `worst frame in ${phase}`).toBeLessThan(200);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
