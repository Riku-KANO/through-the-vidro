import { describe, expect, it } from 'vitest';
import { peak, rms, spectralCentroid } from '../core/audio/analysis';
import { Biquad } from '../core/audio/dsp';
import { isInScale } from '../core/audio/scale';
import {
  finaleSources,
  GATE_HUM_NOTES,
  GATE_KNOCK_NOTES,
  GATE_LATCH_NOTE,
  renderGateOpen,
  renderSettle,
  SETTLE_CHORD,
  SETTLE_RUN_NOTES,
} from './finale';
import { VIDRO_SCALE } from './tuning';

const SR = 44100;
const at = (s: number): number => Math.round(s * SR);
const RUN = 1.6;
const SWING = 2.6;

describe('the bridge settling (S-34: 光が橋を渡っていく音, 合成の仮置き)', () => {
  it('is on the game’s scale (音階の統一): a run that climbs, over a chord of D and A', () => {
    for (const m of [...SETTLE_RUN_NOTES, ...SETTLE_CHORD])
      expect(isInScale(m, VIDRO_SCALE), `${m}`).toBe(true);
    for (let i = 1; i < SETTLE_RUN_NOTES.length; i++)
      expect(SETTLE_RUN_NOTES[i] as number).toBeGreaterThan(SETTLE_RUN_NOTES[i - 1] as number);
    expect(SETTLE_RUN_NOTES.length).toBeGreaterThanOrEqual(5);
  });

  it('lasts the light’s crossing and a tail, starts and ends in silence and never clips', () => {
    const x = renderSettle(SR, RUN);
    expect(x.length / SR).toBeGreaterThan(RUN + 0.8);
    expect(x.length / SR).toBeLessThan(RUN + 3.5);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(peak(x)).toBeLessThanOrEqual(1);
    expect(peak(x)).toBeGreaterThan(0.5);
    expect(Math.abs(x[0] as number)).toBeLessThan(0.05);
    expect(rms(x, x.length - at(0.005))).toBeLessThan(2e-3);
    // it sounds all the way across (no gap while the light is on the bridge)
    for (let t = 0.1; t < RUN; t += 0.2)
      expect(rms(x, at(t), at(t + 0.2)), `${t.toFixed(1)} s`).toBeGreaterThan(0.01);
  });

  it('climbs as the light crosses: its notes are higher at the far end of the run than where it leaves the vidro', () => {
    // the notes only (the run is D5 … A6): the chord below them and the air and the glass's ticks above them left out
    const a = new Biquad(SR).lowpass(2600, 0.7);
    const b = new Biquad(SR).lowpass(2600, 0.7);
    const c = new Biquad(SR).highpass(480, 0.7);
    const x = renderSettle(SR, RUN).map((v) => c.process(b.process(a.process(v))));
    // as the light leaves the vidro, and as it reaches the far shore
    expect(spectralCentroid(x, SR, RUN - 0.1, 0.15)).toBeGreaterThan(
      spectralCentroid(x, SR, 0.05, 0.15) * 1.6,
    );
  });
});

describe('the gate opening (S-34: 門が開く音, 合成の仮置き)', () => {
  it('rings brass on the scale: the latch, the hinges’ hum, the leaves coming to rest', () => {
    for (const m of [GATE_LATCH_NOTE, ...GATE_HUM_NOTES, ...GATE_KNOCK_NOTES])
      expect(isInScale(m, VIDRO_SCALE), `${m}`).toBe(true);
  });

  it('a latch at once, the swing, then the knocks of the leaves stopping where the swing ends', () => {
    const x = renderGateOpen(SR, SWING);
    expect(x.length / SR).toBeGreaterThan(SWING + 0.4);
    expect(x.length / SR).toBeLessThan(SWING + 2.5);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(peak(x)).toBeLessThanOrEqual(1);
    expect(Math.abs(x[0] as number)).toBeLessThan(0.05);
    expect(rms(x, x.length - at(0.005))).toBeLessThan(2e-3);
    const p = peak(x);
    // the latch: loud at once
    expect(peak(x, 0, at(0.06))).toBeGreaterThan(p * 0.5);
    // the knocks stand out over the end of the swing just before them
    const knock = peak(x, at(SWING - 0.15), at(SWING + 0.35));
    expect(knock).toBeGreaterThan(peak(x, at(SWING - 0.6), at(SWING - 0.3)) * 1.5);
    // the swing is heard, softer than the latch
    expect(rms(x, at(SWING * 0.4), at(SWING * 0.6))).toBeGreaterThan(0.005);
  });
});

describe('the close’s sounds as sources (S-22: bank.ts の口、録音に差し替えられる形)', () => {
  it('each is a SoundSource of its own, made the same every time', () => {
    const s = finaleSources({ settleSeconds: RUN, gateSeconds: SWING });
    expect(s.settle.id).not.toBe(s.gate.id);
    expect(s.settle.kind).toBe('synth');
    expect(s.gate.kind).toBe('synth');
    if (s.settle.kind !== 'synth') throw new Error('synth');
    expect(Array.from(s.settle.render(SR).slice(0, 2000))).toEqual(
      Array.from(renderSettle(SR, RUN).slice(0, 2000)),
    );
  });
});
