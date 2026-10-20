#!/usr/bin/env node
// Real-GPU benchmark for the M0 gate (技術設計 > 性能の目標と予算: 1080p・中品質・60fps).
// Opens a visible browser at 1920×1080 with vsync and the frame-rate limit lifted, runs every scene at
// low/mid/high on WebGPU and WebGL2, and writes artifacts/bench-headed.md + .json. Run `pnpm build` first.
//   SCENES=stress QUALITIES=mid BACKENDS=webgpu BENCH_SECONDS=5 node scripts/bench-headed.mjs
//   DPR=2      device pixel ratio (2 = 4× the pixels, a GPU-bound check)
//   VSYNC=1    keep vsync and the 60 Hz cap (what the governor sees at run time)
//   OUT=name   write artifacts/<name>.md + .json instead of bench-headed
//   QUERY=&x=1 extra URL switches for every page (e.g. &gpuSpan=0 to measure without the frame span)
//
// Primary metric: uncapped frame time. With vsync off, frames are limited by back-pressure, so the frame time
// is the real per-frame cost (max of CPU and GPU). The GPU frame span (WebGPU, first pass start → last pass end,
// S-08) is the GPU time the governor uses; it should stay at or below the frame time and grow with load.
// three's per-pass timestamp sum is shown for reference only: the passes overlap on some GPUs (Apple/Metal read
// ~10× too high in S-05).
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  contendingBrowsers,
  GPU_ARGS,
  startPreview,
  UNCAPPED_ARGS,
  worktreePort,
} from './lib/preview-server.mjs';

const root = process.cwd();
const list = (v, d) => (v ? v.split(',').filter(Boolean) : d);
const scenes = list(
  process.env.SCENES,
  readdirSync(join(root, 'src/scenes'))
    .filter((f) => f.endsWith('.scene.ts'))
    .map((f) => f.replace(/\.scene\.ts$/, ''))
    .sort(),
);
const qualities = list(process.env.QUALITIES, ['low', 'mid', 'high']);
const backends = list(process.env.BACKENDS, ['webgpu', 'webgl2']);
const seconds = Number(process.env.BENCH_SECONDS ?? 5);
const dpr = Number(process.env.DPR ?? 1);
const vsync = process.env.VSYNC === '1';
const outName = process.env.OUT ?? 'bench-headed';
const extraQuery = process.env.QUERY ?? '';
const BUDGET_MS = (1000 / 60) * 0.8;

// Other browsers on the same GPU distort every number here. QUIET=1 refuses to measure under contention.
const busyBefore = contendingBrowsers();
if (busyBefore > 0) {
  console.warn(
    `warning: ${busyBefore} other Playwright browser(s) are using the GPU; results will be marked as contended`,
  );
  if (process.env.QUIET === '1') process.exit(3);
}
const server = await startPreview(worktreePort(311));
const rows = [];
let browser;
try {
  browser = await chromium.launch({
    channel: 'chromium',
    headless: false,
    args: [...GPU_ARGS, ...(vsync ? [] : UNCAPPED_ARGS)],
  });
  for (const scene of scenes) {
    for (const backend of backends) {
      for (const quality of qualities) {
        const page = await browser.newPage({
          viewport: { width: 1920, height: 1080 },
          deviceScaleFactor: dpr,
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        const webgl = backend === 'webgl2' ? '&webgl=1' : '';
        await page.goto(
          `${server.url}?scene=${scene}&quality=${quality}&bench=${seconds}&warmup=2&dynres=0${webgl}${extraQuery}`,
        );
        await page
          .waitForFunction(() => ['done', 'error'].includes(window.__vidro?.status), undefined, {
            timeout: 120_000,
          })
          .catch(() => errors.push('timeout'));
        const p = await page.evaluate(() => window.__vidro);
        const b = p?.bench;
        rows.push({
          scene,
          backend: p?.backend ?? backend,
          quality,
          frameAvgMs: b?.avgMs ?? null,
          frameP95Ms: b?.p95Ms ?? null,
          spanAvgMs: b?.gpuSpan?.avgMs ?? null,
          spanP95Ms: b?.gpuSpan?.p95Ms ?? null,
          gpuAvgMs: b?.gpu?.avgMs ?? null,
          draws: b?.maxDrawCalls ?? 0,
          tris: b?.maxTriangles ?? 0,
          errors: errors.length,
        });
        const r = rows[rows.length - 1];
        console.log(
          `${scene} ${r.backend} ${quality}: frame ${r.frameAvgMs?.toFixed(2)} ms (p95 ${r.frameP95Ms?.toFixed(2)}), span ${r.spanAvgMs?.toFixed(2) ?? 'n/a'} ms (p95 ${r.spanP95Ms?.toFixed(2) ?? 'n/a'}), pass sum ${r.gpuAvgMs?.toFixed(2) ?? 'n/a'} ms, errors ${r.errors}`,
        );
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  server.stop();
}
const busyAfter = contendingBrowsers();
const contended = busyBefore !== 0 || busyAfter !== 0;

const fmt = (v, d = 2) => (v == null ? 'n/a' : v.toFixed(d));
const lines = [
  `# 実機ベンチ（ヘッドあり、1920×1080×DPR ${dpr}、垂直同期${vsync ? 'あり' : 'なし'}）`,
  '',
  `${new Date().toISOString()} · ${cpus()[0]?.model ?? 'unknown CPU'} · ${seconds}秒/条件${extraQuery ? ` · 追加のスイッチ \`${extraQuery}\`` : ''}`,
  '',
  contended
    ? `**混雑した状態の計測**: ほかのブラウザが GPU を使っていた（前 ${busyBefore} / 後 ${busyAfter}）。数値は比較に使わない。`
    : '静かな状態で計測した（ほかのブラウザなし、前後とも確認）。',
  '',
  vsync
    ? '垂直同期ありの計測（実行時に governor が見る値）。フレーム時間は 60Hz に張り付くので余裕の判定はしない。'
    : `主な指標は垂直同期を外したフレーム時間（CPUとGPUの重い方）。p95 が ${BUDGET_MS.toFixed(1)}ms（60fpsの80%）以下なら余裕あり。`,
  'GPU span はフレームの最初のパスの開始から最後のパスの終わりまで（WebGPU のみ、実行時の判断に使う GPU 時間）。',
  'パス合計は three のタイムスタンプの合計で参考値（描画パスが重なる GPU では過大になる）。',
  '',
  '| シーン | 経路 | 品質 | フレーム平均 ms | フレーム p95 ms | GPU span 平均 ms | GPU span p95 ms | パス合計 平均 ms（参考） | 描画呼び出し | 三角形 | 余裕 | エラー |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.scene} | ${r.backend} | ${r.quality} | ${fmt(r.frameAvgMs)} | ${fmt(r.frameP95Ms)} | ${fmt(r.spanAvgMs)} | ${fmt(r.spanP95Ms)} | ${fmt(r.gpuAvgMs)} | ${r.draws} | ${Math.round(r.tris / 1000)}k | ${vsync ? '-' : r.frameP95Ms == null ? '?' : r.frameP95Ms <= BUDGET_MS ? 'あり' : 'なし'} | ${r.errors} |`,
  ),
  '',
];
mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(join(root, `artifacts/${outName}.md`), lines.join('\n'));
writeFileSync(
  join(root, `artifacts/${outName}.json`),
  JSON.stringify({ contended, busyBefore, busyAfter, dpr, vsync, extraQuery, rows }, null, 2),
);
console.log(`\nwrote artifacts/${outName}.md`);
