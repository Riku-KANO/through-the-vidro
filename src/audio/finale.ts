/**
 * The close of the prologue (S-34): the sound of the drop's light settling the bridge, and of the gate at the back of the
 * far shore opening. Design doc: トランジション設計 > 遷移のルール6 (音を必ず添える: 目を閉じていても何が起きたか分かる);
 * サウンドデザイン > 音階の統一 (D メジャー・ペンタトニック), ガラスの音 (大きい物ほど低く).
 *  - 橋が定着する: light running across glass — a run of small glass tings climbing the scale as the light crosses (on the
 *    light's own curve, so each ting falls where the front is), over a soft chord of D and A that swells and lingers.
 *  - 門が開く: brass — the latch lifting, the hinges' low hum and a breath of air while the leaves swing, and the leaves
 *    coming to rest against their stops, one after the other.
 * Synthesized placeholders (制作方法: 足りない音はシンセサイザーで補う), each a SoundSource that a recording can replace in
 * `finaleSources` (src/core/audio/bank.ts; the steps in process/slices/S-22.md). The room plays them (game/prologue/
 * sound.ts) through the engine's voices, from where they happen. Every number here is a tuning value (仮), for the ear.
 */
import { loadBank, type SoundSource, synth } from '../core/audio/bank';
import {
  addPartials,
  Biquad,
  decayPerSample,
  fadeEnds,
  normalizePeak,
  type RingingPartial,
} from '../core/audio/dsp';
import { GLASS_MODE_RATIOS } from '../core/audio/glass';
import { mulberry32, type Rng } from '../core/audio/rng';
import { midiToHz } from '../core/audio/scale';
import { glassEase } from '../core/transition';

/** The run the light rings across the bridge: D5 E5 F#5 A5 B5 D6 E6 F#6 A6. */
export const SETTLE_RUN_NOTES: readonly number[] = [74, 76, 78, 81, 83, 86, 88, 90, 93];
/** The chord under it: D4 A4 D5. */
export const SETTLE_CHORD: readonly number[] = [62, 69, 74];
/** The gate's latch (a small brass catch, A5), the hinges' hum (D3, A3), the two leaves stopping (D4, E4). */
export const GATE_LATCH_NOTE = 81;
export const GATE_HUM_NOTES: readonly number[] = [50, 57];
export const GATE_KNOCK_NOTES: readonly number[] = [62, 64];

/** How loud each plays at its source (distance does the rest: HRTF, 1/d beyond 1 m). */
export const FINALE_LEVELS = { settle: 0.55, gate: 0.6 } as const;

/** Seconds the sound rings on after the light is across / after the leaves have stopped. */
const SETTLE_TAIL = 2.4;
const GATE_TAIL = 1.6;

/** Free-free bar modes of a brass part: ratio, relative level and ring (s) — the grating's (footsteps.ts), a little longer. */
const BRASS_MODES: readonly { ratio: number; gain: number; t60: number }[] = [
  { ratio: 1, gain: 0.32, t60: 0.7 },
  { ratio: 2.756, gain: 0.16, t60: 0.4 },
  { ratio: 5.404, gain: 0.08, t60: 0.22 },
  { ratio: 8.933, gain: 0.04, t60: 0.12 },
];

/** Filtered noise decaying from `at` seconds. */
function noise(
  x: Float32Array,
  sr: number,
  rng: Rng,
  at: number,
  shape: { level: number; t60: number; filter: (f: Biquad) => Biquad; attack?: number },
): void {
  const f = shape.filter(new Biquad(sr));
  const k = decayPerSample(shape.t60, sr);
  const attack = Math.max(1, Math.round((shape.attack ?? 0.0008) * sr));
  let env = shape.level;
  for (let i = Math.max(0, Math.round(at * sr)), n = 0; i < x.length && env > 1e-5; i++, n++) {
    x[i] = (x[i] as number) + f.process(rng() * 2 - 1) * env * (n < attack ? n / attack : 1);
    if (n >= attack) env *= k;
  }
}

/** A 0..1 → 0..1 curve, monotonic: how the light and the leaves move over their time. */
export type Ease = (x: number) => number;

