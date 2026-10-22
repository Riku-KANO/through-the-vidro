import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { FURNACE_FACING, FURNACE_MOUTH, WORKSHOP_OBJECTS } from '../../src/game/prologue/layout';

/**
 * S-31: the furnace made again in the annealer's words (a low, wide bubble dome; the mouth an opening in its front with a
 * brass ring for its rim; the chimney straight up), so that it no longer reads as a kettle, a diving helmet or a pot
 * (the designer, 2026-10-22; the shape itself is measured on the glb: src/game/assets/furnace-shape.test.ts). On both
 * render paths.
 *  (a) the four fixed views of S-24 (目覚め, 炉の前, 作品の棚, 扉から振り返る), taken the way S-24, S-27 and S-30 take them,
 *      into artifacts/screens/S-31/<backend>/<phase>/ with their draws, triangles and transmissive glass in view
 *      (artifacts/S-31/views-<backend>-<phase>.json). `S31_PHASE=before` takes the build as it is before the change (the
 *      S-30 glb); the default is `after`, which also puts before | after side by side: all four views
 *      (artifacts/screens/S-31/<backend>/compare.png) and the two the furnace is seen in, in front of it and from the door
 *      (compare-furnace.png). The designer judges the look.
 *  (b) the fire's core blooms a little (画面の仕上げ: ブルームは控えめにし、強い光源だけが滲む; S-30 残件: its hottest
 *      colour, luminance 0.43, was under the bloom's threshold of 0.9): in front of the furnace, the same view with the
 *      finishing's bloom and without it (`finish=aa`, S-17), two pictures each, with the fire's spot light dark in both:
 *      what blooms is then the fire itself, not the brass it lights (the S-30 build, with the light, already brightened a
 *      fifth of the disc: the blowpipe and the collar beside the light; process/slices/S-31.md). About the mouth (a disc
 *      over the opening, wider than it) enough pixels are brightened by the bloom; a place of the same size away from the
 *      fire is not. Pixels that differ between the two pictures of one mode and the hand orb are left out. That the bloom
 *      stays a little is held by S-27's sensors (the mouth still a fire's red, no cream from the door).
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
interface ViewCounts {
  drawCalls: number;
  triangles: number;
  transmissive: number;
}
/** A disc on the screen (CSS pixels of the 1280×720 page). */
interface Circle {
  cx: number;
  cy: number;
  r: number;
}
interface Glow {
  /** Pixels of the disc measured (on the screen, not the hand orb, steady in both modes). */
  pixels: number;
  /** Share of the disc's pixels left out because the two pictures of a mode differ there. */
  unsteady: number;
  /** Mean gain of sRGB luminance (0..1) with the bloom over without it. */
  mean: number;
  /** Share of the measured pixels brightened by more than GAIN. */
  brightened: number;
  /** The 95th percentile of the gain. */
  p95: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const phase = process.env.S31_PHASE === 'before' ? 'before' : 'after';
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
const VIEWS = [
  ['bench', 'wake'],
  ['furnace', 'furnace'],
  ['shelf', 'shelf'],
  ['door', 'door'],
] as const;
/**
 * The mouth's opening (blender/scripts/make_workshop.py furnace(): MOUTH_HOLE, and where the dome's surface crosses the
 * mouth's axis): its middle this far along the facing from FURNACE_MOUTH (the fire, 0.62 m off the furnace's centre), its
 * radius. tests/e2e/S-27-workshop-look.spec.ts mouthRegion uses the same numbers.
 */
const OPENING = { reach: 0.17, radius: 0.21 };
/** The disc measured for the bloom: the opening and the glass about it. */
const GLOW_DISC = 1.8;
/** A pixel is brightened by the bloom when its sRGB luminance rises by more than this (about 8 of 255). */
const GAIN = 0.03;
/**
 * Thresholds, set before the change from the S-30 build measured the same way (process/slices/S-31.md 赤の証跡: with the
 * fire's light dark, the bloom brightened 1.3% of the disc about the mouth, mean gain 0.003, on both paths): about the
 * mouth at least a tenth of the pixels brightened and a mean gain of at least 0.01 (three times S-30's), but under 0.08
 * (少し: the bloom does not wash over the mouth); away from the fire, the mean gain stays under 0.01.
 */
const LIMITS = { brightened: 0.1, mean: 0.01, meanMax: 0.08, away: 0.01 };

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
 * Opens a fixed view the way S-24, S-27 and S-30 take it (mid quality, no dynamic resolution, no hint), with ?debug=1, and
 * keeps the camera the room draws with (to put world points on the screen). `S31_QUERY` adds switches for looking into
 * something by hand; the recorded runs leave it empty.
 */
async function openView(page: Page, spawn: string, webgl: string, query = ''): Promise<void> {
  const extra = process.env.S31_QUERY ?? '';
  await page.goto(
    `/?scene=prologue-proto&direct=1&spawn=${spawn}&peekHold=0&quality=mid&dynres=0&debug=1${webgl}${query}${extra}`,
  );
  await waitRoom(page, 'r.ready && r.playing && r.workshop && r.workshop.loaded');
  await page.evaluate((furnace) => {
    const w = window as unknown as { __s31Camera?: unknown; __s31Scene?: unknown };
    const renderer = window.__vidroDebug?.renderer as unknown as {
      render: (...args: unknown[]) => unknown;
    };
    if (!renderer) throw new Error('no __vidroDebug.renderer (debug=1)');
    const render = renderer.render;
    renderer.render = (...args: unknown[]) => {
      const s = args[0] as { isScene?: boolean };
      const camera = args[1] as { isPerspectiveCamera?: boolean } | undefined;
      if (s?.isScene && !w.__s31Camera && camera?.isPerspectiveCamera) {
        let found = false;
        (s as { traverse(f: (o: { userData: { name?: string } }) => void): void }).traverse((o) => {
          if (o.userData?.name === furnace) found = true;
        });
        if (found) {
          w.__s31Camera = camera;
          w.__s31Scene = s;
        }
      }
      return render.apply(renderer, args);
    };
  }, WORKSHOP_OBJECTS.furnace.name);
  await page.waitForFunction(() => !!(window as unknown as { __s31Camera?: unknown }).__s31Camera);
  await page.waitForTimeout(1_200);
}

/**
 * Darkens the fire's light (room-art.ts: the one warm spot light, low at the furnace's mouth; its breathing sets only the
 * intensity, so a black colour stays dark and changes no shader). Returns how many lights it darkened.
 */
async function darkenFireLight(page: Page): Promise<number> {
  const n = await page.evaluate(() => {
    interface L {
      isSpotLight?: boolean;
      color: { r: number; g: number; b: number; setRGB(r: number, g: number, b: number): void };
      matrixWorld: { elements: number[] };
    }
    const scene = (window as unknown as { __s31Scene: { traverse(f: (o: L) => void): void } }).__s31Scene;
    let count = 0;
    scene.traverse((o) => {
      if (!o.isSpotLight) return;
      const y = o.matrixWorld.elements[13] ?? 0;
      // warm (red over blue) and low: the fire, not the skylight's cool spot under the dome's top
      if (o.color.r > o.color.b && y < 1.5) {
        o.color.setRGB(0, 0, 0);
        count++;
      }
    });
    return count;
  });
  await page.waitForTimeout(400);
  return n;
}

/** World points (three's coordinates) on the screen, with the camera the room drew with (CSS pixels). */
async function project(page: Page, points: [number, number, number][]): Promise<[number, number][]> {
  return page.evaluate((points) => {
    const cam = (
      window as unknown as {
        __s31Camera: { matrixWorldInverse: { elements: number[] }; projectionMatrix: { elements: number[] } };
      }
    ).__s31Camera;
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

/** The mouth's opening on the screen, `scale` times its radius. */
async function mouthDisc(page: Page, scale: number): Promise<Circle> {
  const [fx, fz] = FURNACE_FACING;
  const c: [number, number, number] = [
    FURNACE_MOUTH[0] + fx * OPENING.reach,
    FURNACE_MOUTH[1],
    FURNACE_MOUTH[2] + fz * OPENING.reach,
  ];
  const [centre, edge] = await project(page, [c, [c[0], c[1] + OPENING.radius, c[2]]]);
  if (!centre || !edge) throw new Error('the mouth was not projected');
  return { cx: centre[0], cy: centre[1], r: Math.hypot(edge[0] - centre[0], edge[1] - centre[1]) * scale };
}

/** The hand orb on the screen now, a little enlarged (it refracts what is behind it and sways). */
async function handOrb(page: Page): Promise<Circle[]> {
  const o = (await room(page)).orbScreen;
  if (!o.visible) return [];
  return [{ cx: o.x * 1280, cy: o.y * 720, r: o.r * 720 * 1.12 + 10 }];
}

/** Two pictures of the view as it is, and where the hand orb was in either. */
async function twoShots(page: Page): Promise<{ a: Buffer; b: Buffer; orb: Circle[] }> {
  const orb = await handOrb(page);
  const a = await page.screenshot();
  await page.waitForTimeout(400);
  orb.push(...(await handOrb(page)));
  const b = await page.screenshot();
  orb.push(...(await handOrb(page)));
  return { a, b, orb };
}

/** What the bloom adds within `disc`: `on` and `off` are two pictures each, with and without it. */
async function glowIn(
  page: Page,
  on: { a: Buffer; b: Buffer },
  off: { a: Buffer; b: Buffer },
  disc: Circle,
  leaveOut: Circle[],
): Promise<Glow> {
  return page.evaluate(
    async ({ shots, disc, leaveOut, gain }) => {
      const pixels = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const g = cv.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { data: g.getImageData(0, 0, bmp.width, bmp.height).data, width: bmp.width };
      };
      const [onA, onB, offA, offB] = await Promise.all(shots.map(pixels));
      if (!onA || !onB || !offA || !offB) throw new Error('missing a picture');
      const width = onA.width;
      const k = width / innerWidth;
      const lum = (d: Uint8ClampedArray, i: number) =>
        (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      const diff = (p: Uint8ClampedArray, q: Uint8ClampedArray, i: number): number =>
        Math.max(
          Math.abs((p[i] ?? 0) - (q[i] ?? 0)),
          Math.abs((p[i + 1] ?? 0) - (q[i + 1] ?? 0)),
          Math.abs((p[i + 2] ?? 0) - (q[i + 2] ?? 0)),
        );
      const gains: number[] = [];
      let inDisc = 0;
      let unsteady = 0;
      const x0 = Math.max(0, Math.floor((disc.cx - disc.r) * k));
      const x1 = Math.min(width - 1, Math.ceil((disc.cx + disc.r) * k));
      const rows = onA.data.length / 4 / width;
      const y0 = Math.max(0, Math.floor((disc.cy - disc.r) * k));
      const y1 = Math.min(rows - 1, Math.ceil((disc.cy + disc.r) * k));
      for (let py = y0; py <= y1; py++)
        for (let px = x0; px <= x1; px++) {
          const x = px / k;
          const y = py / k;
          if (Math.hypot(x - disc.cx, y - disc.cy) > disc.r) continue;
          if (leaveOut.some((o) => Math.hypot(x - o.cx, y - o.cy) <= o.r)) continue;
          inDisc++;
          const i = (py * width + px) * 4;
          if (diff(onA.data, onB.data, i) > 6 || diff(offA.data, offB.data, i) > 6) {
            unsteady++;
            continue;
          }
          gains.push((lum(onA.data, i) + lum(onB.data, i) - lum(offA.data, i) - lum(offB.data, i)) / 2);
        }
      gains.sort((a, b) => a - b);
      const n = Math.max(1, gains.length);
      return {
        pixels: gains.length,
        unsteady: unsteady / Math.max(1, inDisc),
        mean: gains.reduce((s, g) => s + g, 0) / n,
        brightened: gains.filter((g) => g > gain).length / n,
        p95: gains[Math.floor(gains.length * 0.95)] ?? 0,
      };
    },
    {
      shots: [on.a, on.b, off.a, off.b].map((b) => b.toString('base64')),
      disc,
      leaveOut,
      gain: GAIN,
    },
  );
}

/** Before | after side by side, one row per view (PNG). */
async function sideBySide(page: Page, rows: { name: string; a: string; b: string }[]): Promise<Buffer> {
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
    g.fillText('S-30 (before)', 12, 24);
    g.fillText('S-31 (after)', W + gap + 12, 24);
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
    for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return btoa(s);
  }, rows);
  return Buffer.from(b64, 'base64');
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-31', backend);
  const outDir = join(root, 'artifacts/S-31');
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

  test(`S-31 the four fixed views (${phase}) inside the budget; before | after side by side [${backend}]`, async ({
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
    const shot = (p: string, name: string) => join(shotDir, p, `${name}.png`);
    if (phase === 'after' && VIEWS.every(([, name]) => existsSync(shot('before', name)))) {
      const row = (name: string) => ({
        name,
        a: readFileSync(shot('before', name)).toString('base64'),
        b: readFileSync(shot('after', name)).toString('base64'),
      });
      writeFileSync(
        join(shotDir, 'compare.png'),
        await sideBySide(
          page,
          VIEWS.map(([, name]) => row(name)),
        ),
      );
      writeFileSync(
        join(shotDir, 'compare-furnace.png'),
        await sideBySide(page, [row('furnace'), row('door')]),
      );
    }
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-31 the fire's core blooms a little about the mouth, and nothing else does (炉の前) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    // without the bloom (S-17's finish=aa: AgX and the anti-aliasing only), then the game's finishing
    await openView(page, 'furnace', webgl, '&finish=aa');
    expect(await darkenFireLight(page), "the fire's light").toBe(1);
    const off = await twoShots(page);
    await openView(page, 'furnace', webgl);
    expect(await darkenFireLight(page), "the fire's light").toBe(1);
    const on = await twoShots(page);
    const mouth = await mouthDisc(page, GLOW_DISC);
    // away from the fire: as big a disc, as far up the picture as it fits (the dawn sky and the glass of the dome)
    const away: Circle = { cx: 1280 - mouth.r - 8, cy: mouth.r + 8, r: mouth.r };
    const leaveOut = [...off.orb, ...on.orb];
    const near = await glowIn(page, on, off, mouth, leaveOut);
    const far = await glowIn(page, on, off, away, leaveOut);
    keep('glow', { mouth: near, away: far, disc: mouth, awayDisc: away });
    expect(near.pixels, 'the mouth is on the screen').toBeGreaterThan(3_000);
    expect(near.unsteady, 'pixels about the mouth left out as unsteady').toBeLessThan(0.3);
    expect(near.brightened, 'share of the mouth brightened by the bloom').toBeGreaterThan(LIMITS.brightened);
    expect(near.mean, 'mean gain about the mouth').toBeGreaterThan(LIMITS.mean);
    expect(near.mean, 'mean gain about the mouth (a little)').toBeLessThan(LIMITS.meanMax);
    expect(Math.abs(far.mean), 'mean gain away from the fire').toBeLessThan(LIMITS.away);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
