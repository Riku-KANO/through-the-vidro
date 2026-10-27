import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { VIDRO_VOLUMES } from '../../src/audio/levels';
import { PAUSE_DUCK } from '../../src/audio/pause';

/**
 * S-42: the pause. Through the home (loading → 「はじめる」 → dive), as a player plays it, on both render paths:
 *  - open: Esc in play (with the mouse taken: the lock drops), a gamepad's Start (a stand-in pad), and as asked while the
 *    autopilot holds the input (the close's light running). The time stops (the body, the room's clock, the close's light),
 *    the frost spreads, the items are written; the pause answers the key within 0.1 s, with its own glass sound
 *  - while open: the world is not drawn (renderer.render is counted, ?debug=1) but once after the render scale changed;
 *    the ambience is turned down (the gate's volumes), no footsteps or room sounds start
 *  - the items by keyboard alone (arrows, Enter, Esc), by mouse (hover swells and rings, click), by pad (D-pad, A, B, Start)
 *  - つづける / Esc / B: the frost clears, the time runs again, the volumes come back
 *  - タイトルへ → the confirmation (いいえ first) → はい: the dive plays back to the home, no black picture on the way;
 *    「はじめる」 dives into the game again and it plays; one AudioContext and one engine all along
 *  - the text: at least 18 px, on frosted glass; in English the tags grow with the words
 * Pictures → artifacts/screens/S-42/<backend>/, numbers → artifacts/S-42/<what>-<backend>.json.
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
  locked: boolean;
  footfalls: number;
  dropTaken: boolean;
  finale: { settle: number; gate: number; frontZ: number | null };
  autoplay: { step: string; done: boolean } | null;
}
interface PauseProbe {
  phase: 'closed' | 'opening' | 'open' | 'closing' | 'leaving';
  page: 'menu' | 'confirm';
  focused: string | null;
  hovered: string | null;
  frost: number;
  writing: number;
  timeScale: number;
  opened: number;
  closed: number;
  left: number;
  requestedAt: number | null;
  respondedAt: number | null;
  sounds: { cue: string; at: number; rang: boolean }[];
  heldFrames: number;
  drawnWhileHeld: number;
  frameMs: { opening: number; open: number; closing: number };
  ducked: number;
  hold: number | null;
}
interface SoundProbe {
  state: string;
  voicesStarted: number;
}
interface GateProbe {
  state: string;
  contexts: number;
  volumes: Record<string, number> | null;
}
interface ContextRecord {
  state: string;
  engines: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** UI/UX設計 > 文字と色: 最小の文字サイズは1080p基準で18px (the page is 720 px high: the floor of 18 px holds). */
const MIN_TEXT_PX = 18;

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

/** Every AudioContext made (S-18's wrapper, shortened): its state and the engines built on it (one limiter each). */
async function countContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Base = window.AudioContext;
    if (!Base) return;
    const made: { context: BaseAudioContext; engines: number }[] = [];
    class CountedAudioContext extends Base {
      constructor(options?: AudioContextOptions) {
        super(options);
        made.push({ context: this, engines: 0 });
      }
      override createDynamicsCompressor(): DynamicsCompressorNode {
        const m = made.find((x) => x.context === this);
        if (m) m.engines++;
        return super.createDynamicsCompressor();
      }
    }
    window.AudioContext = CountedAudioContext;
    (window as unknown as { __s42Contexts: () => unknown }).__s42Contexts = () =>
      made.map(({ context, engines }) => ({ state: context.state, engines }));
  });
}

