import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-34: the close of the prologue (発案者 2026-10-22: 雫の光で裏の橋が表に定着し、向こう岸の門が開く), on both render paths.
 *  1. held frames (?finaleHold=<seconds since the drop was taken>): the light half way across the bridge, the gate shut,
 *     half open and open, the road past it — state, budget and pictures
 *  2. real input from the dead end: place → cross → touch the drop → the light settles the bridge (timed: 1–2 s) and the
 *     gate opens → back over the bridge → pick the vidro up ON the bridge (the exception to 裏の足場の上では拾えない) →
 *     the bridge stays, colliders and all → across again, through the gate, along the road to the lookout's railing.
 *     The close's two sounds are played (sound.finale), apart from the S-16 table of cues.
 * Screens → artifacts/screens/S-34/<backend>/, the run → artifacts/S-34/run-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface FinaleProbe {
  settle: number;
  gate: number;
  settledSegments: number;
  gateDeg: number;
  gateOpen: boolean;
  frontZ: number | null;
  events: string[];
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
  locked: boolean;
  orb: 'bench' | 'hand' | 'pedestal';
  sphereRadius: number;
  bridgeColliders: number;
  bridgeSegments: number;
  onBackFooting: boolean;
  shaking: boolean;
  target: 'bench' | 'pedestal' | 'drop' | null;
  drop: 'waiting' | 'flying' | 'taken';
  dropTaken: boolean;
  events: string[];
  lastAction: string | null;
  drawCalls: number;
  triangles: number;
  fallRescues: number;
  finale: FinaleProbe;
  layout: {
    edgeZ: number;
    farZ: number;
    pedestalOrb: [number, number, number];
    drop: [number, number, number];
    gateZ: number;
    roadEndZ: number;
    lookoutZ: number;
  };
}
interface SoundProbe {
  state: string;
  playedCount: number;
  voicesStarted: number;
  finale: {
    ready: boolean;
    played: { event: string; distance: number }[];
    refused: string[];
    voicesStarted: number;
  };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
/** S-03 mouse sensitivity (rad per pixel). */
const SENSITIVITY = 0.0022;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
/** The close's own events (session.ts FinaleEvent): never on the room's event log (S-16's table of sounds). */
const FINALE_EVENTS = ['settle', 'settled', 'gateOpen', 'gateOpened'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (/GPU stall|powerPreference/i.test(text)) return;
    if (m.type() === 'error' || m.type() === 'warning' || GPU_VALIDATION.test(text)) errors.push(text);
  });
  return errors;
}

/** Mean luminance, share of near-black and of near-white pixels of a PNG (黒い画面・画面全体を覆う演出は使わない). */
async function luminance(page: Page, png: Buffer): Promise<{ mean: number; dark: number; white: number }> {
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
    let white = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 5) {
      const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      sum += l;
      if (l < 0.06) dark++;
      if (l > 0.94) white++;
      n++;
    }
    return { mean: sum / n, dark: dark / n, white: white / n };
  }, png.toString('base64'));
}

const room = (page: Page): Promise<RoomProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { room: RoomProbe }).room);
const sound = (page: Page): Promise<SoundProbe> =>
  page.evaluate(() => {
    const s = (window.__vidro.sceneProbe as { sound: SoundProbe }).sound;
    return { state: s.state, playedCount: s.playedCount, voicesStarted: s.voicesStarted, finale: s.finale };
  });

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<RoomProbe> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return room(page);
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
    const dYaw = wrap(Math.atan2(-dx, -dz) - r.yaw);
    const dPitch = Math.atan2(dy, Math.hypot(dx, dz)) - r.pitch;
    if (Math.abs(dYaw) < 0.01 && Math.abs(dPitch) < 0.01) return;
    await look(page, dYaw, dPitch);
    await page.waitForTimeout(60);
  }
}

