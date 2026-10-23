import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-38: the workshop's glass compiles while loading, not when the player first turns toward it.
 *
 * The stall (S-34 review P2-3): the scripted play (?autoplay=1) looks back from the far shore at the workshop, and the
 * transmissive glass wares on the dome's +Z side (A0_ware_anneal01, A0_ware_cart01 …) were drawn for the first time
 * there: three built their render pipelines in those frames, one per frame (the longest frame of the play: 36–52 ms on
 * WebGPU, 53–64 ms on WebGL2, a fresh browser each time; 195 ms on a busy GPU in S-34; process/slices/S-38.md 計測). The
 * loading's warm-up draw saw only what its pose (the miniature view) saw.
 *
 * A tracer installed before the page's script wraps the renderer's backend (?debug=1 publishes it) and notes every
 * render pipeline three creates, with where the game was: the autoplay step once playing, else the home's screen or
 * transition. Checked on both paths:
 *   - the script: after landing, no pipeline is made for anything whose material reads the backdrop (glass), none at all
 *     while looking back; the culprits got theirs while loading (so the test cannot pass by tracing nothing)
 *   - peeking all around right after landing (S-38 review round 2 P2-1): no pipeline for the glass, nor for the
 *     peek image's stand-ins that LayerField hangs under shared transmissive glass (drawn only in the peek image)
 *   - no console error or warning, nor a GPU validation message of another level
 * Pipelines by step, the longest frame of each step and the loading's steps go to artifacts/S-38/pipelines-<backend>.json,
 * those of the turn to artifacts/S-38/peek-around-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const BENIGN = /GPU stall|powerPreference/i;
/** As in S-06: WebGPU validation errors can arrive at any level and silently drop frames. */
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** S-03 mouse sensitivity (rad per pixel). */
const SENSITIVITY = 0.0022;
/** The workshop's glass first seen when looking back (S-34's trace; layout.ts WORKSHOP_OBJECTS annealerWares, cartWares). */
const LOOK_BACK_GLASS = ['A0_ware_anneal01', 'A0_ware_cart01'];

interface Made {
  /** 'game:<step>' once playing, else '<screen or transition>' ('loading' until the load is ready). */
  at: string;
  object: string;
  material: string;
  glass: boolean;
  /** The peek image's stand-in of a transmissive object (LayerField: `<name>:peek-stand-in`, drawn only there). */
  standIn: boolean;
  /** A full-screen pass of the finishing (three's QuadMesh), not a thing in the scene. */
  quad: boolean;
}
declare global {
  interface Window {
    __s38?: Made[];
  }
}

