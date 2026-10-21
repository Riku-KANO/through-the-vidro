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
 * - requireResponse (S-08): lowering the resolution must lower the GPU time. Three steps down in a row that do not
 *   lower it by a tenth mean the cost does not follow the pixel count (for example the GPU clocks down as the load
 *   drops, or the frame is bound by work that does not scale with pixels); the controller then flags itself
 *   `unresponsive` and stops, and the governor goes back to the preset scale. The yardstick is the median of the
 *   last 5 samples right before each step, not the EMA: after the cooldown the window holds samples at the current
 *   scale only, while the EMA still lags behind a load that rose mid-session (S-08 review round 2).
 * - resumeWatch (S-11): a stopped controller is not dead for the session. `ResumeWatch` follows the GPU time at the
 *   preset scale and tells when it rose RESUME_RISE above the level the controller stopped at and stayed there for
 *   RESUME_HOLD_SEC, in both the recent median and the smoothed value. That is a new load, so the governor starts a
 *   fresh controller, which judges the response again. Under vsync a light load's span swings (S-08: 3.6–6.7 ms
 *   that did not follow the resolution) and a hitch lasts a moment; neither holds a 30% rise for 2 s.
 *   The level it stopped at is the smoothed GPU time (EMA) at the stop, lowered once to the median of the first
 *   RESUME_BASELINE_SAMPLES samples after it if that is lower. On hardware (S-11) both single readings misled: the
 *   recent median caught a peak (7.15 ms on a 6.2–6.8 ms load), and the EMA of a stop 5 s after loading still carried
 *   the start-up (6.8–7.0 ms on a ~5 ms load); either put the threshold on the grown load itself. Taking the lower
 *   of the two never raises the bar, so a new load right after the stop is still seen against the EMA. If the EMA
 *   lags behind a load that rose just before the stop, the watch may resume once too early; the fresh controller
 *   then stops again with a baseline taken at the new level.
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
const RESPONSE_STEPS = 3;
const RESPONSE_MIN = 0.1;
/** Steps down further apart than this (or a step up in between) start a new run. */
const RESPONSE_GAP_SEC = 2.5;
/** resumeWatch: a new load is this much above the level the controller stopped at (発案者の判断, S-11). */
const RESUME_RISE = 1.3;
/**
 * ...for this long, in the recent median and the smoothed value. Chosen equal to UP_DELAY_SEC (a level has to hold
 * as long to raise the scale): in simulation it rejects 1 s bursts of any height and swings of the S-08 light load
 * with a period up to 8 s, and resumes 2.2–3.8 s after a load 1.55× or more above the light one (S-11.md).
 */
const RESUME_HOLD_SEC = 2;
/** resumeWatch: samples right after the stop that measure the level at the preset scale (~2 s at 60 fps). */
const RESUME_BASELINE_SAMPLES = 15;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The last few samples, with an allocation-free median (insertion sort on ≤ MEDIAN_WINDOW values). */
class MedianWindow {
  private readonly values: Float64Array;
  private readonly scratch: Float64Array;
  private len = 0;
  private idx = 0;
  constructor(size: number) {
    this.values = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }
  get full(): boolean {
    return this.len === this.values.length;
  }
  push(v: number): void {
    this.values[this.idx] = v;
    this.idx = (this.idx + 1) % this.values.length;
    this.len = Math.min(this.len + 1, this.values.length);
  }
  median(): number {
    const n = this.len;
    for (let i = 0; i < n; i++) this.scratch[i] = this.values[i] ?? 0;
    for (let i = 1; i < n; i++) {
      const v = this.scratch[i] ?? 0;
      let j = i - 1;
      while (j >= 0 && (this.scratch[j] ?? 0) > v) {
        this.scratch[j + 1] = this.scratch[j] ?? 0;
        j--;
      }
      this.scratch[j + 1] = v;
    }
    return this.scratch[n >> 1] ?? 0;
  }
}

