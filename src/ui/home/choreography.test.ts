import { describe, expect, it } from 'vitest';
import {
  DIVE,
  diveChoreography,
  HOME_COMPOSITION,
  openingChoreography,
  orbCoversScreen,
} from './choreography';

const steps = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);
const { orbRadius, fovDeg } = HOME_COMPOSITION;

describe('orbCoversScreen', () => {
  it('is false from the home distance and true when the camera is almost touching the orb', () => {
    expect(orbCoversScreen(HOME_COMPOSITION.cameraDistance, orbRadius, fovDeg, 16 / 9)).toBe(false);
    expect(orbCoversScreen(orbRadius * 1.05, orbRadius, fovDeg, 16 / 9)).toBe(true);
  });

  it('needs the camera closer on wider screens', () => {
    const d = orbRadius * 1.7;
    expect(orbCoversScreen(d, orbRadius, fovDeg, 4 / 3)).toBe(true);
    expect(orbCoversScreen(d, orbRadius, fovDeg, 32 / 9)).toBe(false);
  });
});

describe('openingChoreography (読み込み → ホーム)', () => {
  it('starts in full white fog with only the vessel, and ends on the home screen', () => {
    const a = openingChoreography(0);
    expect(a.fog).toBe(1);
    expect(a.overflow).toBe(0);
    expect(a.orbRise).toBe(0);
    expect(a.menu).toBe(0);
    const b = openingChoreography(1);
    expect(b.fog).toBeLessThan(0.3);
    expect(b.overflow).toBe(1);
    expect(b.orbRise).toBe(1);
    expect(b.menu).toBe(1);
  });

  it('overflows first, then clears the fog, then lifts the orb, and shows the drops last', () => {
    for (const p of steps(200)) {
      const c = openingChoreography(p);
      if (c.fog < 1) expect(c.overflow).toBeGreaterThan(0);
      if (c.orbRise > 0) expect(c.fog).toBeLessThan(1);
      if (c.menu > 0) expect(c.orbRise).toBeGreaterThan(0.5);
    }
  });

  it('clears the fog without ever thickening it again', () => {
    let prev = 1;
    for (const p of steps(200)) {
      const fog = openingChoreography(p).fog;
      expect(fog).toBeLessThanOrEqual(prev + 1e-9);
      prev = fog;
    }
  });
});

describe('diveChoreography (ホーム → ゲーム開始)', () => {
  it('starts from the home composition and ends fully inside the game view with no distortion left', () => {
    const a = diveChoreography(0);
    expect(a.cameraDistance).toBe(HOME_COMPOSITION.cameraDistance);
    expect(a.fullscreen).toBe(0);
    expect(a.distortion).toBe(0);
    expect(a.inner).toBe(0);
    const b = diveChoreography(1);
    expect(b.fullscreen).toBe(1);
    expect(b.distortion).toBe(0);
    expect(b.inner).toBe(1);
  });

  it('moves the camera steadily towards the orb', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const p of steps(200)) {
      const d = diveChoreography(p).cameraDistance;
      expect(d).toBeLessThanOrEqual(prev);
      expect(d).toBeGreaterThan(0);
      prev = d;
    }
  });

  it('switches to the full-screen game image only once the orb fills the whole screen (no seam)', () => {
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      for (const p of steps(400)) {
        const c = diveChoreography(p);
        // the warp and the ripple are drawn by the orb too: they may only start once it covers the screen
        if (c.fullscreen > 0 || c.warp > 0 || c.ripple > 0) {
          expect(
            orbCoversScreen(c.cameraDistance, orbRadius, fovDeg, aspect),
            `p=${p} aspect=${aspect}`,
          ).toBe(true);
        }
      }
    }
  });

  it('spreads the refraction over the whole screen at the moment of passing through the surface', () => {
    let peakP = 0;
    let peak = 0;
    for (const p of steps(400)) {
      const c = diveChoreography(p);
      if (c.distortion > peak) {
        peak = c.distortion;
        peakP = p;
      }
    }
    const atPeak = diveChoreography(peakP);
    expect(peak).toBeGreaterThan(0.5);
    expect(orbCoversScreen(atPeak.cameraDistance, orbRadius, fovDeg, 16 / 9)).toBe(true);
    expect(atPeak.fullscreen).toBeGreaterThan(0);
    // not just a zoom: the whole screen is warped and the ripple ring is running across it right then
    const atCross = diveChoreography(DIVE.crossAt);
    expect(atCross.warp).toBeGreaterThan(0.8);
    expect(atCross.ripple).toBeGreaterThan(0.8);
    expect(atCross.ringRadius).toBeGreaterThan(0.3);
    expect(atCross.ringRadius).toBeLessThan(1.2);
  });

  it('leaves no warp or ripple once standing in the game view', () => {
    const end = diveChoreography(1);
    expect(end.warp).toBe(0);
    expect(end.ripple).toBe(0);
    expect(end.surface).toBe(0);
    expect(end.refraction).toBe(0);
  });
});
