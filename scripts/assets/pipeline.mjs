#!/usr/bin/env node
// The asset pipeline (S-23; 設計書 Blenderアセットパイプライン > 自動化 / 書き出しと圧縮): one command from .blend to the
// glb files the game loads.
//   pnpm assets                 every job of blender/pipeline.json
//   pnpm assets -- --job lab    one job
//   BLENDER=/path/to/blender    another Blender (default: /Applications/Blender.app/Contents/MacOS/Blender)
//   KEEP=1                      keep the uncompressed export (its folder is printed)
//   BAKE=0 / -- --no-bake       export without baking the light (the game then lights everything in real time)
//
// For each job: Blender in the background runs blender/scripts/pipeline.py on the .blend (naming lint, triangle report
// against the budget, second UV, the light bake when the job has `bake` (S-26: Cycles, one lightmap per area: the size,
// samples, percentile, margin and texel density of blender/pipeline.json), one glb per area + common), then
// gltf-transform compresses each glb:
//   textures → KTX2 (normal and thickness maps: UASTC, the high-quality mode; colour and the rest: ETC1S, the
//              high-compression mode) when the `ktx` CLI of KTX-Software 4.4+ is on PATH (gltf-transform 4.5 runs
//              `ktx create`; it does not use `toktx`); otherwise a warning and the PNG/JPEG stay as they are
//   geometry → meshopt (EXT_meshopt_compression + KHR_mesh_quantization)
// and writes <out>/<group>.glb (glb files of groups that are gone are removed). The area's baked lightmap then goes into
// its glb as a texture of its own (KTX2, ETC1S, sRGB, with mip levels: decided in S-26; a PNG when `ktx` is missing),
// named as the baked objects' extras `lightmap` say. A naming problem stops the job before anything is written. Check
// the result with `pnpm assets:test`, `scripts/check.sh` and the asset-lab scene.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  addTexture,
  bakeLines,
  bakeSettings,
  blenderPath,
  clipsByDesign,
  encodeLightmap,
  findKtx,
  formatBytes,
  GL,
  gltfTransform,
  gltfTransformVersion,
  KTX_MIN_VERSION,
  reportLines,
  runBlender,
  staleOutputs,
} from './lib.mjs';

const root = process.cwd();
const LINT_FAILED = 2;
/** Texture slots that get UASTC (high quality). Everything else gets ETC1S (high compression). */
const UASTC_SLOTS = '{normalTexture,thicknessTexture}';
/**
 * meshopt level. "medium" quantizes normals to 10 bits; "high" would filter them to 8-bit octahedral, and glass shows
 * every error of its normals as distortion (設計書 Blenderアセットパイプライン > 造形 > 法線). 仮.
 */
const MESHOPT_LEVEL = 'medium';
/** Bits of the UVs of a baked job (S-26): a texel of a 2048 px lightmap is 1/2048; 12 bits would round to half of one. */
const BAKED_TEXCOORD_BITS = 14;

const argv = process.argv.slice(2).filter((a) => a !== '--');
const onlyJob = argv.includes('--job') ? argv[argv.indexOf('--job') + 1] : null;
const config = JSON.parse(readFileSync(join(root, 'blender/pipeline.json'), 'utf8'));
const jobs = config.jobs.filter((j) => !onlyJob || j.name === onlyJob);
if (jobs.length === 0) {
  console.error(`no job named ${onlyJob} in blender/pipeline.json`);
  process.exit(1);
}

const blender = blenderPath();
if (!existsSync(blender)) {
  console.error(`Blender not found at ${blender}. Set BLENDER to its path.`);
  process.exit(1);
}
const ktx = findKtx();
if (ktx.ok) {
  console.log(`${ktx.text} (KTX-Software): textures → KTX2 (normal, thickness: UASTC; the rest: ETC1S)`);
} else {
  const why = ktx.found
    ? `ktx ${ktx.version?.join('.') ?? '(unknown version)'} is older than ${KTX_MIN_VERSION.join('.')}`
    : 'ktx (KTX-Software) not found';
  console.warn(
    `WARNING: ${why}; textures stay PNG/JPEG (geometry is still compressed). @gltf-transform/cli ${gltfTransformVersion()} ` +
      `encodes KTX2 with the new \`ktx\` CLI (\`ktx create\`) of KTX-Software ${KTX_MIN_VERSION.join('.')}+, not with \`toktx\`: ` +
      'install KTX-Software (its .pkg puts both on PATH) and run `pnpm assets` again.',
  );
}

const glbJson = (file) => {
  const b = readFileSync(file);
  const length = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + length).toString('utf8'));
};
const textureSummary = (file) => {
  const counts = {};
  for (const i of glbJson(file).images ?? []) counts[i.mimeType] = (counts[i.mimeType] ?? 0) + 1;
  return Object.entries(counts)
    .map(([type, n]) => `${n} ${type.replace('image/', '')}`)
    .join(', ');
};

