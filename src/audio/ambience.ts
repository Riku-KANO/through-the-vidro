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
 *
 * S-25 adds the workshop's own sounds where S-24 drew them: the furnace burning low (a bed like the wind), and the
 * chime above the door, its own bell (not one of the far set), rung now and then by a draught through the door that
 * swells the wind there. The drops of the tub are S-22's drops, placed by the room.
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
import { designGlassVoice, type GlassStrength, type GlassTuning, type GlassVoice } from '../core/audio/glass';
import { mulberry32, type Rng, randomSeed } from '../core/audio/rng';
import { midiToHz } from '../core/audio/scale';
import { glassPitch } from './tuning';

/* ---------- tuning (仮) ---------- */

/** 風鈴: five glass bells, one per note of D major pentatonic, high and small (D6 E6 F#6 A6 B6). */
export const CHIME_NOTES: readonly number[] = [86, 88, 90, 93, 95];
/** 水滴: eight drops, D5 … F#6; each place drips on a few of them (deeper into a bucket, higher onto glass). */
export const DROP_NOTES: readonly number[] = [74, 76, 78, 81, 83, 86, 88, 90];
/** The wind's loop, long enough that its gusts do not sound like a cycle. */
export const WIND_LOOP_SECONDS = 8;
/** The furnace's loop (S-25): another length than the wind's, so the two never breathe in step. */
export const FURNACE_LOOP_SECONDS = 7;
/** The furnace's chamber hums under its roar on D2 and A2, the root and the fifth (音階の統一). */
export const FURNACE_HUM_NOTES: readonly number[] = [38, 45];
/**
 * 扉の上の風鈴 (S-25): S-24 drew one clear glass bell 8.3 cm across with a glass clapper (make_workshop.py wind_chime,
 * the bell's profile up to a radius of 4.15 cm). It rings the note the game's glass rule gives that size
 * (サウンドデザイン > ガラスの音: 大きい物ほど低く): B5, below the far chimes (D6 … B6) and none of theirs. The rule turns to
 * D6 below 8.17 cm, so the e2e measures the drawn bell and checks it still gives this note (S-27 may reshape it).
 */
export const DOOR_CHIME_SIZE = 0.083;
export const DOOR_CHIME_NOTE = glassPitch(DOOR_CHIME_SIZE).midi;
/** How the clapper meets the rim, one sound each: a graze, two taps, a full swing (DOOR_CHIME_SOURCES, in order). */
export const DOOR_CHIME_STRIKES: readonly GlassStrength[] = ['touch', 'tap', 'tap', 'hit'];
/** Which of DOOR_CHIME_STRIKES a swing of the clapper meets the rim with (a tap or a full swing) … */
export const DOOR_SWING_STRIKES: readonly number[] = [1, 2, 3];
/** … and which a bounce back onto the rim does (a graze or a tap). */
export const DOOR_BOUNCE_STRIKES: readonly number[] = [0, 1];
/** The clapper's swings in a draught and its bounces after each (AMBIENCE.doorChime). */
const DOOR_SWINGS = [1, 3] as const;
const DOOR_BOUNCES = 2;

