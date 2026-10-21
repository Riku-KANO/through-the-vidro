/**
 * Plain-JS signal building blocks for synthesizing sounds into sample arrays (S-22): filters, envelopes, ringing
 * partials, seamless loops. Pure (no Web Audio), so a synthesized sound is a Float32Array that unit tests can measure
 * and that plays through the same buffer port as a recording (bank.ts). The recipes — what a footstep or the wind
 * is made of — are the game's (Through the Vidro: src/audio/footsteps.ts, ambience.ts).
 */
import { LN1000 } from './glass';

/** A biquad filter (RBJ cookbook), run one sample at a time. Retuning keeps its state (no click). */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(readonly sampleRate: number) {}

  lowpass(hz: number, q = Math.SQRT1_2): this {
    const { cos, alpha } = this.prewarp(hz, q);
    return this.set((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }

  highpass(hz: number, q = Math.SQRT1_2): this {
    const { cos, alpha } = this.prewarp(hz, q);
    return this.set((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }

  /** Band-pass with a 0 dB peak at `hz`. */
  bandpass(hz: number, q: number): this {
    const { cos, alpha } = this.prewarp(hz, q);
    return this.set(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha);
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  private prewarp(hz: number, q: number): { cos: number; alpha: number } {
    const f = Math.min(this.sampleRate * 0.49, Math.max(1, hz));
    const w = (2 * Math.PI * f) / this.sampleRate;
    return { cos: Math.cos(w), alpha: Math.sin(w) / (2 * Math.max(1e-3, q)) };
  }

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }
}

/** Per-sample multiplier of an exponential decay that falls 60 dB in `t60` seconds. */
export function decayPerSample(t60: number, sampleRate: number): number {
  return Math.exp(-LN1000 / (Math.max(1e-6, t60) * sampleRate));
}

export function peakOf(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] as number));
  return m;
}

/** Scales `x` in place so its peak is `peak` (silence stays silence). Returns `x`. */
export function normalizePeak(x: Float32Array, peak: number): Float32Array {
  const m = peakOf(x);
  if (m > 0) {
    const k = peak / m;
    for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) * k;
  }
  return x;
}

/** A ringing partial: a sine at `hz`, peak `gain`, decaying by 60 dB in `t60` seconds. */
export interface RingingPartial {
  hz: number;
  gain: number;
  t60: number;
}

/**
 * Adds decaying sines into `out` from `start` seconds, each rising linearly over `attack` seconds. A rotating phasor
 * stands in for Math.sin (cheap for long rings); it stops where the buffer ends.
 */
export function addPartials(
  out: Float32Array,
  partials: readonly RingingPartial[],
  opts: { start: number; attack: number; sampleRate: number },
): void {
  const { sampleRate } = opts;
  const from = Math.max(0, Math.round(opts.start * sampleRate));
  const attack = Math.max(0, Math.round(opts.attack * sampleRate));
  for (const p of partials) {
    if (!(p.hz > 0) || p.hz >= sampleRate / 2 || p.gain === 0) continue;
    const w = (2 * Math.PI * p.hz) / sampleRate;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const k = decayPerSample(p.t60, sampleRate);
    // sin and cos of the phase, advanced by rotation
    let s = 0;
    let c = 1;
    let env = p.gain;
    for (let i = from, n = 0; i < out.length; i++, n++) {
      const rise = attack > 0 && n < attack ? n / attack : 1;
      out[i] = (out[i] as number) + s * env * rise;
      const s2 = s * cw + c * sw;
      c = c * cw - s * sw;
      s = s2;
      env *= k;
      if (env < 1e-6 * Math.abs(p.gain)) break;
    }
  }
}

/**
 * A loop without a seam: the last `fade` samples are crossfaded (equal power) into the first ones, and the result is
 * that much shorter. Played as a loop, its end runs into its start as the original ran on past the cut.
 */
export function crossfadeLoop(x: Float32Array, fade: number): Float32Array {
  const f = Math.max(0, Math.min(Math.floor(fade), Math.floor(x.length / 2)));
  const n = x.length - f;
  const y = x.slice(0, n);
  for (let i = 0; i < f; i++) {
    const u = (i + 0.5) / f;
    const fadeIn = Math.sin((u * Math.PI) / 2);
    const fadeOut = Math.cos((u * Math.PI) / 2);
    y[i] = (x[i] as number) * fadeIn + (x[n + i] as number) * fadeOut;
  }
  return y;
}

/** Linear fade-in and fade-out at the ends (ms-long, so a sound never starts or stops with a click). */
export function fadeEnds(x: Float32Array, inSamples: number, outSamples: number): Float32Array {
  const a = Math.min(inSamples, x.length);
  for (let i = 0; i < a; i++) x[i] = (x[i] as number) * (i / a);
  const b = Math.min(outSamples, x.length);
  for (let i = 0; i < b; i++) {
    const j = x.length - 1 - i;
    x[j] = (x[j] as number) * (i / b);
  }
  return x;
}
