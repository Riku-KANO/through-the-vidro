import { describe, expect, it } from 'vitest';
import { designPopen, POPEN_KINDS } from './popen';
import { mulberry32 } from './rng';
import { isInScale, midiToHz } from './scale';

describe('popen (the hand orb’s “po-pen”)', () => {
  it('has the four kinds: peek, place, pick up, tremble', () => {
    expect([...POPEN_KINDS].sort()).toEqual(['peek', 'pickup', 'place', 'tremble']);
  });

  it('keeps every pop on a scale note', () => {
    for (const kind of POPEN_KINDS) {
      for (let seed = 1; seed <= 10; seed++) {
        const score = designPopen(kind, mulberry32(seed));
        for (const pop of score.pops) {
          expect(isInScale(pop.midi), `${kind} ${pop.midi}`).toBe(true);
          expect(Math.abs(pop.hz / midiToHz(pop.midi) - 1)).toBeLessThan(0.005);
        }
      }
    }
  });

  it('is a short two-note sound for peek, place and pick up', () => {
    for (const kind of ['peek', 'place', 'pickup'] as const) {
      const score = designPopen(kind, mulberry32(1));
      expect(score.pops).toHaveLength(2);
      expect(score.duration).toBeLessThan(0.6);
      const [po, pen] = score.pops;
      expect((pen?.time ?? 0) - (po?.time ?? 0)).toBeGreaterThan(0.05);
      expect((pen?.time ?? 1) - (po?.time ?? 0)).toBeLessThan(0.2);
    }
  });

  it('gives each action its own contour', () => {
    const contour = (kind: (typeof POPEN_KINDS)[number]) =>
      designPopen(kind, mulberry32(1)).pops.map((p) => p.midi);
    const [pickUp0, pickUp1] = contour('pickup');
    const [place0, place1] = contour('place');
    expect(pickUp1).toBeGreaterThan(pickUp0 as number); // lifting rises
    expect(place1).toBeLessThan(place0 as number); // setting down falls
    const all = POPEN_KINDS.map((k) => contour(k).join(','));
    expect(new Set(all).size).toBe(4);
  });

  it('trembles with several quick, quieter pops', () => {
    const tremble = designPopen('tremble', mulberry32(1));
    const peek = designPopen('peek', mulberry32(1));
    expect(tremble.pops.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...tremble.pops.map((p) => p.gain))).toBeLessThan(
      Math.max(...peek.pops.map((p) => p.gain)),
    );
    expect(tremble.duration).toBeLessThan(0.8);
  });

  it('varies slightly from one play to the next', () => {
    const a = designPopen('peek', mulberry32(1));
    const b = designPopen('peek', mulberry32(2));
    expect(a).not.toEqual(b);
    expect(a.pops.map((p) => p.midi)).toEqual(b.pops.map((p) => p.midi));
  });
});
