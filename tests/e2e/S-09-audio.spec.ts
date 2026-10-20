import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { glassPitch, VIDRO_SCALE } from '../../src/audio/tuning';
import { decayT60, estimatePitch, peak, rms } from '../../src/core/audio/analysis';
import { volumeToGain } from '../../src/core/audio/mix';
import { isInScale, midiToHz } from '../../src/core/audio/scale';

/**
 * S-09 sensor for the audio foundation (scene: audio-lab).
 *  (a) the AudioContext stays suspended until the first click, then runs; keys and clicks play sounds
 *  (b) glass and popen sounds rendered in the browser with OfflineAudioContext are audible,
 *      in tune (fundamental within ±3 % of the scale note) and decay as designed; rooms differ in T60
 *  (c) the real AudioEngine rendered offline: an emitter voice is audible, and the four volumes act
 *      as specified (sfx 0 = silence, master 0.5 = -12 dB, music does not touch sfx)
 * Runs on both render paths. Numbers land in artifacts/audio/S-09[-webgl].json for the slice record.
 */

interface Note {
  time: number;
  midi: number;
  hz: number;
  t60: number;
}
interface RenderResult {
  sampleRate: number;
  samples: number[];
  notes: Note[];
  t60: number;
  voicesStarted?: number;
  cutAt?: number;
}
type RenderSpec =
  | { kind: 'glass'; size: number; strength: 'touch' | 'tap' | 'hit'; seed: number; duration?: number }
  | { kind: 'popen'; type: 'peek' | 'place' | 'pickup' | 'tremble'; seed: number; duration?: number }
  | { kind: 'impulse'; room: 'workshop' | 'dome'; duration?: number }
  | { kind: 'mix'; volumes: Record<string, number>; seed: number; duration?: number }
  | { kind: 'cut'; mode: 'steal' | 'silence' }
  | { kind: 'bed'; bed: 'wind' | 'drone'; stopAt: number };
interface AudioLabProbe {
  ready: boolean;
  audio: {
    state: string;
    unlocked: boolean;
    room: string;
    volumes: Record<string, number>;
    voicesStarted: number;
  };
  plays: number;
  glassPlays: number;
  popenPlays: number;
  strength: string;
  lastSound: { kind: string } | null;
  orbit: { on: boolean; angle: number; dotX: number; dotY: number };
  glasses: { size: number; midi: number; hz: number; note: string }[];
}

const RMS_MIN = 0.01; // -40 dBFS over the first 0.3 s
const PITCH_TOLERANCE = 0.03; // ±3 % of the target scale note

const backends = ['webgpu', 'webgl2'] as const;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

async function open(page: Page, backend: (typeof backends)[number]): Promise<void> {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  await page.goto(`/?scene=audio-lab${webgl}`);
  await page.waitForFunction(
    () =>
      window.__vidro?.status === 'error' ||
      (window.__vidro?.status === 'running' &&
        (window.__vidro.sceneProbe as { ready?: boolean }).ready === true),
    undefined,
    { timeout: 60_000 },
  );
  expect(await page.evaluate(() => window.__vidro.errors)).toEqual([]);
}

async function probe(page: Page): Promise<AudioLabProbe> {
  return (await page.evaluate(() => window.__vidro.sceneProbe)) as unknown as AudioLabProbe;
}

async function render(page: Page, spec: RenderSpec): Promise<RenderResult & { x: Float32Array }> {
  const r = await page.evaluate(
    (s) =>
      (
        window as unknown as { __vidroAudioLab: { render(spec: unknown): Promise<unknown> } }
      ).__vidroAudioLab.render(s),
    spec,
  );
  const result = r as RenderResult;
  return { ...result, x: Float32Array.from(result.samples) };
}

