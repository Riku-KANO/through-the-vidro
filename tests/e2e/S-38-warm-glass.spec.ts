import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-38: the workshop's glass compiles while loading, not when the player first turns toward it.
 *
 * The stall (S-34 review P2-3): the scripted play (?autoplay=1) looks back from the far shore at the workshop, and the
 * transmissive glass wares on the dome's +Z side (A0_ware_anneal01, A0_ware_cart01 …) were drawn for the first time
 * there: three built their render pipelines in those frames, one per frame (the longest frame of the play, 40–65 ms,
 * 195 ms on a busy GPU). The loading's warm-up draw saw only what its pose (the miniature view) saw.
 *
 * A tracer installed before the page's script wraps the renderer's backend (?debug=1 publishes it) and notes every
 * render pipeline three creates, with where the game was: the autoplay step once playing, else the home's screen or
 * transition. Checked on both paths: after landing, no pipeline is made for anything whose material reads the backdrop
 * (glass), none at all while looking back; the culprits got theirs while loading (so the test cannot pass by tracing
 * nothing); no console error or warning. Pipelines by step, the longest frame of each step and the loading's steps go
 * to artifacts/S-38/pipelines-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const BENIGN = /GPU stall|powerPreference/i;
/** The workshop's glass first seen when looking back (S-34's trace; layout.ts WORKSHOP_OBJECTS annealerWares, cartWares). */
const LOOK_BACK_GLASS = ['A0_ware_anneal01', 'A0_ware_cart01'];

interface Made {
  /** 'game:<step>' once playing, else '<screen or transition>' ('loading' until the load is ready). */
  at: string;
  object: string;
  material: string;
  glass: boolean;
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
    if ((m.type() === 'error' || m.type() === 'warning') && !BENIGN.test(m.text()))
      seen.push(`${m.type()}: ${m.text().slice(0, 300)}`);
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
}
