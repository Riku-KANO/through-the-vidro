/**
 * Footsteps (S-22). Design doc: サウンドデザイン > 環境音 — 足音は床の材質ごとに変える(石畳、曇りガラス、真鍮の格子)。
 * 各8種類をランダムに使う; アセットリスト > 音 — 足音 24 = 3材質 × 8種.
 * Synthesized placeholders for now (制作方法: 足りない音はシンセサイザーで補う), each one a SoundSource so a recording can
 * take its place later without touching anything else (src/core/audio/bank.ts; the steps are in process/slices/S-22.md).
 * The glass and the brass ring on notes of the scale (音階の統一: 環境音も対象 — "歩くだけで小さな音楽が生まれます").
 * Every number here is a tuning value (仮), to be confirmed by ear.
 */

import { loadBank, type SoundSource, scheduleBuffer, synth } from '../core/audio/bank';
import {
  addPartials,
  Biquad,
  decayPerSample,
  fadeEnds,
  normalizePeak,
  type RingingPartial,
} from '../core/audio/dsp';
import type { AudioEngine, Emitter } from '../core/audio/engine';
import { GLASS_MODE_RATIOS } from '../core/audio/glass';
import { jitter, mulberry32, type Rng, randomSeed } from '../core/audio/rng';
import { midiToHz } from '../core/audio/scale';

export const FLOOR_MATERIALS = ['stone', 'frosted', 'brass'] as const;
/** 石畳 / 曇りガラス / 真鍮の格子. */
export type FloorMaterial = (typeof FLOOR_MATERIALS)[number];

/** アセットリスト > 音: 各8種. */
export const FOOTSTEP_VARIANTS = 8;

/** The note each frosted-glass step leaves the floor ringing on: a thick slab, low (D4 … F#5). */
export const FROSTED_RING_NOTES: readonly number[] = [62, 64, 66, 69, 71, 74, 76, 78];
/** The note each brass-grating step rings on: thin bars, higher (A4 … D6). */
export const BRASS_RING_NOTES: readonly number[] = [69, 71, 74, 76, 78, 81, 83, 86];

/** Free-free bar modes (a brass bar of the grating): ratio, relative level and ring (s) of each. */
const BAR_MODES: readonly { ratio: number; gain: number; t60: number }[] = [
  { ratio: 1, gain: 0.32, t60: 0.5 },
  { ratio: 2.756, gain: 0.16, t60: 0.3 },
  { ratio: 5.404, gain: 0.08, t60: 0.18 },
  { ratio: 8.933, gain: 0.04, t60: 0.1 },
];

/** Mix and variation (仮). */
export const FOOTSTEP_TUNING = {
  /** Peak level of a walking step at the feet (the po-pen is 0.5 at the hand). */
  level: 0.3,
  /**
   * Per step: ± playback rate (a hair of pitch and length) and ± dB. The ringing floors keep to a hair (±0.4 %, about
   * ±7 cents, like the glass's own jitter in glass-tuning.ts) so they stay on the scale; stone has no note to keep.
   */
  rateJitter: { stone: 0.03, frosted: 0.004, brass: 0.004 },
  levelJitterDb: 1.5,
  /** Peak of each rendered variant (the mix level comes from `level`). */
  renderPeak: 0.9,
} as const;

/* ---------- synthesis (pure) ---------- */

const MATERIAL_SEED: Readonly<Record<FloorMaterial, number>> = {
  stone: 0x5701e,
  frosted: 0xf2057,
  brass: 0xb2a55,
};

type Out = { x: Float32Array; sr: number; rng: Rng };

/** Filtered noise with an exponential decay, from `at` seconds (a contact, a scuff, a grain of grit). */
function noiseBurst(
  o: Out,
  at: number,
  shape: {
    level: number;
    t60: number;
    attack?: number;
    filter: (f: Biquad) => Biquad;
    filter2?: (f: Biquad) => Biquad;
  },
): void {
  const { x, sr, rng } = o;
  const f = shape.filter(new Biquad(sr));
  const f2 = shape.filter2?.(new Biquad(sr));
  const k = decayPerSample(shape.t60, sr);
  const attack = Math.max(1, Math.round((shape.attack ?? 0.0015) * sr));
  let env = shape.level;
  const from = Math.max(0, Math.round(at * sr));
  for (let i = from, n = 0; i < x.length && env > 1e-5; i++, n++) {
    let v = f.process(rng() * 2 - 1);
    if (f2) v = f2.process(v);
    const rise = n < attack ? n / attack : 1;
    x[i] = (x[i] as number) + v * env * rise;
    if (n >= attack) env *= k;
  }
}

/** A soft low body thump (the weight of the foot): a short, damped low sine. */
function thump(o: Out, at: number, hz: number, level: number, t60: number): void {
  addPartials(o.x, [{ hz, gain: level, t60 }], { start: at, attack: 0.004, sampleRate: o.sr });
}

