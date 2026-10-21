import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { FURNACE, FURNACE_FACING, GRATE, WORKSHOP_OBJECTS } from '../../src/game/prologue/layout';

/**
 * S-24: the workshop's interior (Blender → `pnpm assets` → public/assets/workshop/a0.glb) in the prologue room, on both
 * render paths.
 *  (a) it loads: every piece of the approved plan, their colliders, marked glass made by the library, no problems,
 *      nothing on one layer only; no console error or warning
 *  (b) played: wake in front of the bench, take the vidro, step onto the brass grate in front of the furnace (the
 *      footsteps turn brass), walk out of the door onto the way
 *  (c) the fixed views for the designer (目覚め, 炉の前, 作品の棚, 扉から振り返る): screenshots → artifacts/screens/S-24/<backend>/,
 *      draws and triangles → artifacts/S-24/views-<backend>.json, inside the budget
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface WorkshopProbe {
  loaded: boolean;
  objects: string[];
  missing: string[];
  colliders: string[];
  problems: { object: string; code: string }[];
  glass: { object: string; material: string; kind: string; path: string }[];
  triangles: number;
  hiddenFromCamera: string[];
}
interface RoomProbe {
  ready: boolean;
  playing: boolean;
  time: number;
  position: V3;
  speed: number;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  locked: boolean;
  orb: 'bench' | 'hand' | 'pedestal';
  target: 'bench' | 'pedestal' | 'drop' | null;
  drawCalls: number;
  triangles: number;
  workshop?: WorkshopProbe;
}
interface FootstepEntry {
  material: 'stone' | 'frosted' | 'brass';
  zone: string;
  x: number;
  z: number;
}
interface SoundProbe {
  state: string;
  footsteps: { ready: boolean; log: FootstepEntry[] };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
const SENSITIVITY = 0.0022;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;

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

const room = (page: Page): Promise<RoomProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { room: RoomProbe }).room);
const sound = (page: Page): Promise<SoundProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { sound: SoundProbe }).sound);

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<RoomProbe> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return room(page);
}

/**
 * A point `a` metres off the furnace's centre toward the room, 0.4 m to the door's side of the blowpipe in its mouth
 * (the pipe runs along the middle of the grate). On the grate for `a` between GRATE.near and GRATE.near + GRATE.depth.
 */
function besideThePipe(a: number): [number, number] {
  const [fx, fz] = FURNACE_FACING;
  const side = 0.4;
  expect(side).toBeLessThan(GRATE.width / 2);
  return [FURNACE.center[0] + fx * a - fz * side, FURNACE.center[2] + fz * a + fx * side];
}

const cursor = { x: 640, y: 360 };
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

async function look(page: Page, dYaw: number, dPitch: number): Promise<void> {
  const dx = -dYaw / SENSITIVITY;
  const dy = -dPitch / SENSITIVITY;
  const steps = Math.max(2, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 60));
  cursor.x += dx;
  cursor.y += dy;
  await page.mouse.move(cursor.x, cursor.y, { steps });
}

