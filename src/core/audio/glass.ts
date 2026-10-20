/**
 * Synthesized glass sounds (modal synthesis): a struck glass shell rings as a few sine "modes"
 * whose frequencies are NOT integer multiples of the fundamental — that inharmonicity is what makes
 * it sound like glass rather than a string or a flute.
 * Design doc: サウンドデザイン > ガラスの音 — three strengths (touch / tap / hit) × size (bigger = lower).
 *
 * designGlassVoice() is pure (testable); scheduleGlassVoice() turns a voice into Web Audio nodes
 * on any BaseAudioContext (live or OfflineAudioContext), so tests render exactly what players hear.
 */
import { jitter, type Rng } from './rng';

export type GlassStrength = 'touch' | 'tap' | 'hit';
export const GLASS_STRENGTHS: readonly GlassStrength[] = ['touch', 'tap', 'hit'];

/** Rayleigh's thin-shell bending modes (bells, wine glasses): f_n ∝ n(n²−1)/√(n²+1). */
function shellMode(n: number): number {
  return (n * (n * n - 1)) / Math.sqrt(n * n + 1);
}

/** Mode frequency ratios for n = 2…5, relative to the fundamental: 1 : 2.83 : 5.42 : 8.77. */
export const GLASS_MODE_RATIOS: readonly number[] = [2, 3, 4, 5].map((n) => shellMode(n) / shellMode(2));

interface StrengthProfile {
  /** Peak level of the whole voice (all partials in phase). */
  level: number;
  /** Relative gain of mode k is brightness^k: harder strikes excite higher modes. */
  brightness: number;
  /** Attack time in seconds: a finger swells in, a hard object clicks. */
  attack: number;
  /** Level of the noisy strike transient (0 = none). */
  strike: number;
  strikeDuration: number;
  /** Ring-time multiplier: a touching finger damps the glass. */
  ring: number;
}

/** Tuning values (not in the design doc; to be confirmed by ear). */
const STRENGTH: Record<GlassStrength, StrengthProfile> = {
  touch: { level: 0.2, brightness: 0.12, attack: 0.012, strike: 0, strikeDuration: 0, ring: 0.6 },
  tap: { level: 0.45, brightness: 0.35, attack: 0.002, strike: 0.07, strikeDuration: 0.006, ring: 1 },
  hit: { level: 0.75, brightness: 0.6, attack: 0.0005, strike: 0.12, strikeDuration: 0.004, ring: 1 },
};

/** Per-strike randomness ("揺らぎ"), so repeated strikes never sound mechanical. */
const JITTER = {
  /** Fundamental detune, ±0.35 % ≈ ±6 cents: alive, still clearly on the scale note. */
  detune: 0.0035,
  /** Overtone ratio spread (small glass imperfections). */
  modeRatio: 0.006,
  modeGain: 0.2,
  t60: 0.1,
  /** ±1 dB overall level. */
  levelDb: 1,
  /** Real glass modes come in near-degenerate pairs; the split makes a slow shimmer (beats). */
  splitMin: 0.0005,
  splitMax: 0.0025,
  splitGain: 0.35,
};

export interface GlassVoiceParams {
  /** Fundamental in Hz (use pitchForSize() to stay on the scale). */
  hz: number;
  /** Characteristic size in metres; bigger glass rings longer. */
  size: number;
  strength: GlassStrength;
  /** Partials above 0.45 × sampleRate are dropped. Default 48000. */
  sampleRate?: number;
}

export interface GlassPartial {
  hz: number;
  /** Absolute peak gain of this partial. */
  gain: number;
  /** Seconds to decay by 60 dB. */
  t60: number;
}

export interface GlassVoice {
  /** Actual (jittered) fundamental. */
  hz: number;
  strength: GlassStrength;
  level: number;
  attack: number;
  /** partials[0] is the fundamental. */
  partials: GlassPartial[];
  /** Noisy strike transient; `offset` picks where to read the shared noise buffer. */
  strike: { gain: number; hz: number; q: number; duration: number; offset: number } | null;
  /** Seconds from start until the voice is silent (-60 dB). */
  duration: number;
}

