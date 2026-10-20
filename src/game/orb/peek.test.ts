import { describe, expect, it } from 'vitest';
import {
  PEEK_FOV_DELTA_DEG,
  PEEK_MOVE_SPEED_FACTOR,
  PEEK_SECONDS,
  type PeekState,
  peekAmount,
  peekFovOffset,
  peekMoveSpeedMultiplier,
  stepPeek,
} from './peek';

const hold = (s: PeekState, seconds: number, wantPeek: boolean, allowed = true, dt = 1 / 60): PeekState => {
  let out = s;
  for (let t = 0; t < seconds - 1e-9; t += dt)
    out = stepPeek(out, { wantPeek, allowed }, Math.min(dt, seconds - t));
  return out;
};

const rest: PeekState = { progress: 0, peeking: false };

describe('peek (コアメカニクス > 基本の動作, トランジション設計 > 覗く開始・終了)', () => {
  it('uses the design numbers: 0.25 s, -6°, 50 % speed', () => {
    expect(PEEK_SECONDS).toBe(0.25);
    expect(PEEK_FOV_DELTA_DEG).toBe(-6);
    expect(PEEK_MOVE_SPEED_FACTOR).toBe(0.5);
  });

  it('holding the peek input raises the orb fully in 0.25 s', () => {
    const early = hold(rest, 0.1, true);
    expect(early.peeking).toBe(true);
    expect(peekAmount(early)).toBeGreaterThan(0);
    expect(peekAmount(early)).toBeLessThan(1);
    expect(peekAmount(hold(rest, 0.2, true))).toBeLessThan(1);
    expect(peekAmount(hold(rest, PEEK_SECONDS, true))).toBe(1);
  });

  it('releasing plays the same 0.25 s backwards', () => {
    const full = hold(rest, PEEK_SECONDS, true);
    const ending = hold(full, 0.1, false);
    expect(ending.peeking).toBe(false);
    expect(peekAmount(ending)).toBeGreaterThan(0);
    expect(peekAmount(hold(full, PEEK_SECONDS, false))).toBe(0);
  });

  it('a peek that is not allowed never starts', () => {
    const s = hold(rest, 0.5, true, false);
    expect(s.peeking).toBe(false);
    expect(peekAmount(s)).toBe(0);
  });

  it('a peek that stops being allowed ends', () => {
    const full = hold(rest, PEEK_SECONDS, true);
    const s = hold(full, PEEK_SECONDS, true, false);
    expect(s.peeking).toBe(false);
    expect(peekAmount(s)).toBe(0);
  });

  it('narrows the field of view by 6° at full peek and not at all at rest', () => {
    expect(peekFovOffset(0)).toBe(0);
    expect(peekFovOffset(1)).toBe(-6);
  });

  it('walking speed is 50 % while peeking and 100 % otherwise', () => {
    expect(peekMoveSpeedMultiplier(0)).toBe(1);
    expect(peekMoveSpeedMultiplier(1)).toBe(0.5);
  });
});
