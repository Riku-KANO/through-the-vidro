import { describe, expect, it } from 'vitest';
import { isInScale, midiToHz, noteName, scaleNotes } from '../core/audio/scale';
import { glassPitch, VIDRO_SCALE, VIDRO_SIZE_PITCH } from './tuning';

describe('the game is tuned to D major pentatonic', () => {
  it('contains exactly D E F# A B in every octave', () => {
    const names = scaleNotes(VIDRO_SCALE, 60, 71).map((m) => noteName(m).replace(/\d+$/, ''));
    expect(names).toEqual(['D', 'E', 'F#', 'A', 'B']);
    for (const m of [60, 67, 65, 63]) expect(isInScale(m, VIDRO_SCALE)).toBe(false); // C G F D#
  });
});

describe('glass pitch from size (bigger glass rings lower)', () => {
  const sizes = Array.from({ length: 200 }, (_, i) => 0.005 * 1.05 ** i); // 5 mm .. ~85 m

  it('is always a scale note in range and never rises as size grows', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const s of sizes) {
      const p = glassPitch(s);
      expect(isInScale(p.midi, VIDRO_SCALE), `size ${s}`).toBe(true);
      expect(p.midi).toBeGreaterThanOrEqual(VIDRO_SIZE_PITCH.minMidi);
      expect(p.midi).toBeLessThanOrEqual(VIDRO_SIZE_PITCH.maxMidi);
      expect(p.midi).toBeLessThanOrEqual(prev);
      expect(p.hz).toBeCloseTo(midiToHz(p.midi), 9);
      prev = p.midi;
    }
  });

  it('spans low for big objects and high for small ones', () => {
    expect(glassPitch(0.01).hz).toBeGreaterThan(1500);
    expect(glassPitch(5).hz).toBeLessThan(150);
    expect(glassPitch(0.15).midi - glassPitch(0.3).midi).toBe(12);
  });
});
