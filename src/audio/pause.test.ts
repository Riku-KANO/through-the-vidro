import { describe, expect, it } from 'vitest';
import { estimatePitch, rms } from '../core/audio/analysis';
import type { VolumeChannel } from '../core/audio/mix';
import { hzToMidi, isInScale, midiToHz } from '../core/audio/scale';
import { VIDRO_VOLUMES } from './levels';
import {
  PAUSE_CUES,
  PAUSE_DUCK,
  PAUSE_LEAVE_AT,
  PAUSE_NOTES,
  PauseMix,
  renderPauseCue,
  tickRate,
} from './pause';
import { VIDRO_SCALE } from './tuning';

const SR = 48_000;

/** A stand-in for the engine's four volumes. */
function fakeEngine(start: Partial<Record<VolumeChannel, number>> = {}) {
  const volumes: Record<VolumeChannel, number> = { ...VIDRO_VOLUMES, ...start };
  const sets: [VolumeChannel, number][] = [];
  return {
    volumes,
    sets,
    getVolume: (ch: VolumeChannel) => volumes[ch],
    setVolume: (ch: VolumeChannel, v: number) => {
      volumes[ch] = v;
      sets.push([ch, v]);
    },
  };
}

describe('the pause’s sounds (遷移のルール 6: 遷移ごとに固有のガラスの音; サウンドデザイン > 音階の統一)', () => {
  it('has its own sound for opening, closing, the items and leaving for the title', () => {
    expect([...PAUSE_CUES].sort()).toEqual(['close', 'leave', 'open', 'tick']);
  });

  it('rings only notes of the game scale (D major pentatonic)', () => {
    for (const cue of PAUSE_CUES) {
      for (const midi of PAUSE_NOTES[cue]) expect(isInScale(midi, VIDRO_SCALE), `${cue} ${midi}`).toBe(true);
    }
  });

  it('renders every cue finite, under the peak, and short enough for a UI sound', () => {
    for (const cue of PAUSE_CUES) {
      const x = renderPauseCue(cue, SR);
      expect(x.length, cue).toBeGreaterThan(0.1 * SR);
      expect(x.length, cue).toBeLessThan(2.5 * SR);
      let peak = 0;
      for (const v of x) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak, cue).toBeLessThanOrEqual(0.9 + 1e-6);
      expect(peak, cue).toBeGreaterThan(0.3);
    }
  });

  it('opens with a breath on the glass that swells while the time stops (0.4 s), and lasts through the writing', () => {
    const x = renderPauseCue('open', SR);
    expect(x.length / SR).toBeGreaterThanOrEqual(0.7);
    const at = (a: number, b: number) => rms(x, Math.round(a * SR), Math.round(b * SR));
    expect(at(0.28, 0.4)).toBeGreaterThan(2 * at(0, 0.05));
  });

  it('closes faster than it opens', () => {
    expect(renderPauseCue('close', SR).length).toBeLessThan(renderPauseCue('open', SR).length);
  });

  it('the item tick is D5, and each item rings its own note of the scale (as the home drops)', () => {
    const x = renderPauseCue('tick', SR);
    const hz = estimatePitch(x, SR, { start: 0.01, duration: 0.25 });
    expect(hz).not.toBeNull();
    expect(Math.abs(hzToMidi(hz ?? 0) - 74)).toBeLessThan(0.2);
    for (let i = 0; i < 6; i++) {
      const midi = hzToMidi(midiToHz(74) * tickRate(i));
      expect(Math.abs(midi - Math.round(midi))).toBeLessThan(1e-6);
      expect(isInScale(Math.round(midi), VIDRO_SCALE), `item ${i}`).toBe(true);
    }
    // a choice sinks: an octave under the item's own note
    expect(tickRate(1, true)).toBeCloseTo(tickRate(1) / 2, 9);
  });

  it('leaving for the title steps down, note by note (back down into the orb)', () => {
    const x = renderPauseCue('leave', SR);
    const notes = PAUSE_NOTES.leave;
    expect(PAUSE_LEAVE_AT).toHaveLength(notes.length);
    let last = Number.POSITIVE_INFINITY;
    notes.forEach((midi, k) => {
      const hz = estimatePitch(x, SR, { start: (PAUSE_LEAVE_AT[k] ?? 0) + 0.02, duration: 0.12, minHz: 200 });
      expect(hz, `note ${k}`).not.toBeNull();
      const heard = hzToMidi(hz ?? 0);
      expect(Math.abs(heard - midi), `note ${k}`).toBeLessThan(0.3);
      expect(heard).toBeLessThan(last);
      last = heard;
    });
  });
});

