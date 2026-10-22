import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { readGlbJson } from '../../src/core/assets/glb';
import { WORKSHOP_ASSET, WORKSHOP_OBJECTS } from '../../src/game/prologue/layout';

/**
 * S-26: the workshop's light baked in Blender (設計書 アートディレクション > 光と時間帯: 静止した光と影はBlenderで焼き込み、
 * 動く物だけを実時間で照らす; Blenderアセットパイプライン > 焼き込み), on both render paths.
 *  (a) the four fixed views of S-24 (目覚め, 炉の前, 作品の棚, 扉から振り返る), taken the way S-24, S-27, S-30 and S-31 take
 *      them, into artifacts/screens/S-26/<backend>/<phase>/, with their draws, triangles, transmissive glass in view and the
 *      GPU size of the workshop's textures (artifacts/S-26/views-<backend>-<phase>.json), and the size of the glb.
 *      `S26_PHASE=before` takes the build before the bake (S-31's glb, lit in real time); the default is `after`, which also
 *      puts before | after side by side (artifacts/screens/S-26/<backend>/compare.png). The designer judges the look.
 *      Budget: 1エリアのテクスチャは GPU 上 80MB 以下 (設計書 ポリゴンとテクスチャの予算).
 *  (b) the baked room does not take the realtime lights a second time: with every realtime light of the room off (the
 *      dawn sun, the sky's fill, the skylight's spot, the fire's spot), the picture from the bench stays nearly as it is
 *      (only the highlights, which a diffuse bake cannot hold, go). Lit in real time (before), it goes dark.
 *  (c) what is baked and what is not: every drawn piece of the workshop's glb that carries a lightmap draws its opaque
 *      materials with it (the second UV, an sRGB image, a positive strength), but those the bake leaves out (`bake: false`:
 *      the fire, the embers, the air in the glass); the glass, and everything the room makes itself (the vidro, the drop,
 *      the placed orb's cup…), has none.
 */
test.use({ locale: 'ja-JP' });