export class DynamicResolution {
  scale: number;
  /** requireResponse only: set once steps down stopped lowering the GPU time; the controller then does nothing. */
  unresponsive = false;
  /** requireResponse only: the smoothed GPU time (ms) when it gave up, the baseline a resumeWatch compares against. */
  stoppedAtMs: number | null = null;
  private readonly min: number;
  private readonly max: number;
  private readonly step: number;
  private readonly targetMs: number;
  private readonly cooldownSec: number;
  private readonly alpha: number;
  private readonly window = new MedianWindow(MEDIAN_WINDOW);
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

  constructor(opts: DynamicResolutionOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.step = opts.step ?? 0.05;
    this.targetMs = opts.targetMs ?? 1000 / 60;
    this.cooldownSec = opts.cooldownSec ?? 1;
    this.alpha = opts.emaAlpha ?? 0.08;
    this.requireResponse = opts.requireResponse ?? false;
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
    const median = this.window.median();
    const smoothed = Math.min(median, this.targetMs * SPIKE_CLAMP);
    this.ema = this.ema === null ? smoothed : this.ema + this.alpha * (smoothed - this.ema);

    if (this.ema > this.targetMs * DOWN) {
      this.comfortableFor = 0;
      if (this.sinceChange < this.cooldownSec || this.scale <= this.min) return null;
      if (this.requireResponse && !this.respondsToSteps(median)) {
        this.unresponsive = true;
        this.stoppedAtMs = this.ema;
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
        return this.set(Math.min(this.max, round2(this.scale + this.step)));
      }
      return null;
    }
    this.comfortableFor = 0;
    return null;
  }

  /**
   * Called right before a step down with the median of the last samples (all at the current scale, since the
   * cooldown has passed). False when the last RESPONSE_STEPS steps of this run did not lower it by RESPONSE_MIN;
   * otherwise records this step.
   */
  private respondsToSteps(median: number): boolean {
    if (this.time - this.lastDownAt > RESPONSE_GAP_SEC) this.downRun = 0;
    const slot = this.downRun % RESPONSE_STEPS;
    if (this.downRun >= RESPONSE_STEPS && median > (this.downMedian[slot] ?? 0) * (1 - RESPONSE_MIN))
      return false;
    this.downMedian[slot] = median;
    this.downRun++;
    this.lastDownAt = this.time;
    return true;
  }

  /** After `unresponsive`: a watch for a new load to resume on (S-11). Null while the controller runs. */
  resumeWatch(): ResumeWatch | null {
    if (this.stoppedAtMs === null) return null;
    return new ResumeWatch(this.stoppedAtMs, this.targetMs, this.alpha);
  }

  private set(scale: number): number {
    this.scale = scale;
    this.sinceChange = 0;
    return scale;
  }
}

/**
 * Watches a stopped controller's GPU time at the preset scale for a new load (S-11; see the header). Feed it the same
 * samples the controller would get; `update` returns true once the governor should start a fresh controller.
 */
export class ResumeWatch {
  /** The level the controller stopped at (ms); see the header for how it is taken. */
  baselineMs: number;
  /** Resume above this (ms): RESUME_RISE over the baseline, and an overload the controller would act on. */
  thresholdMs: number;
  private readonly window = new MedianWindow(MEDIAN_WINDOW);
  private readonly first = new MedianWindow(RESUME_BASELINE_SAMPLES);
  private rebased = false;
  private readonly overloadMs: number;
  private readonly clampMs: number;
  /** Starts at the baseline: the first samples nudge it instead of setting it. */
  private ema: number;
  private heldFor = 0;

  constructor(
    baselineMs: number,
    targetMs: number,
    private readonly alpha: number,
  ) {
    this.overloadMs = targetMs * DOWN;
    this.baselineMs = baselineMs;
    this.thresholdMs = Math.max(baselineMs * RESUME_RISE, this.overloadMs);
    this.clampMs = Math.max(baselineMs, targetMs) * SPIKE_CLAMP;
    this.ema = baselineMs;
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
    if (!this.rebased) {
      this.first.push(gpuMs);
      if (this.first.full) {
        this.rebased = true;
        this.baselineMs = Math.min(this.baselineMs, this.first.median());
        this.thresholdMs = Math.max(this.baselineMs * RESUME_RISE, this.overloadMs);
      }
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
}
