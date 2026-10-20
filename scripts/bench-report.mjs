#!/usr/bin/env node
// Prints artifacts/bench/*.json as one table so a loop iteration can read the sensor at a glance.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'artifacts/bench');
let files = [];
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
} catch {
  console.log('no bench results (run pnpm e2e first)');
  process.exit(0);
}
const rows = files.map((f) => {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const b = r.bench ?? {};
  return {
    scene: f.replace(/\.json$/, ''),
    backend: r.backend ?? '-',
    status: r.status,
    fps: b.avgFps ? b.avgFps.toFixed(1) : '-',
    p95ms: b.p95Ms ? b.p95Ms.toFixed(1) : '-',
    spanMs: b.gpuSpan ? b.gpuSpan.avgMs.toFixed(2) : '-',
    draws: b.maxDrawCalls ?? '-',
    ktris: b.maxTriangles != null ? Math.round(b.maxTriangles / 1000) : '-',
    budget: (b.budgetViolations ?? []).length ? 'OVER' : 'ok',
    errors: (r.errors?.length ?? 0) + (r.pageErrors?.length ?? 0),
  };
});
console.table(rows);
