#!/usr/bin/env node
// Runs the three.js reproduction pages headless (WebGPU and WebGL2) for each three build and prints a table.
//   node tools/three-repro/run.mjs                    three 0.186.1 and dev
//   THREE=0.186.1,dev,<sha> node tools/three-repro/run.mjs
//   CASES=S-05 node tools/three-repro/run.mjs         only the cases whose label starts with one of these
//   HEADED=1                                          show the browser
// The pages load three from jsDelivr, so this needs the network. Errors are counted twice: by the page itself
// (window.__repro) and from the browser console here (the WebGL2 "deleted object" warning is only visible here).
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { GPU_ARGS } from '../../scripts/lib/preview-server.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const builds = (process.env.THREE ?? '0.186.1,dev').split(',').filter(Boolean);
const backends = [
  ['webgpu', ''],
  ['webgl2', '&webgl=1'],
];
const cases = [
  ...[0, 1].map((fix) => ({ page: 's12-backdrop-resize.html', label: `S-12 fix=${fix}`, query: `fix=${fix}` })),
  ...['half', 'full'].map((rt) => ({
    page: 's05-transmission-rt-size.html',
    label: `S-05 rt=${rt}`,
    query: `mode=pipeline&rt=${rt}`,
  })),
  { page: 's05-transmission-rt-size.html', label: 'S-05 rt=half seq', query: 'mode=seq&rt=half' },
  ...['half', 'full'].map((rt) => ({
    page: 's05-transmission-rt-size.html',
    label: `S-05 reflector rt=${rt}`,
    query: `mode=reflector&rt=${rt}`,
  })),
  ...['up', 'down'].flatMap((dir) =>
    [0, 1].map((fix) => ({
      page: 's29-backdrop-shared-size.html',
      label: `S-29 ${dir} fix=${fix}`,
      query: `dir=${dir}&fix=${fix}`,
    })),
  ),
];
const only = process.env.CASES?.split(',');

const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  const path = normalize(join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(dir) || !types[extname(path)]) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(path)] });
  createReadStream(path).on('error', () => res.end()).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chromium', headless: process.env.HEADED !== '1', args: GPU_ARGS });
const rows = [];
try {
  for (const three of builds) {
    for (const c of cases.filter((x) => !only || only.some((o) => x.label.startsWith(o)))) {
      for (const [backend, flag] of backends) {
        const page = await browser.newPage();
        const consoleHits = { destroyed: 0, deleted: 0, copy: 0 };
        page.on('console', (m) => {
          const t = m.text();
          if (t.includes('Destroyed texture')) consoleHits.destroyed++;
          if (t.includes('deleted object')) consoleHits.deleted++;
          // S-29: WebGPU "Texture copy range … touches outside", WebGL2 "glCopyTexSubImage2D: Offset overflows"
          if (/touches outside|Offset overflows/.test(t)) consoleHits.copy++;
        });
        let r = null;
        let failure = '';
        try {
          await page.goto(`${origin}/${c.page}?three=${three}&${c.query}${flag}`);
          await page.waitForFunction(() => window.__repro?.done === true, undefined, { timeout: 60_000 });
          r = await page.evaluate(() => window.__repro);
        } catch (e) {
          failure = String(e.message ?? e).split('\n')[0];
        }
        await page.close();
        rows.push({
          three,
          revision: r?.revision ?? '-',
          case: c.label,
          backend: r?.backend ?? backend,
          destroyed: r?.destroyed ?? '-',
          glErrors: r?.glErrors ?? '-',
          recreated: r?.recreated ?? '-',
          stale: r?.stale ?? '-',
          'console destroyed': consoleHits.destroyed,
          'console deleted': consoleHits.deleted,
          'console copy': consoleHits.copy,
          ...(failure ? { failure } : {}),
        });
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.table(rows);
