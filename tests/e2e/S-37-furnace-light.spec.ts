import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { FURNACE, FURNACE_FACING, FURNACE_MOUTH } from '../../src/game/prologue/layout';

/**
 * S-37: the furnace's light baked apart (設計書 アートディレクション > 光と時間帯: 静止した光は焼き込み; 温度のある透明;
 * 世界観 > まだそこで暮らしている気配). The fire in the furnace's mouth and the embers of the annealer are baked into a lightmap of
 * their own, added to the lightmap of the sky and the sun in the game, its strength breathing with the fire's realtime light
 * (room-art.ts, ±8%). On both render paths.
 *  (a) the warm light on the floor in front of the furnace, from the furnace view, the first picture (目覚め) and the door
 *      (扉から振り返る: the floor at the furnace's foot), measured on
 *      the screenshots: the pixels of the floor (found by drawing the floor flat magenta) whose point on the floor lies in front
 *      of the furnace (FLOOR_SECTOR), their warmth (sRGB red minus blue). `S37_PHASE` picks what is taken:
 *        s31    S-31 (a3fd76d: the workshop lit in real time, the fire's spot without a shadow). Run in a checkout of that
 *               commit with this file copied in and `S37_ROOT` pointing here (process/slices/S-37.md)
 *        s26    S-26 (main before this slice: the fire baked with the sky and the sun into one lightmap, behind the dome)
 *        after  this slice (the default): the warmth is back to about S-31's (WARMTH), and S-31 | S-26 | S-37 side by side
 *      WARMTH holds what S-31 and S-26 measured on the machine of S-37 (Apple M5 Pro, Metal). On another machine (another
 *      GPU draws the colours a little apart) measure them again there with S37_PHASE=s31 and s26 before judging `after`.
 *  (b) (after) the fire's lightmap breathes: every frame the fire light's intensity ÷ the lightmap's strength is the same, it moves
 *      within ±8%, every baked material of the furnace's light uses the same strength, and with it held at 0 the warm floor
 *      in front of the furnace goes (the warmth is the fire's lightmap)
 *  (c) the weight of one more lightmap: the workshop's textures on the GPU (≤ 80MB: 設計書 ポリゴンとテクスチャの予算), the glb,
 *      the draw calls of the four fixed views (not more than S-26's: DRAWS)
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
interface Warmth {
  /** Floor pixels in the sector (CSS pixels of the 1280×720 page). */
  pixels: number;
  /** Mean of red minus blue (sRGB, 0–255) over them. */
  mean: number;
  /** Mean of max(0, red − blue): the amount of warm colour. */
  amount: number;
  /** Share of them warmer than WARM (red − blue). */
  warmShare: number;
  /**
   * Mean of max(0, red − green): the fire's red-orange (0xff6a2a) apart from the dawn sun's peach (0xffbd86), which is warm
   * (red over blue) but hardly red over green.
   */
  red: number;
  /** Share of them redder than RED (red − green). */
  redShare: number;
}

const PHASES = ['s31', 's26', 'after'] as const;
type Phase = (typeof PHASES)[number];
const phase: Phase = PHASES.find((p) => p === process.env.S37_PHASE) ?? 'after';
/** Where the pictures and numbers go (a checkout of S-31 writes into this one's artifacts). */
const root = process.env.S37_ROOT ?? process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const FURNACE_NAME = 'A0_frn_furnace01';
const FLOOR_NAME = 'A0_flr_floor01';
/** The floor's top (make_workshop.py FLOOR_TOP; S-31's disc in room-art.ts: −0.096 + 0.1). */
const FLOOR_Y = 0.004;
/**
 * The floor in front of the furnace: from its foot (the dome's radius at the floor, 1.0 m) out to `far`, within `deg` of the
 * way its mouth faces (the half disc before it: the fire's spot is turned toward the bench and spreads 80° about its axis).
 */
