import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-48: the quality, continued. Through the home, as a player plays it, on both render paths:
 *  - 初回は自動: with no ?quality and nothing kept, the game starts under 自動; it measures only while the game itself is drawn
 *    (not the light home orb), switches in place (the scene is not made again), keeps its pick, and the next visit builds
 *    from that preset (the peek image's scale, the anti-aliasing, the shadows and the glass all of it) and measures again.
 *    The settings' 自動 tag carries the preset in use (自動（低）)
 *  - in play, 低 ⇄ 高 from the pause's settings: the render scale, the peek image's scale and the finishing's anti-aliasing
 *    change at once; the line under 品質 names the shadows and the glass alone (they wait for the next time); the switch makes
 *    no long frame and no full-screen pipeline (the anti-aliasing's shaders were made while loading); the game is kept (the
 *    body, the vidro, the drop taken, the light that settled the bridge, the gate open)
 *  - the sensors: the URL's ?quality still wins over what is kept; a bench neither reads nor writes it
 *  - one AudioContext and one engine; no console error or warning
 * Pictures → artifacts/screens/S-48/<backend>/, numbers → artifacts/S-48/<what>-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface PeekQuality {
  peekScale: number;
  antialias: 'fxaa' | 'smaa' | 'none';
  backWidth: number;
  backHeight: number;
}
interface RoomProbe {
  ready: boolean;
  playing: boolean;
  time: number;
  position: V3;
  yaw: number;
  orb: string;
  locked: boolean;
  target: string | null;
  peeking: boolean;
  peekAmount: number;
  handPresence: number;
  dropTaken: boolean;
  drops: { id: string; state: string }[];
  areas: Record<string, unknown>;
  finale: { settle: number; gate: number; settledSegments: number; gateOpen: boolean };
  autoplay: { step: string; done: boolean } | null;
  peekQuality: PeekQuality;
}
interface Shell {
  quality: string;
  qualityChoice: string;
  qualityOrigin: string;
  qualityPicked: boolean;
  qualityKept: string | null;
  qualityDecision: { level: string; measuredAt: string } | null;
  qualitySwitchesInPlace: number;
  qualitySwitchFrames: number[];
  sceneInstances: number;
  renderScale: number;
  errors: string[];
}
interface ContextRecord {
  state: string;
  engines: number;
}
interface Made {
  at: string;
  quad: boolean;
  material: string;
  /** The preset in use when it was made, and the page time (ms). */
  quality: string;
  ms: number;
}
declare global {
  interface Window {
    __s48?: Made[];
  }
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** The headless bound of a switch's frames (S-48 受け入れ条件: ヘッドレスで 100ms 未満). */
const SWITCH_FRAME_MS = 100;
/** The pick 自動 keeps (settings-store.ts AUTO_PICK_KEY). */
const PICK_KEY = 'vidro.autoQuality';
const SETTINGS_KEY = 'vidro.settings';
/** 技術設計 > 品質プリセット: 覗いたときの裏の層 0.5 / 0.6 / 0.75, 描画解像度 0.67 / 0.85 / 1.0. */
const PEEK_SCALE = { low: 0.5, mid: 0.6, high: 0.75 } as const;
const RENDER_SCALE = { low: 0.67, mid: 0.85, high: 1 } as const;
/** 技術設計 > 品質プリセット: アンチエイリアス FXAA / SMAA / SMAA. */
const ANTIALIAS = { low: 'fxaa', mid: 'smaa', high: 'smaa' } as const;
const LATER = '影とガラスの描き方は次回から変わります';

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
    (window as unknown as { __s48Contexts: () => unknown }).__s48Contexts = () =>
      made.map(({ context, engines }) => ({ state: context.state, engines }));
  });
}
const contexts = (page: Page): Promise<ContextRecord[]> =>
  page.evaluate(() => (window as unknown as { __s48Contexts: () => ContextRecord[] }).__s48Contexts());

/**
 * Runs in the page before its own script (S-38's tracer, shortened): notes every render pipeline three creates, whether it
 * is a full-screen pass (three's QuadMesh: the finishing, its anti-aliasing), and where the game was ('game' once playing).
 */
