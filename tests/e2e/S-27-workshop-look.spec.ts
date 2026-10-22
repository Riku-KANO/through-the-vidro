import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { FURNACE_FACING, FURNACE_MOUTH, WORKS_SHELF } from '../../src/game/prologue/layout';

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
 *      - 炉が炉に見える: from in front of the furnace, the mouth (its opening projected on the screen) burns red — enough
 *        of it is a fire's red (hue up to 20°, saturated)
 *      - 扉から見てクリーム色に滲みすぎない: from the door, few bright, warm, washed-out (cream) pixels in the picture
 *      - 作品の棚の作品が見える: within the works' place on the screen (the box round their vertices), hiding the works changes
 *        enough pixels, the clear ones alone too (against the sky, before, they hardly changed it). Pixels that differ
 *        between two pictures of the same thing (the fire's light breathes) are left out
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
 * Thresholds of the sensors, set before measuring the change. The mouth: a fifth of its opening on the screen (about a
 * third of the opening is the cave behind the pipe and the yoke). The door: 1% of the picture (S-24: 12%). The shelf: twice
 * what the S-24 workshop showed in the same place (review round 1: the first version counted over the whole picture and
 * left the clear works a thin margin).
 */
const LIMITS = {
  /** 炉の前: share of the mouth's opening in a fire's red. S-24: 0 (its fire was a cream-white disc). */
  furnaceRed: 0.2,
  /** 扉から振り返る: cream pixels (bright, warm, washed out). S-24: 12% (the furnace's milky bubbles and their bloom). */
  doorCream: 0.01,
  /**
   * 作品の棚: share of the works' place that changes when they are hidden — all of them, and the clear ones alone. S-24:
   * 2.34–2.36% and 0.76–0.77% (WebGPU–WebGL2, the same measure on the S-24 glb); twice the higher of the two.
   */
  shelfWorks: 0.0471,
  shelfClear: 0.0154,
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
      const camera = args[1] as { isPerspectiveCamera?: boolean } | undefined;
      if (s?.isScene && !w.__s27Scene && camera?.isPerspectiveCamera) {
        let found = false;
        (s as { traverse(f: (o: { userData: { name?: string } }) => void): void }).traverse((o) => {
          if (o.userData?.name === 'A0_shlf_works01') found = true;
        });
        if (found) {
          w.__s27Scene = s;
          (w as { __s27Camera?: unknown }).__s27Camera = camera;
        }
      }
      return render.apply(renderer, args);
    };
  });
  await page.waitForFunction(() => !!(window as unknown as { __s27Scene?: unknown }).__s27Scene);
  await page.waitForTimeout(1_200);
}

/** A place on the screen (CSS pixels of the 1280×720 page): a box, or a disc. */
type Region = { x0: number; y0: number; x1: number; y1: number } | { cx: number; cy: number; r: number };

/** World points (three's coordinates) on the screen, with the camera the room drew with (CSS pixels). */
async function project(page: Page, points: [number, number, number][]): Promise<[number, number][]> {
  return page.evaluate((points) => {
    const cam = (
      window as unknown as {
        __s27Camera: { matrixWorldInverse: { elements: number[] }; projectionMatrix: { elements: number[] } };
      }
    ).__s27Camera;
    const v = cam.matrixWorldInverse.elements;
    const p = cam.projectionMatrix.elements;
    const at = (m: number[], i: number) => m[i] ?? 0;
    return points.map(([x, y, z]) => {
      const vx = at(v, 0) * x + at(v, 4) * y + at(v, 8) * z + at(v, 12);
      const vy = at(v, 1) * x + at(v, 5) * y + at(v, 9) * z + at(v, 13);
      const vz = at(v, 2) * x + at(v, 6) * y + at(v, 10) * z + at(v, 14);
      const cx = at(p, 0) * vx + at(p, 4) * vy + at(p, 8) * vz + at(p, 12);
      const cy = at(p, 1) * vx + at(p, 5) * vy + at(p, 9) * vz + at(p, 13);
      const cw = at(p, 3) * vx + at(p, 7) * vy + at(p, 11) * vz + at(p, 15);
      return [(cx / cw / 2 + 0.5) * innerWidth, (0.5 - cy / cw / 2) * innerHeight] as [number, number];
    });
  }, points);
}

