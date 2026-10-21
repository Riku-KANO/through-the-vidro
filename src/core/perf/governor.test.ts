import { describe, expect, it } from 'vitest';
import {
  DYNRES_MAX_RESUMES,
  DYNRES_MAX_WASTED_RESUMES,
  type GovernorAction,
  PerfGovernor,
  type PerfGovernorOptions,
} from './governor';
import { type Cost, driveLikeApp, logNormalAr1, spikes, vsyncFrame } from './load-sim';

const FRAME = 1000 / 60;

/**
 * Drives the governor like the app does: one frame() per frame, a GPU sample every 4th frame
 * (tagged with the epoch at request time), sceneReady() a few frames after a quality switch.
 */
function simulate(
  g: PerfGovernor,
  seconds: number,
  gpuMs: ((level: string, scale: number) => number) | null,
  frameMs: number | ((i: number, level: string) => number) = FRAME,
): GovernorAction[] {
  const actions: GovernorAction[] = [];
  let switchingFrames = -1;
  let elapsed = 0;
  for (let i = 0; elapsed < seconds * 1000; i++) {
    const ms = typeof frameMs === 'number' ? frameMs : frameMs(i, g.level);
    elapsed += ms;
    if (gpuMs && i % 4 === 0) g.gpu(gpuMs(g.level, g.scale), g.epoch);
    const a = g.frame(ms);
    if (a) {
      actions.push(a);
      if (a.kind === 'quality') switchingFrames = 5;
    }
    if (switchingFrames > 0 && --switchingFrames === 0) g.sceneReady();
  }
  return actions;
}

/**
 * Drives the governor exactly like src/main.ts (load-sim.ts): a GPU sample requested every 8th frame while none is in
 * flight, read back 2 frames later with the epoch of the request, the cost taken at the scale the frame was rendered
 * at. Frames take one refresh interval, or two when the GPU cost does not fit.
 */
const simulateApp = (g: PerfGovernor, seconds: number, gpuMs: Cost): GovernorAction[] =>
  driveLikeApp(g, seconds, gpuMs);

/** Deterministic uniform noise in [min, max) (32-bit LCG on the high bits), whatever the sampling stride. */
function noise(min: number, max: number, seed = 7): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return min + ((max - min) * x) / 2 ** 32;
  };
}

const opts = (o: Partial<PerfGovernorOptions> = {}): PerfGovernorOptions => ({
  level: 'mid',
  auto: false,
  autoWindowSec: 10,
  dynres: false,
  gpuTiming: true,
  ...o,
});

