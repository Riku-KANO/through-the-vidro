import { describe, expect, it } from 'vitest';
import { designGlassVoice, GLASS_STRENGTHS, type GlassStrength, type GlassVoice } from './glass';
import { mulberry32 } from './rng';

const base = { hz: 880, size: 0.1 };

function upperShare(v: GlassVoice): number {
  const total = v.partials.reduce((s, p) => s + p.gain, 0);
  const upper = v.partials.filter((p) => p.hz > v.hz * 1.5).reduce((s, p) => s + p.gain, 0);
  return upper / total;
}

function voice(strength: GlassStrength, seed = 1, extra: Partial<{ hz: number; size: number }> = {}) {
  return designGlassVoice({ ...base, ...extra, strength }, mulberry32(seed));
}

describe('glass voice (modal synthesis)', () => {
  it('rings at the requested pitch with only a tiny random detune', () => {
    const detunes = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const v = voice('tap', seed);
      expect(Math.abs(v.hz / base.hz - 1)).toBeLessThan(0.006);
      detunes.add(Math.round(v.hz * 1000));
    }
    // Every strike is slightly different so repeated taps never sound mechanical.
    expect(detunes.size).toBeGreaterThan(30);
  });

  it('is deterministic for the same seed', () => {
    expect(voice('hit', 9)).toEqual(voice('hit', 9));
  });

  it('has glass-like, non-integer overtones', () => {
    for (const s of GLASS_STRENGTHS) {
      const v = voice(s, 3);
      const overtones = v.partials.filter((p) => p.hz > v.hz * 1.5);
      expect(overtones.length).toBeGreaterThanOrEqual(2);
      for (const p of overtones) {
        const ratio = p.hz / v.hz;
        expect(Math.abs(ratio - Math.round(ratio)), `ratio ${ratio}`).toBeGreaterThan(0.1);
      }
    }
  });

  it('makes a harder strike louder, brighter and sharper', () => {
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

  it('lets higher modes die away faster than the fundamental', () => {
    const v = voice('hit', 2);
    const fundamental = v.partials.find((p) => Math.abs(p.hz / v.hz - 1) < 0.01);
    expect(fundamental).toBeDefined();
    for (const p of v.partials.filter((q) => q.hz > v.hz * 1.5)) {
      expect(p.t60).toBeLessThan((fundamental as { t60: number }).t60);
    }
  });

  it('rings longer for bigger glass', () => {
    const small = voice('tap', 4, { size: 0.04, hz: 1760 });
    const big = voice('tap', 4, { size: 0.8, hz: 220 });
    expect(big.duration).toBeGreaterThan(small.duration * 1.5);
  });

  it('never schedules overtones above the Nyquist-safe limit', () => {
    const v = designGlassVoice({ hz: 4000, size: 0.02, strength: 'hit', sampleRate: 22050 }, mulberry32(1));
    for (const p of v.partials) expect(p.hz).toBeLessThan(22050 * 0.45);
  });

  it('cannot clip on its own (summed partial gains stay below full scale)', () => {
    for (const s of GLASS_STRENGTHS) {
      for (let seed = 1; seed < 20; seed++) {
        const v = voice(s, seed);
        const sum = v.partials.reduce((acc, p) => acc + p.gain, 0) + (v.strike?.gain ?? 0);
        expect(sum).toBeLessThanOrEqual(1);
      }
    }
  });
});
