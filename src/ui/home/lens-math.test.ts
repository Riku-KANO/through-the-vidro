import { describe, expect, it } from 'vitest';
import { DIVE, diveChoreography, HOME_COMPOSITION } from './choreography';
import { divePickUV, foldMargin, type LensState } from './lens-math';

const ASPECTS = [4 / 3, 16 / 9, 21 / 9];

function stateAt(p: number, aspect: number): LensState {
  const c = diveChoreography(p);
  return {
    aspect,
    fovDeg: HOME_COMPOSITION.fovDeg,
    cameraDistance: c.cameraDistance,
    refraction: c.refraction,
    warp: c.warp,
    ripple: c.ripple,
    ringRadius: c.ringRadius,
  };
}

describe('the dive distortion (lens.ts, mirrored in lens-math.ts)', () => {
  it('never folds the picture over itself, on 4:3 to 21:9, at any moment of the full-screen part', () => {
    for (const aspect of ASPECTS) {
      for (let i = 0; i <= 50; i++) {
        const p = DIVE.blendFrom + ((1 - DIVE.blendFrom) * i) / 50;
        const m = foldMargin(stateAt(p, aspect), 32);
        expect(m.det, `det at p=${p.toFixed(2)} aspect=${aspect.toFixed(2)}`).toBeGreaterThan(0.25);
        expect(m.diag, `slope at p=${p.toFixed(2)} aspect=${aspect.toFixed(2)}`).toBeGreaterThan(0.4);
      }
    }
  });

  it('visibly bends the picture at the moment of passing through the surface', () => {
    for (const aspect of ASPECTS) {
      const s = stateAt(DIVE.crossAt, aspect);
      const calm = { ...s, warp: 0, ripple: 0 };
      const [x, y] = divePickUV(0.95, 0.92, s);
      const [x0, y0] = divePickUV(0.95, 0.92, calm);
      expect(Math.hypot(x - x0, y - y0), `aspect=${aspect.toFixed(2)}`).toBeGreaterThan(0.015);
    }
  });

  it('leaves the game image untouched at the end of the dive', () => {
    for (const aspect of ASPECTS) {
      const [x, y] = divePickUV(0.3, 0.7, stateAt(1, aspect));
      expect(x).toBeCloseTo(0.3, 6);
      expect(y).toBeCloseTo(0.7, 6);
    }
  });
});
