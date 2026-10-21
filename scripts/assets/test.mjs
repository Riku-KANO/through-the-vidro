#!/usr/bin/env node
// Checks of the asset pipeline itself (`pnpm assets:test`). Separate from scripts/check.sh, which must stay green
// without Blender and KTX-Software (check.sh reads the committed glb files instead).
//   1. the helpers of scripts/assets (node:test)
//   2. the Python of blender/scripts (unittest inside Blender: naming rules with the cases shared with the game,
//      triangle budget, triangle count after modifiers, second UV)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runBlender } from './lib.mjs';

const root = process.cwd();
const step = (title) => console.log(`\n▶ ${title}`);

step('scripts/assets (node:test)');
const node = spawnSync(process.execPath, ['--test', join(root, 'scripts/assets/lib.test.mjs')], {
  stdio: 'inherit',
});
if (node.status !== 0) process.exit(1);

step('blender/scripts (unittest in Blender)');
const r = runBlender({ script: join(root, 'blender/scripts/tests/run.py') });
const log = `${r.stdout}${r.stderr}`;
const lines = log.split('\n').filter((l) => / \.\.\. |^Ran |^OK|^FAILED|Error|Traceback|^ {2}File /.test(l));
console.log(lines.join('\n'));
if (r.status !== 0) {
  console.error(log.slice(-4000));
  process.exit(1);
}
console.log('\nALL OK');
