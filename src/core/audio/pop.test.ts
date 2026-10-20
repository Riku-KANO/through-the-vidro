import { describe, expect, it } from 'vitest';
import { designPops, type PopPattern } from './pop';
import { mulberry32 } from './rng';
import { midiToHz } from './scale';

const pair: PopPattern = { notes: [72, 76], spacing: 0.1, gain: 0.5, fade: 1, pair: true };
const run: PopPattern = { notes: [72, 74, 72, 74, 72], spacing: 0.06, gain: 0.3, fade: 0.8, pair: false };

describe('thin-glass pops (generic)', () => {
  it('plays the given notes in order, on pitch', () => {
    const score = designPops(pair, mulberry32(1));
    expect(score.pops.map((p) => p.midi)).toEqual([72, 76]);
    for (const p of score.pops) expect(Math.abs(p.hz / midiToHz(p.midi) - 1)).toBeLessThan(0.005);
    expect(score.pops[1]?.time).toBeGreaterThan(0.08);
    expect(score.pops[1]?.time).toBeLessThan(0.12);
  });

  it('articulates a pair as a soft short pop then a brighter, longer one', () => {
    const [po, pen] = designPops(pair, mulberry32(3)).pops;
    expect(po?.bright).toBeLessThan(pen?.bright as number);
    expect(po?.t60).toBeLessThan(pen?.t60 as number);
    expect(po?.gain).toBeLessThan(pen?.gain as number);
  });

  it('fades a run of pops and keeps it short', () => {
    const score = designPops(run, mulberry32(1));
    expect(score.pops).toHaveLength(5);
    expect(score.pops[4]?.gain).toBeLessThan(score.pops[0]?.gain as number);
    expect(score.duration).toBeLessThan(0.6);
  });

  it('varies slightly per play but is deterministic per seed', () => {
    expect(designPops(pair, mulberry32(1))).toEqual(designPops(pair, mulberry32(1)));
    expect(designPops(pair, mulberry32(1))).not.toEqual(designPops(pair, mulberry32(2)));
  });

  it('cannot clip on its own', () => {
    for (let seed = 1; seed < 30; seed++) {
      for (const p of designPops(pair, mulberry32(seed)).pops) {
        // body + overtone + click
        expect(p.gain * (1 + p.bright * 0.5 + 0.25 * (0.5 + p.bright))).toBeLessThan(1);
      }
    }
  });
});
