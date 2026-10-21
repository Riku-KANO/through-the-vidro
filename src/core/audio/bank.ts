/**
 * Sound banks: where each sound comes from, behind one port (S-22). A sound is either synthesized (a render function
 * that returns its samples, src/core/audio/dsp.ts) or recorded (files to decode). Either way it becomes an AudioBuffer,
 * and from there it plays the same: a one-shot (scheduleBuffer) or a loop (startLoop). Swapping a synthesized
 * placeholder for a recording changes the source in the game's table and nothing else.
 *  - 制作方法 (design doc): ブラウザの互換性のため、圧縮形式を2種類用意する — a recording lists its files in order of
 *    preference (e.g. .ogg then .m4a); the first one the browser decodes is used.
 *  - Loading never throws: a source that cannot be had is null (the caller stays silent there) and is reported.
 */
import { fadeAndStop, type PlannedSource } from './glass';
import type { ScheduledVoice } from './voices';

export type SoundSource =
  /**
   * Synthesized: `render` returns the mono samples at the sample rate it is given — the context's, or `sampleRate`
   * when the source asks for its own (a bed with nothing high in it can be made at a lower rate, for less work).
   */
  | {
      readonly kind: 'synth';
      readonly id: string;
      readonly render: (sampleRate: number) => Float32Array;
      readonly sampleRate?: number;
    }
  /** Recorded: the same sound in one or more files (formats), in order of preference. */
  | { readonly kind: 'file'; readonly id: string; readonly urls: readonly string[] };

export function synth(
  id: string,
  render: (sampleRate: number) => Float32Array,
  opts: { sampleRate?: number } = {},
): SoundSource {
  return { kind: 'synth', id, render, sampleRate: opts.sampleRate };
}

export function recording(id: string, ...urls: string[]): SoundSource {
  return { kind: 'file', id, urls };
}

export interface BankLoadOptions {
  /** Reads a file (default: fetch, given the signal so leaving stops a download too). */
  fetchBytes?: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  /** Awaited before each source so a long bank does not hold the main thread (default: a macrotask). */
  pause?: () => Promise<void>;
  /** Told about each source that could not be had (default: console.error, which the sensors count). */
  onError?: (id: string, error: unknown) => void;
  /**
   * Stops loading: the sources not yet begun are left null, a file being read is let go of (its fetch is aborted), and
   * nothing more is reported.
   */
  signal?: AbortSignal;
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function fetchBytesDefault(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** The sources as buffers on `ctx`, in order; null where one could not be had. */
export async function loadBank(
  ctx: BaseAudioContext,
  sources: readonly SoundSource[],
  opts: BankLoadOptions = {},
): Promise<(AudioBuffer | null)[]> {
  const pause = opts.pause ?? nextTask;
  const fetchBytes = opts.fetchBytes ?? fetchBytesDefault;
  const onError = opts.onError ?? ((id, e) => console.error(`sound ${id} could not be loaded:`, e));
  const out: (AudioBuffer | null)[] = [];
  for (const source of sources) {
    await pause();
    if (opts.signal?.aborted) {
      out.push(null);
      continue;
    }
    try {
      out.push(
        source.kind === 'synth'
          ? rendered(ctx, source.render, source.sampleRate ?? ctx.sampleRate)
          : await decoded(ctx, source.urls, fetchBytes, opts.signal),
      );
    } catch (e) {
      if (opts.signal?.aborted) {
        out.push(null);
        continue;
      }
      onError(source.id, e);
      out.push(null);
    }
  }
  return out;
}

function rendered(
  ctx: BaseAudioContext,
  render: (sampleRate: number) => Float32Array,
  sampleRate: number,
): AudioBuffer {
  const samples = render(sampleRate);
  const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}

async function decoded(
  ctx: BaseAudioContext,
  urls: readonly string[],
  fetchBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  let last: unknown = new Error('no files');
  for (const url of urls) {
    if (signal?.aborted) break;
    try {
      return await ctx.decodeAudioData(await fetchBytes(url, signal));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export interface BufferPlay {
  /** Playback rate (1 = as recorded; it also shifts the pitch). */
  rate?: number;
  gain?: number;
}

/** Plays `buffer` once into `destination` from `when`. The voice can be cut short without a click. */
export function scheduleBuffer(
  ctx: BaseAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  when: number,
  play: BufferPlay = {},
): ScheduledVoice {
  const rate = play.rate ?? 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const out = ctx.createGain();
  out.gain.value = play.gain ?? 1;
  src.connect(out).connect(destination);
  const end = when + buffer.duration / rate;
  src.start(when);
  // let go of the destination once it has played
  src.onended = () => out.disconnect();
  const sources: PlannedSource[] = [{ node: src, stop: end }];
  return { end, fadeOut: (at: number) => fadeAndStop(out, sources, at) };
}

export interface LoopVoice {
  /** The loop's own gain (its level and fades). */
  readonly gain: GainNode;
  /** Fades out over `fade` seconds from `at`, then stops and lets go. */
  stop(at: number, fade?: number): void;
}

/**
 * Loops `buffer` into `destination` from `when`, starting `offset` seconds into it (wrapped), fading in from silence
 * over `fadeIn` seconds to `gain`.
 */
export function startLoop(
  ctx: BaseAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  when: number,
  opts: { offset?: number; gain?: number; fadeIn?: number } = {},
): LoopVoice {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  const level = opts.gain ?? 1;
  const fadeIn = opts.fadeIn ?? 0;
  gain.gain.setValueAtTime(fadeIn > 0 ? 0 : level, when);
  // setTargetAtTime reaches ~95 % after three time constants: the fade-in time
  if (fadeIn > 0) gain.gain.setTargetAtTime(level, when, fadeIn / 3);
  src.connect(gain).connect(destination);
  const offset = buffer.duration > 0 ? (opts.offset ?? 0) % buffer.duration : 0;
  src.start(when, offset);
  let stopped = false;
  return {
    gain,
    stop(at: number, fade = 0.5) {
      if (stopped) return;
      stopped = true;
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(0, at, Math.max(0.003, fade / 3));
      src.onended = () => gain.disconnect();
      src.stop(at + Math.max(0.03, fade * 2));
    },
  };
}
