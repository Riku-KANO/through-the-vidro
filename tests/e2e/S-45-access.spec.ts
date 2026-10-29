import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { HAND_ORB_RADIUS } from '../../src/game/orb/hand-pose';
import { BENCH_ORB } from '../../src/game/prologue/layout';

/**
 * S-45: the rest of accessibility, through the home as a player plays it, on both render paths.
 *  1. the world's glass and the camera — from the pause's settings (keyboard alone):
 *     - コントラスト強化 makes the rim of the thing you can act on (the vidro on the workbench) and the hand orb's rim thicker and
 *       brighter (発案者の判断 2026-10-28); measured against two shots of the same picture (its own flicker)
 *     - 歩行の揺れ: walking, the eye bobs (as before); at 0 its height stays at 1.6 m
 *     - 視点の基準の点: a small glass bead in the middle of the screen in play, never under the pause or the settings
 *     - 覗いたときの歪み: at 0 the picture through the orb changes (its refraction and colour fringes gone), and stays a picture
 *     - no render pipeline is made for any of these changes (uniforms: 設定を変えてもシェーダを作り直さない), no frame of the open
 *       panel reaches 100 ms, the room stays within 300 draws
 *  2. 簡易トランジション (kept from before: 読み込み画面の分は次に開いたときから): 読み込み→ホーム, the dive, ゲーム⇄ポーズ and the
 *     panel are each a white fade of 0.3 s; at its middle the screen is white (no black), each rings; Esc plays the dive's back
 * Pictures → artifacts/screens/S-45/<backend>/, numbers → artifacts/S-45/<what>-<backend>.json.
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
  locked: boolean;
  time: number;
  position: V3;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  fov: number;
  speed: number;
  orb: string;
  target: string | null;
  peekAmount: number;
  handPresence: number;
  drawCalls: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  access: { headBob: number; distortion: number; calm: boolean; contrast: boolean; bloom: number | null };
  peekQuality: { antialias: string };
}
interface Fade {
  source: string;
  start: number;
  peak: number | null;
  end: number | null;
  reversed: boolean;
}
interface AccessProbe {
  reticle: boolean;
  white: number;
  simple: boolean;
  fades: Fade[];
  hold: number | null;
  peaks: number[];
  tops: number[];
}
interface SettingsProbe {
  phase: string;
  tab: string;
  row: string | null;
  white: number;
  values: Record<string, unknown>;
  frameMs: { opening: number; open: number; closing: number };
  sounds: { cue: string; at: number; rang: boolean }[];
}
interface Lum {
  mean: number;
  dark: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const W = 1280;
const H = 720;

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

/** Counts the render pipelines three makes (S-38's tracer, shortened: ?debug=1 publishes the renderer). */
function installPipelineCounter(): void {
  interface Backend {
    createRenderPipeline(...a: unknown[]): unknown;
  }
  const w = window as unknown as { __s45Pipelines: number };
  w.__s45Pipelines = 0;
  Object.defineProperty(window, '__vidroDebug', {
    configurable: true,
    set(v: { renderer: { backend: Backend } }) {
      Object.defineProperty(window, '__vidroDebug', { value: v, writable: true, configurable: true });
      const backend = v.renderer.backend;
      const create = backend.createRenderPipeline;
      backend.createRenderPipeline = function (this: Backend, ...a: unknown[]) {
        w.__s45Pipelines++;
        return create.apply(this, a);
      };
    },
  });
}
const pipelines = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __s45Pipelines: number }).__s45Pipelines);

const probeOf = <T>(page: Page, key: string): Promise<T> =>
  page.evaluate((k) => {
    const v = (window.__vidro.sceneProbe as Record<string, unknown>)[k];
    return JSON.parse(JSON.stringify(v)) as unknown;
  }, key) as Promise<T>;
const room = (page: Page) => probeOf<RoomProbe>(page, 'room');
const settings = (page: Page) => probeOf<SettingsProbe>(page, 'settings');
const access = (page: Page) => probeOf<AccessProbe>(page, 'access');

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