async function lookAt(page: Page, p: [number, number, number]): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const r = await room(page);
    const eye = { x: r.position.x, y: r.position.y + r.eyeHeight, z: r.position.z };
    const yaw = Math.atan2(-(p[0] - eye.x), -(p[2] - eye.z));
    const pitch = Math.atan2(p[1] - eye.y, Math.hypot(p[0] - eye.x, p[2] - eye.z));
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
      if (Math.hypot(x - r.position.x, z - r.position.z) < within) return r;
      if (Date.now() > end)
        throw new Error(`walkTo(${x}, ${z}) did not arrive: at ${JSON.stringify(r.position)}`);
      const dYaw = wrap(Math.atan2(-(x - r.position.x), -(z - r.position.z)) - r.yaw);
      if (Math.abs(dYaw) > 0.05) await look(page, dYaw, 0);
      await page.waitForTimeout(50);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-24', backend);
  const outDir = join(root, 'artifacts/S-24');

  test(`S-24 the workshop's interior loads: every piece, its colliders, the library's glass, no problems [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    // debug=1: __vidroDebug.backdropRisks() (S-14) looks at what the room drew, once the workshop is in
    await page.goto(`/?scene=prologue-proto&direct=1&debug=1${webgl}`);
    const r = await waitRoom(page, 'r.ready && r.playing', 60_000);
    const w = r.workshop;
    expect(w, 'room.workshop on the probe').toBeDefined();
    if (!w) return;
    expect(w.loaded).toBe(true);
    expect(w.missing).toEqual([]);
    for (const o of Object.values(WORKSHOP_OBJECTS)) {
      expect(w.objects).toContain(o.name);
      if (o.col) expect(w.colliders).toContain(`${o.name}_col`);
    }
    expect(w.problems).toEqual([]);
    expect(w.hiddenFromCamera).toEqual([]);
    // the glass marked in Blender is the library's glass: near pieces refract (transmission), the furnace is milky
    expect(new Set(w.glass.map((g) => g.kind))).toEqual(new Set(['clear', 'frosted', 'bubble', 'milky']));
    expect(w.glass.filter((g) => g.kind === 'milky').every((g) => g.path === 'opaque')).toBe(true);
    expect(w.glass.filter((g) => g.kind !== 'milky').every((g) => g.path === 'transmission')).toBe(true);
    await page.waitForTimeout(1_500);
    // S-12: every transmissive material of the workshop follows a render size change (the S-14 sensor's check, made
    // here after the glb is in: the all-scenes sensor looks at 1 s and 5 s, which can be before it is loaded)
    const backdrop = await page.evaluate(() => window.__vidroDebug?.backdropRisks() ?? null);
    expect(backdrop, '__vidroDebug.backdropRisks()').not.toBeNull();
    expect(backdrop?.risks).toEqual([]);
    expect(Math.max(0, ...(backdrop?.roots ?? []).map((x) => x.backdropReaders))).toBeGreaterThanOrEqual(
      w.glass.filter((g) => g.path === 'transmission').length,
    );
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-24 wake, take the vidro, step on the brass grate, walk out of the door onto the way [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(outDir, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&direct=1${webgl}`);
    await waitRoom(page, 'r.ready && r.playing && r.workshop && r.workshop.loaded', 60_000);
    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    await page.waitForFunction(
      () => {
        const s = (window.__vidro?.sceneProbe as { sound?: SoundProbe } | undefined)?.sound;
        return !!s && s.state === 'running' && s.footsteps.ready;
      },
      undefined,
      { timeout: 15_000 },
    );
    // 作業台の玉を手にする
    await waitRoom(page, "r.target === 'bench'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand'");
    // onto the grate in front of the furnace, beside the blowpipe left in its mouth, and back: the steps there are brass
    const beside = (a: number): [number, number] => besideThePipe(a);
    await walkTo(page, ...beside(2.3), 0.3);
    await walkTo(page, ...beside(1.35), 0.2);
    await walkTo(page, ...beside(2.2), 0.25);
    // round the bench's right end, out of the door, onto the one way
    await walkTo(page, 0.05, -2.2, 0.35);
    await walkTo(page, 0.05, -3.8, 0.35);
    const out = await walkTo(page, 0, -6.2, 0.4);
    const steps = (await sound(page)).footsteps.log;
    writeFileSync(
      join(outDir, `walk-${backend}.json`),
      JSON.stringify({ backend, room: out, steps, errors }, null, 2),
    );
    expect(out.orb).toBe('hand');
    expect(out.position.z).toBeLessThan(-5.5);
    const brass = steps.filter((s) => s.material === 'brass');
    expect(brass.length).toBeGreaterThan(0);
    expect(brass.every((s) => s.zone === 'grate')).toBe(true);
    expect(steps.some((s) => s.material === 'stone' && s.zone === 'path')).toBe(true);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-24 trial: a surface-only wall in the placed orb's sphere — keep stops you, cut lets you onto the bridge [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const errors = collectErrors(page);
    const out: Record<string, unknown> = {};
    for (const mode of ['keep', 'cut'] as const) {
      // the orb on the dead-end pedestal, fully grown (growHold=1); the trial wall on the lip of the dead end
      await page.goto(
        `/?scene=prologue-proto&spawn=dead-end&growHold=1&trial=surface-wall&surfaceCol=${mode}${webgl}`,
      );
      const r0 = await waitRoom(page, 'r.ready && r.playing && r.trial', 60_000);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shotDir, `trial-${mode}.png`) });
      cursor.x = 640;
      cursor.y = 360;
      await page.mouse.move(cursor.x, cursor.y);
      await page.mouse.down();
      await page.mouse.up();
      await waitRoom(page, 'r.locked === true');
      await lookAt(page, [0.05, 1.2, r0.position.z - 6]);
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(3_500);
      await page.keyboard.up('KeyW');
      const r = await room(page);
      const trial = (r as RoomProbe & { trial: { mode: string; segments: number; off: number } }).trial;
      out[mode] = { trial, position: r.position };
      expect(trial.mode).toBe(mode);
      if (mode === 'keep') {
        expect(trial.off).toBe(0);
        expect(r.position.z).toBeGreaterThan(-13.9); // stopped by the wall that is not drawn inside the sphere
      } else {
        expect(trial.off).toBe(trial.segments);
        expect(r.position.z).toBeLessThan(-14.5); // on the bridge
      }
    }
    writeFileSync(join(outDir, `trial-${backend}.json`), JSON.stringify(out, null, 2));
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-24 the fixed views (wake, furnace, shelf, door) inside the budget [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const errors = collectErrors(page);
    const views: Record<string, { drawCalls: number; triangles: number; workshop: boolean }> = {};
    for (const view of ['bench', 'furnace', 'shelf', 'door'] as const) {
      // peekHold=0: no controls hint (a clean picture), nothing else held; mid quality, no dynamic resolution
      await page.goto(
        `/?scene=prologue-proto&direct=1&spawn=${view}&peekHold=0&quality=mid&dynres=0${webgl}`,
      );
      await waitRoom(page, 'r.ready && r.playing', 60_000);
      await page.waitForTimeout(1_200);
      const counts = { drawCalls: 0, triangles: 0 };
      for (let i = 0; i < 6; i++) {
        const r = await room(page);
        counts.drawCalls = Math.max(counts.drawCalls, r.drawCalls);
        counts.triangles = Math.max(counts.triangles, r.triangles);
        await page.waitForTimeout(80);
      }
      const name = view === 'bench' ? 'wake' : view;
      await page.screenshot({ path: join(shotDir, `${name}.png`) });
      views[name] = { ...counts, workshop: !!(await room(page)).workshop?.loaded };
    }
    writeFileSync(join(outDir, `views-${backend}.json`), JSON.stringify({ backend, views }, null, 2));
    for (const [name, v] of Object.entries(views)) {
      expect(v.workshop, `${name}: the workshop is there`).toBe(true);
      expect(v.drawCalls, name).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(v.triangles, name).toBeLessThanOrEqual(BUDGET.triangles);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
