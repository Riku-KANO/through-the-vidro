import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defineConfig } from '@playwright/test';

/**
 * Browser sensor. Builds once, serves dist/ with `vite preview`, opens every scene
 * and records a screenshot + bench JSON under artifacts/.
 * HEADED=1 runs a visible browser (closer to real GPU timing).
 */
const headed = process.env.HEADED === '1';

/** The sensors' ports: a worktree's path hashes to one of them. */
const PORT_BASE = 4200;
const PORT_SPAN = 700;

/**
 * Run in a Node of its own (the config is read synchronously): from the port the path hashes to, the first one nothing
 * listens on, on either loopback address (`vite preview` listens on `localhost`, ::1 or 127.0.0.1). An address family the
 * machine lacks counts as free.
 */
const FIND_FREE = `
const net = require('node:net');
const [base, span, start] = process.argv.slice(1).map(Number);
const free = (port, host) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
  s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
});
(async () => {
  for (let i = 0; i < span; i++) {
    const port = base + ((start + i) % span);
    if ((await free(port, '127.0.0.1')) && (await free(port, '::1'))) return process.stdout.write(String(port));
  }
  process.stdout.write(String(base + start));
})();
`;

/**
 * Each worktree gets its own preview port so parallel slices never test each other's build: the one its path hashes to,
 * or, when that one is taken (S-48: two worktrees' hashes met on 4371 in S-43), the next free one after it. Chosen once,
 * by the runner, which puts it in SENSOR_PORT: the workers inherit it (they read this file again while the runner's own
 * preview server already holds the port). SENSOR_PORT set by hand still wins.
 */
function sensorPort(): number {
  const fixed = Number(process.env.SENSOR_PORT);
  if (fixed) return fixed;
  const start = createHash('sha1').update(process.cwd()).digest().readUInt16BE(0) % PORT_SPAN;
  let port = PORT_BASE + start;
  try {
    const found = Number(
      execFileSync(process.execPath, ['-e', FIND_FREE, String(PORT_BASE), String(PORT_SPAN), String(start)], {
        encoding: 'utf8',
        timeout: 10_000,
      }).trim(),
    );
    if (Number.isInteger(found) && found > 0) port = found;
  } catch {
    // the hashed port, as before S-48
  }
  process.env.SENSOR_PORT = String(port);
  return port;
}

const port = sensorPort();

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 720 },
    headless: !headed,
    channel: 'chromium',
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
    },
  },
  webServer: {
    command: `pnpm exec vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
