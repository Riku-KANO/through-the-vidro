/**
 * The workshop's ambience (S-22). Design doc: サウンドデザイン > 環境音 — 風がガラスの隙間を抜ける音、遠くの風鈴、水滴;
 * 音は3D空間に配置し HRTF; 空間の広さに合わせて残響を変える. 音階の統一 — 環境音も D メジャー・ペンタトニック.
 * 物語と世界 — 寂しさではなく見つける喜び、まだそこで暮らしている気配: chimes someone hung, water still dripping
 * where it is used, a soft wind rather than a howl.
 * Synthesized placeholders (制作方法: 足りない音はシンセサイザーで補う), each a SoundSource that a recording can replace
 * (src/core/audio/bank.ts; the steps in process/slices/S-22.md). Where each sound is placed is the room's
 * (src/game/prologue/sound.ts). Every number here is a tuning value (仮), to be confirmed by ear.
 *
 * The ambience does not go through the engine's voice allocator (AudioEngine.startVoice): the wind is a bed, not a
 * voice, and the chimes and drops are planned ahead on their own schedule, which keeps their number small itself
 * (AMBIENCE.*.maxActive). It plays into emitters on the ambience bus, so it follows the ambience volume and the room's
 * reverb like everything else.
 */
import {
  type LoopVoice,
  loadBank,
  type SoundSource,
  scheduleBuffer,
  startLoop,
  synth,
} from '../core/audio/bank';
import {
  addPartials,
  Biquad,
  crossfadeLoop,
  decayPerSample,
  fadeEnds,
  normalizePeak,
} from '../core/audio/dsp';
import { designGlassVoice, type GlassTuning } from '../core/audio/glass';
import { mulberry32, type Rng, randomSeed } from '../core/audio/rng';
import { midiToHz } from '../core/audio/scale';

/* ---------- tuning (仮) ---------- */

/** 風鈴: five glass bells, one per note of D major pentatonic, high and small (D6 E6 F#6 A6 B6). */
export const CHIME_NOTES: readonly number[] = [86, 88, 90, 93, 95];
/** 水滴: eight drops, D5 … F#6; each place drips on a few of them (deeper into a bucket, higher onto glass). */
export const DROP_NOTES: readonly number[] = [74, 76, 78, 81, 83, 86, 88, 90];
/** The wind's loop, long enough that its gusts do not sound like a cycle. */
export const WIND_LOOP_SECONDS = 8;

export const AMBIENCE = {
  /** Seconds to fade in when the workshop is entered, and out when it is left. */
  fadeIn: 2.5,
  fadeOut: 0.8,
  /** How far ahead (s) chimes and drops are put on the audio clock. */
  lookahead: 0.25,
  /** Peak levels at the source (distance does the rest: HRTF, inverse 1/d beyond 1 m). */
  wind: { level: 0.5 },
  chimes: {
    // above 1: they hang 26 m off at the bench (1/26 by distance); from the far shore, 6.5 m, they are as loud as a step
    level: 2,
    /** Seconds between gusts that ring them, and before the first one. */
    gap: [5, 13] as const,
    first: [1.2, 4] as const,
    /** Strikes per gust, the spacing between strikes, and how much softer each next one is. */
    strikes: [1, 4] as const,
    spacing: [0.14, 0.6] as const,
    fall: [0.55, 0.9] as const,
    maxActive: 8,
  },
  drops: {
    level: 0.16,
    gap: [2.5, 8] as const,
    first: [0.6, 3] as const,
    /** A drop sometimes falls twice (drip … drip). */
    double: 0.3,
    doubleGap: [0.18, 0.5] as const,
    maxActive: 4,
  },
} as const;

