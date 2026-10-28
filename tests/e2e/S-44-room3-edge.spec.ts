import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-44 (発案者 2026-10-28): 部屋3's lookout and the peek image's far end — on both render paths, with real input.
 *  1. 部屋3の端: the lookout (見晴らし台) at the valley's front is wide: peeking from three spots on it (where its view starts,
 *     out at the deck's railing, back toward its way in) the drop's pixels show in the vidro's circle, through the gap the
 *     crumbled wall leaves in the peek image and the slot of the shelter on the north roof. From where the slope arrives the
 *     lookout is in the picture (screen). (That from nowhere else, nor after placing on either pedestal, the drop is seen: the
 *     S-41 spec's 部屋3 test, on this layout.)
 *  2. 覗く像の遠端 150m (目印は遠くても描く): peeking in the courtyard from A toward the town, the draw calls are down (S-41: 274, aim
 *     210 or under), things past 150 m are left out and none of the back layer; peeking from the slope's brow at エリア1's
 *     chimney (目印, about 190 m) the chimney stays in the vidro's image — its pixels against the same picture with it hidden —
 *     drawn though it lies past the far end.
 * Measured as S-27 / S-41 did: a thing hidden by its mark against the same picture, the pixels that move between two shots of
 * the same picture left out. Screens → artifacts/screens/S-44/<backend>/, the runs → artifacts/S-44/.
 */
test.use({ locale: 'ja-JP' });

type P3 = [number, number, number];
interface V3 {
  x: number;
  y: number;
  z: number;
}
interface RoomProbe {
  ready: boolean;
  position: V3;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  locked: boolean;
  peekAmount: number;
  orb: 'bench' | 'hand' | 'pedestal';
  drawCalls: number;
  triangles: number;
  fallRescues: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  peekFar: { far: number; leftOut: number; leftOutBack: number; keptBack: number; keptLandmarks: number };
  area1: { state: string };
  layout: {
    area1: {
      chimneyTop: P3;
      room2: { drop: P3 };
      room3: {
        terrace: { minX: number; maxX: number; minZ: number; maxZ: number };
        summitY: number;
        edge: P3;
        drop: P3;
        railing: { min: P3; max: P3 };
      };
    };
  };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const SENSITIVITY = 0.0022;
const BENIGN = /GPU stall|powerPreference/i;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
/** S-41: peeking in the courtyard from A toward the town (the haze's far end, 300 m in the town); S-44 aims at 210 or under. */
const S41_COURT_A_PEEK = 274;
const COURT_A_AIM = 210;
const PEEK_FAR = 150;

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
  opts: { within?: number; timeout?: number } = {},
): Promise<RoomProbe> {
  const { within = 0.3, timeout = 30_000 } = opts;
  const end = Date.now() + timeout;
  const r0 = await room(page);
  await lookAt(page, [x, r0.position.y + r0.eyeHeight, z]);
  await page.keyboard.down('KeyW');
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
  }
}

async function lock(page: Page): Promise<void> {
  cursor.x = 640;
  cursor.y = 360;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.up();
  await waitRoom(page, 'r.locked === true');
}

/**
 * Records the scene the room draws (?debug=1: the renderer is the page's), so a thing can be hidden: the drop by name (its
 * children: the room shows and hides the drop itself each frame, S-41), a landmark by its mark (S-44: userData.landmark).
 */
async function hookScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __vidroDebug: { renderer: { render: (...a: unknown[]) => unknown } };
      __s44Scene?: unknown;
      __s44Hide?: (what: string, hidden: boolean) => number;
    };
    const r = w.__vidroDebug.renderer;
    const inner = r.render.bind(r);
    r.render = (...args: unknown[]) => {
      const scene = args[0] as { isScene?: boolean };
      if (scene?.isScene) w.__s44Scene = scene;
      return inner(...args);
    };
    type O = {
      visible: boolean;
      userData: Record<string, unknown>;
      children: O[];
      traverse: (f: (o: O) => void) => void;
    };
    w.__s44Hide = (what, hidden) => {
      const scene = w.__s44Scene as (O & { getObjectByName: (n: string) => O | undefined }) | undefined;
      if (!scene) return 0;
      if (what.startsWith('landmark:')) {
        const mark = what.slice('landmark:'.length);
        let n = 0;
        scene.traverse((o) => {
          if (o.userData.landmark === mark) {
            o.visible = !hidden;
            n++;
          }
        });
        return n;
      }
      const o = scene.getObjectByName(what);
      if (!o) return 0;
      for (const c of o.children) c.visible = !hidden;
      return 1;
    };
  });
  await page.waitForTimeout(200);
}

