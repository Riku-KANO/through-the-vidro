import { describe, expect, it } from 'vitest';
import { activeSegmentIds, type FootingSegment, type Sphere, segmentsUnder, splitFooting } from './footing';

// A 3 m bridge along +x, 1.2 m wide, deck top at y = 0.
const bridge: FootingSegment[] = splitFooting('bridge', { min: [0, -0.12, -0.6], max: [3, 0, 0.6] }, 0.5);

describe('back-layer footing segments (技術設計 > 裏の層の実装 > 当たり判定)', () => {
  it('splits a footing box into small segments', () => {
    expect(bridge).toHaveLength(6);
    expect(new Set(bridge.map((s) => s.id)).size).toBe(6);
  });

  it('no sphere → no segment collides', () => {
    expect(activeSegmentIds(bridge, [])).toEqual([]);
  });

  it('only segments that overlap a materialized sphere collide', () => {
    const sphere: Sphere = { center: [-0.5, 1, 0], radius: 2 };
    const ids = activeSegmentIds(bridge, [sphere]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(bridge.length);
    // the near end overlaps, the far end does not
    expect(ids).toContain(bridge[0]?.id);
    expect(ids).not.toContain(bridge.at(-1)?.id);
  });

  it('a sphere of radius 0 (not yet grown) activates nothing', () => {
    expect(activeSegmentIds(bridge, [{ center: [0.2, 0, 0], radius: 0 }])).toEqual([]);
  });

  it('a 4 m sphere at the pedestal covers the whole bridge', () => {
    const ids = activeSegmentIds(bridge, [{ center: [-0.5, 1, -0.9], radius: 4 }]);
    expect(ids).toHaveLength(bridge.length);
  });

  it('several spheres activate the union of what each overlaps', () => {
    const a: Sphere = { center: [-0.5, 0, 0], radius: 1 };
    const b: Sphere = { center: [3.5, 0, 0], radius: 1 };
    const ids = activeSegmentIds(bridge, [a, b]);
    expect(ids).toContain(bridge[0]?.id);
    expect(ids).toContain(bridge.at(-1)?.id);
    expect(ids).not.toContain(bridge[2]?.id);
  });

  it('finds the segments under the feet', () => {
    expect(segmentsUnder([0.7, 0, 0], bridge).map((s) => s.id)).toEqual([bridge[1]?.id]);
    expect(segmentsUnder([-1, 0, 0], bridge)).toEqual([]);
    // feet far above the deck are not standing on it
    expect(segmentsUnder([0.7, 2, 0], bridge)).toEqual([]);
  });
});