/** Largest jump between neighbouring samples in [from, to) seconds: a click shows up as a jump. */
function maxStep(x: Float32Array, sampleRate: number, from: number, to: number): number {
  let m = 0;
  const end = Math.min(x.length, Math.round(to * sampleRate));
  for (let i = Math.max(1, Math.round(from * sampleRate)); i < end; i++)
    m = Math.max(m, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return m;
}

function rmsAt(x: Float32Array, sampleRate: number, from: number, to: number): number {
  return rms(x, Math.round(from * sampleRate), Math.round(to * sampleRate));
}

function relErr(measured: number | null, target: number): number {
  return measured === null ? Number.POSITIVE_INFINITY : Math.abs(measured / target - 1);
}

for (const backend of backends) {
  const suffix = backend === 'webgl2' ? '-webgl' : '';

  test(`S-09 audio unlocks on the first click and plays [${backend}]`, async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, backend);

    let p = await probe(page);
    expect(p.audio.state, 'before any user gesture').toBe('suspended');
    expect(p.audio.unlocked).toBe(false);
    expect(Object.keys(p.audio.volumes).sort()).toEqual(['ambience', 'master', 'music', 'sfx']);
    expect(p.glasses.length).toBeGreaterThanOrEqual(4);
    // Bigger glass, lower note — and every note is on the scale.
    const bySize = [...p.glasses].sort((a, b) => a.size - b.size);
    for (let i = 1; i < bySize.length; i++) {
      const a = bySize[i - 1] as AudioLabProbe['glasses'][number];
      const b = bySize[i] as AudioLabProbe['glasses'][number];
      expect(b.size).toBeGreaterThan(a.size);
      expect(b.midi).toBeLessThan(a.midi);
    }
    for (const g of p.glasses) expect(isInScale(g.midi, VIDRO_SCALE)).toBe(true);

    // The instructions and the audio status are on screen before the click.
    await expect(page.getByLabel('操作の説明')).toBeVisible();
    await expect(page.getByLabel('音の状態')).toBeVisible();

    await page.mouse.click(640, 430);
    await page.waitForFunction(
      () => (window.__vidro.sceneProbe as { audio?: { state?: string } }).audio?.state === 'running',
      undefined,
      { timeout: 10_000 },
    );
    p = await probe(page);
    expect(p.audio.unlocked).toBe(true);

    const before = p.plays;
    await page.keyboard.press('1');
    await page.keyboard.press('5');
    await page.keyboard.press('6');
    p = await probe(page);
    expect(p.plays).toBe(before + 3);
    expect(p.popenPlays).toBeGreaterThanOrEqual(1);
    expect(p.lastSound?.kind).toBe('popen');
    expect(p.audio.voicesStarted).toBeGreaterThanOrEqual(3);

    await page.keyboard.press('e');
    expect((await probe(page)).strength).toBe('hit');
    await page.keyboard.press('q');
    expect((await probe(page)).strength).toBe('touch');

    const room0 = (await probe(page)).audio.room;
    await page.keyboard.press('r');
    const room1 = (await probe(page)).audio.room;
    expect(new Set([room0, room1])).toEqual(new Set(['workshop', 'dome']));

    await page.keyboard.press('o');
    const a0 = (await probe(page)).orbit.angle;
    await page.waitForTimeout(500);
    p = await probe(page);
    expect(p.orbit.on).toBe(true);
    expect(p.orbit.angle).not.toBeCloseTo(a0, 2);
    // The direction dial follows the source (its dot sits on the dial's ring).
    expect(Math.hypot(p.orbit.dotX, p.orbit.dotY)).toBeGreaterThan(30);

    // A struck glass shows its light ring; the orbiting source is on screen while in front.
    await page.keyboard.press('3');
    await page.waitForTimeout(150);
    mkdirSync(join(process.cwd(), 'artifacts/screens'), { recursive: true });
    await page.screenshot({ path: join(process.cwd(), `artifacts/screens/audio-lab-playing${suffix}.png`) });

    expect(errors.filter((e) => !/GPU stall|powerPreference/i.test(e))).toEqual([]);
    expect(await page.evaluate(() => window.__vidro.errors)).toEqual([]);
  });

  test(`S-09 offline renders are audible and in tune [${backend}]`, async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, backend);
    const p = await probe(page);
    const report: Record<string, unknown>[] = [];

    // Glass by size (tap): audible, unclipped, fundamental on the expected scale note.
    for (const [i, g] of p.glasses.entries()) {
      const r = await render(page, {
        kind: 'glass',
        size: g.size,
        strength: 'tap',
        seed: i + 1,
        duration: 0.6,
      });
      const expected = glassPitch(g.size);
      expect((r.notes[0] as Note).midi).toBe(expected.midi);
      const level = rms(r.x, 0, Math.round(0.3 * r.sampleRate));
      const hz = estimatePitch(r.x, r.sampleRate, { start: 0.01, duration: 0.45 });
      report.push({
        sound: `glass ${g.size}m tap`,
        note: g.note,
        target: expected.hz,
        measured: hz,
        rms: level,
      });
      expect(level, `rms glass ${g.size}`).toBeGreaterThan(RMS_MIN);
      expect(peak(r.x)).toBeLessThanOrEqual(1);
      expect(relErr(hz, expected.hz), `pitch glass ${g.size}: ${hz} vs ${expected.hz}`).toBeLessThan(
        PITCH_TOLERANCE,
      );
    }

    // Three strengths on one glass: touch < tap < hit in level, all in tune.
    const mid = p.glasses[Math.floor(p.glasses.length / 2)] as AudioLabProbe['glasses'][number];
    const levels: number[] = [];
    for (const strength of ['touch', 'tap', 'hit'] as const) {
      const r = await render(page, { kind: 'glass', size: mid.size, strength, seed: 11, duration: 0.6 });
      const level = rms(r.x, 0, Math.round(0.3 * r.sampleRate));
      const hz = estimatePitch(r.x, r.sampleRate, { start: 0.01, duration: 0.45 });
      report.push({
        sound: `glass ${mid.size}m ${strength}`,
        note: mid.note,
        target: mid.hz,
        measured: hz,
        rms: level,
      });
      expect(level).toBeGreaterThan(RMS_MIN);
      expect(relErr(hz, mid.hz), `pitch ${strength}`).toBeLessThan(PITCH_TOLERANCE);
      levels.push(level);
    }
    expect(levels[0]).toBeLessThan(levels[1] as number);
    expect(levels[1]).toBeLessThan(levels[2] as number);

    // Decay: the rendered ring follows the designed T60, and the biggest glass rings longest.
    const sorted = [...p.glasses].sort((a, b) => a.size - b.size);
    const smallest = sorted[0] as AudioLabProbe['glasses'][number];
    const biggest = sorted[sorted.length - 1] as AudioLabProbe['glasses'][number];
    const decays: number[] = [];
    for (const g of [smallest, biggest]) {
      const r = await render(page, { kind: 'glass', size: g.size, strength: 'tap', seed: 3 });
      const t60 = decayT60(r.x, r.sampleRate);
      report.push({ sound: `glass ${g.size}m decay`, designedT60: r.t60, measuredT60: t60 });
      expect(relErr(t60, r.t60), `decay ${g.size}: ${t60} vs ${r.t60}`).toBeLessThan(0.3);
      decays.push(t60 as number);
    }
    expect(decays[1]).toBeGreaterThan(decays[0] as number);

    // Popen: each pop on its scale note (±3 %), audible, short.
    for (const [i, type] of (['peek', 'place', 'pickup', 'tremble'] as const).entries()) {
      const r = await render(page, { kind: 'popen', type, seed: 20 + i });
      expect(r.notes.length).toBeGreaterThanOrEqual(2);
      if (type !== 'tremble') expect(r.notes).toHaveLength(2);
      const level = rms(r.x, 0, Math.round(0.3 * r.sampleRate));
      expect(level, `rms popen ${type}`).toBeGreaterThan(RMS_MIN);
      expect(peak(r.x)).toBeLessThanOrEqual(1);
      for (const [j, n] of r.notes.entries()) {
        expect(isInScale(n.midi, VIDRO_SCALE)).toBe(true);
        const next = r.notes[j + 1]?.time ?? n.time + 0.16;
        const start = n.time + 0.012;
        const hz = estimatePitch(r.x, r.sampleRate, { start, duration: Math.min(0.14, next - start) });
        const target = midiToHz(n.midi);
        report.push({ sound: `popen ${type} #${j + 1}`, target, measured: hz, rms: level });
        expect(relErr(hz, target), `popen ${type} #${j + 1}: ${hz} vs ${target}`).toBeLessThan(
          PITCH_TOLERANCE,
        );
      }
    }

    // Rooms: an impulse through the synthesized reverb decays at the room's T60; the dome is much longer.
    const roomT60: Record<string, number> = {};
    for (const room of ['workshop', 'dome'] as const) {
      const r = await render(page, { kind: 'impulse', room });
      const t60 = decayT60(r.x, r.sampleRate);
      report.push({ sound: `impulse ${room}`, designedT60: r.t60, measuredT60: t60, rms: rms(r.x) });
      expect(relErr(t60, r.t60), `room ${room}: ${t60} vs ${r.t60}`).toBeLessThan(0.2);
      roomT60[room] = t60 as number;
    }
    expect(roomT60.dome).toBeGreaterThan((roomT60.workshop as number) * 3);

    // The real engine on an OfflineAudioContext: a glass struck through an HRTF emitter on the sfx bus.
    const db = (a: number, b: number) => 20 * Math.log10(a / b);
    const mix = async (volumes: Record<string, number>) => {
      const r = await render(page, { kind: 'mix', volumes, seed: 5 });
      return { level: rms(r.x), voices: r.voicesStarted ?? 0 };
    };
    const full = await mix({ master: 1, music: 1, sfx: 1, ambience: 1 });
    const sfxOff = await mix({ master: 1, music: 1, sfx: 0, ambience: 1 });
    const masterHalf = await mix({ master: 0.5, music: 1, sfx: 1, ambience: 1 });
    const musicOff = await mix({ master: 1, music: 0, sfx: 1, ambience: 1 });
    report.push({
      sound: 'engine mix (glass via emitter, sfx bus)',
      rmsFull: full.level,
      rmsSfxOff: sfxOff.level,
      masterHalfDb: db(masterHalf.level, full.level),
      musicOffDb: db(musicOff.level, full.level),
    });
    expect(full.voices, 'offline engine needs no unlock').toBe(1);
    expect(full.level, 'emitter voice is audible').toBeGreaterThan(RMS_MIN);
    expect(sfxOff.level, 'sfx volume 0 is silent').toBeLessThan(1e-5);
    // The expectation comes from the volume curve itself, so the curve can change without editing this test.
    const halfDb = 20 * Math.log10(volumeToGain(0.5));
    expect(Math.abs(db(masterHalf.level, full.level) - halfDb), 'master 0.5 follows the curve').toBeLessThan(
      0.5,
    );
    expect(Math.abs(db(musicOff.level, full.level)), 'music volume leaves sfx alone').toBeLessThan(0.1);

    // Cutting a ringing voice must not click: stealing it at the voice cap, or fading the whole engine
    // (what dispose() does while playing). A click is a jump between neighbouring samples.
    for (const mode of ['steal', 'silence'] as const) {
      const r = await render(page, { kind: 'cut', mode });
      const at = r.cutAt as number;
      const before = maxStep(r.x, r.sampleRate, 0.1, at - 0.002);
      const around = maxStep(r.x, r.sampleRate, at - 0.002, at + 0.06);
      const ringing = rmsAt(r.x, r.sampleRate, 0.1, at);
      const after = rmsAt(r.x, r.sampleRate, at + 0.1, at + 0.2);
      report.push({
        sound: `cut ${mode}`,
        stepBefore: before,
        stepAround: around,
        rmsBefore: ringing,
        rmsAfter: after,
      });
      expect(around, `${mode}: no click (largest sample jump vs. before)`).toBeLessThan(before * 1.5);
      if (mode === 'steal') {
        expect(r.voicesStarted, 'a voice was stolen').toBe(1);
        expect(after, 'stolen voice is gone (only the room tail remains)').toBeLessThan(ringing * 0.3);
      } else {
        expect(after, 'whole mix is silent').toBeLessThan(ringing * 0.01);
      }
    }

    // Switching a test bed off fades it (no click that could be mistaken for a bug when listening).
    for (const bed of ['wind', 'drone'] as const) {
      const r = await render(page, { kind: 'bed', bed, stopAt: 0.5 });
      const level = rmsAt(r.x, r.sampleRate, 0.3, 0.5);
      const first10ms = rmsAt(r.x, r.sampleRate, 0.5, 0.51);
      const later = rmsAt(r.x, r.sampleRate, 0.7, 0.9);
      const before = maxStep(r.x, r.sampleRate, 0.3, 0.5);
      const around = maxStep(r.x, r.sampleRate, 0.5, 0.65);
      report.push({
        sound: `bed ${bed} stop`,
        rmsBefore: level,
        rmsFirst10ms: first10ms,
        rmsAfter: later,
        stepBefore: before,
        stepAround: around,
      });
      expect(first10ms, `${bed}: fades rather than cutting`).toBeGreaterThan(level * 0.3);
      expect(later, `${bed}: silent after the fade`).toBeLessThan(level * 0.05);
      if (bed === 'drone') expect(around, 'drone: no click').toBeLessThan(before * 1.5);
    }

    mkdirSync(join(process.cwd(), 'artifacts/audio'), { recursive: true });
    writeFileSync(join(process.cwd(), `artifacts/audio/S-09${suffix}.json`), JSON.stringify(report, null, 2));
    expect(errors.filter((e) => !/GPU stall|powerPreference/i.test(e))).toEqual([]);
  });
}
