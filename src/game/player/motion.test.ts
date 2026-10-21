import { describe, expect, it } from 'vitest';
import {
  EYE_HEIGHT,
  FOOTSTEP_LENGTH,
  FOV_DEFAULT,
  FOV_MAX,
  FOV_MIN,
  PEEK_MODIFIER,
  SPRINT_SPEED,
  WALK_SPEED,
} from './constants';
import {
  approachVelocity,
  clampFov,
  clampPitch,
  combineModifiers,
  followEye,
  footfallsBy,
  headBobOffset,
  wishVelocity,
} from './motion';

describe('design numbers (操作とカメラ > カメラ, コアメカニクス > 基本の動作)', () => {
  it('uses the values from the design doc', () => {
    expect(EYE_HEIGHT).toBe(1.6);
    expect(WALK_SPEED).toBe(1.4);
    expect(SPRINT_SPEED).toBe(2.2);
    expect([FOV_DEFAULT, FOV_MIN, FOV_MAX]).toEqual([70, 60, 100]);
    expect(PEEK_MODIFIER).toEqual({ speedMultiplier: 0.5, fovOffsetDeg: -6 });
  });
});

describe('wishVelocity', () => {
  it('forward at yaw 0 is -Z (three.js camera forward)', () => {
    const v = wishVelocity({ x: 0, y: 1 }, 0, 1.4);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(-1.4, 9);
  });

  it('turning left 90 degrees makes forward -X', () => {
    const v = wishVelocity({ x: 0, y: 1 }, Math.PI / 2, 1.4);
    expect(v.x).toBeCloseTo(-1.4, 9);
    expect(v.z).toBeCloseTo(0, 9);
  });

  it('strafing right at yaw 0 is +X', () => {
    expect(wishVelocity({ x: 1, y: 0 }, 0, 1).x).toBeCloseTo(1, 9);
  });
});

/** Walks with the pure kinematics only: hold forward for `hold` s, then release for `coast` s. */
function walk(hz: number, hold: number, coast: number) {
  const dt = 1 / hz;
  let v = { x: 0, z: 0 };
  let z = 0;
  let maxSpeed = 0;
  for (let t = 0; t < hold + coast - 1e-9; t += dt) {
    const target = t < hold - 1e-9 ? wishVelocity({ x: 0, y: 1 }, 0, WALK_SPEED) : { x: 0, z: 0 };
    v = approachVelocity(v, target, dt);
    z += v.z * dt;
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.z));
  }
  return { distance: -z, speed: Math.hypot(v.x, v.z), maxSpeed };
}

describe('approachVelocity (短い慣性)', () => {
  it('holding forward for 2 s covers about 2.8 m', () => {
    const r = walk(60, 2, 1);
    expect(r.distance).toBeGreaterThan(2.65);
    expect(r.distance).toBeLessThan(2.95);
  });

  it('never overshoots the walking speed and comes to rest within half a second', () => {
    const r = walk(60, 2, 0.5);
    expect(r.maxSpeed).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
    expect(r.speed).toBeLessThan(0.05);
  });

  it('reaches walking speed quickly (short inertia, not floaty)', () => {
    const r = walk(60, 0.35, 0);
    expect(r.speed).toBeGreaterThan(WALK_SPEED * 0.9);
  });

  it('does not depend on the frame rate', () => {
    const a = walk(30, 2, 1).distance;
    const b = walk(144, 2, 1).distance;
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });
});

describe('combineModifiers (S-02 との口)', () => {
  it('no modifiers: normal speed and field of view', () => {
    expect(combineModifiers([])).toEqual({ speedMultiplier: 1, fovOffsetDeg: 0 });
  });

  it('peeking halves the speed and narrows the view by 6 degrees', () => {
    expect(combineModifiers([{ ...PEEK_MODIFIER, weight: 1 }])).toEqual({
      speedMultiplier: 0.5,
      fovOffsetDeg: -6,
    });
  });

  it('a half-finished transition blends halfway', () => {
    const m = combineModifiers([{ ...PEEK_MODIFIER, weight: 0.5 }]);
    expect(m.speedMultiplier).toBeCloseTo(0.75, 9);
    expect(m.fovOffsetDeg).toBeCloseTo(-3, 9);
  });

  it('several modifiers multiply speeds and add view offsets', () => {
    const m = combineModifiers([
      { speedMultiplier: 0.5, fovOffsetDeg: -6 },
      { speedMultiplier: 0.8, fovOffsetDeg: 2 },
    ]);
    expect(m.speedMultiplier).toBeCloseTo(0.4, 9);
    expect(m.fovOffsetDeg).toBeCloseTo(-4, 9);
  });
});

