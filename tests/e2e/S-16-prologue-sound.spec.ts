import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-16: the prologue room with sound (S-06's room × S-09's audio foundation), on both render paths.
 *  - the whole S-06 play-through with real input: the cues that sounded, in order, are the room's events
 *    mapped by the table below (ぽぺん for 覗く・置く・拾う・震える, glass for the light drop, peekEnd silent);
 *    the po-pens come from the hand (HRTF), the reverb is the workshop's
 *  - nothing sounds before the first gesture, and nothing refused then is played later
 *  - leaving the scene (a quality switch recreates it) closes the old audio graph
 *  - mid quality: the room with its sound running stays at or below the stress scene (S-06's bar), compared
 *    within one run (other sessions share the GPU, so absolute numbers are not compared)
 * Numbers → artifacts/S-16/<what>-<backend>.json.
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
  locked: boolean;
  peekAmount: number;
  orb: 'bench' | 'hand' | 'pedestal';
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
  autoplay: { step: string; done: boolean } | null;
  layout: {
    edgeZ: number;
    farZ: number;
    pedestalOrb: [number, number, number];
    drop: [number, number, number];
  };
}
interface PlayedCue {
  event: string;
  cue: string;
  source: 'hand' | 'orb' | 'drop';
  distance: number;
}
interface SoundProbe {
  state: string;
  unlocked: boolean;
  room: string;
  panning: string[];
  voicesStarted: number;
  voicesDropped: number;
  played: PlayedCue[];
  refused: { event: string; cue: string }[];
  playedCount: number;
  refusedCount: number;
  emitters: number;
  subscribed: boolean;
  disposed: boolean;
}

/**
 * The acceptance table (spine S-16; design: サウンドデザイン > ガラスの音, アセットリスト > 音 — ビードロの音 4 =
 * 覗く・置く・拾う・震える). peekEnd is silent: the design names no sound for it.
 */
