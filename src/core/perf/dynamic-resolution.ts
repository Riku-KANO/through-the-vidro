/**
 * Dynamic resolution (技術設計 > 品質プリセット: プレイ中も負荷に応じて描画解像度を動的に調整).
 * Pure controller: feed one cost sample at a time, apply the returned scale when it changes.
 *
 * - A median of the last 5 samples, then an EMA: one or two hitches never move the resolution.
 * - Separate down/up thresholds (hysteresis), a cooldown that also serves as start-up warm-up,
 *   because every change reallocates render targets.
 * - GPU time is the preferred basis. Frame time is vsync-capped and cannot tell a frame-rate cap
 *   (30 fps power saving, 50 Hz panels) from overload, so on that basis a step down is checked:
 *   if it did not help, it is reverted and further step-downs are held off.
 * - Raising right before having to lower again doubles the wait before the next raise.
 */
export type CostBasis = 'gpu' | 'frame';

export interface DynamicResolutionOptions {
  min: number;
  max: number;
  step?: number;
  targetMs?: number;
  cooldownSec?: number;
  emaAlpha?: number;
}

const THRESHOLDS: Record<CostBasis, { down: number; up: number; upDelaySec: number; spikeClamp: number }> = {
  // down = the 80% headroom used by quality selection; the 0.6–0.8 band is wider than one step's cost (≤ ×1.21).
  gpu: { down: 0.8, up: 0.6, upDelaySec: 2, spikeClamp: 4 },
  frame: { down: 1.15, up: 1.03, upDelaySec: 5, spikeClamp: 2 },
};
const MEDIAN_WINDOW = 5;
/** Time after a frame-basis step down before judging whether it helped. */
const EVALUATE_SEC = 2;
/** A step down must improve the smoothed frame time by at least this much to count as effective. */
const MIN_IMPROVEMENT = 0.05;
const HOLD_SEC = 30;
const MAX_HOLD_SEC = 300;
/** A down this soon after an up means the up was premature. */
const PREMATURE_UP_SEC = 3;
const MAX_UP_BACKOFF = 16;

const round2 = (v: number) => Math.round(v * 100) / 100;

export class DynamicResolution {
  scale: number;
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
  private basis: CostBasis | null = null;
  private ema: number | null = null;
  private time = 0;
  private sinceChange = 0;
  private comfortableFor = 0;
  private upBackoff = 1;
  private holdDownUntil = 0;
  private holdSec = HOLD_SEC;
  private lastChange: { dir: 'up' | 'down'; at: number; emaBefore: number } | null = null;

  constructor(opts: DynamicResolutionOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.step = opts.step ?? 0.05;
    this.targetMs = opts.targetMs ?? 1000 / 60;
    this.cooldownSec = opts.cooldownSec ?? 1;
    this.alpha = opts.emaAlpha ?? 0.08;
    this.scale = opts.max;
  }

  /** Smoothed cost in ms, for display. */
  get smoothedMs(): number {
    return this.ema ?? 0;
  }

  /**
   * @param costMs GPU time (basis 'gpu') or frame time (basis 'frame') of the latest sample.
   * @param dt seconds since the previous call.
   * @returns the new scale when it changed, otherwise null.
   */
  update(costMs: number, basis: CostBasis, dt: number): number | null {
    if (!Number.isFinite(costMs) || costMs <= 0) return null;
    const t = THRESHOLDS[basis];
    this.time += dt;
    this.sinceChange += dt;
    if (basis !== this.basis) this.resetSmoothing(basis);

    this.push(Math.min(costMs, this.targetMs * t.spikeClamp));
    const median = this.median();
    this.ema = this.ema === null ? median : this.ema + this.alpha * (median - this.ema);

    if (
      basis === 'frame' &&
      this.lastChange?.dir === 'down' &&
      this.time - this.lastChange.at >= EVALUATE_SEC
    ) {
      const helped = this.ema < this.lastChange.emaBefore * (1 - MIN_IMPROVEMENT);
      this.lastChange = null;
      if (!helped) {
        this.holdDownUntil = this.time + this.holdSec;
        this.holdSec = Math.min(this.holdSec * 2, MAX_HOLD_SEC);
        return this.set(Math.min(this.max, round2(this.scale + this.step)), null);
      }
    }

    if (this.ema > this.targetMs * t.down) {
      this.comfortableFor = 0;
      // On frame time, wait for the previous step down to be judged before stepping again.
      if (basis === 'frame' && (this.time < this.holdDownUntil || this.lastChange?.dir === 'down'))
        return null;
      if (this.sinceChange < this.cooldownSec || this.scale <= this.min) return null;
      if (this.lastChange?.dir === 'up' && this.time - this.lastChange.at < PREMATURE_UP_SEC) {
        this.upBackoff = Math.min(this.upBackoff * 2, MAX_UP_BACKOFF);
      }
      return this.set(Math.max(this.min, round2(this.scale - this.step)), 'down');
    }
    if (this.ema < this.targetMs * t.up) {
      this.comfortableFor += dt;
      if (
        this.comfortableFor >= t.upDelaySec * this.upBackoff &&
        this.sinceChange >= this.cooldownSec &&
        this.scale < this.max
      ) {
        this.comfortableFor = 0;
        return this.set(Math.min(this.max, round2(this.scale + this.step)), 'up');
      }
      return null;
    }
    this.comfortableFor = 0;
    return null;
  }

  private set(scale: number, dir: 'up' | 'down' | null): number {
    this.lastChange = dir ? { dir, at: this.time, emaBefore: this.ema ?? 0 } : null;
    this.scale = scale;
    this.sinceChange = 0;
    return scale;
  }

  private resetSmoothing(basis: CostBasis): void {
    this.basis = basis;
    this.ema = null;
    this.windowLen = 0;
    this.windowIdx = 0;
    this.comfortableFor = 0;
    this.lastChange = null;
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