describe('PerfGovernor', () => {
  it('does nothing with a fixed preset and dynamic resolution off', () => {
    const g = new PerfGovernor(opts());
    expect(simulate(g, 20, () => 30)).toEqual([]);
    expect(g.scale).toBe(0.85);
  });

  it('auto: measures, switches to the recommended preset, verifies it, then stays', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    const cost = { low: 4, mid: 5, high: 8.5 } as Record<string, number>;
    const actions = simulate(g, 20, (level) => cost[level] ?? 5);
    expect(actions).toEqual([{ kind: 'quality', level: 'high', reason: expect.any(String) }]);
    expect(g.level).toBe('high');
    expect(g.scale).toBe(1);
    expect(g.verified).toBe(true);
    expect(g.phase).toBe('steady');
  });

  it('auto: steps down once when the chosen preset fails verification', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    // mid measures cheap, but high is far heavier than the model predicts.
    const cost = { low: 4, mid: 5, high: 15 } as Record<string, number>;
    const actions = simulate(g, 30, (level) => cost[level] ?? 5);
    expect(actions.map((a) => (a.kind === 'quality' ? a.level : a.kind))).toEqual(['high', 'mid']);
    expect(g.level).toBe('mid');
    expect(g.verified).toBe(false);
  });

  it('auto without GPU timing keeps mid on a 60 Hz display and does not switch', () => {
    const g = new PerfGovernor(opts({ auto: true, gpuTiming: false }));
    expect(simulate(g, 15, null)).toEqual([]);
    expect(g.decision?.level).toBe('mid');
    expect(g.phase).toBe('steady');
  });

  it('does not adjust resolution while auto quality is measuring', () => {
    const g = new PerfGovernor(opts({ auto: true, dynres: true, autoWindowSec: 5 }));
    expect(simulate(g, 4, () => 40)).toEqual([]);
  });

  it('dynamic resolution lowers the scale under GPU overload', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    // GPU-bound: the cost follows the pixel count (S-08: a cost that does not follow it stops dynamic resolution).
    const actions = simulate(g, 5, (_l, s) => 30 * (s / 0.85) ** 2, 33.3);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.kind === 'scale')).toBe(true);
    expect(g.scale).toBeLessThan(0.85);
  });

  it('drops GPU samples requested before a scale change', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulate(g, 1.2, () => 30, 33.3); // first step down after the cooldown
    const scaleAfter = g.scale;
    const staleEpoch = g.epoch - 1;
    for (let i = 0; i < 30; i++) g.gpu(1000, staleEpoch);
    simulate(g, 0.2, null);
    expect(g.scale).toBe(scaleAfter);
  });

  it('ignores a long gap such as returning to a background tab', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulate(g, 2, () => 5);
    expect(g.frame(5000)).toBeNull();
    expect(simulate(g, 0.5, () => 5)).toEqual([]);
  });

  it('keeps dynamic resolution between its floor and the preset scale', () => {
    const g = new PerfGovernor(opts({ dynres: true, level: 'low' }));
    simulate(g, 60, () => 90, 100);
    expect(g.scale).toBeGreaterThanOrEqual(0.5);
    expect(g.scale).toBeLessThanOrEqual(0.67);
  });

  it('stops trusting GPU timestamps that exceed the real frame time (per-pass sums overlap on some GPUs)', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    // Holding 60 fps while the timestamp sum claims 20 ms: physically impossible, so ignore GPU time.
    simulate(g, 12, () => 20);
    expect(g.gpuReliable).toBe(false);
    expect(g.decision?.basis).toBe('frame');
    expect(g.decision?.level).toBe('mid');
  });

  it('keeps trusting GPU time that fits inside the frame', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    simulate(g, 12, () => 6);
    expect(g.gpuReliable).toBe(true);
    expect(g.decision?.basis).toBe('gpu');
  });

  it('turns dynamic resolution off when GPU time is implausible (frame time alone cannot tell a cap from overload)', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    expect(simulate(g, 10, () => 30)).toEqual([]);
    expect(g.gpuReliable).toBe(false);
  });

  it('keeps trusting real GPU overload under vsync, where frames alternate 16.7 / 33.3 ms', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    // GPU 22 ms: two refresh intervals for most frames, one for some; the mean matches the GPU time.
    // GPU-bound, so the cost follows the pixel count.
    const quantized = (i: number) => (i % 3 === 0 ? FRAME : FRAME * 2);
    simulate(g, 10, (_l, s) => 22 * (s / 0.85) ** 2, quantized);
    expect(g.gpuReliable).toBe(true);
    expect(g.scale).toBeLessThan(0.85);
  });

  it('distrusts GPU readings well above a steady 60 Hz frame', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulate(g, 5, () => 24);
    expect(g.gpuReliable).toBe(false);
  });

  it('auto: verifies an upgrade with frame time when GPU readings become implausible', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    // mid measures cheap; on high the GPU readings jump (implausible) and frames start missing vsync.
    const gpu = (level: string) => (level === 'high' ? 40 : 5);
    const frames = (i: number, level: string) => (level === 'high' && i % 2 === 0 ? FRAME * 2 : FRAME);
    const actions = simulate(g, 30, gpu, frames);
    expect(actions.map((a) => (a.kind === 'quality' ? a.level : a.kind))).toEqual(['high', 'mid']);
    expect(g.verified).toBe(false);
  });

  it('auto without GPU timing: verifies an upgrade with frame time and steps down when frames miss', () => {
    const g = new PerfGovernor(opts({ auto: true, gpuTiming: false }));
    // 120 Hz display at mid suggests an upgrade; at high, frames start missing.
    const frames = (i: number, level: string) => (level === 'high' ? (i % 2 === 0 ? 25 : 12) : 8.3);
    const actions = simulate(g, 30, null, frames);
    expect(actions.map((a) => (a.kind === 'quality' ? a.level : a.kind))).toEqual(['high', 'mid']);
    expect(g.verified).toBe(false);
  });

  it('restores the previous preset when recreating the scene fails', () => {
    const g = new PerfGovernor(opts({ auto: true }));
    let action: GovernorAction | null = null;
    for (let i = 0; i < 60 * 12 && !action; i++) {
      if (i % 4 === 0) g.gpu(5, g.epoch);
      action = g.frame(FRAME);
    }
    expect(action).toMatchObject({ kind: 'quality', level: 'high' });
    g.sceneFailed();
    expect(g.level).toBe('mid');
    expect(g.scale).toBe(0.85);
    expect(g.phase).toBe('steady');
    expect(g.verified).toBe(false);
  });

  it('returns to the preset scale when GPU time stops being trusted after lowering it', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    // Real overload that follows the resolution, with frames at 30 Hz: plausible.
    simulate(g, 3, (_l, s) => 30 * (s / 0.85) ** 2, 33.3);
    expect(g.scale).toBeLessThan(0.85);
    // Then readings far above a steady 60 Hz frame: implausible, so the lowered scale has no basis any more.
    const actions = simulate(g, 3, () => 60);
    expect(g.gpuReliable).toBe(false);
    expect(actions.at(-1)).toEqual({ kind: 'scale', scale: 0.85 });
    expect(g.scale).toBe(0.85);
    expect(g.dynresStopReason).toMatch(/implausible/);
    expect(simulate(g, 5, () => 60)).toEqual([]);
  });

  it('stops dynamic resolution and restores the preset when GPU time does not follow the resolution', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    // 25 ms at any scale with frames at 30 Hz: plausible, but lowering the resolution does not help.
    const actions = simulate(g, 10, () => 25, 33.3);
    expect(actions.length).toBeGreaterThanOrEqual(4);
    expect(actions.at(-1)).toEqual({ kind: 'scale', scale: 0.85 });
    expect(g.scale).toBe(0.85);
    expect(g.dynresStopReason).toMatch(/follow/);
    expect(g.gpuReliable).toBe(true);
    // For the rest of the session, also after a quality switch.
    expect(simulate(g, 20, () => 25, 33.3)).toEqual([]);
  });

  it('settles in the band, then keeps lowering for an overload that starts mid-session (app sampling)', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulateApp(g, 5, (s) => 8 * (s / 0.85) ** 2);
    expect(g.scale).toBe(0.85);
    simulateApp(g, 25, (s) => 25 * (s / 0.85) ** 2);
    expect(g.dynresStopReason).toBeNull();
    expect(g.scale).toBeLessThan(0.7);
    expect(g.scale).toBeGreaterThan(0.51);
  });

  it('keeps lowering when part of the cost is fixed (8 ms fixed + 12 ms that follows the pixels, app sampling)', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulateApp(g, 5, (s) => 6 * (s / 0.85) ** 2);
    simulateApp(g, 25, (s) => 8 + 12 * (s / 0.85) ** 2);
    expect(g.dynresStopReason).toBeNull();
    expect(g.scale).toBeLessThan(0.75);
  });

  it('stops for a constant cost that starts mid-session (app sampling)', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulateApp(g, 5, () => 8);
    const actions = simulateApp(g, 25, () => 25);
    expect(g.dynresStopReason).toMatch(/follow/);
    expect(actions.at(-1)).toEqual({ kind: 'scale', scale: 0.85 });
  });

  it('without the response check (?dynresResponse=0), keeps stepping down to the floor whatever the GPU time does', () => {
    const g = new PerfGovernor(opts({ dynres: true, dynresRequireResponse: false }));
    simulate(g, 15, () => 25, 33.3);
    expect(g.scale).toBe(0.51);
    expect(g.dynresStopReason).toBeNull();
  });

  it('a forced level replaces the recommendation but is still verified', () => {
    const g = new PerfGovernor(opts({ auto: true, gpuTiming: false, forceLevel: 'high' }));
    const actions = simulate(g, 20, null);
    expect(actions).toEqual([{ kind: 'quality', level: 'high', reason: expect.stringMatching(/^forced/) }]);
    expect(g.verified).toBe(true);
  });
});

