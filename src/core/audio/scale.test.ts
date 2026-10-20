import { describe, expect, it } from 'vitest';
import {
  D_MAJOR_PENTATONIC,
  DEFAULT_SIZE_PITCH,
  hzToMidi,
  isInScale,
  midiToHz,
  noteName,
  pitchForSize,
  scaleNotes,
  scaleStep,
  snapToScale,
} from './scale';

describe('D major pentatonic', () => {
  it('contains exactly D E F# A B in every octave', () => {
    const names = scaleNotes(D_MAJOR_PENTATONIC, 60, 71).map((m) => noteName(m).replace(/\d+$/, ''));
    expect(names).toEqual(['D', 'E', 'F#', 'A', 'B']);
    for (const m of scaleNotes(D_MAJOR_PENTATONIC, 24, 108)) {
      expect(['D', 'E', 'F#', 'A', 'B']).toContain(noteName(m).replace(/-?\d+$/, ''));
    }
  });

  it('rejects notes outside the scale (C, G, F, D#)', () => {
    for (const m of [60, 67, 65, 63]) expect(isInScale(m)).toBe(false);
    for (const m of [62, 64, 66, 69, 71]) expect(isInScale(m)).toBe(true);
  });

  it('uses equal temperament with A4 = 440 Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(62)).toBeCloseTo(293.665, 2); // D4
    expect(midiToHz(74)).toBeCloseTo(587.33, 1); // D5
    expect(hzToMidi(midiToHz(66.25))).toBeCloseTo(66.25, 9);
  });

  it('snaps any pitch to the nearest scale note', () => {
    for (let m = 30; m <= 100; m += 0.37) {
      const snapped = snapToScale(m);
      expect(isInScale(snapped)).toBe(true);
      const best = Math.min(...scaleNotes(D_MAJOR_PENTATONIC, 20, 110).map((n) => Math.abs(n - m)));
      expect(Math.abs(snapped - m)).toBeCloseTo(best, 9);
    }
  });

  it('steps up and down by scale degrees', () => {
    expect(scaleStep(62, 1)).toBe(64); // D4 -> E4
    expect(scaleStep(62, 5)).toBe(74); // five degrees = one octave
    expect(scaleStep(69, -1)).toBe(66); // A4 -> F#4
    expect(scaleStep(62, 0)).toBe(62);
  });
});

describe('pitch from size (bigger glass rings lower)', () => {
  const sizes = Array.from({ length: 200 }, (_, i) => 0.005 * 1.05 ** i); // 5 mm .. ~85 m

  it('always lands on a scale note inside the allowed range', () => {
    for (const s of sizes) {
      const p = pitchForSize(s);
      expect(isInScale(p.midi), `size ${s}`).toBe(true);
      expect(p.midi).toBeGreaterThanOrEqual(DEFAULT_SIZE_PITCH.minMidi);
      expect(p.midi).toBeLessThanOrEqual(DEFAULT_SIZE_PITCH.maxMidi);
      expect(p.hz).toBeCloseTo(midiToHz(p.midi), 9);
    }
  });

  it('never rises when the object gets bigger', () => {
    for (let i = 1; i < sizes.length; i++) {
      expect(pitchForSize(sizes[i] as number).midi).toBeLessThanOrEqual(
        pitchForSize(sizes[i - 1] as number).midi,
      );
    }
  });

  it('spans low for big objects and high for small ones', () => {
    expect(pitchForSize(0.01).hz).toBeGreaterThan(1500);
    expect(pitchForSize(5).hz).toBeLessThan(150);
  });

  it('drops one octave when the size doubles (f ∝ 1/size), within the range', () => {
    expect(pitchForSize(0.15).midi - pitchForSize(0.3).midi).toBe(12);
    expect(pitchForSize(0.07).midi - pitchForSize(0.14).midi).toBe(12);
  });

  it('maps the reference size to the reference note', () => {
    expect(pitchForSize(DEFAULT_SIZE_PITCH.refSize).midi).toBe(DEFAULT_SIZE_PITCH.refMidi);
  });
});
