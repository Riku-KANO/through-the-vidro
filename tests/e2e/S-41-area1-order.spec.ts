import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-41: エリア1's rooms in order, 部屋3's drop in the lee of the roof's walls, the peek image without what lies past the haze — on
 * both render paths, with real input.
 *  1. 部屋は順に開く: the gate across the slope's foot stops you until 部屋1's drop is taken; its light comes along the lamps to
 *     the keystone, the leaves swing open with the prologue gate's sound, up the first flight. The same at the second flight's
 *     foot with 部屋2's drop (the courtyard played for real). Screens of each gate shut and open.
 *  2. 部屋3: peeking from the edge (端) the drop's pixels show through the gap in the roof's walls; with the vidro placed on the
 *     south pedestal, then on the north one, from by each pedestal (and from the edge) none do. Measured as S-27 did: the drop
 *     hidden by name against the same picture, the pixels that move between two shots of the same picture left out.
 *  3. 覗く像に遠い物を描かない: peeking in the courtyard from A toward the town, fewer draw calls than S-40's 266, nothing of the
 *     back layer left out, and the vidro's image as with nothing left out (the pixels inside it).
 * Screens → artifacts/screens/S-41/<backend>/, the runs → artifacts/S-41/.
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
interface Gate {
  id: string;
  after: string;
  at: P3;
  halfWidth: number;
  swing: number;
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
  target: 'bench' | 'pedestal' | 'drop' | null;
  targetId: string | null;
  events: string[];
  drawCalls: number;
  triangles: number;
  fallRescues: number;
  areas: Record<string, { drops: number; taken: number }>;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  peekFar: { far: number; leftOut: number; leftOutBack: number; keptBack: number };
  area1: {
    state: string;
    walls: Record<string, { segments: number; off: number }>;
    nextRoom: number;
    next: number;
    next2: number;
    gates: Record<string, { progress: number; angle: number; events: string[] }>;
  };
  layout: {
    area1: {
      alley: Rect;
      wall: Box;
      pedestalOrb: P3;
      drop: P3;
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
        pedestals: { n: P3; s: P3 };
        ids: { n: string; s: string; drop: string };
        drop: P3;
        shade: (Rect & { top: number })[];
      };
      gates: Gate[];
    };
  };
}
interface GateSound {
  ready: boolean;
  played: { gate: string; at: P3; distance: number }[];
  refused: string[];
  voicesStarted: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const SENSITIVITY = 0.0022;
const BENIGN = /GPU stall|powerPreference/i;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
/** S-40: peeking in the courtyard from A toward the town. */
const S40_COURT_A_PEEK = 266;

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
const gateSound = (page: Page): Promise<GateSound | null> =>
  page.evaluate(() => {
    const s = (window.__vidro.sceneProbe as { sound?: { gates?: GateSound } }).sound;
    return s?.gates ? { ...s.gates } : null;
  });

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<RoomProbe> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return room(page);
}

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
  for (let i = 0; i < 6; i++) {
    const r = await room(page);
    const eye = { x: r.position.x, y: r.position.y + r.eyeHeight, z: r.position.z };
    const dx = p[0] - eye.x;
    const dy = p[1] - eye.y;
    const dz = p[2] - eye.z;
    const dYaw = wrap(Math.atan2(-dx, -dz) - r.yaw);
    const dPitch = Math.atan2(dy, Math.hypot(dx, dz)) - r.pitch;
    if (Math.abs(dYaw) < 0.008 && Math.abs(dPitch) < 0.008) return;
    await look(page, dYaw, dPitch);
    await page.waitForTimeout(60);
  }
}