async function toHome(page: Page, query: string): Promise<void> {
  await page.goto(`/?scene=prologue-proto&quality=mid${query}`);
  await waitProbe(page, 'p.load.ready === true', 90_000);
  await page.locator('[data-ui="loading-start"]').click();
  await waitProbe(page, "p.screen === 'home' && p.transition === null", 30_000);
}

async function playThroughHome(page: Page, query: string): Promise<void> {
  await toHome(page, query);
  await page.locator('[data-item="start"]').click();
  await waitProbe(
    page,
    "p.screen === 'game' && p.transition === null && p.room.ready && p.room.playing",
    60_000,
  );
}

/** Where the mouse is (with the view locked, its moves turn the view). */
const cursor = { x: 640, y: 360 };

async function lock(page: Page): Promise<void> {
  if ((await room(page)).locked) return;
  cursor.x = 640;
  cursor.y = 360;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.up();
  await waitRoom(page, 'r.locked === true');
}

/** Esc → the pause → 設定 → 表示とアクセシビリティ, on the row `row` of it (keyboard alone). */
async function displayRow(page: Page, row: number): Promise<void> {
  await page.keyboard.press('Escape');
  await waitPause(page, "q.phase === 'open'");
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitSettings(page, "q.phase === 'open' && q.from === 'pause'");
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i <= row; i++) await page.keyboard.press('ArrowDown');
  await waitSettings(page, `q.tab === 'display' && q.row !== null`);
}
/** Closes the panel, then the pause (back in play). */
async function backToPlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await waitSettings(page, "q.phase === 'closed'");
  await waitPause(page, "q.phase === 'open' && q.yielded === false");
  await page.keyboard.press('Escape');
  await waitPause(page, "q.phase === 'closed'");
  await waitRoom(page, 'r.playing === true');
}

/** Decodes PNGs in the page: per pixel luminance (0..1) of a region. */
async function lumOf(page: Page, png: Buffer): Promise<Float32Array> {
  const values = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const out: number[] = [];
    for (let i = 0; i < d.length; i += 4)
      out.push((0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255);
    return out;
  }, png.toString('base64'));
  return Float32Array.from(values);
}
const shot = async (page: Page, path?: string): Promise<Float32Array> =>
  lumOf(page, await page.screenshot(path ? { path } : {}));

/** Mean luminance of the pixels whose distance from (cx, cy) lies in [r0, r1). */
function ringMean(l: Float32Array, cx: number, cy: number, r0: number, r1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - r1)); y < Math.min(H, Math.ceil(cy + r1)); y++)
    for (let x = Math.max(0, Math.floor(cx - r1)); x < Math.min(W, Math.ceil(cx + r1)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r0 || d >= r1) continue;
      sum += l[y * W + x] ?? 0;
      n++;
    }
  return n > 0 ? sum / n : 0;
}
/** Share of the pixels within r of (cx, cy) whose luminance differs by more than `by`. */
function changedShare(
  a: Float32Array,
  b: Float32Array,
  cx: number,
  cy: number,
  r: number,
  by = 0.06,
): number {
  let changed = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) >= r) continue;
      n++;
      if (Math.abs((a[y * W + x] ?? 0) - (b[y * W + x] ?? 0)) > by) changed++;
    }
  return n > 0 ? changed / n : 0;
}
function spread(l: Float32Array, cx: number, cy: number, r: number): number {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) >= r) continue;
      const v = l[y * W + x] ?? 0;
      sum += v;
      sq += v * v;
      n++;
    }
  const m = sum / Math.max(1, n);
  return Math.sqrt(Math.max(0, sq / Math.max(1, n) - m * m));
}

