import { describe, expect, it } from 'vitest';
import { decayT60, estimatePitch, rms } from './analysis';
import { addPartials, Biquad, crossfadeLoop, decayPerSample, normalizePeak, peakOf } from './dsp';

const SR = 48000;

function sine(hz: number, seconds: number, sampleRate = SR): Float32Array {
  const x = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return x;
}

/** Steady-state gain (dB) of a filter for a sine, measured after it settles. */
function gainDb(make: () => Biquad, hz: number): number {
  const f = make();
  const x = sine(hz, 0.2);
  const y = x.map((v) => f.process(v));
  const from = Math.round(0.1 * SR);
  return 20 * Math.log10(rms(y, from) / rms(x, from));
}

describe('Biquad (sample-by-sample filters for synthesizing sounds in plain JS)', () => {
  it('a low-pass keeps the lows and cuts the highs', () => {
    const lp = () => new Biquad(SR).lowpass(500);
    expect(Math.abs(gainDb(lp, 100))).toBeLessThan(1);
    expect(gainDb(lp, 5000)).toBeLessThan(-30);
  });

  it('a high-pass keeps the highs and cuts the lows', () => {
    const hp = () => new Biquad(SR).highpass(2000);
    expect(Math.abs(gainDb(hp, 8000))).toBeLessThan(1);
    expect(gainDb(hp, 200)).toBeLessThan(-30);
  });

  it('a band-pass peaks at 0 dB on its centre and falls off around it', () => {
    const bp = () => new Biquad(SR).bandpass(1000, 5);
    expect(Math.abs(gainDb(bp, 1000))).toBeLessThan(0.5);
    expect(gainDb(bp, 3000)).toBeLessThan(-12);
    expect(gainDb(bp, 330)).toBeLessThan(-12);
  });

  it('can be retuned while running without blowing up', () => {
    const f = new Biquad(SR).bandpass(400, 1);
    let m = 0;
    for (let i = 0; i < SR; i++) {
      if (i % 64 === 0) f.bandpass(400 + 600 * Math.abs(Math.sin(i / 5000)), 1);
      m = Math.max(m, Math.abs(f.process(Math.sin(i / 7))));
    }
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeLessThan(4);
  });
});

describe('envelopes and levels', () => {
  it('decays by 60 dB over t60 seconds, sample by sample', () => {
    const k = decayPerSample(0.5, SR);
    expect(k ** (0.5 * SR)).toBeCloseTo(1e-3, 6);
  });

  it('normalizes the peak in place', () => {
    const x = Float32Array.from([0, 0.2, -0.5, 0.1]);
    expect(normalizePeak(x, 0.9)).toBe(x);
    expect(peakOf(x)).toBeCloseTo(0.9, 6);
    expect(normalizePeak(new Float32Array(4), 0.9).every((v) => v === 0)).toBe(true);
  });
});

describe('addPartials (a struck, ringing body as decaying sines)', () => {
  it('rings at its fundamental and dies away in its t60', () => {
    const out = new Float32Array(SR * 2);
    addPartials(out, [{ hz: 440, gain: 0.5, t60: 0.8 }], { start: 0, attack: 0.002, sampleRate: SR });
    expect(estimatePitch(out, SR, { start: 0.05, duration: 0.5 })).toBeCloseTo(440, 0);
    const t60 = decayT60(out, SR);
    expect(t60).not.toBeNull();
    expect(Math.abs((t60 as number) - 0.8)).toBeLessThan(0.08);
    expect(out[0]).toBe(0);
  });

  it('adds onto what is there, from where it starts, and stops at the end of the buffer', () => {
    const out = new Float32Array(1000).fill(0.1);
    addPartials(out, [{ hz: 1000, gain: 0.3, t60: 5 }], { start: 0.01, attack: 0, sampleRate: SR });
    expect(out[100]).toBeCloseTo(0.1, 6);
    expect(Math.abs((out[600] as number) - 0.1)).toBeGreaterThan(0);
  });
});

describe('crossfadeLoop (a recording or a render that loops without a seam)', () => {
  it('joins its end to its start as smoothly as any two neighbouring samples', () => {
    // 3.3 cycles: played as a loop as it is, the seam jumps
    const raw = sine(1000 / 3.3, 1);
    const fade = Math.round(0.1 * SR);
    const loop = crossfadeLoop(raw, fade);
    expect(loop.length).toBe(raw.length - fade);
    let steepest = 0;
    for (let i = 1; i < loop.length; i++)
      steepest = Math.max(steepest, Math.abs((loop[i] as number) - (loop[i - 1] as number)));
    const seam = Math.abs((loop[0] as number) - (loop[loop.length - 1] as number));
    expect(seam).toBeLessThanOrEqual(steepest * 1.01);
    const rawSeam = Math.abs((raw[0] as number) - (raw[raw.length - fade - 1] as number));
    expect(rawSeam).toBeGreaterThan(steepest * 5);
  });

  it('keeps the level of noise through the fade (equal power)', () => {
    let s = 1;
    const noise = new Float32Array(SR * 2).map(() => {
      s = (s * 16807) % 2147483647;
      return (s / 2147483647) * 2 - 1;
    });
    const fade = Math.round(0.5 * SR);
    const loop = crossfadeLoop(noise, fade);
    const inFade = rms(loop, Math.round(0.2 * SR), Math.round(0.3 * SR));
    const after = rms(loop, Math.round(0.8 * SR), Math.round(1.2 * SR));
    expect(inFade / after).toBeGreaterThan(0.85);
    expect(inFade / after).toBeLessThan(1.15);
  });
});