const FLOOR_SECTOR = { near: 0.95, far: 3.0, deg: 90 } as const;
/** A warm pixel: red minus blue over this (sRGB 0–255; the floor in the dawn's blue is about −20). */
const WARM = 8;
/** A red pixel: red minus green over this (sRGB 0–255). */
const RED = 12;
const VIEWS = [
  ['furnace', 'furnace'],
  ['bench', 'wake'],
  ['door', 'door'],
] as const;
const ALL_VIEWS = [
  ['bench', 'wake'],
  ['furnace', 'furnace'],
  ['shelf', 'shelf'],
  ['door', 'door'],
] as const;
const TEXTURE_BUDGET = 80 * 1024 * 1024;

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
 * Opens a fixed view the way S-24…S-31 and S-26 take it (mid quality, no dynamic resolution, no hint), with ?debug=1, and
 * keeps the scene and the camera the room draws with (`__s37Scene`, `__s37Camera`).
 */
async function openView(page: Page, spawn: string, webgl: string): Promise<void> {
  await page.goto(
    `/?scene=prologue-proto&direct=1&spawn=${spawn}&peekHold=0&quality=mid&dynres=0&debug=1${webgl}`,
  );
  await waitRoom(page, 'r.ready && r.playing && r.workshop && r.workshop.loaded');
  await page.evaluate((furnace) => {
    const w = window as unknown as { __s37Camera?: unknown; __s37Scene?: unknown };
    const renderer = window.__vidroDebug?.renderer as unknown as {
      render: (...args: unknown[]) => unknown;
    };
    if (!renderer) throw new Error('no __vidroDebug.renderer (debug=1)');
    const render = renderer.render;
    renderer.render = (...args: unknown[]) => {
      const s = args[0] as { isScene?: boolean };
      const camera = args[1] as { isPerspectiveCamera?: boolean } | undefined;
      if (s?.isScene && !w.__s37Camera && camera?.isPerspectiveCamera) {
        let found = false;
        (s as { traverse(f: (o: { userData: { name?: string } }) => void): void }).traverse((o) => {
          if (o.userData?.name === furnace) found = true;
        });
        if (found) {
          w.__s37Camera = camera;
          w.__s37Scene = s;
        }
      }
      return render.apply(renderer, args);
    };
  }, FURNACE_NAME);
  await page.waitForFunction(() => !!(window as unknown as { __s37Scene?: unknown }).__s37Scene);
  await page.waitForTimeout(1_200);
}

/**
 * Draws the workshop's floor flat magenta (a plain unlit material of the scene's own kind), or gives it back its own. The
 * floor: the glb's A0_flr_floor01 (S-26 on), or S-31's disc drawn in code (a cylinder 0.2 m high, as wide as the dome).
 */
async function floorMagenta(page: Page, on: boolean): Promise<number> {
  const n = await page.evaluate(
    ({ on, floorName }) => {
      interface Mat {
        type: string;
        dispose(): void;
      }
      interface O {
        isMesh?: boolean;
        userData: { name?: string; __s37Own?: unknown };
        parent: O | null;
        geometry?: { type?: string; parameters?: { height?: number; radiusTop?: number } };
        material: Mat | Mat[];
        traverse(f: (o: O) => void): void;
      }
      const scene = (window as unknown as { __s37Scene: O }).__s37Scene;
      let Basic:
        | (new () => Mat & { color: { setRGB(r: number, g: number, b: number): void }; fog: boolean })
        | null = null;
      const floors: O[] = [];
      scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          if (m.type === 'MeshBasicNodeMaterial') Basic = m.constructor as typeof Basic;
        let named: string | null = null;
        for (let p: O | null = o; p; p = p.parent)
          if (typeof p.userData?.name === 'string') {
            named = p.userData.name;
            break;
          }
        const g = o.geometry;
        if (
          named === floorName ||
          (g?.type === 'CylinderGeometry' &&
            g.parameters?.height === 0.2 &&
            (g.parameters?.radiusTop ?? 0) > 4.5)
        )
          floors.push(o);
      });
      for (const f of floors) {
        if (on) {
          if (!Basic) throw new Error('no plain material in the scene');
          const flat = new (
            Basic as unknown as new () => Mat & {
              color: { setRGB(r: number, g: number, b: number): void };
              fog: boolean;
            }
          )();
          flat.color.setRGB(1, 0, 1);
          flat.fog = false;
          f.userData.__s37Own = f.material;
          f.material = flat;
        } else if (f.userData.__s37Own) {
          (f.material as Mat).dispose();
          f.material = f.userData.__s37Own as Mat;
          delete f.userData.__s37Own;
        }
      }
      return floors.length;
    },
    { on, floorName: FLOOR_NAME },
  );
  await page.waitForTimeout(700);
  return n;
}

