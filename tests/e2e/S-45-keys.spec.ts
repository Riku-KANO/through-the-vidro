import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-45: キーの割り当て (操作とカメラ: すべてのキーは設定で割り当て直せます; アクセシビリティ: キーの割り当て変更). Through the home,
 * as a player plays it, on both render paths:
 *  - keyboard alone: 設定 → 操作 → キーの割り当て (a page of its own: the frosted list, 「キーを押してください」 while it waits);
 *    Esc while it waits gives the waiting up (back to the list); 前へ進む to I, 覗く to P, 置く・拾う・調べる's second key to A —
 *    which 左へ had: the two swap and the page says so; Esc back to 操作, Esc closes
 *  - kept: after a reload the bindings are there; diving in, the prompt shows the key bound (A　手に取る), A takes the vidro,
 *    I walks (W no longer does), P peeks; from the pause the page is in English too, and 初期に戻す puts the design's table back
 *  - a pad alone: the home's drops by 十字 and A, RB to 操作, the page, 覗く's pad button to X, B gives the waiting up, B back
 *  - one AudioContext, no console error or warning
 * Pictures → artifacts/screens/S-45/<backend>/, numbers → artifacts/S-45/keys-<backend>.json.
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
  speed: number;
  orb: string;
  target: string | null;
  peeking: boolean;
  locked: boolean;
}
type Codes = Record<string, string[]>;
interface Bindings {
  keyboardMouse: Codes;
  gamepad: Codes;
}
interface KeysProbe {
  open: boolean;
  focus: { row: number; col: number };
  waiting: { action: string; device: string; slot: number } | null;
  notice: string | null;
  bound: number;
  resets: number;
}
interface SettingsProbe {
  phase: string;
  tab: string;
  row: string | null;
  values: { bindings: Bindings; lang: string };
  keys: KeysProbe;
  saves: { kept: number; refused: number };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** The page's rows (src/ui/settings/keys-logic.ts KEY_ROWS) as the test walks them. */
const ROW = { moveForward: 0, moveBack: 1, moveLeft: 2, moveRight: 3, peek: 4, interact: 5 } as const;
/** W3C standard mapping. */
const PAD = { A: 0, B: 1, X: 2, RB: 5, LT: 6, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

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

async function countContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Base = window.AudioContext;
    if (!Base) return;
    const made: BaseAudioContext[] = [];
    class CountedAudioContext extends Base {
      constructor(options?: AudioContextOptions) {
        super(options);
        made.push(this);
      }
    }
    window.AudioContext = CountedAudioContext;
    (window as unknown as { __s45Contexts: () => number }).__s45Contexts = () => made.length;
  });
}
const contexts = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __s45Contexts: () => number }).__s45Contexts());

async function fakePad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = {
      id: 'S-45 stand-in pad',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons,
      timestamp: 0,
    };
    navigator.getGamepads = () => [pad as unknown as Gamepad];
    (window as unknown as { __s45Pad: (i: number, down: boolean) => void }).__s45Pad = (i, down) => {
      buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
    };
  });
}
async function padPress(page: Page, button: number): Promise<void> {
  const set = (down: boolean) =>
    page.evaluate(
      ([b, d]) => (window as unknown as { __s45Pad: (i: number, d: boolean) => void }).__s45Pad(b, d),
      [button, down] as const,
    );
  await set(true);
  await page.waitForTimeout(120);
  await set(false);
  await page.waitForTimeout(120);
}

const probeOf = <T>(page: Page, key: string): Promise<T> =>
  page.evaluate((k) => {
    const v = (window.__vidro.sceneProbe as Record<string, unknown>)[k];
    return JSON.parse(JSON.stringify(v)) as unknown;
  }, key) as Promise<T>;
const room = (page: Page) => probeOf<RoomProbe>(page, 'room');
const settings = (page: Page) => probeOf<SettingsProbe>(page, 'settings');