/** Runs in the page before its own script: wraps createRenderPipeline on the backend of the renderer main.ts publishes. */
function installTracer(): void {
  interface Material {
    name?: string;
    type?: string;
    useTransmission?: boolean;
    transmission?: number;
    transmissionNode?: unknown;
  }
  interface RenderObject {
    object?: {
      name?: string;
      type?: string;
      isQuadMesh?: boolean;
      userData?: { name?: string };
      parent?: unknown;
    };
    material?: Material;
  }
  interface Backend {
    createRenderPipeline(renderObject: RenderObject, promises?: unknown): unknown;
  }
  const made: Made[] = [];
  window.__s38 = made;
  // the same test as src/core/glass/backdrop.ts readsBackdrop
  const readsBackdrop = (m: Material | undefined): boolean => {
    if (!m) return false;
    if (typeof m.useTransmission === 'boolean') return m.useTransmission;
    return (m.transmission ?? 0) > 0 || (m.transmissionNode ?? null) !== null;
  };
  // a glb piece's mesh is a child of the named object (or the object itself)
  const named = (o: RenderObject['object']): string => {
    for (let p = o as { name?: string; userData?: { name?: string }; parent?: unknown } | undefined; p; ) {
      const n = p.userData?.name;
      if (typeof n === 'string' && /^A\d+_/.test(n)) return n;
      p = p.parent as typeof p;
    }
    return o?.name || o?.type || '?';
  };
  const where = (): string => {
    const p = window.__vidro?.sceneProbe as
      | {
          screen?: string;
          transition?: { id: string } | null;
          load?: { ready: boolean };
          room?: { playing: boolean; autoplay: { step: string } | null };
        }
      | undefined;
    if (p?.room?.playing && p.room.autoplay) return `game:${p.room.autoplay.step}`;
    if (p?.load && !p.load.ready) return 'loading';
    return p?.transition?.id ?? p?.screen ?? '?';
  };
  const install = (debug: { renderer: { backend: Backend } }): void => {
    const backend = debug.renderer.backend;
    const create = backend.createRenderPipeline;
    backend.createRenderPipeline = function (this: Backend, ro: RenderObject, promises?: unknown) {
      made.push({
        at: where(),
        object: named(ro.object),
        material: ro.material?.name || ro.material?.type || '?',
        glass: readsBackdrop(ro.material),
        standIn: /:peek-stand-in$/.test(ro.object?.name ?? ''),
        quad: ro.object?.isQuadMesh === true,
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

function collectConsole(page: Page): string[] {
  const seen: string[] = [];
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    if (BENIGN.test(text)) return;
    if (m.type() === 'error' || m.type() === 'warning' || GPU_VALIDATION.test(text))
      seen.push(`${m.type()}: ${text.slice(0, 300)}`);
  });
  return seen;
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';

  test(`S-38 the workshop's glass compiles while loading, not when looking back [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectConsole(page);
    await page.addInitScript(installTracer);
    await page.goto(`/?scene=prologue-proto&autoplay=1&debug=1${webgl}`);
    await page.waitForFunction(
      () => {
        const r = (
          window.__vidro?.sceneProbe as { room?: { autoplay?: { done: boolean }; dropTaken?: boolean } }
        )?.room;
        return !!r?.autoplay?.done && r.dropTaken === true;
      },
      undefined,
      { timeout: 120_000 },
    );
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
    const { made, load, steps } = await page.evaluate(() => {
      const p = window.__vidro.sceneProbe as {
        load: { seconds: number; steps: { name: string; seconds: number; maxFrameMs: number }[] };
        room: { autoplay: { steps: Record<string, number> } };
      };
      return { made: window.__s38 ?? [], load: p.load, steps: p.room.autoplay.steps };
    });

    const byStep: Record<string, { all: number; glass: number; scene: number }> = {};
    for (const m of made) {
      const s = byStep[m.at] ?? { all: 0, glass: 0, scene: 0 };
      byStep[m.at] = s;
      s.all++;
      if (m.glass) s.glass++;
      if (!m.quad) s.scene++;
    }
    const inPlay = made.filter((m) => m.at.startsWith('game:'));
    mkdirSync(join(root, 'artifacts/S-38'), { recursive: true });
    writeFileSync(
      join(root, `artifacts/S-38/pipelines-${backend}.json`),
      JSON.stringify(
        {
          backend,
          byStep,
          inPlay,
          worstFrameByStep: steps,
          loadSeconds: load.seconds,
          loadSteps: load.steps,
          errors,
        },
        null,
        2,
      ),
    );

    // the tracer saw the loading compile the scene, the pieces first seen when looking back among it
    const loaded = new Set(made.filter((m) => m.at === 'loading').map((m) => m.object));
    expect(
      made.filter((m) => m.at === 'loading' && m.glass).length,
      'glass compiled while loading',
    ).toBeGreaterThan(0);
    for (const name of LOOK_BACK_GLASS) expect([...loaded], `${name} compiled while loading`).toContain(name);
    // after landing: no glass compiles, and nothing at all while looking back
    expect(
      inPlay.filter((m) => m.glass).map((m) => `${m.at} ${m.object} ${m.material}`),
      'glass pipelines made while playing',
    ).toEqual([]);
    expect(
      made.filter((m) => m.at === 'game:look-back').map((m) => `${m.object} ${m.material}`),
      'pipelines made while looking back',
    ).toEqual([]);
    expect(steps['look-back'], 'the look-back step was played').toBeGreaterThan(0);

    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-38 peeking all around right after landing compiles no glass, nor the peek image's stand-ins [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectConsole(page);
    await page.addInitScript(installTracer);
    await page.goto(`/?scene=prologue-proto&debug=1${webgl}`);
    // home → dive by the same clicks a player makes (as S-06)
    await waitHome(page, 'p.load.ready === true', 90_000);
    await page.locator('[data-ui="loading-start"]').click();
    await waitHome(page, "p.screen === 'home' && p.transition === null", 30_000);
    await page.locator('[data-item="start"]').click();
    await waitHome(page, "p.screen === 'game' && p.transition === null", 30_000);
    await waitRoom(page, 'r.ready && r.playing');
    expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
    // take the vidro from the bench (the first click only locks the mouse), then hold the right button and turn once round
    const cursor = { x: 640, y: 360 };
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand' && r.handPresence > 0.99");
    const before = await room(page);
    await page.mouse.down({ button: 'right' });
    await waitRoom(page, 'r.peekAmount > 0.999');
    const turns = 16;
    let turned = 0;
    let yaw = (await room(page)).yaw;
    for (let i = 0; i < turns; i++) {
      cursor.x -= (2 * Math.PI) / turns / SENSITIVITY;
      await page.mouse.move(cursor.x, cursor.y, { steps: 4 });
      await page.waitForTimeout(250);
      const r = await room(page);
      turned += Math.abs(Math.atan2(Math.sin(r.yaw - yaw), Math.cos(r.yaw - yaw)));
      yaw = r.yaw;
    }
    const after = await room(page);
    await page.mouse.up({ button: 'right' });

    const made = await page.evaluate(() => window.__s38 ?? []);
    const inPlay = made.filter((m) => m.at === 'game');
    mkdirSync(join(root, 'artifacts/S-38'), { recursive: true });
    writeFileSync(
      join(root, `artifacts/S-38/peek-around-${backend}.json`),
      JSON.stringify(
        {
          backend,
          turned,
          backPassFrames: after.backPassFrames,
          inPlay,
          standIns: made.filter((m) => m.standIn),
          errors,
        },
        null,
        2,
      ),
    );
    // it really turned once round while peeking, and the peek image was drawn all the way
    expect(turned).toBeGreaterThan(2 * Math.PI * 0.9);
    expect(after.peeking).toBe(true);
    expect(after.backPassFrames - before.backPassFrames).toBeGreaterThan(turns * 4);
    // the tracer saw the stand-ins at all (so the check below cannot pass by tracing nothing)
    expect(made.filter((m) => m.standIn).length, 'stand-ins compiled at some point').toBeGreaterThan(0);
    expect(
      inPlay
        .filter((m) => m.glass || m.standIn)
        .map((m) => `${m.object} ${m.material}${m.standIn ? ' (stand-in)' : ''}`),
      'glass or stand-in pipelines made while peeking all around',
    ).toEqual([]);

    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}

interface RoomState {
  ready: boolean;
  playing: boolean;
  locked: boolean;
  orb: string;
  handPresence: number;
  peeking: boolean;
  peekAmount: number;
  yaw: number;
  backPassFrames: number;
}

const room = (page: Page): Promise<RoomState> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { room: RoomState }).room);

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

async function waitHome(page: Page, fn: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}