/** Fundamental ring time: ~1.6 s for a 10 cm glass, longer for bigger ones. Tuning value. */
function baseT60(size: number): number {
  return Math.min(6, Math.max(0.5, 1.6 * (Math.max(size, 1e-3) / 0.1) ** 0.35));
}

export function designGlassVoice(params: GlassVoiceParams, rng: Rng): GlassVoice {
  const profile = STRENGTH[params.strength];
  const nyquistSafe = (params.sampleRate ?? 48000) * 0.45;
  const hz = params.hz * (1 + jitter(rng, JITTER.detune));
  const level = profile.level * 10 ** (jitter(rng, JITTER.levelDb) / 20);
  const t60 = baseT60(params.size) * profile.ring * (1 + jitter(rng, JITTER.t60));

  const raw: GlassPartial[] = [];
  GLASS_MODE_RATIOS.forEach((ratio, k) => {
    const modeHz = k === 0 ? hz : hz * ratio * (1 + jitter(rng, JITTER.modeRatio));
    const rel = k === 0 ? 1 : profile.brightness ** k * (1 + jitter(rng, JITTER.modeGain));
    const modeT60 = k === 0 ? t60 : (t60 / ratio ** 0.7) * (1 + jitter(rng, JITTER.t60));
    raw.push({ hz: modeHz, gain: rel, t60: modeT60 });
    if (k === 0) {
      const split = JITTER.splitMin + rng() * (JITTER.splitMax - JITTER.splitMin);
      raw.push({ hz: hz * (1 + split), gain: JITTER.splitGain, t60: t60 * (1 + jitter(rng, JITTER.t60)) });
    }
  });
  const audible = raw.filter((p) => p.hz < nyquistSafe);
  const sum = audible.reduce((s, p) => s + p.gain, 0);
  const partials = audible.map((p) => ({ ...p, gain: (p.gain / sum) * level }));

  const strike =
    profile.strike > 0
      ? {
          gain: profile.strike,
          hz: Math.min(nyquistSafe * 0.9, Math.max(1500, hz * 3.5 * (1 + jitter(rng, 0.15)))),
          q: 1.2,
          duration: profile.strikeDuration,
          offset: rng() * 0.15,
        }
      : null;
  const ring = Math.max(...partials.map((p) => p.t60));
  return {
    hz,
    strength: params.strength,
    level,
    attack: profile.attack,
    partials,
    strike,
    duration: profile.attack + ring,
  };
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Shared 0.25 s white-noise buffer per context (strike transients, clicks). */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.25), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 0x9e3779b9;
    for (let i = 0; i < d.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

/** Natural log of 1000: an exponential decays by 60 dB after t60 = tau × LN1000. */
export const LN1000 = Math.log(1000);

/** Build the voice as Web Audio nodes into `destination`, starting at `when`. Returns the end time. */
export function scheduleGlassVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  voice: GlassVoice,
  when: number,
): number {
  const out = ctx.createGain();
  out.connect(destination);
  const end = when + voice.duration;
  let last: OscillatorNode | null = null;
  let lastEnd = 0;
  for (const p of voice.partials) {
    const osc = ctx.createOscillator();
    osc.frequency.value = p.hz;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(p.gain, when + voice.attack);
    env.gain.setTargetAtTime(0, when + voice.attack, p.t60 / LN1000);
    osc.connect(env).connect(out);
    const stop = when + voice.attack + p.t60;
    osc.start(when);
    osc.stop(stop);
    if (stop > lastEnd) {
      lastEnd = stop;
      last = osc;
    }
  }
  if (voice.strike) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = voice.strike.hz;
    band.Q.value = voice.strike.q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(voice.strike.gain, when);
    env.gain.setTargetAtTime(0, when, voice.strike.duration / 3);
    src.connect(band).connect(env).connect(out);
    src.start(when, voice.strike.offset);
    src.stop(when + voice.strike.duration * 4);
  }
  if (last) last.onended = () => out.disconnect();
  return end;
}
