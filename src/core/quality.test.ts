import { describe, expect, it } from 'vitest';
import {
  isQualityChoice,
  QUALITY_CHOICES,
  QUALITY_PRESETS,
  type QualityPort,
  qualityPortOf,
  startQuality,
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
  it('the URL’s ?quality wins (a dev and sensor switch), as before', () => {
    expect(startQuality({ url: { level: 'high', auto: false }, saved: 'low' })).toEqual({
      level: 'high',
      auto: false,
      origin: 'url',
    });
    expect(startQuality({ url: { level: 'low', auto: true }, saved: 'high' })).toEqual({
      level: 'low',
      auto: true,
      origin: 'url',
    });
  });

  it('without it, the player’s saved choice', () => {
    expect(startQuality({ url: null, saved: 'low' })).toEqual({ level: 'low', auto: false, origin: 'saved' });
    // 自動 measures from mid, as ?quality=auto does
    expect(startQuality({ url: null, saved: 'auto' })).toEqual({ level: 'mid', auto: true, origin: 'saved' });
  });

  it('with neither, mid (as before)', () => {
    expect(startQuality({ url: null, saved: null })).toEqual({
      level: 'mid',
      auto: false,
      origin: 'default',
    });
  });
});

describe('the scene’s quality port (S-43)', () => {
  it('finds the shell’s port on a scene context that has one', () => {
    const port: QualityPort = {
      choice: 'mid',
      level: 'mid',
      sceneLevel: 'mid',
      request: () => undefined,
      attach: () => () => undefined,
    };
    expect(qualityPortOf({ quality: QUALITY_PRESETS.mid, qualityPort: port })).toBe(port);
    expect(qualityPortOf({ quality: QUALITY_PRESETS.mid })).toBeNull();
    expect(qualityPortOf({ qualityPort: { choice: 'mid', request: () => undefined } })).toBeNull();
  });
});
