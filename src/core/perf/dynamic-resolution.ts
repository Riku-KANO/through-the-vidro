import { RollingWindow } from './rolling';

/**
 * Dynamic resolution (技術設計 > 品質プリセット: プレイ中も負荷に応じて描画解像度を動的に調整).
 * Pure controller driven by GPU time: feed one sample at a time, apply the returned scale when it changes.
 *
 * - A median of the last 5 samples, then an EMA: one or two hitches never move the resolution.
 * - Down above 80% of the frame (the headroom quality selection uses), up below 60%: the band is wider than
 *   the cost of one step (≤ ×1.21), so a fitting scale is not left again.
 * - A cooldown between changes (also the start-up warm-up), because every change reallocates render targets.
 * - Raising right before having to lower again doubles the wait before the next raise; a calm period resets it.
 *
 * - requireResponse (S-08, S-13): lowering the resolution must lower the GPU time. Before each step down after the
 *   third of a run, a verdict compares the median of the last 5 samples with the one taken before the step
 *   RESPONSE_STEPS back (all at one scale, since the cooldown has passed; the EMA would lag behind a load that rose
 *   mid-session, S-08 review round 2): a fall by less than RESPONSE_MIN is a miss. RESPONSE_MISSES misses in a row
 *   mean the cost does not follow the pixel count (the GPU clocks down as the load drops, or the frame is bound by
 *   work that does not scale with pixels); the controller flags itself `unresponsive` and stops, and the governor
 *   goes back to the preset scale. One miss is not enough (S-13): a verdict rests on two medians of 0.67 s each,
 *   and under vsync the span swings for a second or more, so in simulation a single swing stopped a load that does
 *   follow the pixels in 43% of 30 s runs (scripts/sim/dynres-noise.mjs, process/slices/S-13.md).
 *   At the floor there is no next step, so the controller judges once there: whether the run as a whole, from its
 *   first step down to the floor, lowered the median by RESPONSE_MIN per RESPONSE_STEPS steps. The whole run, not
 *   its last steps, because stopping gives up the whole run (back to the preset scale), and a cost with a fixed part
 *   falls less at the bottom of the range than at the top.
 * - resumeWatch (S-11, S-13): a stopped controller is not dead for the session. `ResumeWatch` follows the GPU time at
 *   the preset scale and tells when it rose above the level the controller stopped at, by RESUME_RISE and by the
 *   swing seen around the stop, and stayed there for RESUME_HOLD_SEC in both the recent median and the smoothed
 *   value. That is a new load, so the governor starts a fresh controller, which judges the response again.
 *   The level it stopped at is the middle of three estimates, each misled by something else: the smoothed GPU time
 *   at the stop (it still carries the start-up after a stop 5 s into a scene, S-11), the median of the last samples
 *   at the stop (it catches the peak of a swing, S-11), and the median of the first RESUME_BASELINE_SAMPLES samples
 *   after it (it takes in a new load that arrives right after the stop). S-11 took the lower of the first and the
 *   last; under a swinging load that sat low and resumed on the swing (S-13). The swing is the 90th percentile over
 *   the median of RESUME_BASELINE_SAMPLES samples (read off their upper quartile, so that single spikes do not count,
 *   see swingOf), right before the stop and right after it, whichever is lower: a new load inside the window after
 *   the stop inflates that one, a load that did follow the steps down (a wrong stop) inflates the one before.
 *
 * Frame time is deliberately not supported: under vsync it cannot tell a frame-rate cap from overload and hides
 * moderate overload completely (S-05 review). Without trustworthy GPU time the governor keeps the preset scale.
 */
export interface DynamicResolutionOptions {
  min: number;
  max: number;
  step?: number;
  targetMs?: number;
  cooldownSec?: number;
  emaAlpha?: number;
  /** Stop when steps down do not lower the GPU time (see above). Off by default. */
  requireResponse?: boolean;
}

