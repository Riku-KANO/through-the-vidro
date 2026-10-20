#!/usr/bin/env node
// Quick sensor for one or more URLs: serves dist/, opens each query string, prints status, errors and bench.
//   node scripts/bench-probe.mjs '?scene=stress&bench=2' '?scene=stress&bench=2&peek=0'
// HEADED=1 uses a visible browser. UNCAPPED=1 lifts vsync so frame time shows real throughput.
// Run `pnpm build` first.
import { chromium } from '@playwright/test';
import { GPU_ARGS, startPreview, UNCAPPED_ARGS, worktreePort } from './lib/preview-server.mjs';

const queries = process.argv.slice(2);
if (queries.length === 0) {
  console.error('usage: node scripts/bench-probe.mjs "?scene=<name>&bench=2" [...]');
  process.exit(2);
}
const server = await startPreview(worktreePort(157));
let browser;
try {
  browser = await chromium.launch({
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    args: [...GPU_ARGS, ...(process.env.UNCAPPED === '1' ? UNCAPPED_ARGS : [])],
  });
  for (const q of queries) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = new Map();
    const note = (m) => errors.set(m.slice(0, 160), (errors.get(m.slice(0, 160)) ?? 0) + 1);
    page.on('pageerror', (e) => note(e.message));
    page.on(
      'console',
      (m) => (m.type() === 'error' || m.type() === 'warning') && note(`[${m.type()}] ${m.text()}`),
    );
    await page.goto(server.url + q);
    await page
      .waitForFunction(() => ['done', 'error'].includes(window.__vidro?.status), undefined, {
        timeout: 60_000,
      })
      .catch(() => note('timeout waiting for done'));
    const p = await page.evaluate(() => window.__vidro);
    const b = p?.bench;
    console.log(
      `\n${q}  →  ${p?.status} ${p?.backend} ${p?.quality} ×${p?.renderScale} gpuReliable=${p?.gpuReliable}`,
    );
    if (b) {
      const gpu = b.gpu
        ? ` gpu ts avg ${b.gpu.avgMs.toFixed(2)} p95 ${b.gpu.p95Ms.toFixed(2)} ms`
        : ' gpu n/a';
      console.log(
        `  frame avg ${b.avgMs.toFixed(2)} p95 ${b.p95Ms.toFixed(2)} ms (${b.avgFps.toFixed(1)} fps)${gpu}  draws ${b.maxDrawCalls} tris ${b.maxTriangles}`,
      );
    }
    if (p?.qualityDecision)
      console.log('  quality', JSON.stringify(p.qualityDecision), 'verified', p.qualityVerified);
    for (const [m, n] of errors) console.log(`  ${n}× ${m}`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.stop();
}