/**
 * What a thing adds to the picture now: shown, hidden, shown, hidden — the pixels (share of `region`, a circle in 0..1 of the
 * picture's height, or the whole picture) that change both times with it and are the same in both shots of it shown and of it
 * hidden (the motes and the glimmers drift between shots: they change one way, not both).
 */
async function addedPixels(
  page: Page,
  what: string,
  region: { x: number; y: number; r: number } | null,
): Promise<number> {
  const hide = (hidden: boolean) =>
    page.evaluate(
      ([n, h]) => (window as unknown as { __s44Hide: (n: string, h: boolean) => number }).__s44Hide(n, h),
      [what, hidden] as const,
    );
  const shots: Buffer[] = [];
  for (const hidden of [false, true, false, true]) {
    expect(await hide(hidden), `${what} found`).toBeGreaterThan(0);
    await page.waitForTimeout(150);
    shots.push(await page.screenshot());
  }
  await hide(false);
  await page.waitForTimeout(100);
  return page.evaluate(
    async ([b64s, reg]) => {
      const read = async (b64: string) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { d: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
      };
      const [S1, H1, S2, H2] = await Promise.all(b64s.map(read));
      if (!S1 || !H1 || !S2 || !H2) return 0;
      const lum = (d: Uint8ClampedArray, i: number) =>
        (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      let n = 0;
      let changed = 0;
      for (let y = 0; y < S1.h; y += 2)
        for (let x = 0; x < S1.w; x += 2) {
          if (reg) {
            const cx = reg.x * S1.w;
            const cy = reg.y * S1.h;
            const rr = reg.r * S1.h * 0.9;
            if ((x - cx) ** 2 + (y - cy) ** 2 > rr * rr) continue;
          }
          const i = (y * S1.w + x) * 4;
          n++;
          const s1 = lum(S1.d, i);
          const s2 = lum(S2.d, i);
          const h1 = lum(H1.d, i);
          const h2 = lum(H2.d, i);
          if (Math.abs(s1 - s2) > 0.03 || Math.abs(h1 - h2) > 0.03) continue;
          if (Math.abs(s1 - h1) > 0.06 && Math.abs(s2 - h2) > 0.06) changed++;
        }
      return n > 0 ? changed / n : 0;
    },
    [shots.map((b) => b.toString('base64')), region] as const,
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-44', backend);
  const runDir = join(root, 'artifacts/S-44');

  test(`S-44 部屋3: the lookout at the valley's front is in sight on arrival, and from three spots on it, peeking, the drop shows [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
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
    // where the slope arrives: the lookout ahead at the valley's front (探さなくても目に入る)
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'arrive.png') });
    // into the lookout by its way in (east of its walls), then three spots on it
    const wall = r3.railing;
    const midZ = r3.edge[2];
    await walkTo(page, wall.max[0] + 0.6, midZ, { within: 0.25 });
    const spots: Record<string, [number, number]> = {
      edge: [r3.edge[0], r3.edge[2]],
      railing: [r3.terrace.minX - 0.25, midZ + 0.35],
      back: [r3.edge[0] + 0.6, midZ - 0.55],
    };
    const share: Record<string, number> = {};
    for (const [name, [x, z]] of Object.entries(spots)) {
      await walkTo(page, x, z, { within: 0.15 });
      await lookAt(page, r3.drop);
      await page.mouse.down({ button: 'right' });
      const p = await waitRoom(page, 'r.peekAmount > 0.999');
      await page.waitForTimeout(500);
      if (name === 'edge') await page.screenshot({ path: join(shotDir, 'edge-peek.png') });
      share[name] = await addedPixels(page, 'area1-drop:area1-room3', p.orbScreen);
      await page.mouse.up({ button: 'right' });
      await waitRoom(page, 'r.peekAmount === 0');
      if (name === 'edge') {
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shotDir, 'edge.png') });
      }
    }
    writeFileSync(
      join(runDir, `lookout-${backend}.json`),
      JSON.stringify({ backend, share, errors }, null, 2),
    );
    for (const [name, v] of Object.entries(share))
      expect(v, `the drop through the gap, peeking from the lookout (${name})`).toBeGreaterThan(0.003);
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-44 the peek image ends at ${PEEK_FAR} m: fewer draw calls toward the town, the chimney (目印) kept in the vidro past it, the back layer never left out [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const errors = collectErrors(page);
    const runs: Record<string, unknown> = {};
    const setFar = (m: number | null) =>
      page.evaluate(
        (v) =>
          (window.__vidro.sceneProbe as { room: { setPeekFar: (m: number | null) => void } }).room.setPeekFar(
            v,
          ),
        m,
      );
    for (const [name, spawn, at] of [
      // toward the town from the courtyard (S-41: 274); the slope's brow toward the street's chimney (目印, about 190 m)
      ['court-a', 'area1-court-a', 'room2'],
      ['brow-chimney', 'slope', 'chimney'],
      // for the record: 部屋3's lookout toward the drop, the ridge's end toward the workshop's hill
      ['edge', 'area1-edge&area1Drop=1,2', 'room3'],
      ['ridge-workshop', 'area1-shortcut', 'workshop'],
    ] as const) {
      await page.goto(`/?scene=prologue-proto&spawn=${spawn}&debug=1${webgl}`);
      const r0 = await waitRoom(page, "r.ready === true && r.orb === 'hand'", 90_000);
      if (spawn !== 'slope') await waitRoom(page, "r.area1.state === 'ready'", 90_000);
      await lock(page);
      await hookScene(page);
      const lay = r0.layout.area1;
      const target: P3 =
        at === 'room2'
          ? lay.room2.drop
          : at === 'room3'
            ? lay.room3.drop
            : at === 'chimney'
              ? lay.chimneyTop
              : [0, 4, 6];
      await lookAt(page, target);
      await page.mouse.down({ button: 'right' });
      await waitRoom(page, 'r.peekAmount > 0.999');
      await page.waitForTimeout(600);
      const own = await room(page);
      if (name === 'brow-chimney') await page.screenshot({ path: join(shotDir, 'brow-chimney-peek.png') });
      const chimney =
        name === 'brow-chimney' ? await addedPixels(page, 'landmark:area1-chimney', own.orbScreen) : null;
      // everything drawn into it, for the count of what the far end saves
      await setFar(1000);
      await page.waitForTimeout(400);
      const all = await room(page);
      await setFar(null);
      await page.mouse.up({ button: 'right' });
      runs[name] = {
        drawCalls: own.drawCalls,
        triangles: own.triangles,
        peekFar: own.peekFar,
        allDrawCalls: all.drawCalls,
        chimneyInOrb: chimney,
      };
      expect(own.peekFar.far, name).toBe(PEEK_FAR);
      expect(own.peekFar.leftOutBack, `${name}: nothing of the back layer left out`).toBe(0);
      expect(own.drawCalls).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(own.triangles).toBeLessThanOrEqual(BUDGET.triangles);
      if (name === 'court-a') {
        expect(own.peekFar.leftOut, 'things past 150 m left out').toBeGreaterThan(40);
        expect(all.drawCalls - own.drawCalls).toBeGreaterThan(40);
        expect(own.drawCalls, `down from ${S41_COURT_A_PEEK}`).toBeLessThanOrEqual(COURT_A_AIM);
      }
      if (name === 'brow-chimney') {
        // past the far end things are left out, yet the landmark is drawn: the chimney's pixels stay in the vidro's circle
        expect(own.peekFar.leftOut).toBeGreaterThan(0);
        expect(own.peekFar.keptLandmarks).toBeGreaterThan(0);
        expect(chimney, 'the chimney in the vidro').toBeGreaterThan(0.003);
      }
    }
    writeFileSync(
      join(runDir, `peek-far-${backend}.json`),
      JSON.stringify({ backend, runs, errors }, null, 2),
    );
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
