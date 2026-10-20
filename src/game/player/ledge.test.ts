import { describe, expect, it } from 'vitest';
import { WALK_SPEED } from './constants';
import { findLedges, type GroundProbe, LEDGE_DEFAULTS, limitVelocityAtLedges } from './ledge';

/** Ground height at (x, z), or null over the void. Values above the probe start count as walls. */
type Heights = (x: number, z: number) => number | null;

function probeOf(heights: Heights): GroundProbe {
  return (x, z, fromY, depth) => {
    const h = heights(x, z);
    if (h === null) return null;
    if (h >= fromY) return { y: fromY, ny: 1, fat: false };
    if (fromY - h > depth) return null;
    // Surface normal from the height field's slope.
    const e = 1e-4;
    const gx = ((heights(x + e, z) ?? h) - (heights(x - e, z) ?? h)) / (2 * e);
    const gz = ((heights(x, z + e) ?? h) - (heights(x, z - e) ?? h)) / (2 * e);
    return { y: h, ny: 1 / Math.hypot(1, gx, gz), fat: false };
  };
}

const square: Heights = (x, z) => (Math.abs(x) <= 5 && Math.abs(z) <= 5 ? 0 : null);
const walkway: Heights = (x, z) => (Math.abs(x) <= 0.5 && Math.abs(z) <= 20 ? 0 : null);
const disc: Heights = (x, z) => (Math.hypot(x, z) <= 3 ? 0 : null);

/** Integrates the pure ledge rule: the wished velocity is limited every frame. Returns the path. */
function walk(
  heights: Heights,
  start: { x: number; z: number },
  dir: { x: number; z: number },
  seconds: number,
) {
  const probe = probeOf(heights);
  const dt = 1 / 60;
  const len = Math.hypot(dir.x, dir.z);
  const wish = { x: (dir.x / len) * WALK_SPEED, z: (dir.z / len) * WALK_SPEED };
  let { x, z } = start;
  const path: { x: number; z: number; speed: number; supported: boolean }[] = [];
  for (let t = 0; t < seconds; t += dt) {
    const ground = heights(x, z) ?? 0;
    const v = limitVelocityAtLedges(wish, findLedges(x, z, ground, probe));
    x += v.x * dt;
    z += v.z * dt;
    path.push({ x, z, speed: Math.hypot(v.x, v.z), supported: heights(x, z) !== null });
  }
  return path;
}

describe('findLedges', () => {
  it('finds nothing in the middle of a platform', () => {
    expect(findLedges(0, 0, 0, probeOf(square))).toEqual([]);
  });

  it('finds the nearby edge with its outward direction and distance', () => {
    const ledges = findLedges(4.6, 0.13, 0, probeOf(square));
    expect(ledges).toHaveLength(1);
    const [ledge] = ledges;
    expect(Math.abs(ledge?.nx ?? 0)).toBeGreaterThan(Math.cos((2 * Math.PI) / 180));
    expect(ledge?.nx).toBeGreaterThan(0);
    expect(ledge?.distance).toBeCloseTo(0.4, 1);
  });

  it('finds both sides of a narrow walkway', () => {
    const ledges = findLedges(0, 0, 0, probeOf(walkway));
    expect(ledges.length).toBeGreaterThanOrEqual(2);
    expect(ledges.some((l) => l.nx > 0.95)).toBe(true);
    expect(ledges.some((l) => l.nx < -0.95)).toBe(true);
  });

  it('does not treat a wall as a ledge', () => {
    const walled: Heights = (x, z) => (x > 2 ? 3 : square(x, z));
    expect(findLedges(1.6, 0, 0, probeOf(walled))).toEqual([]);
  });

  it('lets you walk down stairs and ramps (段差は自動で上り下りする)', () => {
    const stairs: Heights = (x) => -Math.max(0, Math.floor(x / 0.35)) * 0.2;
    const ramp: Heights = (x) => -Math.max(0, x) * Math.tan((30 * Math.PI) / 180);
    for (let x = -1; x < 2; x += 0.05) {
      expect(findLedges(x, 0, stairs(x, 0) ?? 0, probeOf(stairs)), `stairs at x=${x}`).toEqual([]);
      expect(findLedges(x, 0, ramp(x, 0) ?? 0, probeOf(ramp)), `ramp at x=${x}`).toEqual([]);
    }
  });

  it('treats a drop higher than a step as a ledge', () => {
    const drop: Heights = (x) => (x > 0.4 ? -0.5 : 0);
    const ledges = findLedges(0, 0, 0, probeOf(drop));
    expect(ledges).toHaveLength(1);
    expect(ledges[0]?.distance).toBeCloseTo(0.4, 1);
  });

  it('treats a descent steeper than the climbable slope as an edge where it starts', () => {
    const steep: Heights = (x) => (x > 0.4 ? -(x - 0.4) * Math.tan((50 * Math.PI) / 180) : 0);
    const ledges = findLedges(0, 0, 0, probeOf(steep));
    expect(ledges).toHaveLength(1);
    expect(ledges[0]?.nx).toBeGreaterThan(0.95);
    expect(ledges[0]?.distance).toBeCloseTo(0.4, 1);
  });

  it('lets you walk down slopes up to the climbable angle and stairs with short treads', () => {
    const ramp38: Heights = (x) => -Math.max(0, x) * Math.tan((38 * Math.PI) / 180);
    const stairs: Heights = (x) => -Math.max(0, Math.floor(x / 0.3)) * 0.2;
    for (let x = -1; x < 2; x += 0.05) {
      expect(findLedges(x, 0, ramp38(x, 0) ?? 0, probeOf(ramp38)), `38° at x=${x}`).toEqual([]);
      expect(findLedges(x, 0, stairs(x, 0) ?? 0, probeOf(stairs)), `stairs at x=${x}`).toEqual([]);
    }
  });

  it('does not pin a body that already stands on too steep a slope', () => {
    const steep: Heights = (x) => -x * Math.tan((50 * Math.PI) / 180);
    expect(findLedges(0, 0, 0, probeOf(steep))).toEqual([]);
  });

  it('does not hold an airborne body that is already past the edge', () => {
    expect(findLedges(6, 0, 0, probeOf(square))).toEqual([]);
  });
});

