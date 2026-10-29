import { describe, expect, it } from 'vitest';
import {
  CALM_FADE_SECONDS,
  FadeCourse,
  FlashGate,
  fadeArrived,
  fadeSecondsFor,
  fadeStep,
  fadeWhite,
  gatedStep,
  MIN_PEAK_GAP,
  SIMPLE_FADE_SECONDS,
  simpleSpeed,
} from './fade';

describe('S-45 簡易トランジション (遷移のルール 1: 0.3秒の白いフェードに置き換えられる)', () => {
  it('lasts 0.3 s', () => {
    expect(SIMPLE_FADE_SECONDS).toBe(0.3);
  });

  it('goes up to white at its middle and down again: never darker than where it started (黒い画面を使わない)', () => {
    expect(fadeWhite(0)).toBe(0);
    expect(fadeWhite(0.25)).toBeCloseTo(0.5, 12);
    expect(fadeWhite(0.5)).toBe(1);
    expect(fadeWhite(0.75)).toBeCloseTo(0.5, 12);
    expect(fadeWhite(1)).toBe(0);
    for (let u = 0; u <= 1; u += 0.01) {
      expect(fadeWhite(u)).toBeGreaterThanOrEqual(0);
      expect(fadeWhite(u)).toBeLessThanOrEqual(1);
    }
    expect(fadeWhite(-1)).toBe(0);
    expect(fadeWhite(2)).toBe(0);
    expect(fadeWhite(Number.NaN)).toBe(0);
  });

  it('shows where it came from until the middle, where it goes from there (the swap is hidden under the white)', () => {
    expect(fadeArrived(0)).toBe(false);
    expect(fadeArrived(0.49)).toBe(false);
    expect(fadeArrived(0.5)).toBe(true);
    expect(fadeArrived(1)).toBe(true);
    // played back, the full white still hides the cut: at the middle it is already where it came from
    expect(fadeArrived(0.5, false)).toBe(false);
    expect(fadeArrived(0.51, false)).toBe(true);
  });

  it('a step over the middle lands on it: the screen is all white for at least a frame, both ways', () => {
    expect(fadeStep(0.4, 0.2)).toBe(0.5);
    expect(fadeStep(0.5, 0.2)).toBeCloseTo(0.7, 12);
    expect(fadeStep(0.6, -0.2)).toBe(0.5);
    expect(fadeStep(0.5, -0.2)).toBeCloseTo(0.3, 12);
    expect(fadeStep(0.9, 0.2)).toBe(1);
    expect(fadeStep(0.1, -0.2)).toBe(0);
    // at 60 Hz the fade has a full white frame
    let u = 0;
    let white = 0;
    for (let i = 0; i < 30 && u < 1; i++) {
      u = fadeStep(u, 1 / 60 / SIMPLE_FADE_SECONDS);
      white = Math.max(white, fadeWhite(u));
    }
    expect(white).toBe(1);
  });

  it('a longer transition runs that much faster to last the fade (the dive’s 2 s, the opening’s 1.5 s)', () => {
    expect(simpleSpeed(2)).toBeCloseTo(2 / 0.3, 12);
    expect(simpleSpeed(1.5) * SIMPLE_FADE_SECONDS).toBeCloseTo(1.5, 12);
    expect(simpleSpeed(0)).toBe(1);
    expect(simpleSpeed(2, CALM_FADE_SECONDS)).toBeCloseTo(2 / 0.5, 12);
  });
});

/** A fade on the screen, as the pause, the panel and the screens' transitions move theirs (u 0..1, which way, or at rest). */
interface Source {
  u: number;
  dir: -1 | 0 | 1;
  course: FadeCourse;
}

/** Seeded random numbers (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plays `sources` fades for `seconds` with keys pressed at the given rhythm (each press: a source at rest starts its next fade,
 * a moving one is played back — Esc), frames of random length. Returns the times the screen (the whitest of the fades) came to
 * full white from below (`peaks`), and the times its white topped at all — went from rising to falling, at any height (`tops`:
 * every flash).
 */
