import { describe, expect, it } from 'vitest';
import { PassTimestampDrain, POOL_CONTEXTS, READ_AT_CONTEXTS } from './timestamp-drain';

const POLL_EVERY = 8; // main.ts GPU_POLL_EVERY_FRAMES

interface Run {
  /** Frames whose render three wrote per-pass timestamps in. */
  tracked: number[];
  /** Frames after which a readback started. */
  reads: number[];
  /** Most render contexts in three's pool at once. */
  maxPooled: number;
  /** Times three's pool was full and reset itself (each can warn "a query is already active"). */
  overflows: number;
}

/**
 * main.ts's loop against a model of three r186's WebGL2 pool: `contexts(frame)` render contexts a frame, a readback
 * settles `latency` frames after the frame it started in (0: before the next frame) and empties the pool.
 */
function run(o: {
  pause: boolean;
  frames: number;
  contexts: number | ((frame: number) => number);
  latency: number;
  want?: (frame: number) => boolean;
  /** Render contexts begun between frame f - 1 and frame f (outside the animation frame). */
  outside?: (frame: number) => number;
  firstPoll?: number;
}): Run {
  const drain = new PassTimestampDrain({ pauseWhileReading: o.pause, tracking: true, renderCalls: 0 });
  const result: Run = { tracked: [], reads: [], maxPooled: 0, overflows: 0 };
  let calls = 0;
  let pooled = 0;
  let tracking = true;
  let settleAt = -1;
  const take = (n: number) => {
    for (let i = 0; i < n; i++) {
      calls++;
      if (!tracking) continue;
      if (pooled === POOL_CONTEXTS) {
        result.overflows++;
        pooled = 0;
      }
      pooled++;
      result.maxPooled = Math.max(result.maxPooled, pooled);
    }
  };
  for (let f = 0; f < o.frames; f++) {
    if (f === settleAt) {
      pooled = 0;
      drain.settled();
      settleAt = -1;
    }
    take(o.outside?.(f) ?? 0);
    tracking = drain.beginFrame(o.want?.(f) ?? true, calls);
    if (tracking) result.tracked.push(f);
    take(typeof o.contexts === 'number' ? o.contexts : o.contexts(f));
    if (drain.endFrame(calls, (f - (o.firstPoll ?? 0)) % POLL_EVERY === 0)) {
      result.reads.push(f);
      settleAt = f + 1 + o.latency;
    }
    tracking = drain.writing;
  }
  return result;
}

