// Loads TypeScript modules of this repository into a node script, from the working tree or from a git commit, so a
// simulation can drive the code before and after a change side by side. Each module and the relative imports it
// pulls in are transformed with vite's oxc transform (already a dev dependency; node's own type stripping rejects
// parameter properties) and written as .mjs files into a temporary directory, removed when the process exits.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';

const root = process.cwd();
const outRoot = mkdtempSync(join(tmpdir(), 'vidro-sim-'));
process.on('exit', () => rmSync(outRoot, { recursive: true, force: true }));

const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

function readSource(ref, path) {
  if (!ref) return readFileSync(join(root, path), 'utf8');
  return execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
}

/**
 * Imports `entry` (a repository path such as 'src/core/perf/governor.ts') as it is in the working tree (`ref` null)
 * or at a git commit, and returns the module namespace.
 */
export async function loadTs(entry, ref = null) {
  const tag = ref
    ? execFileSync('git', ['rev-parse', '--short', ref], { cwd: root, encoding: 'utf8' }).trim()
    : 'worktree';
  const base = join(outRoot, tag);
  const done = new Set();
  const queue = [entry];
  while (queue.length) {
    const path = queue.pop();
    if (done.has(path)) continue;
    done.add(path);
    const { code } = await transformWithOxc(readSource(ref, path), path, { lang: 'ts' });
    const out = code.replace(RELATIVE_IMPORT, (_m, head, quote, spec) => {
      queue.push(posix.join(posix.dirname(path), `${spec}.ts`));
      return `${head}${quote}${spec}.mjs${quote}`;
    });
    const file = join(base, path.replace(/\.ts$/, '.mjs'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out);
  }
  return import(pathToFileURL(join(base, entry.replace(/\.ts$/, '.mjs'))).href);
}
