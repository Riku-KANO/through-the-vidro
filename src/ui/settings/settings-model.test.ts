import { describe, expect, it } from 'vitest';
import { VIDRO_VOLUMES } from '../../audio/levels';
import { MOUSE_RADIANS_PER_PIXEL } from '../../game/input/gamepad';
import { FOV_DEFAULT, FOV_MAX, FOV_MIN } from '../../game/player/constants';
import {
  defaultSettings,
  type Settings,
  sanitizeSettings,
  TEXT_SCALE,
  TEXT_SIZES,
  worldSettingsOf,
} from './settings-model';

const ja = defaultSettings({ lang: 'ja' });

describe('defaultSettings (設定の初期値)', () => {
  it('starts as the design says: 視野角70度, 覗くは長押し, 言語はブラウザの言語, 標準の文字, コントラストはふつう', () => {
    expect(ja.fov).toBe(FOV_DEFAULT);
    expect(ja.fov).toBe(70);
    expect(ja.peekMode).toBe('hold');
    expect(ja.mouseSensitivity).toBe(1);
    expect(ja.invertY).toBe(false);
    expect(ja.lang).toBe('ja');
    expect(defaultSettings({ lang: 'en' }).lang).toBe('en');
    expect(ja.textSize).toBe('normal');
    expect(ja.contrast).toBe(false);
  });

  it('leaves the quality to the shell until the player chooses one', () => {
    expect(ja.quality).toBeNull();
  });

  it('starts the volumes at the game’s mixer defaults; the UI’s own at full', () => {
    expect(ja.volumes).toEqual({
      master: VIDRO_VOLUMES.master,
      sfx: VIDRO_VOLUMES.sfx,
      ambience: VIDRO_VOLUMES.ambience,
      ui: 1,
    });
  });

  it('takes a dev switch for the peek mode (?peek=toggle)', () => {
    expect(defaultSettings({ lang: 'ja', peekMode: 'toggle' }).peekMode).toBe('toggle');
  });
});

describe('sanitizeSettings (読み込んだ設定を信用しない)', () => {
  it('keeps what is valid', () => {
    const s: Settings = {
      quality: 'low',
      fov: 92,
      peekMode: 'toggle',
      mouseSensitivity: 1.75,
      invertY: true,
      volumes: { master: 0.5, sfx: 0.25, ambience: 0, ui: 0.6 },
      lang: 'en',
      textSize: 'larger',
      contrast: true,
    };
    expect(sanitizeSettings(JSON.parse(JSON.stringify(s)), ja)).toEqual(s);
  });

  it('clamps numbers into their ranges (視野角 60〜100 度, 音量 0〜1)', () => {
    const s = sanitizeSettings(
      { fov: 140, mouseSensitivity: 50, volumes: { master: 2, sfx: -1, ambience: 0.5, ui: 0.5 } },
      ja,
    );
    expect(s.fov).toBe(FOV_MAX);
    expect(sanitizeSettings({ fov: 10 }, ja).fov).toBe(FOV_MIN);
    expect(s.mouseSensitivity).toBe(3);
    expect(sanitizeSettings({ mouseSensitivity: 0 }, ja).mouseSensitivity).toBe(0.25);
    expect(s.volumes).toEqual({ master: 1, sfx: 0, ambience: 0.5, ui: 0.5 });
  });

  it('falls back to the defaults field by field for anything unknown, missing or of the wrong kind', () => {
    const s = sanitizeSettings(
      {
        quality: 'ultra',
        fov: 'wide',
        peekMode: 'tap',
        invertY: 'yes',
        volumes: { master: 'loud', sfx: Number.NaN },
        lang: 'fr',
        textSize: 'huge',
        contrast: 1,
      },
      ja,
    );
    expect(s).toEqual(ja);
  });

  it('reads anything that is not an object as the defaults', () => {
    for (const raw of [null, undefined, 3, 'x', [1, 2]]) expect(sanitizeSettings(raw, ja)).toEqual(ja);
  });

  it('keeps 自動 as a choice of its own', () => {
    expect(sanitizeSettings({ quality: 'auto' }, ja).quality).toBe('auto');
  });
});

describe('the text sizes (アクセシビリティ: 字幕と文字の大きさを3段階で変更できる)', () => {
  it('has three steps, the first the standard, never below the 18 px floor', () => {
    expect(TEXT_SIZES).toHaveLength(3);
    expect(TEXT_SCALE[TEXT_SIZES[0]]).toBe(1);
    const scales = TEXT_SIZES.map((t) => TEXT_SCALE[t]);
    expect([...scales].sort((a, b) => a - b)).toEqual(scales);
    expect(new Set(scales).size).toBe(3);
  });
});

describe('worldSettingsOf (the world takes them in its own terms)', () => {
  it('passes the field of view, the peek mode, the inversion and the language through', () => {
    const w = worldSettingsOf({ ...ja, fov: 88, peekMode: 'toggle', invertY: true, lang: 'en' });
    expect(w.fovDeg).toBe(88);
    expect(w.peekMode).toBe('toggle');
    expect(w.invertY).toBe(true);
    expect(w.lang).toBe('en');
  });

  it('turns the sensitivity (×) into radians per pixel of the mouse', () => {
    expect(worldSettingsOf(ja).mouseSensitivity).toBeCloseTo(MOUSE_RADIANS_PER_PIXEL, 12);
    expect(worldSettingsOf({ ...ja, mouseSensitivity: 2 }).mouseSensitivity).toBeCloseTo(
      2 * MOUSE_RADIANS_PER_PIXEL,
      12,
    );
  });
});
