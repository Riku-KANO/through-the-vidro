#!/usr/bin/env node
// How dynamic resolution's response check and resume watch cope with GPU time that swings (S-13).
// Drives src/core/perf/governor.ts like the app does (src/core/perf/load-sim.ts: a sample every 8th frame, read back
// 2 frames later, vsync) under seeded, persistent log-normal AR(1) noise (σ = spread in log units, τ = how long a
// swing lasts), and prints the rates as a markdown table, before (a git commit) and after (the working tree).
//   node scripts/sim/dynres-noise.mjs                 before = 98185af (S-13's base), after = the working tree
//   node scripts/sim/dynres-noise.mjs --before main   compare with another commit; --before none for the tree only
//   node scripts/sim/dynres-noise.mjs --runs 50 --only prop,flat   fewer runs (default 200, sessions 100), some groups
// Seeds are fixed (run k uses seed k × a per-scenario prime), so a run prints the same numbers every time.
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const beforeRef = arg('before', '98185af');
const runs = Number(arg('runs', 200));
const only = arg('only', '')?.split(',').filter(Boolean) ?? [];

const {
  driveLikeApp,
  logNormalAr1,
  mulberry32,
  spikes: spikeTrain,
  vsyncFrame,
} = await loadTs('src/core/perf/load-sim.ts');
const versions = [];
if (beforeRef !== 'none')
  versions.push({ name: `before (${beforeRef})`, mod: await loadTs('src/core/perf/governor.ts', beforeRef) });
versions.push({ name: 'after (working tree)', mod: await loadTs('src/core/perf/governor.ts') });

const TARGET = 1000 / 60;
const OVERLOAD = 0.8; // DOWN in dynamic-resolution.ts: the controller lowers the scale above this share of the target
const pixels = (msAtPreset, preset) => (s) => msAtPreset * (s / preset) ** 2;
const flat = (ms) => () => ms;

/**
 * One session: phases run back to back on one governor, each with its own noise (seeded from the run).
 * A phase with `untilStop` runs in 0.25 s chunks until dynamic resolution stops (or `seconds` pass).
 */