/** The furnace's mouth on the screen: a disc over the brass collar's opening (radius 0.2 m, 0.955 m off the centre). */
async function mouthRegion(page: Page): Promise<Region> {
  const [fx, fz] = FURNACE_FACING;
  const reach = 0.335; // from FURNACE_MOUTH (0.62 m off the centre) to the opening
  const c: [number, number, number] = [
    FURNACE_MOUTH[0] + fx * reach,
    FURNACE_MOUTH[1],
    FURNACE_MOUTH[2] + fz * reach,
  ];
  const [centre, edge] = await project(page, [c, [c[0], c[1] + 0.2, c[2]]]);
  if (!centre || !edge) throw new Error('the mouth was not projected');
  return { cx: centre[0], cy: centre[1], r: Math.hypot(edge[0] - centre[0], edge[1] - centre[1]) };
}

/**
 * Hides (or shows again) the shelf's works: named objects of kind `ware` standing along the shelf's arc. With `clear`,
 * only their meshes of clear glass (the library's glass keeps its Blender mark in userData.mark). Returns how many meshes,
 * and points of them in the world (every 4th vertex: to find their place on the screen).
 */
async function setShelfWorks(
  page: Page,
  visible: boolean,
  only?: 'clear',
): Promise<{ meshes: number; points: [number, number, number][] }> {
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
        geometry?: {
          boundingBox: { min: V; max: V } | null;
          computeBoundingBox(): void;
          getAttribute(name: string): {
            count: number;
            getX(i: number): number;
            getY(i: number): number;
            getZ(i: number): number;
          };
        };
        matrixWorld: { elements: number[] };
        traverse(f: (o: O) => void): void;
      }
      const scene = (window as unknown as { __s27Scene: O }).__s27Scene;
      const meshes = new Set<O>();
      const points: [number, number, number][] = [];
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
          // every 4th vertex in the world (one object holds the works of the whole arc, so its box would cover far more)
          const pos = m.geometry?.getAttribute('position');
          if (!pos) return;
          const e = m.matrixWorld.elements;
          const w = (i: number) => e[i] ?? 0;
          for (let i = 0; i < pos.count; i += 4) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            const z = pos.getZ(i);
            points.push([
              w(0) * x + w(4) * y + w(8) * z + w(12),
              w(1) * x + w(5) * y + w(9) * z + w(13),
              w(2) * x + w(6) * y + w(10) * z + w(14),
            ]);
          }
        });
      });
      return { meshes: meshes.size, points };
    },
    { visible, only, from: WORKS_SHELF.fromDeg, to: WORKS_SHELF.toDeg },
  );
}

/**
 * Shares measured in the page (sRGB 0..1). `cream` over the whole picture. With a region: `red` = share of the region in a
 * fire's red; with `other`, `changed` = share of the region that differs from `other`, leaving out the pixels that differ
 * between `png` and `again` (two pictures of the same thing), whose share of the region is `noise`.
 */
