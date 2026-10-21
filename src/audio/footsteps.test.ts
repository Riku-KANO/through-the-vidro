import { describe, expect, it } from 'vitest';
import { correlation, estimatePitch, peak, rms } from '../core/audio/analysis';
import { mulberry32 } from '../core/audio/rng';
import { isInScale, midiToHz } from '../core/audio/scale';
import {
  BRASS_RING_NOTES,
  FLOOR_MATERIALS,
  FOOTSTEP_SOURCES,
  FOOTSTEP_VARIANTS,
  FROSTED_RING_NOTES,
  footstepGain,
  nextVariant,
  renderFootstep,
} from './footsteps';
import { VIDRO_SCALE } from './tuning';

const SR = 44100;
const at = (s: number): number => Math.round(s * SR);

describe('footsteps (サウンドデザイン > 環境音: 床の材質ごとに、各8種類をランダムに)', () => {
  it('has 8 for each of 石畳・曇りガラス・真鍮の格子 (アセットリスト > 音: 足音 24 = 3材質 × 8種)', () => {
    expect([...FLOOR_MATERIALS]).toEqual(['stone', 'frosted', 'brass']);
    expect(FOOTSTEP_VARIANTS).toBe(8);
    const ids = new Set<string>();
    for (const m of FLOOR_MATERIALS) {
      expect(FOOTSTEP_SOURCES[m]).toHaveLength(8);
      for (const s of FOOTSTEP_SOURCES[m]) {
        expect(s.kind).toBe('synth');
        ids.add(s.id);
      }
    }
    expect(ids.size).toBe(24);
  });

  it('each is a short, audible step that starts and ends in silence (no click) and never clips', () => {
    for (const m of FLOOR_MATERIALS) {
      for (let v = 0; v < FOOTSTEP_VARIANTS; v++) {
        const x = renderFootstep(m, v, SR);
        const name = `${m} #${v + 1}`;
        expect(x.length / SR, name).toBeLessThanOrEqual(0.6);
        expect(x.every(Number.isFinite), name).toBe(true);
        expect(peak(x), name).toBeLessThanOrEqual(1);
        expect(rms(x, 0, at(0.15)), name).toBeGreaterThan(0.03);
        expect(Math.abs(x[0] as number), name).toBeLessThan(0.05);
        expect(rms(x, x.length - at(0.005)), name).toBeLessThan(2e-3);
      }
    }
  });

  it('the 8 of a material are 8 different steps, the same every time they are made', () => {
    for (const m of FLOOR_MATERIALS) {
      const steps = Array.from({ length: FOOTSTEP_VARIANTS }, (_, v) => renderFootstep(m, v, SR));
      for (let a = 0; a < steps.length; a++)
        for (let b = a + 1; b < steps.length; b++)
          expect(
            Math.abs(correlation(steps[a] as Float32Array, steps[b] as Float32Array)),
            `${m} ${a}/${b}`,
          ).toBeLessThan(0.9);
      expect(Array.from(renderFootstep(m, 3, SR))).toEqual(Array.from(steps[3] as Float32Array));
    }
  });

  it('glass and brass floors ring on the scale, so walking makes a small tune (音階の統一)', () => {
    for (const [m, notes] of [
      ['frosted', FROSTED_RING_NOTES],
      ['brass', BRASS_RING_NOTES],
    ] as const) {
      expect(notes).toHaveLength(FOOTSTEP_VARIANTS);
      for (let v = 0; v < FOOTSTEP_VARIANTS; v++) {
        const midi = notes[v] as number;
        expect(isInScale(midi, VIDRO_SCALE), `${m} #${v + 1}`).toBe(true);
        // after the contact the floor is left ringing on its note
        const x = renderFootstep(m, v, SR);
        const hz = estimatePitch(x, SR, { start: 0.12, duration: 0.2, minHz: 150 });
        expect(hz, `${m} #${v + 1}`).not.toBeNull();
        expect(Math.abs((hz as number) / midiToHz(midi) - 1), `${m} #${v + 1}`).toBeLessThan(0.03);
      }
    }
  });

  it('stone stops dead; glass and brass ring on after the foot lands', () => {
    const tail = (m: (typeof FLOOR_MATERIALS)[number]): number => {
      let sum = 0;
      for (let v = 0; v < FOOTSTEP_VARIANTS; v++) {
        const x = renderFootstep(m, v, SR);
        sum += rms(x, at(0.15), at(0.3)) / rms(x, 0, at(0.15));
      }
      return sum / FOOTSTEP_VARIANTS;
    };
    expect(tail('brass')).toBeGreaterThan(tail('stone'));
    expect(tail('frosted')).toBeGreaterThan(tail('stone'));
  });
});

describe('choosing the next step (同じ音が続かないように)', () => {
  it('never repeats the previous one, and over a walk uses all eight', () => {
    const rng = mulberry32(7);
    let prev: number | null = null;
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const v = nextVariant(prev, FOOTSTEP_VARIANTS, rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(FOOTSTEP_VARIANTS);
      expect(v).not.toBe(prev);
      seen.add(v);
      prev = v;
    }
    expect(seen.size).toBe(FOOTSTEP_VARIANTS);
  });

  it('is fair: every variant comes up about as often', () => {
    const rng = mulberry32(11);
    const counts = new Array(FOOTSTEP_VARIANTS).fill(0);
    let prev: number | null = null;
    for (let i = 0; i < 8000; i++) {
      prev = nextVariant(prev, FOOTSTEP_VARIANTS, rng);
      counts[prev]++;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan(850);
      expect(c).toBeLessThan(1150);
    }
  });

  it('with one variant there is nothing else to choose', () => {
    expect(nextVariant(0, 1, mulberry32(1))).toBe(0);
  });
});

describe('how loud a step is for how fast the body goes (仮)', () => {
  it('walking is the reference; a slower, peeking step is softer, a hurried one a little louder', () => {
    expect(footstepGain(1)).toBeCloseTo(1, 6);
    expect(footstepGain(0.5)).toBeLessThan(1);
    expect(footstepGain(0.5)).toBeGreaterThan(0.6);
    expect(footstepGain(2.2 / 1.4)).toBeGreaterThan(1);
    expect(footstepGain(2.2 / 1.4)).toBeLessThanOrEqual(1.25);
    for (let s = 0; s < 2; s += 0.1) expect(footstepGain(s + 0.1)).toBeGreaterThanOrEqual(footstepGain(s));
    expect(footstepGain(0)).toBeGreaterThan(0);
    expect(footstepGain(10)).toBeLessThanOrEqual(1.25);
  });
});
