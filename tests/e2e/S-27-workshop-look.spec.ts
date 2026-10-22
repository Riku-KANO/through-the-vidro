import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { WORKS_SHELF } from '../../src/game/prologue/layout';

/**
 * S-27: the workshop's look, polished (a furnace that reads as a furnace, works on the shelf you can see, more things
 * left about). On both render paths.
 *  (a) the four fixed views of S-24 (目覚め, 炉の前, 作品の棚, 扉から振り返る), taken the way S-24 takes them, into
 *      artifacts/screens/S-27/<backend>/<phase>/ with their draws, triangles and transmissive glass in view
 *      (artifacts/S-27/views-<backend>-<phase>.json). `S27_PHASE=before` takes the pictures of the build as it is before
 *      the change (the S-24 glb); the default is `after`. After: one picture of before | after side by side
 *      (artifacts/screens/S-27/<backend>/compare.png), when the before pictures are there. The designer judges the look.
 *  (b) sensors for what the designer saw (2026-10-22), measured on the screenshots in the page (thresholds and the
 *      values before and after: process/slices/S-27.md):
 *      - 炉が炉に見える: from in front of the furnace its mouth burns red — enough deep red pixels
 *      - 扉から見てクリーム色に滲みすぎない: from the door, few bright, warm, washed-out (cream) pixels
 *      - 作品の棚の作品が見える: hiding the works on the shelf changes enough of the picture, the clear ones alone too
 *        (against the sky, before, they hardly changed it)
 */
test.use({ locale: 'ja-JP' });