/** The furin's glass (src/core/audio/glass.ts): a small, thin, bright bell that rings long. */
const FURIN_GLASS: GlassTuning = {
  strengths: {
    touch: { level: 0.3, brightness: 0.2, attack: 0.004, strike: 0, strikeDuration: 0, ring: 0.7 },
    // the clapper (舌) striking the rim
    tap: { level: 0.6, brightness: 0.42, attack: 0.0008, strike: 0.12, strikeDuration: 0.004, ring: 1 },
    hit: { level: 0.8, brightness: 0.55, attack: 0.0005, strike: 0.18, strikeDuration: 0.004, ring: 1 },
  },
  ring: { refSize: 0.1, t60: 2.4, exponent: 0.35, min: 0.5, max: 6 },
  modeDamping: 0.6,
  strike: { centerRatio: 3, q: 1.5, minHz: 2500 },
  jitter: {
    detune: 0.002,
    modeRatio: 0.006,
    modeGain: 0.2,
    t60: 0.1,
    levelDb: 0.5,
    splitMin: 0.0008,
    splitMax: 0.002,
    splitGain: 0.3,
    strikeHz: 0.15,
  },
};
/** A furin about 8 cm across. */
const FURIN_SIZE = 0.08;

/* ---------- synthesis (pure) ---------- */

/** One glass bell struck once, on `midi`. Mono, peak 0.9. */
export function renderChime(midi: number, sampleRate: number): Float32Array {
  const voice = designGlassVoice(
    { hz: midiToHz(midi), size: FURIN_SIZE, strength: 'tap', sampleRate },
    mulberry32(0xc41e + midi * 101),
    FURIN_GLASS,
  );
  const x = new Float32Array(Math.round(Math.min(3.2, voice.duration) * sampleRate));
  addPartials(x, voice.partials, { start: 0, attack: voice.attack, sampleRate });
  const s = voice.strike;
  if (s) {
    const rng = mulberry32(0x57 + midi);
    const band = new Biquad(sampleRate).bandpass(s.hz, s.q);
    const k = Math.exp(-1 / ((s.duration / 3) * sampleRate));
    let env = s.gain;
    for (let i = 0; i < Math.min(x.length, Math.round(s.duration * 4 * sampleRate)); i++) {
      x[i] = (x[i] as number) + band.process(rng() * 2 - 1) * env;
      env *= k;
    }
  }
  normalizePeak(x, 0.9);
  return fadeEnds(x, 0, Math.round(0.05 * sampleRate));
}

/** A water drop onto water or glass: a short sine that springs up onto its note (a tiny bubble) and dies. Mono. */
export function renderDrop(midi: number, variant: number, sampleRate: number): Float32Array {
  const rng = mulberry32(0xd209 + variant * 131);
  const x = new Float32Array(Math.round(0.3 * sampleRate));
  const f1 = midiToHz(midi);
  const f0 = f1 * (0.6 + rng() * 0.15);
  const chirp = 0.01 + rng() * 0.008;
  const k = decayPerSample(0.13 + rng() * 0.08, sampleRate);
  const attack = 0.0008 * sampleRate;
  let phase = 0;
  let env = 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / sampleRate;
    const u = Math.min(1, t / chirp);
    const f = f0 + (f1 - f0) * (1 - (1 - u) * (1 - u));
    phase += (2 * Math.PI * f) / sampleRate;
    x[i] = Math.sin(phase) * env * Math.min(1, i / attack);
    env *= k;
  }
  // the tiny tick of the impact
  const tick = new Biquad(sampleRate).highpass(2500, 0.7);
  const kt = decayPerSample(0.006, sampleRate);
  let e = 0.25;
  for (let i = 0; i < x.length && e > 1e-5; i++) {
    x[i] = (x[i] as number) + tick.process(rng() * 2 - 1) * e * Math.min(1, i / 8);
    e *= kt;
  }
  normalizePeak(x, 0.9);
  return fadeEnds(x, 0, Math.round(0.01 * sampleRate));
}

/**
 * The wind through the glass gaps, a seamless loop of WIND_LOOP_SECONDS: soft band-passed air that breathes in gusts
 * (an envelope periodic over the loop), a low rumble, and — only in the strongest gusts — a faint whistle of the gap on
 * A5 and D6 (音階の統一). Mono, peak 0.9.
 */
