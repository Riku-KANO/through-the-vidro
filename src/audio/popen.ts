/**
 * The hand orb's "po-pen" (game rule). Design doc: サウンドデザイン > ガラスの音 — the hand orb sounds
 * like a Nagasaki vidro (poppen) on peek / place / pick up; アセットリスト > 音 — ビードロの音 4:
 * 覗く、置く、拾う、震える. The synthesis is generic (src/core/audio/pop.ts); this file decides the notes.
 */
import type { AudioEngine } from '../core/audio/engine';
import { type PlayOptions, playPops } from '../core/audio/play';
import { designPops, type PopPattern, type PopScore, type PopTuning } from '../core/audio/pop';
import type { Rng } from '../core/audio/rng';

export const POPEN_KINDS = ['peek', 'place', 'pickup', 'tremble'] as const;
export type PopenKind = (typeof POPEN_KINDS)[number];

/**
 * Tuning values (not in the design doc; to be confirmed by ear). All notes on D major pentatonic
 * (VIDRO_SCALE). Each action has its own contour so they can be told apart without looking:
 *  peek    B5 → B5   level: the plain "po-pen" of the toy, the most frequent sound
 *  place   D6 → A5   falling fourth: settling down
 *  pickup  A5 → D6   rising fourth, quicker: lifting (mirror of place)
 *  tremble A5 / B5 alternating quickly and fading: the orb shivers
 */
export const POPEN_PATTERNS: Readonly<Record<PopenKind, PopPattern>> = {
  peek: { notes: [83, 83], spacing: 0.13, gain: 0.5, fade: 1, pair: true },
  place: { notes: [86, 81], spacing: 0.12, gain: 0.5, fade: 1, pair: true },
  pickup: { notes: [81, 86], spacing: 0.09, gain: 0.5, fade: 1, pair: true },
  tremble: { notes: [81, 83, 81, 83, 81, 83], spacing: 0.055, gain: 0.28, fade: 0.85, pair: false },
};

/**
 * Voicing of the pops (tuning values, to be confirmed by ear): in a pair the "po" is soft and short,
 * the "pen" brighter with a longer ringing tail (the "n").
 */
export const VIDRO_POP: PopTuning = {
  po: { gain: 0.7, bright: 0.25, t60: 0.12, glide: 0.06 },
  pen: { gain: 1, bright: 0.5, t60: 0.28, glide: 0.035 },
  plain: { gain: 1, bright: 0.35, t60: 0.08, glide: 0.035 },
  jitter: { time: 0.005, pitch: 0.002, levelDb: 1, t60: 0.1 },
};

export interface PopenScore extends PopScore {
  kind: PopenKind;
}

export function designPopen(kind: PopenKind, rng: Rng): PopenScore {
  return { kind, ...designPops(POPEN_PATTERNS[kind], rng, VIDRO_POP) };
}

/** Play the po-pen for an action now. Returns the score, or null if the engine refused it. */
export function playPopen(engine: AudioEngine, kind: PopenKind, opts: PlayOptions = {}): PopenScore | null {
  const score = playPops(engine, POPEN_PATTERNS[kind], { ...opts, tuning: VIDRO_POP });
  return score ? { kind, ...score } : null;
}
