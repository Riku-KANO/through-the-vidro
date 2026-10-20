/**
 * Musical scale math. Pure functions, no Web Audio.
 * Design doc: サウンドデザイン > 音階の統一 — everything (ambience, glass, UI, music) is tuned to
 * D major pentatonic, so any combination of sounds stays consonant.
 * Design doc: サウンドデザイン > ガラスの音 — bigger objects ring lower, smaller ones higher.
 */

export interface Scale {
  readonly name: string;
  /** Pitch class of the root, 0 = C … 11 = B. */
  readonly rootPitchClass: number;
  /** Semitone offsets from the root, ascending, within one octave. */
  readonly intervals: readonly number[];
}

/** D E F# A B (サウンドデザイン > 音階の統一). */
export const D_MAJOR_PENTATONIC: Scale = {
  name: 'D major pentatonic',
  rootPitchClass: 2,
  intervals: [0, 2, 4, 7, 9],
};

const A4_MIDI = 69;
const A4_HZ = 440;
const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Equal temperament, A4 = 440 Hz. MIDI may be fractional. */
export function midiToHz(midi: number): number {
  return A4_HZ * 2 ** ((midi - A4_MIDI) / 12);
}

export function hzToMidi(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

/** Scientific pitch name, e.g. 62 → "D4", 66 → "F#4". */
export function noteName(midi: number): string {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return `${PITCH_CLASS_NAMES[pc]}${Math.floor(m / 12) - 1}`;
}

export function isInScale(midi: number, scale: Scale = D_MAJOR_PENTATONIC): boolean {
  if (!Number.isInteger(midi)) return false;
  const rel = (((midi - scale.rootPitchClass) % 12) + 12) % 12;
  return scale.intervals.includes(rel);
}

/** All scale notes in [lowMidi, highMidi], ascending. */
export function scaleNotes(scale: Scale, lowMidi: number, highMidi: number): number[] {
  const out: number[] = [];
  for (let m = Math.ceil(lowMidi); m <= Math.floor(highMidi); m++) if (isInScale(m, scale)) out.push(m);
  return out;
}

/** Nearest scale note to a (fractional) MIDI pitch. Ties resolve downward so the mapping stays monotonic. */
export function snapToScale(midi: number, scale: Scale = D_MAJOR_PENTATONIC): number {
  const below = Math.floor(midi);
  let lo = below;
  while (!isInScale(lo, scale)) lo--;
  let hi = below + 1;
  while (!isInScale(hi, scale)) hi++;
  return midi - lo <= hi - midi ? lo : hi;
}

/** Move `steps` scale degrees from a scale note (negative = down). */
export function scaleStep(midi: number, steps: number, scale: Scale = D_MAJOR_PENTATONIC): number {
  let m = snapToScale(midi, scale);
  const dir = Math.sign(steps);
  for (let i = 0; i < Math.abs(steps); i++) {
    m += dir;
    while (!isInScale(m, scale)) m += dir;
  }
  return m;
}

/**
 * Rule for choosing a pitch from an object's size.
 * A vibrating shell scaled up uniformly drops in frequency as f ∝ 1/size, i.e. one octave (12 semitones)
 * per doubling — the "physically natural" mapping the design doc asks for. The result is clamped to a
 * playable range and snapped to the scale.
 */
export interface SizePitchRule {
  /** Characteristic size in metres (diameter / longest dimension) that rings at refMidi. */
  readonly refSize: number;
  readonly refMidi: number;
  readonly semitonesPerDoubling: number;
  readonly minMidi: number;
  readonly maxMidi: number;
  readonly scale: Scale;
}

/**
 * Defaults (tuning values, not from the design doc; to be confirmed by ear):
 * a 10 cm glass rings at A5 (880 Hz, wine-glass territory); range D2 (73 Hz) … D7 (2349 Hz).
 */
export const DEFAULT_SIZE_PITCH: SizePitchRule = {
  refSize: 0.1,
  refMidi: 81,
  semitonesPerDoubling: 12,
  minMidi: 38,
  maxMidi: 98,
  scale: D_MAJOR_PENTATONIC,
};

export interface Pitch {
  midi: number;
  hz: number;
  name: string;
}

/** Scale note for an object of `size` metres. Never rises when size grows. */
export function pitchForSize(size: number, rule: SizePitchRule = DEFAULT_SIZE_PITCH): Pitch {
  const safe = Math.max(size, 1e-6);
  const raw = rule.refMidi - rule.semitonesPerDoubling * Math.log2(safe / rule.refSize);
  const clamped = Math.min(rule.maxMidi, Math.max(rule.minMidi, raw));
  let midi = snapToScale(clamped, rule.scale);
  if (midi > rule.maxMidi) midi = scaleStep(midi, -1, rule.scale);
  if (midi < rule.minMidi) midi = scaleStep(midi, 1, rule.scale);
  return { midi, hz: midiToHz(midi), name: noteName(midi) };
}
