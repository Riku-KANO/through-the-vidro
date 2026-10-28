import { describe, expect, it } from 'vitest';
import { fadeArrived, fadeWhite, SIMPLE_FADE_SECONDS, simpleSpeed } from './fade';

describe('S-45 簡易トランジション (遷移のルール 1: 0.3秒の白いフェードに置き換えられる)', () => {
  it('lasts 0.3 s', () => {
    expect(SIMPLE_FADE_SECONDS).toBe(0.3);
  });

  it('goes up to white at its middle and down again: never darker than where it started (黒い画面を使わない)', () => {
    expect(fadeWhite(0)).toBe(0);
    expect(fadeWhite(0.25)).toBeCloseTo(0.5, 12);
    expect(fadeWhite(0.5)).toBe(1);
    expect(fadeWhite(0.75)).toBeCloseTo(0.5, 12);
    expect(fadeWhite(1)).toBe(0);
    for (let u = 0; u <= 1; u += 0.01) {
      expect(fadeWhite(u)).toBeGreaterThanOrEqual(0);
      expect(fadeWhite(u)).toBeLessThanOrEqual(1);
    }
    expect(fadeWhite(-1)).toBe(0);
    expect(fadeWhite(2)).toBe(0);
    expect(fadeWhite(Number.NaN)).toBe(0);
  });

  it('shows where it came from until the middle, where it goes from there (the swap is hidden under the white)', () => {
    expect(fadeArrived(0)).toBe(false);
    expect(fadeArrived(0.49)).toBe(false);
    expect(fadeArrived(0.5)).toBe(true);
    expect(fadeArrived(1)).toBe(true);
  });

  it('a longer transition runs that much faster to last the fade (the dive’s 2 s, the opening’s 1.5 s)', () => {
    expect(simpleSpeed(2)).toBeCloseTo(2 / 0.3, 12);
    expect(simpleSpeed(1.5) * SIMPLE_FADE_SECONDS).toBeCloseTo(1.5, 12);
    expect(simpleSpeed(0)).toBe(1);
  });
});
