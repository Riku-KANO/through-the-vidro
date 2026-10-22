import { describe, expect, it } from 'vitest';
import type { Box, FootingSphere } from './footing';
import { boxInsideSphere, cutSurfaceIds, SURFACE_SEGMENT, segmentsAroundBody, splitSurface } from './surface';

/**
 * 表にしかない壁 inside a placed orb's sphere (コアメカニクス > 裏の層のルール: 玉を置くと、その球の中では裏が表を置き換える…
 * 表にしかない壁は消えて通れるようになる; S-28). Pure geometry: which segments of a surface-only wall lose their collider, and
 * which ones a standing body is in.
 */

// A wall 2 m wide (along x), 1.2 m high, 0.15 m thick, standing on y = 0.
const WALL: Box = { min: [-1, 0, -0.075], max: [1, 1.2, 0.075] };
const volume = (b: Box): number => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
/** A placed orb's sphere (grown or growing: target 1). */
const placed = (center: FootingSphere['center'], radius: number): FootingSphere => ({
  center,
  radius,
  materialize: { target: 1 },
});
const BODY = { radius: 0.3, height: 1.75 };

describe('surface-only walls in segments (技術設計 > 裏の層の実装 > 当たり判定: 細かい区画)', () => {
  it('starts with segments of 0.4 m, like the back footing', () => {
    expect(SURFACE_SEGMENT).toBe(0.4);
  });

  it('splits a wall into segments no longer than the size on any axis that tile the wall exactly', () => {
    const segs = splitSurface('wall', WALL, SURFACE_SEGMENT);
    // 2 m → 5 across, 1.2 m → 3 high, 0.15 m → 1 thick
    expect(segs).toHaveLength(15);
    expect(new Set(segs.map((s) => s.id)).size).toBe(segs.length);
    for (const s of segs) {
      for (let a = 0; a < 3; a++) {
        expect((s.max[a] ?? 0) - (s.min[a] ?? 0)).toBeLessThanOrEqual(SURFACE_SEGMENT + 1e-9);
        expect(s.min[a] ?? 0).toBeGreaterThanOrEqual((WALL.min[a] ?? 0) - 1e-9);
        expect(s.max[a] ?? 0).toBeLessThanOrEqual((WALL.max[a] ?? 0) + 1e-9);
      }
    }
    const sum = segs.reduce((n, s) => n + volume(s), 0);
    expect(sum).toBeCloseTo(volume(WALL), 9);
  });

  it('a wall smaller than a segment stays one segment', () => {
    const small: Box = { min: [0, 0, 0], max: [0.3, 0.25, 0.1] };
    expect(splitSurface('pillar', small, SURFACE_SEGMENT)).toEqual([{ id: 'pillar:0.0.0', ...small }]);
  });

  it('a box is inside a sphere only when all of it is', () => {
    const box: Box = { min: [0, 0, 0], max: [0.4, 0.4, 0.4] };
    expect(boxInsideSphere(box, { center: [0.2, 0.2, 0.2], radius: 0.35 })).toBe(true);
    // the far corner pokes out
    expect(boxInsideSphere(box, { center: [0, 0, 0], radius: 0.6 })).toBe(false);
    expect(boxInsideSphere(box, { center: [0.2, 0.2, 0.2], radius: 0 })).toBe(false);
  });
});

describe('a placed orb cuts the surface-only segments wholly inside its sphere (S-28)', () => {
  const segs = splitSurface('wall', WALL, SURFACE_SEGMENT);

  it('without a sphere the whole wall is solid', () => {
    expect(cutSurfaceIds(segs, [])).toEqual([]);
  });

  it('a placed orb whose sphere holds the whole wall cuts all of it', () => {
    expect(cutSurfaceIds(segs, [placed([0, 1, 1.5], 4)])).toEqual(segs.map((s) => s.id));
  });

  it('a segment the sphere’s film crosses stays solid: it is still partly drawn', () => {
    // the film passes through the wall around x = 0
    const sphere = placed([-2, 0.6, 0], 2.05);
    const cut = cutSurfaceIds(segs, [sphere]);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.length).toBeLessThan(segs.length);
    for (const s of segs) expect(cut.includes(s.id)).toBe(boxInsideSphere(s, sphere));
    // the far end of the wall (outside the sphere) and the crossed middle are solid
    expect(cut.some((id) => (segs.find((s) => s.id === id)?.max[0] ?? 0) > 0)).toBe(false);
  });

  it('the sphere of an orb that was picked up (shrinking back) cuts nothing: the wall is solid again at once', () => {
    const shrinking: FootingSphere = { center: [0, 1, 1.5], radius: 3.9, materialize: { target: 0 } };
    expect(cutSurfaceIds(segs, [shrinking])).toEqual([]);
  });

  it('a growing orb cuts a segment once its sphere has reached all of it', () => {
    const near = segs.filter((s) => s.max[0] <= -0.6 + 1e-9);
    const growing = placed([-1.6, 0.6, 0], 1.2);
    const cut = cutSurfaceIds(segs, [growing]);
    expect(cut.length).toBeGreaterThan(0);
    for (const id of cut) expect(near.map((s) => s.id)).toContain(id);
    expect(cutSurfaceIds(segs, [placed([-1.6, 0.6, 0], 0)])).toEqual([]);
  });

  it('a sphere without a materialization (the dev holds draw a fixed one) counts as placed', () => {
    expect(cutSurfaceIds(segs, [{ center: [0, 1, 1.5], radius: 4 }])).toHaveLength(segs.length);
  });
});

describe('the segments a standing body is in (for 拾う前の確かめ)', () => {
  const segs = splitSurface('wall', WALL, SURFACE_SEGMENT);

  it('a body standing in the wall is in the segments around it, from the floor up to its head', () => {
    const around = segmentsAroundBody([0.1, 0, 0], BODY, segs);
    expect(around.length).toBeGreaterThan(0);
    // across: the segments within 0.3 m of x = 0.1; up: every row of the 1.2 m wall (the body is 1.75 m tall)
    for (const s of around) {
      expect(s.min[0]).toBeLessThan(0.4);
      expect(s.max[0]).toBeGreaterThan(-0.2);
    }
    expect(new Set(around.map((s) => s.min[1])).size).toBe(3);
  });

  it('a body half in the wall (its radius reaches in) is in it', () => {
    expect(segmentsAroundBody([0, 0, 0.075 + 0.25], BODY, segs).length).toBeGreaterThan(0);
  });

  it('a body beside the wall, or just clear of its face, is not in it', () => {
    expect(segmentsAroundBody([0, 0, 0.6], BODY, segs)).toEqual([]);
    expect(segmentsAroundBody([0, 0, 0.075 + 0.305], BODY, segs)).toEqual([]);
  });

  it('the body is round: off the wall’s corner on the diagonal it is not in it', () => {
    // 0.25 m past the end and 0.25 m off the face: inside the square around the body, outside its circle
    expect(segmentsAroundBody([1.25, 0, 0.075 + 0.25], BODY, segs)).toEqual([]);
    expect(segmentsAroundBody([1.15, 0, 0.075 + 0.1], BODY, segs).length).toBeGreaterThan(0);
  });

  it('a body above the wall is not in it', () => {
    expect(segmentsAroundBody([0, 1.3, 0], BODY, segs)).toEqual([]);
  });
});
