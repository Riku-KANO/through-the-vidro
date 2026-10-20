// Shared by the bench scripts: serve dist/ with `vite preview` on a port owned by this worktree,
// fail fast if it cannot start, and always stop the whole process group.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Same derivation as playwright.config.ts, shifted so scripts and the e2e sensor never collide. */
export function worktreePort(offset) {
  return (
    Number(process.env.SENSOR_PORT) ||
    4200 + ((createHash('sha1').update(process.cwd()).digest().readUInt16BE(0) + offset) % 700)
  );
}

export async function startPreview(port) {
  const vite = join(process.cwd(), 'node_modules/.bin/vite');
  if (!existsSync(join(process.cwd(), 'dist/index.html')))
    throw new Error('dist/ missing: run `pnpm build` first');
  const child = spawn(vite, ['preview', '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid);
    } catch {}
  };
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 75; i++) {
    if (exited) throw new Error(`vite preview exited on port ${port}: ${stderr.trim()}`);
    try {
      if ((await fetch(url)).ok) return { url, stop };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error(`vite preview did not answer on ${url}`);
}

export const GPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--use-angle=metal',
];
/** Lifts the 60 Hz cap so frame time shows real throughput (max of CPU and GPU under back-pressure). */
export const UNCAPPED_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];
