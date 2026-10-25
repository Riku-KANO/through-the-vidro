import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-34: the close of the prologue (発案者 2026-10-22: 雫の光で裏の橋が表に定着し、向こう岸の門が開く), on both render paths.
 *  1. held frames (?finaleHold=<seconds since the drop was taken>): the light half way across the bridge, the gate shut,
 *     half open and open, the road past it — state, budget and pictures
 *  2. with the vidro taken back after the close, the settled bridge is still drawn (見えることのセンサー)
 *  3. real input from the dead end: place → cross → touch the drop → the light settles the bridge (timed: 1–2 s), and when
 *     it has reached the far shore the gate opens (発案者 2026-10-23; timed) → back over the bridge → pick the vidro up ON
 *     the bridge (the exception to 裏の足場の上では拾えない) → the bridge stays, colliders and all → across again, through
 *     the gate onto the road and over the slope's brow (S-35: the railing at the road's end is gone; the slope goes on down
 *     to the plaza, S-35's spec). The close's two sounds are played (sound.finale), apart from the S-16 cues.
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
  fov: number;
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
    /** S-35: the film in the gate's arch, the broken lighthouse's top. */
    membraneZ: number;
    lighthouseTop: [number, number, number];
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

/** A box on the screen (CSS pixels of the 1280×720 page). */
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * World points on the screen, from the room's camera as its probe tells it (eye at the feet + eye height, yaw, pitch,
 * vertical FOV; three's frame: yaw 0 looks down -Z), clipped to the page: their bounding box.
 */
function screenBox(r: RoomProbe, points: [number, number, number][]): Region {
  const W = 1280;
  const H = 720;
  const e = [r.position.x, r.position.y + r.eyeHeight, r.position.z];
  const cp = Math.cos(r.pitch);
  const f = [-Math.sin(r.yaw) * cp, Math.sin(r.pitch), -Math.cos(r.yaw) * cp];
  const right = [Math.cos(r.yaw), 0, -Math.sin(r.yaw)];
  // up = right × forward
  const up = [
    (right[1] ?? 0) * (f[2] ?? 0) - (right[2] ?? 0) * (f[1] ?? 0),
    (right[2] ?? 0) * (f[0] ?? 0) - (right[0] ?? 0) * (f[2] ?? 0),
    (right[0] ?? 0) * (f[1] ?? 0) - (right[1] ?? 0) * (f[0] ?? 0),
  ];
  const t = Math.tan((r.fov * Math.PI) / 180 / 2);
  const dot = (a: number[], b: number[]) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  let x0 = W;
  let y0 = H;
  let x1 = 0;
  let y1 = 0;
  for (const p of points) {
    const d = [p[0] - (e[0] ?? 0), p[1] - (e[1] ?? 0), p[2] - (e[2] ?? 0)];
    const depth = dot(d, f);
    if (depth <= 0.05) continue;
    const sx = (dot(d, right) / depth / (t * (W / H)) / 2 + 0.5) * W;
    const sy = (0.5 - dot(d, up) / depth / t / 2) * H;
    x0 = Math.min(x0, sx);
    y0 = Math.min(y0, sy);
    x1 = Math.max(x1, sx);
    y1 = Math.max(y1, sy);
  }
  return {
    x0: Math.max(0, Math.floor(x0)),
    y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(W, Math.ceil(x1)),
    y1: Math.min(H, Math.ceil(y1)),
  };
}

