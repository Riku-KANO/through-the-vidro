/**
 * Thin-glass pops: the snap of a glass membrane so thin it flexes, like the bottom of a vidro /
 * poppen (Nagasaki's blown-glass toy) flipping in and out. Generic synthesis only — which notes a
 * game plays for which action lives in the game (Through the Vidro: src/audio/popen.ts).
 *
 * Each pop = a sine whose pitch starts a few percent sharp and drops onto the note within ~10 ms
 * (the membrane springs back), a faint thin-shell overtone, and a ~1 ms click.
 * A "pair" pattern articulates two pops as a soft short "po" and a brighter, longer-ringing "pen".
 * designPops() is pure; schedulePops() renders it on any BaseAudioContext.
 */
import { fadeAndStop, GLASS_MODE_RATIOS, LN1000, noiseBuffer, type PlannedSource } from './glass';
import { jitter, type Rng } from './rng';
import { midiToHz } from './scale';
import type { ScheduledVoice } from './voices';

export interface PopPattern {
  /** MIDI notes, one per pop (the caller keeps them on its scale). */
  readonly notes: readonly number[];
  /** Seconds between pops. */
  readonly spacing: number;
  /** Peak gain of the loudest pop. */
  readonly gain: number;
  /** Gain multiplier per following pop (1 = even, <1 fades out). */
  readonly fade: number;
  /** Articulate the first two pops as a soft "po" and a bright, ringing "pen". */
  readonly pair: boolean;
}

export interface Pop {
  /** Seconds from the start of the sound. */
  time: number;
  midi: number;
  /** Target (jittered) frequency the pop settles on. */
  hz: number;
  gain: number;
  /** 0..1, level of the thin-shell overtone and the click. */
  bright: number;
  t60: number;
  /** Relative pitch overshoot at the snap. */
  glide: number;
}

export interface PopScore {
  pops: Pop[];
  duration: number;
}

const ATTACK = 0.001;

/** Tuning values (to be confirmed by ear). */
const ARTICULATION = {
  po: { gain: 0.7, bright: 0.25, t60: 0.12, glide: 0.06 },
  pen: { gain: 1, bright: 0.5, t60: 0.28, glide: 0.035 },
  plain: { gain: 1, bright: 0.35, t60: 0.08, glide: 0.035 },
};

/** Per-play randomness. */
const JITTER = { time: 0.005, pitch: 0.002, levelDb: 1, t60: 0.1 };

export function designPops(pattern: PopPattern, rng: Rng): PopScore {
  const pops: Pop[] = pattern.notes.map((midi, i) => {
    const a =
      pattern.pair && i === 0
        ? ARTICULATION.po
        : pattern.pair && i === 1
          ? ARTICULATION.pen
          : ARTICULATION.plain;
    return {
      time: i === 0 ? 0 : i * pattern.spacing + jitter(rng, JITTER.time),
      midi,
      hz: midiToHz(midi) * (1 + jitter(rng, JITTER.pitch)),
      gain: pattern.gain * a.gain * pattern.fade ** i * 10 ** (jitter(rng, JITTER.levelDb) / 20),
      bright: a.bright,
      t60: a.t60 * (1 + jitter(rng, JITTER.t60)),
      glide: a.glide,
    };
  });
  const duration = pops.length ? Math.max(...pops.map((p) => p.time + ATTACK + p.t60)) : 0;
  return { pops, duration };
}

/** Render the score into `destination` starting at `when`. */
export function schedulePops(
  ctx: BaseAudioContext,
  destination: AudioNode,
  score: PopScore,
  when: number,
): ScheduledVoice {
  const out = ctx.createGain();
  out.connect(destination);
  const sources: PlannedSource[] = [];
  let last: OscillatorNode | null = null;
  let lastEnd = 0;
  const overtone = GLASS_MODE_RATIOS[1] as number;
  for (const pop of score.pops) {
    const t = when + pop.time;
    // Body and thin-shell overtone, both snapping down onto pitch within ~10 ms.
    for (const [ratio, gain, t60] of [
      [1, pop.gain, pop.t60],
      [overtone, pop.gain * pop.bright * 0.5, pop.t60 * 0.5],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(pop.hz * ratio * (1 + pop.glide), t);
      osc.frequency.setTargetAtTime(pop.hz * ratio, t, 0.003);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(gain, t + ATTACK);
      env.gain.setTargetAtTime(0, t + ATTACK, t60 / LN1000);
      osc.connect(env).connect(out);
      const stop = t + ATTACK + t60;
      osc.start(t);
      osc.stop(stop);
      sources.push({ node: osc, stop });
      if (stop > lastEnd) {
        lastEnd = stop;
        last = osc;
      }
    }
    // The click of the glass bottom flipping.
    const click = ctx.createBufferSource();
    click.buffer = noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const env = ctx.createGain();
    env.gain.setValueAtTime(pop.gain * 0.25 * (0.5 + pop.bright), t);
    env.gain.setTargetAtTime(0, t, 0.001);
    click.connect(hp).connect(env).connect(out);
    click.start(t, (pop.hz % 97) / 1000);
    click.stop(t + 0.01);
    sources.push({ node: click, stop: t + 0.01 });
  }
  // Free the voice once the longest-ringing partial has stopped.
  if (last) last.onended = () => out.disconnect();
  return {
    end: when + score.duration,
    fadeOut: (at: number) => fadeAndStop(out, sources, at),
  };
}
