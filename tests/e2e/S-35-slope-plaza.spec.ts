import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-35: the slope down from the gate and the central plaza (進行構造とエリア設計 > 街の配置と序章の締め), on both render paths.
 *  1. the three views the slice is judged by, held after the close with the vidro in hand: from the slope's brow down to
 *     the plaza and the broken lighthouse, up at the lighthouse from the plaza, at the open east gate — state, pictures,
 *     and the draw calls and triangles all round (a full turn at the slope's top and near the plaza's centre)
 *  2. 玉の置き忘れ (発案者 2026-10-23) with real input: the vidro left on its pedestal, the film in the gate's arch holds you
 *     softly before the slope, and the vidro glows faintly (seen on the screen: its spot is brighter than once it has
 *     fallen quiet); back over the bridge, the vidro picked up, the film lets you by and the slope goes down under your feet
 * The walk all the way down to the east gate is S-06's play-through (real input and autoplay).
 * Screens → artifacts/screens/S-35/<backend>/, the runs → artifacts/S-35/.
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
type P3 = [number, number, number];
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
  target: 'bench' | 'pedestal' | 'drop' | null;
  dropTaken: boolean;
  events: string[];
  lastAction: string | null;
  drawCalls: number;
  triangles: number;
  fallRescues: number;
  finale: { settle: number; gate: number; settledSegments: number; gateOpen: boolean };
  membrane: { holding: boolean; film: number; call: number };
  layout: {
    edgeZ: number;
    farZ: number;
    pedestalOrb: P3;
    gateZ: number;
    roadEndZ: number;
    membraneZ: number;
    slopeEndZ: number;
    plaza: { center: P3; radius: number };
    lighthouseTop: P3;
    eastGate: P3;
    eastRoadEndX: number;
  };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
/** S-03 mouse sensitivity (rad per pixel). */
const SENSITIVITY = 0.0022;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };

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

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Mean luminance and the shares of near-black and near-white pixels of a PNG, in a region (the whole page by default). */
async function luminance(
  page: Page,
  png: Buffer,
  region?: Region,
): Promise<{ mean: number; dark: number; white: number }> {
  return page.evaluate(
    async ([b64, reg]) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const r = (reg as Region | null) ?? { x0: 0, y0: 0, x1: bmp.width, y1: bmp.height };
      let sum = 0;
      let dark = 0;
      let white = 0;
      let n = 0;
      for (let y = r.y0; y < r.y1; y += 2)
        for (let x = r.x0; x < r.x1; x += 2) {
          const i = (y * bmp.width + x) * 4;
          const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
          sum += l;
          if (l < 0.06) dark++;
          if (l > 0.94) white++;
          n++;
        }
      return { mean: sum / n, dark: dark / n, white: white / n };
    },
    [png.toString('base64'), region ?? null] as const,
  );
}

