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
 *   lower the smoothed GPU time by a tenth mean the cost does not follow the pixel count (for example the GPU clocks
 *   down as the load drops, or the frame is bound by work that does not scale with pixels); the controller then flags
 *   itself `unresponsive` and stops, and the governor goes back to the preset scale.
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
/** requireResponse: the smoothed GPU time must fall by RESPONSE_MIN over RESPONSE_STEPS steps down in a row. */
const RESPONSE_STEPS = 3;
const RESPONSE_MIN = 0.1;
/** Steps down further apart than this (or a step up in between) start a new run. */
const RESPONSE_GAP_SEC = 2.5;

const round2 = (v: number) => Math.round(v * 100) / 100;

export class DynamicResolution {
  scale: number;
  /** requireResponse only: set once steps down stopped lowering the GPU time; the controller then does nothing. */
  unresponsive = false;
  private readonly min: number;
  private readonly max: number;
  private readonly step: number;
  private readonly targetMs: number;
  private readonly cooldownSec: number;
  private readonly alpha: number;
  private readonly window = new Float64Array(MEDIAN_WINDOW);
  private readonly scratch = new Float64Array(MEDIAN_WINDOW);
  private windowLen = 0;
  private windowIdx = 0;
  private ema: number | null = null;
  private time = 0;
  private sinceChange = 0;
  private comfortableFor = 0;
  private upBackoff = 1;
  private lastUpAt = Number.NEGATIVE_INFINITY;
  private readonly requireResponse: boolean;
  /** Smoothed GPU time at each of the last RESPONSE_STEPS steps down of the current run (ring buffer). */
  private readonly downEma = new Float64Array(RESPONSE_STEPS);
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

    this.push(Math.min(gpuMs, this.targetMs * SPIKE_CLAMP));
    const median = this.median();
    this.ema = this.ema === null ? median : this.ema + this.alpha * (median - this.ema);

    if (this.ema > this.targetMs * DOWN) {
      this.comfortableFor = 0;
      if (this.sinceChange < this.cooldownSec || this.scale <= this.min) return null;
      if (this.requireResponse && !this.respondsToSteps(this.ema)) {
        this.unresponsive = true;
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
   * Called right before a step down with the smoothed GPU time that asks for it. False when the last
   * RESPONSE_STEPS steps of this run did not lower it by RESPONSE_MIN; otherwise records this step.
   */
  private respondsToSteps(ema: number): boolean {
    if (this.time - this.lastDownAt > RESPONSE_GAP_SEC) this.downRun = 0;
    const slot = this.downRun % RESPONSE_STEPS;
    if (this.downRun >= RESPONSE_STEPS && ema > (this.downEma[slot] ?? 0) * (1 - RESPONSE_MIN)) return false;
    this.downEma[slot] = ema;
    this.downRun++;
    this.lastDownAt = this.time;
    return true;
  }

  private set(scale: number): number {
    this.scale = scale;
    this.sinceChange = 0;
    return scale;
  }

  private push(v: number): void {
    this.window[this.windowIdx] = v;
    this.windowIdx = (this.windowIdx + 1) % MEDIAN_WINDOW;
    this.windowLen = Math.min(this.windowLen + 1, MEDIAN_WINDOW);
  }

  private median(): number {
    const n = this.windowLen;
    for (let i = 0; i < n; i++) this.scratch[i] = this.window[i] ?? 0;
    // Insertion sort on ≤ 5 values: no allocation in the frame loop.
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