/** 石畳: a soft sole on stone — a low thud, a gritty scuff, the toe a moment later. No ring. */
function stone(o: Out): void {
  const { rng } = o;
  const toe = 0.06 + rng() * 0.035;
  const heel = 0.85 + rng() * 0.15;
  thump(o, 0, 70 + rng() * 35, 0.9 * heel, 0.07 + rng() * 0.03);
  noiseBurst(o, 0, { level: 1.4 * heel, t60: 0.06, filter: (f) => f.lowpass(260 + rng() * 120, 0.9) });
  const scuff = 1500 + rng() * 1800;
  noiseBurst(o, 0.002, {
    level: 0.35 + rng() * 0.15,
    t60: 0.08 + rng() * 0.07,
    filter: (f) => f.bandpass(scuff, 0.8),
  });
  // grit under the sole: a few tiny bright grains
  const grains = 4 + Math.floor(rng() * 9);
  for (let g = 0; g < grains; g++) {
    const at = rng() * (toe + 0.05);
    const hz = 2800 + rng() * 3500;
    noiseBurst(o, at, {
      level: 0.12 + rng() * 0.18,
      t60: 0.006 + rng() * 0.01,
      attack: 0.0003,
      filter: (f) => f.bandpass(hz, 2),
    });
  }
  const toeLevel = 0.45 + rng() * 0.25;
  thump(o, toe, 95 + rng() * 40, 0.55 * toeLevel, 0.05);
  noiseBurst(o, toe, { level: 0.9 * toeLevel, t60: 0.045, filter: (f) => f.lowpass(380 + rng() * 150, 0.9) });
  noiseBurst(o, toe + 0.003, {
    level: 0.2 * toeLevel,
    t60: 0.05,
    filter: (f) => f.bandpass(scuff * 1.2, 0.9),
  });
}

/** 曇りガラス: a thick frosted slab — a hard short tock, a faint sandy hiss, and the slab left ringing on a note. */
function frosted(o: Out, variant: number): void {
  const { rng } = o;
  const toe = 0.065 + rng() * 0.03;
  const note = midiToHz(FROSTED_RING_NOTES[variant] as number);
  const tock = 1900 + rng() * 1300;
  thump(o, 0, 120 + rng() * 50, 0.55, 0.06);
  noiseBurst(o, 0, { level: 0.9, t60: 0.05, filter: (f) => f.lowpass(320, 0.8) });
  noiseBurst(o, 0, {
    level: 0.75,
    t60: 0.03 + rng() * 0.015,
    attack: 0.0004,
    filter: (f) => f.bandpass(tock, 1.3),
  });
  noiseBurst(o, 0.001, { level: 0.12, t60: 0.05, filter: (f) => f.highpass(5500, 0.7) });
  // the slab rings (damped by the foot): glass shell modes, the fundamental on the scale
  const ring: RingingPartial[] = [
    { hz: note, gain: 0.3, t60: 0.5 + rng() * 0.15 },
    { hz: note * 1.0015, gain: 0.1, t60: 0.45 },
    { hz: note * (GLASS_MODE_RATIOS[1] as number), gain: 0.05, t60: 0.3 },
    { hz: note * (GLASS_MODE_RATIOS[2] as number), gain: 0.015, t60: 0.15 },
  ];
  addPartials(o.x, ring, { start: 0.001, attack: 0.002, sampleRate: o.sr });
  const toeLevel = 0.4 + rng() * 0.2;
  noiseBurst(o, toe, {
    level: 0.7 * toeLevel,
    t60: 0.03,
    attack: 0.0004,
    filter: (f) => f.bandpass(tock * 1.15, 1.4),
  });
  noiseBurst(o, toe, { level: 0.5 * toeLevel, t60: 0.04, filter: (f) => f.lowpass(380, 0.8) });
  addPartials(o.x, [{ hz: note, gain: 0.08 * toeLevel, t60: 0.4 }], {
    start: toe,
    attack: 0.002,
    sampleRate: o.sr,
  });
}

/** 真鍮の格子: brass bars — a metallic clank on a note, the bars rattling against each other, the hollow underneath. */
function brass(o: Out, variant: number): void {
  const { rng } = o;
  const toe = 0.06 + rng() * 0.035;
  const note = midiToHz(BRASS_RING_NOTES[variant] as number);
  const bar = (at: number, level: number): void => {
    const partials: RingingPartial[] = BAR_MODES.map((mode, k) => ({
      hz: note * mode.ratio * (k === 0 ? 1 : 1 + jitter(rng, 0.01)),
      gain: level * mode.gain,
      t60: mode.t60 * (0.85 + rng() * 0.3),
    }));
    addPartials(o.x, partials, { start: at, attack: 0.0008, sampleRate: o.sr });
  };
  thump(o, 0, 80 + rng() * 25, 0.5, 0.12);
  noiseBurst(o, 0, { level: 0.6, t60: 0.06, filter: (f) => f.lowpass(240, 0.9) });
  noiseBurst(o, 0, {
    level: 0.6,
    t60: 0.02,
    attack: 0.0003,
    filter: (f) => f.bandpass(3200 + rng() * 1500, 1.5),
  });
  bar(0.0005, 1);
  // the grating's bars knocking: a few quick, fading clicks
  const rattles = 2 + Math.floor(rng() * 3);
  let at = 0.006;
  for (let r = 0; r < rattles; r++) {
    at += 0.007 + rng() * 0.016;
    const hz = 2600 + rng() * 2400;
    noiseBurst(o, at, {
      level: 0.35 * 0.7 ** r,
      t60: 0.012,
      attack: 0.0003,
      filter: (f) => f.bandpass(hz, 2.5),
    });
  }
  const toeLevel = 0.4 + rng() * 0.2;
  noiseBurst(o, toe, {
    level: 0.45 * toeLevel,
    t60: 0.02,
    attack: 0.0003,
    filter: (f) => f.bandpass(3600, 1.5),
  });
  bar(toe, 0.45 * toeLevel);
}

