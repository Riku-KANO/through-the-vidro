import { describe, expect, it } from 'vitest';
import { type GovernorAction, PerfGovernor, type PerfGovernorOptions } from './governor';

const FRAME = 1000 / 60;

/**
 * Drives the governor like the app does: one frame() per frame, a GPU sample every 4th frame
 * (tagged with the epoch at request time), sceneReady() a few frames after a quality switch.
 */
function simulate(
  g: PerfGovernor,
  seconds: number,
  gpuMs: ((level: string, scale: number) => number) | null,
  frameMs = FRAME,
): GovernorAction[] {
  const actions: GovernorAction[] = [];
  let switchingFrames = -1;
  const frames = Math.round((seconds * 1000) / frameMs);
  for (let i = 0; i < frames; i++) {
    if (gpuMs && i % 4 === 0) g.gpu(gpuMs(g.level, g.scale), g.epoch);
    const a = g.frame(frameMs);
    if (a) {
      actions.push(a);
      if (a.kind === 'quality') switchingFrames = 5;
    }
    if (switchingFrames > 0 && --switchingFrames === 0) g.sceneReady();
  }
  return actions;
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
    const actions = simulate(g, 5, () => 30, 33.3);
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

  it('falls back to frame time for dynamic resolution when GPU time is implausible', () => {
    const g = new PerfGovernor(opts({ dynres: true }));
    // Implausible 30 ms GPU readings while frames hold 60 Hz: no reason to lower the resolution.
    expect(simulate(g, 10, () => 30)).toEqual([]);
    expect(g.gpuReliable).toBe(false);
  });
});