describe('PassTimestampDrain: when three writes per-pass timestamps and main.ts reads them (S-20)', () => {
  for (const pause of [true, false]) {
    const path = pause ? 'WebGL2' : 'WebGPU';

    it(`${path}: reads on every 8th frame, one readback at a time`, () => {
      expect(run({ pause, frames: 24, contexts: 4, latency: 2 }).reads).toEqual([0, 8, 16]);
      // Still in flight on frame 8: the next readback waits for the next sampling frame after it settles.
      expect(run({ pause, frames: 24, contexts: 4, latency: 10 }).reads).toEqual([0, 16]);
    });

    it(`${path}: never asks for a readback in a frame three wrote no timestamps in`, () => {
      const r = run({ pause, frames: 32, contexts: 4, latency: 0, want: (f) => f >= 12 });
      expect(r.tracked[0]).toBe(12);
      expect(r.reads).toEqual([16, 24]);
    });
  }

  it('WebGL2: three writes no per-pass timestamps while a readback is in flight', () => {
    const r = run({ pause: true, frames: 20, contexts: 4, latency: 3 });
    expect(r.reads).toEqual([0, 8, 16]);
    // Started after frame 0, settles before frame 4.
    expect(r.tracked).toEqual([0, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16]);
  });

  it('WebGPU: keeps them on while reading, as before (a cached pass descriptor keeps its timestampWrites)', () => {
    const r = run({ pause: false, frames: 20, contexts: 4, latency: 3 });
    expect(r.tracked).toHaveLength(20);
  });

  it('WebGL2: reads before the sampling frame once a quarter of the pool is in use', () => {
    const r = run({ pause: true, frames: 7, contexts: 100, latency: 0, firstPoll: 7 });
    // 100, 200, 300 ≥ 256 contexts: after frame 2; then again after 3 more frames.
    expect(r.reads).toEqual([2, 5]);
    expect(r.maxPooled).toBeLessThan(READ_AT_CONTEXTS + 100);
    // WebGPU's pool empties itself when a readback starts: it keeps reading on the sampling frames only.
    expect(run({ pause: false, frames: 12, contexts: 100, latency: 0, firstPoll: 7 }).reads).toEqual([7]);
  });

  it('WebGL2: counts render contexts begun outside the animation frame while the timestamps are on', () => {
    const outside = (f: number) => (f === 3 ? 300 : 0);
    expect(run({ pause: true, frames: 8, contexts: 4, latency: 0, firstPoll: 7, outside }).reads).toEqual([
      3, 7,
    ]);
    // While a readback is in flight they take no queries, from the moment it starts (renders before the next frame,
    // in a scene's update() or a promise callback, too).
    const during = (f: number) => (f === 1 || f === 2 ? 300 : 0);
    const r = run({ pause: true, frames: 8, contexts: 4, latency: 3, outside: during });
    expect(r.reads).toEqual([0]);
    expect(r.maxPooled).toBeLessThanOrEqual(4 * POLL_EVERY);
  });

  describe('three keeps up at any frame rate (the calculation for 144 and 240 fps)', () => {
    // S-17's finishing: ~20 render contexts a frame in the workshop and the stress scene (measured, S-20).
    const CONTEXTS = 20;
    /**
     * Readback times measured on WebGL2 (Apple M5 Pro, S-20, before and after the change): the longest seen at each
     * frame rate. 'paced': FPS=<n> scripts/bench-probe.mjs's frame clock; 'uncapped': no vsync, no frame limit.
     */
    const MEASURED = [
      { fps: 60, ms: 28, how: 'vsync' },
      { fps: 144, ms: 14.1, how: 'paced' },
      { fps: 240, ms: 12.5, how: 'paced' },
      { fps: 480, ms: 17.7, how: 'paced' },
      { fps: 554, ms: 220, how: 'uncapped' },
      { fps: 600, ms: 1745, how: 'uncapped' },
    ];
    const frames = (ms: number, fps: number) => Math.ceil((ms * fps) / 1000);

    for (const m of MEASURED) {
      it(`${m.fps} fps (${m.how}, readbacks up to ${m.ms} ms): the pool never fills`, () => {
        const r = run({ pause: true, frames: 4000, contexts: CONTEXTS, latency: frames(m.ms, m.fps) });
        expect(r.overflows).toBe(0);
        expect(r.maxPooled).toBeLessThanOrEqual(CONTEXTS * POLL_EVERY);
      });
    }

    it('without the pause (main before S-20) it filled only when uncapped', () => {
      const old = (fps: number, ms: number) =>
        run({ pause: false, frames: 4000, contexts: CONTEXTS, latency: frames(ms, fps) }).overflows;
      expect(old(144, 14.1)).toBe(0);
      expect(old(240, 12.5)).toBe(0);
      expect(old(554, 220)).toBeGreaterThan(0);
      // The pool collected every frame from one readback settling to the next one settling, 8 × ⌈(L + 1) / 8⌉ frames
      // for a readback of L frames; past 1024 / 20 contexts that needs L ≥ 48: 333 ms at 144 fps, 200 ms at 240 fps.
      expect(run({ pause: false, frames: 4000, contexts: CONTEXTS, latency: 47 }).overflows).toBe(0);
      expect(run({ pause: false, frames: 4000, contexts: CONTEXTS, latency: 48 }).overflows).toBeGreaterThan(
        0,
      );
    });

    it('with the pause no readback time or number of passes up to ~770 a frame fills it', () => {
      for (const contexts of [1, 20, 64, 128, 200, 500, POOL_CONTEXTS - READ_AT_CONTEXTS + 1]) {
        for (const latency of [0, 1, 7, 8, 9, 47, 48, 200, 2000]) {
          const r = run({ pause: true, frames: 2500, contexts, latency });
          expect(r.overflows, `${contexts} contexts a frame, readback ${latency} frames`).toBe(0);
        }
      }
    });
  });
});
