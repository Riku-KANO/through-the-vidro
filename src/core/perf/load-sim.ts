import type { GovernorAction } from './governor';

/**
 * Simulated GPU loads for the performance governor (S-13). Pure and seeded: the unit tests and scripts/sim/*.mjs
 * drive the governor through the same code and reproduce the same runs. Not used by the app.
 *
 * - driveLikeApp feeds a governor the way src/main.ts does: one frame() per frame, a GPU sample requested every 8th
 *   frame while none is in flight, read back 2 frames later with the epoch of the request, the cost taken at the
 *   scale the frame was rendered at. Frame times follow vsync (`vsyncFrame`), or the coarser model of the S-11 tests
 *   (`twoIntervalFrame`, the default), where a reading above two refresh intervals looks implausible.
 * - logNormalAr1 is GPU-time noise that persists. Under vsync the measured span swings for seconds, not from one
 *   frame to the next (S-08, S-11: 2.9–16.5 ms on one heavy load), so independent noise per sample overstates what a
 *   median of a few samples can do. AR(1) in log space: z ← ρ·z + √(1 − ρ²)·σ·ε with ρ = exp(−Δt / τ), and the cost
 *   is multiplied by exp(z − σ²/2) (mean 1). σ is the spread in log units, τ how long a swing lasts.
 * - spikes adds single long frames on top, which the log-normal swing does not produce.
 */

/** One refresh interval of a 60 Hz display (ms). */
export const REFRESH_MS = 1000 / 60;
/** GPU_POLL_EVERY_FRAMES in src/main.ts. */
const POLL_EVERY_FRAMES = 8;
/** A sample requested at frame i is fed at frame i + READBACK_FRAMES (the span resolves asynchronously). */
const READBACK_FRAMES = 2;

/** Frame time under vsync: the GPU cost rounded up to whole refresh intervals. */
export const vsyncFrame = (costMs: number): number =>
  Math.max(1, Math.ceil(costMs / REFRESH_MS)) * REFRESH_MS;
/**
 * One refresh interval, or two when the cost does not fit (the model of the S-11 tests). A cost above two intervals
 * then reads above the frame time, which the governor takes as implausible: tests use that on purpose.
 */
export const twoIntervalFrame = (costMs: number): number =>
  costMs <= REFRESH_MS ? REFRESH_MS : REFRESH_MS * 2;

/** The part of PerfGovernor the driver touches. Structural, so an older governor (scripts/sim --before) fits too. */
export interface DrivenGovernor {
  readonly scale: number;
  readonly epoch: number;
  gpu(ms: number, epoch: number): void;
  frame(dtMs: number): GovernorAction | null;
}

/**
 * GPU cost (ms) of the frame about to be rendered.
 * @param scale the render scale the frame uses.
 * @param elapsedMs time since this drive started.
 * @param sinceLastMs duration of the previous frame (one refresh interval for the first), for noise that evolves
 *   in time.
 */
export type Cost = (scale: number, elapsedMs: number, sinceLastMs: number) => number;

export interface DriveOptions {
  /** Frame time (ms) for a GPU cost (default twoIntervalFrame). */
  frame?: (costMs: number) => number;
  /** Called after every frame with the elapsed time, the GPU cost of that frame and its duration. */
  onFrame?: (elapsedMs: number, costMs: number, frameMs: number) => void;
}

/**
 * Drives `g` for `seconds` like the app. Each call starts with no sample in flight and the clock at 0.
 * @returns the actions the governor returned.
 */
export function driveLikeApp(
  g: DrivenGovernor,
  seconds: number,
  cost: Cost,
  { frame = twoIntervalFrame, onFrame }: DriveOptions = {},
): GovernorAction[] {
  const actions: GovernorAction[] = [];
  let pending: { ms: number; epoch: number; at: number } | null = null;
  let elapsed = 0;
  let last = REFRESH_MS;
  for (let i = 0; elapsed < seconds * 1000; i++) {
    const c = cost(g.scale, elapsed, last);
    const ms = frame(c);
    elapsed += ms;
    last = ms;
    if (pending && i >= pending.at) {
      g.gpu(pending.ms, pending.epoch);
      pending = null;
    }
    if (!pending && i % POLL_EVERY_FRAMES === 0) pending = { ms: c, epoch: g.epoch, at: i + READBACK_FRAMES };
    const a = g.frame(ms);
    if (a) actions.push(a);
    onFrame?.(elapsed, c, ms);
  }
  return actions;
}

/** Seeded uniform generator in [0, 1) (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample from a uniform generator (Box–Muller). */
function gauss(uniform: () => number): number {
  const u = Math.max(uniform(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
}

export interface SpikeOptions {
  /** Chance that a frame spikes. */
  p: number;
  /** A spike multiplies the cost by a factor drawn uniformly from [lo, hi). */
  lo: number;
  hi: number;
  seed: number;
}

/**
 * Single frames that take several times longer, on top of the swing: the span showed them on hardware (S-13 closed
 * loop: 2–4 ms with single samples at 8–48 ms). Call once per frame; returns the factor for that frame (mostly 1).
 */
export function spikes(o: SpikeOptions): () => number {
  const uniform = mulberry32(o.seed);
  return () => (uniform() < o.p ? o.lo + (o.hi - o.lo) * uniform() : 1);
}

export interface LogNormalAr1Options {
  /** Spread in log units (0.3 ≈ ±35% for one standard deviation). */
  sigma: number;
  /** How long a swing lasts (s); 0 makes every sample independent. */
  tauSec: number;
  seed: number;
}

/** Persistent multiplicative noise with mean 1 (see the header). Call `next` once per frame. */
export function logNormalAr1(o: LogNormalAr1Options): { next(dtMs: number): number } {
  const uniform = mulberry32(o.seed);
  let z = gauss(uniform) * o.sigma;
  return {
    next(dtMs: number): number {
      const rho = o.tauSec > 0 ? Math.exp(-dtMs / 1000 / o.tauSec) : 0;
      z = rho * z + Math.sqrt(1 - rho * rho) * o.sigma * gauss(uniform);
      return Math.exp(z - (o.sigma * o.sigma) / 2);
    },
  };
}
