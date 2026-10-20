import { describe, expect, it } from 'vitest';
import { glassEase, stepTween, type Tween } from './tween';

describe('glassEase (ゆっくり始まって粘りながら止まる)', () => {
  it('starts at 0 and ends at 1', () => {
    expect(glassEase(0)).toBe(0);
    expect(glassEase(1)).toBe(1);
  });

  it('clamps outside 0..1', () => {
    expect(glassEase(-1)).toBe(0);
    expect(glassEase(2)).toBe(1);
  });

  it('starts slowly and settles slowly', () => {
    expect(glassEase(0.1)).toBeLessThan(0.1);
    expect(1 - glassEase(0.9)).toBeLessThan(0.1);
  });

  it('never moves backwards', () => {
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = glassEase(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('stepTween', () => {
  const run = (from: Tween, seconds: number, total: number, dt = 1 / 60): Tween => {
    let t = from;
    for (let elapsed = 0; elapsed < total - 1e-9; elapsed += dt)
      t = stepTween(t, Math.min(dt, total - elapsed), seconds);
    return t;
  };

  it('reaches the target after exactly the given duration', () => {
    const half = run({ progress: 0, target: 1 }, 0.8, 0.4);
    expect(half.progress).toBeCloseTo(0.5, 5);
    const done = run({ progress: 0, target: 1 }, 0.8, 0.8);
    expect(done.progress).toBe(1);
  });

  it('plays backwards along the same path when the target flips', () => {
    const forward = run({ progress: 0, target: 1 }, 0.8, 0.3);
    const back = run({ ...forward, target: 0 }, 0.8, 0.3);
    expect(back.progress).toBeCloseTo(0, 5);
  });

  it('does not overshoot', () => {
    const t = stepTween({ progress: 0.95, target: 1 }, 1, 0.25);
    expect(t.progress).toBe(1);
  });
});
