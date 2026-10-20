/**
 * How glass sounds in Through the Vidro (tuning values for the generic modal synth in
 * src/core/audio/glass.ts). Design doc: サウンドデザイン > ガラスの音 — touch / tap / hit × size.
 * None of these numbers are in the design doc; they are starting points to be confirmed by ear.
 */
import type { AudioEngine } from '../core/audio/engine';
import type { GlassStrength, GlassTuning, GlassVoice } from '../core/audio/glass';
import { type PlayOptions, playGlass } from '../core/audio/play';
import { glassPitch } from './tuning';

export const VIDRO_GLASS: GlassTuning = {
  strengths: {
    // A finger brushing the glass: soft, slow swell, no click, damped by the touch.
    touch: { level: 0.2, brightness: 0.12, attack: 0.012, strike: 0, strikeDuration: 0, ring: 0.6 },
    // A fingernail / knuckle tap.
    tap: { level: 0.45, brightness: 0.35, attack: 0.002, strike: 0.07, strikeDuration: 0.006, ring: 1 },
    // A glass orb hitting it: loud, bright, sharp click.
    hit: { level: 0.75, brightness: 0.6, attack: 0.0005, strike: 0.12, strikeDuration: 0.004, ring: 1 },
  },
  // ~1.6 s for a 10 cm glass, longer for bigger ones (0.5 … 6 s).
  ring: { refSize: 0.1, t60: 1.6, exponent: 0.35, min: 0.5, max: 6 },
  modeDamping: 0.7,
  strike: { centerRatio: 3.5, q: 1.2, minHz: 1500 },
  jitter: {
    // ±0.35 % ≈ ±6 cents: alive, still clearly on the scale note.
    detune: 0.0035,
    modeRatio: 0.006,
    modeGain: 0.2,
    t60: 0.1,
    levelDb: 1,
    splitMin: 0.0005,
    splitMax: 0.0025,
    splitGain: 0.35,
    strikeHz: 0.15,
  },
};

/** Strike a glass object of `size` metres: pitch from the game's size rule, sound from VIDRO_GLASS. */
export function strikeGlass(
  engine: AudioEngine,
  size: number,
  strength: GlassStrength,
  opts: PlayOptions = {},
): GlassVoice | null {
  return playGlass(engine, { hz: glassPitch(size).hz, size, strength }, { ...opts, tuning: VIDRO_GLASS });
}