interface RoomProbe {
  ready: boolean;
  playing: boolean;
  drawCalls: number;
  triangles: number;
  workshop?: { loaded: boolean };
}
interface ViewCounts {
  drawCalls: number;
  triangles: number;
  transmissive: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const phase = process.env.S27_PHASE === 'before' ? 'before' : 'after';
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const VIEWS = [
  ['bench', 'wake'],
  ['furnace', 'furnace'],
  ['shelf', 'shelf'],
  ['door', 'door'],
] as const;

/**
 * Thresholds of the sensors (shares of the 1280×720 picture). Set from the pictures before and after (S-27.md): each
 * sits between what the S-24 workshop showed and what the change is meant to show, with room for the two paths.
 */
const LIMITS = {
  /**
   * 炉の前: deep red pixels — the fire in the mouth (S-24: none; the warm brass and the lit floor are orange, not this red).
   * 0.15% of the picture is a disc about 40 px across.
   */
  furnaceRed: 0.0015,
  /** 扉から振り返る: cream pixels (bright, warm, washed out). S-24: 12% (the furnace's milky bubbles and their bloom). */
  doorCream: 0.01,
  /**
   * 作品の棚: pixels the works change when hidden, above the noise between two pictures — all of them, and the clear ones
   * alone. At least twice what S-24 showed (0.44% and 0.25%).
   */
  shelfWorks: 0.009,
  shelfClear: 0.005,
};

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
 * Opens a fixed view the way S-24 takes it (mid quality, no dynamic resolution, no hint), with ?debug=1. `S27_QUERY`
 * adds switches for looking into something by hand (e.g. `&finish=aa`: no bloom); the recorded runs leave it empty.
 */
async function openView(page: Page, spawn: string, webgl: string): Promise<void> {
  const extra = process.env.S27_QUERY ?? '';
  await page.goto(
    `/?scene=prologue-proto&direct=1&spawn=${spawn}&peekHold=0&quality=mid&dynres=0&debug=1${webgl}${extra}`,
  );
  await waitRoom(page, 'r.ready && r.playing && r.workshop && r.workshop.loaded');
  // the scene the room draws, to hide pieces of the workshop by name (debug=1: further wrappers call on with apply)
  await page.evaluate(() => {
    const w = window as unknown as { __s27Scene?: unknown };
    const renderer = window.__vidroDebug?.renderer as unknown as {
      render: (...args: unknown[]) => unknown;
    };
    if (!renderer) throw new Error('no __vidroDebug.renderer (debug=1)');
    const render = renderer.render;
    renderer.render = (...args: unknown[]) => {
      const s = args[0] as { isScene?: boolean; getObjectByProperty?: unknown };
      if (s?.isScene && !w.__s27Scene) {
        let found = false;
        (s as { traverse(f: (o: { userData: { name?: string } }) => void): void }).traverse((o) => {
          if (o.userData?.name === 'A0_shlf_works01') found = true;
        });
        if (found) w.__s27Scene = s;
      }
      return render.apply(renderer, args);
    };
  });
  await page.waitForFunction(() => !!(window as unknown as { __s27Scene?: unknown }).__s27Scene);
  await page.waitForTimeout(1_200);
}

/**
 * Hides (or shows again) the shelf's works: named objects of kind `ware` standing along the shelf's arc. With `clear`,
 * only their meshes of clear glass (the library's glass keeps its Blender mark in userData.mark).
 */
async function setShelfWorks(page: Page, visible: boolean, only?: 'clear'): Promise<number> {
  return page.evaluate(
    ({ visible, only, from, to }) => {
      interface V {
        x: number;
        y: number;
        z: number;
      }
      interface O {
        userData: { name?: string; mark?: string };
        visible: boolean;
        isMesh?: boolean;
        material?: { userData?: { mark?: string } } | { userData?: { mark?: string } }[];
        geometry?: { boundingBox: { min: V; max: V } | null; computeBoundingBox(): void };
        matrixWorld: { elements: number[] };
        traverse(f: (o: O) => void): void;
      }
      const scene = (window as unknown as { __s27Scene: O }).__s27Scene;
      const meshes = new Set<O>();
      scene.traverse((o) => {
        const name = o.userData?.name ?? '';
        if (!/^A0_ware_[A-Za-z0-9]+$/.test(name)) return;
        // where the object is: the mean of its meshes' box centres in the world
        let sx = 0;
        let sz = 0;
        let k = 0;
        o.traverse((m) => {
          if (!m.isMesh || !m.geometry) return;
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox;
          if (!b) return;
          const c = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
          const e = m.matrixWorld.elements;
          const [x, y, z] = c as [number, number, number];
          sx += (e[0] ?? 0) * x + (e[4] ?? 0) * y + (e[8] ?? 0) * z + (e[12] ?? 0);
          sz += (e[2] ?? 0) * x + (e[6] ?? 0) * y + (e[10] ?? 0) * z + (e[14] ?? 0);
          k++;
        });
        if (k === 0) return;
        const deg = (Math.atan2(sz / k, sx / k) * 180) / Math.PI;
        const r = Math.hypot(sx / k, sz / k);
        if (deg < from - 5 || deg > to + 5 || r < 3.0) return;
        o.traverse((m) => {
          if (!m.isMesh) return;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          if (only === 'clear' && !mats.some((x) => x?.userData?.mark === 'glass_clear')) return;
          m.visible = visible;
          meshes.add(m);
        });
      });
      return meshes.size;
    },
    { visible, only, from: WORKS_SHELF.fromDeg, to: WORKS_SHELF.toDeg },
  );
}

/** Shares of the picture (PNG) by colour, measured in the page (sRGB 0..1). */
async function measure(
  page: Page,
  png: Buffer,
  other?: Buffer,
): Promise<{ red: number; cream: number; changed: number }> {
  return page.evaluate(
    async ({ a, b }) => {
      const pixels = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const d = await pixels(a);
      const e = b ? await pixels(b) : null;
      let red = 0;
      let cream = 0;
      let changed = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const r = (d[i] ?? 0) / 255;
        const g = (d[i + 1] ?? 0) / 255;
        const bl = (d[i + 2] ?? 0) / 255;
        // deep red: a saturated red with little green and blue (a fire's red; lit brass is about 0.55, 0.33, 0.2)
        if (r > 0.45 && g < 0.5 * r && bl < 0.3 * r) red++;
        // cream: bright, warm (red ≥ green ≥ blue), washed out (little between red and blue)
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        if (l > 0.72 && r >= g && g >= bl && r - bl < 0.3) cream++;
        if (e) {
          const dd = Math.max(
            Math.abs((d[i] ?? 0) - (e[i] ?? 0)),
            Math.abs((d[i + 1] ?? 0) - (e[i + 1] ?? 0)),
            Math.abs((d[i + 2] ?? 0) - (e[i + 2] ?? 0)),
          );
          if (dd > 12) changed++;
        }
      }
      return { red: red / n, cream: cream / n, changed: changed / n };
    },
    { a: png.toString('base64'), b: other?.toString('base64') ?? null },
  );
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-27', backend);
  const outDir = join(root, 'artifacts/S-27');
  const sensorFile = join(outDir, `sensors-${backend}-${phase}.json`);
  const sensors: Record<string, unknown> = {};
  const keep = (key: string, value: unknown) => {
    // merged with what is in the file: a failed test restarts the worker, which forgets the module's state
    if (existsSync(sensorFile)) Object.assign(sensors, JSON.parse(readFileSync(sensorFile, 'utf8')).sensors);
    sensors[key] = value;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(sensorFile, JSON.stringify({ backend, phase, sensors }, null, 2));
  };

