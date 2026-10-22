import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { EDGE_Z, PEDESTAL_ORB, TRIAL_SURFACE_WALL } from '../../src/game/prologue/layout';

/**
 * S-28: a surface-only wall (表にしかない壁) inside the placed orb's sphere, played with real keys and mouse on both render
 * paths (コアメカニクス > 裏の層のルール: 玉を置くと、その球の中では…表にしかない壁は消えて通れるようになる).
 * The wall is S-24's on the lip of the dead end (?trial=surface-wall), across the way onto the bridge.
 *  1. before the orb is placed the wall stops you
 *  2. place the vidro on the dead end's pedestal: the wall's segments lose their collider, and you walk through onto the bridge
 *  3. standing in the wall, the orb will not come (pickup-denied, it trembles: shake:pickup), and the wall stays open
 *  4. out of the wall the orb comes, and the wall is solid again
 * No console error or warning. Screenshots → artifacts/screens/S-28/<backend>/ (wall, stopped, open, through, denied),
 * positions → artifacts/S-28/<backend>.json.
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
  position: V3;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  locked: boolean;
  orb: 'bench' | 'hand' | 'pedestal';
  pedestal: string | null;
  sphereRadius: number;
  shaking: boolean;
  target: 'bench' | 'pedestal' | 'drop' | null;
  events: string[];
  lastAction: string | null;
  trial: { segments: number; off: number } | null;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const SENSITIVITY = 0.0022;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** The body (player/constants BODY_RADIUS) and the wall it walks into. */
const BODY_RADIUS = 0.3;
const WALL_X = 0.05;
const WALL_NEAR_Z = TRIAL_SURFACE_WALL.max[2];
const WALL_FAR_Z = TRIAL_SURFACE_WALL.min[2];
/** In the wall and still on the shore (not over the bridge's footing, which refuses a pickup by itself). */
const IN_WALL = { minZ: EDGE_Z + 0.03, maxZ: WALL_NEAR_Z + BODY_RADIUS - 0.08 };

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

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<RoomProbe> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return room(page);
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