/** One footstep, the same every time for a material and variant (0..7). Mono, peak FOOTSTEP_TUNING.renderPeak. */
export function renderFootstep(material: FloorMaterial, variant: number, sampleRate: number): Float32Array {
  const seconds = material === 'stone' ? 0.32 : 0.6;
  const x = new Float32Array(Math.round(seconds * sampleRate));
  const o: Out = { x, sr: sampleRate, rng: mulberry32((MATERIAL_SEED[material] + variant * 7919) >>> 0) };
  if (material === 'stone') stone(o);
  else if (material === 'frosted') frosted(o, variant);
  else brass(o, variant);
  normalizePeak(x, FOOTSTEP_TUNING.renderPeak);
  // the last milliseconds fade out, so a step never ends on a click
  return fadeEnds(x, 0, Math.round(0.03 * sampleRate));
}

/** The 24 footsteps as sources (synthesized for now; swap an entry for `recording(...)` to use a file). */
export const FOOTSTEP_SOURCES: Readonly<Record<FloorMaterial, readonly SoundSource[]>> = Object.fromEntries(
  FLOOR_MATERIALS.map((m) => [
    m,
    Array.from({ length: FOOTSTEP_VARIANTS }, (_, v) =>
      synth(`step-${m}-${v + 1}`, (sr) => renderFootstep(m, v, sr)),
    ),
  ]),
) as unknown as Record<FloorMaterial, readonly SoundSource[]>;

/* ---------- choosing and playing ---------- */

/** The next variant: any of the `count`, never the `previous` one again (同じ音が続かないように). */
export function nextVariant(previous: number | null, count: number, rng: Rng): number {
  if (count <= 1) return 0;
  if (previous === null || previous < 0 || previous >= count) return Math.floor(rng() * count) % count;
  const pick = Math.floor(rng() * (count - 1)) % (count - 1);
  return pick >= previous ? pick + 1 : pick;
}

/**
 * How loud a step is for the body's speed relative to walking (仮): a slow, careful step while peeking is softer,
 * a hurried one a little louder; never silent, never more than +2 dB.
 */
export function footstepGain(speedRatio: number): number {
  const s = Number.isFinite(speedRatio) ? Math.max(0, speedRatio) : 1;
  return Math.min(1.25, 0.55 + 0.45 * Math.min(s, 1) + 0.35 * Math.max(0, s - 1));
}

export type FootstepBanks = Readonly<Record<FloorMaterial, readonly (AudioBuffer | null)[]>>;

export async function loadFootstepBanks(ctx: BaseAudioContext, signal?: AbortSignal): Promise<FootstepBanks> {
  const out = {} as Record<FloorMaterial, (AudioBuffer | null)[]>;
  for (const m of FLOOR_MATERIALS) out[m] = await loadBank(ctx, FOOTSTEP_SOURCES[m], { signal });
  return out;
}

/** Plays footsteps through the engine (admission and voice caps as any effect), never the same twice running. */
export class Footsteps {
  private readonly last: Record<FloorMaterial, number | null> = { stone: null, frosted: null, brass: null };

  constructor(
    private readonly banks: FootstepBanks,
    private readonly rng: Rng = mulberry32(randomSeed()),
  ) {}

  /** Whether any sound of `material` could be loaded (a floor with none stays silent). */
  has(material: FloorMaterial): boolean {
    return this.banks[material].some((b) => b);
  }

  /** One step on `material` from `emitter`, now. Null if the engine refused it, or the material has no sound. */
  play(
    engine: AudioEngine,
    emitter: Emitter,
    material: FloorMaterial,
    speedRatio: number,
  ): { variant: number } | null {
    const bank = this.banks[material];
    if (!this.has(material)) return null;
    let variant = nextVariant(this.last[material], bank.length, this.rng);
    // a variant that could not be loaded is skipped over
    for (let tries = 0; !bank[variant] && tries < bank.length; tries++) variant = (variant + 1) % bank.length;
    const buffer = bank[variant] as AudioBuffer;
    const t = FOOTSTEP_TUNING;
    const gain = t.level * footstepGain(speedRatio) * 10 ** (jitter(this.rng, t.levelJitterDb) / 20);
    const rate = 1 + jitter(this.rng, t.rateJitter[material]);
    const started = engine.startVoice({ level: gain, emitter }, (ctx, destination, when) =>
      scheduleBuffer(ctx, destination, buffer, when, { rate, gain }),
    );
    if (!started) return null;
    this.last[material] = variant;
    return { variant };
  }
}
