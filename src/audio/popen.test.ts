import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../core/audio/rng';
import { isInScale } from '../core/audio/scale';
import { designPopen, POPEN_KINDS, type PopenKind } from './popen';
import { VIDRO_SCALE } from './tuning';

describe('popen (the hand orb’s “po-pen”)', () => {
  it('has the four kinds: peek, place, pick up, tremble', () => {
    expect([...POPEN_KINDS].sort()).toEqual(['peek', 'pickup', 'place', 'tremble']);
  });

  it('keeps every pop on the game scale', () => {
    for (const kind of POPEN_KINDS) {
      for (let seed = 1; seed <= 10; seed++) {
        for (const pop of designPopen(kind, mulberry32(seed)).pops) {
          expect(isInScale(pop.midi, VIDRO_SCALE), `${kind} ${pop.midi}`).toBe(true);
        }
      }
    }
  });

  it('is a short two-note sound for peek, place and pick up', () => {
    for (const kind of ['peek', 'place', 'pickup'] as const) {
      const score = designPopen(kind, mulberry32(1));
      expect(score.pops).toHaveLength(2);
      expect(score.duration).toBeLessThan(0.6);
      const gap = (score.pops[1]?.time ?? 0) - (score.pops[0]?.time ?? 0);
      expect(gap).toBeGreaterThan(0.05);
      expect(gap).toBeLessThan(0.2);
    }
  });

  it('gives each action its own contour: peek level, pick up rising, place falling', () => {
    const contour = (kind: PopenKind) => designPopen(kind, mulberry32(1)).pops.map((p) => p.midi);
    const [peek0, peek1] = contour('peek');
    const [up0, up1] = contour('pickup');
    const [down0, down1] = contour('place');
    expect(peek1).toBe(peek0);
    expect(up1).toBeGreaterThan(up0 as number);
    expect(down1).toBeLessThan(down0 as number);
    expect(new Set(POPEN_KINDS.map((k) => contour(k).join(','))).size).toBe(4);
  });

  it('voices a pair as a soft short “po” and a brighter, longer “pen”', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const [po, pen] = designPopen('place', mulberry32(seed)).pops;
      expect(po?.gain).toBeLessThan(pen?.gain as number);
      expect(po?.bright).toBeLessThan(pen?.bright as number);
      expect(po?.t60).toBeLessThan(pen?.t60 as number);
    }
  });

  it('cannot clip on its own (body + overtone + click)', () => {
    for (const kind of POPEN_KINDS) {
      for (let seed = 1; seed < 30; seed++) {
        for (const p of designPopen(kind, mulberry32(seed)).pops) {
          expect(p.gain * (1 + p.bright * 0.5 + 0.25 * (0.5 + p.bright))).toBeLessThan(1);
        }
      }
    }
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
});
