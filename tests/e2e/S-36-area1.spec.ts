import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-36: エリア1's way in and its first room, on both render paths.
 *  1. the scripted play (?autoplay=1): home → dive → the prologue → the slope's brow, from where エリア1 is built and warmed
 *     behind the scenes (S-40: added at once out of view, or out of the haze in view) → along the road into the morning →
 *     the entrance plaza → 部屋1: peek, place, through the crumbled wall, the drop, back out, the vidro picked up (S-40: on
 *     through 部屋2 and 部屋3 and down the shortcut, tests/e2e/S-40-*.spec.ts). A tracer (as S-38's) notes every render pipeline three
 *     makes: none for glass while playing, none at all once エリア1 is ready (it was all made before it was seen). The
 *     longest frame while エリア1 is built and warmed; the loading's warm-up frame within 300 draw calls and a second
 *  2. along the road with real input: the sky goes from before dawn to morning as you walk east, and back as you walk back
 *     (the same view: the sky brighter at the entrance plaza's end than at the gate's, then as before); no black frame
 *  3. 部屋1 with real input: the wall stops you; peeking, the drop shows through the vidro; placed, the wall is cut and you
 *     walk through to the drop; standing in the wall the vidro will not come; out of it, it comes and the wall is back;
 *     the lamps toward the next room have lit
 *  4. the views the slice is judged by: on the road where the sky moves, up at the chimney from the entrance plaza, the
 *     drop through the vidro in 部屋1 (from 3), and the budget all round in the entrance plaza and peeking in 部屋1
 * Screens → artifacts/screens/S-36/<backend>/, the runs → artifacts/S-36/.
 */
test.use({ locale: 'ja-JP' });

type P3 = [number, number, number];
interface V3 {
  x: number;
  y: number;
  z: number;
}
interface Area1Probe {
  state: 'waiting' | 'building' | 'compiling' | 'built' | 'warming' | 'ready';
  startedAt: number | null;
  addedAt: number | null;
  readyAt: number | null;
  addedInView: boolean;
  /** S-40: out of the haze (0..1), its parts shown of all. */
  appear: number;
  shown: number;
  entries: number;
  frames: number;
  worstMs: number;
  warmed: number;
  wall: { segments: number; off: number };
  next: number;
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
  orb: 'bench' | 'hand' | 'pedestal';
  pedestal: string | null;
  sphereRadius: number;
  shaking: boolean;
  target: 'bench' | 'pedestal' | 'drop' | null;
  events: string[];
  lastAction: string | null;
  backPassFrames: number;
  drawCalls: number;
  triangles: number;
  fallRescues: number;
  dropTaken: boolean;
  daylight: number;
  areas: Record<string, { drops: number; taken: number }>;
  drops: { id: string; area: string; state: 'waiting' | 'flying' | 'taken' }[];
  area1: Area1Probe;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  autoplay: { step: string; done: boolean; worstMs: number; steps: Record<string, number> } | null;
  layout: {
    area1: {
      plaza: { center: P3; radius: number };
      roadFromX: number;
      roadToX: number;
      pedestalOrb: P3;
      drop: P3;
      wall: { min: P3; max: P3 };
      alley: { minX: number; maxX: number; minZ: number; maxZ: number };
      chimneyTop: P3;
    };
  };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
/** S-03 mouse sensitivity (rad per pixel). */
const SENSITIVITY = 0.0022;
const BENIGN = /GPU stall|powerPreference/i;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
/** S-06's limit on a frame of play; the aim while エリア1 is built and warmed (spine S-36) is 50 ms. */
const PLAY_FRAME_MS = 200;
/** The loading's warm-up frame (S-38: 0.55 s WebGPU, 0.72 s WebGL2): kept under a second (S-38 の発案者の判断). */
const WARM_FRAME_MS = 1000;

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

interface Made {
  at: string;
  object: string;
  material: string;
  glass: boolean;
  quad: boolean;
}
declare global {
  interface Window {
    __s36?: Made[];
  }
}

/** S-38's tracer (runs in the page before its script): every render pipeline three creates, and where the game was. */
function installTracer(): void {
  interface Material {
    name?: string;
    type?: string;
    useTransmission?: boolean;
    transmission?: number;
    transmissionNode?: unknown;
  }
  interface RenderObject {
    object?: {
      name?: string;
      type?: string;
      isQuadMesh?: boolean;
      userData?: { name?: string };
      parent?: unknown;
    };
    material?: Material;
  }
  interface Backend {
    createRenderPipeline(renderObject: RenderObject, promises?: unknown): unknown;
  }
  const made: Made[] = [];
  window.__s36 = made;
  const readsBackdrop = (m: Material | undefined): boolean => {
    if (!m) return false;
    if (typeof m.useTransmission === 'boolean') return m.useTransmission;
    return (m.transmission ?? 0) > 0 || (m.transmissionNode ?? null) !== null;
  };
  const named = (o: RenderObject['object']): string => {
    for (let p = o as { name?: string; userData?: { name?: string }; parent?: unknown } | undefined; p; ) {
      if (p.name && /^(area1|A\d+_)/.test(p.name)) return p.name;
      const n = p.userData?.name;
      if (typeof n === 'string' && /^A\d+_/.test(n)) return n;
      p = p.parent as typeof p;
    }
    return o?.name || o?.type || '?';
  };
  const where = (): string => {
    const p = window.__vidro?.sceneProbe as
      | {
          screen?: string;
          transition?: { id: string } | null;
          load?: { ready: boolean };
          room?: { playing: boolean; autoplay: { step: string } | null };
        }
      | undefined;
    if (p?.room?.playing && p.room.autoplay) return `game:${p.room.autoplay.step}`;
    if (p?.room?.playing) return 'game';
    if (p?.load && !p.load.ready) return 'loading';
    return p?.transition?.id ?? p?.screen ?? '?';
  };
  const install = (debug: { renderer: { backend: Backend } }): void => {
    const backend = debug.renderer.backend;
    const create = backend.createRenderPipeline;
    backend.createRenderPipeline = function (this: Backend, ro: RenderObject, promises?: unknown) {
      made.push({
        at: where(),
        object: named(ro.object),
        material: ro.material?.name || ro.material?.type || '?',
        glass: readsBackdrop(ro.material),
        quad: ro.object?.isQuadMesh === true,
      });
      return create.call(this, ro, promises);
    };
  };
  Object.defineProperty(window, '__vidroDebug', {
    configurable: true,
    set(v: { renderer: { backend: Backend } }) {
      Object.defineProperty(window, '__vidroDebug', { value: v, writable: true, configurable: true });
      install(v);
    },
  });
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
  opts: {
    within?: number;
    timeout?: number;
    sprint?: boolean;
    pitch?: number;
    each?: (r: RoomProbe) => void;
  } = {},
): Promise<RoomProbe> {
  const { within = 0.3, timeout = 30_000, sprint = false } = opts;
  const end = Date.now() + timeout;
  const r0 = await room(page);
  await lookAt(page, [x, r0.position.y + r0.eyeHeight + Math.tan(opts.pitch ?? 0) * 10, z]);
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

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/**
 * Mean luminance, near-black share, share of pixels brighter than `bright`, and share of warm bright ones (the light drop's
 * core through the vidro: luminance over 0.75, red over blue by more than 0.05), in a region of the page (all by default)
 * or a circle (pixels).
 */
async function measure(
  page: Page,
  png: Buffer,
  region?: Region,
  circle?: { x: number; y: number; r: number },
  bright = 0.85,
): Promise<{ mean: number; dark: number; bright: number; warm: number }> {
  return page.evaluate(
    async ([b64, reg, circ, lim]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const r = (reg as Region | null) ?? { x0: 0, y0: 0, x1: bmp.width, y1: bmp.height };
      const k = circ as { x: number; y: number; r: number } | null;
      let sum = 0;
      let dark = 0;
      let lit = 0;
      let warm = 0;
      let n = 0;
      for (let y = r.y0; y < r.y1; y += 2)
        for (let x = r.x0; x < r.x1; x += 2) {
          if (k && Math.hypot(x - k.x, y - k.y) > k.r) continue;
          const i = (y * bmp.width + x) * 4;
          const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
          sum += l;
          if (l < 0.06) dark++;
          if (l > (lim as number)) lit++;
          if (l > 0.75 && ((d[i] ?? 0) - (d[i + 2] ?? 0)) / 255 > 0.05) warm++;
          n++;
        }
      const k1 = Math.max(1, n);
      return { mean: sum / k1, dark: dark / k1, bright: lit / k1, warm: warm / k1 };
    },
    [png.toString('base64'), region ?? null, circle ?? null, bright] as const,
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-36', backend);

  test(`S-36 autoplay: エリア1 built from the brow (added out of view, or out of the haze), the road into the morning, its rooms; nothing compiled once it is seen [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(660_000);
    mkdirSync(join(root, 'artifacts/S-36'), { recursive: true });
    const errors = collectErrors(page);
    await page.addInitScript(installTracer);
    await page.goto(`/?scene=prologue-proto&autoplay=1&autoplayTo=area1&debug=1${webgl}`);
    // S-40: the script plays on through 部屋2 and 部屋3 and down the shortcut
    const done = await waitRoom(page, 'r.autoplay && r.autoplay.done && r.areas.area1.taken === 3', 600_000);
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
    const { made, load, phases } = await page.evaluate(() => {
      const p = window.__vidro.sceneProbe as {
        load: { seconds: number; steps: { name: string; seconds: number; maxFrameMs: number }[] };
        phases: Record<
          string,
          { frames: number; maxFrameMs: number; maxDrawCalls: number; maxTriangles: number }
        >;
      };
      return { made: window.__s36 ?? [], load: p.load, phases: p.phases };
    });
    const a = done.area1;
    const warmFrame = load.steps.find((s) => s.name === 'compile game (screen)')?.maxFrameMs ?? 0;
    // the steps from the road on (autopilot.ts area1Script, S-40: through 部屋2・3 and the shortcut): エリア1 is ready and seen
    // from there (the room's record of the steps is in the order they were played)
    const order = Object.keys(done.autoplay?.steps ?? {});
    const seenFrom = [...order.slice(Math.max(0, order.indexOf('walk-road'))), 'done'];
    expect(seenFrom).toContain('walk-shortcut');
    const afterSeen = made.filter((m) => seenFrom.some((s) => m.at === `game:${s}`));
    // and the script played them all (the check above cannot pass by never getting there)
    expect(done.autoplay?.steps?.['touch-drop1'] ?? 0).toBeGreaterThan(0);
    writeFileSync(
      join(root, `artifacts/S-36/autoplay-${backend}.json`),
      JSON.stringify(
        {
          backend,
          area1: a,
          daylight: done.daylight,
          areas: done.areas,
          warmFrameMs: warmFrame,
          loading: phases.loading,
          game: phases.game,
          steps: done.autoplay?.steps,
          inPlay: made.filter((m) => m.at.startsWith('game:')),
          errors,
        },
        null,
        2,
      ),
    );

    // the whole way: the prologue's drop and 部屋1's, counted by area; in the morning at the end, the vidro in hand
    expect(done.areas).toEqual({ prologue: { drops: 1, taken: 1 }, area1: { drops: 3, taken: 3 } });
    expect(done.daylight).toBe(1);
    expect(done.orb).toBe('hand');
    expect(done.events).toContain('dropTaken');
    expect(done.fallRescues).toBe(0);
    // エリア1 was built and warmed behind the scenes from the slope's brow; S-40: added at once out of view, or (in view: the
    // summit and the shortcut are in the picture down the slope) out of the haze, its parts shown one at a time
    expect(a.state).toBe('ready');
    expect(a.appear).toBe(1);
    expect(a.shown).toBe(a.entries);
    expect(a.warmed).toBeGreaterThan(0);
    expect(a.worstMs, 'the longest frame while エリア1 was built and warmed').toBeLessThan(PLAY_FRAME_MS);
    // no glass compiled in play (S-38), and nothing at all from the road on (it was all made before it was seen)
    expect(made.filter((m) => m.at.startsWith('game:') && m.glass).map((m) => `${m.at} ${m.object}`)).toEqual(
      [],
    );
    expect(
      afterSeen.map((m) => `${m.at} ${m.object} ${m.material}`),
      'pipelines made once エリア1 is seen',
    ).toEqual([]);
    // the loading's warm-up frame: within the budget of draw calls, under a second (S-38's judgement)
    expect(phases.loading?.maxDrawCalls ?? 0).toBeGreaterThan(0);
    expect(phases.loading?.maxDrawCalls ?? 999, 'draw calls in the loading frame').toBeLessThanOrEqual(
      BUDGET.drawCalls,
    );
    expect(warmFrame, 'the loading warm-up frame (ms)').toBeGreaterThan(0);
    expect(warmFrame, 'the loading warm-up frame (ms)').toBeLessThan(WARM_FRAME_MS);
    expect(phases.game?.maxDrawCalls ?? 999).toBeLessThanOrEqual(BUDGET.drawCalls);
    expect(phases.game?.maxTriangles ?? 1e9).toBeLessThanOrEqual(BUDGET.triangles);
    expect(phases.game?.maxFrameMs ?? 999).toBeLessThan(PLAY_FRAME_MS);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-36 the road with real input: before dawn at the gate, morning at the entrance plaza, and back [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    // in the central plaza before the open east gate, after the close, the vidro in hand
    await page.goto(`/?scene=prologue-proto&spawn=east&finaleHold=4.5&finaleOrb=hand${webgl}`);
    const r0 = await waitRoom(
      page,
      "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
      90_000,
    );
    const { roadFromX, roadToX, plaza } = r0.layout.area1;
    const z = plaza.center[2];
    await lock(page);
    await walkTo(page, roadFromX + 1, z, { within: 0.5 });
    // the same view at each place: along the road, up a little (the sky over the way on)
    const view = async (name: string): Promise<{ daylight: number; sky: number; dark: number }> => {
      const r = await waitRoom(page, 'r.speed < 0.03');
      await lookAt(page, [r.position.x + 30, r.position.y + r.eyeHeight + 30 * Math.tan(0.18), z]);
      await page.waitForTimeout(400);
      const png = await page.screenshot({ path: join(shotDir, `road-${name}.png`) });
      const sky = await measure(page, png, { x0: 0, y0: 0, x1: 1280, y1: 200 });
      const all = await measure(page, png);
      return { daylight: (await room(page)).daylight, sky: sky.mean, dark: all.dark };
    };
    const samples: { x: number; daylight: number }[] = [];
    const each = (r: RoomProbe) => samples.push({ x: r.position.x, daylight: r.daylight });
    const atGate = await view('gate');
    await walkTo(page, (roadFromX + roadToX) / 2, z, { within: 0.5, sprint: true, each });
    const middle = await view('middle');
    await walkTo(page, roadToX - 1, z, { within: 0.5, sprint: true, each });
    const atEnd = await view('end');
    // and back: the sky goes back to before dawn as you walk back
    await walkTo(page, roadFromX + 1, z, { within: 0.5, sprint: true, each });
    const back = await view('back');
    writeFileSync(
      join(root, `artifacts/S-36/road-${backend}.json`),
      JSON.stringify({ backend, atGate, middle, atEnd, back, samples: samples.length, errors }, null, 2),
    );
    expect(atGate.daylight).toBe(0);
    expect(middle.daylight).toBeGreaterThan(0.2);
    expect(middle.daylight).toBeLessThan(0.8);
    expect(atEnd.daylight).toBe(1);
    expect(back.daylight).toBe(0);
    // the sky over the way brightens toward the morning, and is as before once back
    expect(middle.sky).toBeGreaterThan(atGate.sky + 0.03);
    expect(atEnd.sky).toBeGreaterThan(middle.sky + 0.03);
    expect(Math.abs(back.sky - atGate.sky)).toBeLessThan(0.02);
    // by where you stand, smoothly: no jump between two samples a few cm apart
    const sorted = samples.slice().sort((p, q) => p.x - q.x);
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1] as { x: number; daylight: number };
      const q = sorted[i] as { x: number; daylight: number };
      if (q.x - p.x < 0.5) expect(Math.abs(q.daylight - p.daylight)).toBeLessThan(0.05);
    }
    // never a black screen (黒い画面を使わない)
    for (const s of [atGate, middle, atEnd, back]) expect(s.dark).toBeLessThan(0.02);
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-36 部屋1 with real input: the wall, the peek, place, through to the drop, the pickup refused in the wall and taken out of it [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-36'), { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&spawn=area1-alley${webgl}`);
    const r0 = await waitRoom(
      page,
      "r.ready === true && r.orb === 'hand' && r.area1.state === 'ready'",
      90_000,
    );
    const { wall, pedestalOrb, drop, alley } = r0.layout.area1;
    const x = (alley.minX + alley.maxX) / 2 - 0.4;
    await lock(page);
    // the wall stops you before it
    await lookAt(page, [x, r0.position.y + 1.4, wall.max[2] + 10]);
    const pushed = await pushUntilStopped(page, 'KeyW');
    const stopped = pushed.at(-1) as RoomProbe;
    expect(stopped.position.z).toBeLessThan(wall.min[2]);
    expect(stopped.position.z).toBeGreaterThan(wall.min[2] - 0.7);
    expect(stopped.area1.wall.off).toBe(0);
    // 覗く: through the vidro the wall is gone and the drop's light shows behind it (a metre before the wall, looking at
    // where the drop hovers; the same place and look again once it is taken, to tell its light from the vidro's glints)
    const peekFrom = wall.min[2] - 1.0;
    const peekAt = async (name: string) => {
      await walkTo(page, x, peekFrom, { within: 0.12 });
      await waitRoom(page, 'r.speed < 0.03');
      await lookAt(page, drop);
      await page.waitForTimeout(200);
      const passes = (await room(page)).backPassFrames;
      await page.mouse.down({ button: 'right' });
      const p = await waitRoom(page, 'r.peekAmount > 0.999');
      await page.waitForTimeout(400);
      const png = await page.screenshot({ path: join(shotDir, `${name}.png`) });
      const q = await room(page);
      await page.mouse.up({ button: 'right' });
      await waitRoom(page, 'r.peekAmount === 0');
      // the orb's circle in pixels (orbScreen: normalized, its radius a share of the height), a little inside its rim
      const circle = { x: q.orbScreen.x * 1280, y: q.orbScreen.y * 720, r: q.orbScreen.r * 720 * 0.85 };
      return { peeking: p.peeking, passes, room: q, inOrb: await measure(page, png, undefined, circle) };
    };
    const withDrop = await peekAt('room1-peek');
    const peekRoom = withDrop.room;
    expect(withDrop.peeking).toBe(true);
    expect(peekRoom.backPassFrames).toBeGreaterThan(withDrop.passes + 5);
    expect(peekRoom.drawCalls, 'draw calls peeking in 部屋1').toBeLessThanOrEqual(BUDGET.drawCalls);
    expect(peekRoom.triangles).toBeLessThanOrEqual(BUDGET.triangles);
    // 置く: the sphere grows and cuts the whole wall
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const grown = await waitRoom(
      page,
      'r.sphereRadius > 3.99 && r.area1.wall.off === r.area1.wall.segments',
      5_000,
    );
    expect(grown.area1.wall.segments).toBeGreaterThan(10);
    await lookAt(page, [x, grown.position.y + 1.2, wall.max[2] + 2]);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'room1-placed.png') });
    // through the wall to the drop, and take it
    await walkTo(page, drop[0] + 0.2, wall.max[2] + 0.6, { within: 0.3 });
    await lookAt(page, drop);
    await waitRoom(page, "r.target === 'drop'", 5_000);
    await page.keyboard.press('KeyE');
    const taken = await waitRoom(page, 'r.areas.area1.taken === 1', 6_000);
    expect(taken.events).toContain('dropTaken');
    expect(taken.areas.prologue?.taken).toBe(0);
    // back into the wall: from there the vidro will not come (it would shut you in)
    await walkTo(page, x, wall.min[2] - 0.05, { within: 0.2 });
    await waitRoom(page, 'r.speed < 0.03');
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const refused = await waitRoom(page, 'r.shaking === true', 3_000);
    expect(refused.orb).toBe('pedestal');
    expect(refused.events).toContain('shake:pickup');
    // out of it, it comes; the wall is back at once and stops you as before
    await walkTo(page, x, wall.min[2] - 1.0, { within: 0.25 });
    await waitRoom(page, 'r.speed < 0.03');
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    const back = await waitRoom(page, "r.orb === 'hand' && r.area1.wall.off === 0", 3_000);
    expect(back.events).toContain('pickup:pedestal');
    // the same peek with the drop taken: what the drop's light added through the vidro is gone (S-36 measured 0.074 of
    // the vidro's circle warm with it, 0 without, both ways)
    const noDrop = await peekAt('room1-peek-taken');
    expect(withDrop.inOrb.warm, 'the drop’s light through the vidro').toBeGreaterThan(
      noDrop.inOrb.warm + 0.03,
    );
    await lookAt(page, [x, back.position.y + 1.4, wall.max[2] + 10]);
    const again = (await pushUntilStopped(page, 'KeyW')).at(-1) as RoomProbe;
    expect(again.position.z).toBeLessThan(wall.min[2]);
    // the lamps toward the next room have lit (次の部屋の方向が見える): look out of the alley at the slope's foot
    const lit = await waitRoom(page, 'r.area1.next >= 1', 8_000);
    await walkTo(page, x + 0.4, alley.minZ - 0.9, { within: 0.3 });
    await lookAt(page, [alley.maxX + 6, lit.position.y + 2, alley.minZ - 6]);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'room1-next.png') });
    writeFileSync(
      join(root, `artifacts/S-36/room1-${backend}.json`),
      JSON.stringify(
        {
          backend,
          inOrbPeek: withDrop.inOrb,
          inOrbTaken: noDrop.inOrb,
          peek: { draws: peekRoom.drawCalls, tris: peekRoom.triangles },
          errors,
        },
        null,
        2,
      ),
    );
    expect((await room(page)).fallRescues).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-36 the views: the road where the sky moves, the chimney from the entrance plaza; the budget all round [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    const shots: Record<string, { mean: number; dark: number; warm: number }> = {};
    const budget: Record<string, { drawCalls: number; triangles: number }> = {};
    for (const [name, spawn, extra] of [
      ['road', 'area1-road', ''],
      ['plaza-chimney', 'area1-plaza', ''],
      ['alley', 'area1-alley', ''],
      // S-40: the slope's foot, looking up the first flight (S-36's shut gate is gone: the slope goes on to the summit)
      ['slope', 'area1-slope', ''],
      // 部屋1's drop taken (a dev hold): the lamps toward the next room lit up the slope to the shut gate
      ['slope-next', 'area1-slope', '&area1Drop=taken'],
    ] as const) {
      await page.goto(`/?scene=prologue-proto&spawn=${spawn}${extra}${webgl}`);
      const r = await waitRoom(page, "r.ready === true && r.area1.state === 'ready'", 90_000);
      if (extra) await waitRoom(page, 'r.area1.next >= 1', 10_000);
      if (spawn === 'area1-road') {
        expect(r.daylight).toBeGreaterThan(0.3);
        expect(r.daylight).toBeLessThan(0.7);
      } else expect(r.daylight).toBe(1);
      await lock(page);
      await page.waitForTimeout(800);
      const png = await page.screenshot({ path: join(shotDir, `${name}.png`) });
      const m = await measure(page, png);
      shots[name] = { mean: m.mean, dark: m.dark, warm: m.warm };
      const q = await room(page);
      budget[name] = { drawCalls: q.drawCalls, triangles: q.triangles };
      expect(q.grounded).toBe(true);
    }
    // all round in the entrance plaza (8 headings)
    await page.goto(`/?scene=prologue-proto&spawn=area1-plaza${webgl}`);
    await waitRoom(page, "r.ready === true && r.area1.state === 'ready'", 90_000);
    await lock(page);
    for (let i = 0; i < 8; i++) {
      if (i > 0) await look(page, Math.PI / 4, 0);
      await page.waitForTimeout(250);
      const r = await room(page);
      budget[`plaza-turn-${i}`] = { drawCalls: r.drawCalls, triangles: r.triangles };
    }
    writeFileSync(
      join(root, `artifacts/S-36/views-${backend}.json`),
      JSON.stringify({ backend, shots, budget, errors }, null, 2),
    );
    for (const [name, b] of Object.entries(budget)) {
      expect(b.drawCalls, `draw calls in ${name}`).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(b.triangles, `triangles in ${name}`).toBeLessThanOrEqual(BUDGET.triangles);
      expect(b.drawCalls, `something drawn in ${name}`).toBeGreaterThan(10);
    }
    // the lamps toward the next room read as lights: more warm bright pixels than the same view before the drop (S-36
    // measured 0.0026 of the screen with them lit, 0.00003 before, both ways)
    expect(shots['slope-next']?.warm ?? 0, 'the lit lamps toward the next room').toBeGreaterThan(
      (shots.slope?.warm ?? 0) + 0.0015,
    );
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `near-black share in ${name}`).toBeLessThan(0.02);
      expect(l.mean, `mean luminance in ${name}`).toBeGreaterThan(0.12);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
