/**
 * The pause's sounds and its mix (S-42).
 *  - 遷移のルール 6 (音を必ず添える: 遷移ごとに固有のガラスの音): opening is a breath on the glass that swells while the time
 *    stops, with the vidro's D5 under it and A5 as the writing begins; closing plays the two notes back (A5 then D5) over a
 *    short clearing of air; each item rings its own note of the scale as the home drops do (D5 E5 F#5 …), a choice sinks an
 *    octave; leaving for the title steps down A5 F#5 D5 A4, back down into the orb.
 *    サウンドデザイン > 音階の統一 (D メジャー・ペンタトニック). Synthesized placeholders (制作方法: 足りない音はシンセサイザーで
 *    補う), one SoundSource each (src/core/audio/bank.ts): a recording replaces one in PAUSE_SOURCES.
 *  - ポーズ中はゲームの音を絞る: the ambience stays, small (PAUSE_DUCK); footsteps and the room's events stop because the game's
 *    time stops (src/ui/pause, room.ts). The effects bus carries the pause's own sounds, so it is not turned down.
 * Every number here is a tuning value (仮), for the ear.
 */

import { loadBank, type SoundSource, scheduleBuffer, synth } from '../core/audio/bank';
import { addPartials, Biquad, fadeEnds, normalizePeak, type RingingPartial } from '../core/audio/dsp';
import type { AudioEngine } from '../core/audio/engine';
import { GLASS_MODE_RATIOS } from '../core/audio/glass';
import type { VolumeChannel } from '../core/audio/mix';
import { mulberry32 } from '../core/audio/rng';
import { midiToHz, scaleStep } from '../core/audio/scale';
import { VIDRO_SCALE } from './tuning';

export const PAUSE_CUES = ['open', 'close', 'tick', 'leave'] as const;
export type PauseCue = (typeof PAUSE_CUES)[number];

/** The vidro's note (D5): the item tick's own pitch, moved per item by playback rate (tickRate). */
const D5 = 74;

/** The notes each cue rings, in order (MIDI). */
export const PAUSE_NOTES: Readonly<Record<PauseCue, readonly number[]>> = {
  open: [D5, 81],
  close: [81, D5],
  tick: [D5],
  leave: [81, 78, D5, 69],
};
/** When each of the leave's notes starts (s). */
export const PAUSE_LEAVE_AT: readonly number[] = [0, 0.12, 0.24, 0.36];

/** How loud each cue plays (its peak), about the home drops' pings (src/ui/audio-gate.ts). */
export const PAUSE_LEVELS: Readonly<Record<PauseCue, number>> = {
  open: 0.075,
  close: 0.06,
  tick: 0.05,
  leave: 0.07,
};

/** A note: when (s), how loud, how long it swells in (s) and rings (t60 of its lowest mode, s). */
interface NoteShape {
  midi: number;
  at: number;
  gain: number;
  swell: number;
  ring: number;
}
/** The glass's modes: relative level and ring (as a share of the note's): soft, a touch rather than a strike. */
const MODES: readonly { gain: number; ring: number }[] = [
  { gain: 1, ring: 1 },
  { gain: 0.2, ring: 0.5 },
  { gain: 0.07, ring: 0.32 },
  { gain: 0.025, ring: 0.2 },
];

/** Adds one glass note, swelling in over `swell` seconds (a sine-shaped rise: no click). */
function addNote(x: Float32Array, sr: number, note: NoteShape, rng: () => number): void {
  const hz = midiToHz(note.midi);
  const partials: RingingPartial[] = GLASS_MODE_RATIOS.map((ratio, m) => ({
    hz: hz * ratio * (m === 0 ? 1 : 1 + (rng() - 0.5) * 0.004),
    gain: note.gain * (MODES[m]?.gain ?? 0),
    t60: note.ring * (MODES[m]?.ring ?? 0.2),
  }));
  const ring = new Float32Array(x.length);
  addPartials(ring, partials, { start: note.at, attack: 0, sampleRate: sr });
  const from = Math.round(note.at * sr);
  const rise = Math.max(1, Math.round(note.swell * sr));
  for (let i = from; i < x.length; i++) {
    const n = i - from;
    const env = n < rise ? 0.5 - 0.5 * Math.cos((Math.PI * n) / rise) : 1;
    x[i] = (x[i] as number) + (ring[i] as number) * env;
  }
}

/** Breath over glass: band-limited noise under an envelope `env(t)` (0..1), its band gliding from `fromHz` to `toHz`. */
function addBreath(
  x: Float32Array,
  sr: number,
  seconds: number,
  level: number,
  env: (t: number) => number,
  band: { fromHz: number; toHz: number; q: number },
  rng: () => number,
): void {
  const n = Math.min(x.length, Math.round(seconds * sr));
  const filter = new Biquad(sr);
  const lowpass = new Biquad(sr).lowpass(5200, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // the band moves slowly: retune every 256 samples
    if (i % 256 === 0) {
      const u = Math.min(1, t / seconds);
      filter.bandpass(band.fromHz + (band.toHz - band.fromHz) * u, band.q);
    }
    x[i] = (x[i] as number) + lowpass.process(filter.process(rng() * 2 - 1)) * level * env(t);
  }
}

