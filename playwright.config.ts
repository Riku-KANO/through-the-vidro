import { createHash } from 'node:crypto';
import { defineConfig } from '@playwright/test';

/**
 * Browser sensor. Builds once, serves dist/ with `vite preview`, opens every scene
 * and records a screenshot + bench JSON under artifacts/.
 * HEADED=1 runs a visible browser (closer to real GPU timing).
 */
const headed = process.env.HEADED === '1';

// Each worktree gets its own preview port so parallel slices never test each other's build.
const port =
  Number(process.env.SENSOR_PORT) ||
  4200 + (createHash('sha1').update(process.cwd()).digest().readUInt16BE(0) % 700);

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