const CUES: Record<string, string | null> = {
  peekStart: 'popen:peek',
  peekEnd: null,
  place: 'popen:place',
  'pickup:bench': 'popen:pickup',
  'pickup:pedestal': 'popen:pickup',
  'shake:peek': 'popen:tremble',
  'shake:pickup': 'popen:tremble',
  dropTouched: 'glass:touch',
  dropTaken: 'glass:tap',
};
function expectedCues(events: string[]): { event: string; cue: string }[] {
  const out: { event: string; cue: string }[] = [];
  for (const event of events) {
    if (!(event in CUES)) throw new Error(`no sound decided for the event ${event}`);
    const cue = CUES[event];
    if (cue) out.push({ event, cue });
  }
  return out;
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
    // warnings count too (an AudioContext autoplay notice would be one)
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

async function waitSound(page: Page, fn: string, timeout = 10_000): Promise<SoundProbe> {
  await page.waitForFunction(
    `(() => { try { const s = window.__vidro?.sceneProbe?.sound; return !!s && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return sound(page);
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

/** Holds a key until the body has been at rest for 0.4 s of scene time (or the limit). */
async function pushUntilStopped(page: Page, key: string, limitMs = 8_000): Promise<RoomProbe> {
  await page.keyboard.down(key);
  let stillSince: number | null = null;
  let samples = 0;
  let last: RoomProbe | null = null;
  const end = Date.now() + limitMs;
  try {
    while (Date.now() < end) {
      last = await room(page);
      samples++;
      if (last.speed > 0.03) stillSince = null;
      else stillSince ??= last.time;
      if (stillSince !== null && last.time - stillSince > 0.4 && samples > 10) break;
      await page.waitForTimeout(40);
    }
  } finally {
    await page.keyboard.up(key);
  }
  return last ?? room(page);
}

/** The played cues must be the events' cues, one for one and in order. */
function expectCuesMatchEvents(events: string[], s: SoundProbe): void {
  expect(events.length, 'the room keeps its last 40 events: the run must fit').toBeLessThan(40);
  expect(s.played.map(({ event, cue }) => ({ event, cue }))).toEqual(expectedCues(events));
  expect(s.playedCount).toBe(s.played.length);
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-16', backend);

  test(`S-16 the S-06 play-through sounds each event: po-pens from the hand, glass for the drop [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-16'), { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto${webgl}`);

    // 読み込み: silent until the player presses 「はじめる」 (the first gesture). The AudioContext is not even
    // made before it, so the browser has nothing to warn about (autoplay)
    await waitHome(page, 'p.load.ready === true', 90_000);
    const before = await sound(page);
    expect(before.state).toBe('locked');
    expect(before.unlocked).toBe(false);
    expect(before.room).toBe('workshop');
    await page.locator('[data-ui="loading-start"]').click();
    await waitSound(page, "s.state === 'running'");
    await waitHome(page, "p.screen === 'home' && p.transition === null");
    await page.locator('[data-item="start"]').click();
    await waitHome(page, "p.screen === 'game' && p.transition === null", 60_000);
    const landed = await waitRoom(page, 'r.ready && r.playing');
    expect(landed.orb).toBe('bench');
    // the home and the dive make no prologue sounds
    expect((await sound(page)).playedCount).toBe(0);

    // take the mouse, then the vidro from the bench (拾う)
    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand' && r.handPresence > 0.99");
    await waitSound(page, "s.played.some((p) => p.cue === 'popen:pickup')", 3_000);

    // the one way, a peek while walking (覗く, then its silent end)
    await walkTo(page, 0.1, -3.6, 0.35);
    await lookAt(page, [0, 1.4, -30]);
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.peekAmount > 0.999');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(800);
    await page.keyboard.up('KeyW');
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peekAmount === 0');
    await walkTo(page, 0, -11.5, 0.4);
    await lookAt(page, [0, 1.4, -30]);
    const stop = await pushUntilStopped(page, 'KeyW');
    const { edgeZ, farZ, pedestalOrb, drop } = stop.layout;

    // 覗く at the dead end
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.peekAmount > 0.999');
    await page.screenshot({ path: join(shotDir, 'peek.png') });
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peekAmount === 0');

    // 置く
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, 'r.bridgeColliders === r.bridgeSegments && r.bridgeSegments > 0');

    // 置いている間は覗けない → 震える
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.shaking === true', 3_000);
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.shaking === false', 3_000);

    // 橋の上では拾えない → 震える
    await lookAt(page, pedestalOrb);
    await page.keyboard.down('KeyD');
    await waitRoom(page, `r.onBackFooting && r.position.z < ${edgeZ - 0.45}`, 8_000);
    await page.keyboard.up('KeyD');
    await waitRoom(page, 'r.speed < 0.03');
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, 'r.shaking === true', 3_000);

    // 渡る, then 雫: touched (glass), it flies into the vidro (glass)
    await walkTo(page, 0, edgeZ - 1.4, 0.3);
    await walkTo(page, 0.45, farZ - 0.6, 0.3);
    await lookAt(page, drop);
    await waitRoom(page, "r.target === 'drop'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.drop === 'flying'", 3_000);
    await lookAt(page, [pedestalOrb[0], pedestalOrb[1] + 0.4, pedestalOrb[2]]);
    await page.screenshot({ path: join(shotDir, 'drop-flying.png') });
    await waitRoom(page, 'r.dropTaken === true', 5_000);

    // 罰がない: back on the shore the vidro comes back (拾う)
    await walkTo(page, 0, edgeZ + 0.5, 0.3);
    await lookAt(page, pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand'", 3_000);
    await page.waitForTimeout(300);

    const final = await room(page);
    const s = await sound(page);
    writeFileSync(
      join(root, `artifacts/S-16/run-${backend}.json`),
      JSON.stringify({ backend, events: final.events, sound: s, errors }, null, 2),
    );
    expect(final.events).toEqual(
      expect.arrayContaining([
        'pickup:bench',
        'peekStart',
        'peekEnd',
        'place',
        'shake:peek',
        'shake:pickup',
        'dropTouched',
        'dropTaken',
        'pickup:pedestal',
      ]),
    );
    // the sounds are the events, one for one and in order; nothing was refused (all after the first gesture)
    expectCuesMatchEvents(final.events, s);
    expect(s.refusedCount).toBe(0);
    expect(s.voicesStarted).toBe(s.playedCount);
    // 工房の残響, HRTF; the po-pens of the held vidro sound from the hand (well within arm's length)
    expect(s.state).toBe('running');
    expect(s.room).toBe('workshop');
    expect(s.panning.length).toBeGreaterThan(0);
    expect(s.panning.every((p) => p === 'HRTF')).toBe(true);
    for (const p of s.played) {
      if (p.source === 'hand') {
        expect(p.distance, `${p.event} from the hand`).toBeGreaterThan(0.3);
        expect(p.distance, `${p.event} from the hand`).toBeLessThan(0.8);
      }
    }
    const from = (event: string) => s.played.filter((p) => p.event === event).map((p) => p.source);
    for (const e of ['peekStart', 'place', 'pickup:bench', 'pickup:pedestal'])
      expect(from(e).every((x) => x === 'hand')).toBe(true);
    for (const e of ['shake:peek', 'shake:pickup', 'dropTaken'])
      expect(from(e).every((x) => x === 'orb')).toBe(true);
    expect(from('dropTouched')).toEqual(['drop']);
    // the refusals come from the vidro on the pedestal, a step or two away
    for (const p of s.played.filter((q) => q.event.startsWith('shake:'))) {
      expect(p.distance).toBeGreaterThan(0.8);
      expect(p.distance).toBeLessThan(3.5);
    }

    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-16 nothing sounds before the first gesture, and nothing is played later [${backend}]`, async ({
    page,
  }) => {
    // S-35: the script goes on down the slope to the plaza (about 100 s of play)
    test.setTimeout(300_000);
    const errors = collectErrors(page);
    // the scripted play has no gesture: every event happens while audio waits for one
    await page.goto(`/?scene=prologue-proto&direct=1&autoplay=1${webgl}`);
    const done = await waitRoom(page, 'r.autoplay && r.autoplay.done && r.dropTaken', 200_000);
    const s = await sound(page);
    expect(s.state).toBe('locked');
    expect(s.unlocked).toBe(false);
    expect(s.played).toEqual([]);
    expect(s.voicesStarted).toBe(0);
    expect(s.refused).toEqual(expectedCues(done.events));
    expect(s.refused.length).toBeGreaterThan(3);

    // the first gesture starts the audio; nothing that was refused comes out now (溜めて後から鳴らさない)
    await page.mouse.click(640, 360);
    await waitSound(page, "s.state === 'running'");
    await page.waitForTimeout(800);
    const after = await sound(page);
    expect(after.unlocked).toBe(true);
    expect(after.played).toEqual([]);
    expect(after.playedCount).toBe(0);
    expect(after.voicesStarted).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-16 leaving the scene closes its audio graph [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    // ?quality=auto pinned to another preset recreates the scene after the window: the first instance is disposed
    await page.goto(
      `/?scene=prologue-proto&direct=1&quality=auto&autoFrom=mid&autoForce=low&autoWindow=8&dynres=0${webgl}`,
    );
    await waitRoom(page, 'r.ready && r.playing', 60_000);
    // hold on to the first instance's probe (its getters keep reading that instance after it is gone)
    const held = await page.evaluate(() => {
      (window as unknown as { __s16first: unknown }).__s16first = window.__vidro.sceneProbe.sound;
      return window.__vidro.sceneInstances;
    });
    expect(held).toBe(1);
    const readFirst = () => page.evaluate(() => (window as unknown as { __s16first: SoundProbe }).__s16first);
    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(async () => (await readFirst()).state, { timeout: 10_000 }).toBe('running');
    await waitRoom(page, "r.target === 'bench'", 5_000);
    await page.keyboard.press('KeyE');
    await expect.poll(async () => (await readFirst()).playedCount, { timeout: 3_000 }).toBe(1);
    const playing = await readFirst();
    expect(playing.emitters).toBeGreaterThan(0);
    expect(playing.subscribed).toBe(true);
    expect(await page.evaluate(() => window.__vidro.sceneInstances), 'played before the switch').toBe(1);

    await page.waitForFunction(() => window.__vidro.sceneInstances >= 2, undefined, { timeout: 40_000 });
    // generous: the new instance's first frames compile the finishing (S-17) on the main thread, which on WebGL2 under
    // a busy machine (parallel worktrees) held the close past 5 s once in each of S-16 and S-17's full checks
    await expect.poll(async () => (await readFirst()).state, { timeout: 20_000 }).toBe('closed');
    const first = await readFirst();
    expect(first.disposed).toBe(true);
    expect(first.subscribed).toBe(false);
    expect(first.emitters).toBe(0);
    expect(first.playedCount).toBe(1);
    // the new instance starts its own, silent until the next gesture
    const next = await waitSound(page, 's.disposed === false');
    expect(next.state).not.toBe('closed');
    expect(next.played).toEqual([]);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-16 mid quality: the room with its sound stays within the stress scene's draws and triangles [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    mkdirSync(join(root, 'artifacts/S-16'), { recursive: true });
    const errors = collectErrors(page);
    type Bench = {
      p50Ms: number;
      maxDrawCalls: number;
      maxTriangles: number;
      gpu: { p50Ms: number } | null;
      gpuSpan: { p50Ms: number } | null;
      cpuRenderMs: { p50Ms: number } | null;
    };
    const measure = async (scene: string, unlock: boolean): Promise<Bench> => {
      await page.goto(`/?scene=${scene}&quality=mid&bench=4&warmup=3&dynres=0${webgl}`);
      await page.waitForFunction(
        () => ['benchmarking', 'done', 'error'].includes(window.__vidro?.status ?? ''),
        undefined,
        { timeout: 60_000 },
      );
      if (unlock) {
        // the sound runs while the heaviest view (the dead end, peeking) is measured
        await waitRoom(page, 'r.ready');
        await page.mouse.click(640, 360);
        await waitSound(page, "s.state === 'running'");
        expect(await page.evaluate(() => window.__vidro.status)).toBe('benchmarking');
      }
      await page.waitForFunction(() => ['done', 'error'].includes(window.__vidro.status), undefined, {
        timeout: 60_000,
      });
      expect(await page.evaluate(() => window.__vidro.status)).toBe('done');
      if (unlock) expect((await sound(page)).state).toBe('running');
      return (await page.evaluate(() => window.__vidro.bench)) as unknown as Bench;
    };
    const prologue = await measure('prologue-proto', true);
    const stress = await measure('stress', false);
    writeFileSync(
      join(root, `artifacts/S-16/weight-${backend}.json`),
      JSON.stringify({ backend, prologue, stress }, null, 2),
    );
    expect(prologue.maxDrawCalls).toBeLessThanOrEqual(BUDGET.drawCalls);
    expect(prologue.maxTriangles).toBeLessThanOrEqual(BUDGET.triangles);
    expect(prologue.maxDrawCalls).toBeLessThanOrEqual(stress.maxDrawCalls);
    expect(prologue.maxTriangles).toBeLessThanOrEqual(stress.maxTriangles);
    // No GPU-time comparison here: at vsync's 60 fps the GPU's clock state moves the span from run to run, and since
    // S-17 the two scenes weigh about the same (quiet bench-headed, mid, 1080p, vsync off: frame 1.08–1.26 vs
    // 1.09–1.28 ms on WebGPU, lighter on WebGL2; process/slices/S-17.md). A span check flipped either way (6.35 vs
    // 4.68 ms, then 2.77 vs 3.36 ms). Both benches stay in the JSON above; the weight is judged with
    // scripts/bench-headed.mjs (QUIET=1, AGENTS.md).
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
