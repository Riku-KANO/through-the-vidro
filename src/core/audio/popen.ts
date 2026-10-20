/**
 * "Po-pen": the sound of a vidro / poppen (Nagasaki's blown-glass toy). Its bottom is glass so thin
 * that breathing into it makes the bottom snap in and out — a short, soft "po" and a brighter "pen".
 * Design doc: サウンドデザイン > ガラスの音 (the hand orb's signature sound, played on peek / place / pick up)
 * and アセットリスト > 音 (ビードロの音 4: 覗く、置く、拾う、震える).
 *
 * Each pop = a thin membrane snap: a sine whose pitch drops quickly onto the target note
 * (the bottom springs back), a faint thin-shell overtone, and a tiny click.
 * designPopen() is pure; schedulePopen() renders it on any BaseAudioContext.
 *
 * Note: which contour belongs to which game action is a game rule; it lives here as presets for now
 * (candidate to move to src/audio/ when M1 audio starts).
 */
import { GLASS_MODE_RATIOS, LN1000, noiseBuffer } from './glass';
import { jitter, type Rng } from './rng';
import { D_MAJOR_PENTATONIC, isInScale, midiToHz, type Scale, snapToScale } from './scale';

export const POPEN_KINDS = ['peek', 'place', 'pickup', 'tremble'] as const;
export type PopenKind = (typeof POPEN_KINDS)[number];

interface PopenPattern {
  /** MIDI notes, one per pop (snapped to the scale). */
  notes: readonly number[];
  /** Seconds between pops. */
  spacing: number;
  /** Peak gain of the loudest pop. */
  gain: number;
  /** Gain multiplier per following pop (tremble fades out). */
  fade: number;
  /** Two-pop patterns: the first is the soft "po", the second the brighter, longer "pen". */
  twoNote: boolean;
}

/**
 * Tuning values (not in the design doc; to be confirmed by ear). All notes on D major pentatonic.
 *  peek   F#5 → B5  rising fourth: opening, curious
 *  place  D6  → A5  falling fourth: settling down
 *  pickup A5  → D6  rising fourth: lifting (mirror of place)
 *  tremble A5/B5 alternating quickly and fading: the orb shivers
 */
export const POPEN_PATTERNS: Readonly<Record<PopenKind, PopenPattern>> = {
  peek: { notes: [78, 83], spacing: 0.11, gain: 0.5, fade: 1, twoNote: true },
  place: { notes: [86, 81], spacing: 0.12, gain: 0.5, fade: 1, twoNote: true },
  pickup: { notes: [81, 86], spacing: 0.1, gain: 0.5, fade: 1, twoNote: true },
  tremble: { notes: [81, 83, 81, 83, 81, 83], spacing: 0.055, gain: 0.28, fade: 0.85, twoNote: false },
};

export interface PopenPop {
  /** Seconds from the start of the sound. */
  time: number;
  midi: number;
  /** Target (jittered) frequency the pop settles on. */
  hz: number;
  gain: number;
  /** 0..1, level of the thin-shell overtone and the click. */
  bright: number;
  t60: number;
  /** Relative pitch overshoot at the snap (the membrane springs back onto the note). */
  glide: number;
}

export interface PopenScore {
  kind: PopenKind;
  pops: PopenPop[];
  duration: number;
}

const ATTACK = 0.001;

export function designPopen(kind: PopenKind, rng: Rng, scale: Scale = D_MAJOR_PENTATONIC): PopenScore {
  const pattern = POPEN_PATTERNS[kind];
  const pops: PopenPop[] = pattern.notes.map((note, i) => {
    const midi = isInScale(note, scale) ? note : snapToScale(note, scale);
    const isPo = pattern.twoNote && i === 0;
    const isPen = pattern.twoNote && i === 1;
    const base = isPo ? 0.8 : 1;
    return {
      time: i === 0 ? 0 : i * pattern.spacing + jitter(rng, 0.005),
      midi,
      hz: midiToHz(midi) * (1 + jitter(rng, 0.002)),
      gain: pattern.gain * base * pattern.fade ** i * 10 ** (jitter(rng, 1) / 20),
      bright: isPen ? 0.5 : isPo ? 0.25 : 0.35,
      t60: (isPen ? 0.28 : isPo ? 0.12 : 0.08) * (1 + jitter(rng, 0.1)),
      glide: isPo ? 0.06 : 0.035,
    };
  });
  const duration = Math.max(...pops.map((p) => p.time + ATTACK + p.t60));
  return { kind, pops, duration };
}

/** Render the score into `destination` starting at `when`. Returns the end time. */
export function schedulePopen(
  ctx: BaseAudioContext,
  destination: AudioNode,
  score: PopenScore,
  when: number,
): number {
  const out = ctx.createGain();
  out.connect(destination);
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
  }
  // Free the voice once the longest-ringing partial has stopped.
  if (last) last.onended = () => out.disconnect();
  return when + score.duration;
}
