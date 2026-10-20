/**
 * Through the Vidro's acoustic spaces (data for the generic synthesized reverb in src/core/audio/reverb.ts).
 * Design doc: サウンドデザイン > 環境音 — reverb follows the size of the space: short in the small
 * workshop, long under the greenhouse dome. The numbers are not in the design doc; to be confirmed by ear.
 */
import type { RoomPreset } from '../core/audio/reverb';

export const VIDRO_ROOMS = {
  /** 工房: a small furnished room. */
  workshop: {
    id: 'workshop',
    t60: 0.6,
    preDelay: 0.004,
    wet: 0.25,
    damping: 0.5,
    early: { count: 8, spread: 0.025, gain: 4 },
  },
  /** ドーム: a big, hard, glass-walled hall. */
  dome: {
    id: 'dome',
    t60: 4.2,
    preDelay: 0.035,
    wet: 0.45,
    damping: 0.65,
    early: { count: 10, spread: 0.12, gain: 3 },
  },
} as const satisfies Record<string, RoomPreset>;

export type VidroRoomId = keyof typeof VIDRO_ROOMS;