async function walkTo(
  page: Page,
  x: number,
  z: number,
  opts: { within?: number; timeout?: number; sprint?: boolean } = {},
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

/** Holds W until the body has been at rest for 0.4 s of scene time (or the limit). */
async function pushUntilStopped(page: Page, limitMs = 8_000): Promise<RoomProbe> {
  let last = await room(page);
  await page.keyboard.down('KeyW');
  let stillSince: number | null = null;
  const end = Date.now() + limitMs;
  try {
    while (Date.now() < end) {
      last = await room(page);
      if (last.speed > 0.03) stillSince = null;
      else stillSince ??= last.time;
      if (stillSince !== null && last.time - stillSince > 0.4) break;
      await page.waitForTimeout(40);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
  return last;
}

async function lock(page: Page): Promise<void> {
  cursor.x = 640;
  cursor.y = 360;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.up();
  await waitRoom(page, 'r.locked === true');
}

async function use(page: Page, at: P3, kind: 'pedestal' | 'drop', id?: string): Promise<void> {
  await lookAt(page, at);
  await waitRoom(page, `r.target === '${kind}'${id ? ` && r.targetId === '${id}'` : ''}`, 5_000);
  await page.keyboard.press('KeyE');
}

/**
 * Records the scene the room draws (?debug=1: the renderer is the page's), so a thing can be hidden by name — its children:
 * the room shows and hides the thing itself each frame (S-27's way of measuring what a thing adds to the picture).
 */
async function hookScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __vidroDebug: { renderer: { render: (...a: unknown[]) => unknown } };
      __s41Scene?: unknown;
      __s41Hide?: (name: string, hidden: boolean) => boolean;
    };
    const r = w.__vidroDebug.renderer;
    const inner = r.render.bind(r);
    r.render = (...args: unknown[]) => {
      const scene = args[0] as { isScene?: boolean };
      if (scene?.isScene) w.__s41Scene = scene;
      return inner(...args);
    };
    w.__s41Hide = (name, hidden) => {
      const scene = w.__s41Scene as
        | { getObjectByName: (n: string) => { children: { visible: boolean }[] } | undefined }
        | undefined;
      const o = scene?.getObjectByName(name);
      if (!o) return false;
      for (const c of o.children) c.visible = !hidden;
      return true;
    };
  });
  await page.waitForTimeout(200);
}