interface RoomProbe {
  ready: boolean;
  playing: boolean;
  drawCalls: number;
  triangles: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  workshop?: { loaded: boolean };
}
interface TextureSize {
  name: string;
  width: number;
  height: number;
  bytes: number;
  compressed: boolean;
}
interface ViewCounts {
  drawCalls: number;
  triangles: number;
  transmissive: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
/**
 * `before` (S-31's glb), `after` (the default), or `uastc`: the same bake with its lightmap in UASTC, taken to put the two
 * side by side (compare-codec.png, written by `after`). Since S-26's integration the default (blender/pipeline.json bake.codec)
 * is UASTC itself (the owner's choice over ETC1S, whose 4×4 blocks showed on smooth surfaces close by), so the two match.
 */
const PHASES = ['before', 'after', 'uastc'] as const;
const phase = PHASES.find((p) => p === process.env.S26_PHASE) ?? 'after';
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
/** 設計書 ポリゴンとテクスチャの予算: 1エリア全体のテクスチャは合計80MB以下(GPU上). */
const TEXTURE_BUDGET = 80 * 1024 * 1024;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const VIEWS = [
  ['bench', 'wake'],
  ['furnace', 'furnace'],
  ['shelf', 'shelf'],
  ['door', 'door'],
] as const;
/**
 * (b): with the realtime lights off, the mean sRGB luminance of the lower half of the picture from the bench (the bench, its
 * shelf, the floor; the hand orb left out) keeps at least this share of what it was. Set before the bake from what a
 * diffuse bake leaves to real time (the highlights of the brass and the frosted glass) and what the realtime room loses
 * (process/slices/S-26.md 赤の証跡: over the whole picture the sky, which no light changes, kept 81% before the bake).
 */
const KEEPS_LIGHT = 0.8;
/**
 * (b), with the environment off as well: a matte place (the frosted top of the bench left of the vidro, nothing on it, CSS
 * pixels of the view from the bench) keeps at least this share. Its light is the bake's; the environment adds a faint sheen.
 * Measured: the bake as it is keeps 0.9875 (both paths); with the environment's diffuse light counted a second time (the
 * sink in BakedLightingModel.indirect taken out, review round 2 of S-26) it kept 0.952, so the line is between. A coarse
 * watch: the guard is src/core/assets/lightmap.test.ts. (Before the bake the lights alone took two thirds of it: the picture
 * before/wake.png measured 0.547, wake-lights-off.png 0.188.)
 */
const KEEPS_MATTE = 0.975;
const BENCH_TOP = { x0: 470, y0: 455, x1: 590, y1: 490 } as const;

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

async function waitRoom(page: Page, fn: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

/**
 * Opens a fixed view the way S-24, S-27, S-30 and S-31 take it (mid quality, no dynamic resolution, no hint), with
 * ?debug=1, and keeps the scene and the camera the room draws with. `S26_QUERY` adds switches for looking into something
 * by hand; the recorded runs leave it empty.
 */
async function openView(page: Page, spawn: string, webgl: string): Promise<void> {
  const extra = process.env.S26_QUERY ?? '';
  await page.goto(
    `/?scene=prologue-proto&direct=1&spawn=${spawn}&peekHold=0&quality=mid&dynres=0&debug=1${webgl}${extra}`,
  );
  await waitRoom(page, 'r.ready && r.playing && r.workshop && r.workshop.loaded');
  await page.evaluate((furnace) => {
    const w = window as unknown as { __s26Camera?: unknown; __s26Scene?: unknown };
    const renderer = window.__vidroDebug?.renderer as unknown as {
      render: (...args: unknown[]) => unknown;
    };
    if (!renderer) throw new Error('no __vidroDebug.renderer (debug=1)');
    const render = renderer.render;
    renderer.render = (...args: unknown[]) => {
      const s = args[0] as { isScene?: boolean };
      const camera = args[1] as { isPerspectiveCamera?: boolean } | undefined;
      if (s?.isScene && !w.__s26Camera && camera?.isPerspectiveCamera) {
        let found = false;
        (s as { traverse(f: (o: { userData: { name?: string } }) => void): void }).traverse((o) => {
          if (o.userData?.name === furnace) found = true;
        });
        if (found) {
          w.__s26Camera = camera;
          w.__s26Scene = s;
        }
      }
      return render.apply(renderer, args);
    };
  }, WORKSHOP_OBJECTS.furnace.name);
  await page.waitForFunction(() => !!(window as unknown as { __s26Scene?: unknown }).__s26Scene);
  await page.waitForTimeout(1_200);
}

/**
 * The textures the workshop's glb brought (the materials of the meshes under the node of the furnace's parent: the glTF
 * scene), with their size on the GPU: a compressed texture (KTX2, transcoded) is the bytes of its mip levels as uploaded,
 * an image is width × height × 4, × 4/3 with mipmaps.
 */
async function workshopTextures(page: Page): Promise<TextureSize[]> {
  return page.evaluate((furnace) => {
    interface Tex {
      isTexture?: boolean;
      isCompressedTexture?: boolean;
      name: string;
      uuid: string;
      image?: { width?: number; height?: number };
      mipmaps?: { data?: { byteLength: number }; width: number; height: number }[];
      generateMipmaps?: boolean;
    }
    interface O {
      userData: { name?: string };
      parent: O | null;
      material?: unknown;
      isMesh?: boolean;
      traverse(f: (o: O) => void): void;
    }
    const scene = (window as unknown as { __s26Scene: O }).__s26Scene;
    let glbRoot: O | null = null;
    scene.traverse((o) => {
      if (o.userData?.name === furnace) {
        let p: O = o;
        while (p.parent && p.parent !== scene) p = p.parent;
        glbRoot = p;
      }
    });
    if (!glbRoot) throw new Error('the workshop is not in the scene');
    const seen = new Map<string, Tex>();
    (glbRoot as O).traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats as Record<string, unknown>[]) {
        for (const key in m) {
          const v = m[key] as Tex | null;
          if (v?.isTexture) seen.set(v.uuid, v);
        }
      }
    });
    return [...seen.values()].map((t) => {
      if (t.isCompressedTexture && t.mipmaps?.length) {
        const bytes = t.mipmaps.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0);
        return {
          name: t.name,
          width: t.mipmaps[0]?.width ?? 0,
          height: t.mipmaps[0]?.height ?? 0,
          bytes,
          compressed: true,
        };
      }
      const w = t.image?.width ?? 0;
      const h = t.image?.height ?? 0;
      return {
        name: t.name,
        width: w,
        height: h,
        bytes: Math.round(w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1)),
        compressed: false,
      };
    });
  }, WORKSHOP_OBJECTS.furnace.name);
}

