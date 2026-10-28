import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { PAUSE_DUCK } from '../../src/audio/pause';

/**
 * S-43: the settings panel. Through the home (loading → 「はじめる」 → home → 設定, and → the dive → the pause → 設定), as a
 * player plays it, on both render paths:
 *  - it opens from the home's 設定 drop and from the pause's 設定 item (between つづける and タイトルへ), a pane of frosted
 *    glass spreading sideways in 0.3 s, answering the key within 0.1 s with its own glass sound; Esc / B closes it the way it
 *    came (back on 設定), the picture behind it in view all along
 *  - every setting takes effect at once: 品質 the render scale (the game kept: the body, the orb, the scene instance),
 *    視野角 the camera (the pause's held picture drawn again), the volumes their own sliders (the pause's turn-down stays its
 *    own), 言語 the words of the home, the pause and the panel, 覗く the peek (押すたびに切り替え), 文字の大きさ and
 *    コントラスト強化 the UI
 *  - kept in the browser: after a reload they are still there (the scene made with the quality chosen); where the browser
 *    keeps nothing, it says 「この環境では保存できません」 once and plays on
 *  - while the pause holds the picture, no frame goes to the governor (no new render scale)
 *  - keyboard alone, and a pad; one AudioContext and one engine; every voice the UI's or the room's
 * Pictures → artifacts/screens/S-43/<backend>/, numbers → artifacts/S-43/<what>-<backend>.json.
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
  fov: number;
  orb: string;
  target: string | null;
  peeking: boolean;
}
interface Settings {
  quality: string | null;
  fov: number;
  peekMode: string;
  mouseSensitivity: number;
  invertY: boolean;
  volumes: { master: number; sfx: number; ambience: number; ui: number };
  lang: string;
  textSize: string;
  contrast: boolean;
}
interface SettingsProbe {
  phase: 'closed' | 'opening' | 'open' | 'closing';
  open: number;
  from: 'home' | 'pause' | null;
  tab: string;
  row: string | null;
  values: Settings;
  persistent: boolean;
  notices: number;
  opened: number;
  closed: number;
  saves: { kept: number; refused: number };
  requestedAt: number | null;
  respondedAt: number | null;
  sounds: { cue: string; at: number; rang: boolean }[];
  frameMs: { opening: number; open: number; closing: number };
}
interface PauseProbe {
  phase: string;
  page: string;
  focused: string | null;
  yielded: boolean;
  heldFrames: number;
  drawnWhileHeld: number;
}
interface GateProbe {
  state: string;
  contexts: number;
  uiVoices: number;
  voicesStarted: number;
  volumes: Record<string, number> | null;
  sliders: { master: number; sfx: number; ambience: number; music: number; ui: number };
}
interface SoundProbe {
  voicesStarted: number;
  footsteps: { voicesStarted: number };
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
    (window as unknown as { __s43Contexts: () => unknown }).__s43Contexts = () =>
      made.map(({ context, engines }) => ({ state: context.state, engines }));
  });
}
const contexts = (page: Page): Promise<ContextRecord[]> =>
  page.evaluate(() => (window as unknown as { __s43Contexts: () => ContextRecord[] }).__s43Contexts());

/** A stand-in standard gamepad: window.__s43Pad(button, down) presses and releases its buttons. */
async function fakePad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = {
      id: 'S-43 stand-in pad',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons,
      timestamp: 0,
    };
    navigator.getGamepads = () => [pad as unknown as Gamepad];
    (window as unknown as { __s43Pad: (i: number, down: boolean) => void }).__s43Pad = (i, down) => {
      buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
    };
  });
}
/** W3C standard mapping. */
const PAD = { A: 0, B: 1, RB: 5, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

async function padPress(page: Page, button: number): Promise<void> {
  await page.evaluate(
    (b) => (window as unknown as { __s43Pad: (i: number, d: boolean) => void }).__s43Pad(b, true),
    button,
  );
  await page.waitForTimeout(120);
  await page.evaluate(
    (b) => (window as unknown as { __s43Pad: (i: number, d: boolean) => void }).__s43Pad(b, false),
    button,
  );
  await page.waitForTimeout(120);
}

/** Mean luminance and share of near-black pixels of a PNG, decoded by the browser (as in S-42's e2e). */
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
    return JSON.parse(JSON.stringify(v)) as unknown;
  }, key) as Promise<T>;