async function waitProbe(page: Page, fn: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}
const waitSettings = (page: Page, fn: string, timeout = 10_000) =>
  waitProbe(page, `p.settings && (() => { const q = p.settings; return ${fn}; })()`, timeout);
const waitKeys = (page: Page, fn: string, timeout = 10_000) =>
  waitProbe(
    page,
    `p.settings && p.settings.keys && (() => { const k = p.settings.keys; return ${fn}; })()`,
    timeout,
  );
const waitRoom = (page: Page, fn: string, timeout = 10_000) =>
  waitProbe(page, `p.room && (() => { const r = p.room; return ${fn}; })()`, timeout);

async function toHome(page: Page, query: string): Promise<void> {
  await page.goto(`/?scene=prologue-proto${query}`);
  await waitProbe(page, 'p.load.ready === true', 90_000);
  await page.locator('[data-ui="loading-start"]').click();
  await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
}

/**
 * Every word of the key page at the UI's size (文字と色: 最小の文字サイズは1080p基準で18px), the pane on the screen, and no name
 * cut short or running into the tag beside it (英語版: 札は文字の長さに合わせて伸びる).
 */
async function expectFits(page: Page): Promise<void> {
  const fit = await page.evaluate(() => {
    const el = document.querySelector('[data-ui="settings"] [data-page="keys"]') as HTMLElement;
    const pane = (document.querySelector('[data-ui="settings"]') as HTMLElement).getBoundingClientRect();
    const texts = [...el.querySelectorAll<HTMLElement>('p, span, button')].filter(
      (t) =>
        t.childElementCount === 0 && (t.textContent ?? '').trim() !== '' && t.getClientRects().length > 0,
    );
    // each name's ink against the left edge of the first tag of its row
    const overlaps: string[] = [];
    for (const row of el.querySelectorAll<HTMLElement>('.vd-keys__row')) {
      const name = row.querySelector<HTMLElement>('.vd-keys__action');
      const tag = row.querySelector<HTMLElement>('.vd-keys__cell');
      if (!name || !tag || !name.firstChild) continue;
      const range = document.createRange();
      range.selectNodeContents(name);
      if (range.getBoundingClientRect().right > tag.getBoundingClientRect().left)
        overlaps.push(name.textContent ?? '');
    }
    // the laid-out words wider than the box they are in (an ellipsis, or run out of it)
    const cutShort = (t: HTMLElement): boolean => {
      const s = getComputedStyle(t);
      const inner =
        t.getBoundingClientRect().width -
        Number.parseFloat(s.paddingLeft) -
        Number.parseFloat(s.paddingRight) -
        Number.parseFloat(s.borderLeftWidth) -
        Number.parseFloat(s.borderRightWidth);
      const words = document.createRange();
      words.selectNodeContents(t);
      return words.getBoundingClientRect().width > inner + 0.5 || t.scrollWidth > t.clientWidth + 1;
    };
    return {
      fontPx: texts.map((t) => Number.parseFloat(getComputedStyle(t).fontSize)),
      cut: texts.filter(cutShort).map((t) => t.textContent),
      overlaps,
      inside: pane.top >= 0 && pane.bottom <= window.innerHeight,
    };
  });
  for (const px of fit.fontPx) expect(px).toBeGreaterThanOrEqual(18);
  expect(fit.cut, 'no key or action name cut short').toEqual([]);
  expect(fit.overlaps, 'no name under the tag beside it').toEqual([]);
  expect(fit.inside, 'the pane within the screen').toBe(true);
}

