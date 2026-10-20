/**
 * Live playback helpers: design a voice (with a fresh random seed, so every strike differs a little),
 * reserve a voice slot on the engine, and schedule it on an emitter (3D) or a bus.
 */
import type { AudioEngine, Emitter } from './engine';
import { designGlassVoice, type GlassStrength, type GlassVoice, scheduleGlassVoice } from './glass';
import type { BusName } from './mix';
import { designPopen, type PopenKind, type PopenScore, schedulePopen } from './popen';
import { mulberry32, randomSeed } from './rng';
import { pitchForSize } from './scale';

export interface PlayOptions {
  /** Positioned source; otherwise the sound goes straight to `bus`. */
  emitter?: Emitter;
  bus?: BusName;
  /** Fix the randomness (tests); default is a new seed per call. */
  seed?: number;
}

export interface GlassStrike {
  /** Characteristic size in metres (decides ring time, and the pitch unless `hz` is given). */
  size: number;
  strength: GlassStrength;
  /** Override the pitch (should be a scale note). Default: pitchForSize(size). */
  hz?: number;
}

/** Strike a glass now. Returns the voice, or null if the engine refused it (locked / voice cap). */
export function playGlass(
  engine: AudioEngine,
  strike: GlassStrike,
  opts: PlayOptions = {},
): GlassVoice | null {
  const voice = designGlassVoice(
    {
      hz: strike.hz ?? pitchForSize(strike.size).hz,
      size: strike.size,
      strength: strike.strength,
      sampleRate: engine.ctx.sampleRate,
    },
    mulberry32(opts.seed ?? randomSeed()),
  );
  const when = engine.now();
  if (!engine.beginVoice(when + voice.duration)) return null;
  scheduleGlassVoice(engine.ctx, opts.emitter?.input ?? engine.bus(opts.bus ?? 'sfx'), voice, when);
  return voice;
}

/** Play the hand orb's po-pen now. Returns the score, or null if the engine refused it. */
export function playPopen(engine: AudioEngine, kind: PopenKind, opts: PlayOptions = {}): PopenScore | null {
  const score = designPopen(kind, mulberry32(opts.seed ?? randomSeed()));
  const when = engine.now();
  if (!engine.beginVoice(when + score.duration)) return null;
  schedulePopen(engine.ctx, opts.emitter?.input ?? engine.bus(opts.bus ?? 'sfx'), score, when);
  return score;
}