/**
 * The warmth of the floor in front of the furnace in `shots` (PNG, base64; averaged: the fire breathes), over the pixels the
 * magenta picture shows as floor whose point on the floor plane (the camera's ray through the pixel) lies in FLOOR_SECTOR.
 * With `tint`, also returns the first shot with those pixels tinted green (to see what was measured).
 */
async function floorWarmth(
  page: Page,
  shots: string[],
  magenta: string,
  tint = false,
): Promise<Warmth & { region?: string }> {
  return page.evaluate(
    async ({ shots, magenta, centre, facing, sector, floorY, warm, redLine, tint }) => {
      const pixelsOf = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { c, g, data: g.getImageData(0, 0, bmp.width, bmp.height), w: bmp.width, h: bmp.height };
      };
      const cam = (
        window as unknown as {
          __s37Camera: {
            matrixWorld: { elements: number[] };
            projectionMatrixInverse: { elements: number[] };
          };
        }
      ).__s37Camera;
      const mw = cam.matrixWorld.elements;
      const pi = cam.projectionMatrixInverse.elements;
      const at = (m: number[], i: number) => m[i] ?? 0;
      const mask = await pixelsOf(magenta);
      const { w, h } = mask;
      const ox = at(mw, 12);
      const oy = at(mw, 13);
      const oz = at(mw, 14);
      const cosMax = Math.cos((sector.deg * Math.PI) / 180);
      const inSector = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = mask.data.data[i] ?? 0;
          const g = mask.data.data[i + 1] ?? 0;
          const b = mask.data.data[i + 2] ?? 0;
          if (!(r - g > 60 && b - g > 60)) continue;
          // the camera's ray through the pixel, onto the floor plane
          const nx = ((x + 0.5) / w) * 2 - 1;
          const ny = 1 - ((y + 0.5) / h) * 2;
          const vx = at(pi, 0) * nx + at(pi, 4) * ny + at(pi, 8) * 0.5 + at(pi, 12);
          const vy = at(pi, 1) * nx + at(pi, 5) * ny + at(pi, 9) * 0.5 + at(pi, 13);
          const vz = at(pi, 2) * nx + at(pi, 6) * ny + at(pi, 10) * 0.5 + at(pi, 14);
          const vw = at(pi, 3) * nx + at(pi, 7) * ny + at(pi, 11) * 0.5 + at(pi, 15);
          const px = vx / vw;
          const py = vy / vw;
          const pz = vz / vw;
          const dx = at(mw, 0) * px + at(mw, 4) * py + at(mw, 8) * pz + at(mw, 12) - ox;
          const dy = at(mw, 1) * px + at(mw, 5) * py + at(mw, 9) * pz + at(mw, 13) - oy;
          const dz = at(mw, 2) * px + at(mw, 6) * py + at(mw, 10) * pz + at(mw, 14) - oz;
          if (dy >= 0) continue;
          const t = (floorY - oy) / dy;
          const fx = ox + dx * t - centre[0];
          const fz = oz + dz * t - centre[2];
          const d = Math.hypot(fx, fz);
          if (d < sector.near || d > sector.far) continue;
          if ((fx * facing[0] + fz * facing[1]) / d < cosMax) continue;
          inSector[y * w + x] = 1;
        }
      }
      const sums = { pixels: 0, mean: 0, amount: 0, warmShare: 0, red: 0, redShare: 0 };
      let region: string | undefined;
      for (const [k, b64] of shots.entries()) {
        const shot = await pixelsOf(b64);
        let n = 0;
        let sum = 0;
        let amount = 0;
        let warmCount = 0;
        let red = 0;
        let redCount = 0;
        for (let p = 0; p < w * h; p++) {
          if (!inSector[p]) continue;
          const i = p * 4;
          const d = (shot.data.data[i] ?? 0) - (shot.data.data[i + 2] ?? 0);
          const e = (shot.data.data[i] ?? 0) - (shot.data.data[i + 1] ?? 0);
          n++;
          sum += d;
          amount += Math.max(0, d);
          if (d > warm) warmCount++;
          red += Math.max(0, e);
          if (e > redLine) redCount++;
          if (tint && k === 0) {
            shot.data.data[i] = Math.round((shot.data.data[i] ?? 0) * 0.6);
            shot.data.data[i + 1] = Math.round((shot.data.data[i + 1] ?? 0) * 0.6 + 255 * 0.4);
            shot.data.data[i + 2] = Math.round((shot.data.data[i + 2] ?? 0) * 0.6);
          }
        }
        sums.pixels = n;
        sums.mean += sum / Math.max(1, n) / shots.length;
        sums.amount += amount / Math.max(1, n) / shots.length;
        sums.warmShare += warmCount / Math.max(1, n) / shots.length;
        sums.red += red / Math.max(1, n) / shots.length;
        sums.redShare += redCount / Math.max(1, n) / shots.length;
        if (tint && k === 0) {
          shot.g.putImageData(shot.data, 0, 0);
          const out = await shot.c.convertToBlob({ type: 'image/png' });
          const bytes = new Uint8Array(await out.arrayBuffer());
          let s = '';
          for (let j = 0; j < bytes.length; j += 0x8000)
            s += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
          region = btoa(s);
        }
      }
      return { ...sums, ...(region ? { region } : {}) };
    },
    {
      shots,
      magenta,
      centre: FURNACE.center,
      facing: FURNACE_FACING,
      sector: FLOOR_SECTOR,
      floorY: FLOOR_Y,
      warm: WARM,
      redLine: RED,
      tint,
    },
  );
}

