import { describe, expect, it } from 'vitest';
import { splitFooting } from '../../layers/footing';
import { createOrbs, placeOn, settle, takeBack } from './orbs';
import { canPeek, canPickUp, canPlace } from './rules';

const pedestals = { gap: [-0.5, 1, -0.9] as const, far: [2.5, 1, 0] as const };
// The lab bridge: 3 m across the gap, deck top at y = 0.
const bridge = splitFooting('bridge', { min: [0, -0.12, -0.6], max: [3, 0, 0.6] }, 0.5);

describe('rules (コアメカニクス > 基本の動作)', () => {
  it('the main orb can be peeked through while it is in hand', () => {
    expect(canPeek(createOrbs(0))).toBe(true);
  });

  it('while the main orb is placed you cannot peek', () => {
    expect(canPeek(placeOn(createOrbs(0), 'main', 'gap'))).toBe(false);
  });

  it('placing a small orb does not stop the main orb from peeking', () => {
    expect(canPeek(placeOn(createOrbs(1), 'small-1', 'gap'))).toBe(true);
  });

  it('an orb in hand can be placed on a free pedestal', () => {
    expect(canPlace(createOrbs(0), 'main', 'gap')).toBe(true);
  });

  it('an orb cannot be placed on an occupied pedestal or placed twice', () => {
    const orbs = placeOn(createOrbs(1), 'main', 'gap');
    expect(canPlace(orbs, 'small-1', 'gap')).toBe(false);
    expect(canPlace(orbs, 'main', 'far')).toBe(false);
  });

  it('a just picked-up orb goes onto another pedestal only after its old sphere has shrunk away', () => {
    const lifted = takeBack(settle(placeOn(createOrbs(0), 'main', 'gap')), 'main');
    expect(canPlace(lifted, 'main', 'far')).toBe(false);
    expect(placeOn(lifted, 'main', 'far').find((o) => o.id === 'main')?.pedestal).toBeNull();
    expect(canPlace(lifted, 'main', 'gap')).toBe(true);
    expect(canPlace(settle(lifted), 'main', 'far')).toBe(true);
  });

  it('standing on materialized back footing, the orb cannot be picked up', () => {
    const orbs = settle(placeOn(createOrbs(0), 'main', 'gap'));
    expect(canPickUp(orbs, 'main', { pedestals, footing: bridge, feet: [1.2, 0, 0] })).toBe(false);
  });

  it('standing on shared ground, the orb can be picked up', () => {
    const orbs = settle(placeOn(createOrbs(0), 'main', 'gap'));
    expect(canPickUp(orbs, 'main', { pedestals, footing: bridge, feet: [-1.5, 0, 0] })).toBe(true);
  });

  it('footing still held by another orb does not block the pickup', () => {
    // 2手先: a small orb keeps the path while the main orb is taken to peek ahead.
    let orbs = placeOn(createOrbs(1), 'main', 'gap');
    orbs = settle(placeOn(orbs, 'small-1', 'far'));
    expect(canPickUp(orbs, 'main', { pedestals, footing: bridge, feet: [2.4, 0, 0] })).toBe(true);
    expect(canPickUp(orbs, 'main', { pedestals, footing: bridge, feet: [0.3, 0, 0] })).toBe(false);
  });

  it('a sphere that is already shrinking does not count as holding the footing', () => {
    // small orb picked up (its sphere shrinks) while both spheres still cover the feet
    let orbs = placeOn(createOrbs(1), 'main', 'gap');
    orbs = settle(placeOn(orbs, 'small-1', 'far'));
    orbs = takeBack(orbs, 'small-1');
    expect(canPickUp(orbs, 'main', { pedestals, footing: bridge, feet: [2.4, 0, 0] })).toBe(false);
  });

  it('an orb in hand cannot be picked up', () => {
    expect(canPickUp(createOrbs(0), 'main', { pedestals, footing: bridge, feet: [-1.5, 0, 0] })).toBe(false);
  });
});