/** The page's visible words: the action names of its rows and what each cell reads. */
async function pageText(page: Page): Promise<{ actions: string[]; cells: string[]; title: string }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-ui="settings"] [data-page="keys"]');
    if (!el || (el as HTMLElement).hidden) return { actions: [], cells: [], title: '' };
    return {
      title: el.querySelector('[data-part="keys-title"]')?.textContent ?? '',
      actions: [...el.querySelectorAll<HTMLElement>('[data-part="keys-action"]')].map(
        (a) => a.textContent ?? '',
      ),
      cells: [...el.querySelectorAll<HTMLElement>('[data-key-cell]')].map((c) => c.textContent ?? ''),
    };
  });
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-45', backend);

  test(`S-45 keys by keyboard alone: the page, the waiting, a swap told, kept, played with [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-45'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await toHome(page, webgl);

    // ---- 設定 → 操作 → キーの割り当て, keyboard alone ----
    await waitProbe(page, "p.focused === 'start'");
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await waitProbe(page, "p.focused === 'settings'");
    await page.keyboard.press('Enter');
    await waitSettings(page, "q.phase === 'open'");
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.tab === 'controls'");
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'keys'");
    await page.keyboard.press('Enter');
    await waitKeys(page, 'k.open === true');
    const opened = await settings(page);
    expect(opened.keys.focus).toEqual({ row: 0, col: 0 });
    expect(opened.keys.waiting).toBeNull();
    await page.waitForTimeout(300);
    const ja = await pageText(page);
    expect(ja.title).toBe('キーの割り当て');
    expect(ja.actions.slice(0, 6)).toEqual([
      '前へ進む',
      '後ろへ下がる',
      '左へ',
      '右へ',
      '覗く',
      '置く・拾う・調べる',
    ]);
    // the first row: W, (none), the left stick
    expect(ja.cells.slice(0, 3)).toEqual(['W', '—', '左スティック']);
    await expectFits(page);
    await page.screenshot({ path: join(shotDir, 'keys-ja.png') });

    // ---- the waiting (キーを押してください), and Esc gives it up: back to the list, nothing changed ----
    await page.keyboard.press('Enter');
    await waitKeys(
      page,
      "k.waiting && k.waiting.action === 'moveForward' && k.waiting.device === 'keyboardMouse'",
    );
    const waitingCell = page.locator('[data-key-cell="0:0"]');
    // the cell lights and waits; over the list: 「前へ進む」に割り当てるキーを押してください (Esc・B でやめる)
    await expect(waitingCell).toHaveText('…', { timeout: 2_000 });
    await expect(page.locator('[data-ui="settings"] [data-part="keys-prompt"]')).toContainText(
      '「前へ進む」に割り当てるキーを押してください',
    );
    await page.screenshot({ path: join(shotDir, 'keys-waiting.png') });
    await page.keyboard.press('Escape');
    await waitKeys(page, 'k.waiting === null && k.open === true');
    expect((await settings(page)).phase).toBe('open');
    expect((await settings(page)).values.bindings.keyboardMouse.moveForward).toEqual(['KeyW']);

    // ---- 前へ進む → I, 覗く → P ----
    await page.keyboard.press('Enter');
    await waitKeys(page, 'k.waiting !== null');
    await page.keyboard.press('KeyI');
    await waitKeys(page, 'k.waiting === null && k.bound === 1');
    for (let i = 0; i < ROW.peek; i++) await page.keyboard.press('ArrowDown');
    await waitKeys(page, `k.focus.row === ${ROW.peek}`);
    await page.keyboard.press('Enter');
    await waitKeys(page, "k.waiting && k.waiting.action === 'peek'");
    await page.keyboard.press('KeyP');
    await waitKeys(page, 'k.bound === 2');
    let s = await settings(page);
    expect(s.values.bindings.keyboardMouse.moveForward).toEqual(['KeyI']);
    expect(s.values.bindings.keyboardMouse.peek).toEqual(['KeyP']);
    expect(s.keys.notice).toBeNull();

    // ---- 置く・拾う・調べる's second key → A, which 左へ had: they swap, and the page says what changed ----
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await waitKeys(page, `k.focus.row === ${ROW.interact} && k.focus.col === 1`);
    await page.keyboard.press('Enter');
    await waitKeys(page, "k.waiting && k.waiting.action === 'interact' && k.waiting.slot === 1");
    await page.keyboard.press('KeyA');
    await waitKeys(page, 'k.bound === 3 && k.notice !== null');
    s = await settings(page);
    expect(s.values.bindings.keyboardMouse.interact).toEqual(['Mouse0', 'KeyA']);
    expect(s.values.bindings.keyboardMouse.moveLeft).toEqual(['KeyE']);
    expect(s.keys.notice).toBe('A を「左へ」から移し、「左へ」は E にしました');
    const notice = page.locator('[data-ui="settings"] [data-part="keys-notice"]');
    // (the page is written at the next frame)
    await expect(notice).toHaveText(s.keys.notice ?? '', { timeout: 2_000 });
    await expect(notice).toBeVisible();
    // (the tags' light settles: 0.26 s)
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shotDir, 'keys-swapped.png') });
    expect(s.saves.kept).toBeGreaterThanOrEqual(3);

    // ---- Esc: back to 操作 on its row (一つ前), Esc again: the pane closes ----
    await page.keyboard.press('Escape');
    await waitKeys(page, 'k.open === false');
    await waitSettings(page, "q.tab === 'controls' && q.row === 'keys' && q.phase === 'open'");
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'");

    // ---- kept: reload, and the bindings are there ----
    await page.reload();
    await waitProbe(page, 'p.load.ready === true', 90_000);
    const kept = await settings(page);
    expect(kept.values.bindings.keyboardMouse.moveForward).toEqual(['KeyI']);
    expect(kept.values.bindings.keyboardMouse.peek).toEqual(['KeyP']);
    expect(kept.values.bindings.keyboardMouse.interact).toEqual(['Mouse0', 'KeyA']);
    expect(kept.values.bindings.keyboardMouse.moveLeft).toEqual(['KeyE']);

    // ---- played with: the prompt shows A, A takes the vidro, I walks (W does not), P peeks ----
    await page.locator('[data-ui="loading-start"]').click();
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
    await page.locator('[data-item="start"]').click();
    await waitProbe(
      page,
      "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
      60_000,
    );
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, "r.locked === true && r.target === 'bench'");
    const prompt = page.locator('[data-ui="prompt"]');
    await expect(prompt).toHaveText('A　手に取る', { timeout: 3_000 });
    await page.keyboard.press('KeyA');
    await waitRoom(page, "r.orb === 'hand'", 3_000);
    const before = await room(page);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyW');
    const afterW = await room(page);
    expect(
      Math.hypot(afterW.position.x - before.position.x, afterW.position.z - before.position.z),
      'W no longer walks',
    ).toBeLessThan(0.02);
    // turn away from the workbench (the mouse is locked: half a turn), then I walks on
    await page.mouse.move(640 + Math.PI / 0.0022, 360, { steps: 12 });
    await page.waitForTimeout(200);
    await page.keyboard.down('KeyI');
    await waitRoom(page, 'r.speed > 0.5', 3_000);
    await page.waitForTimeout(400);
    await page.keyboard.up('KeyI');
    const afterI = await room(page);
    expect(
      Math.hypot(afterI.position.x - before.position.x, afterI.position.z - before.position.z),
    ).toBeGreaterThan(0.1);
    await waitRoom(page, 'r.speed < 0.05', 3_000);
    await page.keyboard.down('KeyP');
    await waitRoom(page, 'r.peeking === true', 3_000);
    await page.keyboard.up('KeyP');
    await waitRoom(page, 'r.peeking === false', 3_000);

    // ---- from the pause: the page in English, and 初期に戻す ----
    await page.keyboard.press('Escape');
    await waitProbe(page, "p.pause.phase === 'open'", 5_000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitSettings(page, "q.phase === 'open' && q.from === 'pause'");
    // 表示 (←, round the ends), 言語 → English
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.values.lang === 'en'");
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('KeyQ');
    await waitSettings(page, "q.tab === 'controls'");
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'keys'");
    await page.keyboard.press('Enter');
    await waitKeys(page, 'k.open === true');
    await page.waitForTimeout(300);
    const en = await pageText(page);
    expect(en.title).toBe('Key bindings');
    expect(en.actions.slice(0, 2)).toEqual(['Move forward', 'Move back']);
    expect(en.cells.slice(0, 3)).toEqual(['I', '—', 'Left stick']);
    await expectFits(page);
    await page.screenshot({ path: join(shotDir, 'keys-en.png') });
    // to the foot: 初期に戻す (Reset to defaults)
    for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowDown');
    await waitKeys(page, 'k.focus.row === 12 && k.focus.col === 0');
    await page.keyboard.press('Enter');
    await waitKeys(page, 'k.resets === 1');
    const reset = await settings(page);
    expect(reset.values.bindings.keyboardMouse.moveForward).toEqual(['KeyW']);
    expect(reset.values.bindings.keyboardMouse.interact).toEqual(['Mouse0', 'KeyE']);
    expect(reset.values.bindings.keyboardMouse.peek).toEqual(['Mouse2']);
    expect(reset.keys.notice).toBe('Back to the default bindings');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'");
    await page.keyboard.press('Escape');
    await waitProbe(page, "p.pause.phase === 'closed'", 5_000);
    // the prompt follows: English, the design's keys again (the one-line hint while the mouse is free)
    await expect(prompt).toHaveText(
      'Click to look around · WASD walk · Right click peek · E place / pick up / touch · Esc release',
      { timeout: 3_000 },
    );

    expect(await contexts(page)).toBe(1);
    writeFileSync(
      join(root, `artifacts/S-45/keys-${backend}.json`),
      JSON.stringify({ backend, kept: kept.values.bindings, reset: reset.values.bindings, errors }, null, 2),
    );
    expect(errors).toEqual([]);
  });

  test(`S-45 keys by a pad alone: the page, 覗く to X, B gives the waiting up [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await fakePad(page);
    await toHome(page, webgl);
    await waitProbe(page, "p.focused === 'start'");
    // 十字 down to 設定, A
    for (let i = 0; i < 3; i++) await padPress(page, PAD.DOWN);
    await waitProbe(page, "p.focused === 'settings'");
    await padPress(page, PAD.A);
    await waitSettings(page, "q.phase === 'open'");
    await padPress(page, PAD.RB);
    await waitSettings(page, "q.tab === 'controls'");
    for (let i = 0; i < 4; i++) await padPress(page, PAD.DOWN);
    await waitSettings(page, "q.row === 'keys'");
    await padPress(page, PAD.A);
    await waitKeys(page, 'k.open === true');
    // 覗く's pad button: down to its row, right to the pad's column
    for (let i = 0; i < ROW.peek; i++) await padPress(page, PAD.DOWN);
    await padPress(page, PAD.RIGHT);
    await padPress(page, PAD.RIGHT);
    await waitKeys(page, `k.focus.row === ${ROW.peek} && k.focus.col === 2`);
    // A waits; B gives the waiting up (fixed: it is the way back)
    await padPress(page, PAD.A);
    await waitKeys(page, "k.waiting && k.waiting.device === 'gamepad'");
    await expect(page.locator('[data-ui="settings"] [data-part="keys-prompt"]')).toContainText(
      '「覗く」に割り当てるボタンを押してください',
      { timeout: 2_000 },
    );
    await padPress(page, PAD.B);
    await waitKeys(page, 'k.waiting === null && k.open === true');
    // A again, X
    await padPress(page, PAD.A);
    await waitKeys(page, 'k.waiting !== null');
    await padPress(page, PAD.X);
    await waitKeys(page, 'k.bound === 1 && k.waiting === null');
    const s = await settings(page);
    expect(s.values.bindings.gamepad.peek).toEqual(['PadX']);
    expect(s.values.bindings.gamepad.interact).toEqual(['PadA']);
    await expect(page.locator(`[data-key-cell="${ROW.peek}:2"]`)).toHaveText('X', { timeout: 2_000 });
    // B: back to 操作; B: the pane closes
    await padPress(page, PAD.B);
    await waitKeys(page, 'k.open === false');
    await padPress(page, PAD.B);
    await waitSettings(page, "q.phase === 'closed'");
    // played with the pad alone: 十字 up to はじめる, A dives; X held peeks, let go it ends; LT does not
    await waitProbe(page, "p.focused === 'settings'");
    for (let i = 0; i < 3; i++) await padPress(page, PAD.UP);
    await waitProbe(page, "p.focused === 'start'");
    await padPress(page, PAD.A);
    await waitProbe(
      page,
      "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
      60_000,
    );
    // (on the pad, the prompt shows the pad's button: A　手に取る)
    await padPress(page, PAD.A);
    await waitRoom(page, "r.orb === 'hand'", 5_000);
    const setPad = (b: number, down: boolean) =>
      page.evaluate(
        ([i, d]) => (window as unknown as { __s45Pad: (i: number, d: boolean) => void }).__s45Pad(i, d),
        [b, down] as const,
      );
    await setPad(PAD.X, true);
    await waitRoom(page, 'r.peeking === true', 3_000);
    await setPad(PAD.X, false);
    await waitRoom(page, 'r.peeking === false', 3_000);
    await setPad(PAD.LT, true);
    await page.waitForTimeout(500);
    expect((await room(page)).peeking, 'LT no longer peeks').toBe(false);
    await setPad(PAD.LT, false);
    expect(errors).toEqual([]);
  });

  test(`S-45 keys by the mouse: the wheel, the middle button, and the next click is a click [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    await toHome(page, webgl);
    await page.locator('[data-item="settings"]').click();
    await waitSettings(page, "q.phase === 'open'");
    await page.locator('[data-ui="settings"] [data-tab="controls"]').click();
    await page.locator('[data-ui="settings"] [data-keys-open]').click();
    await waitKeys(page, 'k.open === true');
    // 小玉を前へ ← the wheel down: 小玉を次へ, which had it, takes the wheel up in exchange
    await page.locator('[data-key-cell="6:0"]').click();
    await waitKeys(page, "k.waiting && k.waiting.action === 'orbPrev'");
    await page.mouse.wheel(0, 120);
    await waitKeys(page, 'k.bound === 1 && k.waiting === null');
    let s = await settings(page);
    expect(s.values.bindings.keyboardMouse.orbPrev).toEqual(['WheelDown']);
    expect(s.values.bindings.keyboardMouse.orbNext).toEqual(['WheelUp']);
    expect(s.keys.notice).toBe('ホイール下 を「小玉を次へ」から移し、「小玉を次へ」は ホイール上 にしました');
    // 前へ進む is walked by holding: the wheel is not taken there (it waits on), Esc gives it up
    await page.locator('[data-key-cell="0:1"]').click();
    await waitKeys(page, "k.waiting && k.waiting.action === 'moveForward'");
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(300);
    expect((await settings(page)).keys.waiting, 'still waiting').not.toBeNull();
    await page.keyboard.press('Escape');
    await waitKeys(page, 'k.waiting === null');
    // 覗く's second key ← the middle button; the next left click on another tag is a click again (it waits)
    await page.locator(`[data-key-cell="${ROW.peek}:1"]`).click();
    await waitKeys(page, "k.waiting && k.waiting.action === 'peek' && k.waiting.slot === 1");
    await page.mouse.down({ button: 'middle' });
    await page.mouse.up({ button: 'middle' });
    await waitKeys(page, 'k.bound === 2 && k.waiting === null');
    s = await settings(page);
    expect(s.values.bindings.keyboardMouse.peek).toEqual(['Mouse2', 'Mouse1']);
    await page.locator(`[data-key-cell="${ROW.interact}:1"]`).click();
    await waitKeys(page, "k.waiting && k.waiting.action === 'interact'", 3_000);
    await page.keyboard.press('Escape');
    await waitKeys(page, 'k.waiting === null');
    // 戻る and the pane's 戻る, by the mouse
    await page.locator('[data-ui="settings"] [data-keys-back]').click();
    await waitKeys(page, 'k.open === false');
    await waitSettings(page, "q.row === 'keys'");
    expect(errors).toEqual([]);
  });
}