/** Three (or fewer) phases side by side, one row per view, under their titles (PNG). */
async function grid(
  page: Page,
  titles: string[],
  rows: { name: string; cells: string[] }[],
): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ titles, rows }) => {
      const W = 560;
      const H = 315;
      const top = 34;
      const gap = 6;
      const cols = titles.length;
      const c = new OffscreenCanvas(cols * W + (cols - 1) * gap, top + rows.length * (H + gap));
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.fillStyle = '#16181d';
      g.fillRect(0, 0, c.width, c.height);
      g.font = '19px sans-serif';
      for (const [j, t] of titles.entries()) {
        g.fillStyle = '#e8e6e1';
        g.fillText(t, j * (W + gap) + 10, 24);
      }
      for (const [i, row] of rows.entries()) {
        for (const [j, src] of row.cells.entries()) {
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
    { titles, rows },
  );
  return Buffer.from(b64, 'base64');
}

type Kept = Pick<Warmth, 'amount' | 'warmShare' | 'red'>;
/**
 * The warmth of the floor in front of the furnace in S-31 (S37_PHASE=s31, run in a checkout of a3fd76d: the realtime fire,
 * its spot without a shadow) and in S-26 (S37_PHASE=s26, main 2d30c73: the fire baked with the sky into one lightmap),
 * per backend and view, measured on 2026-10-23 with SHOTS pictures each (artifacts/S-37/sensors-<backend>-<phase>.json; process/slices/S-37.md).
 * After, "about as much as S-31": the amount of warm colour (red − blue) and of the fire's red (red − green), and the share
 * of warm pixels, at least KEPT of S-31's, the amount not past OVER times it (the dawn's blue stays: no orange room).
 * From in front of the furnace and from the door, where S-26 lost it (8.9 and 18.4 of S-31's 15.4 and 22.4), the amount is
 * also more than halfway back from S-26 to S-31. In the first picture the floor on the right is warm with the dawn's sun as
 * well (S-26 is as warm there as S-31), so only the bounds hold there.
 */
const WARMTH: Record<string, Record<string, { s31: Kept; s26: Kept }>> = {
  webgpu: {
    furnace: {
      s31: { amount: 15.41, warmShare: 0.36, red: 18.18 },
      s26: { amount: 8.885, warmShare: 0.203, red: 13.94 },
    },
    wake: {
      s31: { amount: 30.35, warmShare: 0.93, red: 24.33 },
      s26: { amount: 31.38, warmShare: 0.996, red: 23.54 },
    },
    door: {
      s31: { amount: 22.34, warmShare: 0.497, red: 25.61 },
      s26: { amount: 18.42, warmShare: 0.459, red: 23.64 },
    },
  },
  webgl2: {
    furnace: {
      s31: { amount: 15.44, warmShare: 0.361, red: 18.2 },
      s26: { amount: 8.905, warmShare: 0.204, red: 13.96 },
    },
    wake: {
      s31: { amount: 30.35, warmShare: 0.93, red: 24.34 },
      s26: { amount: 31.38, warmShare: 0.996, red: 23.54 },
    },
    door: {
      s31: { amount: 22.38, warmShare: 0.497, red: 25.64 },
      s26: { amount: 18.42, warmShare: 0.459, red: 23.64 },
    },
  },
};
const KEPT = 0.85;
const OVER = 1.25;
/** Pictures averaged per view, and the time between them (the fire breathes: room-art.ts, ±8%). */
const SHOTS = 8;
const SHOT_GAP_MS = 300;
/** Where S-37 brings back what S-26 lost: more than halfway from S-26 to S-31. */
const RESTORES: readonly string[] = ['furnace', 'door'];
/** Draw calls of the four fixed views in S-26 (S37_PHASE=s26, the same on both paths): one more lightmap adds none. */
const DRAWS: Record<string, number> = { wake: 67, furnace: 43, shelf: 38, door: 72 };

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-37', backend);
  const outDir = join(root, 'artifacts/S-37');
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

  test(`S-37 the warm light on the floor in front of the furnace (${phase}) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(join(shotDir, phase), { recursive: true });
    const errors = collectErrors(page);
    const measured: Record<string, Warmth> = {};
    for (const [spawn, name] of VIEWS) {
      await openView(page, spawn, webgl);
      // SHOTS pictures over about one slow wave of the fire's breath (2.3 rad/s: 2.7 s), averaged
      const shots: string[] = [];
      for (let i = 0; i < SHOTS; i++) {
        const png = await page.screenshot();
        if (i === 0) writeFileSync(join(shotDir, phase, `${name}.png`), png);
        shots.push(png.toString('base64'));
        await page.waitForTimeout(SHOT_GAP_MS);
      }
      expect(await floorMagenta(page, true), 'the floor').toBeGreaterThan(0);
      const magenta = (await page.screenshot()).toString('base64');
      await floorMagenta(page, false);
      const { region, ...warmth } = await floorWarmth(page, shots, magenta, true);
      if (region) writeFileSync(join(shotDir, phase, `${name}-region.png`), Buffer.from(region, 'base64'));
      measured[name] = warmth;
      expect(warmth.pixels, `${name}: floor pixels in front of the furnace`).toBeGreaterThan(2_000);
    }
    keep('warmth', measured);
    if (phase === 'after') {
      const shot = (p: Phase, name: string) => join(shotDir, p, `${name}.png`);
      const have = PHASES.filter((p) => VIEWS.every(([, name]) => existsSync(shot(p, name))));
      const titles: Record<Phase, string> = {
        s31: 'S-31 (realtime fire)',
        s26: 'S-26 (fire baked with the sky)',
        after: 'S-37 (fire baked apart)',
      };
      writeFileSync(
        join(shotDir, 'compare.png'),
        await grid(
          page,
          have.map((p) => titles[p]),
          VIEWS.map(([, name]) => ({
            name,
            cells: have.map((p) => readFileSync(shot(p, name)).toString('base64')),
          })),
        ),
      );
      const ref = WARMTH[backend];
      for (const [, name] of VIEWS) {
        const was = ref?.[name];
        const now = measured[name];
        if (!was || !now) throw new Error(`no S-31 warmth for ${backend} ${name} (S37_PHASE=s31)`);
        const ratios = {
          amount: now.amount / was.s31.amount,
          warmShare: now.warmShare / was.s31.warmShare,
          red: now.red / was.s31.red,
        };
        keep(`ratiosToS31-${name}`, ratios);
        expect(ratios.amount, `${name}: warm amount, ÷ S-31`).toBeGreaterThan(KEPT);
        expect(ratios.amount, `${name}: warm amount, ÷ S-31`).toBeLessThan(OVER);
        expect(ratios.warmShare, `${name}: warm share, ÷ S-31`).toBeGreaterThan(KEPT);
        expect(ratios.red, `${name}: the fire's red, ÷ S-31`).toBeGreaterThan(KEPT);
        if (RESTORES.includes(name))
          expect(now.amount, `${name}: more than halfway back from S-26 to S-31`).toBeGreaterThan(
            (was.s26.amount + was.s31.amount) / 2,
          );
      }
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-37 the baked fire breathes with the fire's light [${backend}]`, async ({ page }) => {
    test.skip(phase !== 'after', 'the fire baked apart is this slice’s');
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    await openView(page, 'furnace', webgl);
    // every frame for 2.5 s: the fire's realtime light (the spot light at the furnace's mouth) and the strength of the fire's
    // lightmap on each baked material that has it. They breathe together: the light's intensity ÷ the strength is the same
    // (its intensity at rest) every frame
    const run = await page.evaluate(async (mouth) => {
      interface Gain {
        value: number;
        uuid?: string;
        id?: number;
      }
      interface Layer {
        layer: string;
        gain: Gain | number;
      }
      interface O {
        isMesh?: boolean;
        isSpotLight?: boolean;
        intensity?: number;
        matrixWorld: { elements: number[] };
        material?: { lightMapLayers?: Layer[] } | { lightMapLayers?: Layer[] }[];
        traverse(f: (o: O) => void): void;
      }
      const scene = (window as unknown as { __s37Scene: O }).__s37Scene;
      let fire: O | null = null;
      let nearest = 0.3;
      const gains = new Set<Gain | number>();
      let layered = 0;
      scene.traverse((o) => {
        if (o.isSpotLight) {
          const e = o.matrixWorld.elements;
          const d = Math.hypot((e[12] ?? 0) - mouth[0], (e[13] ?? 0) - mouth[1], (e[14] ?? 0) - mouth[2]);
          if (d < nearest) {
            nearest = d;
            fire = o;
          }
        }
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
          for (const l of m.lightMapLayers ?? []) {
            if (l.layer !== 'fire') continue;
            gains.add(l.gain);
            layered++;
          }
        }
      });
      if (!fire) throw new Error('no spot light within 0.3 m of the furnace’s mouth');
      const f = fire as O;
      const [gain] = [...gains];
      const frames: { light: number; gain: number }[] = [];
      await new Promise<void>((done) => {
        const t0 = performance.now();
        const step = () => {
          frames.push({
            light: f.intensity ?? 0,
            gain: typeof gain === 'number' ? gain : (gain?.value ?? Number.NaN),
          });
          if (performance.now() - t0 < 2_500) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      return { frames, distinctGains: gains.size, layered, numberGain: typeof gain === 'number' };
    }, FURNACE_MOUTH);
    const values = run.frames.map((x) => x.gain);
    const atRest = run.frames.map((x) => x.light / x.gain);
    const rest = atRest.reduce((s, x) => s + x, 0) / Math.max(1, atRest.length);
    keep('breath', {
      frames: run.frames.length,
      layered: run.layered,
      distinctGains: run.distinctGains,
      min: Math.min(...values),
      max: Math.max(...values),
      lightAtRest: rest,
    });
    expect(run.layered, "baked materials with the fire's lightmap").toBeGreaterThan(5);
    expect(run.distinctGains, 'one strength for all of them').toBe(1);
    expect(run.numberGain, 'a strength that can change (a uniform), not a number').toBe(false);
    expect(run.frames.length).toBeGreaterThan(30);
    expect(rest, 'the fire light’s intensity at rest').toBeGreaterThan(0);
    for (const r of atRest)
      expect(
        Math.abs(r / rest - 1),
        'the fire light’s intensity ÷ the strength: the same breath',
      ).toBeLessThan(1e-6);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.92 - 1e-6);
    expect(Math.max(...values)).toBeLessThanOrEqual(1.08 + 1e-6);
    expect(Math.max(...values) - Math.min(...values), 'it breathes').toBeGreaterThan(0.04);

    // held at 0, the warm floor in front of the furnace goes: its warmth is the fire's lightmap
    const shotsOn: string[] = [];
    for (let i = 0; i < 2; i++) {
      shotsOn.push((await page.screenshot()).toString('base64'));
      await page.waitForTimeout(200);
    }
    await page.evaluate(() => {
      interface O {
        isMesh?: boolean;
        material?: { lightMapLayers?: { gain: object }[] } | { lightMapLayers?: { gain: object }[] }[];
        traverse(f: (o: O) => void): void;
      }
      const scene = (window as unknown as { __s37Scene: O }).__s37Scene;
      scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])
          for (const l of m.lightMapLayers ?? [])
            Object.defineProperty(l.gain, 'value', { configurable: true, get: () => 0, set: () => {} });
      });
    });
    await page.waitForTimeout(500);
    const off = await page.screenshot();
    mkdirSync(join(shotDir, phase), { recursive: true });
    writeFileSync(join(shotDir, phase, 'furnace-fire-lightmap-off.png'), off);
    await floorMagenta(page, true);
    const magenta = (await page.screenshot()).toString('base64');
    await floorMagenta(page, false);
    const on = await floorWarmth(page, shotsOn, magenta);
    const without = await floorWarmth(page, [off.toString('base64')], magenta);
    keep('fireLightmapOff', { on, without });
    expect(without.amount, "warm amount without the fire's lightmap, ÷ with it").toBeLessThan(
      on.amount * 0.5,
    );
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-37 one more lightmap: the textures on the GPU, the glb, the draws (${phase}) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors = collectErrors(page);
    const draws: Record<string, number> = {};
    let textures: { name: string; width: number; height: number; bytes: number }[] = [];
    for (const [spawn, name] of ALL_VIEWS) {
      await openView(page, spawn, webgl);
      let most = 0;
      for (let i = 0; i < 6; i++) {
        most = Math.max(most, (await room(page)).drawCalls);
        await page.waitForTimeout(80);
      }
      draws[name] = most;
      if (name !== 'wake') continue;
      // the textures the workshop's glb brought, with what its baked materials hold in their layers
      textures = await page.evaluate((furnace) => {
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
        const scene = (window as unknown as { __s37Scene: O }).__s37Scene;
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
            for (const l of (m.lightMapLayers as { map?: Tex }[] | undefined) ?? [])
              if (l.map?.isTexture) seen.set(l.map.uuid, l.map);
          }
        });
        return [...seen.values()].map((t) => {
          if (t.isCompressedTexture && t.mipmaps?.length)
            return {
              name: t.name,
              width: t.mipmaps[0]?.width ?? 0,
              height: t.mipmaps[0]?.height ?? 0,
              bytes: t.mipmaps.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0),
            };
          const w = t.image?.width ?? 0;
          const h = t.image?.height ?? 0;
          return {
            name: t.name,
            width: w,
            height: h,
            bytes: Math.round(w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1)),
          };
        });
      }, FURNACE_NAME);
    }
    const textureBytes = textures.reduce((s, t) => s + t.bytes, 0);
    const glb = join(process.cwd(), 'public/assets/workshop/a0.glb');
    const glbBytes = existsSync(glb) ? statSync(glb).size : 0;
    keep('weight', { draws, textures, textureBytes, glbBytes });
    expect(textureBytes, "the workshop's textures on the GPU").toBeLessThanOrEqual(TEXTURE_BUDGET);
    if (phase === 'after') {
      expect(
        textures.filter((t) => /lightmap/.test(t.name)).map((t) => t.name),
        'the lightmaps',
      ).toEqual(expect.arrayContaining(['A0_lightmap', 'A0_lightmap_fire']));
      for (const [name, n] of Object.entries(draws)) {
        const before = DRAWS[name];
        if (before === undefined) throw new Error(`no S-26 draw calls for ${name} (S37_PHASE=s26)`);
        expect(n, `${name}: draw calls, not more than S-26's`).toBeLessThanOrEqual(before);
      }
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
