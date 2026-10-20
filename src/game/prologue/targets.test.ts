import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../layers/footing';
import { pickTarget, type TargetCandidate } from './targets';

const eye: Vec3 = [0, 1.6, 0];
const ahead: Vec3 = [0, 0, -1];

describe('what 置く・拾う・調べる acts on', () => {
  it('picks a thing in front of you and within reach', () => {
    const c: TargetCandidate<string>[] = [{ target: 'pedestal', point: [0, 1.05, -2], reach: 2.5 }];
    expect(pickTarget(eye, ahead, c, 40)).toBe('pedestal');
  });

  it('ignores things out of reach, behind you or off to the side', () => {
    const c: TargetCandidate<string>[] = [
      { target: 'far', point: [0, 1.6, -3], reach: 2.5 },
      { target: 'behind', point: [0, 1.6, 1], reach: 2.5 },
      { target: 'side', point: [1.5, 1.6, -0.5], reach: 2.5 },
    ];
    expect(pickTarget(eye, ahead, c, 40)).toBeNull();
  });

  it('prefers the one closest to where you look', () => {
    const c: TargetCandidate<string>[] = [
      { target: 'off', point: [0.6, 1.2, -1.2], reach: 2.5 },
      { target: 'centre', point: [0.05, 1.5, -2.0], reach: 2.5 },
    ];
    expect(pickTarget(eye, ahead, c, 40)).toBe('centre');
  });

  it('uses each candidate’s own reach', () => {
    const c: TargetCandidate<string>[] = [{ target: 'drop', point: [0, 1.4, -2], reach: 1.7 }];
    expect(pickTarget(eye, ahead, c, 40)).toBeNull();
    expect(pickTarget([0, 1.6, -0.6], ahead, c, 40)).toBe('drop');
  });
});
