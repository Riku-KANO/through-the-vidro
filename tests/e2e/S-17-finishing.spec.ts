import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-17: the finishing of the prologue room (アートディレクション > 画面の仕上げ, 技術設計 > 1フレームの描画の流れ 6,
 * 品質プリセット). Behind PeekPipeline's composite: restrained bloom → AgX → the preset's FXAA/SMAA (stress's order).
 * The `finish` switch takes the chain apart, so the same frame can be compared with and without each step:
 *   finish=0   AgX only (the frame before S-17)      finish=aa   AgX → anti-aliasing, no bloom      (none) everything
 * Checked on the screenshots (sRGB luminance), on both render paths:
 *   - only strong lights and the light drop bleed: the vidro lit on its pedestal and the drop seen up close (both the
 *     target, so their glass lights up) get a halo, the rest of the frame barely changes, and what does brighten lies
 *     next to a bright source. The drop seen from the dead end (5 m, not the target) is recorded, not checked: it is
 *     drawn about as bright as the dawn sky there and hardly bleeds (process/slices/S-17.md 判断待ち1)
 *   - while peeking, the image inside the orb keeps its contrast (bloom does not wash it out)
 *   - anti-aliasing touches only a small share of the pixels and lowers the frame's total variation (edges), at mid
 *     (SMAA) and at low (FXAA)
 *   - layers-lab runs the same pipeline without errors, and its orb image keeps its contrast too
 * Screens → artifacts/screens/S-17/<backend>/<view>-<before|aa|after>.png (before/after the finishing, rest/peek),
 * numbers → artifacts/S-17/finishing-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface RoomProbe {
  ready: boolean;
  position: V3;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  fov: number;
  peekAmount: number;
  sphereRadius: number;
  dropMaterialized: boolean;
  drawCalls: number;
  triangles: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
  layout: { drop: [number, number, number]; pedestalOrb: [number, number, number] };
}
interface LabProbe {
  ready: boolean;
  peekAmount: number;
  orbScreen: { x: number; y: number; r: number; visible: boolean };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const BUDGET = { drawCalls: 300, triangles: 1_500_000 };
const W = 1280;
const H = 720;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;

type Mode = 'before' | 'aa' | 'after';
const MODES: Record<Mode, string> = { before: '&finish=0', aa: '&finish=aa', after: '' };

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

const roomProbe = (page: Page): Promise<RoomProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { room: RoomProbe }).room);

/** Screen position (px) of a world point, from the room's body pose (S-06's look convention). */
function project(r: RoomProbe, p: [number, number, number]): { x: number; y: number; depth: number } {
  const e = { x: r.position.x, y: r.position.y + r.eyeHeight, z: r.position.z };
  const d = [p[0] - e.x, p[1] - e.y, p[2] - e.z] as const;
  const [sy, cy, sp, cp] = [Math.sin(r.yaw), Math.cos(r.yaw), Math.sin(r.pitch), Math.cos(r.pitch)];
  const f = [-sy * cp, sp, -cy * cp];
  const right = [cy, 0, -sy];
  const up = [sp * sy, cp, sp * cy];
  const dot = (a: readonly number[], b: readonly number[]) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  const depth = dot(d, f);
  const tanY = Math.tan((r.fov * Math.PI) / 360);
  const tanX = tanY * (W / H);
  return {
    x: (0.5 + (0.5 * dot(d, right)) / (depth * tanX)) * W,
    y: (0.5 - (0.5 * dot(d, up)) / (depth * tanY)) * H,
    depth,
  };
}

/** project() with the point in front of the camera and inside the frame (40 px margin). */
function onScreen(r: RoomProbe, p: [number, number, number]): { x: number; y: number; depth: number } {
  const s = project(r, p);
  expect(s.depth).toBeGreaterThan(0);
  expect(s.x).toBeGreaterThan(40);
  expect(s.x).toBeLessThan(W - 40);
  expect(s.y).toBeGreaterThan(40);
  expect(s.y).toBeLessThan(H - 40);
  return s;
}

