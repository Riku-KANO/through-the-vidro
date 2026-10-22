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

// ── glb files (S-26: the baked lightmap goes into the area's glb as one more texture) ──────────────────────────────
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const pad4 = (n) => (n + 3) & ~3;

/** The JSON and the binary chunk of a .glb (the binary chunk is buffers[0], the one without a uri). */
export function readGlb(glb) {
  const b = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  if (b.readUInt32LE(0) !== GLB_MAGIC || b.readUInt32LE(4) !== 2) throw new Error('not a glTF 2.0 binary');
  const jsonLength = b.readUInt32LE(12);
  if (b.readUInt32LE(16) !== CHUNK_JSON) throw new Error('the first chunk of the glb is not JSON');
  const json = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8'));
  let bin = Buffer.alloc(0);
  const at = 20 + jsonLength;
  if (at + 8 <= b.length && b.readUInt32LE(at + 4) === CHUNK_BIN) {
    bin = Buffer.from(b.subarray(at + 8, at + 8 + b.readUInt32LE(at)));
  }
  return { json, bin };
}

/** A .glb from its JSON and binary chunk (each padded to 4 bytes: the JSON with spaces, the binary with zeros). */
export function writeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([text, Buffer.alloc(pad4(text.length) - text.length, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const parts = [Buffer.alloc(12), Buffer.alloc(8), jsonChunk];
  if (bin.length > 0) parts.push(Buffer.alloc(8), binChunk);
  const out = Buffer.concat(parts);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  if (bin.length > 0) {
    out.writeUInt32LE(binChunk.length, 20 + jsonChunk.length);
    out.writeUInt32LE(CHUNK_BIN, 24 + jsonChunk.length);
  }
  return out;
}

/**
 * The bake of a job (blender/pipeline.json `bake`), or null when it is not baked: the job has none, or the run says not
 * to (`BAKE=0`, or `--no-bake`: export what is there without a lightmap, the game lights it all in real time).
 */
export function bakeSettings(job, env = process.env, argv = []) {
  if (!job.bake || env.BAKE === '0' || argv.includes('--no-bake')) return null;
  return job.bake;
}

/** glTF sampler values (WebGL enums). */
export const GL = { LINEAR: 9729, LINEAR_MIPMAP_LINEAR: 9987, CLAMP_TO_EDGE: 33071 };

/**
 * Adds an image to a .glb as a texture of its own, which no material uses (S-26: the area's lightmap; the game finds it
 * by name, from the extras `lightmap` of the baked objects). The image goes at the end of the binary chunk (buffers[0]),
 * a KTX2 image through KHR_texture_basisu (required: the texture has no other source). Returns the new .glb and the
 * index of the texture. Pure.
 */
export function addTexture(glb, { name, mimeType, bytes, sampler }) {
  const { json, bin } = readGlb(glb);
  json.buffers ??= [];
  if (json.buffers.length === 0) json.buffers.push({ byteLength: 0 });
  if (json.buffers[0].uri !== undefined) throw new Error('buffers[0] of the glb is not its binary chunk');
  const offset = pad4(bin.length);
  const data = Buffer.concat([bin, Buffer.alloc(offset - bin.length), Buffer.from(bytes)]);
  json.buffers[0].byteLength = data.length;
  json.bufferViews ??= [];
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
  json.images ??= [];
  json.images.push({ name, mimeType, bufferView: json.bufferViews.length - 1 });
  const image = json.images.length - 1;
  json.samplers ??= [];
  json.samplers.push(sampler);
  const texture = { name, sampler: json.samplers.length - 1 };
  if (mimeType === 'image/ktx2') {
    texture.extensions = { KHR_texture_basisu: { source: image } };
    for (const list of ['extensionsUsed', 'extensionsRequired']) {
      json[list] ??= [];
      if (!json[list].includes('KHR_texture_basisu')) json[list].push('KHR_texture_basisu');
    }
  } else {
    texture.source = image;
  }
  json.textures ??= [];
  json.textures.push(texture);
  return { glb: writeGlb(json, data), texture: json.textures.length - 1 };
}

/**
 * Arguments of `ktx create` for a baked lightmap (S-26): an 8-bit sRGB PNG (common/bake.py) to KTX2 with its mip levels,
 * marked sRGB. `etc1s` (decided: 色は ETC1S, the high-compression mode the doc gives colour) at the highest quality level
 * (the default 128 drew the 4×4 blocks over the smooth light of the furnace's dome and the bench); `uastc` (the
 * high-quality mode, zstd-supercompressed) to compare.
 */
export function lightmapKtxArgs(png, out, codec = 'etc1s') {
  const encode =
    codec === 'uastc'
      ? ['--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18']
      : ['--encode', 'basis-lz', '--qlevel', '255'];
  return [
    'create',
    '--format',
    'R8G8B8_SRGB',
    '--assign-tf',
    'srgb',
    '--assign-primaries',
    'bt709',
    ...encode,
    '--generate-mipmap',
    png,
    out,
  ];
}

/** Encodes a baked lightmap PNG to KTX2 with the `ktx` CLI. */
export function encodeLightmap(png, out, codec = 'etc1s') {
  const r = spawnSync(KTX_COMMAND, lightmapKtxArgs(png, out, codec), { encoding: 'utf8' });
  if (r.error || r.status !== 0)
    throw new Error(`ktx create failed for ${png}: ${r.error?.message ?? ''}${r.stdout}${r.stderr}`);
}

/**
 * Whether a lightmap clips only what its percentile means to clip: the brightest (100 − percentile)% of its texels (with a
 * half again for the noise). The bake normalizes by that percentile on purpose (blender/pipeline.json).
 */
export function clipsByDesign(bake, image) {
  const share = (100 - Number(bake?.percentile ?? 99.99)) / 100;
  return (image?.clipped_frac ?? 0) <= share * 1.5;
}

/** Lines about the bake for the terminal (blender/scripts/pipeline.py report.bake). */
export function bakeLines(bake) {
  if (!bake) return ['bake (光と影のライトマップ): off'];
  const out = [
    `bake (光と影のライトマップ): ${bake.size}px, ${bake.samples} samples, ${bake.device}, ${bake.seconds} s` +
      ` (percentile ${bake.percentile}${bake.margin != null ? `, margin ${bake.margin}px` : ''})`,
  ];
  for (const i of bake.images ?? []) {
    out.push(
      `  ${pad(i.name, 14)} ${String(i.objects?.length ?? 0).padStart(3)} objects  scale ${i.scale}` +
        `  clipped ${((i.clipped_frac ?? 0) * 100).toFixed(3)}%${clipsByDesign(bake, i) ? ' (by its percentile)' : ''}` +
        `  ${i.seconds} s`,
    );
  }
  for (const l of bake.lights ?? []) out.push(`  light ${pad(l.name, 14)} ${l.type} ${l.energy}`);
  return out;
}

/** Runs the gltf-transform CLI of this repository (devDependency @gltf-transform/cli). */
export function gltfTransform(args) {
  const bin = join(process.cwd(), 'node_modules/.bin/gltf-transform');
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gltf-transform did not start: ${r.error.message} (run pnpm install)`);
  if (r.status !== 0) throw new Error(`gltf-transform ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}
