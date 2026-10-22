import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-29: a render scale change around the dive must not leave the transmission backdrop of a target at an old size.
 *
 * The bug (S-24 判断待ち8, S-27's trace): after landing through the home on WebGPU, every frame stayed black with
 * "Texture copy range … [1088, 612] touches outside of [Texture 1024x576 RGBA16Float]". Cause (three r186,
 * process/slices/S-29.md, src/core/glass/backdrop.ts ownBackdropImage): the backdrop that transmission reads is
 * copied per target (the orb's image in the home, the room's scene pass when playing), and those copies share one
 * image record. Each copy is re-made only when the shared record differs from its target's size, so after a size
 * change the target drawn second keeps its old size. Larger than it: the copy is out of range (WebGPU drops the
 * whole submit: black; WebGL2 warns GL_INVALID_VALUE). Smaller: no message, the glass shows a shifted background.
 *
 * Each case forces the scale (?debug=1 setScale, dynamic resolution off) at the moment the shape needs. A tracer
 * installed before the page's script records, with times, the pixel ratio and canvas size changes, and every backdrop
 * copy (re)made with its target and size. It flags a copy into a backdrop whose texture was made at another size
 * (only public fields: the texture's version and image). Checked after each landing: not black; at the end: no stale
 * copy, no console error or warning, no page error. The trace goes to artifacts/S-29/<case>-<backend>.json first.
 */
test.use({ locale: 'ja-JP' });

const root = process.cwd();
const outDir = join(root, 'artifacts/S-29');
const shotDir = join(root, 'artifacts/screens/S-29');
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const BENIGN = /GPU stall|powerPreference/i;
/** One dynamic resolution step (src/core/perf/dynamic-resolution.ts). */
const STEP = 0.05;
/** One step down, rounded as dynamic resolution rounds its scales (0.85 − 0.05 is 0.7999… in floating point). */
const lower = (scale: number): number => Math.round((scale - STEP) * 100) / 100;

interface TraceEvent {
  t: number;
  kind: 'pixelRatio' | 'size' | 'backdrop' | 'mark';
  value?: number | string;
  texture?: number;
  target?: string;
}
interface StaleCopy {
  t: number;
  texture: number;
  target: string;
  made: string;
  copied: string;
}
interface S29Trace {
  /** performance.now() when the tracer was installed: every t is seconds since. */
  start: number;
  events: TraceEvent[];
  stale: StaleCopy[];
  staleCopies: number;
}
declare global {
  interface Window {
    __s29?: S29Trace;
  }
}

/**
 * Runs in the page before its own script. When main.ts publishes window.__vidroDebug (?debug=1, before the first
 * scene), wraps three methods on that renderer instance: setPixelRatio and setSize (logged when the value changes;
 * three itself calls setPixelRatio with the same value when passes restore the renderer state), and
 * copyFramebufferToTexture (the backdrop copy: ViewportTextureNode calls it with the texture for the current target).
 */
function installTracer(): void {
  interface Tex {
    id: number;
    version: number;
    image: { width: number; height: number };
  }
  interface Target {
    width: number;
    height: number;
    texture?: { name?: string };
  }
  interface Renderer {
    getPixelRatio(): number;
    setPixelRatio(v: number): void;
    setSize(w: number, h: number, s?: boolean): void;
    copyFramebufferToTexture(tex: Tex, rect?: unknown): void;
    getRenderTarget(): Target | null;
  }
  const start = performance.now();
  const at = (): number => Math.round(performance.now() - start) / 1000;
  const trace: S29Trace = { start, events: [], stale: [], staleCopies: 0 };
  window.__s29 = trace;
  const install = (debug: { renderer: Renderer }): void => {
    const r = debug.renderer;
    let ratio = r.getPixelRatio();
    const setPixelRatio = r.setPixelRatio;
    r.setPixelRatio = function (this: Renderer, v: number) {
      if (v !== ratio) {
        ratio = v;
        trace.events.push({ t: at(), kind: 'pixelRatio', value: v });
      }
      return setPixelRatio.call(this, v);
    };
    let size = '';
    const setSize = r.setSize;
    r.setSize = function (this: Renderer, w: number, h: number, s?: boolean) {
      if (`${w}x${h}` !== size) {
        size = `${w}x${h}`;
        trace.events.push({ t: at(), kind: 'size', value: size });
      }
      return setSize.call(this, w, h, s);
    };
    const names = new WeakMap<object, string>();
    let targets = 0;
    const made = new Map<number, { version: number; w: number; h: number }>();
    const copy = r.copyFramebufferToTexture;
    r.copyFramebufferToTexture = function (this: Renderer, tex: Tex, rect?: unknown) {
      const result = copy.call(this, tex, rect);
      const ref = r.getRenderTarget();
      if (ref && !names.has(ref)) names.set(ref, `${ref.texture?.name || 'target'}#${++targets}`);
      const w = tex.image.width;
      const h = tex.image.height;
      const target = ref ? `${names.get(ref)} ${ref.width}x${ref.height}` : 'canvas';
      const m = made.get(tex.id);
      if (!m || m.version !== tex.version) {
        // three re-made this backdrop's texture just now, at its image size (Textures.updateTexture)
        made.set(tex.id, { version: tex.version, w, h });
        trace.events.push({ t: at(), kind: 'backdrop', texture: tex.id, target, value: `${w}x${h}` });
      } else if (m.w !== w || m.h !== h) {
        trace.staleCopies++;
        if (trace.stale.length < 20)
          trace.stale.push({ t: at(), texture: tex.id, target, made: `${m.w}x${m.h}`, copied: `${w}x${h}` });
      }
      return result;
    };
  };
  Object.defineProperty(window, '__vidroDebug', {
    configurable: true,
    set(v: { renderer: Renderer }) {
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

/** One line per distinct message with its count. */
function summarize(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => `${n}× ${l}`);
}

async function waitProbe(page: Page, fn: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/** Share of near-black pixels of what is on screen (S-24's measure). */
async function darkShare(page: Page, path: string): Promise<number> {
  const png = await page.screenshot({ path });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0;
    let k = 0;
    for (let i = 0; i < d.length; i += 20) {
      const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      if (l < 0.06) k++;
      n++;
    }
    return k / n;
  }, png.toString('base64'));
}

class Run {
  readonly landings: { label: string; dark: number; scale: number }[] = [];
  preset = 0;
  /** Each landing is saved as <shots>-<n>.png. */
  constructor(
    readonly page: Page,
    private readonly shots: string,
  ) {}

  async mark(label: string): Promise<void> {
    await this.page.evaluate((label) => {
      const t = window.__s29;
      if (t) t.events.push({ t: Math.round(performance.now() - t.start) / 1000, kind: 'mark', value: label });
    }, label);
  }
  /** Forces the render scale past the governor (dynamic resolution is off in these runs). */
  async setScale(scale: number, label: string): Promise<void> {
    await this.mark(`setScale(${scale}) ${label}`);
    await this.page.evaluate((s) => window.__vidroDebug?.setScale(s), scale);
  }
  async open(scene: string, webgl: boolean): Promise<void> {
    await this.page.goto(`/?scene=${scene}&debug=1&quality=mid&dynres=0${webgl ? '&webgl=1' : ''}`);
    await this.page.waitForFunction(
      () => window.__vidro?.status === 'running' && !!window.__vidroDebug,
      undefined,
      {
        timeout: 60_000,
      },
    );
    this.preset = await this.page.evaluate(() => window.__vidro.renderScale);
  }
  async loaded(): Promise<void> {
    await waitProbe(this.page, 'p.load.ready === true', 90_000);
    await this.mark('loaded');
  }
  async home(): Promise<void> {
    await this.page.locator('[data-ui="loading-start"]').click();
    await waitProbe(this.page, "p.screen === 'home' && p.transition === null", 30_000);
    await this.mark('home');
  }
  /** 「はじめる」 on the home, down into the orb; checks the landed picture. */
  async dive(label: string, playing: string): Promise<void> {
    await this.page.locator('[data-item="start"]').click();
    await waitProbe(this.page, `p.screen === 'game' && p.transition === null && ${playing}`, 60_000);
    await this.mark(`landed ${label}`);
    await frames(this.page, 30);
    const scale = await this.page.evaluate(() => window.__vidro.renderScale);
    const shot = `${this.shots}-${this.landings.length + 1}.png`;
    this.landings.push({ label, dark: await darkShare(this.page, shot), scale });
  }
  /** Esc in the game plays the dive back to the home (the home-dive sandbox scene). */
  async rewind(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await waitProbe(this.page, "p.screen === 'home' && p.transition === null", 30_000);
    await this.mark('back home');
    await frames(this.page, 30);
  }
}

interface Case {
  name: string;
  scene: 'prologue-proto' | 'home-dive';
  /** What the case looks for. */
  shape: string;
  run(r: Run): Promise<void>;
}

const ROOM_PLAYING = 'p.room && p.room.ready && p.room.playing';

const CASES: Case[] = [
  {
    name: 'load-low',
    scene: 'prologue-proto',
    shape:
      'one step down while loading (the playing view is first drawn there), back on the home, land: the scene pass backdrop would stay smaller than the picture (S-27: black)',
    async run(r) {
      await r.setScale(lower(r.preset), 'while loading');
      await r.loaded();
      await r.setScale(r.preset, 'loaded');
      await r.home();
      await r.dive('at the preset', ROOM_PLAYING);
    },
  },
  {
    name: 'home-low',
    scene: 'prologue-proto',
    shape:
      'one step down on the home, land there: the scene pass backdrop would stay larger than the picture',
    async run(r) {
      await r.loaded();
      await r.home();
      await r.setScale(lower(r.preset), 'on the home');
      await r.dive('one step down', ROOM_PLAYING);
    },
  },
  {
    name: 'city-back-and-forth',
    scene: 'home-dive',
    shape:
      'the canvas and the orb image both read the backdrop: down on the home, land, up while playing, back home (Esc), land again',
    async run(r) {
      await r.loaded();
      await r.home();
      await r.setScale(lower(r.preset), 'on the home');
      await r.dive('one step down', 'true');
      await r.setScale(r.preset, 'while playing');
      await frames(r.page, 10);
      await r.rewind();
      await r.dive('again at the preset', 'true');
    },
  },
];

for (const backend of backends) {
  const webgl = backend === 'webgl2';
  for (const c of CASES) {
    test(`S-29 ${c.name}: a scale change around the dive leaves no backdrop at an old size [${backend}]`, async ({
      page,
    }) => {
      test.setTimeout(150_000);
      mkdirSync(outDir, { recursive: true });
      await page.addInitScript(installTracer);
      const seen = collectConsole(page);
      mkdirSync(join(shotDir, backend), { recursive: true });
      const r = new Run(page, join(shotDir, backend, c.name));
      const out: Record<string, unknown> = {
        case: c.name,
        scene: c.scene,
        shape: c.shape,
        backend,
        stage: 'start',
      };
      const write = async () => {
        out.trace = await page.evaluate(() => window.__s29 ?? null).catch(() => null);
        out.landings = r.landings;
        out.console = summarize(seen);
        out.errors = await page.evaluate(() => window.__vidro?.errors ?? null).catch(() => null);
        writeFileSync(join(outDir, `${c.name}-${backend}.json`), JSON.stringify(out, null, 2));
      };
      try {
        await r.open(c.scene, webgl);
        out.preset = r.preset;
        await c.run(r);
        out.stage = 'done';
      } finally {
        await write();
      }
      const trace = out.trace as S29Trace;
      // the case did what it meant: the backdrop was made at both sizes
      const sizes = new Set(trace.events.filter((e) => e.kind === 'backdrop').map((e) => e.value));
      expect(sizes.size, 'backdrop sizes seen').toBeGreaterThanOrEqual(2);
      for (const l of r.landings)
        expect(l.dark, `near-black share after landing ${l.label}`).toBeLessThan(0.02);
      expect(
        trace.stale,
        `copies into a backdrop made at another size (${trace.staleCopies} in all)`,
      ).toEqual([]);
      expect(summarize(seen)).toEqual([]);
      expect(out.errors).toEqual([]);
    });
  }
}
