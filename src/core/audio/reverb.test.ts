import { describe, expect, it } from 'vitest';
import { correlation, decayT60, spectralCentroid } from './analysis';
import { ROOM_PRESETS, synthesizeImpulseResponse } from './reverb';
import { mulberry32 } from './rng';

const SR = 44100;

describe('synthesized room impulse responses', () => {
  const small = ROOM_PRESETS.smallRoom;
  const dome = ROOM_PRESETS.largeDome;

  it('a small workshop is short and a dome is long', () => {
    expect(small.t60).toBeLessThan(1);
    expect(dome.t60).toBeGreaterThan(small.t60 * 3);
  });

  it('decays at the preset T60 (within 15 %)', () => {
    for (const preset of [small, dome]) {
      const [left, right] = synthesizeImpulseResponse(preset, SR, mulberry32(3));
      for (const ch of [left, right]) {
        const t60 = decayT60(ch as Float32Array, SR) as number;
        expect(Math.abs(t60 / preset.t60 - 1), `${preset.id} measured ${t60}`).toBeLessThan(0.15);
      }
    }
  });

  it('contains the whole tail and starts after the pre-delay', () => {
    for (const preset of [small, dome]) {
      const chans = synthesizeImpulseResponse(preset, SR, mulberry32(1));
      expect(chans).toHaveLength(2);
      const ch = chans[0] as Float32Array;
      expect(ch.length / SR).toBeGreaterThanOrEqual(preset.t60);
      const pre = Math.floor(preset.preDelay * SR);
      for (const c of chans) for (let i = 0; i < pre; i++) expect(c[i]).toBe(0);
    }
  });

  it('is stereo (left and right are decorrelated)', () => {
    const [l, r] = synthesizeImpulseResponse(dome, SR, mulberry32(5));
    expect(Math.abs(correlation(l as Float32Array, r as Float32Array))).toBeLessThan(0.2);
  });

  it('gets darker as it decays (high frequencies are absorbed first)', () => {
    const [l] = synthesizeImpulseResponse(dome, SR, mulberry32(2));
    const head = spectralCentroid(l as Float32Array, SR, dome.preDelay + 0.05, 0.2);
    const tail = spectralCentroid(l as Float32Array, SR, dome.preDelay + dome.t60 * 0.6, 0.2);
    expect(tail).toBeLessThan(head * 0.8);
  });

  it('is normalised so rooms can be swapped without a jump in loudness', () => {
    for (const preset of [small, dome]) {
      const chans = synthesizeImpulseResponse(preset, SR, mulberry32(4));
      let energy = 0;
      for (const c of chans) for (const v of c) energy += v * v;
      expect(energy).toBeCloseTo(1, 2);
    }
  });

  it('is deterministic for a seed', () => {
    const a = synthesizeImpulseResponse(small, SR, mulberry32(8));
    const b = synthesizeImpulseResponse(small, SR, mulberry32(8));
    expect(a[0]).toEqual(b[0]);
  });
});