  test(`S-27 the four fixed views (${phase}) inside the budget; before | after side by side [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(join(shotDir, phase), { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const errors = collectErrors(page);
    const views: Record<string, ViewCounts> = {};
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
    }
    writeFileSync(
      join(outDir, `views-${backend}-${phase}.json`),
      JSON.stringify({ backend, phase, views }, null, 2),
    );
    for (const [name, v] of Object.entries(views)) {
      expect(v.drawCalls, name).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(v.triangles, name).toBeLessThanOrEqual(BUDGET.triangles);
      // 技術設計 > 性能の目標と予算: 透過ガラスの同時表示は近景で20個程度まで
      expect(v.transmissive, `${name}: transmissive glass in view`).toBeLessThanOrEqual(20);
    }
    // before | after, one row per view (for the designer; S-24's four views)
    const before = VIEWS.map(([, name]) => join(shotDir, 'before', `${name}.png`));
    if (phase === 'after' && before.every((f) => existsSync(f))) {
      const pairs = VIEWS.map(([, name], i) => ({
        name,
        a: readFileSync(before[i] as string).toString('base64'),
        b: readFileSync(join(shotDir, 'after', `${name}.png`)).toString('base64'),
      }));
      const b64 = await page.evaluate(async (rows) => {
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
        g.fillText('S-24 (before)', 12, 24);
        g.fillText('S-27 (after)', W + gap + 12, 24);
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
      }, pairs);
      writeFileSync(join(shotDir, 'compare.png'), Buffer.from(b64, 'base64'));
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-27 the furnace burns red deep in its mouth (炉の前) [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await openView(page, 'furnace', webgl);
    const m = await measure(page, await page.screenshot());
    keep('furnace', m);
    expect(m.red, 'deep red share of the picture in front of the furnace').toBeGreaterThan(LIMITS.furnaceRed);
    expect(errors).toEqual([]);
  });

  test(`S-27 from the door the furnace does not bloom cream (扉から振り返る) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await openView(page, 'door', webgl);
    const m = await measure(page, await page.screenshot());
    keep('door', m);
    expect(m.cream, 'cream share of the picture from the door').toBeLessThan(LIMITS.doorCream);
    expect(errors).toEqual([]);
  });

  test(`S-27 the works on the shelf are seen against the sky (作品の棚) [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await openView(page, 'shelf', webgl);
    const shown = await page.screenshot();
    // the noise between two pictures of the same thing (the fire's light breathes, the motes drift)
    await page.waitForTimeout(300);
    const again = await page.screenshot();
    const noise = (await measure(page, shown, again)).changed;
    const all = await setShelfWorks(page, false);
    await page.waitForTimeout(400);
    const hidden = await page.screenshot();
    await setShelfWorks(page, true);
    const clear = await setShelfWorks(page, false, 'clear');
    await page.waitForTimeout(400);
    const noClear = await page.screenshot();
    await setShelfWorks(page, true);
    const works = (await measure(page, shown, hidden)).changed;
    const clearOnly = (await measure(page, shown, noClear)).changed;
    keep('shelf', { works, clearOnly, noise, meshes: { all, clear } });
    expect(all, 'meshes of the works on the shelf').toBeGreaterThan(0);
    expect(clear, 'meshes of clear works on the shelf').toBeGreaterThan(0);
    expect(noise, 'two pictures of the same view').toBeLessThan(0.004);
    expect(works - noise, 'share the works change').toBeGreaterThan(LIMITS.shelfWorks);
    expect(clearOnly - noise, 'share the clear works change').toBeGreaterThan(LIMITS.shelfClear);
    expect(errors).toEqual([]);
  });
}
