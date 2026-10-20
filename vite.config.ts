import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1600 },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
