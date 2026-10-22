// Unit tests of the asset pipeline's helpers (node:test). Run by `pnpm assets:test` (no Blender needed for these).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  addTexture,
  bakeLines,
  bakeSettings,
  blenderPath,
  clipsByDesign,
  DEFAULT_BLENDER,
  formatBytes,
  GL,
  KTX_COMMAND,
  KTX_MIN_VERSION,
  ktxVersionOk,
  lightmapKtxArgs,
  parseKtxVersion,
  readGlb,
  reportLines,
  staleOutputs,
  writeGlb,
} from './lib.mjs';

describe('blenderPath', () => {
  it('uses BLENDER when it is set', () => {
    assert.equal(blenderPath({ BLENDER: '/opt/blender/blender' }), '/opt/blender/blender');
  });
  it('falls back to the app in /Applications', () => {
    assert.equal(blenderPath({}), DEFAULT_BLENDER);
    assert.equal(DEFAULT_BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender');
  });
});

describe('ktx (KTX-Software)', () => {
  it('reads the version that `ktx --version` prints', () => {
    assert.deepEqual(parseKtxVersion('ktx version: v4.4.0'), [4, 4, 0]);
    assert.deepEqual(parseKtxVersion('ktx version: v4.4.2~12'), [4, 4, 2]);
    assert.equal(parseKtxVersion('command not found'), null);
  });
  it('needs the version gltf-transform needs', () => {
    assert.deepEqual(KTX_MIN_VERSION, [4, 4, 0]);
    assert.equal(ktxVersionOk([4, 4, 0]), true);
    assert.equal(ktxVersionOk([5, 0, 0]), true);
    assert.equal(ktxVersionOk([4, 3, 9]), false);
    assert.equal(ktxVersionOk(null), false);
  });
});

describe('the KTX-Software the installed gltf-transform needs', () => {
  const cli = readFileSync(join(process.cwd(), 'node_modules/@gltf-transform/cli/dist/cli.mjs'), 'utf8');
  it('is the minimum version we check for', () => {
    const m = /KTX_SOFTWARE_VERSION_MIN = "(\d+)\.(\d+)\.(\d+)"/.exec(cli);
    assert.ok(m, 'KTX_SOFTWARE_VERSION_MIN not found in @gltf-transform/cli');
    assert.deepEqual([Number(m[1]), Number(m[2]), Number(m[3])], KTX_MIN_VERSION);
  });
  it('is run as the command we look for (ktx, not toktx)', () => {
    assert.equal(KTX_COMMAND, 'ktx');
    assert.match(cli, /spawn\("ktx", \["--version"\]\)/);
    assert.doesNotMatch(cli, /spawn\("toktx"/);
  });
});

describe('staleOutputs', () => {
  it('lists the glb files of the output folder that this run did not write', () => {
    assert.deepEqual(staleOutputs(['a0.glb', 'a1.glb', 'common.glb', 'notes.txt'], ['a0', 'common']), [
      'a1.glb',
    ]);
  });
});

describe('formatBytes', () => {
  it('writes sizes in decimal units', () => {
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(15_300), '15.3 kB');
    assert.equal(formatBytes(2_500_000), '2.50 MB');
  });
});

describe('reportLines', () => {
  const report = {
    blend: 'blender/scenes/x.blend',
    problems: [{ object: 'Cube', code: 'format', message: 'name it <area>_<kind>_<id>' }],
    warnings: [{ object: 'A1_vas_vase01', code: 'glass-unmarked', message: 'no glass_ mark' }],
    budget: {
      objects: [
        { name: 'A1_sock_02', category: 'prop', triangles: 3200, limit: 3000, over: true },
        { name: 'A1_flr_floor01', category: 'prop', triangles: 120, limit: 3000, over: false },
      ],
      areas: [{ group: 'a1', triangles: 3320, limit: 1_000_000, over: false }],
    },
    uv2: { A1_flr_floor01: 'generated' },
    groups: [],
  };
  const text = reportLines(report).join('\n');
  it('lists every problem with its object and code', () => {
    assert.match(text, /Cube.*format.*name it/);
  });
  it('lists the warnings, which do not stop the export', () => {
    assert.match(text, /A1_vas_vase01.*glass-unmarked.*no glass_ mark/);
  });
  it('marks an object over its triangle budget', () => {
    assert.match(text, /A1_sock_02.*3,?200.*3,?000.*OVER/);
    assert.doesNotMatch(text, /A1_flr_floor01.*OVER/);
  });
  it('shows the area totals and the second UVs', () => {
    assert.match(text, /a1.*3,?320.*1,?000,?000/);
    assert.match(text, /A1_flr_floor01.*generated/);
  });
});

describe('the bake of a job (S-26)', () => {
  const job = { name: 'workshop', bake: { size: 2048, samples: 512 } };
  it('is the job’s bake unless the run says not to bake', () => {
    assert.deepEqual(bakeSettings(job, {}, []), job.bake);
    assert.equal(bakeSettings(job, { BAKE: '0' }, []), null);
    assert.equal(bakeSettings(job, {}, ['--job', 'workshop', '--no-bake']), null);
    assert.equal(bakeSettings({ name: 'lab' }, {}, []), null);
  });
  it('prints the size, the samples, the seconds and the scale', () => {
    const text = bakeLines({
      size: 2048,
      samples: 512,
      device: 'METAL',
      seconds: 44.1,
      percentile: 99.9,
      margin: 4,
      images: [{ name: 'A0_lightmap', objects: ['a', 'b'], scale: 2.9, clipped_frac: 0.001, seconds: 44.1 }],
      lights: [{ name: 'bake_sun', type: 'SUN', energy: 2.5 }],
    }).join('\n');
    assert.match(text, /2048px, 512 samples, METAL, 44\.1 s/);
    assert.match(text, /A0_lightmap .*2 objects .*scale 2\.9 .*clipped 0\.100%/);
    assert.match(text, /bake_sun +SUN 2\.5/);
    assert.match(text, /by its percentile/);
    assert.match(bakeLines(null).join('\n'), /off/);
  });
  it('tells clipping by the percentile from clipping that is not meant', () => {
    assert.equal(clipsByDesign({ percentile: 99.9 }, { clipped_frac: 0.001 }), true);
    assert.equal(clipsByDesign({ percentile: 99.9 }, { clipped_frac: 0.004 }), false);
    assert.equal(clipsByDesign({ percentile: 99.99 }, { clipped_frac: 0.001 }), false);
  });
});

describe('the lightmap in the glb (S-26)', () => {
  const glb = writeGlb(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 6 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }],
      images: [{ name: 'A0_atlas', mimeType: 'image/ktx2', bufferView: 0 }],
      textures: [{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }],
      samplers: [{}],
      extensionsUsed: ['EXT_meshopt_compression'],
    },
    Buffer.from([1, 2, 3, 4, 5, 6]),
  );
  const bytes = Buffer.from([9, 8, 7, 6, 5]);
  const sampler = {
    magFilter: GL.LINEAR,
    minFilter: GL.LINEAR_MIPMAP_LINEAR,
    wrapS: GL.CLAMP_TO_EDGE,
    wrapT: GL.CLAMP_TO_EDGE,
  };

  it('reads back what it writes, padded to 4 bytes', () => {
    const { json, bin } = readGlb(glb);
    assert.equal(json.images[0].name, 'A0_atlas');
    assert.deepEqual([...bin.subarray(0, 6)], [1, 2, 3, 4, 5, 6]);
    assert.equal(glb.length % 4, 0);
    assert.equal(glb.readUInt32LE(8), glb.length);
  });

  it('adds a KTX2 image as a texture of its own at the end of the binary chunk, by name, through KHR_texture_basisu', () => {
    const { glb: out, texture } = addTexture(glb, {
      name: 'A0_lightmap',
      mimeType: 'image/ktx2',
      bytes,
      sampler,
    });
    const { json, bin } = readGlb(out);
    assert.equal(texture, 1);
    const t = json.textures[texture];
    assert.equal(t.name, 'A0_lightmap');
    const image = json.images[t.extensions.KHR_texture_basisu.source];
    assert.equal(image.name, 'A0_lightmap');
    assert.equal(image.mimeType, 'image/ktx2');
    const view = json.bufferViews[image.bufferView];
    assert.equal(view.byteOffset % 4, 0);
    assert.deepEqual([...bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)], [...bytes]);
    assert.equal(json.buffers[0].byteLength, view.byteOffset + bytes.length);
    assert.deepEqual(json.samplers[t.sampler], sampler);
    assert.ok(json.extensionsUsed.includes('KHR_texture_basisu'));
    assert.ok(json.extensionsRequired.includes('KHR_texture_basisu'));
    // what was there stays where it was
    assert.deepEqual([...bin.subarray(0, 6)], [1, 2, 3, 4, 5, 6]);
    assert.equal(json.images[0].name, 'A0_atlas');
  });

  it('adds a PNG (no ktx) as a plain texture source', () => {
    const { glb: out, texture } = addTexture(glb, {
      name: 'A0_lightmap',
      mimeType: 'image/png',
      bytes,
      sampler,
    });
    const { json } = readGlb(out);
    assert.equal(json.images[json.textures[texture].source].mimeType, 'image/png');
    assert.equal(json.textures[texture].extensions, undefined);
  });

  it('encodes the lightmap as sRGB colour with its mip levels: ETC1S (decided), or UASTC to compare', () => {
    const etc1s = lightmapKtxArgs('in.png', 'out.ktx2');
    assert.equal(etc1s[0], 'create');
    assert.equal(etc1s[etc1s.indexOf('--format') + 1], 'R8G8B8_SRGB');
    assert.equal(etc1s[etc1s.indexOf('--assign-tf') + 1], 'srgb');
    assert.equal(etc1s[etc1s.indexOf('--encode') + 1], 'basis-lz');
    assert.ok(etc1s.includes('--generate-mipmap'));
    assert.deepEqual(etc1s.slice(-2), ['in.png', 'out.ktx2']);
    const uastc = lightmapKtxArgs('in.png', 'out.ktx2', 'uastc');
    assert.equal(uastc[uastc.indexOf('--encode') + 1], 'uastc');
  });
});