const room = (page: Page) => probeOf<RoomProbe>(page, 'room');
const settings = (page: Page) => probeOf<SettingsProbe>(page, 'settings');
const pause = (page: Page) => probeOf<PauseProbe>(page, 'pause');
const gate = (page: Page) => probeOf<GateProbe>(page, 'audioGate');
const sound = (page: Page) => probeOf<SoundProbe>(page, 'sound');
const shell = (page: Page) =>
  page.evaluate(() => {
    const v = window.__vidro;
    return {
      quality: v.quality,
      qualityChoice: v.qualityChoice,
      qualityOrigin: v.qualityOrigin,
      qualitySwitchesInPlace: v.qualitySwitchesInPlace,
      sceneInstances: v.sceneInstances,
      renderScale: v.renderScale,
      idleFrames: v.idleFrames,
      errors: v.errors,
    };
  });

async function waitProbe(page: Page, fn: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}
const waitSettings = (page: Page, fn: string, timeout = 10_000) =>
  waitProbe(page, `p.settings && (() => { const q = p.settings; return ${fn}; })()`, timeout);
const waitPause = (page: Page, fn: string, timeout = 10_000) =>
  waitProbe(page, `p.pause && (() => { const q = p.pause; return ${fn}; })()`, timeout);
const waitRoom = (page: Page, fn: string, timeout = 10_000) =>
  waitProbe(page, `p.room && (() => { const r = p.room; return ${fn}; })()`, timeout);

/** The world's draws since installed (debug=1: wrappers call on with apply). */
async function countRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __s43Renders?: number };
    if (w.__s43Renders !== undefined) return;
    w.__s43Renders = 0;
    const renderer = window.__vidroDebug?.renderer as unknown as { render: (...a: unknown[]) => unknown };
    if (!renderer) throw new Error('no __vidroDebug.renderer (debug=1)');
    const render = renderer.render;
    renderer.render = (...args: unknown[]) => {
      w.__s43Renders = (w.__s43Renders ?? 0) + 1;
      return render.apply(renderer, args);
    };
  });
}
const renders = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __s43Renders?: number }).__s43Renders ?? 0);

/** Marks the page time of the next key down. */
async function markKey(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __s43KeyAt: number | null };
    w.__s43KeyAt = null;
    window.addEventListener(
      'keydown',
      () => {
        w.__s43KeyAt ??= performance.now();
      },
      { capture: true, once: true },
    );
  });
}
const keyAt = (page: Page): Promise<number | null> =>
  page.evaluate(() => (window as unknown as { __s43KeyAt: number | null }).__s43KeyAt);

/** Loading → 「はじめる」 → the home at rest. */
async function toHome(page: Page, query: string): Promise<void> {
  await page.goto(`/?scene=prologue-proto${query}`);
  await waitProbe(page, 'p.load.ready === true', 90_000);
  await page.locator('[data-ui="loading-start"]').click();
  await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
}

/** …→ 「はじめる」 → landed and playing. */
async function playThroughHome(page: Page, query: string): Promise<void> {
  await toHome(page, query);
  await page.locator('[data-item="start"]').click();
  await waitProbe(
    page,
    "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
    60_000,
  );
}