/** World points on the screen (the room's camera from its probe; three's frame), clipped to the page: their box. */
function screenBox(r: RoomProbe, points: P3[]): Region {
  const W = 1280;
  const H = 720;
  const e = [r.position.x, r.position.y + r.eyeHeight, r.position.z];
  const cp = Math.cos(r.pitch);
  const f = [-Math.sin(r.yaw) * cp, Math.sin(r.pitch), -Math.cos(r.yaw) * cp];
  const right = [Math.cos(r.yaw), 0, -Math.sin(r.yaw)];
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

/** Share of the pixels in `region` that are brighter in `a` than in `b` by more than 0.03 of luminance (same view). */
async function brightenedShare(page: Page, a: Buffer, b: Buffer, region: Region): Promise<number> {
  return page.evaluate(
    async ([a64, b64, reg]) => {
      const pixels = async (src: string) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${src}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { w: bmp.width, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const A = await pixels(a64 as string);
      const B = await pixels(b64 as string);
      const r = reg as Region;
      const lum = (d: Uint8ClampedArray, i: number) =>
        (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      let n = 0;
      let up = 0;
      for (let y = r.y0; y < r.y1; y += 2)
        for (let x = r.x0; x < r.x1; x += 2) {
          const i = (y * A.w + x) * 4;
          n++;
          if (lum(A.d, i) - lum(B.d, i) > 0.03) up++;
        }
      return n > 0 ? up / n : 0;
    },
    [a.toString('base64'), b.toString('base64'), region] as const,
  );
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
async function lookAt(page: Page, p: P3): Promise<void> {
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

/** Walks (W) toward a point on the ground, steering with the mouse, the view level with the feet; every sample kept. */
async function walkTo(
  page: Page,
  x: number,
  z: number,
  within = 0.3,
  timeout = 20_000,
): Promise<{ end: RoomProbe; way: RoomProbe[] }> {
  const end = Date.now() + timeout;
  const way: RoomProbe[] = [];
  await lookAt(page, [x, (await room(page)).position.y + 1.5, z]);
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

async function lock(page: Page): Promise<void> {
  cursor.x = 640;
  cursor.y = 360;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.up();
  await waitRoom(page, 'r.locked === true');
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-35', backend);

  test(`S-35 the three views: down the slope to the plaza, up at the lighthouse, at the east gate; the budget all round [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-35'), { recursive: true });
    const errors = collectErrors(page);
    const shots: Record<string, { mean: number; dark: number; white: number }> = {};
    const budget: Record<string, { drawCalls: number; triangles: number }> = {};
    // after the close (the gate open), the vidro back in hand: as you would stand there
    const after = 'finaleHold=4.5&finaleOrb=hand';
    const frames: [string, string, (r: RoomProbe) => void][] = [
      [
        // 坂の入口から広場を見下ろす: the slope going down ahead, the plaza and the broken lighthouse below, エリア1's chimney left
        'slope-down',
        `spawn=slope&${after}`,
        (r) => {
          expect(r.position.z).toBeLessThan(r.layout.gateZ);
          expect(r.position.z).toBeGreaterThan(r.layout.roadEndZ);
          expect(r.layout.plaza.center[1]).toBeLessThan(r.position.y - 8);
        },
      ],
      [
        // 広場から灯塔を見上げる
        'plaza-lighthouse',
        `spawn=plaza&${after}`,
        (r) => {
          expect(r.position.y).toBeCloseTo(r.layout.plaza.center[1], 1);
          expect(r.pitch).toBeGreaterThan(0.3);
        },
      ],
      [
        // 広場から東の門を見る: the open gate, its few metres of road and railing, the chimney's hill beyond
        'plaza-east',
        `spawn=east&${after}`,
        (r) => {
          expect(r.position.y).toBeCloseTo(r.layout.plaza.center[1], 1);
        },
      ],
    ];
    for (const [name, q, check] of frames) {
      await page.goto(`/?scene=prologue-proto&${q}${webgl}`);
      const r0 = await waitRoom(page, "r.ready === true && r.orb === 'hand'", 60_000);
      expect(r0.finale.gateOpen).toBe(true);
      // the view taken (the controls' hint goes once the mouse is), as it was placed
      await lock(page);
      await page.waitForTimeout(800);
      const png = await page.screenshot({ path: join(shotDir, `${name}.png`) });
      shots[name] = await luminance(page, png);
      const r = await room(page);
      check(r);
      expect(r.grounded).toBe(true);
      expect(r.fallRescues).toBe(0);
      expect(r.membrane.film).toBe(0);
      budget[name] = { drawCalls: r.drawCalls, triangles: r.triangles };
    }
    // the budget all round: a full turn at the slope's top and near the plaza's centre (8 headings each)
    for (const [where, spawn] of [
      ['slope', 'slope'],
      ['plaza', 'east'],
    ] as const) {
      await page.goto(`/?scene=prologue-proto&spawn=${spawn}&${after}${webgl}`);
      await waitRoom(page, 'r.ready === true', 60_000);
      await lock(page);
      for (let i = 0; i < 8; i++) {
        if (i > 0) await look(page, Math.PI / 4, 0);
        await page.waitForTimeout(250);
        const r = await room(page);
        budget[`${where}-turn-${i}`] = { drawCalls: r.drawCalls, triangles: r.triangles };
      }
    }
    writeFileSync(
      join(root, `artifacts/S-35/views-${backend}.json`),
      JSON.stringify({ backend, shots, budget, errors }, null, 2),
    );
    for (const [name, b] of Object.entries(budget)) {
      expect(b.drawCalls, `draw calls in ${name}`).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(b.triangles, `triangles in ${name}`).toBeLessThanOrEqual(BUDGET.triangles);
      expect(b.drawCalls, `something drawn in ${name}`).toBeGreaterThan(10);
    }
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(l.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
      expect(l.white, `near-white share in ${name}`).toBeLessThan(0.08);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-35 the vidro left behind: the film in the gate holds you softly and the vidro calls; with it in hand, down the slope [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-35'), { recursive: true });
    const errors = collectErrors(page);
    const shots: Record<string, { mean: number; dark: number; white: number }> = {};
    // the close played out (the gate open), the vidro left on the pedestal: standing on the far shore before the gate
    await page.goto(`/?scene=prologue-proto&spawn=gate&finaleHold=4.5${webgl}`);
    // (the film comes up over half a second once the vidro has left the hand)
    const start = await waitRoom(
      page,
      "r.ready && r.playing && r.orb === 'pedestal' && r.membrane.film === 1",
      60_000,
    );
    const { membraneZ, pedestalOrb, edgeZ, farZ, roadEndZ } = start.layout;
    expect(start.finale.gateOpen).toBe(true);
    expect(start.membrane.film).toBe(1);
    expect(start.membrane.holding).toBe(true);
    expect(start.membrane.call).toBe(0);
    await lock(page);
    await lookAt(page, [0, 1.3, membraneZ]);
    await page.waitForTimeout(200);
    const filmPng = await page.screenshot({ path: join(shotDir, 'film.png') });
    shots.film = await luminance(page, filmPng);

    // walk at the slope: the film eases you to a stop before it, on the shore's side, on the stone (やわらかく止まる)
    await lookAt(page, [0, 1.4, membraneZ - 30]);
    const push = await pushUntilStopped(page, 'KeyW');
    const stop = push.at(-1) as RoomProbe;
    expect(push.length).toBeGreaterThan(10);
    for (const q of push) {
      expect(q.grounded).toBe(true);
      expect(Math.abs(q.position.y)).toBeLessThan(0.03);
      expect(q.position.z).toBeGreaterThan(membraneZ);
    }
    expect(stop.position.z).toBeLessThan(membraneZ + 0.6);
    expect(stop.membrane.holding).toBe(true);
    // そのとき台座の玉がかすかに光って知らせる: pushing on at the film, the vidro calls. Look back at it and push on backwards
    // (S: the film behind you): it glows; let go where you stand and it falls quiet — the same view, the same spot
    await lookAt(page, pedestalOrb);
    await page.waitForTimeout(200);
    await page.keyboard.down('KeyS');
    const calling = await waitRoom(page, 'r.membrane.call > 0.95', 3_000);
    expect(calling.orb).toBe('pedestal');
    expect(calling.position.z).toBeGreaterThan(membraneZ);
    await page.waitForTimeout(200);
    const callR = await room(page);
    const callPng = await page.screenshot({ path: join(shotDir, 'call.png') });
    await page.keyboard.up('KeyS');
    shots.call = await luminance(page, callPng);
    const quietR = await waitRoom(page, 'r.membrane.call === 0', 5_000);
    await page.waitForTimeout(200);
    const quietPng = await page.screenshot({ path: join(shotDir, 'quiet.png') });
    shots.quiet = await luminance(page, quietPng);
    expect(Math.abs(quietR.position.z - callR.position.z)).toBeLessThan(0.08);
    expect(quietR.membrane.holding).toBe(true);
    // the vidro's sphere on the screen (its film, and the seams where it cuts the bridge and the stone): brighter while
    // it calls — seen from the gate even where the bridge's glass stands in front of the vidro itself
    const [ox, oy, oz] = pedestalOrb;
    const R = 4;
    const sphereBox = screenBox(callR, [
      [ox - R, oy - R, oz],
      [ox + R, oy + R, oz],
      [ox, oy + R, oz - R],
      [ox, oy - R, oz + R],
    ]);
    expect(sphereBox.x1 - sphereBox.x0).toBeGreaterThan(200);
    const brighter = await brightenedShare(page, callPng, quietPng, sphereBox);
    const darker = await brightenedShare(page, quietPng, callPng, sphereBox);
    // (the body may settle a few centimetres when you let go: some edges shift either way, so it is weighed against that)
    expect(brighter, 'share of the vidro’s sphere brighter while it calls').toBeGreaterThan(0.03);
    expect(brighter, 'brighter, not merely shifted').toBeGreaterThan(darker * 3);

    // back over the settled bridge, the vidro picked up on it: the film goes, and lets you through
    await walkTo(page, 0.1, edgeZ - 0.8, 0.3);
    await waitRoom(page, 'r.speed < 0.03');
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand' && r.membrane.film === 0", 3_000);
    await walkTo(page, 0.2, farZ - 0.8, 0.3);
    const through = await walkTo(page, 0, roadEndZ - 4, 0.3);
    expect(through.end.membrane.holding).toBe(false);
    expect(through.way.every((q) => q.grounded)).toBe(true);
    expect(through.end.position.z).toBeLessThan(membraneZ - 3);
    // and the slope goes down under the feet
    expect(through.end.position.y).toBeLessThan(-0.05);
    const final = await room(page);
    writeFileSync(
      join(root, `artifacts/S-35/film-${backend}.json`),
      JSON.stringify({ backend, stop: stop.position, brighter, darker, shots, final, errors }, null, 2),
    );
    expect(final.fallRescues).toBe(0);
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(l.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
      expect(l.white, `near-white share in ${name}`).toBeLessThan(0.08);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