/** Pixels (share of `region`, a circle in 0..1 of the picture's height, or the whole picture) that change from `a` to `b`, leaving out those that differ between `a` and `again` (the same picture twice). */
async function changedShare(
  page: Page,
  a: Buffer,
  again: Buffer,
  b: Buffer,
  region: { x: number; y: number; r: number } | null,
): Promise<number> {
  return page.evaluate(
    async ([pa, pa2, pb, reg]) => {
      const read = async (b64: string) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { d: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
      };
      const A = await read(pa);
      const A2 = await read(pa2);
      const B = await read(pb);
      const lum = (d: Uint8ClampedArray, i: number) =>
        (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      let n = 0;
      let changed = 0;
      for (let y = 0; y < A.h; y += 2)
        for (let x = 0; x < A.w; x += 2) {
          if (reg) {
            const cx = reg.x * A.w;
            const cy = reg.y * A.h;
            const rr = reg.r * A.h * 0.9;
            if ((x - cx) ** 2 + (y - cy) ** 2 > rr * rr) continue;
          }
          const i = (y * A.w + x) * 4;
          n++;
          if (Math.abs(lum(A.d, i) - lum(A2.d, i)) > 0.02) continue;
          if (Math.abs(lum(A.d, i) - lum(B.d, i)) > 0.06) changed++;
        }
      return n > 0 ? changed / n : 0;
    },
    [a.toString('base64'), again.toString('base64'), b.toString('base64'), region] as const,
  );
}

/** What the drop adds to the picture now: its pixels against the same picture with it hidden (share of the region). */
async function dropPixels(page: Page, region: { x: number; y: number; r: number } | null): Promise<number> {
  const name = 'area1-drop:area1-room3';
  const a = await page.screenshot();
  await page.waitForTimeout(120);
  const again = await page.screenshot();
  const hid = await page.evaluate(
    (n) => (window as unknown as { __s41Hide: (n: string, h: boolean) => boolean }).__s41Hide(n, true),
    name,
  );
  expect(hid, 'the drop found by name').toBe(true);
  await page.waitForTimeout(150);
  const b = await page.screenshot();
  await page.evaluate(
    (n) => (window as unknown as { __s41Hide: (n: string, h: boolean) => boolean }).__s41Hide(n, false),
    name,
  );
  await page.waitForTimeout(120);
  return changedShare(page, a, again, b, region);
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-41', backend);
  const runDir = join(root, 'artifacts/S-41');

  test(`S-41 rooms open in order: the slope's gate shut until 部屋1's drop, its light, the leaves, the sound, up [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&spawn=area1-alley${webgl}`);
    const r0 = await waitRoom(
      page,
      "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
      90_000,
    );
    const a1 = r0.layout.area1;
    const [court, summit] = a1.gates as [Gate, Gate];
    expect(r0.area1.nextRoom).toBe(0);
    expect(r0.area1.gates[court.id]?.progress).toBe(0);
    // (direct mode: the first click starts the audio)
    await lock(page);
    // to the slope's foot and on up: the gate stops you in the street
    await walkTo(page, a1.slope.x, court.at[2] + 1.6, { within: 0.3 });
    await lookAt(page, [a1.slope.x, court.at[1] + 1.4, court.at[2] - 10]);
    const stopped = await pushUntilStopped(page);
    expect(stopped.position.z, 'stopped at the shut gate').toBeGreaterThan(court.at[2]);
    expect(stopped.grounded).toBe(true);
    await walkTo(page, a1.slope.x - 0.3, court.at[2] + 2.6, { within: 0.25 });
    await lookAt(page, [a1.slope.x + 1.3, a1.room2.courtY + 1.8, a1.room2.balcony.minZ + 0.6]);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'gate-court-shut.png') });
    // 部屋1: place, through the wall, the drop (along the street to the alley's mouth first)
    const x = (a1.alley.minX + a1.alley.maxX) / 2 - 0.4;
    const mouth = a1.alley.minZ - 1.2;
    await walkTo(page, x, mouth, { within: 0.4, timeout: 40_000 });
    await walkTo(page, x, a1.wall.min[2] - 0.9, { within: 0.3 });
    await use(page, a1.pedestalOrb, 'pedestal');
    await waitRoom(page, 'r.sphereRadius > 3.99', 5_000);
    await walkTo(page, a1.drop[0] + 0.2, a1.wall.max[2] + 0.6, { within: 0.3 });
    await page.waitForFunction(
      () =>
        (window.__vidro.sceneProbe as { sound?: { gates?: { ready: boolean } } }).sound?.gates?.ready ===
        true,
      undefined,
      { timeout: 30_000 },
    );
    await use(page, a1.drop, 'drop');
    const taken = await waitRoom(page, 'r.areas.area1.taken === 1', 6_000);
    expect(taken.area1.nextRoom).toBe(1);
    // the light comes along the lamps toward the courtyard; at the keystone the gate starts to open (its own bus, its sound)
    const opening = await waitRoom(page, `r.area1.gates['${court.id}'].events.includes('open')`, 6_000);
    expect(opening.area1.next, 'the lamps lit up to the keystone first').toBeGreaterThan(0.5);
    // (on its own bus: nothing new in the room's events, S-16's table of sounds)
    expect(opening.events.some((e) => e.includes('gate'))).toBe(false);
    const opened = await waitRoom(page, `r.area1.gates['${court.id}'].events.includes('opened')`, 6_000);
    expect(opened.area1.gates[court.id]?.progress).toBe(1);
    expect(opened.area1.gates[summit.id]?.progress).toBe(0);
    const s = await gateSound(page);
    expect(s?.played.map((p) => p.gate)).toEqual([court.id]);
    expect(s?.refused).toEqual([]);
    // back out, the vidro, and up through the open gate to the landing
    await walkTo(page, x, a1.wall.min[2] - 1.0, { within: 0.3 });
    await use(page, a1.pedestalOrb, 'pedestal');
    await waitRoom(page, "r.orb === 'hand'", 5_000);
    await walkTo(page, x, mouth, { within: 0.4 });
    await walkTo(page, a1.slope.x - 0.3, court.at[2] + 2.6, { within: 0.3, timeout: 40_000 });
    await lookAt(page, [a1.slope.x + 1.3, a1.room2.courtY + 1.8, a1.room2.balcony.minZ + 0.6]);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'gate-court-open.png') });
    const up = await walkTo(page, a1.slope.x, a1.slope.landingFromZ - 1.2, { within: 0.4, sprint: true });
    expect(up.position.y).toBeCloseTo(a1.room2.courtY, 1);
    // on the landing the second gate stands shut
    await lookAt(page, [a1.slope.x, summit.at[1] + 1.4, summit.at[2] - 10]);
    const held = await pushUntilStopped(page);
    expect(held.position.z, 'stopped at the second gate').toBeGreaterThan(summit.at[2]);
    writeFileSync(
      join(runDir, `court-gate-${backend}.json`),
      JSON.stringify({ backend, sound: s, gate: opened.area1.gates, errors }, null, 2),
    );
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-41 rooms open in order: the second flight's gate shut until 部屋2's drop (played), then up to the summit [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    // 部屋1's drop held taken (its gate open), on the landing at the courtyard's opening
    await page.goto(`/?scene=prologue-proto&spawn=area1-gate-summit&area1Drop=1${webgl}`);
    const r0 = await waitRoom(
      page,
      "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
      90_000,
    );
    const a1 = r0.layout.area1;
    const summit = a1.gates[1] as Gate;
    const r2 = a1.room2;
    expect(r0.area1.nextRoom).toBe(1);
    await lock(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shotDir, 'gate-summit-shut.png') });
    await lookAt(page, [a1.slope.x, summit.at[1] + 1.4, summit.at[2] - 10]);
    const stopped = await pushUntilStopped(page);
    expect(stopped.position.z, 'stopped at the shut gate').toBeGreaterThan(summit.at[2]);
    // 部屋2 on B: up the stair, through the wall, the drop
    const stairX = (r2.stairs.minX + r2.stairs.maxX) / 2;
    const below: [number, number] = [stairX, r2.stairs.footZ - 0.9];
    await walkTo(page, r2.pedestals.b[0], r2.pedestals.b[2] - 1.5, { within: 0.25 });
    await use(page, r2.pedestals.b, 'pedestal', r2.ids.b);
    await waitRoom(page, 'r.sphereRadius > 3.99', 5_000);
    await walkTo(page, below[0], below[1], { within: 0.25 });
    await walkTo(page, stairX, r2.balcony.minZ + 0.6, { within: 0.25 });
    await walkTo(page, r2.drop[0] + 0.5, r2.drop[2], { within: 0.25 });
    await use(page, r2.drop, 'drop', r2.ids.drop);
    await waitRoom(page, 'r.areas.area1.taken === 2', 6_000);
    // from the balcony the gate is in sight: its keystone lights, it opens
    await lookAt(page, [summit.at[0], summit.at[1] + 2.2, summit.at[2]]);
    const opening = await waitRoom(page, `r.area1.gates['${summit.id}'].events.includes('open')`, 6_000);
    expect(opening.area1.nextRoom).toBe(2);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: join(shotDir, 'gate-summit-opening.png') });
    await waitRoom(page, `r.area1.gates['${summit.id}'].events.includes('opened')`, 6_000);
    // back through the wall, down, the vidro, and up the second flight to the summit
    await walkTo(page, stairX, r2.balcony.minZ + 0.6, { within: 0.25 });
    await walkTo(page, below[0], below[1], { within: 0.25 });
    await walkTo(page, r2.pedestals.b[0], r2.pedestals.b[2] - 1.5, { within: 0.25 });
    await use(page, r2.pedestals.b, 'pedestal', r2.ids.b);
    await waitRoom(page, "r.orb === 'hand'", 5_000);
    await walkTo(page, a1.slope.x + 0.3, a1.slope.landingFromZ - 0.8, { within: 0.3 });
    await lookAt(page, [a1.slope.x - 1.6, a1.room3.summitY + 1.6, a1.slope.toZ - 0.3]);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'gate-summit-open.png') });
    const top = await walkTo(page, a1.slope.x, a1.slope.toZ - 1.5, { within: 0.4, sprint: true });
    expect(top.position.y).toBeCloseTo(a1.room3.summitY, 1);
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-41 部屋3: the drop seen peeking from the edge alone; placed on either pedestal, not from by it [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&spawn=area1-summit&area1Drop=1,2&debug=1${webgl}`);
    const r0 = await waitRoom(
      page,
      "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
      90_000,
    );
    const r3 = r0.layout.area1.room3;
    await lock(page);
    await hookScene(page);
    const share: Record<string, number> = {};
    // from where the slope arrives, looking across at the roofs: nothing of it (and peeking: nothing either)
    await lookAt(page, r3.drop);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'summit.png') });
    share.arrive = await dropPixels(page, null);
    await page.mouse.down({ button: 'right' });
    let p = await waitRoom(page, 'r.peekAmount > 0.999');
    await page.waitForTimeout(400);
    share['arrive-peek'] = await dropPixels(page, p.orbScreen);
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peekAmount === 0');
    // the edge: peeking, its light through the gap between the roof's walls
    await walkTo(page, r3.edge[0], r3.edge[2], { within: 0.2 });
    await lookAt(page, r3.drop);
    await page.mouse.down({ button: 'right' });
    p = await waitRoom(page, 'r.peekAmount > 0.999');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shotDir, 'edge-peek.png') });
    share['edge-peek'] = await dropPixels(page, p.orbScreen);
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peekAmount === 0');
    // placed on the south pedestal (the drop is not in its sphere): from by it, and from the edge, nothing
    const zN = (r3.bridges.n.min[2] + r3.bridges.n.max[2]) / 2;
    const zS = (r3.bridges.s.min[2] + r3.bridges.s.max[2]) / 2;
    await walkTo(page, r3.pedestals.s[0] + 0.6, zS + 0.6, { within: 0.25 });
    await use(page, r3.pedestals.s, 'pedestal', r3.ids.s);
    await waitRoom(page, 'r.sphereRadius > 3.99', 5_000);
    await lookAt(page, r3.drop);
    await page.waitForTimeout(300);
    share['placed-s'] = await dropPixels(page, null);
    await use(page, r3.pedestals.s, 'pedestal', r3.ids.s);
    await waitRoom(page, "r.orb === 'hand' && r.sphereRadius === 0", 5_000);
    // placed on the north one (the drop is real now, in the walls' lee): from by it, nothing (round the stub on the terrace)
    await walkTo(page, r3.edge[0] + 0.2, r3.edge[2] - 0.4, { within: 0.3 });
    await walkTo(page, r3.pedestals.n[0] + 0.9, zN - 0.6, { within: 0.25 });
    await use(page, r3.pedestals.n, 'pedestal', r3.ids.n);
    const placed = await waitRoom(page, 'r.sphereRadius > 3.99', 5_000);
    expect(placed.pedestal).toBe(r3.ids.n);
    await lookAt(page, r3.drop);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'placed-n.png') });
    share['placed-n'] = await dropPixels(page, null);
    // over the bridge and round the northern wall, it is there to touch (覚えておいた所に)
    const wallA = r3.shade[0] as Rect & { top: number };
    await walkTo(page, r3.bridges.n.min[0] + 0.2, zN, { within: 0.25 });
    await walkTo(page, wallA.minX - 0.5, zN - 0.1, { within: 0.25 });
    await walkTo(page, r3.drop[0], wallA.maxZ - 0.2, { within: 0.25 });
    await lookAt(page, r3.drop);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'lee.png') });
    share.lee = await dropPixels(page, null);
    await use(page, r3.drop, 'drop', r3.ids.drop);
    await waitRoom(page, 'r.areas.area1.taken === 3', 6_000);
    writeFileSync(join(runDir, `room3-${backend}.json`), JSON.stringify({ backend, share, errors }, null, 2));
    // (S-41 measured: the edge peek … of the vidro's circle; the rest 0)
    expect(share['edge-peek'], 'the drop through the gap, peeking from the edge').toBeGreaterThan(0.003);
    for (const k of ['arrive', 'arrive-peek', 'placed-s', 'placed-n'])
      expect(share[k], `the drop seen ${k}`).toBeLessThan(0.0005);
    expect(share.lee, 'in its lee it is there').toBeGreaterThan(0.001);
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-41 the peek image leaves out what lies past the haze: fewer draw calls toward the town, the vidro's image as before [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(runDir, { recursive: true });
    const errors = collectErrors(page);
    const runs: Record<string, unknown> = {};
    for (const [name, spawn, at] of [
      ['court-a', 'area1-court-a', 'room2'],
      ['edge', 'area1-edge&area1Drop=1,2', 'room3'],
    ] as const) {
      await page.goto(`/?scene=prologue-proto&spawn=${spawn}${webgl}`);
      const r0 = await waitRoom(
        page,
        "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
        90_000,
      );
      await lock(page);
      await lookAt(page, at === 'room2' ? r0.layout.area1.room2.drop : r0.layout.area1.room3.drop);
      await page.mouse.down({ button: 'right' });
      const peek = await waitRoom(page, 'r.peekAmount > 0.999');
      await page.waitForTimeout(600);
      const cut = await room(page);
      const a = await page.screenshot();
      await page.waitForTimeout(120);
      const again = await page.screenshot();
      // everything the main camera would draw, into the peek image too (S-40's peek image)
      await page.evaluate(() =>
        (window.__vidro.sceneProbe as { room: { setPeekFar: (m: number | null) => void } }).room.setPeekFar(
          1000,
        ),
      );
      await page.waitForTimeout(400);
      const all = await room(page);
      const b = await page.screenshot();
      const changed = await changedShare(page, a, again, b, peek.orbScreen);
      await page.evaluate(() =>
        (window.__vidro.sceneProbe as { room: { setPeekFar: (m: number | null) => void } }).room.setPeekFar(
          null,
        ),
      );
      await page.mouse.up({ button: 'right' });
      runs[name] = {
        cut: { drawCalls: cut.drawCalls, triangles: cut.triangles, peekFar: cut.peekFar },
        all: { drawCalls: all.drawCalls, triangles: all.triangles, peekFar: all.peekFar },
        changedInOrb: changed,
      };
      expect(cut.peekFar.leftOut, `${name}: something left out`).toBeGreaterThan(10);
      expect(cut.peekFar.leftOutBack, `${name}: nothing of the back layer left out`).toBe(0);
      expect(all.drawCalls - cut.drawCalls, `${name}: fewer draw calls`).toBeGreaterThan(40);
      expect(changed, `${name}: the vidro's image as with nothing left out`).toBeLessThan(0.005);
      expect(cut.drawCalls).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(cut.triangles).toBeLessThanOrEqual(BUDGET.triangles);
      if (name === 'court-a') expect(cut.drawCalls).toBeLessThan(S40_COURT_A_PEEK - 40);
    }
    writeFileSync(
      join(runDir, `peek-far-${backend}.json`),
      JSON.stringify({ backend, runs, errors }, null, 2),
    );
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