function installTracer(): void {
  interface RenderObject {
    object?: { isQuadMesh?: boolean };
    material?: { name?: string; type?: string };
  }
  interface Backend {
    createRenderPipeline(renderObject: RenderObject, promises?: unknown): unknown;
  }
  const made: Made[] = [];
  window.__s48 = made;
  const where = (): string => {
    const p = window.__vidro?.sceneProbe as
      | { screen?: string; transition?: { id: string } | null; room?: { playing: boolean } }
      | undefined;
    if (p?.room?.playing) return 'game';
    return p?.transition?.id ?? p?.screen ?? '?';
  };
  const install = (debug: { renderer: { backend: Backend } }): void => {
    const backend = debug.renderer.backend;
    const create = backend.createRenderPipeline;
    backend.createRenderPipeline = function (this: Backend, ro: RenderObject, promises?: unknown) {
      made.push({
        at: where(),
        quad: ro.object?.isQuadMesh === true,
        material: ro.material?.name || ro.material?.type || '?',
        quality: String(window.__vidro?.quality ?? '?'),
        ms: Math.round(performance.now()),
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
const traced = (page: Page): Promise<Made[]> => page.evaluate(() => window.__s48 ?? []);

const probeOf = <T>(page: Page, key: string): Promise<T> =>
  page.evaluate((k) => {
    const v = (window.__vidro.sceneProbe as Record<string, unknown>)[k];
    return JSON.parse(JSON.stringify(v)) as unknown;
  }, key) as Promise<T>;
const room = (page: Page) => probeOf<RoomProbe>(page, 'room');
const shell = (page: Page): Promise<Shell> =>
  page.evaluate(() => {
    const v = window.__vidro as unknown as Shell;
    return JSON.parse(
      JSON.stringify({
        quality: v.quality,
        qualityChoice: v.qualityChoice,
        qualityOrigin: v.qualityOrigin,
        qualityPicked: v.qualityPicked,
        qualityKept: v.qualityKept,
        qualityDecision: v.qualityDecision,
        qualitySwitchesInPlace: v.qualitySwitchesInPlace,
        qualitySwitchFrames: v.qualitySwitchFrames,
        sceneInstances: v.sceneInstances,
        renderScale: v.renderScale,
        errors: v.errors,
      }),
    ) as Shell;
  });
const kept = (page: Page, key: string): Promise<unknown> =>
  page.evaluate((k) => {
    const v = localStorage.getItem(k);
    return v === null ? null : (JSON.parse(v) as unknown);
  }, key);

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

/** Loading → 「はじめる」 → the home at rest. */
async function toHome(page: Page): Promise<void> {
  await waitProbe(page, 'p.load.ready === true', 90_000);
  await page.locator('[data-ui="loading-start"]').click();
  await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
}
/** The home → 「はじめる」 → landed and playing. */
async function dive(page: Page): Promise<void> {
  await page.locator('[data-item="start"]').click();
  await waitProbe(
    page,
    "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
    60_000,
  );
}
const qualityOption = (page: Page, level: string) =>
  page.locator(`[data-ui="settings"] [data-row="quality"][data-option="${level}"]`);
const later = (page: Page) => page.locator('[data-ui="settings"] [data-part="quality-later"]');

/** From play: the pause, then its 設定. */
async function openSettingsFromPause(page: Page): Promise<void> {
  await page.evaluate(() => (window.__vidro.sceneProbe as { pause: { ask(): void } }).pause.ask());
  await waitPause(page, "q.phase === 'open'");
  await page.locator('[data-pause-item="settings"]').click();
  await waitSettings(page, "q.phase === 'open' && q.from === 'pause'");
}
/** The panel, then the pause, closed (Esc, Esc): back in play. */
async function backToPlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await waitSettings(page, "q.phase === 'closed'", 3_000);
  await page.keyboard.press('Escape');
  await waitPause(page, "q.phase === 'closed'", 3_000);
}

/**
 * The peek image and the finishing as the preset `level` makes them (技術設計 > 品質プリセット): its scale, its anti-aliasing,
 * and the peek image's target at that scale of the canvas' size now (read together in the page).
 */
async function expectPeekAt(page: Page, level: 'low' | 'mid' | 'high'): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const q = (window.__vidro.sceneProbe as { room: RoomProbe }).room.peekQuality;
          const c = document.querySelector('#app canvas') as HTMLCanvasElement | null;
          return {
            peekScale: q.peekScale,
            antialias: q.antialias,
            back: [q.backWidth, q.backHeight],
            canvas: [c?.width ?? 0, c?.height ?? 0],
          };
        }),
      { message: `the peek image and the anti-aliasing of ${level}` },
    )
    .toEqual(
      expect.objectContaining({
        peekScale: PEEK_SCALE[level],
        antialias: ANTIALIAS[level],
      }),
    );
  const v = await page.evaluate(() => {
    const q = (window.__vidro.sceneProbe as { room: RoomProbe }).room.peekQuality;
    const c = document.querySelector('#app canvas') as HTMLCanvasElement | null;
    return { back: [q.backWidth, q.backHeight], canvas: [c?.width ?? 0, c?.height ?? 0] };
  });
  expect(v.back, 'the peek image drawn at its scale of the render size').toEqual(
    v.canvas.map((n) => Math.floor(n * PEEK_SCALE[level])),
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-48', backend);

  test(`S-48 first launch is 自動: measured in the game, switched in place, kept, and built from next time [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(join(root, 'artifacts/S-48'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await page.addInitScript(installTracer);
    // no ?quality and nothing kept. A short window and a forced pick (the governor's test hooks) so that 自動 decides within
    // the test; dynamic resolution off so that the render scale is the preset's
    await page.goto(`/?scene=prologue-proto&autoWindow=2&autoForce=low&dynres=0&debug=1${webgl}`);
    await toHome(page);
    const s0 = await shell(page);
    expect(s0.qualityChoice, 'the first time: 自動').toBe('auto');
    expect(s0.qualityOrigin).toBe('default');
    expect(s0.qualityPicked).toBe(false);
    expect(s0.quality, 'measured from 中').toBe('mid');
    expect(await kept(page, PICK_KEY)).toBeNull();

    // the light home orb is not what 自動 measures: longer than its window on the home, and nothing decided
    await page.waitForTimeout(3_500);
    const s1 = await shell(page);
    expect(s1.qualityDecision, 'not measured on the home').toBeNull();
    expect(s1.quality).toBe('mid');
    // the settings over the home: 自動's tag carries the preset in use
    await page.locator('[data-item="settings"]').click();
    await waitSettings(page, "q.phase === 'open' && q.from === 'home'");
    await expect(qualityOption(page, 'auto')).toHaveText('自動（中）');
    await expect(qualityOption(page, 'auto')).toHaveClass(/is-chosen/);
    await expect(later(page)).toBeHidden();
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, 'settings-auto-home.png') });
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'", 3_000);

    // ---- in the game (the workshop drawn): it measures, picks (forced: 低) and switches in place ----
    await dive(page);
    const landedAt = await page.evaluate(() => performance.now());
    expect((await shell(page)).qualityDecision, 'nothing decided before the game was drawn').toBeNull();
    await expectPeekAt(page, 'mid');
    await page.waitForFunction(() => window.__vidro.quality === 'low', undefined, { timeout: 30_000 });
    const decidedAt = await page.evaluate(() => performance.now());
    // the governor's warm-up (0.5 s) and its window (2 s), of the game's frames
    expect(decidedAt - landedAt, 'measured in the game').toBeGreaterThan(2_000);
    const s2 = await shell(page);
    expect(s2.qualityChoice).toBe('auto');
    expect(s2.qualityDecision?.level).toBe('low');
    expect(s2.qualityDecision?.measuredAt).toBe('mid');
    expect(s2.qualitySwitchesInPlace, 'switched in place').toBe(1);
    expect(s2.sceneInstances, 'the scene is not made again').toBe(1);
    expect(s2.renderScale).toBe(RENDER_SCALE.low);
    await expectPeekAt(page, 'low');
    // kept once it has settled (after its verification)
    await page.waitForFunction(() => (window.__vidro as unknown as Shell).qualityKept === 'low', undefined, {
      timeout: 20_000,
    });
    expect(await kept(page, PICK_KEY)).toEqual({ v: 1, level: 'low' });
    // the player chose nothing: the settings keep no quality of theirs
    const settingsKept = (await kept(page, SETTINGS_KEY)) as { settings?: { quality?: unknown } } | null;
    expect(settingsKept?.settings?.quality ?? null).toBeNull();
    // the switch made no long frame and no full-screen pipeline (the anti-aliasings were both made while loading)
    const s3 = await shell(page);
    expect(s3.qualitySwitchFrames).toHaveLength(1);
    expect(s3.qualitySwitchFrames[0]).toBeLessThan(SWITCH_FRAME_MS);
    const madeInPlay = (await traced(page)).filter((m) => m.at === 'game');
    const record = (more: Record<string, unknown> = {}): void =>
      writeFileSync(
        join(root, `artifacts/S-48/first-launch-${backend}.json`),
        JSON.stringify(
          { backend, decidedAfterLandingMs: decidedAt - landedAt, landedAt, s0, s2, s3, madeInPlay, ...more },
          null,
          2,
        ),
      );
    record();
    // (the first frames of play make a few of their own, before as after S-48: those are not the switch's)
    expect(
      madeInPlay.filter((m) => m.quad && m.quality === 'low').map((m) => m.material),
      'full-screen pipelines made by the switch',
    ).toEqual([]);

    // the peek image at 低's scale: take the vidro (the first click only locks the mouse) and peek
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    await waitRoom(page, "r.target === 'bench'", 10_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand' && r.handPresence > 0.99", 5_000);
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.peekAmount > 0.999', 5_000);
    await expectPeekAt(page, 'low');
    await page.mouse.up({ button: 'right' });
    await page.evaluate(() => document.exitPointerLock()).catch(() => {});
    record({ peeked: (await room(page)).peekQuality });

    // ---- the next visit: built at 低 from the start (覗く像・AA・影・ガラスの描き方がそろう), 自動 still, and measured again ----
    await page.reload();
    await waitProbe(page, 'p.load.ready === true', 90_000);
    const r0 = await shell(page);
    expect(r0.quality, 'built from the preset 自動 picked').toBe('low');
    expect(r0.qualityChoice).toBe('auto');
    expect(r0.qualityOrigin).toBe('default');
    expect(r0.qualityPicked).toBe(true);
    expect(r0.sceneInstances).toBe(1);
    expect(r0.renderScale).toBe(RENDER_SCALE.low);
    await expectPeekAt(page, 'low');
    await page.locator('[data-ui="loading-start"]').click();
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
    await dive(page);
    await openSettingsFromPause(page);
    await expect(qualityOption(page, 'auto')).toHaveText('自動（低）');
    await expect(later(page), 'made at 低, playing at 低: nothing waits').toBeHidden();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotDir, 'settings-auto-low.png') });
    await backToPlay(page);
    // 自動のままなら次もまた測る
    await page.waitForFunction(() => window.__vidro.qualityDecision !== null, undefined, { timeout: 30_000 });
    const r1 = await shell(page);
    expect(r1.qualityDecision?.measuredAt).toBe('low');
    expect(r1.quality).toBe('low');
    expect(r1.qualitySwitchesInPlace, 'it picked 低 again: nothing to switch').toBe(0);

    const made = await contexts(page);
    expect(made).toHaveLength(1);
    expect(made[0]?.engines).toBe(1);
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-48 in play, 低 ⇄ 高: the peek image's scale and the anti-aliasing change at once, the game kept [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(420_000);
    mkdirSync(join(root, 'artifacts/S-48'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await page.addInitScript(installTracer);
    // the scripted play through the home to where it ends, down in the town: the drop taken, the bridge settled, the gate
    // open, the vidro taken back
    await page.goto(`/?scene=prologue-proto&autoplay=1&quality=mid&dynres=0&debug=1${webgl}`);
    await page.waitForFunction(
      () => !!(window.__vidro.sceneProbe as { room?: RoomProbe }).room?.autoplay?.done,
      undefined,
      { timeout: 360_000 },
    );
    const before = await room(page);
    expect(before.dropTaken).toBe(true);
    expect(before.finale.gateOpen).toBe(true);
    expect(before.finale.settledSegments).toBeGreaterThan(0);
    expect(before.orb).toBe('hand');
    await expectPeekAt(page, 'mid');
    const shell0 = await shell(page);

    await openSettingsFromPause(page);
    const madeBefore = (await traced(page)).length;
    const steps: Record<string, unknown> = {};
    for (const level of ['low', 'high', 'mid'] as const) {
      await qualityOption(page, level).click();
      await waitSettings(page, `q.values.quality === '${level}'`);
      await page.waitForFunction((l) => window.__vidro.quality === l, level);
      // the held picture is drawn again at the new preset
      await page.waitForTimeout(400);
      await expectPeekAt(page, level);
      const s = await shell(page);
      expect(s.renderScale).toBe(RENDER_SCALE[level]);
      if (level === 'mid') await expect(later(page), 'back at the preset it was made with').toBeHidden();
      else {
        await expect(later(page)).toBeVisible();
        await expect(later(page)).toHaveText(LATER);
      }
      steps[level] = { peek: (await room(page)).peekQuality, renderScale: s.renderScale };
    }
    const after = await shell(page);
    expect(after.qualitySwitchesInPlace).toBe(3);
    expect(after.sceneInstances, 'the scene is not made again').toBe(shell0.sceneInstances);
    expect(after.qualitySwitchFrames).toHaveLength(3);
    for (const ms of after.qualitySwitchFrames) expect(ms).toBeLessThan(SWITCH_FRAME_MS);
    const madeBySwitches = (await traced(page)).slice(madeBefore);
    expect(
      madeBySwitches.filter((m) => m.quad).map((m) => m.material),
      'full-screen pipelines made by the switches (the anti-aliasings were made while loading)',
    ).toEqual([]);

    // the game as it was: the body, the vidro, the drops, the light that settled the bridge, the gate
    const kept1 = await room(page);
    expect(kept1.position).toEqual(before.position);
    expect(kept1.orb).toBe('hand');
    expect(kept1.dropTaken).toBe(true);
    expect(kept1.drops).toEqual(before.drops);
    expect(kept1.areas).toEqual(before.areas);
    expect(kept1.finale.settledSegments).toBe(before.finale.settledSegments);
    expect(kept1.finale.gateOpen).toBe(true);
    await backToPlay(page);
    expect((await room(page)).position).toEqual(before.position);
    writeFileSync(
      join(root, `artifacts/S-48/in-play-${backend}.json`),
      JSON.stringify({ backend, steps, switchFrames: after.qualitySwitchFrames, madeBySwitches }, null, 2),
    );

    // the scripted play skips the audio (no 「はじめる」 press by a player: the home host's autoplay): none at all, never two
    const made = await contexts(page);
    expect(made.length).toBeLessThanOrEqual(1);
    for (const m of made) expect(m.engines).toBe(1);
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-48 the peek seen at 低 and at 高, switched in play (pictures) [${backend}]`, async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&quality=mid&dynres=0&debug=1${webgl}`);
    await toHome(page);
    await dive(page);
    // take the vidro (the first click only locks the mouse)
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    await waitRoom(page, "r.target === 'bench'", 10_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand' && r.handPresence > 0.99", 5_000);
    const at = await room(page);
    const peekShot = async (name: string): Promise<void> => {
      await page.mouse.move(640, 360);
      await page.mouse.down();
      await page.mouse.up();
      await waitRoom(page, 'r.locked === true');
      await page.mouse.down({ button: 'right' });
      await waitRoom(page, 'r.peekAmount > 0.999', 5_000);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shotDir, `${name}.png`) });
      await page.mouse.up({ button: 'right' });
      await waitRoom(page, 'r.peekAmount < 0.001', 5_000);
    };
    await peekShot('peek-mid');
    for (const level of ['low', 'high'] as const) {
      await openSettingsFromPause(page);
      await qualityOption(page, level).click();
      await page.waitForFunction((l) => window.__vidro.quality === l, level);
      await page.waitForTimeout(400);
      if (level === 'low') await page.screenshot({ path: join(shotDir, 'settings-low.png') });
      await backToPlay(page);
      await expectPeekAt(page, level);
      await peekShot(`peek-${level}`);
    }
    const end = await room(page);
    expect(Math.hypot(end.position.x - at.position.x, end.position.z - at.position.z)).toBeLessThan(0.05);
    expect((await shell(page)).sceneInstances).toBe(1);
    await page.evaluate(() => document.exitPointerLock()).catch(() => {});
    expect((await shell(page)).errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-48 sensors: the URL's ?quality wins over what is kept; a bench neither reads nor writes it [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    // kept from playing: 自動 chosen, its pick 低 (written once, before the page's first script)
    await page.addInitScript(
      ([settingsKey, pickKey]) => {
        if (sessionStorage.getItem('s48-seeded')) return;
        sessionStorage.setItem('s48-seeded', '1');
        localStorage.setItem(settingsKey as string, JSON.stringify({ v: 1, settings: { quality: 'auto' } }));
        localStorage.setItem(pickKey as string, JSON.stringify({ v: 1, level: 'low' }));
      },
      [SETTINGS_KEY, PICK_KEY],
    );
    // the URL wins: made at 高 (the peek image and the anti-aliasing too), not 自動
    await page.goto(`/?scene=prologue-proto&quality=high&dynres=0&debug=1${webgl}`);
    await waitProbe(page, 'p.load.ready === true', 90_000);
    const u = await shell(page);
    expect(u.quality).toBe('high');
    expect(u.qualityChoice).toBe('high');
    expect(u.qualityOrigin).toBe('url');
    expect(u.qualityPicked).toBe(false);
    await expectPeekAt(page, 'high');

    // a bench: a fixed preset (mid), whatever is kept, and it keeps nothing
    await page.goto(`/?scene=prologue-proto&bench=3&warmup=1${webgl}`);
    await page.waitForFunction(() => window.__vidro.status === 'done', undefined, { timeout: 90_000 });
    const b = await shell(page);
    expect(b.quality).toBe('mid');
    expect(b.qualityChoice).toBe('mid');
    expect(b.qualityPicked).toBe(false);
    expect(b.qualityKept).toBeNull();
    expect(await kept(page, PICK_KEY)).toEqual({ v: 1, level: 'low' });
    expect(b.errors ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