async function lookAt(page: Page, p: readonly [number, number, number]): Promise<void> {
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

/** Short steps (W forward to −z, S back) until the feet stand between minZ and maxZ. Faces −z first. */
async function stepInto(page: Page, minZ: number, maxZ: number): Promise<RoomProbe> {
  const r0 = await room(page);
  await lookAt(page, [r0.position.x, 1.5, r0.position.z - 8]);
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(350); // let the short inertia settle
    const r = await room(page);
    const z = r.position.z;
    if (z > minZ && z < maxZ) return r;
    const away = z >= maxZ ? z - (minZ + maxZ) / 2 : (minZ + maxZ) / 2 - z;
    const key = z >= maxZ ? 'KeyW' : 'KeyS';
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.max(60, Math.min(800, (away / 1.4) * 1000)));
    await page.keyboard.up(key);
  }
  throw new Error(
    `could not stand between z ${minZ} and ${maxZ}: at ${JSON.stringify((await room(page)).position)}`,
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-28', backend);
  const outDir = join(root, 'artifacts/S-28');

  test(`S-28 a surface-only wall: it stops you, the placed orb lets you through, and standing in it the orb will not come [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const errors = collectErrors(page);
    const out: Record<string, unknown> = { backend };
    // the vidro in hand at the dead end (spawn=dead-end), the wall on the lip
    await page.goto(`/?scene=prologue-proto&spawn=dead-end&trial=surface-wall${webgl}`);
    const r0 = await waitRoom(page, 'r.ready && r.playing && r.trial', 60_000);
    expect(r0.orb).toBe('hand');
    const segments = r0.trial?.segments ?? 0;
    expect(segments).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await page.mouse.move(cursor.x, cursor.y);
    // the pointer lock: a click can land before the page takes it (once in a busy full check on WebGL2), so click again
    for (let attempt = 0; ; attempt++) {
      await page.mouse.down();
      await page.mouse.up();
      try {
        await waitRoom(page, 'r.locked === true', 5_000);
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        await page.waitForTimeout(1_200);
      }
    }

    // 1. before the orb is placed: the wall stops you (the body's radius in front of it, short of the edge)
    await lookAt(page, [WALL_X, 0.5, WALL_NEAR_Z]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'wall.png') });
    await lookAt(page, [WALL_X, 1.2, r0.position.z - 6]);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3_000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    const r1 = await room(page);
    out.stopped = r1.position;
    expect(r1.trial?.off).toBe(0);
    expect(r1.position.z).toBeGreaterThan(WALL_NEAR_Z + BODY_RADIUS - 0.1);
    // the wall in front of the feet, the edge and the valley beyond it
    const lip: [number, number, number] = [WALL_X, 0.2, EDGE_Z - 0.8];
    await lookAt(page, lip);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'stopped.png') });

    // 2. place the vidro on the dead end's pedestal: the whole wall is inside the sphere, its collider goes
    await lookAt(page, PEDESTAL_ORB);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const r2 = await waitRoom(
      page,
      "r.orb === 'pedestal' && r.sphereRadius > 3.99 && r.trial && r.trial.off === r.trial.segments",
      5_000,
    );
    expect(r2.lastAction).toBe('place');
    // the same view: the wall is cut from view inside the sphere, the bridge is there
    await lookAt(page, lip);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'open.png') });

    // ...and you walk through the wall onto the bridge
    const r3 = await walkTo(page, WALL_X, EDGE_Z - 1.0, 0.3);
    out.through = r3.position;
    expect(r3.position.z).toBeLessThan(EDGE_Z - 0.6);
    await page.screenshot({ path: join(shotDir, 'through.png') });

    // 3. back into the wall (on the shore): the orb will not come, it trembles, the wall stays open
    await walkTo(page, WALL_X, WALL_FAR_Z + 0.1, 0.25);
    const r4 = await stepInto(page, IN_WALL.minZ, IN_WALL.maxZ);
    out.inWall = r4.position;
    expect(r4.position.z).toBeLessThan(WALL_NEAR_Z + BODY_RADIUS);
    expect(r4.position.z).toBeGreaterThan(EDGE_Z);
    expect(r4.events).not.toContain('shake:pickup');
    await lookAt(page, PEDESTAL_ORB);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const r5 = await waitRoom(page, "r.lastAction === 'pickup-denied' && r.shaking", 3_000);
    await page.screenshot({ path: join(shotDir, 'denied.png') });
    out.denied = { position: r5.position, events: r5.events.slice(-3) };
    expect(r5.orb).toBe('pedestal');
    // the same refusal as on the bridge's footing (S-02): the shake, for the pickup
    expect(r5.events).toContain('shake:pickup');
    expect(r5.trial?.off).toBe(segments);
    expect(r5.position.z).toBeLessThan(WALL_NEAR_Z + BODY_RADIUS);

    // 4. a few steps back toward the dead end, the orb comes, and the wall is solid again
    await walkTo(page, WALL_X, WALL_NEAR_Z + 1.0, 0.25);
    await lookAt(page, PEDESTAL_ORB);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const r6 = await waitRoom(page, "r.lastAction === 'pickup' && r.orb === 'hand'", 3_000);
    expect(r6.events).toContain('pickup:pedestal');
    expect(r6.trial?.off).toBe(0);
    await lookAt(page, [WALL_X, 1.2, r6.position.z - 6]);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2_000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);
    const r7 = await room(page);
    out.stoppedAgain = r7.position;
    expect(r7.position.z).toBeGreaterThan(WALL_NEAR_Z + BODY_RADIUS - 0.1);

    writeFileSync(join(outDir, `${backend}.json`), JSON.stringify(out, null, 2));
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