function session(mod, o, phases, seed) {
  const g = new mod.PerfGovernor({ auto: false, autoWindowSec: 3, dynres: true, gpuTiming: true, ...o });
  const target = o.dynresTargetMs ?? TARGET;
  const marks = [];
  let clock = 0;
  for (const [k, ph] of phases.entries()) {
    const noise = logNormalAr1({ sigma: ph.sigma, tauSec: ph.tau, seed: seed * 31 + k });
    const uniform = ph.uniform ? mulberry32(seed * 131 + k) : null;
    const spike = ph.spikes ? spikeTrain({ ...ph.spikes, seed: seed * 137 + k }) : () => 1;
    // Per phase: first stop / resume (s into the phase), lowest scale, time stopped (and stopped at an overload).
    const m = {
      stopsBefore: g.dynresStops,
      resumesBefore: g.dynresResumes,
      start: clock,
      firstStop: null,
      firstResume: null,
      minScale: g.scale,
      stoppedMs: 0,
      stoppedOverMs: 0,
      ms: 0,
    };
    const cost = (s, _t, dt) => {
      const base = uniform ? ph.uniform[0] + (ph.uniform[1] - ph.uniform[0]) * uniform() : ph.cost(s);
      return base * noise.next(dt) * spike();
    };
    const onFrame = (_e, c, frameMs) => {
      clock += frameMs;
      m.ms += frameMs;
      m.minScale = Math.min(m.minScale, g.scale);
      if (g.dynresStopReason) {
        m.stoppedMs += frameMs;
        if (c > target * OVERLOAD) m.stoppedOverMs += frameMs;
      }
      if (m.firstStop === null && g.dynresStops > m.stopsBefore) m.firstStop = (clock - m.start) / 1000;
      if (m.firstResume === null && g.dynresResumes > m.resumesBefore)
        m.firstResume = (clock - m.start) / 1000;
    };
    if (ph.untilStop) {
      for (let t = 0; t < ph.seconds && g.dynresStops === m.stopsBefore; t += 0.25)
        driveLikeApp(g, 0.25, cost, { frame: vsyncFrame, onFrame });
    } else {
      driveLikeApp(g, ph.seconds, cost, { frame: vsyncFrame, onFrame });
    }
    m.stops = g.dynresStops - m.stopsBefore;
    m.resumes = g.dynresResumes - m.resumesBefore;
    m.endScale = g.scale;
    m.stoppedAtEnd = g.dynresStopReason !== null;
    m.offForSession = /resumed .*for the session/.test(g.dynresStopReason ?? '');
    m.implausible = !g.gpuReliable;
    marks.push(m);
  }
  return { g, marks };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const frac = (k, n) => `${k}/${n}`;
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const sec = (x) => (x === null ? '-' : `${x.toFixed(1)} s`);

/** Each scenario: id, group, title, options, phases, seed prime, and the metrics it reports from the runs. */
const real = { level: 'mid' };
const t6high = { level: 'high', dynresTargetMs: 6 };
const scenarios = [
  // P2-1: a load that follows the resolution must not stop (30 s at overload, the controller should keep lowering)
  ...[
    ['prop-real-s02', 'real target, mid, 25 ms × (s/0.85)², σ 0.2 τ 1 s', real, 25, 0.85, 0.2, 1],
    ['prop-real-s03', 'real target, mid, 25 ms × (s/0.85)², σ 0.3 τ 1 s', real, 25, 0.85, 0.3, 1],
    ['prop-real-s05', 'real target, mid, 25 ms × (s/0.85)², σ 0.5 τ 1 s', real, 25, 0.85, 0.5, 1],
    ['prop-t6-iid', 'target 6, high, 9.5 ms × s², σ 0.5 independent', t6high, 9.5, 1, 0.5, 0],
    ['prop-t6-t1', 'target 6, high, 9.5 ms × s², σ 0.5 τ 1 s', t6high, 9.5, 1, 0.5, 1],
    ['prop-t6-t3', 'target 6, high, 9.5 ms × s², σ 0.5 τ 3 s', t6high, 9.5, 1, 0.5, 3],
  ].map(([id, title, o, ms, preset, sigma, tau]) => ({
    id,
    group: 'prop',
    title: `follows the pixels: ${title}`,
    o,
    phases: [{ seconds: 30, cost: pixels(ms, preset), sigma, tau }],
    prime: 7919,
    metrics: [
      [
        'stopped wrongly (≥1 stop in 30 s)',
        (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length),
      ],
      ['still stopped at 30 s', (rs) => frac(rs.filter((r) => r.marks[0].stoppedAtEnd).length, rs.length)],
      [
        'time stopped (share of 30 s)',
        (rs) => pct(rs.reduce((a, r) => a + r.marks[0].stoppedMs / r.marks[0].ms, 0) / rs.length),
      ],
    ],
  })),
  // P2-1: a load that does not follow the resolution must stop (back at the preset scale), not sit at the floor
  ...[
    ['flat-real-s03', 'real target, mid, 25 ms, σ 0.3 τ 1 s', real, 25, 0.3, 1],
    ['flat-real-s01', 'real target, mid, 25 ms, σ 0.1 τ 1 s', real, 25, 0.1, 1],
    ['flat-t6-s05', 'target 6, high, 9.5 ms, σ 0.5 τ 1 s', t6high, 9.5, 0.5, 1],
  ].map(([id, title, o, ms, sigma, tau]) => ({
    id,
    group: 'flat',
    title: `does not follow: ${title}`,
    o,
    phases: [{ seconds: 30, cost: flat(ms), sigma, tau }],
    prime: 7919,
    metrics: [
      ['stopped within 30 s', (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length)],
      [
        'median time to stop',
        (rs) => sec(median(rs.map((r) => r.marks[0].firstStop).filter((t) => t !== null))),
      ],
      [
        'at the floor at 30 s, not stopped',
        (rs) =>
          frac(rs.filter((r) => !r.marks[0].stoppedAtEnd && r.marks[0].endScale <= 0.61).length, rs.length),
      ],
    ],
  })),
  {
    id: 'light-uniform',
    group: 'flat',
    title:
      'does not follow: light load under vsync, U(3.6, 6.7) ms per sample, target 6, high (S-08 closed loop)',
    o: t6high,
    phases: [{ seconds: 15, uniform: [3.6, 6.7], sigma: 0, tau: 0 }],
    prime: 31,
    metrics: [
      ['stopped within 15 s', (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length)],
      [
        'median time to stop',
        (rs) => sec(median(rs.map((r) => r.marks[0].firstStop).filter((t) => t !== null))),
      ],
      [
        'at the floor at 15 s, not stopped',
        (rs) =>
          frac(rs.filter((r) => !r.marks[0].stoppedAtEnd && r.marks[0].endScale <= 0.61).length, rs.length),
      ],
    ],
  },
  // P2-2: once stopped on a load that does not follow, the same load swinging must not resume (120 s)
  ...[
    ['noresume-t6-s02-t1', 'target 6, high, 5.3 ms, σ 0.2 τ 1 s', t6high, 5.3, 0.2, 1, 15],
    ['noresume-t6-s03-t1', 'target 6, high, 5.3 ms, σ 0.3 τ 1 s', t6high, 5.3, 0.3, 1, 15],
    ['noresume-t6-s03-t3', 'target 6, high, 5.3 ms, σ 0.3 τ 3 s', t6high, 5.3, 0.3, 3, 15],
    ['noresume-t6-s04-t3', 'target 6, high, 5.3 ms, σ 0.4 τ 3 s', t6high, 5.3, 0.4, 3, 15],
    ['noresume-real-s015-t1', 'real target, mid, 14.5 ms, σ 0.15 τ 1 s', real, 14.5, 0.15, 1, 20],
    ['noresume-real-s02-t3', 'real target, mid, 14.5 ms, σ 0.2 τ 3 s', real, 14.5, 0.2, 3, 20],
    ['noresume-real-s03-t3', 'real target, mid, 14.5 ms, σ 0.3 τ 3 s', real, 14.5, 0.3, 3, 20],
  ].map(([id, title, o, ms, sigma, tau, first]) => ({
    id,
    group: 'noresume',
    title: `same load after the stop: ${title}`,
    o,
    phases: [
      { seconds: first, cost: flat(ms), sigma, tau },
      { seconds: 120, cost: flat(ms), sigma, tau },
    ],
    prime: 104729,
    metrics: [
      ['stopped in the first phase', (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length)],
      [
        'resumed within 120 s (of those)',
        (rs) => {
          const s = rs.filter((r) => r.marks[0].stops > 0);
          return frac(s.filter((r) => r.marks[1].resumes > 0).length, s.length);
        },
      ],
    ],
  })),
  // P2-2: a real new load after the stop must still resume, and then lower the scale
  ...[
    [
      'resume-t6',
      'target 6, high: 5.3 ms flat σ 0.2 τ 1 s for 15 s, then 9.5 ms × s² σ 0.2 τ 1 s',
      t6high,
      [15, flat(5.3)],
      pixels(9.5, 1),
      0.2,
      1,
      false,
    ],
    [
      'resume-t6-now',
      'target 6, high: the same, the new load right at the stop',
      t6high,
      [30, flat(5.3)],
      pixels(9.5, 1),
      0.2,
      1,
      true,
    ],
    [
      'resume-t6-1s',
      'target 6, high: the same, the new load 1 s after the stop',
      t6high,
      [30, flat(5.3)],
      pixels(9.5, 1),
      0.2,
      1,
      1,
    ],
    [
      'resume-real',
      'real target, mid: 14.5 ms flat σ 0.15 τ 1 s for 20 s, then 25 ms × (s/0.85)² σ 0.15 τ 1 s',
      real,
      [20, flat(14.5)],
      pixels(25, 0.85),
      0.15,
      1,
      false,
    ],
  ].map(([id, title, o, [first, light], heavy, sigma, tau, untilStop]) => ({
    id,
    group: 'resume',
    title: `new load after the stop: ${title}`,
    o,
    phases: [
      { seconds: first, cost: light, sigma, tau, untilStop: untilStop !== false },
      ...(typeof untilStop === 'number' ? [{ seconds: untilStop, cost: light, sigma, tau }] : []),
      { seconds: 30, cost: heavy, sigma, tau },
    ],
    prime: 15485863,
    metrics: [
      ['stopped in the first phase', (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length)],
      [
        'resumed within 30 s (of those)',
        (rs) => {
          const s = rs.filter((r) => r.marks[0].stops > 0);
          return frac(s.filter((r) => r.marks.at(-1).resumes > 0).length, s.length);
        },
      ],
      [
        'median time to resume',
        (rs) =>
          sec(
            median(
              rs
                .filter((r) => r.marks[0].stops > 0)
                .map((r) => r.marks.at(-1).firstResume)
                .filter((t) => t !== null),
            ),
          ),
      ],
      [
        'lowered the scale after it (of those)',
        (rs) => {
          const s = rs.filter((r) => r.marks[0].stops > 0);
          return frac(s.filter((r) => r.marks.at(-1).minScale < r.marks[0].endScale - 0.01).length, s.length);
        },
      ],
    ],
  })),
  // P2-2: false resumes used up the cap: 300 s of the same swinging load after the stop, then a real new load
  ...[
    [
      'cap-t6-s03-t3',
      'target 6, high: 5.3 ms σ 0.3 τ 3 s for 300 s, then 9.5 ms × s²',
      t6high,
      5.3,
      pixels(9.5, 1),
      0.3,
      3,
    ],
    [
      'cap-real-s02-t3',
      'real target, mid: 14.5 ms σ 0.2 τ 3 s for 300 s, then 25 ms × (s/0.85)²',
      real,
      14.5,
      pixels(25, 0.85),
      0.2,
      3,
    ],
  ].map(([id, title, o, ms, heavy, sigma, tau]) => ({
    id,
    group: 'cap',
    title: `a long swinging load, then a new one: ${title}`,
    o,
    phases: [
      { seconds: 300, cost: flat(ms), sigma, tau },
      { seconds: 30, cost: heavy, sigma, tau },
    ],
    prime: 104723,
    runs: Math.min(runs, 100),
    metrics: [
      ['stopped in the first phase', (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length)],
      [
        'mean resumes in the first 300 s (all wrong)',
        (rs) => (rs.reduce((a, r) => a + r.marks[0].resumes, 0) / rs.length).toFixed(2),
      ],
      [
        'resume cap used up by then',
        (rs) => frac(rs.filter((r) => r.marks[0].offForSession).length, rs.length),
      ],
      [
        'running or resumed for the new load (of those stopped)',
        (rs) => {
          const s = rs.filter((r) => r.marks[0].stops > 0);
          return frac(s.filter((r) => r.marks[1].resumes > 0 || !r.marks[0].stoppedAtEnd).length, s.length);
        },
      ],
    ],
  })),
  // Spikes on top of the swing, as the span showed on hardware (S-13 closed loop, mid, DPR 2: 2–4 ms with single
  // samples at 8–48 ms): each frame is 3–6× longer with probability 0.1.
  ...(() => {
    const spikes = { p: 0.1, lo: 3, hi: 6 };
    const sw = (cost, seconds, extra = {}) => ({ seconds, cost, sigma: 0.2, tau: 1, spikes, ...extra });
    const stoppedFirst = (rs) => rs.filter((r) => r.marks[0].stops > 0);
    return [
      {
        id: 'spiky-prop-real',
        title: 'spikes: real target, mid, 25 ms × (s/0.85)², σ 0.2 τ 1 s + spikes, 30 s',
        o: real,
        phases: [sw(pixels(25, 0.85), 30)],
        metrics: [
          ['stopped wrongly', (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length)],
          [
            'still stopped at 30 s',
            (rs) => frac(rs.filter((r) => r.marks[0].stoppedAtEnd).length, rs.length),
          ],
        ],
      },
      {
        id: 'spiky-flat-real',
        title: 'spikes: real target, mid, 25 ms flat, σ 0.2 τ 1 s + spikes, 30 s',
        o: real,
        phases: [sw(flat(25), 30)],
        metrics: [
          ['stopped within 30 s', (rs) => frac(rs.filter((r) => r.marks[0].stops > 0).length, rs.length)],
        ],
      },
      {
        id: 'spiky-noresume-t6',
        title: 'spikes: target 6, high, 5.3 ms flat + spikes for 15 s, then the same for 120 s',
        o: t6high,
        phases: [sw(flat(5.3), 15), sw(flat(5.3), 120)],
        metrics: [
          ['stopped in the first phase', (rs) => frac(stoppedFirst(rs).length, rs.length)],
          [
            'resumed within 120 s (of those)',
            (rs) =>
              frac(stoppedFirst(rs).filter((r) => r.marks[1].resumes > 0).length, stoppedFirst(rs).length),
          ],
        ],
      },
      ...[
        ['spiky-resume-t6', '5.3 ms flat, then 9.5 ms × s²', 5.3, 9.5],
        ['spiky-resume-t6-145', '6.5 ms flat, then 9.3 ms × s² (1.45×, the S-11 closed loop)', 6.5, 9.3],
      ].map(([id, what, lightMs, heavyMs]) => ({
        id,
        title: `spikes: target 6, high: ${what}, σ 0.2 τ 1 s + spikes; the new load 3 s after the stop`,
        o: t6high,
        phases: [
          sw(flat(lightMs), 30, { untilStop: true }),
          sw(flat(lightMs), 3),
          sw(pixels(heavyMs, 1), 30),
        ],
        metrics: [
          ['stopped in the first phase', (rs) => frac(stoppedFirst(rs).length, rs.length)],
          [
            'resumed within 30 s (of those)',
            (rs) =>
              frac(stoppedFirst(rs).filter((r) => r.marks[2].resumes > 0).length, stoppedFirst(rs).length),
          ],
          [
            'median time to resume',
            (rs) =>
              sec(
                median(
                  stoppedFirst(rs)
                    .map((r) => r.marks[2].firstResume)
                    .filter((t) => t !== null),
                ),
              ),
          ],
        ],
      })),
    ].map((sc) => ({ ...sc, group: 'spiky', prime: 999983 }));
  })(),
  // P2-2: a long session on a load that follows the pixels: stops, resumes, the cap, time spent stopped (300 s)
  ...[
    ['session-25-s02-t1', '25 ms × (s/0.85)², σ 0.2 τ 1 s', 25, 0.2, 1],
    ['session-25-s03-t2', '25 ms × (s/0.85)², σ 0.3 τ 2 s', 25, 0.3, 2],
    ['session-18-s02-t2', '18 ms × (s/0.85)², σ 0.2 τ 2 s', 18, 0.2, 2],
  ].map(([id, title, ms, sigma, tau]) => ({
    id,
    group: 'session',
    title: `300 s, real target, mid, follows the pixels: ${title}`,
    o: real,
    phases: [{ seconds: 300, cost: pixels(ms, 0.85), sigma, tau }],
    prime: 7727,
    runs: Math.min(runs, 100),
    metrics: [
      [
        'off for the session at 300 s (resume cap used up)',
        (rs) => frac(rs.filter((r) => r.marks[0].offForSession).length, rs.length),
      ],
      [
        'GPU time turned implausible (the plausibility check of S-05, not S-13)',
        (rs) => frac(rs.filter((r) => r.marks[0].implausible).length, rs.length),
      ],
      [
        'mean stops / resumes',
        (rs) =>
          `${(rs.reduce((a, r) => a + r.marks[0].stops, 0) / rs.length).toFixed(2)} / ${(rs.reduce((a, r) => a + r.marks[0].resumes, 0) / rs.length).toFixed(2)}`,
      ],
      [
        'time stopped at an overload (share)',
        (rs) => pct(rs.reduce((a, r) => a + r.marks[0].stoppedOverMs / r.marks[0].ms, 0) / rs.length),
      ],
    ],
  })),
];

const groups = [...new Set(scenarios.map((s) => s.group))];
const header = `| scenario | metric | ${versions.map((v) => v.name).join(' | ')} |`;
console.log(`runs per scenario: ${runs} (sessions: ${Math.min(runs, 100)})\n`);
console.log(header);
console.log(`|---|---|${versions.map(() => '---').join('|')}|`);
for (const group of groups) {
  if (only.length && !only.includes(group)) continue;
  for (const sc of scenarios.filter((s) => s.group === group)) {
    const n = sc.runs ?? runs;
    const results = versions.map((v) =>
      Array.from({ length: n }, (_, k) => session(v.mod, sc.o, sc.phases, (k + 1) * sc.prime)),
    );
    for (const [i, [label, fn]] of sc.metrics.entries()) {
      const cells = results.map((rs) => fn(rs));
      console.log(`| ${i === 0 ? `\`${sc.id}\` ${sc.title}` : ''} | ${label} | ${cells.join(' | ')} |`);
    }
  }
}
