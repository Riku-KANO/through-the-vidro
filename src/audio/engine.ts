/**
 * How Through the Vidro builds its audio engine (S-21): S-09's generic AudioEngine (src/core/audio) with the game's
 * mixer and starting space, in one place for every scene that makes one.
 *  - サウンドデザイン > 制作方法: the four volumes (全体 / 音楽 / 効果音 / 環境音) start at VIDRO_VOLUMES; each bus feeds
 *    the room's reverb at VIDRO_REVERB_SEND (levels.ts).
 *  - サウンドデザイン > 環境音: the space it starts in, the caller's to choose (src/audio/rooms.ts; the game starts in
 *    the workshop).
 *  - The context: the game makes it inside the first user gesture and passes it in (AGENTS.md, S-16 / S-18); the
 *    engine then never suspends or closes it, its maker does. `undefined` must be passed on purpose, and only by a
 *    scene opened alone that builds before any gesture (the audio lab): the engine then makes its own context at once,
 *    keeps it suspended until a gesture and closes it when disposed. An OfflineAudioContext renders the whole mix
 *    (the audio lab's sensor).
 */
import { AudioEngine, type AudioEngineOptions } from '../core/audio/engine';
import type { RoomPreset } from '../core/audio/reverb';
import { VIDRO_REVERB_SEND, VIDRO_VOLUMES } from './levels';

/** Engine settings a caller may still choose (the audio lab caps voices per emitter to test stealing). */
export type VidroEngineExtras = Pick<AudioEngineOptions, 'maxVoicesPerEmitter'>;

export function createVidroEngine(
  context: BaseAudioContext | undefined,
  room: RoomPreset,
  extras: VidroEngineExtras = {},
): Promise<AudioEngine> {
  return AudioEngine.create({
    ...extras,
    room,
    volumes: VIDRO_VOLUMES,
    reverbSend: VIDRO_REVERB_SEND,
    context,
  });
}