describe('limitVelocityAtLedges', () => {
  const edge = [{ nx: 1, nz: 0, distance: LEDGE_DEFAULTS.margin }];

  it('stops motion over the edge at the margin but keeps sliding along it', () => {
    const v = limitVelocityAtLedges({ x: 1, z: -1 }, edge);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(-1, 6);
  });

  it('does not slow you down when walking away from the edge', () => {
    expect(limitVelocityAtLedges({ x: -1.4, z: 0 }, edge)).toEqual({ x: -1.4, z: 0 });
  });
});

describe('walking at ledges (足場の縁ではやわらかく止まる)', () => {
  it('walking straight at an edge never falls and comes to rest near it', () => {
    const path = walk(square, { x: 2, z: 0 }, { x: 1, z: 0 }, 5);
    expect(path.every((p) => p.supported)).toBe(true);
    const end = path[path.length - 1];
    expect(end?.speed).toBeLessThan(0.05);
    expect(5 - (end?.x ?? 0)).toBeGreaterThan(LEDGE_DEFAULTS.margin - 0.03);
    expect(5 - (end?.x ?? 0)).toBeLessThan(LEDGE_DEFAULTS.margin + 0.1);
  });

  it('slows down softly over several frames instead of stopping dead', () => {
    const path = walk(square, { x: 2, z: 0 }, { x: 1, z: 0 }, 5);
    let maxDrop = 0;
    for (let i = 1; i < path.length; i++) {
      maxDrop = Math.max(maxDrop, (path[i - 1]?.speed ?? 0) - (path[i]?.speed ?? 0));
    }
    expect(maxDrop).toBeLessThan(0.25);
    const slowing = path.filter((p) => p.speed < WALK_SPEED * 0.9 && p.speed > 0.1).length;
    expect(slowing / 60).toBeGreaterThan(0.2);
  });

  it('in a corner, never falls off either side', () => {
    for (const dir of [
      { x: 1, z: 0 },
      { x: 0, z: 1 },
      { x: 1, z: 1 },
      { x: 1, z: 0.3 },
    ]) {
      const path = walk(square, { x: 3.5, z: 3.5 }, dir, 4);
      expect(path.every((p) => p.supported)).toBe(true);
    }
  });

  it('on a narrow walkway, walking diagonally slides along it without falling', () => {
    const path = walk(walkway, { x: 0, z: 0 }, { x: 1, z: -1 }, 4);
    expect(path.every((p) => p.supported)).toBe(true);
    expect(-(path[path.length - 1]?.z ?? 0)).toBeGreaterThan(2.5);
  });

  it('on a round platform, walking around the rim keeps you on it', () => {
    const probe = probeOf(disc);
    const dt = 1 / 60;
    let x = 2.6;
    let z = 0;
    for (let t = 0; t < 6; t += dt) {
      // Aim slightly outward of the tangent, as a player hugging the rim would.
      const r = Math.hypot(x, z);
      const tx = -z / r;
      const tz = x / r;
      const wish = { x: (tx + 0.3 * (x / r)) * WALK_SPEED, z: (tz + 0.3 * (z / r)) * WALK_SPEED };
      const v = limitVelocityAtLedges(wish, findLedges(x, z, 0, probe));
      x += v.x * dt;
      z += v.z * dt;
      expect(Math.hypot(x, z)).toBeLessThan(3);
    }
  });
});
