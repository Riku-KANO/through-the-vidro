/**
 * 玉のささやき (S-39; ヒント設計 2, 設計書 rev 49: 台座の玉がかすかに光り、小さく鳴って知らせる): the vidro left behind on its pedestal
 * rings faintly where it stands while it calls, so the ear finds it as well as the eye. A small glass ring, not a strike:
 * the vidro's own note (サウンドデザイン > ガラスの音: the same glass rings at its pitch — D5 for its 15 cm) swelling in softly,
 * as if touched from inside, and a smaller note a fifth above answering it, with a breath of air over both.
 * Design doc: サウンドデザイン > 音階の統一 (D メジャー・ペンタトニック).
 * A synthesized placeholder (制作方法: 足りない音はシンセサイザーで補う): a SoundSource that a recording can replace in
 * `whisperSource` (src/core/audio/bank.ts; the steps in process/slices/S-22.md). The room plays it (game/prologue/sound.ts)
 * through the engine's voices, from where the vidro stands. Every number here is a tuning value (仮), for the ear.
 */
import { loadBank, type SoundSource, synth } from '../core/audio/bank';
import { addPartials, Biquad, fadeEnds, normalizePeak, type RingingPartial } from '../core/audio/dsp';
import { GLASS_MODE_RATIOS } from '../core/audio/glass';
import { mulberry32 } from '../core/audio/rng';
import { midiToHz } from '../core/audio/scale';

/** The vidro's note (D5, its 15 cm: tuning.ts glassPitch), then A5 answering it. */
export const WHISPER_NOTES: readonly number[] = [74, 81];

/**
 * How loud it plays at its source (distance does the rest: HRTF, 1/d beyond 1 m). Below the close's: a hint. From the film
 * (about 7 m) it stands about twice over the room's own sounds in its band (tests/e2e/S-39-*.spec.ts).
 */
export const WHISPER_LEVEL = 0.5;

/** When each note starts (s), how loud, how long it swells in (s) and rings (t60 of its lowest mode, s). */
const NOTE_SHAPE: readonly { at: number; gain: number; swell: number; ring: number }[] = [
  { at: 0.0, gain: 1.0, swell: 0.045, ring: 1.5 },
  { at: 0.17, gain: 0.55, swell: 0.03, ring: 1.1 },
];
/** The glass's modes: relative level and ring (as a share of the note's), softer in the upper ones than a strike's. */
const MODES: readonly { gain: number; ring: number }[] = [
  { gain: 1, ring: 1 },
  { gain: 0.18, ring: 0.55 },
  { gain: 0.06, ring: 0.35 },
  { gain: 0.02, ring: 0.2 },
];
/** Seconds it lasts, its tail faded out over the last FADE_OUT. */
const LENGTH = 1.9;
const FADE_OUT = 0.25;

/** A soft swell over `swell` seconds then a ring of `t60` seconds, added at `at` (a sine-shaped rise: no click). */
function swellPartials(
  x: Float32Array,
  sr: number,
  partials: readonly RingingPartial[],
  at: number,
  swell: number,
): void {
  const ring = new Float32Array(x.length);
  addPartials(ring, partials, { start: at, attack: 0, sampleRate: sr });
  const from = Math.round(at * sr);
  const rise = Math.max(1, Math.round(swell * sr));
  for (let i = from; i < x.length; i++) {
    const n = i - from;
    const env = n < rise ? 0.5 - 0.5 * Math.cos((Math.PI * n) / rise) : 1;
    x[i] = (x[i] as number) + (ring[i] as number) * env;
  }
}

/** The whisper, mono, peak 0.9. */
export function renderWhisper(sampleRate: number): Float32Array {
  const sr = sampleRate;
  const x = new Float32Array(Math.round(LENGTH * sr));
  const rng = mulberry32(0x5a5a1);
  WHISPER_NOTES.forEach((midi, k) => {
    const shape = NOTE_SHAPE[k];
    if (!shape) return;
    const hz = midiToHz(midi);
    const partials: RingingPartial[] = GLASS_MODE_RATIOS.map((ratio, m) => ({
      hz: hz * ratio * (m === 0 ? 1 : 1 + (rng() - 0.5) * 0.004),
      gain: shape.gain * (MODES[m]?.gain ?? 0),
      t60: shape.ring * (MODES[m]?.ring ?? 0.2),
    }));
    swellPartials(x, sr, partials, shape.at, shape.swell);
  });
  // a breath of air over it, as the glass is touched: high, faint, gone in half a second
  const air = new Biquad(sr).bandpass(6200, 0.9);
  const breath = Math.round(0.5 * sr);
  for (let i = 0; i < breath; i++) {
    const env = Math.sin((Math.PI * i) / breath) ** 2;
    x[i] = (x[i] as number) + air.process(rng() * 2 - 1) * 0.02 * env;
  }
  normalizePeak(x, 0.9);
  return fadeEnds(x, Math.round(0.002 * sr), Math.round(FADE_OUT * sr));
}

/** The whisper as a source. To use a recording, swap this for `recording('vidro-whisper', ...urls)`. */
export function whisperSource(): SoundSource {
  return synth('vidro-whisper', renderWhisper);
}

/** The whisper's buffer on `ctx`, or null when it could not be had (the room then stays silent and says so). */
export async function loadWhisperBank(
  ctx: BaseAudioContext,
  source: SoundSource,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  const [buffer = null] = await loadBank(ctx, [source], { signal });
  return buffer;
}
