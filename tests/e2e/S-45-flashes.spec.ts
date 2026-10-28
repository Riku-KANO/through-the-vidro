import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-45: 光の点滅や強い閃光を抑えるモード (UI/UX設計 > アクセシビリティ). The scripted play (?autoplay=1, through the home) twice
 * on each render path, with the setting off and on (kept before the page opens): the screen's mean luminance is sampled while
 * the vidro is placed (its wave of light), while the drop is taken (its light arriving in the vidro) and while the light
 * settles the bridge (its band), each against the picture just before. With the setting on:
 *  - no window rises by 10 % of the full luminance or more (WCAG 2.3.1's general flash: a change of 10 % or more), and none
 *    rises more than it does with the setting off; together they rise less
 *  - the clues stay: the same events happen (the room's log: the sounds play from it), the drop still flies into the vidro
 * Numbers → artifacts/S-45/flashes-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

interface RoomProbe {
  playing: boolean;
  time: number;
  sphereRadius: number;
  drop: string;
  events: string[];
  finale: { settle: number };
  autoplay: { step: string; done: boolean } | null;
  access: { calm: boolean };
}
interface Sample {
  time: number;
  step: string;
  sphere: number;
  drop: string;
  settle: number;
  mean: number;
}
interface Window {
  baseline: number;
  rise: number;
  samples: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** The steps of the script around the place and the take (src/game/prologue/autopilot.ts). */
const WATCHED = new Set(['look-pedestal', 'place', 'look-bridge', 'walk-far', 'touch', 'look-back']);

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

const room = (page: Page): Promise<RoomProbe | null> =>
  page.evaluate(() => {
    const r = (window.__vidro?.sceneProbe as { room?: unknown } | undefined)?.room;
    return r ? (JSON.parse(JSON.stringify(r)) as RoomProbe) : null;
  });

async function meanOf(page: Page, jpeg: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 3) {
      sum += (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / 255;
      n++;
    }
    return sum / n;
  }, jpeg.toString('base64'));
}

/** Plays the script with 点滅を抑える `calm`, sampling the screen around the place and the take. */
async function play(
  page: Page,
  webgl: string,
  calm: boolean,
): Promise<{ samples: Sample[]; final: RoomProbe }> {
  await page.addInitScript((on) => {
    window.localStorage.setItem('vidro.settings', JSON.stringify({ v: 1, settings: { reduceFlashes: on } }));
  }, calm);
  await page.goto(`/?scene=prologue-proto&autoplay=1${webgl}`);
  const shots: { r: RoomProbe; jpeg: Buffer }[] = [];
  const end = Date.now() + 150_000;
  for (;;) {
    if (Date.now() > end) throw new Error('the script did not reach the walk back over the bridge');
    const r = await room(page);
    const step = r?.autoplay?.step ?? '';
    if (r?.playing && (step === 'walk-back' || r.autoplay?.done)) break;
    if (r?.playing && WATCHED.has(step)) {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 70 });
      const after = await room(page);
      shots.push({ r: after ?? r, jpeg });
    } else await page.waitForTimeout(50);
  }
  const final = (await room(page)) as RoomProbe;
  const samples: Sample[] = [];
  for (const { r, jpeg } of shots)
    samples.push({
      time: r.time,
      step: r.autoplay?.step ?? '',
      sphere: r.sphereRadius,
      drop: r.drop,
      settle: r.finale.settle,
      mean: await meanOf(page, jpeg),
    });
  return { samples, final };
}

/** The rise of the mean luminance over the picture just before `starts`, until `ends`. */
function windowOf(samples: Sample[], starts: (s: Sample) => boolean, seconds: number): Window {
  const i = samples.findIndex(starts);
  if (i < 1) return { baseline: Number.NaN, rise: Number.NaN, samples: 0 };
  const baseline = (samples[i - 1] as Sample).mean;
  const from = (samples[i] as Sample).time;
  let rise = 0;
  let n = 0;
  for (const s of samples.slice(i)) {
    if (s.time > from + seconds) break;
    rise = Math.max(rise, s.mean - baseline);
    n++;
  }
  return { baseline, rise, samples: n };
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';

  test(`S-45 点滅を抑える: the place, the take and the sweep rise less, under 10 % [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(420_000);
    mkdirSync(join(root, 'artifacts/S-45'), { recursive: true });
    const errors = collectErrors(page);
    const runs: Record<'off' | 'on', { samples: Sample[]; final: RoomProbe; errors: string[] }> = {} as never;
    // (the second run's init script is added after the first's: it runs last and sets the setting on)
    for (const mode of ['off', 'on'] as const) {
      const r = await play(page, webgl, mode === 'on');
      runs[mode] = { ...r, errors: errors.splice(0) };
    }
    const windows = (s: Sample[]) => ({
      place: windowOf(s, (x) => x.sphere > 0, 1.5),
      take: windowOf(s, (x) => x.drop !== 'waiting', 2.0),
      sweep: windowOf(s, (x) => x.settle > 0, 1.8),
    });
    const off = windows(runs.off.samples);
    const on = windows(runs.on.samples);
    writeFileSync(
      join(root, `artifacts/S-45/flashes-${backend}.json`),
      JSON.stringify({ backend, off, on, samples: { off: runs.off.samples, on: runs.on.samples } }, null, 2),
    );
    expect(runs.off.final.access.calm).toBe(false);
    expect(runs.on.final.access.calm).toBe(true);
    for (const k of ['place', 'take', 'sweep'] as const) {
      expect(on[k].samples, `${k} sampled`).toBeGreaterThan(3);
      expect(off[k].samples).toBeGreaterThan(3);
      expect(on[k].rise, `${k}: no flash of 10 % or more`).toBeLessThan(0.1);
      expect(on[k].rise, `${k}: not more than with the setting off`).toBeLessThanOrEqual(off[k].rise + 0.01);
    }
    const sum = (w: typeof on) => w.place.rise + w.take.rise + w.sweep.rise;
    expect(sum(on), 'together they rise less').toBeLessThan(sum(off));
    // the clues stay: the same events, the drop flew into the vidro (its shape), the light settled the bridge
    const names = (r: RoomProbe) => r.events.filter((e) => /place|drop|pickup/.test(e));
    expect(names(runs.on.final)).toEqual(names(runs.off.final));
    expect(runs.on.samples.some((s) => s.drop === 'flying')).toBe(true);
    expect(runs.on.final.finale.settle).toBe(1);
    expect(runs.off.errors).toEqual([]);
    expect(runs.on.errors).toEqual([]);
  });
}
