import { describe, expect, it } from 'vitest';
import {
  MAIN_ORB_RADIUS,
  MATERIALIZE_SECONDS,
  type Materialization,
  materializedRadius,
  pickUpOrb,
  placeOrb,
  SMALL_ORB_RADIUS,
  stepMaterialization,
} from './materialize';

const simulate = (m: Materialization, seconds: number, dt = 1 / 60): Materialization => {
  let out = m;
  for (let t = 0; t < seconds - 1e-9; t += dt) out = stepMaterialization(out, Math.min(dt, seconds - t));
  return out;
};

describe('materialization (トランジション設計 > 玉を置く)', () => {
  it('uses the design numbers: main orb 4 m, small orb 2 m, 0.8 s', () => {
    expect(MAIN_ORB_RADIUS).toBe(4);
    expect(SMALL_ORB_RADIUS).toBe(2);
    expect(MATERIALIZE_SECONDS).toBe(0.8);
  });

  it('a resting orb materializes nothing', () => {
    const m: Materialization = { progress: 0, target: 0 };
    expect(materializedRadius(m, MAIN_ORB_RADIUS)).toBe(0);
  });

  it('placing grows the radius from 0 to 4 m in 0.8 s', () => {
    const placed = placeOrb({ progress: 0, target: 0 });
    expect(materializedRadius(placed, MAIN_ORB_RADIUS)).toBe(0);
    const mid = simulate(placed, MATERIALIZE_SECONDS / 2);
    const r = materializedRadius(mid, MAIN_ORB_RADIUS);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(MAIN_ORB_RADIUS);
    const before = simulate(placed, MATERIALIZE_SECONDS - 0.05);
    expect(materializedRadius(before, MAIN_ORB_RADIUS)).toBeLessThan(MAIN_ORB_RADIUS);
    const done = simulate(placed, MATERIALIZE_SECONDS);
    expect(materializedRadius(done, MAIN_ORB_RADIUS)).toBe(MAIN_ORB_RADIUS);
  });

  it('the radius never shrinks while growing', () => {
    let m = placeOrb({ progress: 0, target: 0 });
    let prev = 0;
    for (let i = 0; i < 60; i++) {
      m = stepMaterialization(m, 1 / 60);
      const r = materializedRadius(m, MAIN_ORB_RADIUS);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('picking up plays the growth backwards to 0 in 0.8 s', () => {
    const full = simulate(placeOrb({ progress: 0, target: 0 }), MATERIALIZE_SECONDS);
    const lifting = pickUpOrb(full);
    const radii: number[] = [];
    let m = lifting;
    for (let i = 0; i < 48; i++) {
      m = stepMaterialization(m, 1 / 60);
      radii.push(materializedRadius(m, MAIN_ORB_RADIUS));
    }
    expect(radii.at(-1)).toBe(0);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThanOrEqual(radii[i - 1] ?? Infinity);
    // Time-reversed: the radius 0.2 s into the pickup equals the radius 0.6 s into the growth.
    const growth06 = materializedRadius(simulate(placeOrb({ progress: 0, target: 0 }), 0.6), MAIN_ORB_RADIUS);
    const pickup02 = materializedRadius(simulate(lifting, 0.2), MAIN_ORB_RADIUS);
    expect(pickup02).toBeCloseTo(growth06, 5);
  });

  it('a small orb grows to 2 m on the same curve', () => {
    const done = simulate(placeOrb({ progress: 0, target: 0 }), MATERIALIZE_SECONDS);
    expect(materializedRadius(done, SMALL_ORB_RADIUS)).toBe(SMALL_ORB_RADIUS);
  });
});