/** The time (0..1 of the span) at which `ease` reaches `y`. */
function easeInverse(ease: Ease, y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The light crossing the bridge in `runSeconds` on `ease` (the room passes the curve its light moves on) and ringing on.
 * Mono, peak 0.9.
 */
export function renderSettle(sampleRate: number, runSeconds: number, ease: Ease = glassEase): Float32Array {
  const sr = sampleRate;
  const x = new Float32Array(Math.round((runSeconds + SETTLE_TAIL) * sr));
  const rng = mulberry32(0x5e771e);
  const n = SETTLE_RUN_NOTES.length;
  // a ting where the front stands at each step of the way, from the vidro to the far shore
  SETTLE_RUN_NOTES.forEach((midi, k) => {
    const at = 0.02 + easeInverse(ease, k / (n - 1)) * runSeconds * 0.97;
    const hz = midiToHz(midi);
    const level = 0.45 + 0.35 * (k / (n - 1));
    const ring = 1 - 0.35 * (k / (n - 1));
    const partials: RingingPartial[] = GLASS_MODE_RATIOS.map((ratio, m) => ({
      hz: hz * ratio * (1 + (rng() - 0.5) * 0.004),
      gain: level * ([1, 0.32, 0.14, 0.05][m] ?? 0),
      t60: ring * ([1.1, 0.6, 0.35, 0.2][m] ?? 0.2),
    }));
    addPartials(x, partials, { start: at, attack: 0.002, sampleRate: sr });
    // the glass's tiny tick as the light touches it
    noise(x, sr, rng, at, { level: 0.06, t60: 0.012, filter: (f) => f.highpass(4500, 0.7) });
  });
  // the chord: swells as the light leaves the vidro, holds while it crosses, lingers after
  const chord = SETTLE_CHORD.map((m) => ({
    w: (2 * Math.PI * midiToHz(m)) / sr,
    phase: rng() * Math.PI * 2,
  }));
  const rise = Math.round(runSeconds * 0.35 * sr);
  const hold = Math.round(runSeconds * sr);
  const fall = decayPerSample(2.2, sr);
  let env = 0;
  // the air of it: a breath of high noise along the run
  const air = new Biquad(sr).highpass(5200, 0.7);
  for (let i = 0; i < x.length; i++) {
    if (i < rise) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
    else if (i > hold) env *= fall;
    else env = 1;
    let v = 0;
    for (const c of chord) v += Math.sin(c.phase + c.w * i);
    const breath = i < hold ? Math.sin((Math.PI * i) / hold) : 0;
    x[i] = (x[i] as number) + v * 0.07 * env + air.process(rng() * 2 - 1) * 0.035 * breath;
  }
  normalizePeak(x, 0.9);
  return fadeEnds(x, 0, Math.round(0.08 * sr));
}

/** The gate unlatching and its two leaves swinging open over `swingSeconds` on `ease`, then stopping. Mono, peak 0.9. */
export function renderGateOpen(
  sampleRate: number,
  swingSeconds: number,
  ease: Ease = glassEase,
): Float32Array {
  const sr = sampleRate;
  const x = new Float32Array(Math.round((swingSeconds + GATE_TAIL) * sr));
  const rng = mulberry32(0x6a7e0);
  const bar = (at: number, midi: number, level: number): void => {
    const hz = midiToHz(midi);
    addPartials(
      x,
      BRASS_MODES.map((m, k) => ({
        hz: hz * m.ratio * (k === 0 ? 1 : 1 + (rng() - 0.5) * 0.01),
        gain: level * m.gain,
        t60: m.t60,
      })),
      { start: at, attack: 0.0008, sampleRate: sr },
    );
  };
  // the latch: a bright catch lifting, a small clunk
  const latch = 0.004;
  bar(latch, GATE_LATCH_NOTE, 2.2);
  noise(x, sr, rng, latch, { level: 0.55, t60: 0.015, filter: (f) => f.bandpass(3200, 1.6) });
  noise(x, sr, rng, latch + 0.012, { level: 0.5, t60: 0.05, filter: (f) => f.lowpass(320, 0.8) });
  // the swing: the hinges' low hum and the air moved, both as fast as the leaves go (the slope of their curve)
  const start = 0.05;
  const swing = Math.round(swingSeconds * sr);
  const hums = GATE_HUM_NOTES.map((m) => ({
    w: (2 * Math.PI * midiToHz(m)) / sr,
    phase: rng() * Math.PI * 2,
  }));
  const breath = new Biquad(sr).bandpass(560, 0.7);
  const s0 = Math.round(start * sr);
  let peakSpeed = 0;
  const speedAt = (u: number): number => (ease(Math.min(1, u + 0.005)) - ease(Math.max(0, u - 0.005))) / 0.01;
  for (let u = 0; u <= 1; u += 0.01) peakSpeed = Math.max(peakSpeed, speedAt(u));
  for (let i = s0; i < Math.min(x.length, s0 + swing); i++) {
    const u = (i - s0) / swing;
    const speed = speedAt(u) / peakSpeed;
    let v = 0;
    for (const h of hums) v += Math.sin(h.phase + h.w * i) * (1 + 0.15 * Math.sin(h.w * 0.013 * i));
    x[i] = (x[i] as number) + v * 0.045 * speed + breath.process(rng() * 2 - 1) * 0.22 * speed;
  }
  // the leaves coming to rest against their stops, the second a moment after the first
  const end = start + swingSeconds;
  GATE_KNOCK_NOTES.forEach((midi, k) => {
    const at = end - 0.06 + k * 0.11;
    bar(at, midi, 1.1 - 0.25 * k);
    noise(x, sr, rng, at, { level: 0.35, t60: 0.05, filter: (f) => f.lowpass(220, 0.8) });
  });
  normalizePeak(x, 0.9);
  return fadeEnds(x, 0, Math.round(0.08 * sr));
}

/**
 * The close's two sounds as sources, timed to the room's close (session.ts: how long the light takes across, how long the
 * gate swings). To use a recording, swap a row for `recording(id, ...urls)`.
 */
export function finaleSources(timing: { settleSeconds: number; gateSeconds: number; ease?: Ease }): {
  settle: SoundSource;
  gate: SoundSource;
} {
  const ease = timing.ease ?? glassEase;
  return {
    settle: synth('finale-settle', (sr) => renderSettle(sr, timing.settleSeconds, ease)),
    gate: synth('finale-gate-open', (sr) => renderGateOpen(sr, timing.gateSeconds, ease)),
  };
}

export interface FinaleBanks {
  settle: AudioBuffer | null;
  gate: AudioBuffer | null;
}

export async function loadFinaleBanks(
  ctx: BaseAudioContext,
  sources: { settle: SoundSource; gate: SoundSource },
  signal?: AbortSignal,
): Promise<FinaleBanks> {
  const [settle = null, gate = null] = await loadBank(ctx, [sources.settle, sources.gate], { signal });
  return { settle, gate };
}