export function renderWind(sampleRate: number): Float32Array {
  const L = WIND_LOOP_SECONDS;
  const loopLength = Math.round(L * sampleRate);
  const fade = Math.round(1.5 * sampleRate);
  const raw = new Float32Array(loopLength + fade);
  const rng = mulberry32(0x3172d);
  const ph = [rng(), rng(), rng()].map((p) => p * 2 * Math.PI) as [number, number, number];
  const w = (2 * Math.PI) / L;
  const gust = (t: number): number =>
    Math.min(
      1,
      Math.max(
        0.32,
        0.6 +
          0.22 * Math.sin(w * t + ph[0]) +
          0.12 * Math.sin(2 * w * t + ph[1]) +
          0.06 * Math.sin(3 * w * t + ph[2]),
      ),
    );
  const body = new Biquad(sampleRate).bandpass(600, 0.55);
  const soft = new Biquad(sampleRate).lowpass(2200, 0.7);
  const rumble = new Biquad(sampleRate).lowpass(140, 0.7);
  const whistleA = new Biquad(sampleRate).bandpass(midiToHz(81), 45);
  const whistleD = new Biquad(sampleRate).bandpass(midiToHz(86), 55);
  // the gust moves slowly: worked out once per block, not per sample
  const BLOCK = 32;
  for (let start = 0; start < raw.length; start += BLOCK) {
    const g = gust((start + BLOCK / 2) / sampleRate);
    body.bandpass(380 + 420 * g, 0.55);
    const lowGain = (0.35 + 0.65 * g) * 1.6;
    const wa = g ** 4 * 3;
    const wd = g ** 6 * 2.4;
    for (let i = start; i < Math.min(raw.length, start + BLOCK); i++) {
      const n = rng() * 2 - 1;
      const air = soft.process(body.process(n)) * g;
      const low = rumble.process(rng() * 2 - 1) * lowGain;
      raw[i] = air + low + whistleA.process(n) * wa + whistleD.process(n) * wd;
    }
  }
  return normalizePeak(crossfadeLoop(raw, fade), 0.9);
}

export const CHIME_SOURCES: readonly SoundSource[] = CHIME_NOTES.map((m, i) =>
  synth(`chime-${i + 1}`, (sr) => renderChime(m, sr)),
);
export const DROP_SOURCES: readonly SoundSource[] = DROP_NOTES.map((m, i) =>
  synth(`drop-${i + 1}`, (sr) => renderDrop(m, i, sr)),
);
/** Nothing in the wind is above ~10 kHz: it is made at 24 kHz (half the work), the source node resamples it. */
export const WIND_SOURCE: SoundSource = synth('wind-loop', renderWind, { sampleRate: 24000 });

export interface AmbienceBanks {
  wind: AudioBuffer | null;
  chimes: readonly (AudioBuffer | null)[];
  drops: readonly (AudioBuffer | null)[];
}

export async function loadAmbienceBanks(ctx: BaseAudioContext): Promise<AmbienceBanks> {
  const [wind = null] = await loadBank(ctx, [WIND_SOURCE]);
  const chimes = await loadBank(ctx, CHIME_SOURCES);
  const drops = await loadBank(ctx, DROP_SOURCES);
  return { wind, chimes, drops };
}

/* ---------- planning (pure) ---------- */

/** A planned strike: when, which sound of the bank, how loud (0..1). */
export interface Hit {
  at: number;
  index: number;
  gain: number;
}

const between = (rng: Rng, [lo, hi]: readonly [number, number]): number => lo + rng() * (hi - lo);

/** Seconds until the next gust or drip. */
export function nextGap(rng: Rng, range: readonly [number, number]): number {
  return between(rng, range);
}

