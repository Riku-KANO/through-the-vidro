import { describe, expect, it } from 'vitest';
import { splitFooting } from './footing';
import { type SettleSweep, settledAt, settledSegmentIds, sweepFront, sweepSpan } from './settle';
import { splitSurface } from './surface';

/** Light running through a 2 × 2.5 × 4 m box toward -Z (like the prologue's across its bridge). */
const sweep: SettleSweep = { box: { min: [-1, -0.5, -4], max: [1, 2, 0] }, direction: [0, 0, -1] };

describe('定着: light fixes part of the back layer onto the surface (S-34)', () => {
  it('runs through the box from the face it meets first to the last one', () => {
    expect(sweepSpan(sweep)).toEqual([0, 4]);
    expect(sweepFront(sweep, 0)).toBe(0);
    expect(sweepFront(sweep, 0.5)).toBeCloseTo(2, 9);
    expect(sweepFront(sweep, 1)).toBe(4);
    // outside 0..1 it stays at the ends
    expect(sweepFront(sweep, -1)).toBe(0);
    expect(sweepFront(sweep, 2)).toBe(4);
  });

  it('what is inside the box and behind the front is settled; ahead of the front or outside the box is not', () => {
    const front = sweepFront(sweep, 0.5); // the front stands at z = -2
    expect(settledAt([0, 0, -1], sweep, front)).toBe(true);
    expect(settledAt([0, 0, -3], sweep, front)).toBe(false);
    expect(settledAt([1.5, 0, -1], sweep, front)).toBe(false);
    expect(settledAt([0, 2.5, -1], sweep, front)).toBe(false);
    expect(settledAt([0, 0, 0.5], sweep, front)).toBe(false);
    // nothing before the light starts, everything in the box once it is through
    expect(settledAt([0, 0, -0.1], sweep, sweepFront(sweep, 0))).toBe(false);
    expect(settledAt([0, 0, -3.9], sweep, sweepFront(sweep, 1))).toBe(true);
  });

  it('a segment is settled only once the front has passed all of it, in the segments’ order', () => {
    // ten 0.4 m segments along z, the first at the far end (z -4 … -3.6)
    const segs = splitFooting('b', { min: [-0.5, -0.1, -4], max: [0.5, 0, 0] }, 0.4);
    expect(segs).toHaveLength(10);
    expect(settledSegmentIds(segs, sweep, sweepFront(sweep, 0))).toEqual([]);
    const half = settledSegmentIds(segs, sweep, sweepFront(sweep, 0.5));
    expect(half).toEqual(segs.filter((s) => s.min[2] >= -2 - 1e-9).map((s) => s.id));
    expect(half).toHaveLength(5);
    // a front a little past a joint does not take the next segment yet
    expect(settledSegmentIds(segs, sweep, 2.1)).toEqual(half);
    expect(settledSegmentIds(segs, sweep, sweepFront(sweep, 1))).toEqual(segs.map((s) => s.id));
  });

  it('a segment that pokes out of the box never settles (it would be solid where nothing is fixed)', () => {
    const segs = splitFooting('long', { min: [-0.5, -0.1, -5], max: [0.5, 0, 0] }, 0.5);
    const ids = settledSegmentIds(segs, sweep, sweepFront(sweep, 1));
    expect(ids).toEqual(segs.filter((s) => s.min[2] >= -4).map((s) => s.id));
    expect(ids.length).toBeLessThan(segs.length);
  });

  it('measures the front along any direction (a wall settled across x, split on all three axes)', () => {
    const across: SettleSweep = { box: { min: [0, 0, -1], max: [2, 1, 1] }, direction: [1, 0, 0] };
    expect(sweepSpan(across)).toEqual([0, 2]);
    const wall = splitSurface('w', { min: [0.1, 0, -0.05], max: [1.9, 0.9, 0.05] }, 0.4);
    const atHalf = settledSegmentIds(wall, across, sweepFront(across, 0.5));
    expect(atHalf.length).toBeGreaterThan(0);
    expect(atHalf.length).toBeLessThan(wall.length);
    for (const id of atHalf) expect((wall.find((s) => s.id === id)?.max[0] ?? 9) <= 1 + 1e-9).toBe(true);
    expect(settledSegmentIds(wall, across, sweepFront(across, 1))).toHaveLength(wall.length);
  });
});