const DOWN = 0.8;
const UP = 0.6;
const UP_DELAY_SEC = 2;
const SPIKE_CLAMP = 4;
const MEDIAN_WINDOW = 5;
/** A down this soon after an up means the up was premature. */
const PREMATURE_UP_SEC = 3;
const MAX_UP_BACKOFF = 32;
/** This long without a change resets the backoff, so one heavy room does not slow later reactions. */
const CALM_RESET_SEC = 30;
/** requireResponse: the recent median must fall by RESPONSE_MIN over RESPONSE_STEPS steps down in a row. */
export const RESPONSE_STEPS = 3;
export const RESPONSE_MIN = 0.1;
/** requireResponse: verdicts in a row without that fall before it stops (S-13; the floor judges once, see above). */
export const RESPONSE_MISSES = 2;
/** Steps down further apart than this (or a step up in between) start a new run. */
const RESPONSE_GAP_SEC = 2.5;
/** resumeWatch: a new load is this much above the level the controller stopped at (発案者の判断, S-11). */
export const RESUME_RISE = 1.3;
/**
 * resumeWatch: ...and above the swing seen around the stop (S-13): the threshold is at least the 90th percentile of
 * the samples there (see swingOf) times this. The acceptance criteria gave 1.1 as the example; review round 1 of S-13
 * took 1.0: on top of a rise of 30%, a further 10% held back loads only 1.35–1.6× heavier at the real target, while
 * the wrong resumes it prevented were few (scripts/sim, 1.1 → 1.0: 1.45× with spikes resumed 156 → 165 of 188, 1.6×
 * with spikes 172 → 181; wrong resumes grew by 1–7 per case, from 15 → 16 of 144 at target 6 ms, σ 0.2, to 38 → 45 of
 * 117 at the real target, σ 0.3, τ 3 s; the whole table is in process/slices/S-13.md).
 */
export const RESUME_SWING_MARGIN = 1.0;
/** The 90th and 75th percentiles of the standard normal distribution (swingOf). */
const Z90 = 1.2816;
const Z75 = 0.6745;
/**
 * ...for this long, in the recent median and the smoothed value. Chosen equal to UP_DELAY_SEC (a level has to hold
 * as long to raise the scale): in simulation it rejects 1 s bursts of any height and swings of the S-08 light load
 * with a period up to 8 s, and resumes 2.2–3.8 s after a load 1.55× or more above the light one (S-11.md).
 */
const RESUME_HOLD_SEC = 2;
/** resumeWatch: samples right before and right after the stop that measure its level and swing (~2 s at 60 fps). */
const RESUME_BASELINE_SAMPLES = 15;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** What a controller saw when it stopped, for the watch that may resume it. */
export interface StopLevel {
  /** Smoothed GPU time (EMA) at the stop. */
  smoothedMs: number;
  /** Median of the last MEDIAN_WINDOW samples at the stop. */
  medianMs: number;
  /** The swing (swingOf) of the last RESUME_BASELINE_SAMPLES samples before the stop. */
  swing: number;
}

export class DynamicResolution {
  scale: number;
  /** requireResponse only: set once steps down stopped lowering the GPU time; the controller then does nothing. */
  unresponsive = false;
  /** requireResponse only: the smoothed GPU time (ms) when it gave up. */
  stoppedAtMs: number | null = null;
  /** requireResponse only: it gave up on the verdict at the floor (see the header). */
  stoppedAtFloor = false;
  /**
   * requireResponse only: some verdict found the GPU time following the resolution. The governor counts a resume
   * whose controller stopped again without one as wasted (S-13).
   */
  responded = false;
  private readonly min: number;
  private readonly max: number;
  private readonly step: number;
  private readonly targetMs: number;
  private readonly cooldownSec: number;
  private readonly alpha: number;
  private readonly window = new RollingWindow(MEDIAN_WINDOW);
  private ema: number | null = null;
  private time = 0;
  private sinceChange = 0;
  private comfortableFor = 0;
  private upBackoff = 1;
  private lastUpAt = Number.NEGATIVE_INFINITY;
  private readonly requireResponse: boolean;
  /** Median of the last samples at each of the last RESPONSE_STEPS steps down of the current run (ring buffer). */
  private readonly downMedian = new Float64Array(RESPONSE_STEPS);
  private downRun = 0;
  private lastDownAt = Number.NEGATIVE_INFINITY;
  /** Median right before the first step down of the current run, for the verdict at the floor. */
  private runStartMedian = 0;
  /** Verdicts in a row without a response. */
  private misses = 0;
  /** The verdict at the floor was made since the scale last changed. */
  private floorJudged = false;
  /** requireResponse only: the last raw samples, for the swing a resume watch has to clear. */
  private readonly recent: RollingWindow | null;
  private stopLevel: StopLevel | null = null;

