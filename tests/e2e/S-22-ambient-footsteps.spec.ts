import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { CHIME_NOTES, DROP_NOTES } from '../../src/audio/ambience';
import { FLOOR_MATERIALS, FOOTSTEP_VARIANTS } from '../../src/audio/footsteps';
import { VIDRO_VOLUMES } from '../../src/audio/levels';
import { VIDRO_SCALE } from '../../src/audio/tuning';
import { correlation, estimatePitch, peak, rms } from '../../src/core/audio/analysis';
import { Biquad } from '../../src/core/audio/dsp';
import { volumeToGain } from '../../src/core/audio/mix';
import { isInScale, midiToHz } from '../../src/core/audio/scale';
import { EDGE_Z, FAR, PATH, WORKSHOP_FLOOR_RADIUS } from '../../src/game/prologue/layout';

/**
 * S-22: the workshop's ambience and the footsteps, on both render paths.
 *  (a) OfflineAudioContext, in the page, through the game's engine: every synthesized sound (24 footsteps, 5 chimes,
 *      8 drops, the wind loop) is audible; each chime's fundamental is within ±3 % of its scale note; the ambience
 *      follows the ambience volume and the workshop's reverb. WAVs for the ear → artifacts/S-22/wav/
 *  (b) walking out of the workshop: each footstep's material is the floor drawn under the feet where it fell
 *      (frosted glass disc → stone way), from the feet, no variant twice running, slower while peeking (移動50%);
 *      wind, chimes and drops sound (the probe's ears on each kind)
 *  (c) the dead end over the bridge to the far shore: stone → the bridge's frosted glass → stone; the draws and
 *      triangles are the same before and after the sound starts
 *  (d) through the home: the ambience waits for the workshop, and every voice of the one engine is the UI's,
 *      a cue's or a step's
 * No console error or warning anywhere. Numbers → artifacts/S-22/<what>-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface RoomProbe {
  ready: boolean;
  playing: boolean;
  time: number;
  position: V3;
  speed: number;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  locked: boolean;
  peekAmount: number;
  orb: 'bench' | 'hand' | 'pedestal';
  bridgeColliders: number;
  bridgeSegments: number;
  target: 'bench' | 'pedestal' | 'drop' | null;
  walked: number;
  footfalls: number;
  drawCalls: number;
  triangles: number;
  events: string[];
  layout: { edgeZ: number; farZ: number; pedestalOrb: [number, number, number] };
}
interface FootstepEntry {
  material: 'stone' | 'frosted' | 'brass';
  zone: string;
  variant: number;
  x: number;
  z: number;
  time: number;
  speed: number;
  distance: number;
}
interface SoundProbe {
  state: string;
  unlocked: boolean;
  shared: boolean;
  room: string;
  panning: string[];
  voicesStarted: number;
  playedCount: number;
  emitters: number;
  engineVoices: number;
  footsteps: {
    ready: boolean;
    count: number;
    refused: number;
    skipped: number;
    missing: number;
    since: number | null;
    voicesStarted: number;
    log: FootstepEntry[];
  };
  ambience: {
    ready: boolean;
    playing: boolean;
    sources: { id: string; kind: 'wind' | 'chimes' | 'drops'; plays: number; active: number }[];
    levels: { wind: number; chimes: number; drops: number };
  };
}
interface GateProbe {
  state: string;
  uiVoices: number;
  voicesStarted: number;
  voicesDropped: number;
}
type LabSpec =
  | {
      kind: 'sound';
      bank: 'stone' | 'frosted' | 'brass' | 'chimes' | 'drops' | 'wind';
      index: number;
      seconds: number;
      room?: 'workshop' | 'dome';
    }
  | { kind: 'walk'; material: 'stone' | 'frosted' | 'brass'; steps: number }
  | { kind: 'ambience'; seconds: number; seed: number; at: 'bench' | 'path' | 'far'; volume?: number };
interface LabResult {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  hits?: { at: number; id: string; kind: string; index: number }[];
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const SENSITIVITY = 0.0022;
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** S-09's bar for "audible": -40 dBFS RMS. */
const AUDIBLE = 0.01;

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
  page.evaluate(() => (window.__vidro.sceneProbe as { sound: SoundProbe }).sound);
