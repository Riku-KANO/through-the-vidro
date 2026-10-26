import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-40: エリア1's rooms 2 and 3 and the shortcut home, on both render paths.
 *  1. the views the slice is judged by: peeking in 部屋2 from A and from B, the summit's valley, the shortcut fixed by the light
 *     (its light running along the ridge and down the stairs, then fixed), and the budget all round (peeking in the courtyard
 *     and at the summit's edge)
 *  2. 部屋2 with real input: nothing placed, the balcony's face stops you; on A you climb the stair but the wall stands; on B
 *     through the wall to the drop; back down, the vidro comes from the floor
 *  3. 部屋3 with real input (部屋1・2's drops held taken): peek from the edge; on the south pedestal an empty roof; picked up; on
 *     the north one over its bridge to the drop — the third: the shortcut's light runs (its events); the vidro taken back on the
 *     fixed bridge; along the ridge and down the stairs, through where the gate was, into the entrance plaza
 *  4. 東を見たまま坂を下りる (S-36 判断待ち 1, 発案者 2026-10-26): from the workshop's slope brow, looking east toward the chimney the
 *     whole way down and along the road: エリア1 is added in view and comes out of the haze (its `appear` 0 → 1), its parts shown
 *     one at a time; the frames meanwhile (aim 50 ms)
 * Screens → artifacts/screens/S-40/<backend>/, the runs → artifacts/S-40/.
 */
test.use({ locale: 'ja-JP' });

type P3 = [number, number, number];
interface V3 {
  x: number;
  y: number;
  z: number;
}
interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
interface Box {
  min: P3;
  max: P3;
}
interface Area1Probe {
  state: 'waiting' | 'building' | 'compiling' | 'built' | 'warming' | 'ready';
  addedAt: number | null;
  readyAt: number | null;
  addedInView: boolean;
  worstMs: number;
  frameMs: number[];
  appear: number;
  shown: number;
  entries: number;
  walls: Record<string, { segments: number; off: number }>;
  footing: { segments: number; active: number; settled: number };
  next: number;
  next2: number;
  motes: number;
  shortcut: { settle: number; front: P3 | null; leg: number | null; events: string[] };
}
interface RoomProbe {
  ready: boolean;
  time: number;
  position: V3;
  grounded: boolean;
  speed: number;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  locked: boolean;
  peeking: boolean;
  peekAmount: number;
  orb: 'bench' | 'hand' | 'pedestal';
  pedestal: string | null;
  sphereRadius: number;
  shaking: boolean;
  target: 'bench' | 'pedestal' | 'drop' | null;
  targetId: string | null;
  events: string[];
  onBackFooting: boolean;
  backPassFrames: number;
  drawCalls: number;
  triangles: number;
  fallRescues: number;
  daylight: number;
  areas: Record<string, { drops: number; taken: number }>;
  area1: Area1Probe;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  layout: {
    area1: {
      plaza: { center: P3; radius: number };
      chimneyTop: P3;
      slope: { x: number; fromZ: number; landingFromZ: number; landingToZ: number; toZ: number };
      room2: {
        court: Rect;
        courtY: number;
        balcony: Rect & { y: number };
        stairs: { minX: number; maxX: number; footZ: number; topZ: number };
        pedestals: { a: P3; b: P3 };
        ids: { a: string; b: string; drop: string };
        wall: { min: P3; max: P3 };
        drop: P3;
      };
      room3: {
        terrace: Rect;
        summitY: number;
        edge: P3;
        bridges: { n: Box; s: Box };
        roofs: { n: Rect; s: Rect };
        pedestals: { n: P3; s: P3 };
        ids: { n: string; s: string; drop: string };
        drop: P3;
      };
      shortcut: { minX: number; maxX: number; topZ: number; footZ: number; gate: Box; seconds: number };
    };
    slopeEndZ: number;
  };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
/** S-03 mouse sensitivity (rad per pixel). */
const SENSITIVITY = 0.0022;
const BENIGN = /GPU stall|powerPreference/i;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
/** S-06's limit on a frame of play. */
const PLAY_FRAME_MS = 200;
/** The aim on the slope and the road while エリア1 is added (spine S-40: 目安 50 ms); asserted with headroom for a busy GPU. */
const ADD_FRAME_MS = 60;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (BENIGN.test(text)) return;
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

async function lookAt(page: Page, p: P3): Promise<void> {
  for (let i = 0; i < 5; i++) {
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

/** Walks (W, Shift when `sprint`) toward (x, z), steering with the mouse, the view level; each sample handed to `each`. */
async function walkTo(
  page: Page,
  x: number,
  z: number,
  opts: { within?: number; timeout?: number; sprint?: boolean; each?: (r: RoomProbe) => void } = {},
): Promise<RoomProbe> {
  const { within = 0.3, timeout = 30_000, sprint = false } = opts;
  const end = Date.now() + timeout;
  const r0 = await room(page);
  await lookAt(page, [x, r0.position.y + r0.eyeHeight, z]);
  await page.keyboard.down('KeyW');
  if (sprint) await page.keyboard.down('ShiftLeft');
  try {
    for (;;) {
      const r = await room(page);
      opts.each?.(r);
      if (Math.hypot(x - r.position.x, z - r.position.z) < within) return r;
      if (Date.now() > end)
        throw new Error(`walkTo(${x}, ${z}) did not arrive: at ${JSON.stringify(r.position)}`);
      const dYaw = wrap(Math.atan2(-(x - r.position.x), -(z - r.position.z)) - r.yaw);
      if (Math.abs(dYaw) > 0.05) await look(page, dYaw, 0);
      await page.waitForTimeout(40);
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

async function lock(page: Page): Promise<void> {
  cursor.x = 640;
  cursor.y = 360;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.up();
  await waitRoom(page, 'r.locked === true');
}

/** Presses E at what is looked at, once it is the target `kind` (and the given id, if any). */
async function use(page: Page, at: P3, kind: 'pedestal' | 'drop', id?: string): Promise<void> {
  await lookAt(page, at);
  await waitRoom(page, `r.target === '${kind}'${id ? ` && r.targetId === '${id}'` : ''}`, 5_000);
  await page.keyboard.press('KeyE');
}

/** Peeks (right mouse held) until full, a screenshot, back. Returns the probe while peeking. */
async function peekShot(page: Page, path: string): Promise<RoomProbe> {
  await page.mouse.down({ button: 'right' });
  await waitRoom(page, 'r.peekAmount > 0.999');
  await page.waitForTimeout(400);
  await page.screenshot({ path });
  const q = await room(page);
  await page.mouse.up({ button: 'right' });
  await waitRoom(page, 'r.peekAmount === 0');
  return q;
}

/** Mean luminance, near-black share and warm bright share of the page (a screenshot). */
async function measure(page: Page, png: Buffer): Promise<{ mean: number; dark: number; warm: number }> {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let sum = 0;
    let dark = 0;
    let warm = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 8) {
      const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      sum += l;
      if (l < 0.06) dark++;
      if (l > 0.75 && ((d[i] ?? 0) - (d[i + 2] ?? 0)) / 255 > 0.05) warm++;
      n++;
    }
    return { mean: sum / n, dark: dark / n, warm: warm / n };
  }, png.toString('base64'));
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-40', backend);

  test(`S-40 the views: peeking in the courtyard from A and B, the summit's valley, the shortcut fixed; the budget [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-40'), { recursive: true });
    const errors = collectErrors(page);
    const shots: Record<string, { mean: number; dark: number; warm: number }> = {};
    const budget: Record<string, { drawCalls: number; triangles: number }> = {};
    const shoot = async (name: string): Promise<void> => {
      const png = await page.screenshot({ path: join(shotDir, `${name}.png`) });
      shots[name] = await measure(page, png);
      const q = await room(page);
      budget[name] = { drawCalls: q.drawCalls, triangles: q.triangles };
    };
    // 部屋1's drop taken: the lamps light up the first flight to the courtyard's corner (次の部屋の方向)
    for (const [name, query] of [
      ['slope', 'spawn=area1-slope'],
      ['slope-next', 'spawn=area1-slope&area1Drop=taken'],
      ['court', 'spawn=area1-court'],
      ['summit', 'spawn=area1-summit'],
      ['shortcut-top', 'spawn=area1-shortcut'],
      ['shortcut-foot', 'spawn=area1-shortcut-foot'],
    ] as const) {
      await page.goto(`/?scene=prologue-proto&${query}${webgl}`);
      await waitRoom(page, "r.ready === true && r.area1.state === 'ready'", 90_000);
      if (name === 'slope-next') await waitRoom(page, 'r.area1.next >= 1', 10_000);
      await lock(page);
      await page.waitForTimeout(800);
      await shoot(name);
      expect((await room(page)).grounded, name).toBe(true);
    }
    // peeking in the courtyard: from before A and from before B, at where the drop hovers on the balcony
    for (const [name, spawn] of [
      ['court-peek-a', 'area1-court-a'],
      ['court-peek-b', 'area1-court-b'],
      ['edge-peek', 'area1-edge'],
    ] as const) {
      await page.goto(`/?scene=prologue-proto&spawn=${spawn}${webgl}`);
      await waitRoom(page, "r.ready === true && r.area1.state === 'ready' && r.orb === 'hand'", 90_000);
      await lock(page);
      // at the drop: on the balcony (部屋2), across the north bridge (部屋3: 雫へ続く方)
      const lay = (await room(page)).layout.area1;
      await lookAt(page, name === 'edge-peek' ? lay.room3.drop : lay.room2.drop);
      await page.waitForTimeout(500);
      const q = await peekShot(page, join(shotDir, `${name}.png`));
      expect(q.peeking).toBe(true);
      budget[name] = { drawCalls: q.drawCalls, triangles: q.triangles };
      // (S-40 review: what the peek costs depends on where it looks — toward the town (north-west) both the frame and the peek
      // image draw it; the same place peeking the other way, for the record)
      if (name !== 'edge-peek') {
        await lookAt(page, [q.position.x + 10, q.position.y + q.eyeHeight + 1, q.position.z - 2]);
        await page.waitForTimeout(300);
        const away = await peekShot(page, join(shotDir, `${name}-east.png`));
        budget[`${name}-east`] = { drawCalls: away.drawCalls, triangles: away.triangles };
      }
    }
    // the shortcut's light (エリア1's drops all taken, held): along the ridge, down the stairs, then fixed for good. At its
    // steady pace (8.5 m/s: session.ts steadyEase) it is on the ridge at 1.6 s, 5 m down the stairs at 3.4 s, 7 m from the
    // gate at 4.6 s
    for (const [name, spawn, seconds] of [
      ['shortcut-ridge', 'area1-summit', 1.6],
      ['shortcut-stairs', 'area1-shortcut', 3.4],
      ['shortcut-arrives', 'area1-shortcut-foot', 4.6],
      ['shortcut-fixed', 'area1-shortcut', 10],
      ['shortcut-fixed-foot', 'area1-shortcut-foot', 10],
    ] as const) {
      await page.goto(`/?scene=prologue-proto&spawn=${spawn}&shortcutHold=${seconds}${webgl}`);
      const r = await waitRoom(page, "r.ready === true && r.area1.state === 'ready'", 90_000);
      expect(r.areas.area1).toEqual({ drops: 3, taken: 3 });
      await lock(page);
      if (name === 'shortcut-ridge') await lookAt(page, [96, 0.4, -159.6]);
      await page.waitForTimeout(800);
      await shoot(name);
      const q = await room(page);
      if (seconds >= 10) {
        expect(q.area1.footing.settled, name).toBeGreaterThan(50);
        expect(q.area1.walls['area1-shortcut-gate']?.off, name).toBe(
          q.area1.walls['area1-shortcut-gate']?.segments,
        );
      } else expect(q.area1.shortcut.front, name).not.toBeNull();
    }
    writeFileSync(
      join(root, `artifacts/S-40/views-${backend}.json`),
      JSON.stringify({ backend, shots, budget, errors }, null, 2),
    );
    for (const [name, b] of Object.entries(budget)) {
      expect(b.drawCalls, `draw calls in ${name}`).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(b.triangles, `triangles in ${name}`).toBeLessThanOrEqual(BUDGET.triangles);
      expect(b.drawCalls, `something drawn in ${name}`).toBeGreaterThan(10);
    }
    // the lamps toward 部屋2 read as lights once 部屋1's drop is taken
    expect(shots['slope-next']?.warm ?? 0, 'the lit lamps toward 部屋2').toBeGreaterThan(
      (shots.slope?.warm ?? 0) + 0.0015,
    );
    // the shortcut's light reads as light where it runs (原則4: 解けた理由が光で見える): warm bright pixels on the stairs from
    // their top and coming down to the gate, against the same views once it is through
    expect(shots['shortcut-stairs']?.warm ?? 0, 'the light down the stairs').toBeGreaterThan(
      (shots['shortcut-fixed']?.warm ?? 0) + 0.001,
    );
    expect(shots['shortcut-arrives']?.warm ?? 0, 'the light coming to the gate').toBeGreaterThan(
      (shots['shortcut-fixed-foot']?.warm ?? 0) + 0.001,
    );
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(l.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-40 部屋2 with real input: the balcony's face, A climbs to the wall, B through it to the drop, the vidro back [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&spawn=area1-court${webgl}`);
    const r0 = await waitRoom(
      page,
      "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
      90_000,
    );
    const r2 = r0.layout.area1.room2;
    const wallId = 'area1-court-wall';
    const stairX = (r2.stairs.minX + r2.stairs.maxX) / 2;
    const below: [number, number] = [stairX, r2.stairs.footZ - 0.9];
    const onBalcony = (r: RoomProbe) => Math.abs(r.position.y - r2.balcony.y) < 0.1;
    await lock(page);
    // with nothing placed the stair is not there: the balcony's face stops you below it
    await walkTo(page, below[0], below[1], { within: 0.25 });
    await lookAt(page, [stairX, r2.courtY + 1.4, r2.balcony.maxZ + 6]);
    const stopped = (await pushUntilStopped(page, 'KeyW')).at(-1) as RoomProbe;
    expect(stopped.position.z).toBeLessThan(r2.balcony.minZ);
    expect(stopped.position.y).toBeCloseTo(r2.courtY, 1);
    // 両方から覗いて: A, then B, place on A — the stair comes, the wall stays
    await walkTo(page, r2.pedestals.a[0] - 0.2, r2.pedestals.a[2] - 1.1, { within: 0.25 });
    await use(page, r2.pedestals.a, 'pedestal', r2.ids.a);
    const onA = await waitRoom(page, 'r.sphereRadius > 3.99', 5_000);
    expect(onA.area1.walls[wallId]?.off).toBe(0);
    expect(onA.area1.footing.active).toBeGreaterThanOrEqual(7);
    await walkTo(page, below[0], below[1], { within: 0.25 });
    const up = await walkTo(page, stairX, r2.balcony.minZ + 0.6, { within: 0.25 });
    expect(onBalcony(up)).toBe(true);
    // west along the balcony: the wall stops you
    await lookAt(page, [r2.drop[0] - 3, r2.balcony.y + 1.4, r2.drop[2]]);
    const atWall = (await pushUntilStopped(page, 'KeyW')).at(-1) as RoomProbe;
    expect(atWall.position.x).toBeGreaterThan(r2.wall.max[0]);
    expect(onBalcony(atWall)).toBe(true);
    await lookAt(page, [r2.wall.min[0], r2.balcony.y + 1.2, r2.wall.min[2] + 0.4]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'court-a-wall.png') });
    // down the stair; the vidro comes from the floor
    await walkTo(page, stairX, r2.balcony.minZ + 0.6, { within: 0.25 });
    await walkTo(page, below[0], below[1], { within: 0.25 });
    await walkTo(page, r2.pedestals.a[0] - 0.2, r2.pedestals.a[2] - 1.1, { within: 0.25 });
    await use(page, r2.pedestals.a, 'pedestal', r2.ids.a);
    await waitRoom(page, "r.orb === 'hand' && r.sphereRadius === 0", 5_000);
    // on B: the stair and the wall, the drop
    await walkTo(page, r2.pedestals.b[0], r2.pedestals.b[2] - 1.5, { within: 0.25 });
    await use(page, r2.pedestals.b, 'pedestal', r2.ids.b);
    const onB = await waitRoom(
      page,
      `r.sphereRadius > 3.99 && r.area1.walls['${wallId}'].off === r.area1.walls['${wallId}'].segments`,
      5_000,
    );
    expect(onB.area1.walls[wallId]?.segments).toBeGreaterThan(8);
    await lookAt(page, [r2.wall.min[0] - 1, r2.balcony.y + 1.0, r2.wall.min[2] + 0.6]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'court-b-placed.png') });
    await walkTo(page, below[0], below[1], { within: 0.25 });
    await walkTo(page, stairX, r2.balcony.minZ + 0.6, { within: 0.25 });
    await walkTo(page, r2.drop[0] + 0.5, r2.drop[2], { within: 0.25 });
    await use(page, r2.drop, 'drop', r2.ids.drop);
    const taken = await waitRoom(page, 'r.areas.area1.taken === 1', 6_000);
    expect(taken.events).toContain('dropTaken');
    // the lamps toward 部屋3 light (次の部屋の方向)
    await waitRoom(page, 'r.area1.next2 >= 1', 8_000);
    // back through the wall and down the stair: B comes from the floor, the wall is back
    await walkTo(page, stairX, r2.balcony.minZ + 0.6, { within: 0.25 });
    await walkTo(page, below[0], below[1], { within: 0.25 });
    await walkTo(page, r2.pedestals.b[0], r2.pedestals.b[2] - 1.5, { within: 0.25 });
    await use(page, r2.pedestals.b, 'pedestal', r2.ids.b);
    const back = await waitRoom(page, `r.orb === 'hand' && r.area1.walls['${wallId}'].off === 0`, 5_000);
    expect(back.events).toContain('pickup:pedestal');
    writeFileSync(
      join(root, `artifacts/S-40/court-${backend}.json`),
      JSON.stringify({ backend, errors }, null, 2),
    );
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-40 部屋3 and the shortcut with real input: the wrong roof, the right one, the third drop's light, home down the stairs [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    // 部屋1・2's drops held taken: 部屋3's is the third
    await page.goto(`/?scene=prologue-proto&spawn=area1-summit&area1Drop=1,2${webgl}`);
    const r0 = await waitRoom(
      page,
      "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
      90_000,
    );
    expect(r0.areas.area1).toEqual({ drops: 3, taken: 2 });
    const r3 = r0.layout.area1.room3;
    const sc = r0.layout.area1.shortcut;
    const zN = (r3.bridges.n.min[2] + r3.bridges.n.max[2]) / 2;
    const zS = (r3.bridges.s.min[2] + r3.bridges.s.max[2]) / 2;
    const lipX = r3.terrace.minX + 1.2;
    await lock(page);
    // with nothing placed the valley's lip stops you
    await walkTo(page, lipX, zN, { within: 0.25 });
    await lookAt(page, [r3.terrace.minX - 6, r3.summitY + 1.4, zN]);
    const atLip = (await pushUntilStopped(page, 'KeyW')).at(-1) as RoomProbe;
    expect(atLip.position.x).toBeGreaterThan(r3.terrace.minX - 0.45);
    // peek from the edge (端) toward the drop's bridge
    await walkTo(page, r3.edge[0], r3.edge[2], { within: 0.25 });
    await lookAt(page, r3.drop);
    const peek = await peekShot(page, join(shotDir, 'summit-edge-peek.png'));
    expect(peek.drawCalls).toBeLessThanOrEqual(BUDGET.drawCalls);
    // the wrong one first: the south pedestal, over its bridge to an empty roof (no drop to touch), back, picked up
    await walkTo(page, lipX, zS, { within: 0.25 });
    await use(page, r3.pedestals.s, 'pedestal', r3.ids.s);
    await waitRoom(page, 'r.sphereRadius > 3.99', 5_000);
    const onSouth = await walkTo(page, r3.roofs.s.maxX - 0.5, zS, { within: 0.25 });
    expect(onSouth.position.y).toBeCloseTo(r3.summitY, 1);
    await lookAt(page, r3.drop);
    await page.waitForTimeout(400);
    expect((await room(page)).target).not.toBe('drop');
    await walkTo(page, lipX, zS, { within: 0.25 });
    await use(page, r3.pedestals.s, 'pedestal', r3.ids.s);
    await waitRoom(page, "r.orb === 'hand' && r.sphereRadius === 0", 5_000);
    // the north one: over its bridge to the drop — the third: the shortcut's light runs
    await walkTo(page, lipX, zN, { within: 0.25 });
    await use(page, r3.pedestals.n, 'pedestal', r3.ids.n);
    await waitRoom(page, 'r.sphereRadius > 3.99', 5_000);
    const across = await walkTo(page, r3.roofs.n.maxX - 0.4, zN, { within: 0.25 });
    expect(across.position.y).toBeCloseTo(r3.summitY, 1);
    await use(page, r3.drop, 'drop', r3.ids.drop);
    await waitRoom(page, 'r.areas.area1.taken === 3', 6_000);
    // watch the light along the ridge to the stairs' top
    await lookAt(page, [(sc.minX + sc.maxX) / 2, r3.summitY + 0.3, zN]);
    const running = await waitRoom(
      page,
      // (once its front is ahead on the ridge, a few metres past the body)
      'r.area1.shortcut.front !== null && r.area1.shortcut.leg === 0 && r.area1.shortcut.front[0] < r.position.x - 3',
      5_000,
    );
    expect(running.area1.shortcut.events).toEqual(['settle']);
    await page.screenshot({ path: join(shotDir, 'shortcut-settling.png') });
    const fixed = await waitRoom(page, "r.area1.shortcut.events.includes('settled')", 10_000);
    expect(fixed.area1.shortcut.settle).toBe(1);
    expect(fixed.area1.walls['area1-shortcut-gate']?.off).toBe(
      fixed.area1.walls['area1-shortcut-gate']?.segments,
    );
    // back over the bridge (fixed); the vidro comes, and the bridge stays
    const onBridge = await walkTo(page, r3.terrace.minX - 0.9, zN, { within: 0.25 });
    expect(onBridge.position.y).toBeCloseTo(r3.summitY, 1);
    await use(page, r3.pedestals.n, 'pedestal', r3.ids.n);
    const inHand = await waitRoom(page, "r.orb === 'hand' && r.sphereRadius === 0", 5_000);
    expect(inHand.events).not.toContain('shake:pickup');
    // over it again, along the ridge, down the stairs, through where the gate was, into the entrance plaza
    await walkTo(page, (sc.minX + sc.maxX) / 2, zN, { within: 0.4, sprint: true, timeout: 40_000 });
    const home = await walkTo(page, (sc.minX + sc.maxX) / 2, r0.layout.area1.plaza.center[2] - 5, {
      within: 0.5,
      timeout: 60_000,
    });
    expect(home.position.y).toBeCloseTo(r0.layout.area1.plaza.center[1], 1);
    expect(home.grounded).toBe(true);
    await lookAt(page, [(sc.minX + sc.maxX) / 2, r3.summitY + 2, (sc.topZ + sc.footZ) / 2]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'shortcut-home.png') });
    writeFileSync(
      join(root, `artifacts/S-40/summit-${backend}.json`),
      JSON.stringify({ backend, errors }, null, 2),
    );
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-40 looking east down the slope: エリア1 is added in view and comes out of the haze, a part at a time; the frames [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-40'), { recursive: true });
    const errors = collectErrors(page);
    // at the workshop's slope brow, the vidro in hand; エリア1 is built from here on, behind the scenes
    await page.goto(`/?scene=prologue-proto&spawn=slope${webgl}`);
    const r0 = await waitRoom(page, "r.ready === true && r.orb === 'hand'", 90_000);
    expect(r0.area1.state).toBe('waiting');
    await lock(page);
    // every frame's length, as the page presents them (requestAnimationFrame)
    await page.evaluate(() => {
      const w = window as unknown as { __frames: { t: number; ms: number; z: number }[] };
      w.__frames = [];
      let last = performance.now();
      const tick = (now: number) => {
        const r = (window.__vidro?.sceneProbe as { room?: { position: { z: number } } } | undefined)?.room;
        w.__frames.push({ t: now, ms: now - last, z: r?.position.z ?? 0 });
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const { chimneyTop } = r0.layout.area1;
    const appears: number[] = [];
    let midway = false;
    // facing east (the chimney's side) and walking down the slope sideways (facing east, the left hand is south)
    await lookAt(page, [r0.position.x + 30, r0.position.y + r0.eyeHeight + 6, r0.position.z]);
    await page.keyboard.down('KeyA');
    await page.keyboard.down('ShiftLeft');
    try {
      for (const end = Date.now() + 120_000; Date.now() < end; ) {
        const r = await room(page);
        appears.push(r.area1.appear);
        // one picture while it comes out of the haze (S-40 review: no ghost of the haze's colour against the sky)
        if (!midway && r.area1.addedInView && r.area1.appear > 0.2 && r.area1.appear < 0.6) {
          midway = true;
          await page.screenshot({ path: join(shotDir, 'east-appearing.png') });
        }
        if (r.position.z < r0.layout.slopeEndZ - 1.5) break;
        // keep facing east
        const dYaw = wrap(Math.atan2(-1, 0) - r.yaw);
        if (Math.abs(dYaw) > 0.05) await look(page, dYaw, 0);
        await page.waitForTimeout(80);
      }
    } finally {
      await page.keyboard.up('KeyA');
      await page.keyboard.up('ShiftLeft');
    }
    const foot = await room(page);
    expect(foot.position.z).toBeLessThan(foot.layout.slopeEndZ);
    // on along the road, still facing east, into the entrance plaza
    const plaza = foot.layout.area1.plaza;
    await walkTo(page, plaza.center[0] - 4, plaza.center[2], {
      within: 0.6,
      sprint: true,
      timeout: 90_000,
      each: (r) => appears.push(r.area1.appear),
    });
    await lookAt(page, chimneyTop);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'east-arrived.png') });
    const done = await waitRoom(page, "r.area1.state === 'ready'", 30_000);
    const a = done.area1;
    const frames = await page.evaluate(
      () => (window as unknown as { __frames: { t: number; ms: number; z: number }[] }).__frames,
    );
    const played = frames.slice(5).map((f) => f.ms);
    const worst = Math.max(...played);
    const sorted = [...played].sort((p, q) => p - q);
    writeFileSync(
      join(root, `artifacts/S-40/east-${backend}.json`),
      JSON.stringify(
        {
          backend,
          area1: {
            addedAt: a.addedAt,
            readyAt: a.readyAt,
            addedInView: a.addedInView,
            worstMs: a.worstMs,
            frameMs: a.frameMs,
          },
          frames: {
            count: played.length,
            worst,
            p99: sorted[Math.floor(sorted.length * 0.99)],
            median: sorted[sorted.length >> 1],
          },
          appears: appears.filter((_, i) => i % 5 === 0),
          errors,
        },
        null,
        2,
      ),
    );
    // added while looking at it: it came out of the haze (appear rose from 0), its parts shown one at a time
    expect(a.addedInView).toBe(true);
    expect(
      appears.some((v) => v > 0.02 && v < 0.98),
      'appear on its way from the haze',
    ).toBe(true);
    expect(a.appear).toBe(1);
    expect(a.shown).toBe(a.entries);
    // the frames while it was built, added and warmed, and all the way down the slope and the road (aim 50 ms)
    expect(a.worstMs, 'the longest frame from building to ready (ms)').toBeLessThan(ADD_FRAME_MS);
    expect(worst, 'the longest frame down the slope and along the road (ms)').toBeLessThan(PLAY_FRAME_MS);
    expect(done.fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