function play(opts: {
  seed: number;
  sources: number;
  seconds: number;
  gap: () => number;
  calm: boolean;
  /** Each fade keeps its course (default): the gate sees it turn back. */
  turns?: boolean;
}): {
  peaks: number[];
  tops: number[];
} {
  const r = rng(opts.seed);
  const gate = new FlashGate();
  gate.enabled = opts.calm;
  const fade = fadeSecondsFor(opts.calm);
  const sources: Source[] = Array.from({ length: opts.sources }, () => ({
    u: 0,
    dir: 0,
    course: new FadeCourse(),
  }));
  const peaks: number[] = [];
  const tops: number[] = [];
  let t = 0;
  let nextPress = opts.gap();
  let wasFull = false;
  let was = 0;
  let wasAt = 0;
  let rising = false;
  while (t < opts.seconds) {
    const dt = 1 / 144 + r() * (1 / 30 - 1 / 144);
    t += dt;
    gate.tick(dt);
    while (nextPress <= t) {
      const s = sources[Math.floor(r() * sources.length)] as Source;
      if (s.dir === 0) s.dir = s.u >= 1 ? -1 : 1;
      else s.dir = s.dir === 1 ? -1 : 1;
      nextPress += opts.gap();
    }
    for (const s of sources) {
      if (s.dir === 0) continue;
      s.u = gatedStep(s.u, (s.dir * dt) / fade, gate, opts.turns === false ? undefined : s.course);
      if ((s.dir === 1 && s.u >= 1) || (s.dir === -1 && s.u <= 0)) s.dir = 0;
    }
    const white = Math.max(...sources.map((s) => fadeWhite(s.u)));
    const full = white >= 0.999;
    if (full && !wasFull) peaks.push(t);
    wasFull = full;
    if (white < was - 1e-9 && rising) tops.push(wasAt);
    if (white !== was) rising = white > was;
    was = white;
    wasAt = t;
  }
  return { peaks, tops };
}

/** The most of these times in any one second. */
function mostInASecond(peaks: number[]): number {
  let most = 0;
  for (let i = 0; i < peaks.length; i++) {
    let n = 0;
    for (let j = i; j < peaks.length && (peaks[j] as number) < (peaks[i] as number) + 1; j++) n++;
    most = Math.max(most, n);
  }
  return most;
}

