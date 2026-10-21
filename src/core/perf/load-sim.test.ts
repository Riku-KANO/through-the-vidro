import { describe, expect, it } from 'vitest';
import type { GovernorAction } from './governor';
import { type DrivenGovernor, driveLikeApp, logNormalAr1, REFRESH_MS, vsyncFrame } from './load-sim';

/** Records what the driver feeds; bumps its epoch on frame 20 like an applied action would. */
class Recorder implements DrivenGovernor {
  scale = 1;
  epoch = 0;
  frames = 0;
  readonly fed: { frame: number; ms: number; epoch: number }[] = [];
  gpu(ms: number, epoch: number): void {
    this.fed.push({ frame: this.frames, ms, epoch });
  }
  frame(): GovernorAction | null {
    if (++this.frames === 20) this.epoch++;
    return null;
  }
}

describe('load-sim', () => {
  it('feeds a GPU sample like the app: requested every 8th frame, read back 2 frames later with its epoch', () => {
    const g = new Recorder();
    driveLikeApp(g, 0.5, (_s, t) => 1 + t / 1000);
    expect(g.fed.slice(0, 4).map((f) => f.frame)).toEqual([2, 10, 18, 26]);
    // Requested on frame 16 (epoch 0), read back on frame 18; requested on frame 24, after the bump on frame 20.
    expect(g.fed.map((f) => f.epoch).slice(0, 4)).toEqual([0, 0, 0, 1]);
    // The cost of the frame it was requested on (1 ms + the elapsed seconds at the start of frame 8 here).
    expect(g.fed[1]?.ms).toBeCloseTo(1 + (8 * REFRESH_MS) / 1000);
  });

  it('vsync rounds a frame up to whole refresh intervals', () => {
    expect(vsyncFrame(3)).toBe(REFRESH_MS);
    expect(vsyncFrame(20)).toBe(2 * REFRESH_MS);
    expect(vsyncFrame(40)).toBe(3 * REFRESH_MS);
  });

  it('log-normal AR(1) noise: the same seed repeats, the mean is 1, a longer τ swings more slowly', () => {
    const series = (tauSec: number, seed: number) => {
      const n = logNormalAr1({ sigma: 0.3, tauSec, seed });
      return Array.from({ length: 60 * 600 }, () => n.next(REFRESH_MS));
    };
    expect(series(1, 5).slice(0, 10)).toEqual(series(1, 5).slice(0, 10));
    const a = series(1, 11);
    expect(a.reduce((x, y) => x + y, 0) / a.length).toBeCloseTo(1, 1);
    // How far it moves in a quarter of a second, in log units: much less with τ = 3 s than with τ = 0.1 s.
    const drift = (xs: number[]) => {
      let sum = 0;
      for (let i = 15; i < xs.length; i++) sum += Math.abs(Math.log((xs[i] ?? 1) / (xs[i - 15] ?? 1)));
      return sum / (xs.length - 15);
    };
    expect(drift(series(3, 11))).toBeLessThan(drift(series(0.1, 11)) / 2);
  });
});