/** A gust through the chimes: one to four strikes from `at`, on neighbouring bells, each a little softer. */
export function planChimeRing(rng: Rng, at: number): Hit[] {
  const c = AMBIENCE.chimes;
  const count = c.strikes[0] + Math.floor(rng() * (c.strikes[1] - c.strikes[0] + 1));
  const bells = CHIME_NOTES.length;
  let index = Math.floor(rng() * bells) % bells;
  let t = at;
  let gain = 0.75 + rng() * 0.25;
  const hits: Hit[] = [{ at: t, index, gain }];
  for (let k = 1; k < count; k++) {
    t += between(rng, c.spacing);
    gain *= between(rng, c.fall);
    // the clapper swings to a bell nearby
    index = Math.min(bells - 1, Math.max(0, index + Math.floor(rng() * 5) - 2));
    hits.push({ at: t, index, gain });
  }
  return hits;
}

/** A drip from `at`: once, or twice in a row, on the notes that fall at this place. */
export function planDrip(rng: Rng, at: number, notes: readonly number[]): Hit[] {
  const d = AMBIENCE.drops;
  const pick = (): number => notes[Math.floor(rng() * notes.length) % notes.length] as number;
  const hits: Hit[] = [{ at, index: pick(), gain: 0.8 + rng() * 0.2 }];
  if (rng() < d.double)
    hits.push({ at: at + between(rng, d.doubleGap), index: pick(), gain: 0.5 + rng() * 0.35 });
  return hits;
}

/* ---------- playing ---------- */

export type AmbienceKind = 'wind' | 'chimes' | 'drops';
const KINDS: readonly AmbienceKind[] = ['wind', 'chimes', 'drops'];

/** Where one ambient sound plays: into `input` (an emitter, placed by the room). */
export interface AmbiencePlace {
  readonly id: string;
  readonly kind: AmbienceKind;
  readonly input: AudioNode;
  /** wind: where in the loop it starts (s), so two gaps never breathe in step. */
  readonly offset?: number;
  /** drops: which of DROP_NOTES fall here (indices). */
  readonly notes?: readonly number[];
}

export interface AmbienceOptions {
  /** Plan chimes and drops only while the context runs (default). An offline render plans regardless. */
  waitForRunning?: boolean;
}

export interface AmbienceSourceState {
  id: string;
  kind: AmbienceKind;
  /** Chimes and drops started (the wind: 1 once its loop runs). */
  plays: number;
  /** Still sounding now. */
  active: number;
}

/** A strike that was started: when it sounds, when it was planned (the audio clock then), which place and sound. */
export interface AmbienceHit {
  at: number;
  planned: number;
  id: string;
  kind: AmbienceKind;
  index: number;
}

interface PlaceState {
  place: AmbiencePlace;
  fader: GainNode;
  loop: LoopVoice | null;
  next: number;
  plays: number;
  ends: number[];
}

const MAX_HITS = 64;

/**
 * Plays the ambience of one space. `start` fades it in and starts the wind; `update(now)` (every frame, the audio
 * clock) plans the chimes and drops a little ahead; `stop` fades it out. After a stall (a hidden tab) it starts again
 * from now instead of playing everything it missed.
 */