/** A stand-in standard gamepad: window.__s42Pad(button, down) presses and releases its buttons. */
async function fakePad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = {
      id: 'S-42 stand-in pad',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons,
      timestamp: 0,
    };
    navigator.getGamepads = () => [pad as unknown as Gamepad];
    (window as unknown as { __s42Pad: (i: number, down: boolean) => void }).__s42Pad = (i, down) => {
      buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
    };
  });
}
/** W3C standard mapping. */
const PAD = { A: 0, B: 1, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

async function padPress(page: Page, button: number): Promise<void> {
  await page.evaluate(
    (b) => (window as unknown as { __s42Pad: (i: number, d: boolean) => void }).__s42Pad(b, true),
    button,
  );
  await page.waitForTimeout(120);
  await page.evaluate(
    (b) => (window as unknown as { __s42Pad: (i: number, d: boolean) => void }).__s42Pad(b, false),
    button,
  );
  await page.waitForTimeout(120);
}

/** Mean luminance and share of near-black pixels of a PNG, decoded by the browser (as in S-04's and S-06's e2e). */
async function luminance(page: Page, png: Buffer): Promise<{ mean: number; dark: number }> {
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
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 5) {
      const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      sum += l;
      if (l < 0.06) dark++;
      n++;
    }
    return { mean: sum / n, dark: dark / n };
  }, png.toString('base64'));
}

const probeOf = <T>(page: Page, key: string): Promise<T> =>
  page.evaluate((k) => {
    const v = (window.__vidro.sceneProbe as Record<string, unknown>)[k];
    // a plain copy (getters read once), without the probe's functions
    return JSON.parse(JSON.stringify(v)) as unknown;
  }, key) as Promise<T>;
const room = (page: Page) => probeOf<RoomProbe>(page, 'room');
const pause = (page: Page) => probeOf<PauseProbe>(page, 'pause');
const sound = (page: Page) => probeOf<SoundProbe>(page, 'sound');
const gate = (page: Page) => probeOf<GateProbe>(page, 'audioGate');
const contexts = (page: Page): Promise<ContextRecord[]> =>
  page.evaluate(() => (window as unknown as { __s42Contexts: () => ContextRecord[] }).__s42Contexts());

async function waitProbe(page: Page, fn: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}
const waitPause = (page: Page, fn: string, timeout = 10_000) =>
  waitProbe(page, `p.pause && (() => { const q = p.pause; return ${fn}; })()`, timeout);

/** The world's draws since `count()` was installed (debug=1: wrappers call on with apply). */
async function countRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __s42Renders?: number };
    if (w.__s42Renders !== undefined) return;
    w.__s42Renders = 0;
    const renderer = window.__vidroDebug?.renderer as unknown as { render: (...a: unknown[]) => unknown };
    if (!renderer) throw new Error('no __vidroDebug.renderer (debug=1)');
    const render = renderer.render;
    renderer.render = (...args: unknown[]) => {
      w.__s42Renders = (w.__s42Renders ?? 0) + 1;
      return render.apply(renderer, args);
    };
  });
}
const renders = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __s42Renders?: number }).__s42Renders ?? 0);

/** Marks the page time of the next Esc (the key, or the lock it drops, whichever the page sees first). */
async function markEsc(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __s42EscAt: number | null };
    w.__s42EscAt = null;
    const mark = (): void => {
      w.__s42EscAt ??= performance.now();
    };
    window.addEventListener('keydown', (e) => e.key === 'Escape' && mark(), { capture: true, once: true });
    document.addEventListener('pointerlockchange', mark, { capture: true, once: true });
  });
}
const escAt = (page: Page): Promise<number | null> =>
  page.evaluate(() => (window as unknown as { __s42EscAt: number | null }).__s42EscAt);

/** Loading → 「はじめる」 → the home → 「はじめる」 → landed and playing. */
async function playThroughHome(page: Page, query: string): Promise<void> {
  await page.goto(`/?scene=prologue-proto${query}`);
  await waitProbe(page, 'p.load.ready === true', 90_000);
  await page.locator('[data-ui="loading-start"]').click();
  await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
  await page.locator('[data-item="start"]').click();
  await waitProbe(
    page,
    "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
    60_000,
  );
}

async function takeMouse(page: Page): Promise<void> {
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(
    () => (window.__vidro.sceneProbe as { room: RoomProbe }).room.locked === true,
    undefined,
    {
      timeout: 5_000,
    },
  );
}

