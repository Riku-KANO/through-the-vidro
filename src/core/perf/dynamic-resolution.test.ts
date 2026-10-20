import { describe, expect, it } from 'vitest';
import { type CostBasis, DynamicResolution } from './dynamic-resolution';

const TARGET = 1000 / 60;
const DT = 1 / 60;

/** Feeds `seconds` of samples; cost may depend on the current scale. Returns the number of scale changes. */
function run(
  dr: DynamicResolution,
  cost: number | ((scale: number) => number),
  seconds: number,
  basis: CostBasis = 'gpu',
): number {
  let changes = 0;
  for (let t = 0; t < seconds; t += DT) {
    const c = typeof cost === 'number' ? cost : cost(dr.scale);
    if (dr.update(c, basis, DT) !== null) changes++;
  }
  return changes;
}

/** GPU-bound cost that scales with pixel count. */
const pixelBound =
  (msAtMax: number, max = 0.85) =>
  (scale: number) =>
    msAtMax * (scale / max) ** 2;

describe('DynamicResolution (GPU time)', () => {
  it('starts at the preset maximum', () => {
    expect(new DynamicResolution({ min: 0.5, max: 0.85 }).scale).toBe(0.85);
  });

  it('waits one cooldown before the first change (startup hitches, shader compiles)', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    expect(run(dr, TARGET * 3, 0.5)).toBe(0);
  });

  it('lowers the scale under sustained overload, never below min', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET * 1.5, 2.5);
    expect(dr.scale).toBeLessThan(0.85);
    run(dr, TARGET * 3, 30);
    expect(dr.scale).toBe(0.5);
  });

  it('raises the scale again when the GPU has room, never above max', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET * 3, 30);
    run(dr, TARGET * 0.4, 40);
    expect(dr.scale).toBe(0.85);
  });

  it('settles where the cost fits instead of hunting', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, pixelBound(TARGET * 1.2), 20);
    const settled = dr.scale;
    expect(settled).toBeLessThan(0.85);
    expect(run(dr, pixelBound(TARGET * 1.2), 30)).toBe(0);
    expect(dr.scale).toBe(settled);
  });

  it('ignores one or two spikes', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET * 0.5, 2);
    dr.update(200, 'gpu', DT);
    dr.update(200, 'gpu', DT);
    expect(run(dr, TARGET * 0.5, 0.5)).toBe(0);
    expect(dr.scale).toBe(0.85);
  });

  it('waits a cooldown between changes so render targets are not reallocated every frame', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 1, cooldownSec: 1 });
    expect(run(dr, TARGET * 3, 1.9)).toBeLessThanOrEqual(1);
  });

  it('forgets the smoothed cost when the basis changes', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET, 1, 'frame');
    expect(run(dr, 3, 3, 'gpu')).toBe(0);
  });
});

describe('DynamicResolution (frame time only)', () => {
  it('does not read vsync-capped frame time as overload', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    expect(run(dr, TARGET, 10, 'frame')).toBe(0);
  });

  it('ignores a single long frame and two missed vsyncs in a row', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, TARGET, 2, 'frame');
    dr.update(48, 'frame', DT);
    run(dr, TARGET, 1, 'frame');
    dr.update(33.3, 'frame', DT);
    dr.update(33.3, 'frame', DT);
    expect(run(dr, TARGET, 3, 'frame')).toBe(0);
    expect(dr.scale).toBe(0.85);
  });

  it('lowers the scale when lowering it actually helps', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    run(dr, pixelBound(TARGET * 1.6), 8, 'frame');
    expect(dr.scale).toBeLessThan(0.85);
  });

  it('reverts and holds when a lower scale does not help (a 30 fps cap, not overload)', () => {
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    const changes = run(dr, 33.3, 30, 'frame');
    expect(dr.scale).toBe(0.85);
    expect(changes).toBeLessThanOrEqual(2);
  });

  it('backs off instead of oscillating at a boundary', () => {
    // Over budget above 0.8, vsync-capped at or below it: the classic up/down loop.
    const dr = new DynamicResolution({ min: 0.5, max: 0.85 });
    const changes = run(dr, (s) => (s > 0.8 ? 21 : TARGET), 60, 'frame');
    expect(changes).toBeLessThanOrEqual(8);
  });
});
