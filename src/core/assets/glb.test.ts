import { describe, expect, it } from 'vitest';
import { readGlbJson } from './glb';

/** A minimal GLB: 12-byte header, a JSON chunk padded with spaces, an optional BIN chunk. */
function glb(json: unknown, bin?: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  if (bin) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
    out.set(bin, at + 8);
  }
  return out;
}

describe('readGlbJson', () => {
  it('reads the JSON chunk of a binary glTF', () => {
    const json = { asset: { version: '2.0' }, extensionsUsed: ['EXT_meshopt_compression'] };
    expect(readGlbJson(glb(json, new Uint8Array([1, 2, 3])))).toEqual(json);
  });

  it('reads from an ArrayBuffer and from a view into a larger buffer', () => {
    const bytes = glb({ asset: { version: '2.0' } });
    expect(readGlbJson(bytes.buffer as ArrayBuffer)).toEqual({ asset: { version: '2.0' } });
    const bigger = new Uint8Array(bytes.length + 8);
    bigger.set(bytes, 8);
    expect(readGlbJson(bigger.subarray(8))).toEqual({ asset: { version: '2.0' } });
  });

  it('refuses something that is not a binary glTF 2', () => {
    expect(() => readGlbJson(new TextEncoder().encode('{"asset":{}}'))).toThrow(/glTF/);
    const v1 = glb({ asset: { version: '1.0' } });
    new DataView(v1.buffer).setUint32(4, 1, true);
    expect(() => readGlbJson(v1)).toThrow(/version/);
  });
});