describe('PAUSE_DUCK (ポーズ中はゲームの音を絞る: 環境音は小さく残す)', () => {
  it('turns the ambience down but not off, and leaves the player’s master volume', () => {
    expect(PAUSE_DUCK.ambience).toBeGreaterThan(0.2);
    expect(PAUSE_DUCK.ambience).toBeLessThan(0.6);
    expect(PAUSE_DUCK.master).toBeUndefined();
  });
});

describe('PauseMix', () => {
  it('does nothing while the pause is down', () => {
    const e = fakeEngine();
    const mix = new PauseMix(e);
    mix.set(0);
    expect(e.sets).toEqual([]);
  });

  it('turns the ambience down by the pause’s amount, from the player’s own volume', () => {
    const e = fakeEngine({ ambience: 0.8 });
    const mix = new PauseMix(e);
    mix.set(1);
    expect(e.volumes.ambience).toBeCloseTo(0.8 * (PAUSE_DUCK.ambience ?? 1), 6);
    mix.set(0.5);
    expect(e.volumes.ambience).toBeLessThan(0.8);
    expect(e.volumes.ambience).toBeGreaterThan(0.8 * (PAUSE_DUCK.ambience ?? 1));
    // the other volumes are left alone
    expect(e.volumes.sfx).toBe(VIDRO_VOLUMES.sfx);
    expect(e.volumes.master).toBe(VIDRO_VOLUMES.master);
  });

  it('gives the player’s volume back exactly when the pause is gone', () => {
    const e = fakeEngine({ ambience: 0.7 });
    const mix = new PauseMix(e);
    mix.set(0.3);
    mix.set(1);
    mix.set(0);
    expect(e.volumes.ambience).toBe(0.7);
    expect(mix.amount).toBe(0);
  });

  it('keeps the slider the player set while ducked (S-43: 設定はポーズからも開く)', () => {
    const e = fakeEngine({ ambience: 1 });
    const mix = new PauseMix(e);
    mix.set(1);
    mix.setUserVolume('ambience', 0.5);
    expect(mix.userVolume('ambience')).toBe(0.5);
    expect(e.volumes.ambience).toBeCloseTo(0.5 * (PAUSE_DUCK.ambience ?? 1), 6);
    mix.setUserVolume('sfx', 0.4);
    expect(e.volumes.sfx).toBe(0.4);
    mix.set(0);
    expect(e.volumes.ambience).toBe(0.5);
  });

  it('reads the volume the player has now when the pause starts (not a stale one)', () => {
    const e = fakeEngine({ ambience: 1 });
    const mix = new PauseMix(e);
    mix.set(1);
    mix.set(0);
    e.setVolume('ambience', 0.6);
    mix.set(1);
    expect(e.volumes.ambience).toBeCloseTo(0.6 * (PAUSE_DUCK.ambience ?? 1), 6);
  });

  it('lands exactly on the turned-down volume, however small the last step', () => {
    const e = fakeEngine({ ambience: 1 });
    const mix = new PauseMix(e);
    mix.set(0.9995);
    mix.set(1);
    expect(e.volumes.ambience).toBe(PAUSE_DUCK.ambience);
  });

  it('fades the game’s ambience out on the home after タイトルへ, and gives it back when play starts again', () => {
    const e = fakeEngine({ ambience: 0.9 });
    const mix = new PauseMix(e);
    mix.set(1);
    mix.setAway(1);
    mix.set(0);
    expect(e.volumes.ambience).toBe(0);
    mix.setAway(0.5);
    expect(e.volumes.ambience).toBeGreaterThan(0);
    expect(e.volumes.ambience).toBeLessThan(0.9);
    mix.setAway(0);
    expect(e.volumes.ambience).toBe(0.9);
  });

  it('keeps the slider the player set on the home too', () => {
    const e = fakeEngine({ ambience: 1 });
    const mix = new PauseMix(e);
    mix.setAway(1);
    mix.setUserVolume('ambience', 0.3);
    expect(mix.userVolume('ambience')).toBe(0.3);
    expect(e.volumes.ambience).toBe(0);
    mix.setAway(0);
    expect(e.volumes.ambience).toBe(0.3);
  });
});
