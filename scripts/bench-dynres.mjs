#!/usr/bin/env node
// Closed-loop check of dynamic resolution on real hardware: opens one scene in a visible 1920×1080 browser with
// dynamic resolution on, and prints the render scale and the GPU time the governor sees once a second.
// Shows whether the GPU time follows the resolution and where the controller settles. Run `pnpm build` first.
//   node scripts/bench-dynres.mjs '?scene=stress&quality=mid&dynresTarget=3'
//   DPR=2       device pixel ratio (2 = 4× the pixels, makes the scene GPU-bound)
//   UNCAPPED=1  lift vsync (frames run back to back; with vsync the span reads longer, S-08)
//   SECONDS=25  how long to watch
//   GROW_AT=8   start at 960×540 and grow the window to 1920×1080 after this many seconds: an overload that starts
//               mid-session (the response check must keep lowering then, S-08 review round 2)
//   QUIET=1     refuse to run while other Playwright browsers use the GPU (exit 3)
// Dynamic resolution stops (back at the preset scale) when three steps down do not lower the GPU time; add
// &dynresResponse=0 to watch the controller without that check.
import { chromium } from '@playwright/test';
import {
  contendingBrowsers,
  GPU_ARGS,
  startPreview,
  UNCAPPED_ARGS,
  worktreePort,
} from './lib/preview-server.mjs';

const query = process.argv[2];
if (!query) {
  console.error("usage: node scripts/bench-dynres.mjs '?scene=<name>&quality=mid&dynresTarget=<ms>'");
  process.exit(2);
}
const seconds = Number(process.env.SECONDS ?? 25);
const dpr = Number(process.env.DPR ?? 1);
const uncapped = process.env.UNCAPPED === '1';
const growAt = process.env.GROW_AT ? Number(process.env.GROW_AT) : null;
const FULL = { width: 1920, height: 1080 };
const SMALL = { width: 960, height: 540 };

const busyBefore = contendingBrowsers();
if (busyBefore > 0) {
  console.warn(`warning: ${busyBefore} other Playwright browser(s) are using the GPU`);
  if (process.env.QUIET === '1') process.exit(3);
}
const server = await startPreview(worktreePort(433));
let browser;
try {
  browser = await chromium.launch({
    channel: 'chromium',
    headless: false,
    args: [...GPU_ARGS, ...(uncapped ? UNCAPPED_ARGS : [])],
  });
  const page = await browser.newPage({ viewport: growAt === null ? FULL : SMALL, deviceScaleFactor: dpr });
  await page.goto(`${server.url}${query}&dynres=1`);
  await page.waitForFunction(() => ['running', 'error'].includes(window.__vidro?.status), undefined, {
    timeout: 30_000,
  });
  console.log(
    `${query}&dynres=1  DPR ${dpr}  vsync ${uncapped ? 'off' : 'on'}${growAt === null ? '' : `  960×540 → 1920×1080 at ${growAt}s`}`,
  );
  for (let i = 0; i <= seconds; i++) {
    const p = await page.evaluate(() => ({
      status: window.__vidro.status,
      scale: window.__vidro.renderScale,
      gpuMs: window.__vidro.gpuMs,
      source: window.__vidro.gpuSource,
      reliable: window.__vidro.gpuReliable,
      cpu: window.__vidro.cpuRenderMs,
      stopped: window.__vidro.dynresStopped,
      errors: window.__vidro.errors.length,
    }));
    console.log(
      `t=${String(i).padStart(2)}s  scale ${p.scale.toFixed(2)}  gpu(${p.source}) ${p.gpuMs?.toFixed(2) ?? 'n/a'} ms  cpu render ${p.cpu?.toFixed(2) ?? 'n/a'} ms  reliable=${p.reliable}  errors ${p.errors}${p.stopped ? `  stopped: ${p.stopped}` : ''}`,
    );
    if (p.status === 'error') break;
    if (i === growAt) {
      await page.setViewportSize(FULL);
      console.log(`       window grown to ${FULL.width}×${FULL.height}`);
    }
    await page.waitForTimeout(1000);
  }
} finally {
  await browser?.close();
  server.stop();
}
const busyAfter = contendingBrowsers();
console.log(
  busyBefore || busyAfter
    ? `contended: other browsers before ${busyBefore} / after ${busyAfter}; do not compare the numbers`
    : 'quiet: no other browsers before or after',
);