/** Font size (px) and box of each written line of the pause page shown, and of its frosted tag. */
async function writtenLines(
  page: Page,
): Promise<{ text: string; fontPx: number; ink: number; tag: number }[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-ui="pause"] [data-page]:not([hidden]) [data-part="tag"]',
      ),
    ].map((tag) => {
      const ink = tag.querySelector<HTMLElement>('[data-part="ink"]');
      return {
        text: ink?.textContent ?? '',
        fontPx: Number.parseFloat(getComputedStyle(ink ?? tag).fontSize),
        ink: ink?.getBoundingClientRect().width ?? 0,
        tag: tag.getBoundingClientRect().width,
      };
    }),
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-42', backend);

  test(`S-42 the pause: Esc stops the time, keyboard / mouse / pad, つづける, タイトルへ and back into play [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-42'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await fakePad(page);
    const shots: Record<string, { mean: number; dark: number }> = {};
    const snap = async (name: string): Promise<{ mean: number; dark: number }> => {
      const l = await luminance(page, await page.screenshot({ path: join(shotDir, `${name}.png`) }));
      shots[name] = l;
      return l;
    };
    await playThroughHome(page, `&debug=1${webgl}`);
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
    const landed = await snap('landed');
    expect((await pause(page)).phase).toBe('closed');
    await countRenders(page);

    // ---- open: walking, the mouse taken, Esc (the lock drops) ----
    await takeMouse(page);
    const before = (await room(page)).position;
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(500);
    const walking = (await room(page)).position;
    expect(
      Math.hypot(walking.x - before.x, walking.z - before.z),
      'walking before the pause',
    ).toBeGreaterThan(0.2);
    // hold the opening part way for a picture of it (the probe's hold, as the home's autoplay checkpoints)
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { pause: { hold: number | null } }).pause.hold = 0.15;
    });
    await markEsc(page);
    await page.keyboard.press('Escape');
    await page.keyboard.up('KeyW');
    await waitPause(page, "q.phase === 'opening' && q.frost > 0.3");
    // the room's prompt fades in 0.2 s (UI/UX設計 > ゲーム中)
    await page.waitForTimeout(300);
    const opening = await snap('opening');
    const holdingAt = await pause(page);
    expect(holdingAt.timeScale, 'part way: the time is slowing, not stopped').toBeGreaterThan(0);
    expect(holdingAt.timeScale).toBeLessThan(1);
    // and the items being written with a finger (0.4 s of frost, then halfway through the 0.3 s of writing)
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { pause: { hold: number | null } }).pause.hold = 0.55;
    });
    await waitPause(page, "q.phase === 'opening' && q.writing > 0.45 && q.writing < 0.55");
    const writing = await snap('writing');
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { pause: { hold: number | null } }).pause.hold = null;
    });
    await waitPause(page, "q.phase === 'open'");
    const opened = await pause(page);
    const esc = await escAt(page);
    expect(esc, 'the page saw the Esc').not.toBeNull();
    // 入力から0.1秒以内に必ず音と動きで反応する (UIの原則 3)
    expect(
      (opened.respondedAt ?? Number.POSITIVE_INFINITY) - (esc ?? 0),
      'answered within 0.1 s',
    ).toBeLessThan(100);
    const openSound = opened.sounds.find((s) => s.cue === 'open');
    expect(openSound, 'the opening rang its own glass sound').toBeDefined();
    expect(openSound?.rang, 'on the page’s engine').toBe(true);
    expect((openSound?.at ?? Number.POSITIVE_INFINITY) - (esc ?? 0)).toBeLessThan(100);
    const response = {
      motionMs: (opened.respondedAt ?? 0) - (esc ?? 0),
      soundMs: (openSound?.at ?? 0) - (esc ?? 0),
    };
    expect(opened.timeScale).toBe(0);
    expect(opened.frost).toBe(1);
    expect(opened.writing).toBe(1);
    expect(opened.focused).toBe('resume');

    // ---- open: the time stands, nothing is drawn, the game's sounds are turned down ----
    const r0 = await room(page);
    const s0 = await sound(page);
    const n0 = await renders(page);
    await page.waitForTimeout(800);
    const r1 = await room(page);
    const s1 = await sound(page);
    const n1 = await renders(page);
    expect(r1.position, 'the body stands').toEqual(r0.position);
    expect(r1.time, 'the room’s clock stands').toBe(r0.time);
    expect(r1.footfalls, 'no footsteps').toBe(r0.footfalls);
    expect(s1.voicesStarted, 'no room sounds start').toBe(s0.voicesStarted);
    expect(n1 - n0, 'the world is not drawn while the pause holds its picture').toBe(0);
    const g1 = await gate(page);
    expect(g1.volumes?.ambience ?? 1, 'the ambience is turned down, not off').toBeCloseTo(
      VIDRO_VOLUMES.ambience * (PAUSE_DUCK.ambience ?? 1),
      3,
    );
    expect(g1.volumes?.sfx).toBe(VIDRO_VOLUMES.sfx);
    const open = await snap('open');
    // the text: written on frosted glass, at least 18 px; the small line about the mouse is there
    const lines = await writtenLines(page);
    expect(lines.map((l) => l.text)).toEqual(['つづける', 'タイトルへ']);
    for (const l of lines) {
      expect(l.fontPx, l.text).toBeGreaterThanOrEqual(MIN_TEXT_PX);
      expect(l.tag, `${l.text}: the tag holds its words`).toBeGreaterThan(l.ink);
    }
    await expect(page.locator('[data-ui="pause"] [data-part="relock"]')).toBeVisible();
    const relockPx = await page
      .locator('[data-ui="pause"] [data-part="relock"]')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(relockPx).toBeGreaterThanOrEqual(MIN_TEXT_PX);

    // ---- a render scale change while open: drawn once more, then held again (no blank picture) ----
    await page.evaluate(() => window.__vidroDebug?.setScale(0.8));
    await page.waitForTimeout(300);
    const n2 = await renders(page);
    expect(n2 - n1, 'redrawn after the scale changed').toBeGreaterThan(0);
    await page.waitForTimeout(400);
    expect(await renders(page), 'and held again').toBe(n2);
    const rescaled = await snap('open-rescaled');
    expect(rescaled.dark, 'no blank picture after the scale changed').toBeLessThan(open.dark + 0.1);

    // ---- keyboard: down, up, Enter on つづける ----
    let sounds = (await pause(page)).sounds.length;
    await page.keyboard.press('ArrowDown');
    await waitPause(page, "q.focused === 'title'");
    await page.keyboard.press('ArrowUp');
    await waitPause(page, "q.focused === 'resume'");
    expect(
      (await pause(page)).sounds.slice(sounds).filter((s) => s.cue === 'tick').length,
      'each focus rings',
    ).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    await waitPause(page, "q.phase === 'closing'");
    await waitPause(page, "q.phase === 'closed'", 3_000);
    const closed = await pause(page);
    expect(closed.timeScale).toBe(1);
    expect(closed.sounds.some((s) => s.cue === 'close')).toBe(true);
    const t0 = (await room(page)).time;
    // back from the bench (walking on toward it, the body stands against it)
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyS');
    const r2 = await room(page);
    expect(r2.time, 'the time runs again').toBeGreaterThan(t0 + 0.3);
    expect(
      Math.hypot(r2.position.x - r1.position.x, r2.position.z - r1.position.z),
      'walks again',
    ).toBeGreaterThan(0.2);
    await expect
      .poll(async () => (await gate(page)).volumes?.ambience, { timeout: 2_000 })
      .toBe(VIDRO_VOLUMES.ambience);
    // the longest frames while opening and closing (最長 50ms 目安: recorded, held loosely here for the headless runs)
    const frames = (await pause(page)).frameMs;

    // ---- Esc opens, Esc closes (one step back is the game) ----
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    await page.waitForTimeout(350); // past the echo guard of a lock that dropped
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);

    // ---- mouse: hover swells and rings, click つづける ----
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    sounds = (await pause(page)).sounds.length;
    await page.locator('[data-pause-item="title"]').hover();
    await waitPause(page, "q.hovered === 'title' && q.focused === 'title'");
    await expect(page.locator('[data-pause-item="title"]')).toHaveClass(/is-hover/);
    expect(
      (await pause(page)).sounds.slice(sounds).some((s) => s.cue === 'tick'),
      'hover rings',
    ).toBe(true);
    await page.locator('[data-pause-item="resume"]').click();
    await waitPause(page, "q.phase === 'closed'", 3_000);

    // ---- pad: Start opens, D-pad, A asks, B back, B resumes; Start closes too ----
    await padPress(page, PAD.START);
    await waitPause(page, "q.phase === 'open'");
    await padPress(page, PAD.DOWN);
    await waitPause(page, "q.focused === 'title'");
    await padPress(page, PAD.A);
    await waitPause(page, "q.page === 'confirm' && q.focused === 'no'");
    await padPress(page, PAD.B);
    await waitPause(page, "q.page === 'menu' && q.focused === 'title'");
    await padPress(page, PAD.B);
    await waitPause(page, "q.phase === 'closed'", 3_000);
    // Start closes from the question too (it closes as it opened)
    await padPress(page, PAD.START);
    await waitPause(page, "q.phase === 'open'");
    await padPress(page, PAD.DOWN);
    await padPress(page, PAD.A);
    await waitPause(page, "q.page === 'confirm'");
    await padPress(page, PAD.START);
    await waitPause(page, "q.phase === 'closed'", 3_000);
    expect((await pause(page)).left).toBe(0);

    // ---- a double click on タイトルへ does not answer the question it opens (はい is under it, unseen) ----
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    await page.waitForTimeout(350);
    // where はい will stand: ask once by keyboard to measure it, then go back
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitPause(page, "q.page === 'confirm' && q.writing === 1");
    const yesBox = await page.locator('[data-pause-item="yes"]').boundingBox();
    await page.keyboard.press('Escape');
    await waitPause(page, "q.page === 'menu' && q.writing === 1");
    const titleBox = await page.locator('[data-pause-item="title"]').boundingBox();
    if (!yesBox || !titleBox) throw new Error('no boxes for タイトルへ / はい');
    const overlap = {
      x0: Math.max(yesBox.x, titleBox.x),
      x1: Math.min(yesBox.x + yesBox.width, titleBox.x + titleBox.width),
      y0: Math.max(yesBox.y, titleBox.y),
      y1: Math.min(yesBox.y + yesBox.height, titleBox.y + titleBox.height),
    };
    if (overlap.x1 > overlap.x0 && overlap.y1 > overlap.y0) {
      await page.mouse.dblclick((overlap.x0 + overlap.x1) / 2, (overlap.y0 + overlap.y1) / 2);
      await waitPause(page, "q.page === 'confirm'");
      await page.waitForTimeout(500);
      const p = await pause(page);
      expect(p.left, 'the second click did not leave').toBe(0);
      expect(p.phase).toBe('open');
      expect(p.page).toBe('confirm');
    }
    // Esc back to the items, Esc out
    await page.keyboard.press('Escape');
    await waitPause(page, "q.page === 'menu'");
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);

    // ---- タイトルへ: asked first (いいえ chosen), Esc goes back, はい leaves through the dive played back ----
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitPause(page, "q.page === 'confirm' && q.focused === 'no' && q.writing === 1");
    const confirm = await snap('confirm');
    const asked = await writtenLines(page);
    expect(asked.map((l) => l.text)).toEqual(['タイトルへ戻りますか', 'はい', 'いいえ']);
    for (const l of asked) expect(l.fontPx, l.text).toBeGreaterThanOrEqual(MIN_TEXT_PX);
    await page.keyboard.press('Escape');
    await waitPause(page, "q.page === 'menu' && q.focused === 'title' && q.phase === 'open'");
    await page.keyboard.press('Enter');
    await waitPause(page, "q.page === 'confirm' && q.focused === 'no'");
    await page.keyboard.press('ArrowLeft');
    await waitPause(page, "q.focused === 'yes'");
    await page.keyboard.press('Enter');
    await waitProbe(
      page,
      "p.transition && p.transition.id === 'home-game' && p.transition.direction === -1",
      3_000,
    );
    expect((await pause(page)).sounds.some((s) => s.cue === 'leave')).toBe(true);
    await waitProbe(page, 'p.transition && p.transition.value < 0.75', 5_000);
    const leaving = await snap('leaving');
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 10_000);
    const home = await snap('home-again');
    expect((await pause(page)).phase).toBe('closed');
    expect((await pause(page)).left).toBe(1);
    // back on the home the game's ambience has faded out (the home has no room sounds, as when first seen)
    await expect.poll(async () => (await gate(page)).volumes?.ambience, { timeout: 2_000 }).toBe(0);

    // ---- 「はじめる」 again (the keyboard: the focus is back on it) → playing ----
    await expect(page.locator('[data-item="start"]')).toBeFocused({ timeout: 3_000 });
    await page.keyboard.press('Enter');
    await waitProbe(page, "p.screen === 'game' && p.transition === null && p.room.playing", 15_000);
    const again = await snap('playing-again');
    const r3 = await room(page);
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyS');
    const r4 = await room(page);
    expect(
      Math.hypot(r4.position.x - r3.position.x, r4.position.z - r3.position.z),
      'plays again',
    ).toBeGreaterThan(0.2);
    // landed where play was left (the dive in passes through that eye)
    expect(Math.hypot(r3.position.x - r2.position.x, r3.position.z - r2.position.z)).toBeLessThan(1.5);
    await expect
      .poll(async () => (await gate(page)).volumes?.ambience, { timeout: 2_000 })
      .toBe(VIDRO_VOLUMES.ambience);

    // ---- one AudioContext, one engine ----
    const made = await contexts(page);
    expect(made, 'one AudioContext').toHaveLength(1);
    expect(made[0]?.engines, 'one engine').toBe(1);
    expect(made[0]?.state).toBe('running');
    expect((await gate(page)).contexts).toBe(1);

    // 黒い画面を使わない: every picture of the way is as lit as the landing
    for (const [name, l] of Object.entries({ opening, writing, open, confirm, leaving, home, again })) {
      expect(l.dark, `${name}: no black picture`).toBeLessThan(Math.max(0.35, landed.dark + 0.1));
      expect(l.mean, `${name}: not dark`).toBeGreaterThan(0.04);
    }
    writeFileSync(
      join(root, `artifacts/S-42/pause-${backend}.json`),
      JSON.stringify(
        { backend, response, shots, frames, final: await pause(page), contexts: made, errors },
        null,
        2,
      ),
    );
    expect(frames.opening, 'the opening makes no long frame').toBeLessThan(150);
    expect(frames.closing, 'the closing makes no long frame').toBeLessThan(150);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
    await page.evaluate(() => document.exitPointerLock()).catch(() => {});
  });

  test(`S-42 the pause stops the close's light where it is, and タイトルへ from down in the town (asked while the autopilot plays) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(join(root, 'artifacts/S-42'), { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&autoplay=1&debug=1${webgl}`);
    // the moment the light starts across the bridge, ask for the pause as the input would (the autopilot holds it)
    await page.waitForFunction(
      () => {
        const p = window.__vidro?.sceneProbe as { room?: RoomProbe; pause?: { ask(): void } } | undefined;
        const f = p?.room?.finale;
        if (!p?.pause || !f || !(f.settle > 0.02 && f.settle < 0.6)) return false;
        p.pause.ask();
        return true;
      },
      undefined,
      { timeout: 150_000, polling: 'raf' },
    );
    await waitPause(page, "q.phase === 'open'");
    const a = await room(page);
    await page.waitForTimeout(800);
    const b = await room(page);
    expect(a.finale.settle, 'the light stopped on its way').toBeLessThan(1);
    expect(b.finale, 'the light stands').toEqual(a.finale);
    expect(b.position, 'the body stands').toEqual(a.position);
    expect(b.time).toBe(a.time);
    // Esc closes (the pause's own keys; the autopilot still holds the room's)
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);
    await page.waitForFunction(
      (s) => ((window.__vidro.sceneProbe as { room: RoomProbe }).room.finale.settle ?? 0) > s,
      a.finale.settle,
      { timeout: 5_000 },
    );

    // ---- タイトルへ from far from the workshop (where the script ends, down in the town): the dive back leaves from there,
    // arcs up over the town, and the dive in again comes down onto the same place ----
    await page.waitForFunction(
      () => !!(window.__vidro.sceneProbe as { room: RoomProbe }).room.autoplay?.done,
      undefined,
      { timeout: 150_000 },
    );
    const far = await room(page);
    const shotDir = join(root, 'artifacts/screens/S-42', backend);
    mkdirSync(shotDir, { recursive: true });
    const shots: Record<string, { mean: number; dark: number }> = {};
    const snap = async (name: string): Promise<void> => {
      shots[name] = await luminance(page, await page.screenshot({ path: join(shotDir, `${name}.png`) }));
    };
    await snap('far-play');
    // the game camera of every frame of the way back and in again (debug=1: the world drawn into the orb's image)
    await page.evaluate(() => {
      const w = window as unknown as { __s42Cam?: number[][] };
      w.__s42Cam = [];
      const renderer = window.__vidroDebug?.renderer as unknown as { render: (...a: unknown[]) => unknown };
      const render = renderer.render;
      renderer.render = (...args: unknown[]) => {
        const s = args[0] as { isScene?: boolean; children?: unknown[] };
        const c = args[1] as {
          isPerspectiveCamera?: boolean;
          fov?: number;
          position?: { x: number; y: number; z: number };
        };
        const p = window.__vidro.sceneProbe as { transition?: { value: number } | null };
        // (the home's own camera is the 35-degree one: HOME_COMPOSITION.fovDeg)
        if (s?.isScene && c?.isPerspectiveCamera && c.fov !== 35 && c.position && p.transition)
          w.__s42Cam?.push([p.transition.value, c.position.x, c.position.y, c.position.z]);
        return render.apply(renderer, args);
      };
    });
    await page.evaluate(() => (window.__vidro.sceneProbe as { pause: { ask(): void } }).pause.ask());
    await waitPause(page, "q.phase === 'open'");
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitPause(page, "q.page === 'confirm' && q.writing === 1");
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    for (const [name, below] of [
      ['far-back-1', 0.97],
      ['far-back-2', 0.85],
      ['far-back-3', 0.7],
      ['far-back-4', 0.5],
    ] as const) {
      await waitProbe(
        page,
        `p.transition && p.transition.direction === -1 && p.transition.value < ${below}`,
        5_000,
      );
      await snap(name);
    }
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 10_000);
    await expect(page.locator('[data-item="start"]')).toBeFocused({ timeout: 3_000 });
    await page.keyboard.press('Enter');
    for (const [name, above] of [
      ['far-in-1', 0.6],
      ['far-in-2', 0.8],
      ['far-in-3', 0.93],
    ] as const) {
      await waitProbe(
        page,
        `p.transition && p.transition.direction === 1 && p.transition.value > ${above}`,
        5_000,
      );
      await snap(name);
    }
    await waitProbe(page, "p.screen === 'game' && p.transition === null && p.room.playing", 10_000);
    await snap('far-again');
    const again = await room(page);
    expect(again.position, 'standing where play was left').toEqual(far.position);
    const path = await page.evaluate(() => (window as unknown as { __s42Cam: number[][] }).__s42Cam);
    const eyeY = far.position.y + 1.6;
    const highest = Math.max(...path.map((q) => q[2] ?? 0));
    writeFileSync(
      join(root, `artifacts/S-42/far-${backend}.json`),
      JSON.stringify({ backend, far: far.position, highest, shots, path }, null, 2),
    );
    // it rose over the town on the way (not straight through it)
    expect(highest - eyeY, 'the arc rises well above where play stands').toBeGreaterThan(6);
    for (const [name, l] of Object.entries(shots)) {
      expect(l.dark, `${name}: no black picture`).toBeLessThan(0.35);
      expect(l.mean, `${name}: not dark`).toBeGreaterThan(0.04);
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-42 the dynamic resolution while paused: each new scale is drawn once, no blank picture [${backend}]`, async ({
    page,
  }) => {
    // A target so low that play scales the picture down; under the pause (nothing drawn: the GPU time is about nothing)
    // the governor scales it back up step by step (src/core/perf). Each step changes the canvas: the held picture must
    // be drawn again at it, and the screen must never show an empty canvas. The scales are recorded (S-42 判断待ち).
    test.setTimeout(150_000);
    mkdirSync(join(root, 'artifacts/S-42'), { recursive: true });
    const errors = collectErrors(page);
    await playThroughHome(page, `&debug=1&gpuTrust=1&dynresTarget=2${webgl}`);
    const preset = await page.evaluate(() => window.__vidro.renderScale);
    // play until the governor has scaled the picture down (where the GPU time is trusted; else it keeps the preset)
    await page
      .waitForFunction(() => window.__vidro.renderScale < 0.99, undefined, { timeout: 20_000 })
      .catch(() => undefined);
    const before = await page.evaluate(() => window.__vidro.renderScale);
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    const scales: number[] = [];
    const shots: { mean: number; dark: number }[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 9_000) {
      scales.push(await page.evaluate(() => window.__vidro.renderScale));
      shots.push(await luminance(page, await page.screenshot()));
      await page.waitForTimeout(250);
    }
    const p = await pause(page);
    const changes = scales.filter((s, i) => i > 0 && s !== scales[i - 1]).length;
    writeFileSync(
      join(root, `artifacts/S-42/dynres-${backend}.json`),
      JSON.stringify(
        { backend, preset, before, scales, changes, drawnWhileHeld: p.drawnWhileHeld, shots },
        null,
        2,
      ),
    );
    // drawn once when the time stood, and once per new scale at most a few more
    expect(p.drawnWhileHeld).toBeGreaterThanOrEqual(1 + changes);
    expect(p.drawnWhileHeld).toBeLessThanOrEqual(3 + 2 * changes);
    expect(p.heldFrames, 'otherwise held').toBeGreaterThan(100);
    for (const s of shots) {
      expect(s.dark, 'no blank picture').toBeLessThan(0.35);
      expect(s.mean).toBeGreaterThan(0.04);
    }
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test.describe('in English', () => {
  test.use({ locale: 'en-US' });
  for (const backend of backends) {
    const webgl = backend === 'webgl2' ? '&webgl=1' : '';
    test(`S-42 the pause in English: the frosted tags grow with the words [${backend}]`, async ({ page }) => {
      test.setTimeout(150_000);
      const shotDir = join(root, 'artifacts/screens/S-42', backend);
      mkdirSync(shotDir, { recursive: true });
      const errors = collectErrors(page);
      await playThroughHome(page, webgl);
      await page.keyboard.press('Escape');
      await waitPause(page, "q.phase === 'open'");
      const menu = await writtenLines(page);
      expect(menu.map((l) => l.text)).toEqual(['Resume', 'Back to title']);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await waitPause(page, "q.page === 'confirm' && q.writing === 1");
      const asked = await writtenLines(page);
      await page.screenshot({ path: join(shotDir, 'confirm-en.png') });
      expect(asked.map((l) => l.text)).toEqual(['Return to the title?', 'Yes', 'No']);
      for (const l of [...menu, ...asked]) {
        expect(l.fontPx, l.text).toBeGreaterThanOrEqual(MIN_TEXT_PX);
        expect(l.tag, `${l.text}: the tag holds its words`).toBeGreaterThan(l.ink);
      }
      // the longest line has the widest tag
      const widest = [...asked].sort((x, y) => y.tag - x.tag)[0];
      expect(widest?.text).toBe('Return to the title?');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await waitPause(page, "q.phase === 'closed'", 3_000);
      expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});
