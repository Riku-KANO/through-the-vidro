import { describe, expect, it } from 'vitest';
import {
  governorAuto,
  governorTakesFrame,
  isQualityChoice,
  keepsAutoPick,
  QUALITY_CHOICES,
  QUALITY_PRESETS,
  type QualityPreset,
  startQuality,
  waitsForRebuild,
} from './quality';

describe('QUALITY_CHOICES (設定 > 画質: 自動・低・中・高)', () => {
  it('lists 自動 first, then the three presets', () => {
    expect(QUALITY_CHOICES).toEqual(['auto', 'low', 'mid', 'high']);
    for (const c of QUALITY_CHOICES) expect(isQualityChoice(c)).toBe(true);
    expect(isQualityChoice('ultra')).toBe(false);
    expect(isQualityChoice(null)).toBe(false);
  });
});

describe('startQuality (which preset the shell creates the scene with)', () => {
  it('the URL’s ?quality wins (a dev and sensor switch), as before — over a choice and a pick kept', () => {
    expect(startQuality({ url: { level: 'high', auto: false }, saved: 'low', pick: 'low' })).toEqual({
      level: 'high',
      auto: false,
      origin: 'url',
      picked: false,
    });
    expect(startQuality({ url: { level: 'low', auto: true }, saved: 'high', pick: 'high' })).toEqual({
      level: 'low',
      auto: true,
      origin: 'url',
      picked: false,
    });
  });

  it('without it, the player’s saved choice: a preset holds (自動’s pick kept or not)', () => {
    expect(startQuality({ url: null, saved: 'low', pick: 'high' })).toEqual({
      level: 'low',
      auto: false,
      origin: 'saved',
      picked: false,
    });
  });

  it('S-48 初回は自動: with neither, 自動 — measured from mid the first time (技術設計 > 品質プリセット)', () => {
    expect(startQuality({ url: null, saved: null })).toEqual({
      level: 'mid',
      auto: true,
      origin: 'default',
      picked: false,
    });
  });

  it('S-48: 自動 (kept, or never chosen) builds from the preset it picked the last time, and measures again', () => {
    expect(startQuality({ url: null, saved: null, pick: 'low' })).toEqual({
      level: 'low',
      auto: true,
      origin: 'default',
      picked: true,
    });
    expect(startQuality({ url: null, saved: 'auto', pick: 'high' })).toEqual({
      level: 'high',
      auto: true,
      origin: 'saved',
      picked: true,
    });
    // chosen 自動, nothing picked yet: from mid, as ?quality=auto
    expect(startQuality({ url: null, saved: 'auto', pick: null })).toEqual({
      level: 'mid',
      auto: true,
      origin: 'saved',
      picked: false,
    });
  });

  it('S-48: a measurement (?bench) is of a fixed preset: mid, whatever is kept (計測は固定のプリセットで)', () => {
    expect(startQuality({ url: null, saved: 'auto', pick: 'high', bench: true })).toEqual({
      level: 'mid',
      auto: false,
      origin: 'default',
      picked: false,
    });
    // the URL still wins there (a bench of another preset)
    expect(startQuality({ url: { level: 'high', auto: false }, saved: null, bench: true }).level).toBe(
      'high',
    );
  });
});

describe('governorAuto (S-48: whether 自動 runs, once the scene is made)', () => {
  const first = startQuality({ url: null, saved: null });
  it('the first time, only for the game itself (the prologue through the home)', () => {
    expect(governorAuto(first, true)).toBe(true);
    // a dev scene (made again for a preset, or S-04's placeholder city) keeps the one it was made with, as before S-48
    expect(governorAuto(first, false)).toBe(false);
  });

  it('自動 asked for (the URL’s, the player’s kept) runs either way, as before', () => {
    expect(governorAuto(startQuality({ url: { level: 'mid', auto: true }, saved: null }), false)).toBe(true);
    expect(governorAuto(startQuality({ url: null, saved: 'auto' }), false)).toBe(true);
  });

  it('a preset never measures', () => {
    expect(governorAuto(startQuality({ url: null, saved: 'high' }), true)).toBe(false);
    expect(governorAuto(startQuality({ url: null, saved: null, bench: true }), true)).toBe(false);
  });
});

describe('governorTakesFrame (S-48: 推奨はゲームの絵を描いている間の計測で決める)', () => {
  const frame = { idle: false, drawsGame: true, measuring: true, player: true };
  it('the player’s 自動 measures only the frames of the game itself, not the light home orb', () => {
    expect(governorTakesFrame(frame)).toBe(true);
    expect(governorTakesFrame({ ...frame, drawsGame: false })).toBe(false);
  });

  it('once measured (steady), every frame that moves goes on to dynamic resolution, the home’s too', () => {
    expect(governorTakesFrame({ ...frame, drawsGame: false, measuring: false })).toBe(true);
  });

  it('the URL’s ?quality=auto measures as before (M0’s path)', () => {
    expect(governorTakesFrame({ ...frame, drawsGame: false, player: false })).toBe(true);
  });

  it('a still picture (the pause holds it) goes to no governor (S-43)', () => {
    for (const measuring of [true, false])
      for (const player of [true, false])
        expect(governorTakesFrame({ idle: true, drawsGame: true, measuring, player })).toBe(false);
  });
});

describe('keepsAutoPick (S-48: 選ばれたプリセットを保存して次はそこから作る)', () => {
  const game = { player: true, choice: 'auto', bench: false, game: true } as const;
  it('the player’s 自動, measured in the game, keeps what it picked', () => {
    expect(keepsAutoPick(game)).toBe(true);
  });

  it('not a preset the player chose, not the URL’s 自動, never a measurement', () => {
    expect(keepsAutoPick({ ...game, choice: 'high' })).toBe(false);
    expect(keepsAutoPick({ ...game, player: false })).toBe(false);
    expect(keepsAutoPick({ ...game, bench: true })).toBe(false);
  });

  it('not as measured in a dev scene (its load is not the game’s: S-04’s placeholder city, the stress scene)', () => {
    expect(keepsAutoPick({ ...game, game: false })).toBe(false);
  });
});

describe('waitsForRebuild (S-48: 影の大きさとガラスの描き方だけが次に作るときから)', () => {
  it('the same preset: nothing waits', () => {
    for (const l of ['low', 'mid', 'high'] as const)
      expect(waitsForRebuild(QUALITY_PRESETS[l], QUALITY_PRESETS[l])).toBe(false);
  });

  it('the design’s presets differ in their shadows and glass: another one waits in part', () => {
    expect(waitsForRebuild(QUALITY_PRESETS.mid, QUALITY_PRESETS.low)).toBe(true);
    expect(waitsForRebuild(QUALITY_PRESETS.mid, QUALITY_PRESETS.high)).toBe(true);
  });

  it('what switches in place does not wait: the render scale, the peek image’s scale, the anti-aliasing', () => {
    const mid: QualityPreset = { ...QUALITY_PRESETS.mid };
    expect(
      waitsForRebuild(mid, {
        ...mid,
        renderScale: 1,
        transmissionScale: 1,
        peekScale: 0.75,
        antialias: 'fxaa',
      }),
    ).toBe(false);
  });

  it('the shadow map’s size, the dispersion and the far glass each wait', () => {
    const mid: QualityPreset = { ...QUALITY_PRESETS.mid };
    expect(waitsForRebuild(mid, { ...mid, dynamicShadowSize: 2048 })).toBe(true);
    expect(waitsForRebuild(mid, { ...mid, dispersion: 'showcase' })).toBe(true);
    expect(waitsForRebuild(mid, { ...mid, farGlassTransmission: true })).toBe(true);
  });
});
