import { describe, expect, it } from 'vitest';
import { estimatePitch, peak, rms } from '../core/audio/analysis';
import { hzToMidi, isInScale } from '../core/audio/scale';
import { FINALE_LEVELS } from './finale';
import { glassPitch, VIDRO_SCALE } from './tuning';
import { renderWhisper, WHISPER_LEVEL, WHISPER_NOTES, whisperSource } from './whisper';

const SR = 44100;
const at = (s: number): number => Math.round(s * SR);
/** The vidro's diameter (game/orb/hand-pose.ts HAND_ORB_RADIUS × 2; sound.ts VIDRO_SIZE). */
const VIDRO_SIZE = 0.15;

describe('the vidro’s whisper (S-39 玉のささやき: 小さなガラスの鳴り, 合成の仮置き)', () => {
  it('is the vidro’s own voice, on the game’s scale (音階の統一; ガラスの音: the same glass rings at its pitch)', () => {
    for (const m of WHISPER_NOTES) expect(isInScale(m, VIDRO_SCALE), `${m}`).toBe(true);
    expect(WHISPER_NOTES[0]).toBe(glassPitch(VIDRO_SIZE).midi);
    // it answers upward, like a question (ここにいる): its last note above its first
    expect(WHISPER_NOTES.at(-1) as number).toBeGreaterThan(WHISPER_NOTES[0] as number);
  });

  it('is short, starts and ends in silence and never clips', () => {
    const x = renderWhisper(SR);
    expect(x.length / SR).toBeGreaterThan(0.8);
    expect(x.length / SR).toBeLessThan(3);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(peak(x)).toBeLessThanOrEqual(1);
    expect(peak(x)).toBeGreaterThan(0.5);
    expect(Math.abs(x[0] as number)).toBeLessThan(0.01);
    expect(rms(x, x.length - at(0.005))).toBeLessThan(2e-3);
  });

  it('a whisper, not a strike: it swells in softly instead of starting at its loudest', () => {
    const x = renderWhisper(SR);
    expect(peak(x, 0, at(0.01))).toBeLessThan(peak(x) * 0.5);
    // and it is heard over its first half second (no gap between its notes)
    for (let t = 0.05; t < 0.5; t += 0.1)
      expect(rms(x, at(t), at(t + 0.1)), `${t.toFixed(2)} s`).toBeGreaterThan(0.02);
  });

  it('rings at the vidro’s note first', () => {
    const x = renderWhisper(SR);
    const hz = estimatePitch(x, SR, { start: 0.0, duration: 0.12, maxHz: 3000 });
    expect(hz).not.toBeNull();
    expect(Math.abs(hzToMidi(hz ?? 0) - (WHISPER_NOTES[0] as number))).toBeLessThan(0.5);
  });

  it('is quieter at its source than the close’s sounds: a hint, not an event (小さく)', () => {
    expect(WHISPER_LEVEL).toBeGreaterThan(0);
    expect(WHISPER_LEVEL).toBeLessThan(FINALE_LEVELS.settle);
  });

  it('is a SoundSource (bank.ts の口): synthesized now, a recording can take its place; made the same every time', () => {
    const s = whisperSource();
    expect(s.kind).toBe('synth');
    if (s.kind !== 'synth') throw new Error('synth');
    expect(s.id).toBe('vidro-whisper');
    expect(Array.from(s.render(SR).slice(0, 4000))).toEqual(Array.from(renderWhisper(SR).slice(0, 4000)));
  });
});
