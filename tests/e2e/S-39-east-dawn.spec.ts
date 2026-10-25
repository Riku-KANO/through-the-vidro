import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-39: east to the dawn (発案者 2026-10-25; 設計書 rev 49), on both render paths.
 *  1. 玉のささやき with real input: left behind on its pedestal, the vidro whispers — a small glass ring from where it stands —
 *     the moment it starts calling (you push on at the film), and again after a gap while it keeps calling; the whisper is
 *     on its own bus (never on the room's event log: S-16's table of sounds), counted apart from the cues
 *  2. the film at the slope's entrance is milky frosted glass (UI と同じ乳白の曇りガラス), not rainbow: shown and hidden in the
 *     same view, what it adds over the scene keeps one hue across the arch (a thin film's colours would swing round)
 *  3. one lighthouse: the old town's branch in room-art.ts is gone (S-35 提案3): on the plaza's axis stand the five bubbles
 *     and the one great orb plaza.ts builds, no second tower
 * The east and west turned round are checked by layout.test.ts (the dawn and the chimney on the same side), and seen in
 * S-35's three views (artifacts/screens/S-35/<backend>/), taken again by its own e2e.
 * Screens → artifacts/screens/S-39/<backend>/, the runs → artifacts/S-39/.
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
type P3 = [number, number, number];
interface RoomProbe {
  ready: boolean;
  playing: boolean;
  time: number;
  position: V3;
  grounded: boolean;
  speed: number;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  fov: number;
  locked: boolean;
  orb: 'bench' | 'hand' | 'pedestal';
  events: string[];
  finale: { events: string[]; gateOpen: boolean };
  membrane: { holding: boolean; film: number; call: number; whispers: number[] };
  layout: {
    pedestalOrb: P3;
    gateZ: number;
    membraneZ: number;
    plaza: { center: P3; radius: number };
    lighthouseTop: P3;
  };
}
interface SoundProbe {
  state: string;
  playedCount: number;
  voicesStarted: number;
  engineVoices: number;
  whisper: {
    ready: boolean;
    played: { at: P3; distance: number; time: number }[];
    refused: string[];
    voicesStarted: number;
  };
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
/** S-03 mouse sensitivity (rad per pixel). */
const SENSITIVITY = 0.0022;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** session.ts WHISPER_GAP_SECONDS (仮). */
const WHISPER_GAP = 3.2;

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
const sound = (page: Page): Promise<SoundProbe> =>
  page.evaluate(() => {
    const s = (window.__vidro.sceneProbe as { sound: SoundProbe }).sound;
    return {
      state: s.state,
      playedCount: s.playedCount,
      voicesStarted: s.voicesStarted,
      engineVoices: s.engineVoices,
      whisper: s.whisper,
    };
  });

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<RoomProbe> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return room(page);
}

async function waitSound(page: Page, fn: string, timeout = 30_000): Promise<SoundProbe> {
  await page.waitForFunction(
    `(() => { try { const s = window.__vidro?.sceneProbe?.sound; return !!s && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return sound(page);
}

/** Mouse position, tracked so look moves are relative (the page is pointer-locked). */
const cursor = { x: 640, y: 360 };

async function look(page: Page, dYaw: number, dPitch: number): Promise<void> {
  const dx = -dYaw / SENSITIVITY;
  const dy = -dPitch / SENSITIVITY;
  const steps = Math.max(2, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 60));
  cursor.x += dx;
  cursor.y += dy;
  await page.mouse.move(cursor.x, cursor.y, { steps });
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Turns the view (mouse) until it looks at `p` (world point). */
async function lookAt(page: Page, p: P3): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const r = await room(page);
    const eye = { x: r.position.x, y: r.position.y + r.eyeHeight, z: r.position.z };
    const dx = p[0] - eye.x;
    const dy = p[1] - eye.y;
    const dz = p[2] - eye.z;
    const dYaw = wrap(Math.atan2(-dx, -dz) - r.yaw);
    const dPitch = Math.atan2(dy, Math.hypot(dx, dz)) - r.pitch;
    if (Math.abs(dYaw) < 0.01 && Math.abs(dPitch) < 0.01) return;
    await look(page, dYaw, dPitch);
    await page.waitForTimeout(60);
  }
}

/** The first click: pointer lock, and (direct mode) the room's own audio made inside that gesture. */
async function lock(page: Page): Promise<void> {
  cursor.x = 640;
  cursor.y = 360;
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.down();
  await page.mouse.up();
  await waitRoom(page, 'r.locked === true');
}

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** World points on the screen (the room's camera from its probe; three's frame), clipped to the page: their box. */
function screenBox(r: RoomProbe, points: P3[]): Region {
  const W = 1280;
  const H = 720;
  const e = [r.position.x, r.position.y + r.eyeHeight, r.position.z];
  const cp = Math.cos(r.pitch);
  const f = [-Math.sin(r.yaw) * cp, Math.sin(r.pitch), -Math.cos(r.yaw) * cp];
  const right = [Math.cos(r.yaw), 0, -Math.sin(r.yaw)];
  const up = [
    (right[1] ?? 0) * (f[2] ?? 0) - (right[2] ?? 0) * (f[1] ?? 0),
    (right[2] ?? 0) * (f[0] ?? 0) - (right[0] ?? 0) * (f[2] ?? 0),
    (right[0] ?? 0) * (f[1] ?? 0) - (right[1] ?? 0) * (f[0] ?? 0),
  ];
  const t = Math.tan((r.fov * Math.PI) / 180 / 2);
  const dot = (a: number[], b: number[]) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  let x0 = W;
  let y0 = H;
  let x1 = 0;
  let y1 = 0;
  for (const p of points) {
    const d = [p[0] - (e[0] ?? 0), p[1] - (e[1] ?? 0), p[2] - (e[2] ?? 0)];
    const depth = dot(d, f);
    if (depth <= 0.05) continue;
    const sx = (dot(d, right) / depth / (t * (W / H)) / 2 + 0.5) * W;
    const sy = (0.5 - dot(d, up) / depth / t / 2) * H;
    x0 = Math.min(x0, sx);
    y0 = Math.min(y0, sy);
    x1 = Math.max(x1, sx);
    y1 = Math.max(y1, sy);
  }
  return {
    x0: Math.max(0, Math.floor(x0)),
    y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(W, Math.ceil(x1)),
    y1: Math.min(H, Math.ceil(y1)),
  };
}

/**
 * What a thing adds over the scene in `region`, from two PNGs of the same view with it shown (a) and hidden (b):
 *  - shown: the share of the pixels it brightens by more than 0.015 of luminance
 *  - spread: how far the colour of what it adds swings across them — each pixel's added colour as chromaticity
 *    (r, g, b over their sum, for the pixels it brightens by more than 0.03), and the mean distance from their mean. One
 *    milky white over the scene keeps one hue (what it adds only follows the background a little); a thin film's colours
 *    swing round the hue circle
 *  - added: the mean added colour (0..1 sRGB) of those pixels
 */
async function addedColour(
  page: Page,
  a: Buffer,
  b: Buffer,
  region: Region,
): Promise<{ shown: number; spread: number; added: [number, number, number]; counted: number }> {
  return page.evaluate(
    async ([a64, b64, reg]) => {
      const pixels = async (src: string) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${src}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no 2d context');
        g.drawImage(bmp, 0, 0);
        return { w: bmp.width, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const A = await pixels(a64 as string);
      const B = await pixels(b64 as string);
      const r = reg as { x0: number; y0: number; x1: number; y1: number };
      let n = 0;
      let shown = 0;
      const chroma: [number, number, number][] = [];
      const sum = [0, 0, 0];
      for (let y = r.y0; y < r.y1; y += 2)
        for (let x = r.x0; x < r.x1; x += 2) {
          const i = (y * A.w + x) * 4;
          n++;
          const d = [0, 1, 2].map((k) => ((A.d[i + k] ?? 0) - (B.d[i + k] ?? 0)) / 255) as [
            number,
            number,
            number,
          ];
          const l = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
          if (l > 0.015) shown++;
          if (l > 0.03 && d[0] > 0 && d[1] > 0 && d[2] > 0) {
            const s = d[0] + d[1] + d[2];
            chroma.push([d[0] / s, d[1] / s, d[2] / s]);
            for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + (d[k] ?? 0);
          }
        }
      const m = [0, 1, 2].map((k) => chroma.reduce((t, c) => t + (c[k] ?? 0), 0) / Math.max(1, chroma.length));
      const spread =
        chroma.reduce(
          (t, c) => t + Math.hypot((c[0] ?? 0) - (m[0] ?? 0), (c[1] ?? 0) - (m[1] ?? 0), (c[2] ?? 0) - (m[2] ?? 0)),
          0,
        ) / Math.max(1, chroma.length);
      const added = [0, 1, 2].map((k) => (sum[k] ?? 0) / Math.max(1, chroma.length)) as [number, number, number];
      return { shown: n > 0 ? shown / n : 0, spread, added, counted: chroma.length };
    },
    [a.toString('base64'), b.toString('base64'), region] as const,
  );
}

/** Keeps the scene the room draws (debug=1: the renderer's render is wrapped; further wrappers call on with apply). */
async function catchScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __s39Scene?: unknown };
    const renderer = window.__vidroDebug?.renderer as unknown as {
      render: (...args: unknown[]) => unknown;
    };
    if (!renderer) throw new Error('no __vidroDebug.renderer (debug=1)');
    const render = renderer.render;
    renderer.render = (...args: unknown[]) => {
      const s = args[0] as { isScene?: boolean; getObjectByName?: (n: string) => unknown };
      if (s?.isScene && !w.__s39Scene && s.getObjectByName?.('slope-film')) w.__s39Scene = s;
      return render.apply(renderer, args);
    };
  });
  await page.waitForFunction(() => !!(window as unknown as { __s39Scene?: unknown }).__s39Scene);
}

/** Shows or hides the film in the gate's arch (the slope's entrance) in the scene the room draws. */
async function showFilm(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((v) => {
    const s = (window as unknown as { __s39Scene: { getObjectByName(n: string): { visible: boolean } | undefined } })
      .__s39Scene;
    const film = s.getObjectByName('slope-film');
    if (!film) throw new Error('no slope-film');
    film.visible = v;
  }, visible);
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const shotDir = join(root, 'artifacts/screens/S-39', backend);

  test(`S-39 the vidro's whisper: pushing on at the film, it rings faintly from its pedestal, again after a gap; on its own bus [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    mkdirSync(join(root, 'artifacts/S-39'), { recursive: true });
    const errors = collectErrors(page);
    // held at the film after the close, the vidro left on its pedestal
    await page.goto(`/?scene=prologue-proto&spawn=film&finaleHold=4.5${webgl}`);
    const start = await waitRoom(
      page,
      "r.ready && r.playing && r.orb === 'pedestal' && r.membrane.film === 1",
      60_000,
    );
    const { membraneZ, pedestalOrb } = start.layout;
    expect(start.membrane.holding).toBe(true);
    // the first click makes the room's audio (direct mode); its sounds are made a little at a time
    await lock(page);
    const ready = await waitSound(page, "s.state === 'running' && s.whisper.ready", 40_000);
    expect(ready.whisper.played).toEqual([]);
    // standing at the film, not pushing: quiet
    await page.waitForTimeout(600);
    const still = await room(page);
    expect(still.membrane.call).toBe(0);
    expect(still.membrane.whispers).toEqual([]);

    // turn straight back from the film and push on backwards into it (S): it calls, and whispers with it
    await lookAt(page, [still.position.x, 1.4, still.position.z + 30]);
    const pressedAt = (await room(page)).time;
    await page.keyboard.down('KeyS');
    const first = await waitRoom(page, 'r.membrane.whispers.length >= 1', 4_000);
    await page.keyboard.up('KeyS');
    expect(first.membrane.call).toBeGreaterThan(0);
    expect(first.position.z).toBeGreaterThan(membraneZ);
    const [t1] = first.membrane.whispers;
    expect(t1 ?? 0).toBeGreaterThanOrEqual(pressedAt);
    // it sounded, from the vidro on its pedestal
    const s1 = await sound(page);
    expect(s1.whisper.played).toHaveLength(1);
    const p1 = s1.whisper.played[0];
    for (let k = 0; k < 3; k++) expect(p1?.at[k]).toBeCloseTo(pedestalOrb[k] ?? 0, 3);
    expect(p1?.distance ?? 0).toBeGreaterThan(5);
    expect(p1?.distance ?? 99).toBeLessThan(9);

    // let go and turn round to look for it: it keeps calling, and whispers again — the gap apart, not sooner
    await lookAt(page, pedestalOrb);
    const second = await waitRoom(page, 'r.membrane.whispers.length >= 2', (WHISPER_GAP + 3) * 1000);
    expect(second.membrane.call).toBeGreaterThan(0.95);
    const [a = 0, b = 0] = second.membrane.whispers;
    expect(b - a).toBeGreaterThanOrEqual(WHISPER_GAP - 0.05);
    expect(b - a).toBeLessThan(WHISPER_GAP + 0.3);

    // a step back from the film toward it: quiet, and no more whispers
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(800);
    await page.keyboard.up('KeyW');
    const away = await waitRoom(page, 'r.membrane.call === 0', 5_000);
    expect(away.position.z - membraneZ).toBeGreaterThan(0.9);
    const n = away.membrane.whispers.length;
    await page.waitForTimeout((WHISPER_GAP + 0.6) * 1000);
    const later = await room(page);
    expect(later.membrane.whispers).toHaveLength(n);

    const s = await sound(page);
    writeFileSync(
      join(root, `artifacts/S-39/whisper-${backend}.json`),
      JSON.stringify({ backend, whispers: later.membrane.whispers, sound: s, events: later.events, errors }, null, 2),
    );
    // every whisper sounded, and on its own: none refused, one voice each; the cues are still S-16's table's
    expect(s.state).toBe('running');
    expect(s.whisper.played).toHaveLength(n);
    expect(s.whisper.refused).toEqual([]);
    expect(s.whisper.voicesStarted).toBe(n);
    expect(s.voicesStarted).toBe(s.playedCount);
    // never on the room's event log, nor on the close's
    for (const e of later.events) expect(e).not.toMatch(/whisper/);
    for (const e of later.finale.events) expect(e).not.toMatch(/whisper/);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-39 the film in the gate is milky frosted glass: shown and hidden in the same view, what it adds keeps one hue [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(join(root, 'artifacts/S-39'), { recursive: true });
    const errors = collectErrors(page);
    // the close played out (the gate open), the vidro left on the pedestal: on the far shore before the gate, the film up
    await page.goto(
      `/?scene=prologue-proto&spawn=gate&finaleHold=4.5&quality=mid&dynres=0&debug=1${webgl}`,
    );
    const start = await waitRoom(
      page,
      "r.ready && r.playing && r.orb === 'pedestal' && r.membrane.film === 1",
      60_000,
    );
    await catchScene(page);
    const { gateZ } = start.layout;
    await lock(page);
    await lookAt(page, [0, 1.35, gateZ]);
    await page.waitForTimeout(600);
    const r = await room(page);
    const shown = await page.screenshot({ path: join(shotDir, 'film.png') });
    await showFilm(page, false);
    await page.waitForTimeout(300);
    const hidden = await page.screenshot({ path: join(shotDir, 'film-hidden.png') });
    await showFilm(page, true);
    // inside the arch (its posts at ±1.4 m, its top at 2.7 m), a little in from the brass
    const arch = screenBox(r, [
      [-1.15, 0.15, gateZ],
      [1.15, 0.15, gateZ],
      [-1.15, 2.2, gateZ],
      [1.15, 2.2, gateZ],
    ]);
    expect(arch.x1 - arch.x0).toBeGreaterThan(200);
    const film = await addedColour(page, shown, hidden, arch);
    writeFileSync(
      join(root, `artifacts/S-39/film-${backend}.json`),
      JSON.stringify({ backend, arch, film, errors }, null, 2),
    );
    // it is there: a veil over most of the arch
    expect(film.shown, 'share of the arch the film lightens').toBeGreaterThan(0.5);
    expect(film.counted).toBeGreaterThan(200);
    // one milky hue across it: no thin film's colours swinging round
    expect(film.spread, 'how far the hue of what the film adds swings').toBeLessThan(0.03);
    // and pale: what it adds has no strong cast (its channels within a third of each other)
    const [ar, ag, ab] = film.added;
    expect(Math.min(ar, ag, ab)).toBeGreaterThan(Math.max(ar, ag, ab) * 0.66);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-39 one lighthouse: on the plaza's axis only the five bubbles and the great orb plaza.ts builds (S-35 提案3) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.goto(
      `/?scene=prologue-proto&spawn=plaza&finaleHold=4.5&finaleOrb=hand&quality=mid&dynres=0&debug=1${webgl}`,
    );
    const r = await waitRoom(page, "r.ready === true && r.orb === 'hand'", 60_000);
    await catchScene(page);
    const [cx, floorY, cz] = r.layout.plaza.center;
    const census = await page.evaluate(
      ([ax, ay, az]) => {
        type M4 = { elements: number[] };
        type Obj = {
          visible: boolean;
          isMesh?: boolean;
          isInstancedMesh?: boolean;
          count: number;
          matrixWorld: M4;
          geometry: {
            boundingSphere: { center: { x: number; y: number; z: number }; radius: number } | null;
            computeBoundingSphere(): void;
          };
          instanceMatrix: { array: ArrayLike<number> };
          traverseVisible(f: (o: Obj) => void): void;
          updateMatrixWorld(force?: boolean): void;
        };
        const s = (window as unknown as { __s39Scene: Obj }).__s39Scene;
        s.updateMatrixWorld(true);
        const apply = (e: number[], x: number, y: number, z: number): [number, number, number] => [
          (e[0] ?? 0) * x + (e[4] ?? 0) * y + (e[8] ?? 0) * z + (e[12] ?? 0),
          (e[1] ?? 0) * x + (e[5] ?? 0) * y + (e[9] ?? 0) * z + (e[13] ?? 0),
          (e[2] ?? 0) * x + (e[6] ?? 0) * y + (e[10] ?? 0) * z + (e[14] ?? 0),
        ];
        const scaleOf = (e: number[]): number =>
          Math.max(
            Math.hypot(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0),
            Math.hypot(e[4] ?? 0, e[5] ?? 0, e[6] ?? 0),
            Math.hypot(e[8] ?? 0, e[9] ?? 0, e[10] ?? 0),
          );
        let bubbles = 0;
        let orbs = 0;
        const onAxis: number[] = [];
        const high: [number, number][] = [];
        s.traverseVisible((o) => {
          if (!o.isMesh) return;
          if (o.isInstancedMesh) {
            const a = o.instanceMatrix.array;
            for (let i = 0; i < o.count; i++) {
              const p = apply(o.matrixWorld.elements, a[i * 16 + 12] ?? 0, a[i * 16 + 13] ?? 0, a[i * 16 + 14] ?? 0);
              if (Math.hypot(p[0] - ax, p[2] - az) < 0.5 && p[1] > ay - 1) {
                bubbles++;
                onAxis.push(Math.round((p[1] - ay) * 10) / 10);
              }
            }
            return;
          }
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          const b = o.geometry.boundingSphere;
          if (!b) return;
          const e = o.matrixWorld.elements;
          const c = apply(e, b.center.x, b.center.y, b.center.z);
          const radius = b.radius * scaleOf(e);
          if (Math.hypot(c[0] - ax, c[2] - az) < 1.5 && c[1] > ay + 25 && radius < 6) {
            orbs++;
            high.push([Math.round((c[1] - ay) * 10) / 10, Math.round(radius * 10) / 10]);
          }
        });
        return { bubbles, orbs, onAxis, high };
      },
      [cx, floorY, cz] as const,
    );
    mkdirSync(join(root, 'artifacts/S-39'), { recursive: true });
    writeFileSync(
      join(root, `artifacts/S-39/lighthouse-${backend}.json`),
      JSON.stringify({ backend, census, errors }, null, 2),
    );
    expect(census.bubbles, `bubbles on the axis at ${census.onAxis.join(', ')} m`).toBe(5);
    expect(census.orbs, 'great orbs at the top').toBe(1);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