export const AMBIENCE = {
  /** Seconds to fade in when the workshop is entered, and out when it is left. */
  fadeIn: 2.5,
  fadeOut: 0.8,
  /** How far ahead (s) chimes and drops are put on the audio clock. */
  lookahead: 0.25,
  /** Peak levels at the source (distance does the rest: HRTF, inverse 1/d beyond 1 m). */
  wind: { level: 0.5 },
  /** 炉 (S-25): a low bed at its mouth; nearer is louder by distance alone. */
  fire: { level: 0.28 },
  /**
   * 扉から入る風 (S-25): now and then a draught comes in at the door; the door's wind swells to `swell` times its level
   * over `rise` seconds, holds (at least `hold`, and past the chime's last strike), and falls back over `fall`. The chime
   * above the door rings from the draught's start until it begins to fall.
   */
  draught: {
    gap: [8, 18] as const,
    first: [2.5, 6] as const,
    swell: 1.7,
    rise: 0.6,
    hold: [0.8, 1.8] as const,
    fall: 1.5,
  },
  /**
   * The chime above the door (S-25): the air reaches the bell `delay` after the draught starts; its clapper swings
   * against the rim one to three times, `swingGap` apart, each softer by `fall`; a swing may bounce up to `bounces`
   * more times, `bounceGap` apart and softer by `bounceFall` (the チリン of a furin).
   */
  doorChime: {
    // near: at the bench (2.7 m) its strikes peak a little over the far chimes' (26 m, level 2: about +2.5 dB); right
    // under it (the door's view), the whole mix peaks about -9 dBFS with it, as loud as the po-pen at the hand (-10)
    level: 0.4,
    delay: [0.25, 0.6] as const,
    swings: DOOR_SWINGS,
    swingGap: [0.45, 1.1] as const,
    fall: [0.55, 0.85] as const,
    bounces: DOOR_BOUNCES,
    bounceGap: [0.05, 0.12] as const,
    bounceFall: [0.35, 0.65] as const,
    /** Every strike of a draught can ring at once. */
    maxActive: DOOR_SWINGS[1] * (1 + DOOR_BOUNCES),
  },
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

/**
 * The bell above the door (S-25): thicker glass than the far furin (S-24 drew its wall 2.5 mm), so it rings shorter and
 * its overtones die sooner; struck by a glass clapper, a sharper tick; and, hand-blown, its rim is a little uneven: the
 * fundamental's partner mode sits 0.4–0.7 % above, beating a few times a second (the waver of a furin close by).
 */
const DOOR_GLASS: GlassTuning = {
  strengths: {
    // the clapper grazing the rim as the bell turns in the air
    touch: { level: 0.35, brightness: 0.3, attack: 0.002, strike: 0.06, strikeDuration: 0.002, ring: 0.75 },
    tap: { level: 0.65, brightness: 0.45, attack: 0.0006, strike: 0.2, strikeDuration: 0.003, ring: 1 },
    hit: { level: 0.85, brightness: 0.58, attack: 0.0004, strike: 0.3, strikeDuration: 0.003, ring: 1 },
  },
  ring: { refSize: 0.1, t60: 1.6, exponent: 0.35, min: 0.4, max: 4 },
  modeDamping: 0.85,
  strike: { centerRatio: 4.5, q: 2.5, minHz: 3500 },
  jitter: {
    detune: 0.002,
    modeRatio: 0.01,
    modeGain: 0.2,
    t60: 0.1,
    levelDb: 0.5,
    splitMin: 0.004,
    splitMax: 0.007,
    splitGain: 0.45,
    strikeHz: 0.1,
  },
};

/* ---------- synthesis (pure) ---------- */

/** A designed glass voice rendered once: its ringing partials and its strike's noise (from `noise`). Mono, peak 0.9. */
function ringBell(voice: GlassVoice, sampleRate: number, noise: Rng, maxSeconds: number): Float32Array {
  const x = new Float32Array(Math.round(Math.min(maxSeconds, voice.duration) * sampleRate));
  addPartials(x, voice.partials, { start: 0, attack: voice.attack, sampleRate });
  const s = voice.strike;
  if (s) {
    const band = new Biquad(sampleRate).bandpass(s.hz, s.q);
    const k = Math.exp(-1 / ((s.duration / 3) * sampleRate));
    let env = s.gain;
    for (let i = 0; i < Math.min(x.length, Math.round(s.duration * 4 * sampleRate)); i++) {
      x[i] = (x[i] as number) + band.process(noise() * 2 - 1) * env;
      env *= k;
    }
  }
  normalizePeak(x, 0.9);
  return fadeEnds(x, 0, Math.round(0.05 * sampleRate));
}

/** One glass bell struck once, on `midi`. Mono, peak 0.9. */
export function renderChime(midi: number, sampleRate: number): Float32Array {
  const voice = designGlassVoice(
    { hz: midiToHz(midi), size: FURIN_SIZE, strength: 'tap', sampleRate },
    mulberry32(0xc41e + midi * 101),
    FURIN_GLASS,
  );
  return ringBell(voice, sampleRate, mulberry32(0x57 + midi), 3.2);
}

/** The bell above the door struck once, the `variant`-th way of DOOR_CHIME_STRIKES (S-25). Mono, peak 0.9. */
export function renderDoorChime(variant: number, sampleRate: number): Float32Array {
  const strength = DOOR_CHIME_STRIKES[variant] ?? 'tap';
  const voice = designGlassVoice(
    { hz: midiToHz(DOOR_CHIME_NOTE), size: DOOR_CHIME_SIZE, strength, sampleRate },
    mulberry32(0xd00c + variant * 977),
    DOOR_GLASS,
  );
  return ringBell(voice, sampleRate, mulberry32(0x7c1 + variant), 2.6);
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

/**
 * The furnace burning low (S-25), a seamless loop of FURNACE_LOOP_SECONDS: a dark roar (noise under ~250 Hz), the
 * chamber humming on FURNACE_HUM_NOTES (narrow resonances of the same air), and the soft rush of the flame, which
 * flutters. Everything slow in it is periodic over the loop, so the crossfade joins like with like. Nothing in it is
 * above ~1 kHz to speak of: a warmth under the room, not a hiss. Mono, peak 0.9.
 */
export function renderFurnace(sampleRate: number): Float32Array {
  const L = FURNACE_LOOP_SECONDS;
  const loopLength = Math.round(L * sampleRate);
  const fade = Math.round(1.2 * sampleRate);
  const raw = new Float32Array(loopLength + fade);
  const rng = mulberry32(0xf12e5);
  const ph = [rng(), rng(), rng(), rng()].map((p) => p * 2 * Math.PI) as [number, number, number, number];
  const w = (2 * Math.PI) / L;
  // the fire breathes slowly (whole cycles over the loop) …
  const breath = (t: number): number =>
    1 +
    0.13 * Math.sin(2 * w * t + ph[0]) +
    0.08 * Math.sin(5 * w * t + ph[1]) +
    0.05 * Math.sin(11 * w * t + ph[2]);
  // … and its flame flutters (66 cycles over the loop, about 9.4 Hz)
  const flutter = (t: number): number => 1 + 0.3 * Math.sin(66 * w * t + ph[3]);
  const roarA = new Biquad(sampleRate).lowpass(170, 0.7);
  const roarB = new Biquad(sampleRate).lowpass(320, 0.7);
  const hums = FURNACE_HUM_NOTES.map((m) => new Biquad(sampleRate).bandpass(midiToHz(m), 30));
  const rush = new Biquad(sampleRate).bandpass(420, 0.8);
  // the whole fire through a dark top, so no skirt of a filter above reaches the air
  const topA = new Biquad(sampleRate).lowpass(900, 0.7);
  const topB = new Biquad(sampleRate).lowpass(900, 0.7);
  const BLOCK = 32;
  for (let start = 0; start < raw.length; start += BLOCK) {
    const t = (start + BLOCK / 2) / sampleRate;
    const b = breath(t);
    const f = flutter(t);
    for (let i = start; i < Math.min(raw.length, start + BLOCK); i++) {
      const n = rng() * 2 - 1;
      const roar = roarB.process(roarA.process(n)) * 1.4 * b;
      let hum = 0;
      for (const h of hums) hum += h.process(n);
      const air = rush.process(rng() * 2 - 1) * 0.22 * b * f;
      raw[i] = topB.process(topA.process(roar + hum * 3.2 * b + air));
    }
  }
  return normalizePeak(crossfadeLoop(raw, fade), 0.9);
}

export const CHIME_SOURCES: readonly SoundSource[] = CHIME_NOTES.map((m, i) =>
  synth(`chime-${i + 1}`, (sr) => renderChime(m, sr)),
);
/** S-25: the bell above the door, one sound for each way its clapper meets the rim. */
export const DOOR_CHIME_SOURCES: readonly SoundSource[] = DOOR_CHIME_STRIKES.map((_, v) =>
  synth(`door-chime-${v + 1}`, (sr) => renderDoorChime(v, sr)),
);
/** S-25: nothing in the furnace is high either: made at 24 kHz like the wind. */
export const FURNACE_SOURCE: SoundSource = synth('furnace-loop', renderFurnace, { sampleRate: 24000 });
export const DROP_SOURCES: readonly SoundSource[] = DROP_NOTES.map((m, i) =>
  synth(`drop-${i + 1}`, (sr) => renderDrop(m, i, sr)),
);
/** Nothing in the wind is above ~10 kHz: it is made at 24 kHz (half the work), the source node resamples it. */
export const WIND_SOURCE: SoundSource = synth('wind-loop', renderWind, { sampleRate: 24000 });

export interface AmbienceBanks {
  wind: AudioBuffer | null;
  /** S-25 */
  fire: AudioBuffer | null;
  chimes: readonly (AudioBuffer | null)[];
  /** S-25: DOOR_CHIME_SOURCES. */
  doorChime: readonly (AudioBuffer | null)[];
  drops: readonly (AudioBuffer | null)[];
}

export async function loadAmbienceBanks(ctx: BaseAudioContext, signal?: AbortSignal): Promise<AmbienceBanks> {
  const [wind = null] = await loadBank(ctx, [WIND_SOURCE], { signal });
  const [fire = null] = await loadBank(ctx, [FURNACE_SOURCE], { signal });
  const chimes = await loadBank(ctx, CHIME_SOURCES, { signal });
  const doorChime = await loadBank(ctx, DOOR_CHIME_SOURCES, { signal });
  const drops = await loadBank(ctx, DROP_SOURCES, { signal });
  return { wind, fire, chimes, doorChime, drops };
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

/** A draught through the door (S-25): how it swells the wind there, and the chime's strikes it rings. */
export interface Draught {
  /** When it starts to come in; it rises over `rise`, holds for `hold` and falls back over `fall` (s). */
  at: number;
  rise: number;
  hold: number;
  fall: number;
  /** Strikes of the chime above the door (indices into DOOR_CHIME_SOURCES), from its start until it begins to fall. */
  hits: Hit[];
}

const pick = (rng: Rng, from: readonly number[]): number =>
  from[Math.floor(rng() * from.length) % from.length] as number;

/**
 * A draught from `at`: the air reaches the bell a moment later; the clapper swings against the rim one to three times,
 * each softer, and a swing may bounce once or twice (softer still). The draught holds at least until its last strike.
 */
export function planDraught(rng: Rng, at: number): Draught {
  const d = AMBIENCE.draught;
  const c = AMBIENCE.doorChime;
  const hits: Hit[] = [];
  const swings = c.swings[0] + Math.floor(rng() * (c.swings[1] - c.swings[0] + 1));
  let t = at + between(rng, c.delay);
  let gain = 0.7 + rng() * 0.3;
  for (let k = 0; k < swings; k++) {
    // a swing meets the rim with a tap or a full swing …
    hits.push({ at: t, index: pick(rng, DOOR_SWING_STRIKES), gain });
    // … and may bounce back onto it, with a graze or a tap
    const bounces = Math.floor(rng() * (c.bounces + 1));
    let bt = t;
    let bg = gain;
    for (let b = 0; b < bounces; b++) {
      bt += between(rng, c.bounceGap);
      bg *= between(rng, c.bounceFall);
      hits.push({ at: bt, index: pick(rng, DOOR_BOUNCE_STRIKES), gain: bg });
    }
    t += between(rng, c.swingGap);
    gain *= between(rng, c.fall);
  }
  const last = (hits[hits.length - 1] as Hit).at;
  const hold = Math.max(between(rng, d.hold), last - (at + d.rise) + 0.25);
  return { at, rise: d.rise, hold, fall: d.fall, hits };
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

/** S-25 adds the furnace ('fire', a bed like the wind); the chime above the door is a place of 'chimes'. */
export type AmbienceKind = 'wind' | 'fire' | 'chimes' | 'drops';
const KINDS: readonly AmbienceKind[] = ['wind', 'fire', 'chimes', 'drops'];
/** The kinds that are a bed: a loop from the start (the rest are struck now and then). */
const isBed = (kind: AmbienceKind): kind is 'wind' | 'fire' => kind === 'wind' || kind === 'fire';

/** Where one ambient sound plays: into `input` (an emitter, placed by the room). */
export interface AmbiencePlace {
  readonly id: string;
  readonly kind: AmbienceKind;
  readonly input: AudioNode;
  /** wind, fire: where in the loop it starts (s), so two gaps never breathe in step. */
  readonly offset?: number;
  /** drops: which of DROP_NOTES fall here (indices). */
  readonly notes?: readonly number[];
  /**
   * chimes: which bells hang here — the far set (S-22, rung by gusts of their own) or the one above the door (S-25,
   * rung by the door's draughts). Default 'town'.
   */
  readonly bells?: 'town' | 'door';
  /** chimes of the door: the wind place (its id) a draught swells as it comes in. */
  readonly draught?: string;
  /**
   * Its own random stream for when it strikes (default: the player's, shared in the order of the places). A place
   * added later with a stream of its own leaves the timing of the others as it was (S-25: the door's chime keeps S-22's
   * seeded renders, which the ear and the sensors were tuned on, unchanged).
   */
  readonly rng?: Rng;
}

/** A draught that came in (S-25): its place, when it started, until when it held (the chime rings in between), when it had fallen. */
export interface DraughtLog {
  id: string;
  at: number;
  held: number;
  until: number;
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
  /** Where its timing is drawn from: its own stream, or the player's. */
  rng: Rng;
  fader: GainNode;
  loop: LoopVoice | null;
  next: number;
  plays: number;
  ends: number[];
}

const MAX_HITS = 64;
const MAX_DRAUGHTS = 16;
/** Leaving: the faders' fade (≈ -60 dB in 20 ms), and when their nodes are let go of after it. */
const DISPOSE_TAU = 0.003;
const DISPOSE_WAIT_MS = 60;

const isDoor = (place: AmbiencePlace): boolean => place.kind === 'chimes' && place.bells === 'door';
/** Seconds before the first strike of a place, and between strikes (gusts, drips, draughts). */
const firstOf = (place: AmbiencePlace): readonly [number, number] =>
  isDoor(place) ? AMBIENCE.draught.first : AMBIENCE[place.kind === 'drops' ? 'drops' : 'chimes'].first;
const gapOf = (place: AmbiencePlace): readonly [number, number] =>
  isDoor(place) ? AMBIENCE.draught.gap : AMBIENCE[place.kind === 'drops' ? 'drops' : 'chimes'].gap;

/**
 * Plays the ambience of one space. `start` fades it in and starts the beds (wind, fire); `update(now)` (every frame,
 * the audio clock) plans the chimes, drops and draughts a little ahead; `stop` fades it out. After a stall (a hidden
 * tab) it starts again from now instead of playing everything it missed.
 */
export class AmbiencePlayer {
  /**
   * The last strikes (at most 64), in the order they sound. A draught's strikes are planned seconds ahead (S-25), so a
   * strike can be planned before others that sound earlier: each is put in its place by time.
   */
  readonly hits: AmbienceHit[] = [];
  /** S-25: the door's draughts, newest last (at most 16). */
  readonly draughts: DraughtLog[] = [];
  private readonly states: PlaceState[];
  /** The probe's ears, made the first time levels() is asked (the game itself never needs them). */
  private taps: Record<AmbienceKind, AnalyserNode> | null = null;
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
    this.states = places.map((place) => {
      const fader = ctx.createGain();
      fader.gain.value = 0;
      fader.connect(place.input);
      const own = place.rng ?? this.rng;
      return { place, rng: own, fader, loop: null, next: Number.POSITIVE_INFINITY, plays: 0, ends: [] };
    });
  }

  get playing(): boolean {
    return this.started && !this.stopped;
  }

  /** Fades in from `at` and starts the beds; the first gusts, drips and draughts come within their `first` ranges. */
  start(at: number): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const s of this.states) {
      s.fader.gain.setValueAtTime(0, at);
      s.fader.gain.setTargetAtTime(1, at, AMBIENCE.fadeIn / 3);
      const { kind } = s.place;
      if (isBed(kind)) {
        const buffer = kind === 'wind' ? this.banks.wind : this.banks.fire;
        if (buffer) {
          s.loop = startLoop(this.ctx, s.fader, buffer, at, {
            offset: s.place.offset ?? 0,
            gain: AMBIENCE[kind].level,
          });
          s.plays = 1;
        }
      } else s.next = at + between(s.rng, firstOf(s.place));
    }
  }

  /** Plans what falls before `now` + the lookahead. Call every frame with the audio clock. */
  update(now: number): void {
    if (!this.playing) return;
    if (this.waitForRunning && this.ctx.state !== 'running') return;
    const horizon = now + AMBIENCE.lookahead;
    for (const s of this.states) {
      const { kind } = s.place;
      if (isBed(kind)) continue;
      // a stall (a hidden tab, a suspended context): start again from now, skip what was missed
      if (s.next < now - AMBIENCE.lookahead) s.next = now + s.rng() * AMBIENCE.lookahead;
      while (s.next <= horizon) {
        if (isDoor(s.place)) this.draught(s, planDraught(s.rng, s.next), now);
        else {
          const plan =
            kind === 'chimes' ? planChimeRing(s.rng, s.next) : planDrip(s.rng, s.next, s.place.notes ?? [0]);
          for (const hit of plan) this.strike(s, hit, now);
        }
        s.next += nextGap(s.rng, gapOf(s.place));
      }
    }
  }

  /**
   * A draught through the door (S-25): the door's wind swells as it comes in and settles back once it has passed, and
   * the chime above the door rings from its start until it begins to fall. Its strikes are planned with it, ahead of
   * the clock.
   */
  private draught(s: PlaceState, d: Draught, now: number): void {
    const held = d.at + d.rise + d.hold;
    const wind = s.place.draught ? this.states.find((w) => w.place.id === s.place.draught) : undefined;
    if (wind?.loop) {
      const level = AMBIENCE.wind.level;
      const g = wind.loop.gain.gain;
      g.cancelScheduledValues(d.at);
      g.setTargetAtTime(level * AMBIENCE.draught.swell, d.at, d.rise / 3);
      g.setTargetAtTime(level, held, d.fall / 3);
    }
    for (const hit of d.hits) this.strike(s, hit, now);
    this.draughts.push({ id: s.place.id, at: d.at, held, until: held + d.fall });
    if (this.draughts.length > MAX_DRAUGHTS) this.draughts.shift();
  }

  private strike(s: PlaceState, hit: Hit, now: number): void {
    const kind = s.place.kind as 'chimes' | 'drops';
    const door = isDoor(s.place);
    const bank = kind === 'drops' ? this.banks.drops : door ? this.banks.doorChime : this.banks.chimes;
    const buffer = bank[hit.index];
    if (!buffer) return;
    const tuning = door ? AMBIENCE.doorChime : AMBIENCE[kind];
    const at = Math.max(hit.at, now);
    s.ends = s.ends.filter((end) => end > now);
    if (s.ends.length >= tuning.maxActive) return;
    scheduleBuffer(this.ctx, s.fader, buffer, at, { gain: tuning.level * hit.gain });
    s.ends.push(at + buffer.duration);
    s.plays++;
    let k = this.hits.length;
    while (k > 0 && (this.hits[k - 1] as AmbienceHit).at > at) k--;
    this.hits.splice(k, 0, { at, planned: now, id: s.place.id, kind, index: hit.index });
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

  /**
   * Leaving: a quick fade (≈ 20 ms to -60 dB) and the wind stops, then its own nodes are let go of once the fade has
   * run (at once if the context is not running). The inputs are the emitters' owner's.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    const now = this.ctx.currentTime;
    for (const s of this.states) {
      s.fader.gain.cancelScheduledValues(now);
      s.fader.gain.setTargetAtTime(0, now, DISPOSE_TAU);
      s.loop?.stop(now, DISPOSE_TAU * 3);
    }
    const letGo = (): void => {
      for (const s of this.states) s.fader.disconnect();
      if (this.taps) for (const kind of KINDS) this.taps[kind].disconnect();
    };
    if (this.ctx.state === 'running') setTimeout(letGo, DISPOSE_WAIT_MS);
    else letGo();
  }

  get sources(): AmbienceSourceState[] {
    const now = this.ctx.currentTime;
    return this.states.map((s) => ({
      id: s.place.id,
      kind: s.place.kind,
      plays: s.plays,
      active: isBed(s.place.kind) ? (s.loop && this.playing ? 1 : 0) : s.ends.filter((e) => e > now).length,
    }));
  }

  /** The analysers the probe listens through: one per kind, fed from every fader of that kind, with no output. */
  private ears(): Record<AmbienceKind, AnalyserNode> {
    if (this.taps) return this.taps;
    const taps = {} as Record<AmbienceKind, AnalyserNode>;
    for (const kind of KINDS) {
      const a = this.ctx.createAnalyser();
      a.fftSize = 2048;
      taps[kind] = a;
    }
    for (const s of this.states) s.fader.connect(taps[s.place.kind]);
    this.taps = taps;
    return taps;
  }

  /**
   * How loud each kind sounds right now (RMS of its last ~43 ms at the source, before distance). The first call puts
   * the ears in; they hear from then on.
   */
  levels(): Record<AmbienceKind, number> {
    const out = { wind: 0, fire: 0, chimes: 0, drops: 0 };
    if (this.disposed) return out;
    const taps = this.ears();
    for (const kind of KINDS) {
      const a = taps[kind];
      const buf = this.scratch.length === a.fftSize ? this.scratch : new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += (buf[i] as number) ** 2;
      out[kind] = Math.sqrt(sum / buf.length);
    }
    return out;
  }
}
