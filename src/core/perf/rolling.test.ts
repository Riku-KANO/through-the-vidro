import { describe, expect, it } from 'vitest';
import { RollingWindow } from './rolling';

const filled = (size: number, values: number[]) => {
  const w = new RollingWindow(size);
  for (const v of values) w.push(v);
  return w;
};

describe('RollingWindow', () => {
  it('keeps the last `size` samples', () => {
    const w = filled(3, [9, 1, 2, 3]);
    expect(w.full).toBe(true);
    expect(w.mean()).toBe(2);
    expect(w.median()).toBe(2);
  });

  it('is not full until `size` samples arrived, and reads 0 when empty', () => {
    const w = new RollingWindow(5);
    expect(w.median()).toBe(0);
    expect(w.quantile(0.9)).toBe(0);
    expect(w.mean()).toBe(0);
    w.push(4);
    expect(w.full).toBe(false);
    expect(w.median()).toBe(4);
  });

  it('median: the middle sample, the upper one of the two middles for an even count', () => {
    expect(filled(5, [5, 1, 4, 2, 3]).median()).toBe(3);
    expect(filled(4, [4, 1, 3, 2]).median()).toBe(3);
  });

  it('quantile: nearest rank, as percentile() in core/bench.ts', () => {
    const w = filled(15, [15, 1, 14, 2, 13, 3, 12, 4, 11, 5, 10, 6, 9, 7, 8]);
    expect(w.quantile(0.9)).toBe(14);
    expect(w.quantile(0.5)).toBe(8);
    expect(w.quantile(0)).toBe(1);
    expect(w.quantile(1)).toBe(15);
  });

  it('does not reorder the samples it keeps (the next push still drops the oldest)', () => {
    const w = filled(3, [3, 1, 2]);
    w.median();
    w.push(10);
    expect(w.mean()).toBeCloseTo(13 / 3);
  });
});