export class AmbiencePlayer {
  readonly hits: AmbienceHit[] = [];
  private readonly states: PlaceState[];
  private readonly taps: Record<AmbienceKind, AnalyserNode>;
  private readonly waitForRunning: boolean;
  private readonly scratch = new Float32Array(2048);
  private started = false;
  private stopped = false;
  private disposed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly banks: AmbienceBanks,
    places: readonly AmbiencePlace[],
    private readonly rng: Rng = mulberry32(randomSeed()),
    opts: AmbienceOptions = {},
  ) {
    this.waitForRunning = opts.waitForRunning ?? true;
    const taps = {} as Record<AmbienceKind, AnalyserNode>;
    for (const kind of KINDS) {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      taps[kind] = a;
    }
    this.taps = taps;
    this.states = places.map((place) => {
      const fader = ctx.createGain();
      fader.gain.value = 0;
      fader.connect(place.input);
      // the probe's ears: an analyser keeps no output, so it plays nothing
      fader.connect(taps[place.kind]);
      return { place, fader, loop: null, next: Number.POSITIVE_INFINITY, plays: 0, ends: [] };
    });
  }

  get playing(): boolean {
    return this.started && !this.stopped;
  }

  /** Fades in from `at` and starts the wind; the first gust and drips come within their `first` ranges. */
  start(at: number): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const s of this.states) {
      s.fader.gain.setValueAtTime(0, at);
      s.fader.gain.setTargetAtTime(1, at, AMBIENCE.fadeIn / 3);
      const { kind } = s.place;
      if (kind === 'wind') {
        if (this.banks.wind) {
          s.loop = startLoop(this.ctx, s.fader, this.banks.wind, at, {
            offset: s.place.offset ?? 0,
            gain: AMBIENCE.wind.level,
          });
          s.plays = 1;
        }
      } else s.next = at + between(this.rng, AMBIENCE[kind].first);
    }
  }

  /** Plans what falls before `now` + the lookahead. Call every frame with the audio clock. */
  update(now: number): void {
    if (!this.playing) return;
    if (this.waitForRunning && this.ctx.state !== 'running') return;
    const horizon = now + AMBIENCE.lookahead;
    for (const s of this.states) {
      const { kind } = s.place;
      if (kind === 'wind') continue;
      // a stall (a hidden tab, a suspended context): start again from now, skip what was missed
      if (s.next < now - AMBIENCE.lookahead) s.next = now + this.rng() * AMBIENCE.lookahead;
      while (s.next <= horizon) {
        const plan =
          kind === 'chimes'
            ? planChimeRing(this.rng, s.next)
            : planDrip(this.rng, s.next, s.place.notes ?? [0]);
        for (const hit of plan) this.strike(s, hit, now);
        s.next += nextGap(this.rng, AMBIENCE[kind].gap);
      }
    }
  }

  private strike(s: PlaceState, hit: Hit, now: number): void {
    const kind = s.place.kind as 'chimes' | 'drops';
    const buffer = (kind === 'chimes' ? this.banks.chimes : this.banks.drops)[hit.index];
    if (!buffer) return;
    const at = Math.max(hit.at, now);
    s.ends = s.ends.filter((end) => end > now);
    if (s.ends.length >= AMBIENCE[kind].maxActive) return;
    scheduleBuffer(this.ctx, s.fader, buffer, at, { gain: AMBIENCE[kind].level * hit.gain });
    s.ends.push(at + buffer.duration);
    s.plays++;
    this.hits.push({ at, planned: now, id: s.place.id, kind, index: hit.index });
    if (this.hits.length > MAX_HITS) this.hits.shift();
  }

  /** Fades out from `at` and stops the wind; nothing more is planned. */
  stop(at: number): void {
    if (!this.playing) return;
    this.stopped = true;
    for (const s of this.states) {
      s.fader.gain.cancelScheduledValues(at);
      s.fader.gain.setTargetAtTime(0, at, AMBIENCE.fadeOut / 3);
      s.loop?.stop(at, AMBIENCE.fadeOut);
    }
  }

  /** Stops (at once) and lets go of its own nodes; the inputs are the emitters' owner's. */
  dispose(): void {
    if (this.disposed) return;
    if (this.playing) this.stop(this.ctx.currentTime);
    this.disposed = true;
    for (const s of this.states) s.fader.disconnect();
    for (const kind of KINDS) this.taps[kind].disconnect();
  }

  get sources(): AmbienceSourceState[] {
    const now = this.ctx.currentTime;
    return this.states.map((s) => ({
      id: s.place.id,
      kind: s.place.kind,
      plays: s.plays,
      active:
        s.place.kind === 'wind' ? (s.loop && this.playing ? 1 : 0) : s.ends.filter((e) => e > now).length,
    }));
  }

  /** How loud each kind sounds right now (RMS of its last ~43 ms at the source, before distance). */
  levels(): Record<AmbienceKind, number> {
    const out = {} as Record<AmbienceKind, number>;
    for (const kind of KINDS) {
      const a = this.taps[kind];
      const buf = this.scratch.length === a.fftSize ? this.scratch : new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += (buf[i] as number) ** 2;
      out[kind] = Math.sqrt(sum / buf.length);
    }
    return out;
  }
}