function finish(x: Float32Array, sr: number, fadeOut: number): Float32Array {
  normalizePeak(x, 0.9);
  return fadeEnds(x, Math.round(0.002 * sr), Math.round(fadeOut * sr));
}

/** ゲーム → ポーズ: the breath swells while the time stops (0.4 s), D5 under it; A5 as the writing begins. */
function renderOpen(sr: number): Float32Array {
  const x = new Float32Array(Math.round(1.5 * sr));
  const rng = mulberry32(0x42a1);
  const [low = D5, high = 81] = PAUSE_NOTES.open;
  addBreath(
    x,
    sr,
    0.62,
    0.55,
    // rises to its full by the stop (0.4 s), then breathes out
    (t) =>
      t < 0.4
        ? Math.sin((Math.PI / 2) * (t / 0.4)) ** 2
        : Math.cos((Math.PI / 2) * Math.min(1, (t - 0.4) / 0.22)) ** 2,
    { fromHz: 900, toHz: 2400, q: 0.8 },
    rng,
  );
  addNote(x, sr, { midi: low, at: 0.06, gain: 0.7, swell: 0.25, ring: 1.3 }, rng);
  addNote(x, sr, { midi: high, at: 0.4, gain: 0.45, swell: 0.02, ring: 0.9 }, rng);
  return finish(x, sr, 0.3);
}

/** ポーズ → ゲーム: the opening's notes played back (A5, D5) over a short clearing of air. */
function renderClose(sr: number): Float32Array {
  const x = new Float32Array(Math.round(0.95 * sr));
  const rng = mulberry32(0x42c3);
  const [high = 81, low = D5] = PAUSE_NOTES.close;
  addBreath(
    x,
    sr,
    0.3,
    0.4,
    (t) => Math.sin(Math.PI * Math.min(1, t / 0.3)) ** 2,
    { fromHz: 2600, toHz: 1100, q: 0.9 },
    rng,
  );
  addNote(x, sr, { midi: high, at: 0.0, gain: 0.45, swell: 0.012, ring: 0.6 }, rng);
  addNote(x, sr, { midi: low, at: 0.1, gain: 0.6, swell: 0.012, ring: 0.8 }, rng);
  return finish(x, sr, 0.2);
}

/** An item's tick: a small touch of glass at D5 (moved per item by playback rate). */
function renderTick(sr: number): Float32Array {
  const x = new Float32Array(Math.round(0.5 * sr));
  const rng = mulberry32(0x42b7);
  addNote(x, sr, { midi: PAUSE_NOTES.tick[0] ?? D5, at: 0, gain: 1, swell: 0.004, ring: 0.42 }, rng);
  return finish(x, sr, 0.08);
}

/** タイトルへ: four notes stepping down, back down into the orb. */
function renderLeave(sr: number): Float32Array {
  const x = new Float32Array(Math.round(1.7 * sr));
  const rng = mulberry32(0x42d9);
  PAUSE_NOTES.leave.forEach((midi, k) => {
    addNote(x, sr, { midi, at: PAUSE_LEAVE_AT[k] ?? 0, gain: 0.55 + 0.1 * k, swell: 0.008, ring: 0.9 }, rng);
  });
  return finish(x, sr, 0.3);
}

const RENDER: Readonly<Record<PauseCue, (sampleRate: number) => Float32Array>> = {
  open: renderOpen,
  close: renderClose,
  tick: renderTick,
  leave: renderLeave,
};

/** A cue's samples, mono, peak 0.9. */
export function renderPauseCue(cue: PauseCue, sampleRate: number): Float32Array {
  return RENDER[cue](sampleRate);
}

/** Where each cue comes from. To use a recording, swap one for `recording('pause-open', ...urls)`. */
export const PAUSE_SOURCES: Readonly<Record<PauseCue, SoundSource>> = {
  open: synth('pause-open', renderOpen),
  close: synth('pause-close', renderClose),
  tick: synth('pause-tick', renderTick),
  leave: synth('pause-leave', renderLeave),
};

/** The playback rate for item `index` of a page (its own note of the scale, as the home drops), an octave down when chosen. */
export function tickRate(index: number, chosen = false): number {
  const midi = scaleStep(D5, Math.max(0, Math.floor(index)), VIDRO_SCALE);
  return (midiToHz(midi) / midiToHz(D5)) * (chosen ? 0.5 : 1);
}

export type PauseBank = Partial<Record<PauseCue, AudioBuffer>>;

/** The cues' buffers on `ctx` (a cue that could not be had is left out: the pause rings a stand-in there). */
export async function loadPauseBank(ctx: BaseAudioContext, signal?: AbortSignal): Promise<PauseBank> {
  const buffers = await loadBank(
    ctx,
    PAUSE_CUES.map((c) => PAUSE_SOURCES[c]),
    { signal },
  );
  const bank: PauseBank = {};
  PAUSE_CUES.forEach((c, i) => {
    const b = buffers[i];
    if (b) bank[c] = b;
  });
  return bank;
}

