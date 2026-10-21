import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { type GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type * as THREE from 'three/webgpu';
import { convertMaterials, disposeObject, type MaterialHook, texturesOf } from './materials';

/**
 * Loading glb files made by the Blender pipeline (S-23; 技術設計 > アセット圧縮: glTF ＋ meshopt ＋ KTX2), on both
 * routes (WebGPU and its WebGL2 fallback): GLTFLoader with the meshopt decoder (EXT_meshopt_compression) and KTX2Loader
 * (KHR_texture_basisu). Every material becomes a node material (materials.ts).
 *
 * Decoders: the meshopt decoder is a module of three/addons (its wasm is inlined), bundled with the app. The Basis
 * transcoder (basis_transcoder.js + .wasm) is what KTX2Loader fetches when it first meets a KTX2 texture; three r186
 * points at its own copy with `new URL('../libs/basis/…', import.meta.url)`, which Vite serves in dev and emits into
 * dist/assets in a build. So both always match the installed three; nothing is copied by hand.
 *
 * Lifetime: one loader per scene; dispose() stops KTX2Loader's workers. Each loaded asset is disposed on its own.
 */
export interface LoadedAsset {
  url: string;
  /** The glTF scene, materials converted. Add it (or its parts) to a scene. */
  scene: THREE.Group;
  /** extensionsUsed of the file. */
  extensionsUsed: string[];
  /**
   * Every texture the file brought, whatever material uses it now (a hook may keep a texture only inside a node, e.g.
   * the thickness map of the game's glass). dispose() releases them.
   */
  textures: THREE.Texture[];
  gltf: GLTF;
  /** Releases its geometries, materials and textures. */
  dispose(): void;
}

export interface LoadOptions {
  /** Picks the material of a mesh before the default conversion (e.g. the game's glass for marked materials). */
  material?: MaterialHook;
}

export interface GltfAssetLoader {
  load(url: string, options?: LoadOptions): Promise<LoadedAsset>;
  /** Fetches the Basis transcoder now instead of at the first KTX2 texture (to check it, or to warm it up). */
  loadTranscoder(): Promise<void>;
  dispose(): void;
}

/**
 * Call after `await renderer.init()` (KTX2Loader asks the backend which compressed formats it has). `transcoderPath`
 * serves the transcoder from elsewhere (a folder with basis_transcoder.js and .wasm); by default three's own copy.
 */
export function createGltfLoader(
  renderer: THREE.WebGPURenderer,
  options: { transcoderPath?: string } = {},
): GltfAssetLoader {
  const ktx2 = new KTX2Loader().detectSupport(renderer);
  if (options.transcoderPath) ktx2.setTranscoderPath(options.transcoderPath);
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  return {
    async load(url, { material } = {}) {
      const gltf = await loader.loadAsync(url);
      const scene = gltf.scene;
      // world matrices first, so a material hook can read the size quantization gave each mesh
      scene.updateMatrixWorld(true);
      const textures = new Set<THREE.Texture>();
      scene.traverse((o) => {
        const m = (o as { material?: THREE.Material | THREE.Material[] }).material;
        for (const mm of Array.isArray(m) ? m : m ? [m] : []) for (const t of texturesOf(mm)) textures.add(t);
      });
      const { replaced } = convertMaterials(scene, material);
      for (const m of replaced) m.dispose();
      const used = (gltf.parser.json as { extensionsUsed?: string[] }).extensionsUsed ?? [];
      return {
        url,
        scene,
        gltf,
        extensionsUsed: [...used],
        textures: [...textures],
        dispose: () => disposeObject(scene, textures),
      };
    },
    async loadTranscoder() {
      await ktx2.init();
    },
    dispose() {
      ktx2.dispose();
    },
  };
}