/** Walks (W) toward a point on the ground, steering with the mouse; every sample on the way is kept. */
async function walkTo(
  page: Page,
  x: number,
  z: number,
  within = 0.3,
  timeout = 20_000,
): Promise<{ end: RoomProbe; way: RoomProbe[] }> {
  const end = Date.now() + timeout;
  const way: RoomProbe[] = [];
  await lookAt(page, [x, 1.5, z]);
  await page.keyboard.down('KeyW');
  try {
    for (;;) {
      const r = await room(page);
      way.push(r);
      const d = Math.hypot(x - r.position.x, z - r.position.z);
      if (d < within) return { end: r, way };
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
async function pushUntilStopped(page: Page, key: string, limitMs = 10_000): Promise<RoomProbe[]> {
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
  const shotDir = join(root, 'artifacts/screens/S-34', backend);

  test(`S-34 held frames: the light across the bridge, the gate shut / half open / open, the road [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    const shots: Record<string, { mean: number; dark: number; white: number }> = {};
    const frames: [string, string, (r: RoomProbe) => void][] = [
      [
        // from the far shore looking back: the light half way over the bridge (定着の途中)
        'settle-mid',
        'spawn=far&finaleHold=0.75',
        (r) => {
          expect(r.finale.settle).toBeGreaterThan(0.4);
          expect(r.finale.settle).toBeLessThan(0.55);
          expect(r.finale.settledSegments).toBeGreaterThan(0);
          expect(r.finale.settledSegments).toBeLessThan(r.bridgeSegments);
          expect(r.finale.frontZ).not.toBeNull();
          expect(r.finale.frontZ ?? 0).toBeLessThan(r.layout.edgeZ);
          expect(r.finale.frontZ ?? 0).toBeGreaterThan(r.layout.farZ);
        },
      ],
      [
        'settle-after',
        'spawn=far&finaleHold=3',
        (r) => {
          expect(r.finale.settle).toBe(1);
          expect(r.finale.settledSegments).toBe(r.bridgeSegments);
          expect(r.bridgeColliders).toBe(r.bridgeSegments);
        },
      ],
      [
        'gate-shut',
        'spawn=gate',
        (r) => {
          expect(r.finale.gate).toBe(0);
          expect(r.finale.gateDeg).toBe(0);
          expect(r.finale.gateOpen).toBe(false);
        },
      ],
      [
        'gate-mid',
        'spawn=gate&finaleHold=1.3',
        (r) => {
          expect(r.finale.gate).toBeGreaterThan(0.4);
          expect(r.finale.gate).toBeLessThan(0.6);
          expect(r.finale.gateDeg).toBeGreaterThan(10);
          expect(r.finale.gateDeg).toBeLessThan(85);
        },
      ],
      [
        'gate-open',
        'spawn=gate&finaleHold=3',
        (r) => {
          expect(r.finale.gate).toBe(1);
          expect(r.finale.gateOpen).toBe(true);
          expect(r.finale.gateDeg).toBeGreaterThan(85);
        },
      ],
      [
        // past the gate: the short road, the lookout's railing and lamps, the mist and the town beyond (門の先の道)
        'road',
        'spawn=road&finaleHold=3',
        (r) => {
          expect(r.position.z).toBeLessThan(r.layout.gateZ);
          expect(r.position.z).toBeGreaterThan(r.layout.lookoutZ);
          expect(r.grounded).toBe(true);
        },
      ],
    ];
    for (const [name, q, check] of frames) {
      await page.goto(`/?scene=prologue-proto&${q}${webgl}`);
      await waitRoom(page, 'r.ready === true', 60_000);
      await page.waitForTimeout(800);
      const png = await page.screenshot({ path: join(shotDir, `${name}.png`) });
      shots[name] = await luminance(page, png);
      const r = await room(page);
      check(r);
      expect(r.drawCalls, `draw calls in ${name}`).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(r.triangles, `triangles in ${name}`).toBeLessThanOrEqual(BUDGET.triangles);
      expect(r.fallRescues).toBe(0);
    }
    mkdirSync(join(root, 'artifacts/S-34'), { recursive: true });
    writeFileSync(
      join(root, `artifacts/S-34/held-${backend}.json`),
      JSON.stringify({ backend, shots }, null, 2),
    );
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(l.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
      // the light crosses the bridge; it does not cover the screen
      expect(l.white, `near-white share in ${name}`).toBeLessThan(0.08);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-34 drop → the bridge settles, the gate opens → back over the bridge → pick up on it → through the gate [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-34'), { recursive: true });
    const errors = collectErrors(page);
    const shots: Record<string, { mean: number; dark: number; white: number }> = {};
    const snap = async (name: string): Promise<void> => {
      shots[name] = await luminance(page, await page.screenshot({ path: join(shotDir, `${name}.png`) }));
    };
    await page.goto(`/?scene=prologue-proto&direct=1&spawn=dead-end${webgl}`);
    const start = await waitRoom(page, 'r.ready && r.playing', 60_000);
    expect(start.orb).toBe('hand');
    expect(start.finale.settle).toBe(0);
    expect(start.finale.gateOpen).toBe(false);
    const { edgeZ, farZ, pedestalOrb, drop, gateZ, lookoutZ } = start.layout;

    // the first click locks the view (and, alone, starts the room's own audio: S-16)
    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');

    // 置く → 渡る → 雫
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, 'r.sphereRadius > 3.99 && r.bridgeColliders === r.bridgeSegments');
    await walkTo(page, 0, edgeZ - 1.4, 0.3);
    await walkTo(page, 0.45, farZ - 0.6, 0.3);
    await lookAt(page, drop);
    await waitRoom(page, "r.target === 'drop'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.drop === 'flying'", 3_000);
    // the drop flies back into the vidro: look after it, over the bridge
    await lookAt(page, [pedestalOrb[0], 0.9, pedestalOrb[2]]);
    const taken = await waitRoom(page, 'r.dropTaken === true', 5_000);
    const t0 = taken.time;

    // 定着: the light crosses the bridge in 1–2 s, segment by segment; the gate opens at the same time
    const mid = await waitRoom(page, 'r.finale.settle > 0.4', 3_000);
    expect(mid.finale.settledSegments).toBeLessThan(mid.bridgeSegments);
    expect(mid.finale.gate).toBeGreaterThan(0);
    await snap('settle-live');
    const settled = await waitRoom(page, 'r.finale.settle === 1', 5_000);
    const settleSeconds = settled.time - t0;
    expect(settleSeconds).toBeGreaterThanOrEqual(1.0);
    expect(settleSeconds).toBeLessThanOrEqual(2.1);
    expect(settled.finale.settledSegments).toBe(settled.bridgeSegments);
    const opened = await waitRoom(page, 'r.finale.gate === 1 && r.finale.gateOpen', 6_000);
    expect(opened.finale.events).toEqual(expect.arrayContaining(FINALE_EVENTS));
    for (const e of FINALE_EVENTS) expect(opened.events, `${e} on the room's log`).not.toContain(e);
    await lookAt(page, [0, 1.2, gateZ]);
    await page.waitForTimeout(200);
    await snap('gate-opened-live');

    // 橋を戻る: over the settled bridge toward the dead end, and on it, facing the pedestal, 拾う
    const back = await walkTo(page, 0.1, edgeZ - 0.8, 0.3);
    expect(back.end.grounded).toBe(true);
    expect(back.end.position.y).toBeGreaterThan(0.05);
    // the settled bridge is no longer footing that only the vidro holds
    expect(back.end.onBackFooting).toBe(false);
    await waitRoom(page, 'r.speed < 0.03');
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const picked = await waitRoom(page, "r.orb === 'hand'", 3_000);
    expect(picked.lastAction).toBe('pickup');
    expect(picked.events).toContain('pickup:pedestal');
    expect(picked.events).not.toContain('shake:pickup');
    // the vidro's sphere goes; the bridge stays, colliders and all (玉を拾っても橋は消えず、当たり判定も残る)
    const gone = await waitRoom(page, 'r.sphereRadius === 0', 3_000);
    expect(gone.bridgeColliders).toBe(gone.bridgeSegments);
    expect(gone.grounded).toBe(true);
    expect(gone.position.y).toBeGreaterThan(0.05);
    await lookAt(page, [0, 0.2, farZ - 1]);
    await page.waitForTimeout(300);
    await snap('bridge-stays');

    // 門をくぐる: across again with the vidro in hand, through the open gate, along the road to the railing
    const across = await walkTo(page, 0.2, farZ - 0.8, 0.3);
    for (const q of across.way) {
      expect(q.grounded, `on the way back over at z ${q.position.z.toFixed(2)}`).toBe(true);
      expect(q.position.y).toBeGreaterThan(-0.05);
    }
    const through = await walkTo(page, 0, gateZ - 1.6, 0.3);
    expect(through.end.position.z).toBeLessThan(gateZ - 1);
    expect(through.end.grounded).toBe(true);
    await snap('through-gate');
    await lookAt(page, [0, 1.4, lookoutZ - 30]);
    const push = await pushUntilStopped(page, 'KeyW');
    const stop = push.at(-1) as RoomProbe;
    expect(push.every((q) => q.grounded && Math.abs(q.position.y) < 0.03)).toBe(true);
    // the railing stops you (行き止まりの理由: 柵), the town beyond it
    expect(stop.position.z).toBeGreaterThan(lookoutZ);
    expect(stop.position.z).toBeLessThan(lookoutZ + 0.6);
    await lookAt(page, [3, 12, -82]);
    await page.waitForTimeout(200);
    await snap('lookout');
    // and back the way you came: the open gate, the bridge, the workshop
    await lookAt(page, [0, 1.0, edgeZ]);
    await page.waitForTimeout(200);
    await snap('look-back');

    // the close's sounds (direct mode: the first click started the audio), apart from the S-16 cues
    const s = await sound(page);
    const final = await room(page);
    writeFileSync(
      join(root, `artifacts/S-34/run-${backend}.json`),
      JSON.stringify({ backend, settleSeconds, shots, final, sound: s, errors }, null, 2),
    );
    expect(s.state).toBe('running');
    expect(s.finale.ready).toBe(true);
    expect(s.finale.played.map((p) => p.event)).toEqual(['settle', 'gateOpen']);
    expect(s.finale.refused).toEqual([]);
    expect(s.finale.voicesStarted).toBe(2);
    for (const p of s.finale.played) expect(p.distance, p.event).toBeLessThan(12);
    expect(s.voicesStarted).toBe(s.playedCount);

    expect(final.fallRescues, 'the fall guard never had to act').toBe(0);
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(l.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
      expect(l.white, `near-white share in ${name}`).toBeLessThan(0.08);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