/** Between the half-width and the half-height of the drop's glass (room-art.ts: about 0.1 m wide, 0.24 m tall). */
const DROP_RADIUS = 0.09;

/** The ring just outside the drop's glass on screen: 1.3 to 2.5 times its projected radius. */
function dropRing(r: RoomProbe, at: { x: number; y: number; depth: number }): Region {
  const px = (DROP_RADIUS / at.depth / Math.tan((r.fov * Math.PI) / 360)) * (H / 2);
  return { x: at.x, y: at.y, r0: px * 1.3, r1: px * 2.5 };
}

interface Region {
  /** Centre and radii in screenshot pixels. */
  x: number;
  y: number;
  r0: number;
  r1: number;
}
interface Compared {
  /** Mean luminance change b − a over the region (annulus r0..r1). */
  ringGain: number | null;
  /** Inside the circle r1: mean and standard deviation of the luminance, share of near-white pixels. */
  inside: { meanA: number; meanB: number; stdA: number; stdB: number; whiteA: number; whiteB: number } | null;
  /** Share of the frame brightened by more than 4/255, and the 90th percentile of the change. */
  brightened: number;
  p90: number;
  /** Share of the brightened pixels within 48 px of a bright source of image a (luminance ≥ 0.75). */
  nearSource: number;
  /** Share of the frame changed by more than 2/255 either way. */
  changed: number;
  /** Total variation (mean absolute difference to the right and lower neighbour) of a and b. */
  tvA: number;
  tvB: number;
}

/** Compares two screenshots of the same view in the browser (decoding PNGs there, as S-06's e2e does). */
async function compare(page: Page, a: Buffer, b: Buffer, region: Region | null): Promise<Compared> {
  return page.evaluate(
    async ({ a64, b64, region }) => {
      const lum = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const out = new Float32Array(bmp.width * bmp.height);
        for (let i = 0; i < out.length; i++) {
          out[i] =
            (0.2126 * (d[i * 4] ?? 0) + 0.7152 * (d[i * 4 + 1] ?? 0) + 0.0722 * (d[i * 4 + 2] ?? 0)) / 255;
        }
        return { l: out, w: bmp.width, h: bmp.height };
      };
      const A = await lum(a64);
      const B = await lum(b64);
      const { w, h } = A;
      const n = w * h;
      // bright sources of image a, on a grid of 8 px cells dilated by 48 px
      const cell = 8;
      const gw = Math.ceil(w / cell);
      const gh = Math.ceil(h / cell);
      const src = new Uint8Array(gw * gh);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if ((A.l[y * w + x] ?? 0) >= 0.75) src[((y / cell) | 0) * gw + ((x / cell) | 0)] = 1;
      const reach = 48 / cell;
      const near = new Uint8Array(gw * gh);
      for (let gy = 0; gy < gh; gy++)
        for (let gx = 0; gx < gw; gx++) {
          if (!src[gy * gw + gx]) continue;
          for (let oy = -reach; oy <= reach; oy++)
            for (let ox = -reach; ox <= reach; ox++) {
              const yy = gy + oy;
              const xx = gx + ox;
              if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) near[yy * gw + xx] = 1;
            }
        }
      let brightened = 0;
      let brightNear = 0;
      let changed = 0;
      let tvA = 0;
      let tvB = 0;
      const diffs = new Float32Array(n);
      let ringSum = 0;
      let ringN = 0;
      let inN = 0;
      let sA = 0;
      let sB = 0;
      let qA = 0;
      let qB = 0;
      let wA = 0;
      let wB = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const la = A.l[i] ?? 0;
          const lb = B.l[i] ?? 0;
          const d = lb - la;
          diffs[i] = d;
          if (d > 4 / 255) {
            brightened++;
            if (near[((y / cell) | 0) * gw + ((x / cell) | 0)]) brightNear++;
          }
          if (Math.abs(d) > 2 / 255) changed++;
          if (x + 1 < w) {
            tvA += Math.abs((A.l[i + 1] ?? 0) - la);
            tvB += Math.abs((B.l[i + 1] ?? 0) - lb);
          }
          if (y + 1 < h) {
            tvA += Math.abs((A.l[i + w] ?? 0) - la);
            tvB += Math.abs((B.l[i + w] ?? 0) - lb);
          }
          if (region) {
            const dist = Math.hypot(x - region.x, y - region.y);
            if (dist >= region.r0 && dist <= region.r1) {
              ringSum += d;
              ringN++;
            }
            if (dist <= region.r1) {
              inN++;
              sA += la;
              sB += lb;
              qA += la * la;
              qB += lb * lb;
              if (la > 0.92) wA++;
              if (lb > 0.92) wB++;
            }
          }
        }
      const sorted = diffs.sort();
      const mA = inN ? sA / inN : 0;
      const mB = inN ? sB / inN : 0;
      return {
        ringGain: region && ringN ? ringSum / ringN : null,
        inside:
          region && inN
            ? {
                meanA: mA,
                meanB: mB,
                stdA: Math.sqrt(Math.max(0, qA / inN - mA * mA)),
                stdB: Math.sqrt(Math.max(0, qB / inN - mB * mB)),
                whiteA: wA / inN,
                whiteB: wB / inN,
              }
            : null,
        brightened: brightened / n,
        p90: sorted[Math.floor(n * 0.9)] ?? 0,
        nearSource: brightened ? brightNear / brightened : 1,
        changed: changed / n,
        tvA: tvA / n,
        tvB: tvB / n,
      };
    },
    { a64: a.toString('base64'), b64: b.toString('base64'), region },
  );
}

