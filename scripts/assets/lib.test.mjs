// Unit tests of the asset pipeline's helpers (node:test). Run by `pnpm assets:test` (no Blender needed for these).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  blenderPath,
  DEFAULT_BLENDER,
  formatBytes,
  KTX_COMMAND,
  KTX_MIN_VERSION,
  ktxVersionOk,
  parseKtxVersion,
  reportLines,
  staleOutputs,
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