  constructor(opts: DynamicResolutionOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.step = opts.step ?? 0.05;
    this.targetMs = opts.targetMs ?? 1000 / 60;
    this.cooldownSec = opts.cooldownSec ?? 1;
    this.alpha = opts.emaAlpha ?? 0.08;
    this.requireResponse = opts.requireResponse ?? false;
    this.recent = this.requireResponse ? new RollingWindow(RESUME_BASELINE_SAMPLES) : null;
    this.scale = opts.max;
  }

  /** Smoothed GPU time in ms, for display. */
  get smoothedMs(): number {
    return this.ema ?? 0;
  }

  /**
   * @param gpuMs GPU time of the latest sample.
   * @param dt seconds since the previous call.
   * @returns the new scale when it changed, otherwise null.
   */
  update(gpuMs: number, dt: number): number | null {
    if (this.unresponsive || !Number.isFinite(gpuMs) || gpuMs <= 0) return null;
    this.time += dt;
    this.sinceChange += dt;
    if (this.sinceChange >= CALM_RESET_SEC) this.upBackoff = 1;

    // Raw samples in the window, the clamp on what feeds the EMA: the same EMA as clamping each sample (the median
    // commutes with min), while the response check still sees an overload above the clamp go down.
    this.window.push(gpuMs);
    this.recent?.push(gpuMs);
    const median = this.window.median();
    const smoothed = Math.min(median, this.targetMs * SPIKE_CLAMP);
    this.ema = this.ema === null ? smoothed : this.ema + this.alpha * (smoothed - this.ema);

    if (this.ema > this.targetMs * DOWN) {
      this.comfortableFor = 0;
      if (this.sinceChange < this.cooldownSec) return null;
      if (this.scale <= this.min) {
        if (this.requireResponse && !this.floorJudged) {
          this.floorJudged = true;
          if (this.missedAtFloor(median)) {
            this.stoppedAtFloor = true;
            this.giveUp(median);
          }
        }
        return null;
      }
      if (this.requireResponse && !this.respondsToSteps(median)) {
        this.giveUp(median);
        return null;
      }
      if (this.time - this.lastUpAt < PREMATURE_UP_SEC) {
        this.upBackoff = Math.min(this.upBackoff * 2, MAX_UP_BACKOFF);
      }
      return this.set(Math.max(this.min, round2(this.scale - this.step)));
    }
    if (this.ema < this.targetMs * UP) {
      this.comfortableFor += dt;
      if (
        this.comfortableFor >= UP_DELAY_SEC * this.upBackoff &&
        this.sinceChange >= this.cooldownSec &&
        this.scale < this.max
      ) {
        this.comfortableFor = 0;
        this.lastUpAt = this.time;
        this.downRun = 0;
        this.misses = 0;
        return this.set(Math.min(this.max, round2(this.scale + this.step)));
      }
      return null;
    }
    this.comfortableFor = 0;
    return null;
  }

  /** After `unresponsive`: a watch for a new load to resume on (S-11). Null while the controller runs. */
  resumeWatch(): ResumeWatch | null {
    return this.stopLevel ? new ResumeWatch(this.stopLevel, this.targetMs, this.alpha) : null;
  }

  /** Starts a new run when the last step down is too long ago. */
  private continueRun(): void {
    if (this.time - this.lastDownAt > RESPONSE_GAP_SEC) {
      this.downRun = 0;
      this.misses = 0;
    }
  }

  /**
   * Called right before a step down with the median of the last samples (all at the current scale, since the
   * cooldown has passed). False once RESPONSE_MISSES verdicts in a row found no response; otherwise records this step.
   */
  private respondsToSteps(median: number): boolean {
    this.continueRun();
    if (this.downRun >= RESPONSE_STEPS) {
      const before = this.downMedian[this.downRun % RESPONSE_STEPS] ?? 0;
      if (!this.verdict(median > before * (1 - RESPONSE_MIN))) return false;
    }
    if (this.downRun === 0) this.runStartMedian = median;
    this.downMedian[this.downRun % RESPONSE_STEPS] = median;
    this.downRun++;
    this.lastDownAt = this.time;
    return true;
  }

  /** The verdict at the floor, on the whole run that led there (see the header). True when it found no response. */
  private missedAtFloor(median: number): boolean {
    this.continueRun();
    if (this.downRun < RESPONSE_STEPS) return false;
    const miss = median > this.runStartMedian * (1 - RESPONSE_MIN) ** (this.downRun / RESPONSE_STEPS);
    this.verdict(miss);
    return miss;
  }

