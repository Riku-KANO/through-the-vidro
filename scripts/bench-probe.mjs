#!/usr/bin/env node
// Quick sensor for one or more URLs: serves dist/, opens each query string, prints status, errors and bench.
//   node scripts/bench-probe.mjs '?scene=stress&bench=2' '?scene=stress&bench=2&peek=0'
// HEADED=1 uses a visible browser. UNCAPPED=1 lifts vsync so frame time shows real throughput.
// FPS=<n> paces animation frames at n per second like a display of that refresh rate (lifts vsync to get there;
// the page idles between frames, so timers and readbacks run as they would there; S-20).
// Run `pnpm build` first.
import { chromium } from '@playwright/test';
import { GPU_ARGS, startPreview, UNCAPPED_ARGS, worktreePort } from './lib/preview-server.mjs';

const queries = process.argv.slice(2);
if (queries.length === 0) {
  console.error('usage: node scripts/bench-probe.mjs "?scene=<name>&bench=2" [...]');
  process.exit(2);
}
const fpsCap = Number(process.env.FPS) || 0;

/**
 * Runs in the page before its scripts: every requestAnimationFrame callback waits for the next slot of a fixed
 * frame clock (1000 / fps ms apart), all of a slot's callbacks run together, and the thread idles until then.
 * A frame that runs late is not made up for with a burst.
 */
function paceAnimationFrames(fps) {
  const interval = 1000 / fps;
  const raf = window.requestAnimationFrame.bind(window);
  let queue = [];
  let pending = false;
  let slot = performance.now();
  let nextId = 1;
  const flush = (t) => {
    pending = false;
    const run = queue;
    queue = [];
    for (const { cb } of run) cb(t);
  };
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.push({ id, cb });
    if (!pending) {
      pending = true;
      const now = performance.now();
      slot = Math.max(slot + interval, now);
      setTimeout(() => raf(flush), Math.max(0, slot - now));
    }
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queue = queue.filter((e) => e.id !== id);
  };
}

const server = await startPreview(worktreePort(157));
let browser;
try {
  browser = await chromium.launch({
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    args: [...GPU_ARGS, ...(process.env.UNCAPPED === '1' || fpsCap ? UNCAPPED_ARGS : [])],
  });
  if (fpsCap) console.log(`frames paced at ${fpsCap} fps`);
  for (const q of queries) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    if (fpsCap) await page.addInitScript(paceAnimationFrames, fpsCap);
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
      `\n${q}  →  ${p?.status} ${p?.backend} ${p?.quality} ×${p?.renderScale} gpu=${p?.gpuSource} gpuReliable=${p?.gpuReliable}`,
    );
    if (b) {
      const span = b.gpuSpan
        ? ` span avg ${b.gpuSpan.avgMs.toFixed(2)} p95 ${b.gpuSpan.p95Ms.toFixed(2)} ms`
        : ' span n/a';
      const gpu = b.gpu
        ? `${span}, pass sum avg ${b.gpu.avgMs.toFixed(2)} p95 ${b.gpu.p95Ms.toFixed(2)} ms`
        : `${span}, pass sum n/a`;
      const cpu = b.cpuRenderMs ? `, cpu render avg ${b.cpuRenderMs.avgMs.toFixed(2)} ms` : '';
      console.log(
        `  frame avg ${b.avgMs.toFixed(2)} p95 ${b.p95Ms.toFixed(2)} ms (${b.avgFps.toFixed(1)} fps)${gpu}${cpu}  draws ${b.maxDrawCalls} tris ${b.maxTriangles}`,
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