async function measure(
  page: Page,
  png: Buffer,
  opts: { other?: Buffer; again?: Buffer; region?: Region } = {},
): Promise<{ red: number; cream: number; changed: number; noise: number; regionPixels: number }> {
  return page.evaluate(
    async ({ a, b, c, region }) => {
      const pixels = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const g = cv.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { data: g.getImageData(0, 0, bmp.width, bmp.height).data, width: bmp.width };
      };
      const { data: d, width } = await pixels(a);
      const e = b ? (await pixels(b)).data : null;
      const f = c ? (await pixels(c)).data : null;
      // the page's CSS pixels to the picture's pixels (the same at a device scale of 1)
      const k = width / innerWidth;
      const inside = (i: number): boolean => {
        if (!region) return true;
        const x = ((i / 4) % width) / k;
        const y = Math.floor(i / 4 / width) / k;
        if ('r' in region) return Math.hypot(x - region.cx, y - region.cy) <= region.r;
        return x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1;
      };
      const differs = (p: Uint8ClampedArray, q: Uint8ClampedArray, i: number): boolean =>
        Math.max(
          Math.abs((p[i] ?? 0) - (q[i] ?? 0)),
          Math.abs((p[i + 1] ?? 0) - (q[i + 1] ?? 0)),
          Math.abs((p[i + 2] ?? 0) - (q[i + 2] ?? 0)),
        ) > 12;
      let red = 0;
      let cream = 0;
      let changed = 0;
      let noise = 0;
      let inRegion = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const r = (d[i] ?? 0) / 255;
        const g = (d[i + 1] ?? 0) / 255;
        const bl = (d[i + 2] ?? 0) / 255;
        // cream: bright, warm (red ≥ green ≥ blue), washed out (little between red and blue)
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        if (l > 0.72 && r >= g && g >= bl && r - bl < 0.3) cream++;
        if (!inside(i)) continue;
        inRegion++;
        // a fire's red: hue up to 20° (red ≥ green ≥ blue: hue = 60·(g − b)/(r − b)), saturated, not dark. Lit brass is
        // about 22° (0.55, 0.33, 0.2)
        if (r >= 0.4 && r >= g && g >= bl && r - bl >= 0.6 * r && (g - bl) * 3 <= r - bl) red++;
        if (f && differs(d, f, i)) {
          noise++;
          continue;
        }
        if (e && differs(d, e, i)) changed++;
      }
      const m = Math.max(1, inRegion);
      return {
        red: red / m,
        cream: cream / n,
        changed: changed / m,
        noise: noise / m,
        regionPixels: inRegion,
      };
    },
    {
      a: png.toString('base64'),
      b: opts.other?.toString('base64') ?? null,
      c: opts.again?.toString('base64') ?? null,
      region: opts.region ?? null,
    },
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
    const region = await mouthRegion(page);
    const m = await measure(page, await page.screenshot(), { region });
    keep('furnace', { ...m, region });
    expect(m.regionPixels, 'the mouth is on the screen').toBeGreaterThan(2_000);
    expect(m.red, "share of the mouth's opening in a fire's red").toBeGreaterThan(LIMITS.furnaceRed);
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
    // a second picture of the same thing: the pixels that differ (the fire's light breathes) are left out
    await page.waitForTimeout(300);
    const again = await page.screenshot();
    const all = await setShelfWorks(page, false);
    await page.waitForTimeout(400);
    const hidden = await page.screenshot();
    await setShelfWorks(page, true);
    const clear = await setShelfWorks(page, false, 'clear');
    await page.waitForTimeout(400);
    const noClear = await page.screenshot();
    await setShelfWorks(page, true);
    // the works' place on the screen: the box round their vertices
    const xy = await project(page, all.points);
    const xs = xy.map(([x]) => x);
    const ys = xy.map(([, y]) => y);
    const region: Region = {
      x0: Math.max(0, Math.min(...xs)),
      y0: Math.max(0, Math.min(...ys)),
      x1: Math.min(1280, Math.max(...xs)),
      y1: Math.min(720, Math.max(...ys)),
    };
    const works = await measure(page, shown, { other: hidden, again, region });
    const clearOnly = await measure(page, shown, { other: noClear, again, region });
    keep('shelf', {
      works: works.changed,
      clearOnly: clearOnly.changed,
      noise: works.noise,
      region,
      meshes: { all: all.meshes, clear: clear.meshes },
    });
    expect(all.meshes, 'meshes of the works on the shelf').toBeGreaterThan(0);
    expect(clear.meshes, 'meshes of clear works on the shelf').toBeGreaterThan(0);
    expect(works.regionPixels, 'the works are on the screen').toBeGreaterThan(20_000);
    expect(works.noise, 'two pictures of the same view').toBeLessThan(0.02);
    expect(works.changed, "share of the works' place they change").toBeGreaterThan(LIMITS.shelfWorks);
    expect(clearOnly.changed, "share of the works' place the clear ones change").toBeGreaterThan(
      LIMITS.shelfClear,
    );
    expect(errors).toEqual([]);
  });
}
