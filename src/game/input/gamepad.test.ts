import { describe, expect, it } from 'vitest';
import { mouseLookDelta, nextSprintLatch, padCodesPressed, radialDeadzone, stickLookDelta } from './gamepad';

const button = (value: number) => ({ pressed: value > 0.5, value });
const buttons = (pressedIndices: Record<number, number>) =>
  Array.from({ length: 17 }, (_, i) => button(pressedIndices[i] ?? 0));

describe('padCodesPressed (standard mapping)', () => {
  it('names the buttons of the standard layout', () => {
    expect(padCodesPressed(buttons({ 0: 1, 9: 1, 10: 1, 14: 1 }), new Set())).toEqual(
      new Set(['PadA', 'PadStart', 'PadL3', 'PadLeft']),
    );
  });

  it('analog triggers need a firm pull to press and stay pressed while half released', () => {
    expect(padCodesPressed(buttons({ 6: 0.3 }), new Set()).has('PadLT')).toBe(false);
    expect(padCodesPressed(buttons({ 6: 0.7 }), new Set()).has('PadLT')).toBe(true);
    expect(padCodesPressed(buttons({ 6: 0.45 }), new Set(['PadLT'])).has('PadLT')).toBe(true);
    expect(padCodesPressed(buttons({ 6: 0.2 }), new Set(['PadLT'])).has('PadLT')).toBe(false);
  });
});

describe('radialDeadzone', () => {
  it('ignores small drift', () => {
    expect(radialDeadzone(0.1, 0.05, 0.15)).toEqual({ x: 0, y: 0 });
  });

  it('reaches full magnitude at full tilt and keeps the direction', () => {
    const v = radialDeadzone(Math.SQRT1_2, Math.SQRT1_2, 0.15);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 6);
    expect(v.x).toBeCloseTo(v.y, 6);
  });

  it('starts from zero just outside the dead zone (no jump)', () => {
    const v = radialDeadzone(0.16, 0, 0.15);
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeLessThan(0.05);
  });
});

describe('look deltas', () => {
  it('moving the mouse right turns right (yaw decreases), down looks down', () => {
    const d = mouseLookDelta(10, 5, 0.002, false);
    expect(d.yaw).toBeCloseTo(-0.02, 9);
    expect(d.pitch).toBeCloseTo(-0.01, 9);
    expect(mouseLookDelta(0, 5, 0.002, true).pitch).toBeCloseTo(0.01, 9);
  });

  it('a fully tilted stick turns at the configured rate', () => {
    const d = stickLookDelta(1, 0, 0.5, 2, false);
    expect(d.yaw).toBeCloseTo(-1, 6);
    expect(d.pitch).toBeCloseTo(0, 9);
  });

  it('a half tilted stick turns slower than half rate (fine aiming)', () => {
    const d = stickLookDelta(0.5, 0, 1, 2, false);
    expect(Math.abs(d.yaw)).toBeLessThan(1);
    expect(Math.abs(d.yaw)).toBeGreaterThan(0);
  });
});

describe('nextSprintLatch (早歩き: 左スティック押し込み)', () => {
  it('clicking the stick starts sprinting until the stick is released', () => {
    let s = nextSprintLatch(false, true, 0.9);
    expect(s).toBe(true);
    s = nextSprintLatch(s, false, 0.8);
    expect(s).toBe(true);
    s = nextSprintLatch(s, false, 0.05);
    expect(s).toBe(false);
  });
});