/**
 * S-11: once the response check stopped dynamic resolution, a new load (the smoothed GPU time 30% or more above the
 * level it stopped at, sustained) resumes it, a limited number of times per session. The light-load numbers mirror
 * the closed loop the parent measured for S-08 (vsync, high, DPR 2, dynresTarget=6: the span jittered 3.6–6.7 ms in
 * the small window and did not follow the resolution, then read 8.6–11 ms once the window grew).
 */
describe('PerfGovernor: dynamic resolution resumes after a stop (S-11)', () => {
  const lightJitter = (seed = 7) => {
    const n = noise(3.6, 6.7, seed);
    return () => n();
  };

  it('a: stopped at a light load under vsync, resumes and lowers once the load grows (dynresTarget=6, high)', () => {
    const g = new PerfGovernor(opts({ level: 'high', dynres: true, dynresTargetMs: 6 }));
    simulateApp(g, 15, lightJitter());
    expect(g.dynresStopReason).toMatch(/follow/);
    expect(g.scale).toBe(1);
    expect(g.dynresStops).toBe(1);
    // It watches for a new load: 30% above the light level, and above the 4.8 ms where it would step down.
    expect(g.dynresResumeAtMs).toBeGreaterThan(4.8);
    // The window grows: the cost now follows the pixels (~9.5 ms at full scale, ±10%).
    const wobble = noise(0.9, 1.1, 3);
    const actions = simulateApp(g, 20, (s) => 9.5 * s ** 2 * wobble());
    expect(g.dynresResumes).toBe(1);
    expect(g.dynresResumeReason).toMatch(/rose/);
    expect(g.dynresResumeAtMs).toBeNull();
    expect(g.dynresStopReason).toBeNull();
    expect(actions.length).toBeGreaterThan(0);
    expect(g.scale).toBeLessThan(0.8);
    expect(g.scale).toBeGreaterThanOrEqual(0.6);
  });

  it('a: also when the new load is only ~1.45× the light one (the closed loop of S-11: 6.2–6.8 ms, then 7.5–10.4 ms)', () => {
    const g = new PerfGovernor(opts({ level: 'high', dynres: true, dynresTargetMs: 6 }));
    simulateApp(g, 15, noise(5.5, 7.5, 13));
    expect(g.dynresStopReason).toMatch(/follow/);
    const wobble = noise(0.85, 1.15, 17);
    simulateApp(g, 20, (s) => 9.3 * s ** 2 * wobble());
    expect(g.dynresResumes).toBe(1);
    expect(g.scale).toBeLessThan(0.85);
  });

  it('a: also when the smoothed value at the stop still carries the start-up (the closed loop of S-11 stopped at 5 s)', () => {
    const g = new PerfGovernor(opts({ level: 'high', dynres: true, dynresTargetMs: 6 }));
    // Shader compiles and first uploads, then the light load; the stop comes ~4 s later and a new load ~5 s after it.
    simulateApp(g, 0.6, () => 14);
    simulateApp(g, 10, lightJitter(3));
    expect(g.dynresStopReason).toMatch(/follow/);
    const wobble = noise(0.9, 1.1, 19);
    simulateApp(g, 6, (s) => 8 * s ** 2 * wobble());
    expect(g.dynresResumes).toBe(1);
    expect(g.scale).toBeLessThan(1);
  });

  it('a: the same with the real target (16.7 ms): a light frame whose span reads long stops it, real overload resumes it', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulateApp(g, 15, noise(13.5, 15.5));
    expect(g.dynresStopReason).toMatch(/follow/);
    expect(g.scale).toBe(0.85);
    simulateApp(g, 25, (s) => 25 * (s / 0.85) ** 2);
    expect(g.dynresResumes).toBe(1);
    expect(g.dynresStopReason).toBeNull();
    expect(g.gpuReliable).toBe(true);
    expect(g.scale).toBeLessThan(0.7);
  });

  it('b: a light load that only jitters under vsync does not resume', () => {
    const g = new PerfGovernor(opts({ level: 'high', dynres: true, dynresTargetMs: 6 }));
    const jitter = lightJitter(11);
    simulateApp(g, 15, jitter);
    expect(g.dynresStopReason).toMatch(/follow/);
    expect(simulateApp(g, 60, jitter)).toEqual([]);
    expect(g.dynresResumes).toBe(0);
    expect(g.scale).toBe(1);
  });

  it('b: nor does a slow swing of the same light load, or a one-second burst', () => {
    const g = new PerfGovernor(opts({ level: 'high', dynres: true, dynresTargetMs: 6 }));
    simulateApp(g, 15, lightJitter(5));
    expect(g.dynresStopReason).toMatch(/follow/);
    // 3.6–6.7 ms as a 4 s swing, then a 1 s burst at three times the load (a loading hitch).
    const swing = (_s: number, t: number) => 5.15 + 1.55 * Math.sin((2 * Math.PI * t) / 4000);
    expect(simulateApp(g, 40, swing)).toEqual([]);
    const burst = (_s: number, t: number) => (t < 1000 ? 16 : 5.15);
    expect(simulateApp(g, 10, burst)).toEqual([]);
    expect(g.dynresResumes).toBe(0);
  });

  it('c: a constant cost that does not follow the resolution stays stopped', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    simulateApp(g, 5, () => 8);
    simulateApp(g, 25, () => 25);
    expect(g.dynresStopReason).toMatch(/follow/);
    expect(simulateApp(g, 60, () => 25)).toEqual([]);
    const wobble = noise(0.9, 1.1);
    expect(simulateApp(g, 60, () => 25 * wobble())).toEqual([]);
    expect(g.dynresResumes).toBe(0);
    expect(g.scale).toBe(0.85);
  });

  it('d: resumes at most DYNRES_MAX_WASTED_RESUMES times when every new load again does not follow the resolution', () => {
    const g = new PerfGovernor(opts({ dynres: true, dynresTargetMs: 6 }));
    // A staircase of constant costs, each 40% above the last: every step is a new load, none follows the pixels.
    let cost = 5;
    for (let i = 0; i <= DYNRES_MAX_WASTED_RESUMES; i++) {
      simulateApp(g, 20, () => cost);
      cost *= 1.4;
    }
    expect(g.dynresResumes).toBe(DYNRES_MAX_WASTED_RESUMES);
    expect(g.dynresStops).toBe(DYNRES_MAX_WASTED_RESUMES + 1);
    expect(g.dynresStopReason).toMatch(/for the session/);
    expect(g.dynresResumeAtMs).toBeNull();
    expect(g.scale).toBe(0.85);
    // One more new load: no more resumes, the preset scale stays.
    expect(simulateApp(g, 30, () => cost)).toEqual([]);
    expect(g.dynresResumes).toBe(DYNRES_MAX_WASTED_RESUMES);
    expect(g.gpuReliable).toBe(true);
  });

  it('d: a load that goes back and forth between light and heavy is judged once, not resumed every time', () => {
    const g = new PerfGovernor(opts({ dynres: true, dynresTargetMs: 6 }));
    for (let i = 0; i < 6; i++) simulateApp(g, 15, () => (i % 2 === 0 ? 5 : 9));
    expect(g.dynresResumes).toBe(1);
    expect(g.dynresStops).toBe(2);
    expect(g.scale).toBe(0.85);
  });

  it('does not resume once GPU time stopped being trusted (implausible readings)', () => {
    const g = new PerfGovernor(opts({ level: 'high', dynres: true, dynresTargetMs: 6 }));
    simulateApp(g, 15, lightJitter());
    expect(g.dynresStopReason).toMatch(/follow/);
    // Readings far above the frame time: implausible, however much they rose.
    expect(simulateApp(g, 10, () => 60)).toEqual([]);
    expect(g.gpuReliable).toBe(false);
    expect(g.dynresStopReason).toMatch(/implausible/);
    expect(simulateApp(g, 20, (s) => 9.5 * s ** 2)).toEqual([]);
    expect(g.dynresResumes).toBe(0);
    // Already stopped: the reason changes, it does not count as another stop.
    expect(g.dynresStops).toBe(1);
  });
});