/** Share of the pixels in `region` whose luminance differs by more than 0.06 between two PNGs of the same view. */
async function changedShare(page: Page, a: Buffer, b: Buffer, region: Region): Promise<number> {
  return page.evaluate(
    async ([a64, b64, reg]) => {
      const pixels = async (b: string) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { w: bmp.width, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const A = await pixels(a64 as string);
      const B = await pixels(b64 as string);
      const r = reg as { x0: number; y0: number; x1: number; y1: number };
      const lum = (d: Uint8ClampedArray, i: number) =>
        (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      let n = 0;
      let changed = 0;
      for (let y = r.y0; y < r.y1; y += 2)
        for (let x = r.x0; x < r.x1; x += 2) {
          const i = (y * A.w + x) * 4;
          n++;
          if (Math.abs(lum(A.d, i) - lum(B.d, i)) > 0.06) changed++;
        }
      return n > 0 ? changed / n : 0;
    },
    [a.toString('base64'), b.toString('base64'), region] as const,
  );
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
        'spawn=far&finaleHold=0.55',
        (r) => {
          expect(r.finale.settle).toBeGreaterThan(0.3);
          expect(r.finale.settle).toBeLessThan(0.4);
          expect(r.finale.settledSegments).toBeGreaterThan(0);
          expect(r.finale.settledSegments).toBeLessThan(r.bridgeSegments);
          expect(r.finale.frontZ).not.toBeNull();
          expect(r.finale.frontZ ?? 0).toBeLessThan(r.layout.edgeZ);
          expect(r.finale.frontZ ?? 0).toBeGreaterThan(r.layout.farZ);
          // the gate waits for the light to reach the far shore (発案者 2026-10-23)
          expect(r.finale.gate).toBe(0);
          expect(r.finale.gateDeg).toBe(0);
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
        // the light reached the far shore 1.6 s after the drop was taken; the gate 1.3 s into its opening
        'spawn=gate&finaleHold=2.9',
        (r) => {
          expect(r.finale.gate).toBeGreaterThan(0.4);
          expect(r.finale.gate).toBeLessThan(0.6);
          expect(r.finale.gateDeg).toBeGreaterThan(10);
          expect(r.finale.gateDeg).toBeLessThan(85);
        },
      ],
      [
        'gate-open',
        'spawn=gate&finaleHold=4.5',
        (r) => {
          expect(r.finale.gate).toBe(1);
          expect(r.finale.gateOpen).toBe(true);
          expect(r.finale.gateDeg).toBeGreaterThan(85);
        },
      ],
      [
        // past the gate: the road, the slope going down from its brow to the plaza and the lighthouse (門の先の道, S-35)
        'road',
        'spawn=road&finaleHold=4.5',
        (r) => {
          expect(r.position.z).toBeLessThan(r.layout.gateZ);
          expect(r.position.z).toBeGreaterThan(r.layout.roadEndZ);
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

  test(`S-34 with the vidro back in hand, the settled bridge is still drawn where it collides (見えることのセンサー) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    // the same view from the far shore, looking back over the gap: before the drop with the vidro in hand (no sphere, so
    // no bridge), and after the close with the vidro taken back (no sphere either: what is drawn is what the light fixed)
    await page.goto(`/?scene=prologue-proto&spawn=far${webgl}`);
    await waitRoom(page, 'r.ready === true', 60_000);
    await page.waitForTimeout(800);
    const before = await page.screenshot({ path: join(shotDir, 'no-bridge.png') });
    await page.goto(`/?scene=prologue-proto&spawn=far&finaleHold=3&finaleOrb=hand${webgl}`);
    const after = await waitRoom(page, "r.ready && r.orb === 'hand' && r.sphereRadius === 0", 60_000);
    await page.waitForTimeout(800);
    const settled = await page.screenshot({ path: join(shotDir, 'settled-no-orb.png') });
    expect(after.bridgeColliders).toBe(after.bridgeSegments);
    expect(after.finale.settledSegments).toBe(after.bridgeSegments);
    // the bridge's deck and rails on the screen: they must show (a missing bridge would leave this as it was before)
    const { edgeZ, farZ } = after.layout;
    const corners: [number, number, number][] = [];
    for (const x of [-0.6, 0.6])
      for (const y of [0, 0.9]) for (const z of [edgeZ - 0.1, farZ + 0.1]) corners.push([x, y, z]);
    const bridge = screenBox(after, corners);
    expect(bridge.x1 - bridge.x0).toBeGreaterThan(100);
    const shown = await changedShare(page, before, settled, bridge);
    // and nothing else moved: the sky above the town, off to the left
    const sky = await changedShare(page, before, settled, { x0: 0, y0: 0, x1: 320, y1: 160 });
    mkdirSync(join(root, 'artifacts/S-34'), { recursive: true });
    writeFileSync(
      join(root, `artifacts/S-34/visible-${backend}.json`),
      JSON.stringify({ backend, bridge, shown, sky }, null, 2),
    );
    expect(shown, 'share of the bridge’s screen box that changed').toBeGreaterThan(0.3);
    expect(sky, 'share of the sky that changed').toBeLessThan(0.02);
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
    const { edgeZ, farZ, pedestalOrb, drop, gateZ, roadEndZ, lighthouseTop } = start.layout;

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

    // 定着: the light crosses the bridge in 1–2 s, segment by segment; the gate stays shut while it does
    const mid = await waitRoom(page, 'r.finale.settle > 0.3', 3_000);
    expect(mid.finale.settledSegments).toBeLessThan(mid.bridgeSegments);
    expect(mid.finale.gate).toBe(0);
    await snap('settle-live');
    const settled = await waitRoom(page, 'r.finale.settle === 1', 5_000);
    const settleSeconds = settled.time - t0;
    expect(settleSeconds).toBeGreaterThanOrEqual(1.0);
    expect(settleSeconds).toBeLessThanOrEqual(2.1);
    expect(settled.finale.settledSegments).toBe(settled.bridgeSegments);
    // 発案者 2026-10-23: the gate starts to open when the light has reached the far shore (原則4: the reason is seen)
    const starting = await waitRoom(page, 'r.finale.gate > 0', 3_000);
    const gateStartsAt = starting.time - t0;
    expect(gateStartsAt).toBeGreaterThanOrEqual(settleSeconds - 0.1);
    expect(gateStartsAt).toBeLessThanOrEqual(settleSeconds + 0.3);
    const opened = await waitRoom(page, 'r.finale.gate === 1 && r.finale.gateOpen', 6_000);
    // in this order: the light starts, is across, the gate starts to open, is open
    expect(opened.finale.events).toEqual(FINALE_EVENTS);
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

    // 門をくぐる: across again with the vidro in hand, through the open gate, along the road and over the slope's brow
    const across = await walkTo(page, 0.2, farZ - 0.8, 0.3);
    for (const q of across.way) {
      expect(q.grounded, `on the way back over at z ${q.position.z.toFixed(2)}`).toBe(true);
      expect(q.position.y).toBeGreaterThan(-0.05);
    }
    const through = await walkTo(page, 0, gateZ - 1.6, 0.3);
    expect(through.end.position.z).toBeLessThan(gateZ - 1);
    expect(through.end.grounded).toBe(true);
    await snap('through-gate');
    // S-35: no railing at the road's end any more: on over the brow, the feet going down with the slope
    const brow = await walkTo(page, 0, roadEndZ - 3, 0.3);
    expect(brow.way.every((q) => q.grounded)).toBe(true);
    expect(brow.end.position.y).toBeLessThan(-0.02);
    await lookAt(page, lighthouseTop);
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
      JSON.stringify({ backend, settleSeconds, gateStartsAt, shots, final, sound: s, errors }, null, 2),
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