/**
 * Puts out every light of the drawn scene (intensity 0, held there: the fire's breathing sets its intensity every frame in
 * room-art.ts animate). Returns how many lights it put out.
 */
async function realtimeLightsOff(page: Page): Promise<number> {
  const n = await page.evaluate(() => {
    interface L {
      isLight?: boolean;
    }
    const scene = (window as unknown as { __s26Scene: { traverse(f: (o: L) => void): void } }).__s26Scene;
    let count = 0;
    scene.traverse((o) => {
      if (!o.isLight) return;
      Object.defineProperty(o, 'intensity', { configurable: true, get: () => 0, set: () => {} });
      count++;
    });
    return count;
  });
  await page.waitForTimeout(500);
  return n;
}

/**
 * Boxes of open floor in the view from the door (CSS pixels of the 1280×720 page): between the furnace and the bench, and
 * nearer, under the dome's middle. No piece stands there; the furnace's fire is not the light there. `before`: their mean
 * sRGB luminance in the realtime room before the bake (S-31's glb, `S26_PHASE=before`, artifacts/screens/S-26/<backend>/
 * before/door.png), kept here so the check does not need that picture.
 */
const OPEN_FLOOR = [
  { x0: 560, y0: 430, x1: 720, y1: 520, before: { webgpu: 0.3542, webgl2: 0.3536 } },
  { x0: 600, y0: 600, x1: 800, y1: 700, before: { webgpu: 0.4122, webgl2: 0.4113 } },
] as const;

/** Mean sRGB luminance (0..1) of a box of a picture. */
async function regionLuminance(
  page: Page,
  b64: string,
  box: { x0: number; y0: number; x1: number; y1: number },
): Promise<number> {
  return page.evaluate(
    async ({ b64, box }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const k = bmp.width / innerWidth;
      const d = g.getImageData(box.x0 * k, box.y0 * k, (box.x1 - box.x0) * k, (box.y1 - box.y0) * k).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4)
        sum += (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      return sum / (d.length / 4);
    },
    { b64, box },
  );
}

/**
 * Mean sRGB luminance (0..1) of the lower half of a picture (from the bench: the bench, its lower shelf and the floor; the
 * upper half is mostly the sky, which no light changes), leaving out discs (the hand orb).
 */
async function meanLuminance(page: Page, png: Buffer, leaveOut: { cx: number; cy: number; r: number }[]) {
  return page.evaluate(
    async ({ b64, leaveOut }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const k = bmp.width / innerWidth;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const x = ((i / 4) % bmp.width) / k;
        const y = Math.floor(i / 4 / bmp.width) / k;
        if (y < innerHeight / 2) continue;
        if (leaveOut.some((o) => Math.hypot(x - o.cx, y - o.cy) <= o.r)) continue;
        sum += (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
        n++;
      }
      return sum / Math.max(1, n);
    },
    { b64: png.toString('base64'), leaveOut },
  );
}

