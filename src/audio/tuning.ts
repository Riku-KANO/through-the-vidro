/**
 * Through the Vidro's tuning (game rules; the generic math lives in src/core/audio/scale.ts).
 * Design doc: サウンドデザイン > 音階の統一 — ambience, glass, UI and music are all on D major pentatonic,
 * so sounds never clash however they overlap.
 * Design doc: サウンドデザイン > ガラスの音 — bigger objects ring lower, smaller ones higher.
 */
import {
  MAJOR_PENTATONIC,
  makeScale,
  type Pitch,
  pitchForSize,
  type SizePitchRule,
} from '../core/audio/scale';

/** D E F# A B (サウンドデザイン > 音階の統一). */
export const VIDRO_SCALE = makeScale('D major pentatonic', 2, MAJOR_PENTATONIC);

/**
 * Size → pitch for glass. f ∝ 1/size (one octave lower per doubling, サウンドデザイン > ガラスの音).
 * Tuning values (not in the design doc; to be confirmed by ear): a 10 cm glass rings at A5 (880 Hz,
 * wine-glass territory); range D2 (73 Hz) … D7 (2349 Hz).
 */
export const VIDRO_SIZE_PITCH: SizePitchRule = {
  refSize: 0.1,
  refMidi: 81,
  semitonesPerDoubling: 12,
  minMidi: 38,
  maxMidi: 98,
  scale: VIDRO_SCALE,
};

/** Scale note for a glass object of `size` metres (diameter / longest dimension). */
export function glassPitch(size: number): Pitch {
  return pitchForSize(size, VIDRO_SIZE_PITCH);
}