  /** Counts a verdict; false once the misses in a row reach RESPONSE_MISSES. */
  private verdict(miss: boolean): boolean {
    if (!miss) {
      this.misses = 0;
      this.responded = true;
      return true;
    }
    return ++this.misses < RESPONSE_MISSES;
  }

  private giveUp(median: number): void {
    this.unresponsive = true;
    this.stoppedAtMs = this.ema;
    const recent = this.recent;
    this.stopLevel = {
      smoothedMs: this.ema ?? median,
      medianMs: median,
      swing: recent ? swingOf(recent) : 1,
    };
  }

  private set(scale: number): number {
    this.scale = scale;
    this.sinceChange = 0;
    this.floorJudged = false;
    return scale;
  }
}

/**
 * Watches a stopped controller's GPU time at the preset scale for a new load (S-11, S-13; see the header). Feed it
 * the same samples the controller would get; `update` returns true once the governor should start a fresh controller.
 */
export class ResumeWatch {
  /** The level the controller stopped at (ms): its smoothed GPU time until the samples after the stop are in. */
  baselineMs: number;
  /** Resume above this (ms): RESUME_RISE and the swing over the baseline, and an overload the controller acts on. */
  thresholdMs: number;
  private readonly stop: StopLevel;
  private readonly window = new RollingWindow(MEDIAN_WINDOW);
  private readonly after = new RollingWindow(RESUME_BASELINE_SAMPLES);
  private settled = false;
  private readonly overloadMs: number;
  private readonly clampMs: number;
  private readonly alpha: number;
  /** Starts at the baseline: the first samples nudge it instead of setting it. */
  private ema: number;
  private heldFor = 0;

  constructor(stop: StopLevel, targetMs: number, alpha: number) {
    this.stop = stop;
    this.alpha = alpha;
    this.overloadMs = targetMs * DOWN;
    this.baselineMs = stop.smoothedMs;
    this.thresholdMs = Math.max(this.baselineMs * RESUME_RISE, this.overloadMs);
    this.clampMs = Math.max(this.baselineMs, targetMs) * SPIKE_CLAMP;
    this.ema = this.baselineMs;
  }

  /** Smoothed GPU time since the stop (ms). */
  get smoothedMs(): number {
    return this.ema;
  }

  /**
   * @param gpuMs GPU time of the latest sample.
   * @param dt seconds since the previous call.
   * @returns true once the rise has held for RESUME_HOLD_SEC.
   */
  update(gpuMs: number, dt: number): boolean {
    if (!Number.isFinite(gpuMs) || gpuMs <= 0) return false;
    if (!this.settled) {
      this.after.push(gpuMs);
      if (this.after.full) this.settle();
    }
    this.window.push(gpuMs);
    // Judge on full windows only: a median of one or two samples is a spike.
    if (!this.window.full) return false;
    const median = this.window.median();
    this.ema += this.alpha * (Math.min(median, this.clampMs) - this.ema);
    if (median < this.thresholdMs || this.ema < this.thresholdMs) {
      this.heldFor = 0;
      return false;
    }
    this.heldFor += dt;
    return this.heldFor >= RESUME_HOLD_SEC;
  }

  /** The samples after the stop are in: the final baseline and threshold (see the header of this file). */
  private settle(): void {
    this.settled = true;
    const afterMedian = this.after.median();
    this.baselineMs = middle(this.stop.smoothedMs, this.stop.medianMs, afterMedian);
    const swing = Math.min(this.stop.swing, swingOf(this.after));
    this.thresholdMs = Math.max(
      this.baselineMs * RESUME_RISE,
      this.baselineMs * swing * RESUME_SWING_MARGIN,
      this.overloadMs,
    );
  }
}

/**
 * The swing of a window: its 90th percentile over its median, read off the upper quartile as a log-normal swing would
 * have it ((p75 / median) ^ (z90 / z75)). On hardware single samples spike to 3–10× (S-13 closed loop), and two such
 * samples among 15 are the 90th percentile itself; they move the quartile only once a quarter of the window spikes.
 * The watch judges on the median of 5 samples, which ignores single spikes too. Never more than the 90th percentile
 * the window actually has: a swing between two levels (a GPU switching clocks) has a high quartile and nothing above
 * it, which the log-normal reading would stretch.
 */
function swingOf(w: RollingWindow): number {
  const median = w.median();
  return Math.min((w.quantile(0.75) / median) ** (Z90 / Z75), w.quantile(0.9) / median);
}

/** The middle one of three values. */
function middle(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}