const both = (page: Page): Promise<{ room: RoomProbe; sound: SoundProbe }> =>
  page.evaluate(() => {
    const p = window.__vidro.sceneProbe as { room: RoomProbe; sound: SoundProbe };
    return { room: { ...p.room }, sound: { ...p.sound } };
  });

async function waitFor(page: Page, key: 'room' | 'sound', name: string, fn: string, timeout: number) {
  await page.waitForFunction(
    `(() => { try { const ${name} = window.__vidro?.sceneProbe?.${key}; return !!${name} && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}
const waitRoom = async (page: Page, fn: string, timeout = 20_000): Promise<RoomProbe> => {
  await waitFor(page, 'room', 'r', fn, timeout);
  return room(page);
};
const waitSound = async (page: Page, fn: string, timeout = 10_000): Promise<SoundProbe> => {
  await waitFor(page, 'sound', 's', fn, timeout);
  return sound(page);
};
async function waitHome(page: Page, fn: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

async function lab(page: Page, spec: LabSpec): Promise<LabResult & { mono: Float32Array }> {
  const r = (await page.evaluate(
    (s) =>
      (window.__vidro.sceneProbe as { sound: { render(spec: unknown): Promise<unknown> } }).sound.render(s),
    spec,
  )) as LabResult;
  const left = Float32Array.from(r.left);
  const right = Float32Array.from(r.right);
  const mono = left.map((v, i) => (v + (right[i] as number)) / 2);
  return { ...r, left, right, mono };
}

/* ---------- looking and walking (as S-16) ---------- */

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
async function lookAt(page: Page, p: [number, number, number]): Promise<void> {
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

/** Where the body was, sampled while walking, and the loudest each ambience kind was heard meanwhile. */
interface Track {
  points: V3[];
  heard: { wind: number; chimes: number; drops: number };
}
const newTrack = (): Track => ({ points: [], heard: { wind: 0, chimes: 0, drops: 0 } });
async function sample(page: Page, track: Track): Promise<RoomProbe> {
  const { room: r, sound: s } = await both(page);
  track.points.push({ ...r.position });
  for (const k of ['wind', 'chimes', 'drops'] as const)
    track.heard[k] = Math.max(track.heard[k], s.ambience.levels[k]);
  return r;
}

async function walkTo(page: Page, track: Track, x: number, z: number, within = 0.3): Promise<void> {
  const end = Date.now() + 25_000;
  await lookAt(page, [x, 1.5, z]);
  await page.keyboard.down('KeyW');
  try {
    for (;;) {
      const r = await sample(page, track);
      if (Math.hypot(x - r.position.x, z - r.position.z) < within) return;
      if (Date.now() > end)
        throw new Error(`walkTo(${x}, ${z}) did not arrive: at ${JSON.stringify(r.position)}`);
      const dYaw = wrap(Math.atan2(-(x - r.position.x), -(z - r.position.z)) - r.yaw);
      if (Math.abs(dYaw) > 0.05) await look(page, dYaw, 0);
      await page.waitForTimeout(40);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
}

/** Holds W for `ms` of wall time, sampling. */
async function walkFor(page: Page, track: Track, ms: number): Promise<void> {
  await page.keyboard.down('KeyW');
  try {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sample(page, track);
      await page.waitForTimeout(40);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
}

/* ---------- what is drawn underfoot (room-art.ts / physics.ts), independent of the sound's own table ---------- */

function drawnFloor(x: number, z: number): 'frosted' | 'stone' | '?' {
  // the frosted floor disc of the workshop (its walk collider has the same radius)
  if (Math.hypot(x, z) <= WORKSHOP_FLOOR_RADIUS + 0.05) return 'frosted';
  if (x >= PATH.minX && x <= PATH.maxX && z <= PATH.maxZ && z >= PATH.minZ) return 'stone';
  // the back layer's bridge deck (frosted, deckMaterial) over the gap
  if (z < EDGE_Z && z > FAR.maxZ && Math.abs(x) < 0.7) return 'frosted';
  if (x >= FAR.minX && x <= FAR.maxX && z <= FAR.maxZ && z >= FAR.minZ) return 'stone';
  return '?';
}

/** The run of materials with repeats folded: frosted frosted stone → frosted stone. */
const runs = <T>(xs: T[]): T[] => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

function expectHonestSteps(log: FootstepEntry[], track: Track): void {
  for (const e of log) {
    const where = `${e.material} at (${e.x.toFixed(2)}, ${e.z.toFixed(2)})`;
    expect(e.material, where).toBe(drawnFloor(e.x, e.z));
    // logged where the body really was (a sampled point of the walk is near)
    const near = Math.min(...track.points.map((p) => Math.hypot(p.x - e.x, p.z - e.z)));
    expect(near, where).toBeLessThan(0.35);
    // 足元から: below the listener's ear by about the eye height
    expect(e.distance, where).toBeGreaterThan(1.4);
    expect(e.distance, where).toBeLessThan(1.8);
    expect(e.variant).toBeGreaterThanOrEqual(0);
    expect(e.variant).toBeLessThan(FOOTSTEP_VARIANTS);
  }
  // 同じ音が続かない
  for (let i = 1; i < log.length; i++) {
    const a = log[i - 1] as FootstepEntry;
    const b = log[i] as FootstepEntry;
    if (a.material === b.material) expect(b.variant, `step ${i}`).not.toBe(a.variant);
  }
}

/**
 * Every footfall since the sound began counting was answered once: played, refused by the engine, or (two footfalls in
 * one long frame) folded into one step. Nothing is refused once the audio runs.
 */
function expectOneStepPerFootfall(s: SoundProbe, r: RoomProbe): void {
  const f = s.footsteps;
  expect(f.since).not.toBeNull();
  expect(f.count + f.refused + f.skipped + f.missing).toBe(r.footfalls - (f.since as number));
  expect(f.missing).toBe(0);
  expect(f.refused).toBe(0);
  expect(f.skipped).toBeLessThanOrEqual(1);
}

/* ---------- 16-bit WAV for the ear ---------- */

function wav(path: string, sampleRate: number, channels: Float32Array[]): void {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const data = Buffer.alloc(44 + n * ch * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * ch * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(ch, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * ch * 2, 28);
  data.writeUInt16LE(ch * 2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, (channels[c] as Float32Array)[i] as number));
      data.writeInt16LE(Math.round(v * 32767), 44 + (i * ch + c) * 2);
    }
  writeFileSync(path, data);
}

const rmsAt = (x: Float32Array, sr: number, from: number, to: number): number =>
  rms(x, Math.round(from * sr), Math.round(to * sr));

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const out = join(root, 'artifacts/S-22');

  test(`S-22 offline: every synthesized sound is audible, the chimes are on the scale, the ambience follows its volume and the room [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const wavDir = join(out, 'wav');
    mkdirSync(wavDir, { recursive: true });
    const write = backend === 'webgpu';
    await page.goto(`/?scene=prologue-proto&direct=1${webgl}`);
    await waitRoom(page, 'r.ready && r.playing', 60_000);
    const report: Record<string, unknown> = { backend };

    // 24 footsteps: audible, unclipped, 8 different ones per floor
    const steps: Record<string, unknown>[] = [];
    for (const material of FLOOR_MATERIALS) {
      const renders: Float32Array[] = [];
      for (let v = 0; v < FOOTSTEP_VARIANTS; v++) {
        const r = await lab(page, { kind: 'sound', bank: material, index: v, seconds: 0.8 });
        const level = rmsAt(r.mono, r.sampleRate, 0, 0.15);
        steps.push({ material, variant: v, rms: level, peak: peak(r.mono) });
        expect(level, `${material} #${v + 1}`).toBeGreaterThan(AUDIBLE);
        expect(peak(r.mono), `${material} #${v + 1}`).toBeLessThan(1);
        renders.push(r.mono.subarray(0, Math.round(0.3 * r.sampleRate)));
        if (write) wav(join(wavDir, `step-${material}-${v + 1}.wav`), r.sampleRate, [r.left, r.right]);
      }
      for (let a = 0; a < renders.length; a++)
        for (let b = a + 1; b < renders.length; b++)
          expect(Math.abs(correlation(renders[a] as Float32Array, renders[b] as Float32Array))).toBeLessThan(
            0.95,
          );
      if (write) {
        const walk = await lab(page, { kind: 'walk', material, steps: 8 });
        wav(join(wavDir, `walk-${material}.wav`), walk.sampleRate, [walk.left, walk.right]);
      }
    }
    report.steps = steps;

    // 遠くの風鈴: each bell's fundamental within ±3 % of its note on D major pentatonic
    const chimes: Record<string, unknown>[] = [];
    for (const [i, midi] of CHIME_NOTES.entries()) {
      const r = await lab(page, { kind: 'sound', bank: 'chimes', index: i, seconds: 3.2 });
      const hz = estimatePitch(r.mono, r.sampleRate, { start: 0.05, duration: 0.6 });
      const target = midiToHz(midi);
      const error = hz === null ? Number.POSITIVE_INFINITY : Math.abs(hz / target - 1);
      chimes.push({ midi, target, hz, error, rms: rmsAt(r.mono, r.sampleRate, 0, 0.3) });
      expect(isInScale(midi, VIDRO_SCALE)).toBe(true);
      expect(error, `chime ${midi}: ${hz} Hz for ${target.toFixed(1)} Hz`).toBeLessThan(0.03);
      expect(rmsAt(r.mono, r.sampleRate, 0, 0.3)).toBeGreaterThan(AUDIBLE);
      if (write) wav(join(wavDir, `chime-${i + 1}-${midi}.wav`), r.sampleRate, [r.left, r.right]);
    }
    report.chimes = chimes;

    // 水滴 and the wind
    for (const [i, midi] of DROP_NOTES.entries()) {
      const r = await lab(page, { kind: 'sound', bank: 'drops', index: i, seconds: 0.8 });
      expect(rmsAt(r.mono, r.sampleRate, 0, 0.1), `drop ${midi}`).toBeGreaterThan(AUDIBLE);
      if (write) wav(join(wavDir, `drop-${i + 1}-${midi}.wav`), r.sampleRate, [r.left, r.right]);
    }
    const wind = await lab(page, { kind: 'sound', bank: 'wind', index: 0, seconds: 16 });
    expect(rmsAt(wind.mono, wind.sampleRate, 1, 15)).toBeGreaterThan(AUDIBLE);
    // it keeps blowing: no half second of it falls silent
    for (let t = 1; t + 0.5 <= 15; t += 0.5)
      expect(rmsAt(wind.mono, wind.sampleRate, t, t + 0.5), `wind at ${t} s`).toBeGreaterThan(AUDIBLE / 4);
    if (write) wav(join(wavDir, 'wind-loop-x2.wav'), wind.sampleRate, [wind.left, wind.right]);

    // 工房の残響に従う: a drop's tail is the room's — short in the workshop, long under the dome
    const inWorkshop = await lab(page, {
      kind: 'sound',
      bank: 'drops',
      index: 3,
      seconds: 2.5,
      room: 'workshop',
    });
    const inDome = await lab(page, { kind: 'sound', bank: 'drops', index: 3, seconds: 2.5, room: 'dome' });
    const tail = (r: LabResult & { mono: Float32Array }) => rmsAt(r.mono, r.sampleRate, 0.6, 1.6);
    expect(
      rmsAt(inWorkshop.mono, inWorkshop.sampleRate, 0.4, 0.6),
      'the workshop reverb rings after the drop',
    ).toBeGreaterThan(1e-4);
    expect(tail(inDome) / tail(inWorkshop)).toBeGreaterThan(3);
    report.reverb = { workshopTail: tail(inWorkshop), domeTail: tail(inDome) };

    // the whole ambience at the bench, through the engine (HRTF, the workshop): all three kinds sound, and the
    // ambience volume scales it (half the slider = -12 dB, 0 = silence)
    const seconds = 30;
    const full = await lab(page, { kind: 'ambience', seconds, seed: 7, at: 'bench' });
    const half = await lab(page, { kind: 'ambience', seconds, seed: 7, at: 'bench', volume: 0.5 });
    const none = await lab(page, { kind: 'ambience', seconds, seed: 7, at: 'bench', volume: 0 });
    const hits = full.hits ?? [];
    expect(hits.some((h) => h.kind === 'chimes')).toBe(true);
    expect(hits.some((h) => h.kind === 'drops')).toBe(true);
    // a gust's first strike rings out above the wind bed just before it, where a bell is heard (above 1 kHz: the
    // bells are D6 and up, the wind's body lies below): 遠く, but heard
    const sr = full.sampleRate;
    // the far set only (chimes:town): since S-25 the bell above the door is a place of 'chimes' too, and its strikes
    // must not stand in for the far bells. Gusts whose first strike has the bed to itself: no far bell still ringing
    // (3 s), no drop around it, no draught at the door (its bell rings while one comes in, and the door's wind swells).
    // One seed's 30 s may hold none (seed 7 since S-25), so three seeds are listened to.
    const standOut: number[] = [];
    for (const seed of [7, 8, 9]) {
      const run = seed === 7 ? full : await lab(page, { kind: 'ambience', seconds, seed, at: 'bench' });
      const hp = new Biquad(sr).highpass(1000);
      const bright = run.mono.map((v) => hp.process(v));
      const runHits = run.hits ?? [];
      const chimeHits = runHits.filter((q) => q.id === 'chimes:town');
      const doorHits = runHits.filter((q) => q.id === 'chimes:door');
      const dropHits = runHits.filter((q) => q.kind === 'drops');
      const firsts = chimeHits.filter(
        (h, i) =>
          (i === 0 || h.at - (chimeHits[i - 1]?.at ?? 0) > 3) &&
          !dropHits.some((d) => d.at > h.at - 0.6 && d.at < h.at + 0.3) &&
          !doorHits.some((d) => d.at > h.at - 3 && d.at < h.at + 0.3),
      );
      for (const h of firsts) {
        const over = rmsAt(bright, sr, h.at, h.at + 0.3) / rmsAt(bright, sr, h.at - 0.35, h.at - 0.05);
        standOut.push(over);
        expect(over, `seed ${seed}: chime at ${h.at.toFixed(2)} s`).toBeGreaterThan(1.4);
      }
    }
    expect(standOut.length, 'far strikes with the bed to themselves, over seeds 7–9').toBeGreaterThan(0);
    const ratio = rmsAt(half.mono, sr, 3, seconds) / rmsAt(full.mono, sr, 3, seconds);
    // the volume slider's square law (src/core/audio/mix.ts): half the slider against the game's starting position
    const expected = volumeToGain(0.5) / volumeToGain(VIDRO_VOLUMES.ambience);
    expect(ratio).toBeGreaterThan(expected * 0.85);
    expect(ratio).toBeLessThan(expected * 1.15);
    expect(rmsAt(none.mono, sr, 0, seconds)).toBeLessThan(1e-6);
    report.ambience = {
      rms: rmsAt(full.mono, sr, 3, seconds),
      peak: peak(full.mono),
      halfRatio: ratio,
      hits: hits.length,
      chimesOverBed: standOut,
    };
    if (write) {
      wav(join(wavDir, 'ambience-bench-30s.wav'), sr, [full.left, full.right]);
      const path = await lab(page, { kind: 'ambience', seconds, seed: 7, at: 'path' });
      wav(join(wavDir, 'ambience-path-30s.wav'), path.sampleRate, [path.left, path.right]);
      const far = await lab(page, { kind: 'ambience', seconds, seed: 7, at: 'far' });
      wav(join(wavDir, 'ambience-far-30s.wav'), far.sampleRate, [far.left, far.right]);
    }

    writeFileSync(join(out, `offline-${backend}.json`), JSON.stringify(report, null, 2));
    // the offline renders made no live context and need no gesture
    expect((await sound(page)).state).toBe('locked');
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-22 footfalls before the first gesture are never played, nor anything else of the room's steps after it [${backend}]`, async ({
    page,
  }) => {
    // S-35: the script goes on down the slope to the plaza (about 100 s of play)
    test.setTimeout(300_000);
    mkdirSync(out, { recursive: true });
    const errors = collectErrors(page);
    // the scripted play walks the whole way with no gesture: every footfall happens while there is no audio
    await page.goto(`/?scene=prologue-proto&direct=1&autoplay=1${webgl}`);
    const done = await waitRoom(page, 'r.autoplay && r.autoplay.done && r.dropTaken', 200_000);
    expect(done.footfalls, 'the script walked').toBeGreaterThan(10);
    let s = await sound(page);
    expect(s.state).toBe('locked');
    expect(s.footsteps.ready).toBe(false);
    // the first gesture starts the audio: the steps begin counting from now, none of the earlier ones comes out
    await page.mouse.click(640, 360);
    await waitSound(page, "s.state === 'running' && s.footsteps.ready", 15_000);
    await page.waitForTimeout(800);
    s = await sound(page);
    const r = await room(page);
    writeFileSync(
      join(out, `before-gesture-${backend}.json`),
      JSON.stringify({ backend, room: r, sound: s }, null, 2),
    );
    expect(s.footsteps.since).toBe(r.footfalls);
    expect(s.footsteps.count).toBe(0);
    expect(s.footsteps.voicesStarted).toBe(0);
    // the engine started nothing at all: no cue, no step (the ambience plays outside the voice allocator)
    expect(s.engineVoices).toBe(0);
    expect(s.ambience.playing).toBe(true);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-22 walking out of the workshop: the steps follow the floor, slower while peeking; wind, chimes and drops sound [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    mkdirSync(out, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&direct=1${webgl}`);
    await waitRoom(page, 'r.ready && r.playing', 60_000);
    // silent and without a context until the first gesture (AGENTS.md: S-16)
    const before = await sound(page);
    expect(before.state).toBe('locked');
    expect(before.ambience.playing).toBe(false);
    expect(before.footsteps.ready).toBe(false);

    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    const ready = await waitSound(
      page,
      "s.state === 'running' && s.footsteps.ready && s.ambience.playing",
      15_000,
    );
    expect(ready.room).toBe('workshop');
    expect(ready.panning.every((p) => p === 'HRTF')).toBe(true);
    // 拾う (the vidro is needed to peek)
    await waitRoom(page, "r.target === 'bench'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand'");

    const track = newTrack();
    await walkTo(page, track, 0.1, -1.3, 0.35);
    await walkTo(page, track, 0.1, -3.6, 0.35);
    await walkTo(page, track, 0, -7.2, 0.35);
    const walkedUntil = (await room(page)).time;
    // 覗く and keep walking: the body slows to half (移動50%), and so do the steps
    await lookAt(page, [0, 1.4, -30]);
    await page.mouse.down({ button: 'right' });
    const peeking = await waitRoom(page, 'r.peekAmount > 0.999');
    await walkFor(page, track, 5_500);
    await page.mouse.up({ button: 'right' });
    await waitRoom(page, 'r.peekAmount === 0');
    // keep listening until each ambience kind has been heard (the first chime may take a few seconds)
    const end = Date.now() + 25_000;
    // the far set (chimes:town) must have rung itself: the bell above the door (S-25) also feeds the chimes' ear
    const townPlays = async () =>
      (await both(page)).sound.ambience.sources.find((q) => q.id === 'chimes:town')?.plays ?? 0;
    while (
      Date.now() < end &&
      (track.heard.chimes === 0 || track.heard.drops === 0 || (await townPlays()) === 0)
    ) {
      await sample(page, track);
      await page.waitForTimeout(40);
    }

    const { room: r, sound: s } = await both(page);
    const log = s.footsteps.log;
    writeFileSync(
      join(out, `walk-${backend}.json`),
      JSON.stringify(
        { backend, room: r, footsteps: s.footsteps, ambience: s.ambience, heard: track.heard, errors },
        null,
        2,
      ),
    );
    expect(log.length).toBeGreaterThan(10);
    expectHonestSteps(log, track);
    expectOneStepPerFootfall(s, r);
    // the frosted glass of the workshop, then the stone of the way, changing at the door
    expect(runs(log.map((e) => e.material))).toEqual(['frosted', 'stone']);
    const firstStone = log.find((e) => e.material === 'stone') as FootstepEntry;
    expect(firstStone.z).toBeLessThan(-WORKSHOP_FLOOR_RADIUS);
    // the cadence: 2 steps a second walking (歩幅 0.7 m at 1.4 m/s), half that peeking
    const intervals = (from: number, to: number): number[] => {
      const ts = log.filter((e) => e.time > from && e.time < to).map((e) => e.time);
      return ts.slice(1).map((t, i) => t - (ts[i] as number));
    };
    const walking = median(intervals(walkedUntil - 4, walkedUntil));
    const slow = median(intervals(peeking.time + 0.5, Number.POSITIVE_INFINITY));
    expect(walking).toBeGreaterThan(0.44);
    expect(walking).toBeLessThan(0.58);
    expect(slow / walking).toBeGreaterThan(1.7);
    expect(slow / walking).toBeLessThan(2.3);
    // the ambience: the wind keeps blowing, a chime and a drop were heard, all through the probe's ears
    expect(track.heard.wind).toBeGreaterThan(1e-4);
    expect(track.heard.chimes).toBeGreaterThan(1e-4);
    expect(track.heard.drops).toBeGreaterThan(1e-4);
    const plays = (kind: string) =>
      s.ambience.sources.filter((q) => q.kind === kind).reduce((n, q) => n + q.plays, 0);
    expect(plays('chimes')).toBeGreaterThan(0);
    expect(
      s.ambience.sources.find((q) => q.id === 'chimes:town')?.plays ?? 0,
      'the far set rang',
    ).toBeGreaterThan(0);
    expect(plays('drops')).toBeGreaterThan(0);
    // one engine, every voice accounted for: the cue (拾う) and the steps
    expect(s.engineVoices).toBe(s.voicesStarted + s.footsteps.voicesStarted);
    expect(s.voicesStarted).toBe(s.playedCount);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-22 over the bridge: stone → the bridge's frosted glass → stone; the draws do not change with the sound [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    mkdirSync(out, { recursive: true });
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&direct=1&spawn=dead-end&dynres=0&quality=mid${webgl}`);
    await waitRoom(page, 'r.ready && r.playing', 60_000);
    await page.waitForTimeout(500);
    const counters = async (): Promise<{ draws: number[]; triangles: number[] }> => {
      const draws: number[] = [];
      const triangles: number[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await room(page);
        draws.push(r.drawCalls);
        triangles.push(r.triangles);
        await page.waitForTimeout(50);
      }
      return { draws, triangles };
    };
    const silent = await counters();
    expect((await sound(page)).state).toBe('locked');

    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitSound(page, "s.state === 'running' && s.ambience.playing && s.footsteps.ready", 15_000);
    await page.waitForTimeout(1_500);
    const sounding = await counters();
    expect(new Set(sounding.draws), 'draw calls with the sound running').toEqual(new Set(silent.draws));
    expect(new Set(sounding.triangles), 'triangles with the sound running').toEqual(
      new Set(silent.triangles),
    );

    // 置く, then cross
    const start = await room(page);
    await lookAt(page, start.layout.pedestalOrb);
    await waitRoom(page, "r.target === 'pedestal'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, 'r.bridgeColliders === r.bridgeSegments && r.bridgeSegments > 0');
    const track = newTrack();
    await walkTo(page, track, 0, EDGE_Z + 0.6, 0.3);
    await walkTo(page, track, 0, EDGE_Z - 1.4, 0.3);
    await walkTo(page, track, 0.3, FAR.maxZ - 1.2, 0.3);
    await page.waitForTimeout(300);

    const { room: r, sound: s } = await both(page);
    writeFileSync(
      join(out, `bridge-${backend}.json`),
      JSON.stringify({ backend, silent, sounding, room: r, footsteps: s.footsteps, errors }, null, 2),
    );
    const log = s.footsteps.log;
    expectHonestSteps(log, track);
    expectOneStepPerFootfall(s, r);
    expect(runs(log.map((e) => e.zone))).toEqual(['path', 'bridge', 'far']);
    expect(runs(log.map((e) => e.material))).toEqual(['stone', 'frosted', 'stone']);
    expect(log.filter((e) => e.zone === 'bridge').length).toBeGreaterThanOrEqual(3);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-22 through the home: the ambience waits for the workshop; the one engine's voices are the UI's, the cues' and the steps' [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    await page.goto(`/?scene=prologue-proto&quality=mid${webgl}`);
    await waitHome(page, 'p.load.ready === true', 90_000);
    expect((await sound(page)).ambience.playing).toBe(false);
    await page.locator('[data-ui="loading-start"]').click();
    await waitSound(page, "s.state === 'running' && s.ambience.ready", 15_000);
    await waitHome(page, "p.screen === 'home' && p.transition === null");
    // on the home screen the engine is running, but the workshop is not here yet. The probe's ears are put in the first
    // time its levels are read (src/audio/ambience.ts levels()): read once to put them in, then give them a while to
    // hear (a window is ~43 ms) before the reading that counts
    await sound(page);
    await page.waitForTimeout(1_500);
    let s = await sound(page);
    expect(s.ambience.playing, 'no workshop wind on the home screen').toBe(false);
    expect(s.ambience.levels.wind).toBe(0);

    await page.locator('[data-item="start"]').click();
    await waitHome(page, "p.screen === 'game' && p.transition === null", 60_000);
    await waitRoom(page, 'r.ready && r.playing');
    s = await waitSound(page, 's.ambience.playing', 5_000);
    await expect
      .poll(async () => (await sound(page)).ambience.levels.wind, { timeout: 5_000 })
      .toBeGreaterThan(1e-4);

    // a few steps in the workshop, then 拾う
    cursor.x = 640;
    cursor.y = 360;
    await page.mouse.move(cursor.x, cursor.y);
    await page.mouse.down();
    await page.mouse.up();
    await waitRoom(page, 'r.locked === true');
    const track = newTrack();
    await walkTo(page, track, 0.2, -1.4, 0.35);
    await walkTo(page, track, -1.2, -1.4, 0.35);
    await lookAt(page, [-1.55, 0.99, -2.28]);
    await waitRoom(page, "r.target === 'bench'", 5_000);
    await page.keyboard.press('KeyE');
    await waitRoom(page, "r.orb === 'hand'");
    await page.waitForTimeout(300);

    const now = await page.evaluate(() => {
      const p = window.__vidro.sceneProbe as { audioGate: GateProbe; sound: SoundProbe; room: RoomProbe };
      return { gate: { ...p.audioGate }, sound: { ...p.sound }, room: { ...p.room } };
    });
    writeFileSync(join(out, `home-${backend}.json`), JSON.stringify({ backend, ...now, errors }, null, 2));
    expect(now.sound.shared).toBe(true);
    expect(now.sound.footsteps.count).toBeGreaterThan(2);
    expectHonestSteps(now.sound.footsteps.log, track);
    expectOneStepPerFootfall(now.sound, now.room);
    expect(now.sound.voicesStarted).toBe(now.sound.playedCount);
    // every voice the page's one engine started is the UI's, a cue's or a step's (the ambience plays outside the
    // voice allocator, on its own schedule)
    expect(now.gate.voicesStarted).toBe(
      now.gate.uiVoices + now.sound.voicesStarted + now.sound.footsteps.voicesStarted,
    );
    expect(now.gate.voicesDropped).toBe(0);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