describe('camera limits', () => {
  it('clamps the field of view setting to 60..100 degrees', () => {
    expect(clampFov(50)).toBe(60);
    expect(clampFov(120)).toBe(100);
    expect(clampFov(85)).toBe(85);
    expect(clampFov(Number.NaN)).toBe(70);
  });

  it('never lets the view flip over the vertical', () => {
    expect(clampPitch(3)).toBeLessThan(Math.PI / 2);
    expect(clampPitch(-3)).toBeGreaterThan(-Math.PI / 2);
    expect(clampPitch(0.3)).toBe(0.3);
  });
});

describe('headBobOffset (歩行の揺れはごく弱く、オフにできる)', () => {
  it('is at most about a centimetre while walking', () => {
    let max = 0;
    for (let d = 0; d < 5; d += 0.01) max = Math.max(max, Math.abs(headBobOffset(d, 1, 1)));
    expect(max).toBeGreaterThan(0.002);
    expect(max).toBeLessThanOrEqual(0.015);
  });

  it('is zero when switched off or standing still', () => {
    for (let d = 0; d < 5; d += 0.1) {
      expect(headBobOffset(d, 1, 0)).toBe(0);
      expect(headBobOffset(d, 0, 1)).toBe(0);
    }
  });
});

describe('followEye (段差で視点が跳ねない)', () => {
  it('eases toward a step up instead of jumping, but never lags far behind', () => {
    let eye = 0;
    eye = followEye(eye, 0.2, 1 / 60);
    expect(eye).toBeGreaterThan(0);
    expect(eye).toBeLessThan(0.2);
    for (let i = 0; i < 30; i++) eye = followEye(eye, 0.2, 1 / 60);
    expect(eye).toBeCloseTo(0.2, 2);
    expect(followEye(0, 2, 1 / 60)).toBeGreaterThan(2 - 0.36);
  });
});

describe('footfallsBy (S-22: the moment a foot comes down, from the distance walked)', () => {
  it('puts the first footfall half a stride in, then one every stride', () => {
    const L = FOOTSTEP_LENGTH;
    expect(footfallsBy(0)).toBe(0);
    expect(footfallsBy(0.49 * L)).toBe(0);
    expect(footfallsBy(0.51 * L)).toBe(1);
    expect(footfallsBy(1.49 * L)).toBe(1);
    expect(footfallsBy(1.51 * L)).toBe(2);
    expect(footfallsBy(10.51 * L)).toBe(11);
    // never counts backwards or from nothing
    expect(footfallsBy(-1)).toBe(0);
    expect(footfallsBy(Number.NaN)).toBe(0);
  });

  it('lands each footfall on a dip of the walking bob, so what is seen and what is heard agree', () => {
    for (let n = 0; n < 6; n++) {
      const at = (n + 0.5) * FOOTSTEP_LENGTH;
      expect(footfallsBy(at + 1e-6) - footfallsBy(at - 1e-6)).toBe(1);
      // the bob is at its lowest exactly there
      expect(headBobOffset(at, 1, 1)).toBeCloseTo(headBobOffset(0.5 * FOOTSTEP_LENGTH, 1, 1), 9);
      expect(headBobOffset(at, 1, 1)).toBeLessThan(headBobOffset(at - 0.1, 1, 1));
      expect(headBobOffset(at, 1, 1)).toBeLessThan(headBobOffset(at + 0.1, 1, 1));
    }
  });

  it('walks at 2 steps a second at 1.4 m/s, and at half that while peeking (移動50%)', () => {
    const steps = (speed: number, seconds: number): number =>
      footfallsBy(speed * seconds + 0.5 * FOOTSTEP_LENGTH - 1e-9);
    expect(steps(WALK_SPEED, 10)).toBe(20);
    expect(steps(WALK_SPEED * PEEK_MODIFIER.speedMultiplier, 10)).toBe(10);
  });

  it('takes the stride it is given', () => {
    expect(footfallsBy(5, 1)).toBe(5);
    expect(footfallsBy(5, 0)).toBe(0);
  });
});