describe('S-45 簡易トランジション with 点滅を抑える (発案者の判断 2026-10-29: 1 秒に 3 回を超えて全面が白くならない)', () => {
  it('the fade takes 0.5 s, its full white at its middle', () => {
    expect(fadeSecondsFor(false)).toBe(SIMPLE_FADE_SECONDS);
    expect(fadeSecondsFor(true)).toBe(CALM_FADE_SECONDS);
    expect(CALM_FADE_SECONDS).toBe(0.5);
    const gate = new FlashGate();
    gate.enabled = true;
    let u = 0;
    let t = 0;
    let peakAt = Number.NaN;
    while (u < 1 && t < 2) {
      gate.tick(1 / 60);
      t += 1 / 60;
      u = gatedStep(u, 1 / 60 / CALM_FADE_SECONDS, gate);
      if (u === 0.5 && Number.isNaN(peakAt)) peakAt = t;
    }
    expect(t).toBeGreaterThan(0.49);
    expect(t).toBeLessThan(0.55);
    expect(peakAt).toBeGreaterThan(0.23);
    expect(peakAt).toBeLessThan(0.28);
  });

  it('a fade that may not be full white yet waits near white, short of its middle (the cut stays under the white)', () => {
    const gate = new FlashGate();
    gate.enabled = true;
    gate.peak();
    gate.tick(0.1);
    expect(gate.allows).toBe(false);
    // coming up from below and coming back down from above: both wait short of the middle
    expect(gatedStep(0.44, 0.1, gate)).toBe(0.45);
    expect(gatedStep(0.58, -0.1, gate)).toBe(0.55);
    expect(fadeWhite(0.45)).toBeGreaterThan(0.85);
    expect(fadeArrived(0.45)).toBe(false);
    expect(fadeArrived(0.55)).toBe(true);
    // the gate lets it through MIN_PEAK_GAP after the last full white
    gate.tick(MIN_PEAK_GAP);
    expect(gatedStep(0.45, 0.1, gate)).toBe(0.5);
    // without 点滅を抑える, nothing waits
    const open = new FlashGate();
    open.peak();
    expect(gatedStep(0.44, 0.1, open)).toBe(0.5);
  });

  it('two fades meeting at their middles in one frame (the pause leaving as the dive plays back) are one full white', () => {
    const gate = new FlashGate();
    gate.enabled = true;
    expect(gatedStep(0.45, 0.1, gate)).toBe(0.5);
    expect(gatedStep(0.45, 0.1, gate)).toBe(0.5);
    // a frame later, another waits
    gate.tick(1 / 60);
    expect(gatedStep(0.45, 0.1, gate)).toBe(0.45);
  });

  it('a fade played back while its white rises (Esc pressed during it) turns at a top: it stands there until the gate lets it', () => {
    const gate = new FlashGate();
    gate.enabled = true;
    const course = new FadeCourse();
    // rising, then played back: the turn is a top, and the gate has had none — it turns, and the gate counts it
    let u = gatedStep(0, 0.1, gate, course);
    expect(course.rising).toBe(true);
    u = gatedStep(u, -0.05, gate, course);
    expect(u).toBeCloseTo(0.05, 12);
    gate.tick(0.05);
    expect(gate.allows).toBe(false);
    // rising again at once (a bottom is no flash), then played back again before MIN_PEAK_GAP: it stands where it is
    u = gatedStep(u, 0.1, gate, course);
    expect(u).toBeCloseTo(0.15, 12);
    gate.tick(0.05);
    expect(gatedStep(u, -0.05, gate, course)).toBe(u);
    expect(gatedStep(u, -0.05, gate, course)).toBe(u);
    // until the gate opens
    gate.tick(MIN_PEAK_GAP);
    expect(gatedStep(u, -0.05, gate, course)).toBeCloseTo(0.1, 12);
    // coming back down from its full white is no turn (the full white was the top)
    const down = new FadeCourse();
    const g2 = new FlashGate();
    g2.enabled = true;
    expect(gatedStep(0.45, 0.1, g2, down)).toBe(0.5);
    expect(down.rising).toBe(false);
    g2.tick(0.05);
    expect(gatedStep(0.5, -0.1, g2, down)).toBeCloseTo(0.4, 12);
  });

  it('under any rhythm of keys, the screen never flashes white more than 3 times in a second (and it does go white)', () => {
    const rhythms: [string, (r: () => number) => () => number][] = [
      ['mashed every 30 ms', () => () => 0.03],
      ['every 60 ms', () => () => 0.06],
      ['every 130 ms', () => () => 0.13],
      ['every 260 ms', () => () => 0.26],
      ['every 350 ms', () => () => 0.35],
      ['random 10–400 ms', (r) => () => 0.01 + r() * 0.39],
      ['bursts', (r) => () => (r() < 0.7 ? 0.02 + r() * 0.05 : 0.3 + r() * 0.5)],
    ];
    for (const [name, rhythm] of rhythms)
      for (const sources of [1, 2, 3])
        for (let seed = 1; seed <= 12; seed++) {
          const r = rng(seed * 7919 + sources);
          const { peaks, tops } = play({ seed, sources, seconds: 12, gap: rhythm(r), calm: true });
          const where = `${name}, ${sources} fades, seed ${seed}`;
          // every top of the white (a full white, or a fade turned back below it) is a flash
          expect(mostInASecond(tops), where).toBeLessThanOrEqual(3);
          expect(mostInASecond(peaks), where).toBeLessThanOrEqual(3);
          if (name === 'every 260 ms' || name === 'every 350 ms')
            expect(peaks.length, `${where}: it goes white`).toBeGreaterThan(5);
        }
  });

  it('(without 点滅を抑える the short fade can flash more often: the gate is what holds it)', () => {
    expect(
      mostInASecond(play({ seed: 3, sources: 1, seconds: 6, gap: () => 0.13, calm: false }).peaks),
    ).toBeGreaterThan(3);
    // Esc mashed: the white goes up and back many times a second, never full
    const mashed = play({ seed: 3, sources: 1, seconds: 6, gap: () => 0.05, calm: false });
    expect(mostInASecond(mashed.tops)).toBeGreaterThan(3);
    // (and the gate counting only the full whites would let those through: the turns are what the course is for)
    const fullOnly = play({ seed: 3, sources: 1, seconds: 6, gap: () => 0.05, calm: true, turns: false });
    expect(mostInASecond(fullOnly.tops)).toBeGreaterThan(3);
  });
});