/** The panel's visible text: the tabs, and the shown page's labels and options. */
async function panelText(page: Page): Promise<{ tabs: string[]; labels: string[]; fontPx: number[] }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-ui="settings"]');
    if (!el) return { tabs: [], labels: [], fontPx: [] };
    const tabs = [...el.querySelectorAll<HTMLElement>('[data-tab]')].map((b) => b.textContent ?? '');
    const shown = el.querySelector('[data-page]:not([hidden])');
    const texts = [
      ...(shown?.querySelectorAll<HTMLElement>('.vd-settings__label, .vd-settings__option') ?? []),
    ];
    return {
      tabs,
      labels: texts.map((t) => t.textContent ?? ''),
      fontPx: [
        ...el.querySelectorAll<HTMLElement>(
          '[data-tab], .vd-settings__label, .vd-settings__option, .vd-settings__value',
        ),
      ]
        .filter((t) => t.getClientRects().length > 0)
        .map((t) => Number.parseFloat(getComputedStyle(t).fontSize)),
    };
  });
}

/** The pause's written lines on the page shown. */
async function pauseLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-ui="pause"] [data-page]:not([hidden]) [data-part="ink"]',
      ),
    ].map((i) => i.textContent ?? ''),
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-43', backend);

  test(`S-43 from the home: the pane spreads, keyboard alone, every screen’s words change, Esc goes back [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-43'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await toHome(page, webgl);
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
    expect((await settings(page)).phase).toBe('closed');

    // ---- open: keyboard alone, from the home's drops (はじめる → つづきから → 残響 → 設定) ----
    await waitProbe(page, "p.focused === 'start'");
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await waitProbe(page, "p.focused === 'settings'");
    // held half way through the opening for a picture of the pane spreading sideways (the probe's hold)
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { settings: { hold: number | null } }).settings.hold = 0.15;
    });
    await markKey(page);
    await page.keyboard.press('Enter');
    await waitSettings(page, "q.phase === 'opening' && q.open > 0.3");
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shotDir, 'home-opening.png') });
    const spreading = await page.locator('[data-ui="settings"] [data-part="glass"]').boundingBox();
    const full = await page.locator('[data-ui="settings"]').boundingBox();
    expect(spreading?.width ?? 0, 'part way: narrower than the pane').toBeLessThan((full?.width ?? 0) * 0.8);
    expect(spreading?.height, 'spreading sideways: as high as the pane').toBeCloseTo(full?.height ?? 0, 0);
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { settings: { hold: number | null } }).settings.hold = null;
    });
    await waitSettings(page, "q.phase === 'open'", 3_000);
    const opened = await settings(page);
    const pressed = await keyAt(page);
    expect(opened.from).toBe('home');
    // 入力から0.1秒以内に必ず音と動きで反応する (UIの原則 3), with the pane's own glass sound (遷移のルール 6)
    expect(
      (opened.respondedAt ?? Number.POSITIVE_INFINITY) - (pressed ?? 0),
      'moved within 0.1 s',
    ).toBeLessThan(100);
    const openSound = opened.sounds.find((s) => s.cue === 'open');
    expect(openSound?.rang, 'its opening rang').toBe(true);
    expect((openSound?.at ?? Number.POSITIVE_INFINITY) - (pressed ?? 0)).toBeLessThan(100);
    expect(opened.tab).toBe('graphics');
    expect(opened.row).toBeNull();
    // the drops stepped aside; the orb behind the pane stays in view
    await page.waitForTimeout(400);
    const homeShot = await page.screenshot({ path: join(shotDir, 'home-open.png') });
    const homeLook = await luminance(page, homeShot);
    expect(homeLook.dark, 'no black picture behind the pane').toBeLessThan(0.9);
    const text = await panelText(page);
    expect(text.tabs).toEqual(['画質', '操作', '音', '表示とアクセシビリティ']);
    expect(text.labels).toEqual(['品質', '自動', '低', '中', '高', '視野角']);
    for (const px of text.fontPx) expect(px).toBeGreaterThanOrEqual(MIN_TEXT_PX);
    // the pane is narrower than the screen: the picture shows beside it
    const box = await page.locator('[data-ui="settings"]').boundingBox();
    expect(box?.width ?? 1280).toBeLessThan(1280 * 0.75);

    // ---- keyboard: tabs by ←→, rows by ↓↑, values by ←→, Q / E between tabs ----
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.tab === 'controls' && q.row === null");
    await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'peekMode'");
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.values.peekMode === 'toggle'");
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.row === 'sensitivity' && q.values.mouseSensitivity === 1.25");
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitSettings(page, "q.row === 'invertY' && q.values.invertY === true");
    await page.keyboard.press('Enter');
    await waitSettings(page, 'q.values.invertY === false');
    // E twice: 音, then 表示 — the focus stays in the rows (the third row there: コントラスト強化)
    await page.keyboard.press('KeyE');
    await page.keyboard.press('KeyE');
    await waitSettings(page, "q.tab === 'display' && q.row === 'contrast'");

    // ---- 文字の大きさ: the UI's text grows (3 steps); コントラスト強化: the glass's edges and the frost ----
    const labelPx = async (): Promise<number> =>
      page.evaluate(() =>
        Number.parseFloat(
          getComputedStyle(document.querySelector('[data-item="start"] .vd-drop__label') as Element).fontSize,
        ),
      );
    const px0 = await labelPx();
    await page.keyboard.press('ArrowUp');
    await waitSettings(page, "q.row === 'textSize'");
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.values.textSize === 'large'");
    expect(await labelPx()).toBeCloseTo(px0 * 1.2, 0);
    await page.keyboard.press('ArrowLeft');
    await waitSettings(page, "q.values.textSize === 'normal'");
    expect(await labelPx()).toBeCloseTo(px0, 1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.row === 'contrast' && q.values.contrast === true");
    expect(await page.locator('.vd-root').evaluate((r) => r.classList.contains('vd-contrast'))).toBe(true);
    const frostBg = await page
      .locator('[data-ui="settings"] [data-part="glass"]')
      .evaluate((g) => getComputedStyle(g).backgroundColor);
    expect(frostBg, 'the frost behind the text is denser').toMatch(/rgba\(1\d, 1\d, 2\d, 0\.7/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'contrast.png') });
    await page.keyboard.press('ArrowLeft');
    await waitSettings(page, 'q.values.contrast === false');

    // ---- 言語: English — the panel's, the home's (and later the pause's) words ----
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await waitSettings(page, "q.row === 'lang'");
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.values.lang === 'en'");
    const en = await panelText(page);
    expect(en.tabs).toEqual(['Graphics', 'Controls', 'Sound', 'Display & accessibility']);
    expect(en.labels.slice(0, 3)).toEqual(['Language', '日本語', 'English']);
    expect(await page.locator('[data-item="settings"] .vd-drop__label').textContent()).toBe('Settings');
    expect(await page.locator('.vd-root').getAttribute('lang')).toBe('en');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotDir, 'english.png') });

    // ---- the mouse: a tab clicked; hover swells and rings; a click chooses; a slider follows the pointer ----
    await page.locator('[data-ui="settings"] [data-tab="graphics"]').click();
    await waitSettings(page, "q.tab === 'graphics' && q.row === null");
    const high = page.locator('[data-ui="settings"] [data-row="quality"][data-option="high"]');
    const ticks = async (): Promise<number> =>
      (await settings(page)).sounds.filter((s) => s.cue === 'tick' && s.rang).length;
    const ticks0 = await ticks();
    await high.hover();
    await expect(high).toHaveClass(/is-hover/);
    await expect.poll(ticks, { timeout: 2_000 }).toBeGreaterThan(ticks0);
    await high.click();
    await waitSettings(page, "q.values.quality === 'high' && q.row === 'quality'");
    await page.waitForFunction(() => window.__vidro.quality === 'high' && window.__vidro.renderScale === 1);
    await expect(high).toHaveAttribute('aria-pressed', 'true');
    const track = await page.locator('[data-ui="settings"] [data-track="fov"]').boundingBox();
    if (!track) throw new Error('no 視野角 slider');
    await page.mouse.move(track.x + 1, track.y + track.height / 2);
    await page.mouse.down();
    await waitSettings(page, "q.values.fov === 60 && q.row === 'fov'");
    await page.mouse.move(track.x + track.width * 0.75, track.y + track.height / 2, { steps: 5 });
    await waitSettings(page, 'q.values.fov === 90');
    await page.mouse.up();
    await waitSettings(page, 'q.values.fov === 90');
    await page.mouse.move(20, 700);

    // ---- Esc: the pane shrinks away (the opening played back), the home's 設定 drop has the focus again ----
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closing'", 2_000);
    await waitSettings(page, "q.phase === 'closed'", 2_000);
    await waitProbe(page, "p.focused === 'settings'");
    const closed = await settings(page);
    expect(closed.sounds.some((s) => s.cue === 'close' && s.rang)).toBe(true);
    // the close makes no long frame (headless, as S-42: a generous bound; the opening here waited for a screenshot, the
    // pause's test measures it)
    expect(closed.frameMs.closing).toBeLessThan(100);
    // and the drops take the keys again: down to クレジット, up to 設定, Enter opens it again
    await page.keyboard.press('ArrowDown');
    await waitProbe(page, "p.focused === 'credits'");
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await waitSettings(page, "q.phase === 'open' && q.opened === 2");
    // the language is still English, and back to Japanese for the next test's sake is not needed (a new page)
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'", 2_000);

    expect(await contexts(page)).toHaveLength(1);
    const g = await gate(page);
    expect(g.contexts).toBe(1);
    writeFileSync(
      join(root, `artifacts/S-43/home-${backend}.json`),
      JSON.stringify({ backend, opened, closed: closed.frameMs, homeLook }, null, 2),
    );
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-43 from the pause: each setting takes effect at once, the quality without losing the game [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-43'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await fakePad(page);
    await playThroughHome(page, `&debug=1${webgl}`);
    await countRenders(page);

    // ---- a game with a state: the vidro taken, a few steps walked ----
    await waitRoom(page, "r.target === 'bench'", 10_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand'", 5_000);
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(400);
    const before = await room(page);
    const shell0 = await shell(page);
    expect(shell0.quality).toBe('mid');
    expect(shell0.qualityChoice).toBe('mid');

    // ---- the pause's items: つづける / 設定 / タイトルへ (設計書の順) ----
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    // the time slowed to a stop as the frost spread: from here it stands
    const stood = (await room(page)).time;
    expect(await pauseLines(page)).toEqual(['つづける', '設定', 'タイトルへ']);
    await page.keyboard.press('ArrowDown');
    await waitPause(page, "q.focused === 'settings'");
    await page.keyboard.press('Enter');
    await waitSettings(page, "q.phase === 'open' && q.from === 'pause'");
    expect((await pause(page)).yielded).toBe(true);
    await page.waitForTimeout(400);
    const pauseShot = await page.screenshot({ path: join(shotDir, 'pause-open.png') });
    const pauseLook = await luminance(page, pauseShot);
    expect(pauseLook.dark, 'no black picture').toBeLessThan(0.5);
    expect(pauseLook.mean).toBeGreaterThan(0.04);

    // ---- 品質: 中 → 低 — the render scale at once, the scene and the game kept, the held picture drawn again ----
    const drawn0 = await renders(page);
    await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'quality' && q.values.quality === 'mid'");
    await page.keyboard.press('ArrowLeft');
    await waitSettings(page, "q.values.quality === 'low'");
    await page.waitForFunction(() => window.__vidro.quality === 'low');
    const low = await shell(page);
    expect(low.renderScale).toBeCloseTo(0.67, 2);
    expect(low.qualityChoice).toBe('low');
    expect(low.qualitySwitchesInPlace).toBe(1);
    expect(low.sceneInstances, 'the scene is not made again').toBe(shell0.sceneInstances);
    await page.waitForTimeout(300);
    expect(await renders(page), 'the held picture drawn again at the new scale').toBeGreaterThan(drawn0);
    const atLow = await room(page);
    expect(atLow.orb, 'the vidro still in hand').toBe('hand');
    expect(
      Math.hypot(atLow.position.x - before.position.x, atLow.position.z - before.position.z),
    ).toBeLessThan(0.01);
    expect(atLow.time, 'the time stands').toBe(stood);

    // ---- 視野角: 70 → 80 — the camera now, drawn again while the time stands ----
    await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'fov'");
    const drawn1 = await renders(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.fov === 80');
    await waitRoom(page, 'Math.abs(r.fov - 80) < 0.01');
    await page.waitForTimeout(300);
    expect(await renders(page)).toBeGreaterThan(drawn1);
    const held = await renders(page);
    await page.waitForTimeout(500);
    expect(await renders(page), 'and held again').toBe(held);
    await page.screenshot({ path: join(shotDir, 'pause-fov80.png') });

    // ---- 音: 全体・効果音・環境音・UI — each its own slider; the pause's turn-down stays on top ----
    // E twice, from 画質's second row: 音's second row (効果音); up to 全体
    await page.keyboard.press('KeyE');
    await page.keyboard.press('KeyE');
    await waitSettings(page, "q.tab === 'sound' && q.row === 'sfx'");
    await page.keyboard.press('ArrowUp');
    await waitSettings(page, "q.row === 'master'");
    const g0 = await gate(page);
    await page.keyboard.press('ArrowLeft');
    await waitSettings(page, `Math.abs(q.values.volumes.master - ${g0.sliders.master - 0.05}) < 1e-6`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'ambience'");
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await waitSettings(page, `Math.abs(q.values.volumes.ambience - ${g0.sliders.ambience - 0.1}) < 1e-6`);
    await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await waitSettings(page, "q.row === 'ui' && Math.abs(q.values.volumes.ui - 0.8) < 1e-6");
    const g1 = await gate(page);
    expect(g1.sliders.master).toBeCloseTo(g0.sliders.master - 0.05, 6);
    expect(g1.sliders.ambience).toBeCloseTo(g0.sliders.ambience - 0.1, 6);
    expect(g1.sliders.ui).toBeCloseTo(0.8, 6);
    expect(g1.sliders.sfx).toBe(g0.sliders.sfx);
    expect(g1.volumes?.master).toBeCloseTo(g1.sliders.master, 6);
    // the ambience as the mix plays it: the player's slider, under the pause's turn-down
    expect(g1.volumes?.ambience).toBeCloseTo(g1.sliders.ambience * (PAUSE_DUCK.ambience ?? 1), 6);

    // ---- 操作: 覗く 押すたびに切り替え; the mouse's sensitivity — the world takes them ----
    // Q, from 音's last row: 操作's last (上下の反転); up twice to 覗く
    await page.keyboard.press('KeyQ');
    await waitSettings(page, "q.tab === 'controls' && q.row === 'invertY'");
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await waitSettings(page, "q.row === 'peekMode'");
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.values.peekMode === 'toggle'");
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.mouseSensitivity === 1.5');

    // ---- the pad: RB to 音, B closes the pane (back on the pause's 設定), A opens it again, B, B resumes ----
    await padPress(page, PAD.RB);
    await waitSettings(page, "q.tab === 'sound'");
    await padPress(page, PAD.B);
    await waitSettings(page, "q.phase === 'closed'", 2_000);
    await waitPause(page, "q.yielded === false && q.focused === 'settings' && q.phase === 'open'");
    expect(await pauseLines(page)).toEqual(['つづける', '設定', 'タイトルへ']);
    await padPress(page, PAD.A);
    await waitSettings(page, "q.phase === 'open' && q.from === 'pause'");
    await padPress(page, PAD.B);
    await waitSettings(page, "q.phase === 'closed'", 2_000);
    await waitPause(page, "q.yielded === false && q.phase === 'open'");
    await padPress(page, PAD.B);
    await waitPause(page, "q.phase === 'closed'", 3_000);

    // ---- back in play: the game as it was, at 低, with the new field of view and the toggled peek ----
    const after = await room(page);
    expect(after.orb).toBe('hand');
    expect(
      Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z),
    ).toBeLessThan(0.05);
    expect(after.fov).toBeCloseTo(80, 2);
    expect((await shell(page)).sceneInstances).toBe(shell0.sceneInstances);
    // 押すたびに切り替え: a press of the right button starts the peek, which stays after it is let go; the next ends it
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peeking === true', 3_000);
    await page.waitForTimeout(400);
    expect((await room(page)).peeking, 'still peeking after the button was let go').toBe(true);
    await waitRoom(page, 'Math.abs(r.fov - 74) < 0.05', 3_000);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peeking === false', 3_000);

    // ---- one AudioContext, one engine; every voice the UI's (pings, the pause's, the panel's) or the room's ----
    const made = await contexts(page);
    expect(made).toHaveLength(1);
    expect(made[0]?.engines).toBe(1);
    const g2 = await gate(page);
    const s2 = await sound(page);
    expect(g2.voicesStarted).toBe(g2.uiVoices + s2.voicesStarted + s2.footsteps.voicesStarted);
    const p = await pause(page);
    // the pane's opening and closing make no long frame (パネルの開閉で長いフレームを作らない; headless: a generous bound)
    const frames = (await settings(page)).frameMs;
    expect(frames.opening).toBeLessThan(100);
    expect(frames.closing).toBeLessThan(100);
    writeFileSync(
      join(root, `artifacts/S-43/pause-${backend}.json`),
      JSON.stringify(
        {
          backend,
          before,
          after,
          shell0,
          low,
          pauseLook,
          drawnWhileHeld: p.drawnWhileHeld,
          gate: g2,
          frames,
        },
        null,
        2,
      ),
    );
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-43 自動 chosen in play: it measures as the game goes on and switches in place, the game kept [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    // a short window and a forced pick (the governor's test hooks), so that 自動 decides within the test
    await playThroughHome(page, `&autoWindow=2&autoForce=high&dynres=0${webgl}`);
    await waitRoom(page, "r.target === 'bench'", 10_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand'", 5_000);
    const s0 = await shell(page);
    expect(s0.quality).toBe('mid');
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    await page.locator('[data-pause-item="settings"]').click();
    await waitSettings(page, "q.phase === 'open' && q.from === 'pause'");
    await page.locator('[data-ui="settings"] [data-row="quality"][data-option="auto"]').click();
    await waitSettings(page, "q.values.quality === 'auto'");
    expect((await shell(page)).qualityChoice).toBe('auto');
    // while the pause holds the picture, nothing is measured: still mid two seconds on
    await page.waitForTimeout(2_500);
    expect((await shell(page)).quality).toBe('mid');
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'", 2_000);
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);
    // in play it measures, picks (forced: high) and switches without making the scene again
    await page.waitForFunction(() => window.__vidro.quality === 'high', undefined, { timeout: 30_000 });
    const s1 = await shell(page);
    expect(s1.qualityChoice).toBe('auto');
    expect(s1.qualitySwitchesInPlace).toBe(1);
    expect(s1.sceneInstances).toBe(s0.sceneInstances);
    expect(s1.renderScale).toBe(1);
    expect((await room(page)).orb, 'the vidro still in hand').toBe('hand');
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-43 kept: after a reload the settings are there, the scene made with the chosen quality [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await toHome(page, webgl);
    // keyboard: 設定 → 高, 視野角 90, then English
    await page.locator('[data-item="settings"]').click();
    await waitSettings(page, "q.phase === 'open'");
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.values.quality === 'high'");
    await page.waitForFunction(() => window.__vidro.quality === 'high' && window.__vidro.renderScale === 1);
    await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.fov === 90');
    // Q: from 画質 round to 表示, on its second row (文字の大きさ); up to 言語
    await page.keyboard.press('KeyQ');
    await waitSettings(page, "q.tab === 'display' && q.row === 'textSize'");
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, "q.values.lang === 'en'");
    const kept = await settings(page);
    expect(kept.persistent).toBe(true);
    expect(kept.saves.refused).toBe(0);
    expect(kept.saves.kept).toBeGreaterThanOrEqual(3);

    await page.reload();
    await waitProbe(page, 'p.load.ready === true', 90_000);
    const s = await shell(page);
    expect(s.qualityOrigin).toBe('saved');
    expect(s.quality).toBe('high');
    expect(s.renderScale).toBe(1);
    expect(s.sceneInstances).toBe(1);
    const back = await settings(page);
    expect(back.values.quality).toBe('high');
    expect(back.values.fov).toBe(90);
    expect(back.values.lang).toBe('en');
    expect(await page.locator('[data-ui="loading-start"]').textContent()).toContain('Begin');
    await page.locator('[data-ui="loading-start"]').click();
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
    expect(await page.locator('[data-item="settings"] .vd-drop__label').textContent()).toBe('Settings');
    await page.locator('[data-item="start"]').click();
    await waitProbe(
      page,
      "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
      60_000,
    );
    expect((await room(page)).fov, 'the dive ends at the chosen field of view').toBeCloseTo(90, 2);
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-43 nothing kept: the settings still take effect, and it says so once [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
    });
    await toHome(page, webgl);
    await page.locator('[data-item="settings"]').click();
    await waitSettings(page, "q.phase === 'open'");
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.fov === 75 && q.notices === 1');
    await page.waitForTimeout(500);
    const notice = page.locator('[data-ui="settings"] [data-part="notice"]');
    expect(await notice.textContent()).toBe('この環境では保存できません');
    expect(Number(await notice.evaluate((n) => getComputedStyle(n).opacity))).toBeGreaterThan(0.9);
    await page.screenshot({ path: join(shotDir, 'cannot-save.png') });
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.fov === 80');
    const s = await settings(page);
    expect(s.notices, 'told once').toBe(1);
    expect(s.persistent).toBe(false);
    expect(s.saves.refused).toBe(2);
    // and the game plays on with them
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'", 2_000);
    await page.locator('[data-item="start"]').click();
    await waitProbe(
      page,
      "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
      60_000,
    );
    expect((await room(page)).fov).toBeCloseTo(80, 2);
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-43 the pause holds the picture: no frame of it goes to the governor [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    // a target the governor lowers the render scale for (as S-42's sensor of the pause under dynamic resolution)
    await playThroughHome(page, `&debug=1&gpuTrust=1&dynresTarget=2${webgl}`);
    await page.waitForTimeout(3_000);
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'");
    await page.waitForTimeout(300);
    const s0 = await shell(page);
    const scales: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000) {
      scales.push(await page.evaluate(() => window.__vidro.renderScale));
      await page.waitForTimeout(250);
    }
    const s1 = await shell(page);
    expect(s1.idleFrames - s0.idleFrames, 'the still frames were counted').toBeGreaterThan(100);
    expect(new Set(scales).size, 'no new render scale while the picture stands').toBe(1);
    expect(scales[0]).toBe(s0.renderScale);
    writeFileSync(
      join(root, `artifacts/S-43/governor-${backend}.json`),
      JSON.stringify({ backend, scales, idleFrames: s1.idleFrames - s0.idleFrames }, null, 2),
    );
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
