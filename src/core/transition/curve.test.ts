import { describe, expect, it } from 'vitest';
import { GLASS_EASE_CSS, glassEase } from './curve';

const samples = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('glassEase (トランジション設計 > 遷移のルール 5)', () => {
  it('starts at 0 and ends exactly at 1', () => {
    expect(glassEase(0)).toBe(0);
    expect(glassEase(1)).toBe(1);
  });

  it('holds its end values outside the 0..1 range', () => {
    expect(glassEase(-0.5)).toBe(0);
    expect(glassEase(1.5)).toBe(1);
    expect(glassEase(Number.NaN)).toBe(0);
  });

  it('never moves backwards and never overshoots the destination', () => {
    let prev = 0;
    for (const x of samples(2000)) {
      const y = glassEase(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
  });

  it('starts slowly: the first tenth of the time covers only a sliver of the way', () => {
    expect(glassEase(0.1)).toBeLessThan(0.05);
    // initial speed close to zero (no jolt at the start)
    expect(glassEase(0.01) / 0.01).toBeLessThan(0.2);
  });

  it('sticks while stopping: still creeping in the last stretch, then settles with no jolt', () => {
    const remainingAt90 = 1 - glassEase(0.9);
    expect(remainingAt90).toBeGreaterThan(0);
    expect(remainingAt90).toBeLessThan(0.02);
    // final speed close to zero
    expect((1 - glassEase(0.99)) / 0.01).toBeLessThan(0.2);
  });

  it('spends most of its motion in the middle', () => {
    expect(glassEase(0.6) - glassEase(0.3)).toBeGreaterThan(0.5);
  });

  it('is available as the same curve for DOM animations', () => {
    expect(GLASS_EASE_CSS).toMatch(/^cubic-bezier\(/);
  });
});
