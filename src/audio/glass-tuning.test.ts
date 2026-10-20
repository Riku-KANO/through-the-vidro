import { describe, expect, it } from 'vitest';
import { designGlassVoice, GLASS_STRENGTHS, type GlassStrength, type GlassVoice } from '../core/audio/glass';
import { mulberry32 } from '../core/audio/rng';
import { VIDRO_GLASS } from './glass-tuning';

function upperShare(v: GlassVoice): number {
  const total = v.partials.reduce((s, p) => s + p.gain, 0);
  return v.partials.filter((p) => p.hz > v.hz * 1.5).reduce((s, p) => s + p.gain, 0) / total;
}
function voice(strength: GlassStrength, seed = 1, size = 0.1, hz = 880) {
  return designGlassVoice({ hz, size, strength }, mulberry32(seed), VIDRO_GLASS);
}

describe('Vidro glass tuning', () => {
  it('makes a harder strike louder, brighter and sharper (touch < tap < hit)', () => {
    const touch = voice('touch', 5);
    const tap = voice('tap', 5);
    const hit = voice('hit', 5);
    expect(touch.level).toBeLessThan(tap.level);
    expect(tap.level).toBeLessThan(hit.level);
    expect(upperShare(touch)).toBeLessThan(upperShare(tap));
    expect(upperShare(tap)).toBeLessThan(upperShare(hit));
    expect(touch.attack).toBeGreaterThan(tap.attack);
    expect(tap.attack).toBeGreaterThan(hit.attack);
  });

  it('rings longer for bigger glass', () => {
    expect(voice('tap', 4, 0.8, 220).duration).toBeGreaterThan(voice('tap', 4, 0.04, 1760).duration * 1.5);
  });

  it('keeps the random detune far inside the ±3 % pitch tolerance (stays on the scale note)', () => {
    for (let seed = 1; seed <= 50; seed++)
      expect(Math.abs(voice('tap', seed).hz / 880 - 1)).toBeLessThan(0.006);
  });

  it('cannot clip on its own (partials + strike stay below full scale for every seed)', () => {
    for (const s of GLASS_STRENGTHS) {
      for (let seed = 1; seed < 40; seed++) {
        const v = voice(s, seed);
        expect(v.partials.reduce((acc, p) => acc + p.gain, 0) + (v.strike?.gain ?? 0)).toBeLessThanOrEqual(1);
      }
    }
  });
});
