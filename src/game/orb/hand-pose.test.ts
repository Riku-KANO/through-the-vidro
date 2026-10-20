import { describe, expect, it } from 'vitest';
import { HAND_ORB_RADIUS, handOrbCenter, orbScreenCircle } from './hand-pose';

const circle = (peek: number, presence = 1) =>
  orbScreenCircle(handOrbCenter(peek, presence, 0), HAND_ORB_RADIUS, 70 - 6 * peek, 16 / 9);

describe('hand orb pose (覗く: 手の玉が視界中央にせり上がる)', () => {
  it('rests low in the view while walking', () => {
    const c = circle(0);
    expect(c.y).toBeGreaterThan(0.8);
    expect(c.y - c.r).toBeLessThan(1);
  });

  it('rises to the middle of the view when peeking, and the circle widens', () => {
    const rest = circle(0);
    const full = circle(1);
    expect(Math.abs(full.x - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(full.y - 0.5)).toBeLessThan(0.05);
    expect(full.r).toBeGreaterThan(rest.r * 1.5);
    expect(full.r).toBeLessThan(0.3);
  });

  it('rises steadily along the way', () => {
    let prev = circle(0).y;
    for (let i = 1; i <= 10; i++) {
      const y = circle(i / 10).y;
      expect(y).toBeLessThan(prev);
      prev = y;
    }
  });

  it('drops out of view when the hand is empty', () => {
    const c = circle(0, 0);
    expect(c.y - c.r).toBeGreaterThan(1);
  });
});