/** Before | after side by side, one row per view (PNG), under the two titles. */
async function sideBySide(
  page: Page,
  rows: { name: string; a: string; b: string }[],
  titles = ['S-31 (before: lit in real time)', 'S-26 (after: baked)'],
): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ rows, titles }) => {
      const W = 640;
      const H = 360;
      const top = 34;
      const gap = 6;
      const c = new OffscreenCanvas(W * 2 + gap, top + rows.length * (H + gap));
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.fillStyle = '#16181d';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e8e6e1';
      g.font = '20px sans-serif';
      g.fillText(titles[0] ?? '', 12, 24);
      g.fillText(titles[1] ?? '', W + gap + 12, 24);
      for (const [i, row] of rows.entries()) {
        for (const [j, src] of [row.a, row.b].entries()) {
          const blob = await (await fetch(`data:image/png;base64,${src}`)).blob();
          const bmp = await createImageBitmap(blob);
          g.drawImage(bmp, j * (W + gap), top + i * (H + gap), W, H);
        }
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(0, top + i * (H + gap), 96, 28);
        g.fillStyle = '#e8e6e1';
        g.fillText(row.name, 8, top + i * (H + gap) + 21);
      }
      const out = await c.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await out.arrayBuffer());
      let s = '';
      for (let k = 0; k < bytes.length; k += 0x8000)
        s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
      return btoa(s);
    },
    { rows, titles },
  );
  return Buffer.from(b64, 'base64');
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-26', backend);
  const outDir = join(root, 'artifacts/S-26');
  const sensorFile = join(outDir, `sensors-${backend}-${phase}.json`);
  const keep = (key: string, value: unknown) => {
    // merged with what is in the file: a failed test restarts the worker, which forgets the module's state
    const sensors: Record<string, unknown> = existsSync(sensorFile)
      ? JSON.parse(readFileSync(sensorFile, 'utf8')).sensors
      : {};
    sensors[key] = value;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(sensorFile, JSON.stringify({ backend, phase, sensors }, null, 2));
  };

  test(`S-26 the four fixed views (${phase}) inside the budget, the workshop's textures on the GPU; before | after side by side [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(join(shotDir, phase), { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const errors = collectErrors(page);
    const views: Record<string, ViewCounts> = {};
    let textures: TextureSize[] = [];
    for (const [spawn, name] of VIEWS) {
      await openView(page, spawn, webgl);
      const counts = { drawCalls: 0, triangles: 0 };
      for (let i = 0; i < 6; i++) {
        const r = await room(page);
        counts.drawCalls = Math.max(counts.drawCalls, r.drawCalls);
        counts.triangles = Math.max(counts.triangles, r.triangles);
        await page.waitForTimeout(80);
      }
      await page.screenshot({ path: join(shotDir, phase, `${name}.png`) });
      const transmissive = await page.evaluate(() =>
        (window.__vidro.sceneProbe as { room: { transmissiveInView(): number } }).room.transmissiveInView(),
      );
      views[name] = { ...counts, transmissive };
      if (name === 'wake') textures = await workshopTextures(page);
    }
    const textureBytes = textures.reduce((s, t) => s + t.bytes, 0);
    const glbFile = join(root, 'public', WORKSHOP_ASSET);
    const glbBytes = statSync(glbFile).size;
    // what was baked (from the glb's scene extras `bake`; the codec is not in it): pictures of two phases compare only one
    // bake. Its settings, lights, sky and each lightmap's scale (rounded by the bake); not the clipping statistics, whose
    // last digits vary from one bake of the same scene to the next on the GPU
    type BakeRecord = {
      images?: { name: string; scale: number; objects: string[] }[];
      [key: string]: unknown;
    };
    const record = (readGlbJson(readFileSync(glbFile)) as { scenes?: { extras?: { bake?: BakeRecord } }[] })
      .scenes?.[0]?.extras?.bake;
    const { images, ...rest } = record ?? {};
    const bake = record
      ? createHash('sha1')
          .update(
            JSON.stringify({
              ...rest,
              images: images?.map((i) => ({ name: i.name, scale: i.scale, objects: i.objects })),
            }),
          )
          .digest('hex')
      : null;
    writeFileSync(
      join(outDir, `views-${backend}-${phase}.json`),
      JSON.stringify({ backend, phase, bake, views, textures, textureBytes, glbBytes }, null, 2),
    );
    for (const [name, v] of Object.entries(views)) {
      expect(v.drawCalls, name).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(v.triangles, name).toBeLessThanOrEqual(BUDGET.triangles);
      // 技術設計 > 性能の目標と予算: 透過ガラスの同時表示は近景で20個程度まで
      expect(v.transmissive, `${name}: transmissive glass in view`).toBeLessThanOrEqual(20);
    }
    expect(textures.length, 'textures of the workshop').toBeGreaterThan(0);
    expect(textureBytes, "the workshop's textures on the GPU").toBeLessThanOrEqual(TEXTURE_BUDGET);
    const shot = (p: string, name: string) => join(shotDir, p, `${name}.png`);
    const row = (a: string, b: string) => (name: string) => ({
      name,
      a: readFileSync(shot(a, name)).toString('base64'),
      b: readFileSync(shot(b, name)).toString('base64'),
    });
    if (phase === 'after' && VIEWS.every(([, name]) => existsSync(shot('before', name)))) {
      writeFileSync(
        join(shotDir, 'compare.png'),
        await sideBySide(
          page,
          VIEWS.map(([, name]) => row('before', 'after')(name)),
        ),
      );
    }
    if (phase !== 'before') {
      // the bake is the same light as the realtime room where nothing stands in its way: the open floor from the door, its
      // sRGB luminance within a quarter of what it was before the bake (a strength off by π would be about 1.5–1.7 times
      // darker or brighter, through sRGB and AgX)
      const door = readFileSync(shot(phase, 'door')).toString('base64');
      const ratios: number[] = [];
      for (const box of OPEN_FLOOR)
        ratios.push(
          (await regionLuminance(page, door, box)) / box.before[backend === 'webgl2' ? 'webgl2' : 'webgpu'],
        );
      keep('openFloor', { boxes: OPEN_FLOOR, ratios });
      for (const r of ratios) {
        expect(r, 'open floor from the door, after ÷ before').toBeGreaterThan(0.8);
        expect(r, 'open floor from the door, after ÷ before').toBeLessThan(1.25);
      }
    }
    const uastcViews = join(outDir, `views-${backend}-uastc.json`);
    const sameBake =
      existsSync(uastcViews) &&
      (JSON.parse(readFileSync(uastcViews, 'utf8')) as { bake?: string }).bake === bake;
    if (phase === 'after' && VIEWS.every(([, name]) => existsSync(shot('uastc', name))) && !sameBake)
      test.info().annotations.push({
        type: 'compare-codec',
        description: 'not written: the UASTC pictures are of another bake (take S26_PHASE=uastc again)',
      });
    if (phase === 'after' && sameBake && VIEWS.every(([, name]) => existsSync(shot('uastc', name)))) {
      writeFileSync(
        join(shotDir, 'compare-codec.png'),
        await sideBySide(page, ['wake', 'furnace', 'door'].map(row('after', 'uastc')), [
          'S-26 lightmap (the default codec)',
          'S-26 lightmap UASTC (to compare)',
        ]),
      );
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-26 the baked room keeps its light with the realtime lights off (目覚め) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await openView(page, 'bench', webgl);
    const orb = async () => {
      const o = (await room(page)).orbScreen;
      return o.visible ? [{ cx: o.x * 1280, cy: o.y * 720, r: o.r * 720 * 1.12 + 10 }] : [];
    };
    const leaveOut = await orb();
    const lit = await page.screenshot();
    const lights = await realtimeLightsOff(page);
    leaveOut.push(...(await orb()));
    const dark = await page.screenshot();
    mkdirSync(join(shotDir, phase), { recursive: true });
    writeFileSync(join(shotDir, phase, 'wake-lights-off.png'), dark);
    // and the environment (the sky the glass mirrors) off too: its diffuse light is in the bake as well (review round 1 of
    // S-26: with only the lights off, the environment's diffuse light counted twice would still pass)
    await page.evaluate(() => {
      (
        window as unknown as { __s26Scene: { environmentIntensity: number } }
      ).__s26Scene.environmentIntensity = 0;
    });
    await page.waitForTimeout(500);
    leaveOut.push(...(await orb()));
    const unlit = await page.screenshot();
    writeFileSync(join(shotDir, phase, 'wake-lights-and-sky-off.png'), unlit);
    const on = await meanLuminance(page, lit, leaveOut);
    const off = await meanLuminance(page, dark, leaveOut);
    // without the environment the brass and the glass lose what they mirror (that is right): measure the matte top of the
    // bench, where the environment gives only diffuse light and a faint sheen
    const top = {
      on: await regionLuminance(page, lit.toString('base64'), BENCH_TOP),
      none: await regionLuminance(page, unlit.toString('base64'), BENCH_TOP),
    };
    keep('lightsOff', { lights, on, off, kept: off / on, benchTop: top, benchTopKept: top.none / top.on });
    expect(lights, 'realtime lights in the room').toBeGreaterThanOrEqual(4);
    expect(off / on, 'share of the light kept with the realtime lights off').toBeGreaterThan(KEEPS_LIGHT);
    expect(
      top.none / top.on,
      'the bench top with the realtime lights and the environment off',
    ).toBeGreaterThan(KEEPS_MATTE);
    expect(errors).toEqual([]);
  });

  test(`S-26 what is baked: the workshop's opaque pieces carry the lightmap, glass and what moves do not [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await openView(page, 'bench', webgl);
    const report = await page.evaluate((furnace) => {
      interface Tex {
        channel: number;
        colorSpace: string;
        isTexture?: boolean;
        isCompressedTexture?: boolean;
      }
      interface M {
        name: string;
        lightMap?: Tex | null;
        lightMapIntensity?: number;
        transmission?: number;
        userData: { mark?: string; bake?: boolean };
      }
      interface O {
        userData: { name?: string; lightmap?: unknown; lightmap_scale?: unknown };
        parent: O | null;
        material?: M | M[];
        isMesh?: boolean;
        visible: boolean;
        traverse(f: (o: O) => void): void;
      }
      const scene = (window as unknown as { __s26Scene: O }).__s26Scene;
      let glbRoot: O | null = null;
      scene.traverse((o) => {
        if (o.userData?.name === furnace) {
          let p: O = o;
          while (p.parent && p.parent !== scene) p = p.parent;
          glbRoot = p;
        }
      });
      if (!glbRoot) throw new Error('the workshop is not in the scene');
      const inGlb = new Set<O>();
      (glbRoot as O).traverse((o) => inGlb.add(o));
      /** The named piece of the glb a mesh belongs to (the glTF node name). */
      const owner = (o: O): O | null => {
        for (let p: O | null = o; p; p = p.parent) if (typeof p.userData?.name === 'string') return p;
        return null;
      };
      const baked: {
        object: string;
        material: string;
        channel: number;
        colorSpace: string;
        strength: number;
      }[] = [];
      const missing: string[] = [];
      const glassWithLightmap: string[] = [];
      const outsideWithLightmap: string[] = [];
      const bakedPieces = new Set<string>();
      scene.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        if (!inGlb.has(o)) {
          for (const m of mats) if (m.lightMap) outsideWithLightmap.push(m.name || '(unnamed)');
          return;
        }
        const piece = owner(o);
        const lightmapped = typeof piece?.userData.lightmap === 'string';
        for (const m of mats) {
          const glass = typeof m.userData?.mark === 'string' || (m.transmission ?? 0) > 0;
          const name = piece?.userData.name ?? '?';
          if (glass) {
            if (m.lightMap) glassWithLightmap.push(`${name}/${m.name}`);
            continue;
          }
          // what the bake leaves out (blender/scripts/pipeline.py bakeable_material: the fire, the embers, the air in glass)
          if (!lightmapped || m.userData?.bake === false) continue;
          bakedPieces.add(name);
          if (!m.lightMap) {
            missing.push(`${name}/${m.name}`);
            continue;
          }
          baked.push({
            object: name,
            material: m.name,
            channel: m.lightMap.channel,
            colorSpace: m.lightMap.colorSpace,
            strength: m.lightMapIntensity ?? 0,
          });
        }
      });
      return {
        baked,
        missing,
        glassWithLightmap,
        outsideWithLightmap,
        bakedPieces: [...bakedPieces].sort(),
      };
    }, WORKSHOP_OBJECTS.furnace.name);
    keep('baked', report);
    // 受け入れ条件2: the floor, the dome's brass, the furniture, the furnace, the annealer, the shelf's back
    for (const piece of [
      WORKSHOP_OBJECTS.bench.name,
      WORKSHOP_OBJECTS.furnace.name,
      WORKSHOP_OBJECTS.annealer.name,
      WORKSHOP_OBJECTS.shelf.name,
      WORKSHOP_OBJECTS.shelfBoard.name,
      WORKSHOP_OBJECTS.marver.name,
      WORKSHOP_OBJECTS.chair.name,
      WORKSHOP_OBJECTS.floor.name,
      WORKSHOP_OBJECTS.frame.name,
    ]) {
      expect(report.bakedPieces, `${piece} is baked`).toContain(piece);
    }
    expect(report.missing, 'opaque materials of baked pieces without the lightmap').toEqual([]);
    for (const b of report.baked) {
      expect(b.channel, `${b.object}/${b.material}: the second UV`).toBe(1);
      expect(b.colorSpace, `${b.object}/${b.material}: an sRGB image`).toBe('srgb');
      expect(b.strength, `${b.object}/${b.material}: its strength`).toBeGreaterThan(0);
    }
    expect(report.glassWithLightmap, 'glass with a lightmap').toEqual([]);
    expect(report.outsideWithLightmap, 'what the room makes (the vidro, the drop…) with a lightmap').toEqual(
      [],
    );
    expect(errors).toEqual([]);
  });
}