/** Views of the room, each frozen with S-06's dev holds so the three finishing modes see the same frame. */
const VIEWS = {
  /** 覗く前: at the dead end, the vidro in hand, not peeking */
  rest: 'spawn=dead-end&peekHold=0',
  /** 覗いている: the back bridge, its lanterns and the drop through the orb */
  peek: 'spawn=dead-end&peekHold=1',
  /** the bridge materialized: the light drop and the lanterns in the frame itself */
  grown: 'spawn=dead-end&growHold=1',
  /** across the bridge, the light drop right ahead and the target (E 触れる) */
  near: 'spawn=far&growHold=1',
} as const;
type View = keyof typeof VIEWS;

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-17', backend);

  test(`S-17 prologue finishing: bloom only on strong lights, the orb image intact, AA [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-17'), { recursive: true });
    const errors = collectErrors(page);
    const shots = {} as Record<View, Record<Mode, Buffer>>;
    const probes = {} as Record<View, Record<Mode, RoomProbe>>;
    for (const view of Object.keys(VIEWS) as View[]) {
      shots[view] = {} as Record<Mode, Buffer>;
      probes[view] = {} as Record<Mode, RoomProbe>;
      for (const mode of Object.keys(MODES) as Mode[]) {
        await page.goto(`/?scene=prologue-proto&${VIEWS[view]}&dynres=0${MODES[mode]}${webgl}`);
        await page.waitForFunction(
          () =>
            (window.__vidro?.sceneProbe as { room?: { ready?: boolean } } | undefined)?.room?.ready === true,
          undefined,
          { timeout: 60_000 },
        );
        await page.waitForTimeout(800);
        shots[view][mode] = await page.screenshot({ path: join(shotDir, `${view}-${mode}.png`) });
        const r = await roomProbe(page);
        probes[view][mode] = r;
        expect(r.drawCalls, `draw calls in ${view}-${mode}`).toBeLessThanOrEqual(BUDGET.drawCalls);
        expect(r.triangles, `triangles in ${view}-${mode}`).toBeLessThanOrEqual(BUDGET.triangles);
      }
    }

    // the vidro on its pedestal, the target in this view (its rim lights up): where it is on screen
    const grown = probes.grown.after;
    const vidro = onScreen(grown, grown.layout.pedestalOrb);

    // bloom alone: AA-only vs everything; the ring just outside the vidro (≈ 25 px across at this distance)
    const bloomGrown = await compare(page, shots.grown.aa, shots.grown.after, {
      x: vidro.x,
      y: vidro.y,
      r0: 30,
      r1: 50,
    });
    // the light drop: up close (the target) and from the dead end (5 m), the ring just outside its glass
    const nearProbe = probes.near.after;
    expect(nearProbe.dropMaterialized, 'the drop is in the frame').toBe(true);
    const dropNear = onScreen(nearProbe, nearProbe.layout.drop);
    const dropFar = onScreen(grown, grown.layout.drop);
    const bloomNear = await compare(page, shots.near.aa, shots.near.after, dropRing(nearProbe, dropNear));
    const dropFarRing = (await compare(page, shots.grown.aa, shots.grown.after, dropRing(grown, dropFar)))
      .ringGain;
    const bloomRest = await compare(page, shots.rest.aa, shots.rest.after, null);
    const peek = probes.peek.after;
    expect(peek.peekAmount).toBe(1);
    expect(peek.orbScreen.visible).toBe(true);
    // the inner 85 % of the orb's circle (the rim is glass shading, not the image)
    const orbRegion = {
      x: peek.orbScreen.x * W,
      y: peek.orbScreen.y * H,
      r0: 0,
      r1: peek.orbScreen.r * H * 0.85,
    };
    const bloomPeek = await compare(page, shots.peek.aa, shots.peek.after, orbRegion);
    // anti-aliasing alone: before vs AA-only
    const aaRest = await compare(page, shots.rest.before, shots.rest.aa, null);
    const aaGrown = await compare(page, shots.grown.before, shots.grown.aa, null);

    const draws = (v: View) => ({
      before: probes[v].before.drawCalls,
      aa: probes[v].aa.drawCalls,
      after: probes[v].after.drawCalls,
    });
    // low quality: FXAA instead of SMAA, the same view without and with it
    const lowDraws: Record<'before' | 'aa', number> = { before: 0, aa: 0 };
    const lowShots = {} as Record<'before' | 'aa', Buffer>;
    for (const mode of ['before', 'aa'] as const) {
      await page.goto(`/?scene=prologue-proto&${VIEWS.rest}&dynres=0&quality=low${MODES[mode]}${webgl}`);
      await page.waitForFunction(
        () =>
          (window.__vidro?.sceneProbe as { room?: { ready?: boolean } } | undefined)?.room?.ready === true,
        undefined,
        { timeout: 60_000 },
      );
      await page.waitForTimeout(500);
      lowShots[mode] = await page.screenshot({ path: join(shotDir, `rest-low-${mode}.png`) });
      lowDraws[mode] = (await roomProbe(page)).drawCalls;
    }
    const aaLow = await compare(page, lowShots.before, lowShots.aa, null);
    const report = {
      vidro,
      dropNear,
      dropFar: { ...dropFar, ringGain: dropFarRing },
      bloomNear,
      bloomGrown,
      bloomRest,
      bloomPeek,
      aaRest,
      aaGrown,
      aaLow,
      draws: {
        rest: draws('rest'),
        peek: draws('peek'),
        grown: draws('grown'),
        near: draws('near'),
        restLow: lowDraws,
      },
    };
    writeFileSync(join(root, `artifacts/S-17/finishing-${backend}.json`), JSON.stringify(report, null, 2));

    // 強い光源と光の雫だけが滲む: the lit vidro and the drop up close get a visible halo …
    expect(bloomGrown.ringGain ?? 0, 'halo around the lit vidro').toBeGreaterThan(3 / 255);
    expect(bloomNear.ringGain ?? 0, 'halo around the light drop (up close)').toBeGreaterThan(3 / 255);
    // … the rest of the frame is left alone (控えめ) …
    for (const [name, c] of [
      ['grown', bloomGrown],
      ['near', bloomNear],
      ['rest', bloomRest],
      ['peek', bloomPeek],
    ] as const) {
      expect(c.brightened, `share of the frame brightened by bloom (${name})`).toBeLessThan(0.08);
      // 9 pixels in 10 lifted by less than ~1 % of the display range (below what a smooth gradient shows). A large
      // light up close (the drop, `near`) spreads its soft tail further: 2.3/255 there, 0.7–1.9/255 elsewhere
      expect(c.p90, `90th percentile of the bloom (${name})`).toBeLessThan(3 / 255);
      // … and what brightens is next to a bright source
      expect(c.nearSource, `brightened pixels next to a bright source (${name})`).toBeGreaterThan(0.85);
    }
    // 覗いている間も玉の中の像がブルームで潰れない
    const inside = bloomPeek.inside;
    expect(inside).not.toBeNull();
    if (inside) {
      expect(inside.stdB / inside.stdA, 'contrast inside the orb kept').toBeGreaterThan(0.9);
      expect(inside.meanB - inside.meanA, 'the orb image is not lifted').toBeLessThan(0.03);
      expect(inside.whiteB - inside.whiteA, 'no new near-white inside the orb').toBeLessThan(0.02);
    }
    // anti-aliasing: a small share of pixels (edges) changes and the edges get smoother
    for (const [name, c] of [
      ['rest', aaRest],
      ['grown', aaGrown],
      ['rest, low (FXAA)', aaLow],
    ] as const) {
      expect(c.changed, `share of pixels the AA touches (${name})`).toBeGreaterThan(0.002);
      expect(c.changed, `share of pixels the AA touches (${name})`).toBeLessThan(0.2);
      expect(c.tvB, `total variation after AA (${name})`).toBeLessThan(c.tvA * 0.99);
    }
    // wiring: the bloom and the anti-aliasing each add passes (the pass counts themselves are three's business)
    const d = draws('rest');
    expect(d.after).toBeGreaterThan(d.aa);
    expect(d.aa).toBeGreaterThan(d.before);
    expect(lowDraws.aa).toBeGreaterThan(lowDraws.before);

    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-17 layers-lab finishing: same pipeline, orb image intact [${backend}]`, async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(shotDir, { recursive: true });
    const errors = collectErrors(page);
    const shots = {} as Record<Mode, Buffer>;
    let probe: LabProbe | null = null;
    for (const mode of Object.keys(MODES) as Mode[]) {
      await page.goto(`/?scene=layers-lab&peek=hold&dynres=0${MODES[mode]}${webgl}`);
      await page.waitForFunction(
        () => {
          const p = window.__vidro?.sceneProbe as { ready?: boolean; peekAmount?: number } | undefined;
          return p?.ready === true && p.peekAmount === 1;
        },
        undefined,
        { timeout: 60_000 },
      );
      await page.waitForTimeout(500);
      shots[mode] = await page.screenshot({ path: join(shotDir, `layers-lab-peek-${mode}.png`) });
      probe = await page.evaluate(() => window.__vidro.sceneProbe as unknown as LabProbe);
    }
    if (!probe) throw new Error('no probe');
    const region = {
      x: probe.orbScreen.x * W,
      y: probe.orbScreen.y * H,
      r0: 0,
      r1: probe.orbScreen.r * H * 0.85,
    };
    const bloom = await compare(page, shots.aa, shots.after, region);
    const aa = await compare(page, shots.before, shots.aa, null);
    writeFileSync(
      join(root, `artifacts/S-17/layers-lab-${backend}.json`),
      JSON.stringify({ bloom, aa }, null, 2),
    );
    expect(bloom.brightened).toBeLessThan(0.08);
    expect(bloom.inside).not.toBeNull();
    if (bloom.inside) expect(bloom.inside.stdB / bloom.inside.stdA).toBeGreaterThan(0.9);
    // the peek blurs most of this view, so the AA finds few edges: it changes something and only smooths
    expect(aa.changed).toBeGreaterThan(0.0005);
    expect(aa.tvB).toBeLessThan(aa.tvA);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
