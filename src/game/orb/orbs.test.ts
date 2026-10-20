import { describe, expect, it } from 'vitest';
import { MAX_SPHERES } from '../../layers/materialize';
import { createOrbs, orbSpheres, placeOn, settle, stepOrbs } from './orbs';

const pedestals = {
  a: [0, 1, 0] as const,
  b: [10, 1, 0] as const,
  c: [20, 1, 0] as const,
  d: [30, 1, 0] as const,
};

describe('orbs (コアメカニクス > ガラス玉の性質の成長)', () => {
  it('there is one main orb and at most two small orbs', () => {
    const orbs = createOrbs(5);
    expect(orbs.filter((o) => o.kind === 'main')).toHaveLength(1);
    expect(orbs.filter((o) => o.kind === 'small')).toHaveLength(2);
    expect(MAX_SPHERES).toBe(3);
  });

  it('orbs in hand materialize nothing', () => {
    expect(orbSpheres(createOrbs(2), pedestals)).toEqual([]);
  });

  it('placed orbs become spheres around their pedestal: main 4 m, small 2 m', () => {
    let orbs = createOrbs(2);
    orbs = placeOn(orbs, 'main', 'a');
    orbs = placeOn(orbs, 'small-1', 'b');
    orbs = placeOn(orbs, 'small-2', 'c');
    orbs = settle(orbs);
    const spheres = orbSpheres(orbs, pedestals);
    expect(spheres).toHaveLength(3);
    expect(spheres.find((s) => s.orbId === 'main')).toMatchObject({ center: [0, 1, 0], radius: 4 });
    expect(spheres.filter((s) => s.kind === 'small').map((s) => s.radius)).toEqual([2, 2]);
  });

  it('an orb cannot be placed on an occupied pedestal', () => {
    let orbs = placeOn(createOrbs(1), 'main', 'a');
    orbs = placeOn(orbs, 'small-1', 'a');
    expect(orbs.find((o) => o.id === 'small-1')?.pedestal).toBeNull();
  });

  it('stepping orbs that are at rest changes nothing', () => {
    const orbs = settle(placeOn(createOrbs(1), 'main', 'a'));
    expect(stepOrbs(orbs, 1 / 60)).toBe(orbs);
    const growing = placeOn(createOrbs(1), 'main', 'a');
    expect(stepOrbs(growing, 1 / 60)).not.toBe(growing);
  });
});