/** Where a world point is on the screen (pixels) and how many pixels `radius` there spans, from the room's camera. */
type T3 = readonly [number, number, number];
function project(r: RoomProbe, p: T3, radius: number): { x: number; y: number; r: number } {
  const eye: T3 = [r.position.x, r.position.y + r.eyeHeight, r.position.z];
  const cp = Math.cos(r.pitch);
  const fwd: T3 = [-Math.sin(r.yaw) * cp, Math.sin(r.pitch), -Math.cos(r.yaw) * cp];
  const right: T3 = [Math.cos(r.yaw), 0, -Math.sin(r.yaw)];
  const up: T3 = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const d: T3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const dot = (a: T3, b: T3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = dot(d, fwd);
  const tanY = Math.tan((r.fov * Math.PI) / 360);
  const tanX = tanY * (W / H);
  return {
    x: (0.5 + (0.5 * dot(d, right)) / z / tanX) * W,
    y: (0.5 - (0.5 * dot(d, up)) / z / tanY) * H,
    r: ((0.5 * radius) / z / tanY) * H,
  };
}

/** Samples the eye's height above the feet while walking for `ms` toward (x, z) (the room's probe, ~30 ms apart). */
/** Turns the (locked) view toward a world point with the mouse. */
async function lookAt(page: Page, p: T3): Promise<void> {
  await lock(page);
  for (let i = 0; i < 6; i++) {
    const r = await room(page);
    const dx = p[0] - r.position.x;
    const dy = p[1] - (r.position.y + r.eyeHeight);
    const dz = p[2] - r.position.z;
    const yaw = Math.atan2(-dx, -dz) - r.yaw;
    const dYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    const dPitch = Math.atan2(dy, Math.hypot(dx, dz)) - r.pitch;
    if (Math.abs(dYaw) < 0.008 && Math.abs(dPitch) < 0.008) return;
    cursor.x += -dYaw / 0.0022;
    cursor.y += -dPitch / 0.0022;
    await page.mouse.move(cursor.x, cursor.y, { steps: 6 });
    await page.waitForTimeout(80);
  }
}

async function walkSampling(page: Page, x: number, z: number, ms: number): Promise<number[]> {
  await lock(page);
  const r0 = await room(page);
  // turn toward (x, z) with the mouse (the view is locked), level
  const dYaw = Math.atan2(-(x - r0.position.x), -(z - r0.position.z)) - r0.yaw;
  const wrap = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
  cursor.x += -wrap / 0.0022;
  cursor.y += r0.pitch / 0.0022;
  await page.mouse.move(cursor.x, cursor.y, { steps: 8 });
  await page.waitForTimeout(150);
  const heights: number[] = [];
  await page.keyboard.down('KeyW');
  const end = Date.now() + ms;
  try {
    while (Date.now() < end) {
      const r = await room(page);
      if (r.speed > 1) heights.push(r.eyeHeight);
      await page.waitForTimeout(30);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
  await waitRoom(page, 'r.speed < 0.05', 3_000);
  return heights;
}

const range = (v: number[]): number => Math.max(...v) - Math.min(...v);

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-45', backend);

  test(`S-45 the world's rims, the sway, the dot and the distortion, made by uniforms alone [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-45'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await page.addInitScript(installPipelineCounter);
    await playThroughHome(page, `&debug=1${webgl}`);
    await lock(page);
    await waitRoom(page, "r.target === 'bench'", 5_000);
    await page.waitForTimeout(600);
    const r0 = await room(page);
    expect(r0.access).toMatchObject({ headBob: 1, distortion: 1, calm: false, contrast: false });
    // the vidro on the workbench, its rim lit (調べられる物に近づくと縁が淡く光る)
    const bench = project(r0, BENCH_ORB, HAND_ORB_RADIUS);
    expect(bench.x).toBeGreaterThan(0);
    expect(bench.x).toBeLessThan(W);
    const offA = await shot(page, join(shotDir, 'rim-off.png'));
    const offB = await shot(page);
    const ring = (l: Float32Array) => ringMean(l, bench.x, bench.y, bench.r * 0.55, bench.r * 1.3);
    const rimNoise = Math.abs(ring(offA) - ring(offB));

    // ---- コントラスト強化 on (and 点滅を抑える: neither makes a shader) ----
    const p0 = await pipelines(page);
    await displayRow(page, 2);
    await waitSettings(page, "q.row === 'contrast'");
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.contrast === true');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'reduceFlashes'");
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.reduceFlashes === true');
    await page.waitForTimeout(300);
    await backToPlay(page);
    await page.waitForTimeout(700);
    const madeByContrast = (await pipelines(page)) - p0;
    const r1 = await room(page);
    expect(r1.access.contrast).toBe(true);
    expect(r1.access.calm).toBe(true);
    expect(Math.abs(r1.yaw - r0.yaw)).toBeLessThan(1e-3);
    const onA = await shot(page, join(shotDir, 'contrast-rim.png'));
    const rimRise = ring(onA) - ring(offA);
    expect(rimRise, 'the rim of what can be acted on is brighter').toBeGreaterThan(
      Math.max(0.01, rimNoise * 3),
    );

    // ---- the hand orb's rim: take it, then contrast off ----
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand' && r.handPresence > 0.99", 5_000);
    // the view locked again (after the pause): the one-line hint at the bottom goes, nothing over the orb
    await lock(page);
    await page.waitForTimeout(600);
    const hand = (await room(page)).orbScreen;
    expect(hand.visible).toBe(true);
    const hx = hand.x * W;
    const hy = hand.y * H;
    const hr = hand.r * H;
    const handOnA = await shot(page, join(shotDir, 'contrast-hand.png'));
    const handOnB = await shot(page);
    // (the orb this close to the eye is drawn larger than its angular radius: its rim lies a little out of `r`)
    const handRing = (l: Float32Array) => ringMean(l, hx, hy, hr * 0.9, hr * 1.25);
    const handNoise = Math.abs(handRing(handOnA) - handRing(handOnB));
    const p1 = await pipelines(page);
    await displayRow(page, 2);
    await page.keyboard.press('ArrowLeft');
    await waitSettings(page, 'q.values.contrast === false');
    await backToPlay(page);
    await page.waitForTimeout(700);
    const madeByHandContrast = (await pipelines(page)) - p1;
    await lock(page);
    await page.waitForTimeout(600);
    const handOff = await shot(page, join(shotDir, 'contrast-hand-off.png'));
    const handRise = handRing(handOnA) - handRing(handOff);
    expect(handRise, 'the hand orb’s rim is brighter').toBeGreaterThan(Math.max(0.01, handNoise * 3));

    // ---- 歩行の揺れ: walking, the eye bobs; at 0 it does not ----
    const bobbing = await walkSampling(page, 0.1, -3.4, 1200);
    expect(bobbing.length).toBeGreaterThan(10);
    expect(range(bobbing), 'the weak bob as before').toBeGreaterThan(0.004);
    const p2 = await pipelines(page);
    await displayRow(page, 3);
    await waitSettings(page, "q.row === 'headBob'");
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await waitSettings(page, 'q.values.headBob === 0');
    // ---- 視点の基準の点: on, but not under the pause and the settings ----
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await waitSettings(page, 'q.values.reticle === true');
    await page.waitForTimeout(200);
    expect((await access(page)).reticle, 'no dot under the settings').toBe(false);
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'");
    await waitPause(page, "q.phase === 'open'");
    expect((await access(page)).reticle, 'no dot under the pause').toBe(false);
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'");
    await waitProbe(page, 'p.access.reticle === true', 3_000);
    const dot = page.locator('[data-ui="reticle"]');
    const box = await dot.boundingBox();
    expect(box, 'the dot is on the screen').not.toBeNull();
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - W / 2)).toBeLessThan(2);
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - H / 2)).toBeLessThan(2);
    expect(box?.width ?? 99).toBeLessThan(14);
    // (it comes in over 0.15 s)
    await page.waitForTimeout(400);
    expect(Number(await dot.evaluate((d) => getComputedStyle(d).opacity))).toBeGreaterThan(0.8);
    await page.screenshot({ path: join(shotDir, 'reticle.png') });
    const still = await walkSampling(page, -1.2, -1.9, 1200);
    expect(still.length).toBeGreaterThan(10);
    // no bob at 0: what is left is the eye easing after the floor's millimetres (S-03 followEye), not a bob of ±1 cm
    expect(range(still), 'no bob at 0').toBeLessThan(0.002);
    expect(range(still)).toBeLessThan(range(bobbing) * 0.25);
    const madeByBob = (await pipelines(page)) - p2;

    // ---- 覗いたときの歪み: the picture through the orb at full strength, then at 0 (looking at the workbench and its tools) ----
    await lookAt(page, [BENCH_ORB[0], BENCH_ORB[1] - 0.1, BENCH_ORB[2]]);
    await page.waitForTimeout(300);
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.peekAmount > 0.999', 3_000);
    await page.waitForTimeout(300);
    const peekCircle = (await room(page)).orbScreen;
    const px = peekCircle.x * W;
    const py = peekCircle.y * H;
    const pr = peekCircle.r * H * 0.85;
    const strongA = await shot(page, join(shotDir, 'peek-strong.png'));
    const strongB = await shot(page);
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peekAmount === 0', 3_000);
    const p3 = await pipelines(page);
    await displayRow(page, 5);
    await waitSettings(page, "q.row === 'distortion'");
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await waitSettings(page, 'q.values.distortion === 0');
    await backToPlay(page);
    // the view locked again (the same view: an unlocked mouse moving turns nothing)
    await lock(page);
    await page.waitForTimeout(400);
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.peekAmount > 0.999', 3_000);
    await page.waitForTimeout(300);
    const weak = await shot(page, join(shotDir, 'peek-weak.png'));
    await page.mouse.up({ button: 'right' });
    const madeByDistortion = (await pipelines(page)) - p3;
    const peekNoise = changedShare(strongA, strongB, px, py, pr, 0.03);
    const peekChange = changedShare(strongA, weak, px, py, pr, 0.03);
    expect(peekChange, 'the picture through the orb changed').toBeGreaterThan(peekNoise + 0.1);
    // 弱くしても玉越しの裏の層ははっきり見える: still a picture (not a flat disc)
    expect(spread(weak, px, py, pr)).toBeGreaterThan(spread(strongA, px, py, pr) * 0.5);
    expect((await room(page)).access.distortion).toBe(0);

    // ---- budgets: uniforms only, short frames, the draw budget ----
    const panel = await settings(page);
    const final = await room(page);
    writeFileSync(
      join(root, `artifacts/S-45/access-${backend}.json`),
      JSON.stringify(
        {
          backend,
          rim: { off: ring(offA), on: ring(onA), noise: rimNoise, rise: rimRise },
          hand: { on: handRing(handOnA), off: handRing(handOff), noise: handNoise, rise: handRise },
          bob: { on: range(bobbing), off: range(still) },
          peek: { change: peekChange, noise: peekNoise },
          pipelines: { madeByContrast, madeByHandContrast, madeByBob, madeByDistortion },
          frameMs: panel.frameMs,
          drawCalls: final.drawCalls,
          errors,
        },
        null,
        2,
      ),
    );
    expect(madeByContrast, 'no pipeline made by コントラスト強化 and 点滅を抑える').toBe(0);
    expect(madeByHandContrast).toBe(0);
    expect(madeByBob).toBe(0);
    expect(madeByDistortion, 'no pipeline made by the distortion').toBe(0);
    expect(panel.frameMs.open).toBeLessThan(100);
    expect(final.drawCalls).toBeLessThanOrEqual(300);
    expect(
      await page.evaluate(() => (window as unknown as { __s45Contexts: () => number }).__s45Contexts()),
    ).toBe(1);
    expect(errors).toEqual([]);
  });

  test(`S-45 点滅を抑える keeps the bloom quiet across a switch of quality in play (S-48) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'vidro.settings',
        JSON.stringify({ v: 1, settings: { reduceFlashes: true } }),
      );
    });
    await playThroughHome(page, `&dynres=0${webgl}`);
    const r0 = await room(page);
    expect(r0.access.calm).toBe(true);
    const calmBloom = r0.access.bloom ?? 0;
    expect(calmBloom).toBeGreaterThan(0);
    /** From play: the pause, its 設定, the 画質 tab, the preset `level` (S-48: taken in place), back in play. */
    const switchTo = async (level: 'low' | 'mid' | 'high'): Promise<number | null> => {
      await page.evaluate(() => (window.__vidro.sceneProbe as { pause: { ask(): void } }).pause.ask());
      await waitPause(page, "q.phase === 'open'");
      await page.locator('[data-pause-item="settings"]').click();
      await waitSettings(page, "q.phase === 'open' && q.from === 'pause'");
      await page.locator('[data-ui="settings"] button[data-tab="graphics"]').click();
      await page.locator(`[data-ui="settings"] [data-row="quality"][data-option="${level}"]`).click();
      await page.waitForFunction((l) => (window.__vidro as { quality?: string }).quality === l, level);
      // the preset's own anti-aliasing at the end of the finishing (low FXAA; mid and high SMAA)
      await waitRoom(page, `r.peekQuality.antialias === '${level === 'low' ? 'fxaa' : 'smaa'}'`);
      const bloom = (await room(page)).access.bloom;
      await backToPlay(page);
      return bloom;
    };
    // 点滅を抑える on: the bloom stays as quiet at 低 and at 高 (the finishing's anti-aliasing switched under it)
    for (const level of ['low', 'high'] as const) {
      expect(await switchTo(level), `点滅を抑える at ${level}`).toBeCloseTo(calmBloom, 6);
      await page.waitForTimeout(300);
      expect((await room(page)).access.bloom, `in play at ${level}`).toBeCloseTo(calmBloom, 6);
    }
    // turned off: the full bloom, kept across another switch
    await displayRow(page, 2);
    await waitSettings(page, "q.row === 'contrast'");
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await waitSettings(page, "q.row === 'reduceFlashes'");
    await page.keyboard.press('ArrowLeft');
    await waitSettings(page, 'q.values.reduceFlashes === false');
    await backToPlay(page);
    const full = (await room(page)).access.bloom ?? 0;
    expect(full).toBeGreaterThan(calmBloom * 1.5);
    expect(await switchTo('mid'), 'off, at mid').toBeCloseTo(full, 6);
    expect(errors).toEqual([]);
  });

  test(`S-45 簡易トランジション: every transition a white fade of 0.3 s, never black [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    // kept from before (読み込み画面の分は保存した設定で次に開いたときから)
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'vidro.settings',
        JSON.stringify({ v: 1, settings: { simpleTransitions: true } }),
      );
    });
    await page.goto(`/?scene=prologue-proto&quality=mid${webgl}`);
    await waitProbe(page, 'p.load.ready === true', 90_000);
    expect((await access(page)).simple).toBe(true);
    const seconds = (f: Fade | undefined): number => ((f?.end ?? 0) - (f?.start ?? 0)) / 1000;
    const look = async (name: string): Promise<Lum> => {
      const l = await shot(page, join(shotDir, name));
      let sum = 0;
      let dark = 0;
      for (let i = 0; i < l.length; i += 7) {
        sum += l[i] ?? 0;
        if ((l[i] ?? 0) < 0.06) dark++;
      }
      const n = Math.ceil(l.length / 7);
      return { mean: sum / n, dark: dark / n };
    };

    // ---- 読み込み → ホーム: held at its middle, the screen white ----
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { access: { hold: number | null } }).access.hold = 0.5;
    });
    const pings0 = await page.evaluate(
      () => (window.__vidro.sceneProbe as { audioGate: { uiVoices: number } }).audioGate.uiVoices,
    );
    await page.locator('[data-ui="loading-start"]').click();
    await waitProbe(page, 'p.access.white > 0.99');
    await page.waitForTimeout(200);
    const peak = await look('fade-loading-home.png');
    expect(peak.mean, 'white at the middle').toBeGreaterThan(0.9);
    expect(peak.dark, 'no black').toBe(0);
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { access: { hold: number | null } }).access.hold = null;
    });
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 10_000);
    const pings1 = await page.evaluate(
      () => (window.__vidro.sceneProbe as { audioGate: { uiVoices: number } }).audioGate.uiVoices,
    );
    expect(pings1, 'the opening rang').toBeGreaterThan(pings0);

    // ---- ホーム → ゲーム (潜る): no flight, a fade of 0.3 s; Esc while it fades plays it back (遷移のルール 4) ----
    await page.locator('[data-item="start"]').click();
    await page.waitForTimeout(60);
    await page.keyboard.press('Escape');
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 5_000);
    const backed = (await access(page)).fades.find((f) => f.source === 'home-game');
    expect(backed?.reversed, 'played back').toBe(true);
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { access: { hold: number | null } }).access.hold = 0.25;
    });
    await page.locator('[data-item="start"]').click();
    await waitProbe(page, 'p.access.white > 0.45');
    await page.waitForTimeout(200);
    const quarter = await look('fade-dive.png');
    expect(quarter.dark, 'half white over the home: nothing black').toBe(0);
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { access: { hold: number | null } }).access.hold = null;
    });
    await waitProbe(page, "p.screen === 'game' && p.transition === null && p.room.playing", 10_000);
    let fades = (await access(page)).fades;
    const opening = fades.find((f) => f.source === 'loading-home');
    expect(opening?.peak, 'the opening reached white').not.toBeNull();
    const dive = fades.filter((f) => f.source === 'home-game' && !f.reversed).at(-1);
    expect(dive?.peak).not.toBeNull();
    // the dive's fade, not held: 0.3 s (a frame or so either side)
    await page.waitForTimeout(300);

    // ---- ゲーム ⇄ ポーズ ----
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'", 3_000);
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);
    // ---- 設定 from the pause: the panel's fade, open and close ----
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'open'", 3_000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitSettings(page, "q.phase === 'open'", 3_000);
    await page.keyboard.press('Escape');
    await waitSettings(page, "q.phase === 'closed'", 3_000);
    await page.keyboard.press('Escape');
    await waitPause(page, "q.phase === 'closed'", 3_000);
    await page.waitForTimeout(400);
    fades = (await access(page)).fades;
    const timed = fades.filter((f) => f.end !== null && !f.reversed && !(f.source === 'loading-home'));
    const bySource = (s: string) => timed.filter((f) => f.source === s);
    expect(bySource('pause').length).toBeGreaterThanOrEqual(4);
    expect(bySource('settings').length).toBeGreaterThanOrEqual(2);
    for (const f of [...bySource('pause'), ...bySource('settings')]) {
      expect(f.peak, `${f.source} reached white`).not.toBeNull();
      expect(seconds(f), `${f.source} lasts 0.3 s`).toBeGreaterThan(0.24);
      expect(seconds(f)).toBeLessThan(0.45);
    }
    // the pause's and the panel's sounds rang with each
    const pauseSounds = await probeOf<{ sounds: { cue: string; rang: boolean }[] }>(page, 'pause');
    expect(pauseSounds.sounds.filter((s) => s.cue === 'open' && s.rang).length).toBeGreaterThanOrEqual(2);
    const panelSounds = await settings(page);
    expect(panelSounds.sounds.some((s) => s.cue === 'open' && s.rang)).toBe(true);
    expect(panelSounds.sounds.some((s) => s.cue === 'close' && s.rang)).toBe(true);

    // ---- the pause held at its middle: white ----
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { pause: { hold: number | null } }).pause.hold = 0.15;
    });
    await page.keyboard.press('Escape');
    await waitProbe(page, 'p.access.white > 0.95');
    await page.waitForTimeout(200);
    const pausePeak = await look('fade-pause.png');
    expect(pausePeak.mean).toBeGreaterThan(0.9);
    expect(pausePeak.dark).toBe(0);
    await page.evaluate(() => {
      (window.__vidro.sceneProbe as { pause: { hold: number | null } }).pause.hold = null;
    });
    await waitPause(page, "q.phase === 'open'", 3_000);

    // ---- タイトルへ: the dive played back as a fade of 0.3 s ----
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await waitPause(page, "q.page === 'confirm'");
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 5_000);
    fades = (await access(page)).fades;
    const back = fades.filter((f) => f.source === 'home-game' && f.reversed && f.end !== null).at(-1);
    expect(back?.peak).not.toBeNull();
    expect(seconds(back)).toBeGreaterThan(0.24);
    expect(seconds(back)).toBeLessThan(0.45);
    // and the dive once more, not held: 0.3 s (潜るのカメラ移動もこれで置き換わる)
    await page.waitForTimeout(300);
    await page.locator('[data-item="start"]').click();
    await waitProbe(page, "p.screen === 'game' && p.transition === null && p.room.playing", 10_000);
    fades = (await access(page)).fades;
    const again = fades.filter((f) => f.source === 'home-game' && !f.reversed && f.end !== null).at(-1);
    expect(again?.peak).not.toBeNull();
    expect(seconds(again), 'the dive lasts 0.3 s').toBeGreaterThan(0.24);
    expect(seconds(again)).toBeLessThan(0.45);
    expect(seconds(opening)).toBeGreaterThan(0.24);
    writeFileSync(
      join(root, `artifacts/S-45/fades-${backend}.json`),
      JSON.stringify({ backend, fades, errors }, null, 2),
    );
    expect(errors).toEqual([]);
  });

  test(`S-45 簡易トランジション with 点滅を抑える: 0.5 s fades, Esc mashed, never more than 3 full whites a second [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    // 発案者の判断 2026-10-29 (判断待ち 3): both on — the white fade is longer, and its full white comes at most 3 times a second
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'vidro.settings',
        JSON.stringify({ v: 1, settings: { simpleTransitions: true, reduceFlashes: true } }),
      );
    });
    await page.goto(`/?scene=prologue-proto&quality=mid${webgl}`);
    await waitProbe(page, 'p.load.ready === true', 90_000);
    await page.locator('[data-ui="loading-start"]').click();
    await waitProbe(page, "p.screen === 'home' && p.transition === null", 10_000);
    await page.waitForTimeout(300);
    await page.locator('[data-item="start"]').click();
    await waitProbe(page, "p.screen === 'game' && p.transition === null && p.room.playing", 10_000);
    const seconds = (f: Fade | undefined): number => ((f?.end ?? 0) - (f?.start ?? 0)) / 1000;
    let a = await access(page);
    const opening = a.fades.find((f) => f.source === 'loading-home');
    const dive = a.fades.filter((f) => f.source === 'home-game' && f.end !== null).at(-1);
    for (const f of [opening, dive]) {
      expect(f?.peak, `${f?.source} came to full white`).not.toBeNull();
      // (the record starts at the first white frame, a frame after the fade began)
      expect(seconds(f), `${f?.source} lasts 0.5 s`).toBeGreaterThan(0.38);
      expect(seconds(f)).toBeLessThan(0.65);
    }
    await page.waitForTimeout(500);

    // Esc mashed for 4 s (the pause opens and closes as fast as it lets itself), then 4 s at a rhythm a full white could
    // follow (every 0.35 s: without the gate, about 3 whites a second at the edge), then let go
    const from = await page.evaluate(() => performance.now());
    const pause0 = await probeOf<{ opened: number; closed: number }>(page, 'pause');
    for (const [times, gap] of [
      [80, 50],
      [12, 350],
    ] as const) {
      for (let i = 0; i < times; i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(gap);
      }
    }
    const to = await page.evaluate(() => performance.now());
    await page.waitForTimeout(1500);
    a = await access(page);
    const within = (ts: number[]): number[] => ts.filter((t) => t >= from && t <= to + 1500);
    const mostInASecond = (ts: number[]): number => {
      let most = 0;
      for (const t0 of ts) most = Math.max(most, ts.filter((t) => t >= t0 && t < t0 + 1000).length);
      return most;
    };
    // the full whites, and every top of the white at all (a fade turned back below its full white flashes as well)
    const peaks = within(a.peaks);
    const tops = within(a.tops);
    const most = mostInASecond(peaks);
    const mostTops = mostInASecond(tops);
    const pause1 = await probeOf<{
      opened: number;
      closed: number;
      sounds: { cue: string; rang: boolean }[];
    }>(page, 'pause');
    writeFileSync(
      join(root, `artifacts/S-45/flash-gate-${backend}.json`),
      JSON.stringify(
        {
          backend,
          peaks: peaks.map((t) => Math.round(t - from)),
          tops: tops.map((t) => Math.round(t - from)),
          most,
          mostTops,
          pause0,
          pause1,
        },
        null,
        2,
      ),
    );
    // Esc is still taken (the pause opened and closed again and again), each with its sound at once
    expect(pause1.opened - pause0.opened).toBeGreaterThan(2);
    expect(pause1.closed - pause0.closed).toBeGreaterThan(2);
    expect(pause1.sounds.some((s) => s.cue === 'open' && s.rang)).toBe(true);
    // it did go white, never more than 3 times in any second
    expect(peaks.length).toBeGreaterThan(1);
    expect(most, 'full whites in any one second').toBeLessThanOrEqual(3);
    expect(mostTops, 'white tops (flashes) in any one second').toBeLessThanOrEqual(3);
    // and it comes to rest (no white left)
    expect(a.white).toBe(0);
    expect(errors).toEqual([]);
  });
}