/** Rings `cue` on the engine's effects bus (non-positioned: the UI). Returns whether a voice started. */
export function playPauseCue(
  engine: Pick<AudioEngine, 'startVoice'>,
  bank: PauseBank,
  cue: PauseCue,
  opts: { rate?: number; gain?: number } = {},
): boolean {
  const buffer = bank[cue];
  if (!buffer) return false;
  const level = PAUSE_LEVELS[cue] * (opts.gain ?? 1);
  const voice = engine.startVoice({ level, bus: 'sfx' }, (ctx, destination, when) =>
    scheduleBuffer(ctx, destination, buffer, when, { rate: opts.rate ?? 1, gain: level }),
  );
  return voice !== null;
}

/**
 * ポーズ中はゲームの音を絞る: each volume turned down to this share of the player's slider while the pause is all there
 * (環境音は小さく残し: about −16 dB). Not the effects bus: the pause's own sounds ride on it. The game's events stop with its
 * time — no new ones start — but one already ringing rings on (the light's sweep, the gate): the room's sound would have to
 * follow the time's speed, or the UI have its own bus (S-42 判断待ち 2). Not music (none plays yet) nor master.
 */
export const PAUSE_DUCK: Readonly<Partial<Record<VolumeChannel, number>>> = { ambience: 0.4 };

/** The engine's four volumes, as the pause's mix needs them. */
export type VolumeTarget = Pick<AudioEngine, 'getVolume' | 'setVolume'>;

/** Changes smaller than this are not sent (the amount is set every frame). */
const VOLUME_EPSILON = 1e-3;

/**
 * 仮 (S-42): back on the home after タイトルへ, the game's ambience fades out to this share (the home has no room sounds, as
 * when it was first seen) and comes back once play starts again.
 */
export const AWAY_DUCK: Readonly<Partial<Record<VolumeChannel, number>>> = { ambience: 0 };

const DUCKED: readonly VolumeChannel[] = [
  ...new Set([...Object.keys(PAUSE_DUCK), ...Object.keys(AWAY_DUCK)] as VolumeChannel[]),
];

/**
 * The pause's turn-down of the game's sounds, on top of the player's volumes: `set(amount)` for the pause (0 = none, 1 = all
 * there) and `setAway(amount)` for the home after タイトルへ, every frame. The target's level is read when a turn-down starts
 * and given back exactly when both are gone. Since S-43 the pause hands it core's duck stage (`duckStage(engine, 'pause')`),
 * so it writes the pause's own turn-down, not the player's volumes: the settings' sliders (`AudioGate.setVolume`) and the
 * pause never fight over one value. `setUserVolume` is from before that and nothing calls it now.
 */
export class PauseMix {
  private pause = 0;
  private away = 0;
  private readonly user: Partial<Record<VolumeChannel, number>> = {};
  private readonly sent: Partial<Record<VolumeChannel, number>> = {};

  constructor(private readonly engine: VolumeTarget) {}

  get amount(): number {
    return this.pause;
  }

  set(amount: number): void {
    const a = unit(amount);
    if (a === this.pause) return;
    this.pause = a;
    this.apply();
  }

  setAway(amount: number): void {
    const a = unit(amount);
    if (a === this.away) return;
    this.away = a;
    this.apply();
  }

  /** The slider the player set (not the turned-down volume). */
  userVolume(channel: VolumeChannel): number {
    return this.user[channel] ?? this.engine.getVolume(channel);
  }

  /** Sets the player's slider; while a turn-down is on, it stays on top of it. */
  setUserVolume(channel: VolumeChannel, value: number): void {
    if (this.user[channel] === undefined) {
      this.engine.setVolume(channel, value);
      return;
    }
    this.user[channel] = value;
    const v = value * this.factor(channel);
    this.sent[channel] = v;
    this.engine.setVolume(channel, v);
  }

  private factor(channel: VolumeChannel): number {
    const pause = 1 - (1 - (PAUSE_DUCK[channel] ?? 1)) * this.pause;
    const away = 1 - (1 - (AWAY_DUCK[channel] ?? 1)) * this.away;
    return pause * away;
  }

  private apply(): void {
    // the turned-down volumes are sent exactly at the ends (all there, or gone); small steps between are skipped
    const atEnds = (this.pause === 0 || this.pause === 1) && (this.away === 0 || this.away === 1);
    for (const ch of DUCKED) {
      const f = this.factor(ch);
      const user = this.user[ch];
      if (f === 1) {
        if (user !== undefined) {
          this.engine.setVolume(ch, user);
          delete this.user[ch];
          delete this.sent[ch];
        }
        continue;
      }
      const from = user ?? this.engine.getVolume(ch);
      this.user[ch] = from;
      const v = from * f;
      const last = this.sent[ch];
      if (last !== undefined && (last === v || (Math.abs(last - v) < VOLUME_EPSILON && !atEnds))) continue;
      this.sent[ch] = v;
      this.engine.setVolume(ch, v);
    }
  }
}

function unit(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