let failed = false;
for (const job of jobs) {
  console.log(`\n▶ ${job.name}: ${job.blend} → ${job.out}`);
  const work = mkdtempSync(join(tmpdir(), `vidro-assets-${job.name}-`));
  const report = join(work, 'report.json');
  const bake = bakeSettings(job, process.env, argv);
  const started = Date.now();
  const r = runBlender({
    blend: join(root, job.blend),
    script: join(root, 'blender/scripts/pipeline.py'),
    args: ['--out', join(work, 'raw'), '--report', report, ...(bake ? ['--bake', JSON.stringify(bake)] : [])],
  });
  const blenderSeconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!existsSync(report)) {
    console.error(
      `Blender failed (exit ${r.status}) before writing its report:\n${(r.stdout + r.stderr).slice(-4000)}`,
    );
    failed = true;
    continue;
  }
  const result = JSON.parse(readFileSync(report, 'utf8'));
  for (const line of reportLines(result)) console.log(line);
  if (r.status === LINT_FAILED || result.problems.length > 0) {
    console.error(`✗ ${job.name}: fix the names above in ${job.blend}; nothing was written`);
    failed = true;
    continue;
  }
  if (r.status !== 0) {
    console.error(`Blender failed (exit ${r.status}):\n${(r.stdout + r.stderr).slice(-4000)}`);
    failed = true;
    continue;
  }
  for (const line of bakeLines(result.bake)) console.log(line);
  // common/bake.py warns when the brightest texels clip; a lower percentile clips them on purpose (bakeLines says so)
  const clipping = !(result.bake?.images ?? []).every((i) => clipsByDesign(result.bake, i));
  for (const line of (r.stdout + r.stderr).split('\n')) {
    if (/^WARNING: bake /.test(line) || (clipping && /^WARNING: .*lightmap/.test(line)))
      console.warn(`  ${line}`);
  }
  console.log(`Blender: ${blenderSeconds} s`);

  const out = join(root, job.out);
  mkdirSync(out, { recursive: true });
  console.log('compression (gltf-transform)');
  console.log(`  ${'file'.padEnd(12)} ${'exported'.padStart(10)} ${'compressed'.padStart(11)}  textures`);
  for (const g of result.groups) {
    const raw = g.file;
    let current = raw;
    if (ktx.ok) {
      const uastc = join(work, `${g.group}.uastc.glb`);
      gltfTransform(['uastc', current, uastc, '--slots', UASTC_SLOTS]);
      const etc1s = join(work, `${g.group}.etc1s.glb`);
      gltfTransform(['etc1s', uastc, etc1s]);
      current = etc1s;
    }
    const final = join(out, `${g.group}.glb`);
    // a baked job: the second UV at 14 bits (the default 12 is half a texel of a 2048 px lightmap)
    gltfTransform([
      'meshopt',
      current,
      final,
      '--level',
      MESHOPT_LEVEL,
      ...(bake ? ['--quantize-texcoord', String(BAKED_TEXCOORD_BITS)] : []),
    ]);
    const before = statSync(raw).size;
    // the area's lightmap, last: gltf-transform would drop a texture no material uses
    for (const image of (result.bake?.images ?? []).filter((i) => i.group === g.group)) {
      let bytes = readFileSync(image.png);
      let mimeType = 'image/png';
      if (ktx.ok) {
        const encoded = join(work, `${image.name}.ktx2`);
        encodeLightmap(image.png, encoded, bake?.codec ?? 'etc1s');
        bytes = readFileSync(encoded);
        mimeType = 'image/ktx2';
      }
      const sampler = {
        magFilter: GL.LINEAR,
        minFilter: GL.LINEAR_MIPMAP_LINEAR,
        wrapS: GL.CLAMP_TO_EDGE,
        wrapT: GL.CLAMP_TO_EDGE,
      };
      const added = addTexture(readFileSync(final), { name: image.name, mimeType, bytes, sampler });
      writeFileSync(final, added.glb);
      console.log(
        `  lightmap ${image.name}: PNG ${formatBytes(statSync(image.png).size)} → ${mimeType.replace('image/', '')} ${formatBytes(bytes.length)} (texture ${added.texture})`,
      );
    }
    const after = statSync(final).size;
    console.log(
      `  ${`${g.group}.glb`.padEnd(12)} ${formatBytes(before).padStart(10)} ${formatBytes(after).padStart(11)}  ${textureSummary(final) || 'none'}`,
    );
  }
  for (const f of staleOutputs(
    readdirSync(out),
    result.groups.map((g) => g.group),
  )) {
    rmSync(join(out, f));
    console.log(`  removed ${relative(root, join(out, f))} (no objects of that group any more)`);
  }
  if (process.env.KEEP === '1') console.log(`  kept the export in ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
