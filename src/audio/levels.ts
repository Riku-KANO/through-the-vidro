/**
 * Through the Vidro's mixer defaults. Design doc: サウンドデザイン > 制作方法 — four volumes
 * (全体 / 音楽 / 効果音 / 環境音). The numbers are not in the design doc; to be confirmed by ear.
 */
import type { BusName, VolumeChannel } from '../core/audio/mix';

/** Starting slider positions; master leaves headroom for overlapping glass before the limiter. */
export const VIDRO_VOLUMES: Readonly<Record<VolumeChannel, number>> = {
  master: 0.8,
  music: 1,
  sfx: 1,
  ambience: 1,
};

/** How much of each bus feeds the room reverb: music a little drier so melodies stay clear. */
export const VIDRO_REVERB_SEND: Readonly<Record<BusName, number>> = { music: 0.5, sfx: 1, ambience: 1 };
