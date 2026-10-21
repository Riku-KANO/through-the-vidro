#!/usr/bin/env node
// Builds the pipeline's sample .blend by script (S-23): `pnpm assets:sample`, then `pnpm assets` to export it.
// Overwrites blender/scenes/asset-lab.blend (changes made by hand in Blender are lost).
import { join } from 'node:path';
import { runBlender } from './lib.mjs';

const root = process.cwd();
const r = runBlender({
  script: join(root, 'blender/scripts/make_sample.py'),
  args: ['--out', join(root, 'blender/scenes/asset-lab.blend')],
});
const log = `${r.stdout}${r.stderr}`;
if (r.status !== 0) {
  console.error(log.slice(-4000));
  process.exit(1);
}
for (const line of log.split('\n')) if (line.startsWith('[vidro]')) console.log(line);
