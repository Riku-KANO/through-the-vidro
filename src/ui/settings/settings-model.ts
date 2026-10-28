import { VIDRO_VOLUMES } from '../../audio/levels';
import { isQualityChoice, type QualityChoice } from '../../core/quality';
import type { WorldSettings } from '../../game/dive-world';
import { MOUSE_SENSITIVITY_RANGE, mouseSensitivityFor } from '../../game/input/gamepad';
import { FOV_DEFAULT, FOV_MAX, FOV_MIN } from '../../game/player/constants';
import type { Lang } from '../lang';

/**
 * The player's settings (S-43), pure data: what the panel shows and changes, what is kept in the browser, and how the
 * world and the mix take them. UI/UX設計 > 画面ごとの設計: 設定 — タブは画質 / 操作 / 音 / 表示とアクセシビリティ.
 */

/** UI/UX設計 > アクセシビリティ: 字幕と文字の大きさを3段階で変更できる. */
export const TEXT_SIZES = ['normal', 'large', 'larger'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
/** 仮: how much each step scales the UI's text (the first is the standard, which already keeps the 18 px floor). */
export const TEXT_SCALE: Readonly<Record<TextSize, number>> = { normal: 1, large: 1.2, larger: 1.4 };

/** 設定 > 音: 全体・効果音・環境音・UI — slider positions 0..1. */
export interface VolumeSettings {
  master: number;
  sfx: number;
  ambience: number;
  ui: number;
}
export const VOLUME_ROWS = ['master', 'sfx', 'ambience', 'ui'] as const;

export interface Settings {
  /** 画質: 自動・低・中・高; null until the player chooses (the shell's then: the URL's, or mid). */
  quality: QualityChoice | null;
  /** 視野角, degrees (60〜100, 初期 70). */
  fov: number;
  /** 覗く: 長押し / 押すたびに切り替え. */
  peekMode: 'hold' | 'toggle';
  /** マウスの感度, × the tuned rate. */
  mouseSensitivity: number;
  /** 上下の反転. */
  invertY: boolean;
  volumes: VolumeSettings;
  /** 言語 (英語版: 初期値はブラウザの言語設定). */
  lang: Lang;
  textSize: TextSize;
  /** コントラスト強化モード: ガラスの縁を太く明るくし、曇りガラスの背景を濃くする. */
  contrast: boolean;
}

/** The settings before the player changed anything. */
export function defaultSettings(opts: { lang: Lang; peekMode?: 'hold' | 'toggle' }): Settings {
  return {
    quality: null,
    fov: FOV_DEFAULT,
    peekMode: opts.peekMode ?? 'hold',
    mouseSensitivity: 1,
    invertY: false,
    // the game's mixer defaults (src/audio/levels.ts); the UI's own bus at full
    volumes: {
      master: VIDRO_VOLUMES.master,
      sfx: VIDRO_VOLUMES.sfx,
      ambience: VIDRO_VOLUMES.ambience,
      ui: 1,
    },
    lang: opts.lang,
    textSize: 'normal',
    contrast: false,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;

/** Settings read from outside (a kept copy, a click): every field checked; a wrong one takes its default. */
export function sanitizeSettings(raw: unknown, defaults: Settings): Settings {
  const r = isObject(raw) ? raw : {};
  const v = isObject(r.volumes) ? r.volumes : {};
  const d = defaults.volumes;
  return {
    quality: r.quality === null ? null : isQualityChoice(r.quality) ? r.quality : defaults.quality,
    fov: num(r.fov, FOV_MIN, FOV_MAX, defaults.fov),
    peekMode: oneOf(r.peekMode, ['hold', 'toggle'] as const, defaults.peekMode),
    mouseSensitivity: num(
      r.mouseSensitivity,
      MOUSE_SENSITIVITY_RANGE.min,
      MOUSE_SENSITIVITY_RANGE.max,
      defaults.mouseSensitivity,
    ),
    invertY: bool(r.invertY, defaults.invertY),
    volumes: {
      master: num(v.master, 0, 1, d.master),
      sfx: num(v.sfx, 0, 1, d.sfx),
      ambience: num(v.ambience, 0, 1, d.ambience),
      ui: num(v.ui, 0, 1, d.ui),
    },
    lang: oneOf(r.lang, ['ja', 'en'] as const, defaults.lang),
    textSize: oneOf(r.textSize, TEXT_SIZES, defaults.textSize),
    contrast: bool(r.contrast, defaults.contrast),
  };
}

/** The settings as the world takes them (src/game/dive-world.ts WorldSettings). */
export function worldSettingsOf(s: Settings): WorldSettings {
  return {
    fovDeg: s.fov,
    peekMode: s.peekMode,
    mouseSensitivity: mouseSensitivityFor(s.mouseSensitivity),
    invertY: s.invertY,
    lang: s.lang,
  };
}
