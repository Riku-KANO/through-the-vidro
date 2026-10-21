import { readFileSync } from 'node:fs';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { type GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import * as THREE from 'three/webgpu';

/**
 * A committed glb loaded in Node, for unit tests (no GPU, no DOM; S-24): GLTFLoader with the meshopt decoder, as the
 * game loads it (src/core/assets/loader.ts), so a test sees the same nodes, names, extras and geometry (quantized
 * attributes stay normalized, as in the game; three denormalizes when it reads them). KTX2 textures become empty
 * placeholder textures (there is no Basis transcoder here), so tests look at which texture a material uses, not at
 * its pixels. Not part of the app: only tests import it (hence the `.test-helper` name; it writes `self` on globalThis).
 */
export async function loadGlbInNode(path: string): Promise<GLTF> {
  // GLTFLoader turns embedded images into object URLs with self.URL
  (globalThis as { self?: unknown }).self ??= globalThis;
  const bytes = readFileSync(path);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const placeholder = {
    load(_url: string, onLoad: (texture: THREE.Texture) => void): void {
      onLoad(new THREE.Texture());
    },
    detectSupport() {
      return placeholder;
    },
  };
  const loader = new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .setKTX2Loader(placeholder as unknown as KTX2Loader);
  return loader.parseAsync(data, '');
}
