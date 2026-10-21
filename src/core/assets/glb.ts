/**
 * The JSON chunk of a binary glTF (.glb), without loading it into three: for checks and tools (which extensions a file
 * needs, its node names and extras). Pure.
 */
const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'

export function readGlbJson(data: ArrayBuffer | ArrayBufferView): Record<string, unknown> {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength < 20) throw new Error('not a binary glTF: too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('not a binary glTF: no glTF magic');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`binary glTF version ${version}, expected 2`);
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK) throw new Error('binary glTF: the first chunk is not JSON');
  if (20 + length > bytes.byteLength) throw new Error('binary glTF: the JSON chunk runs past the end');
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as Record<string, unknown>;
}