/**
 * S-13: GPU time that swings for a second or more (log-normal AR(1), load-sim.ts; σ = spread in log units, τ = how
 * long a swing lasts), as the span does under vsync. Each case runs a fixed set of seeds and bounds the share of runs
 * that go wrong. The bounds leave room for the seed set: each comment gives the rate on 200 seeds (scripts/sim), the
 * count on these seeds, its range over 9 other sets of the same size (seeds shifted by 100 to 900, review round 1
 * found bounds set at the rate itself failed on a quarter of the sets), and S-11 (98185af) on these seeds.
 * Frames follow vsync (vsyncFrame), so a swing above two refresh intervals is not mistaken for an implausible reading.
 */
describe('PerfGovernor under swinging GPU time (S-13)', () => {
  const swinging = (base: (scale: number) => number, sigma: number, tauSec: number, seed: number): Cost => {
    const n = logNormalAr1({ sigma, tauSec, seed });
    return (s, _t, dt) => base(s) * n.next(dt);
  };
  const drive = (g: PerfGovernor, seconds: number, cost: Cost) =>
    driveLikeApp(g, seconds, cost, { frame: vsyncFrame });
  /** Seeds k × 7919 for k = 1..seeds, the runs for which `run` returns true. */
  const count = (seeds: number, run: (seed: number) => boolean): number => {
    let n = 0;
    for (let k = 1; k <= seeds; k++) if (run(k * 7919)) n++;
    return n;
  };
  const real = { level: 'mid', dynres: true } as const;
  const light = { level: 'high', dynres: true, dynresTargetMs: 6 } as const;
  const pixels = (msAtPreset: number, preset: number) => (s: number) => msAtPreset * (s / preset) ** 2;

  // σ 0.2: 6.5% on 200 seeds; these 100: 7, other sets 3–8; S-11 33. σ 0.3: 17%; these 100: 16, other sets 8–23; S-11 45.
  it.each([
    [0.2, 14],
    [0.3, 30],
  ])(
    'a load that follows the pixels is rarely stopped (real target, 25 ms at mid, σ %s, τ 1 s): ≤ %i of 100',
    (sigma, most) => {
      const stopped = count(100, (seed) => {
        const g = new PerfGovernor(opts(real));
        drive(g, 30, swinging(pixels(25, 0.85), sigma, 1, seed));
        return g.dynresStops > 0;
      });
      expect(stopped).toBeLessThanOrEqual(most);
    },
  );

  // σ 0.1: 100% on 200 seeds; these 100: 100, other sets 99–100; S-11 100. σ 0.3: 88%; these 100: 82, other sets
  // 78–91; S-11 87 (two misses in a row cost some at σ 0.3). A protective bound: green before and after.
  it.each([
    [0.1, 97],
    [0.3, 72],
  ])(
    'a load that does not follow the pixels is still stopped (real target, 25 ms flat, σ %s, τ 1 s): ≥ %i of 100',
    (sigma, least) => {
      const stopped = count(100, (seed) => {
        const g = new PerfGovernor(opts(real));
        drive(
          g,
          30,
          swinging(() => 25, sigma, 1, seed),
        );
        return g.dynresStops > 0 && g.scale === 0.85;
      });
      expect(stopped).toBeGreaterThanOrEqual(least);
    },
  );

  it('a load that does not follow and reaches the floor before two verdicts is stopped there (low preset)', () => {
    const g = new PerfGovernor(opts({ level: 'low', dynres: true }));
    simulateApp(g, 15, () => 25);
    expect(g.dynresStopReason).toMatch(/floor/);
    expect(g.scale).toBe(0.67);
  });

  // Target 6: 11% of the stopped on 200 seeds; these 100: 5/75, other sets 3–10%; S-11 29/89 (33%). Real target:
  // 0/169 on 200 seeds; these 100: 0/82, other sets 0–2.2%; S-11 6/83 (7%).
  it.each([
    ['target 6, high, 5.3 ms, σ 0.2', light, 5.3, 0.2, 15, 0.2],
    ['real target, mid, 14.5 ms, σ 0.15', real, 14.5, 0.15, 20, 0.04],
  ] as const)(
    'swings of the load it stopped on do not resume it (%s, τ 1 s, 120 s)',
    (_l, o, ms, sigma, first, share) => {
      let stopped = 0;
      const resumed = count(100, (seed) => {
        const g = new PerfGovernor(opts(o));
        const cost = swinging(() => ms, sigma, 1, seed);
        drive(g, first, cost);
        if (g.dynresStops === 0) return false;
        stopped++;
        drive(g, 120, cost);
        return g.dynresResumes > 0;
      });
      expect(stopped).toBeGreaterThanOrEqual(50);
      expect(resumed).toBeLessThanOrEqual(Math.floor(stopped * share));
    },
  );

  // Single long frames on top of the swing, as on hardware (S-13 closed loop: 2–4 ms with samples at 8–48 ms): taken
  // as swing, two of them among 15 samples put the threshold out of reach of a new load (the first S-13 rule).
  // 171/179 (96%) on 200 seeds; these 150: 117/124 (94%), other sets 92–97%; with the 90th percentile of the raw
  // samples as the swing 89/124 (72%); S-11 131/134.
  it('single spikes around the stop do not keep a new load from resuming (target 6, high, σ 0.2 + spikes)', () => {
    let stopped = 0;
    const resumed = count(150, (seed) => {
      const g = new PerfGovernor(opts(light));
      const n = logNormalAr1({ sigma: 0.2, tauSec: 1, seed });
      const spike = spikes({ p: 0.1, lo: 3, hi: 6, seed: seed + 1 });
      const cost =
        (base: (s: number) => number): Cost =>
        (s, _t, dt) =>
          base(s) * n.next(dt) * spike();
      drive(
        g,
        15,
        cost(() => 5.3),
      );
      if (g.dynresStops === 0) return false;
      stopped++;
      drive(
        g,
        3,
        cost(() => 5.3),
      );
      drive(g, 30, cost(pixels(9.5, 1)));
      return g.dynresResumes > 0;
    });
    expect(stopped).toBeGreaterThanOrEqual(75);
    expect(resumed).toBeGreaterThanOrEqual(Math.ceil(stopped * 0.85));
  });

  // These 100: 73/75 (97%), other sets 89.9–97.5%; S-11 62/89 (70%: its resumed controller often stopped again on a swing).
  it('a new load after the stop still resumes it and lowers the scale (target 6, high, σ 0.2, τ 1 s)', () => {
    let stopped = 0;
    const lowered = count(100, (seed) => {
      const g = new PerfGovernor(opts(light));
      drive(
        g,
        15,
        swinging(() => 5.3, 0.2, 1, seed),
      );
      if (g.dynresStops === 0) return false;
      stopped++;
      drive(g, 30, swinging(pixels(9.5, 1), 0.2, 1, seed + 1));
      return g.dynresResumes > 0 && g.scale < 0.9;
    });
    expect(stopped).toBeGreaterThanOrEqual(50);
    expect(lowered).toBeGreaterThanOrEqual(Math.ceil(stopped * 0.8));
  });

  it('resumes at most DYNRES_MAX_RESUMES times in all, even when no resume was wasted', () => {
    // Deterministic (review round 2 of S-13): each round a flat load stops it, a heavier load that follows the pixels
    // resumes it and is lowered with a response (so the resume is not wasted), and a light load lets it climb back.
    // The 11th stop finds the total used up: off for the session although no resume was wasted.
    const g = new PerfGovernor(opts(light));
    for (let round = 0; round < DYNRES_MAX_RESUMES + 1; round++) {
      drive(g, 20, () => 5);
      expect(g.dynresStopReason).not.toBeNull();
      drive(g, 25, pixels(9.5, 1));
      drive(g, 30, () => 3);
    }
    expect(g.dynresResumes).toBe(DYNRES_MAX_RESUMES);
    expect(g.dynresWastedResumes).toBe(0);
    expect(g.dynresStopReason).toMatch(/resumed 10 times \(at most 10\).*off for the session/);
    expect(g.dynresResumeAtMs).toBeNull();
  });

  it('only wasted resumes count: resumes whose controller lowered the scale with a response do not use up the cap', () => {
    const g = new PerfGovernor(opts(light));
    // Each round: a load that does not follow the pixels stops it, a heavier one that does resumes it and is lowered,
    // and a light one lets the controller climb back to the preset scale.
    const rounds = [
      [5, 9.5],
      [9, 15],
      [15, 25],
      [25, 40],
    ] as const;
    for (const [flat, heavy] of rounds) {
      drive(g, 20, () => flat);
      expect(g.dynresStopReason).toMatch(/follow/);
      drive(g, 25, pixels(heavy, 1));
      expect(g.dynresStopReason).toBeNull();
      expect(g.scale).toBeLessThan(0.9);
      drive(g, 30, () => 3);
      expect(g.scale).toBe(1);
    }
    expect(g.dynresResumes).toBe(4);
    expect(g.dynresWastedResumes).toBe(0);
    expect(g.gpuReliable).toBe(true);
  });

  it('a resume that stops again without a response is wasted; the cap counts those', () => {
    const g = new PerfGovernor(opts(light));
    // The staircase of the S-11 test d: every new load is constant, so every resume is wasted.
    let cost = 5;
    for (let i = 0; i <= DYNRES_MAX_WASTED_RESUMES; i++) {
      drive(g, 20, () => cost);
      cost *= 1.4;
    }
    expect(g.dynresWastedResumes).toBe(DYNRES_MAX_WASTED_RESUMES);
    expect(g.dynresStopReason).toMatch(/in vain.*off for the session/);
  });
});
