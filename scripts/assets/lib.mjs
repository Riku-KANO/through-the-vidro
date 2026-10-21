// Helpers of the asset pipeline (S-23): where Blender is, which KTX-Software is usable, what to print.
// Pure functions plus thin wrappers around child processes; unit tests in lib.test.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where Blender lives unless BLENDER says otherwise (macOS app; it is not on PATH). */
export const DEFAULT_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';

export function blenderPath(env = process.env) {
  return env.BLENDER || DEFAULT_BLENDER;
}

/**
 * The KTX-Software that @gltf-transform/cli 4.5 needs: its KTX_SOFTWARE_VERSION_MIN, and it runs the `ktx` CLI
 * (`ktx create`), not `toktx`. lib.test.mjs checks both against the installed CLI, so an upgrade that changes them fails.
 */
export const KTX_MIN_VERSION = [4, 4, 0];
export const KTX_COMMAND = 'ktx';

/** The installed @gltf-transform/cli version. */
export function gltfTransformVersion() {
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), 'node_modules/@gltf-transform/cli/package.json'), 'utf8'),
  );
  return pkg.version;
}

/** [major, minor, patch] from what `ktx --version` prints, or null. */
export function parseKtxVersion(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function ktxVersionOk(version) {
  if (!version) return false;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== KTX_MIN_VERSION[i]) return version[i] > KTX_MIN_VERSION[i];
  }
  return true;
}

/** The installed `ktx` (KTX-Software): its version and whether gltf-transform can use it. */
export function findKtx() {
  const r = spawnSync(KTX_COMMAND, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { found: false, version: null, text: '', ok: false };
  const text = `${r.stdout}${r.stderr}`.trim();
  const version = parseKtxVersion(text);
  return { found: true, version, text, ok: ktxVersionOk(version) };
}

/** glb files in an output folder that this run did not write (a group that is gone). */
export function staleOutputs(files, groups) {
  return files.filter((f) => f.endsWith('.glb') && !groups.includes(f.slice(0, -'.glb'.length)));
}

export function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}

const count = (n) => n.toLocaleString('en-US');
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

/** The pipeline's report (blender/scripts/pipeline.py) as lines for the terminal. */
export function reportLines(report) {
  const out = [];
  const problems = report.problems ?? [];
  out.push(
    `naming (設計書 命名規則とゲーム情報): ${problems.length ? `${problems.length} problem(s)` : 'ok'}`,
  );
  for (const p of problems) out.push(`  ✗ ${pad(p.object, 28)} ${pad(p.code, 18)} ${p.message ?? ''}`);
  for (const w of report.warnings ?? [])
    out.push(`  ! ${pad(w.object, 28)} ${pad(w.code, 18)} ${w.message ?? ''}`);
  const objects = report.budget?.objects ?? [];
  out.push('triangles (設計書 ポリゴンとテクスチャの予算; after modifiers)');
  const width = Math.max(10, ...objects.map((o) => o.name.length));
  for (const o of objects) {
    out.push(
      `  ${pad(o.name, width)}  ${pad(o.category, 14)} ${lpad(count(o.triangles), 9)} / ${lpad(count(o.limit), 9)}${o.over ? '  OVER' : ''}`,
    );
  }
  for (const a of report.budget?.areas ?? []) {
    out.push(
      `  area ${pad(a.group, width - 5)}  ${pad('', 14)} ${lpad(count(a.triangles), 9)} / ${lpad(count(a.limit), 9)}${a.over ? '  OVER' : ''}`,
    );
  }
  const uv2 = Object.entries(report.uv2 ?? {});
  out.push(`second UV (Lightmap, TEXCOORD_1): ${uv2.length} object(s)`);
  for (const [name, action] of uv2) out.push(`  ${pad(name, width)}  ${action}`);
  return out;
}

/** Runs Blender in the background on a .blend (or an empty factory scene) with a Python script. */
export function runBlender({ blend, script, args = [], stdio = 'pipe' }) {
  const bin = blenderPath();
  const argv = [
    '-b',
    ...(blend ? [blend] : ['--factory-startup']),
    '--python-exit-code',
    '1',
    '-P',
    script,
    '--',
    ...args,
  ];
  const r = spawnSync(bin, argv, { encoding: 'utf8', stdio, maxBuffer: 64 * 1024 * 1024 });
  if (r.error)
    throw new Error(`Blender did not start (${bin}): ${r.error.message}. Set BLENDER to its path.`);
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Runs the gltf-transform CLI of this repository (devDependency @gltf-transform/cli). */
export function gltfTransform(args) {
  const bin = join(process.cwd(), 'node_modules/.bin/gltf-transform');
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gltf-transform did not start: ${r.error.message} (run pnpm install)`);
  if (r.status !== 0) throw new Error(`gltf-transform ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}
