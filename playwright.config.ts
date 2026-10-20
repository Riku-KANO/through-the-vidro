import { defineConfig } from '@playwright/test';

/**
 * Browser sensor. Builds once, serves dist/ with `vite preview`, opens every scene
 * and records a screenshot + bench JSON under artifacts/.
 * HEADED=1 runs a visible browser (closer to real GPU timing).
 */
const headed = process.env.HEADED === '1';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    headless: !headed,
    channel: 'chromium',
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
    },
  },
  webServer: {
    command: 'pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
