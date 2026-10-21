import type * as THREE from 'three/webgpu';
import { createGltfLoader, type LoadedAsset } from '../../core/assets';
import { type HazeSpec, readsBackdrop } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import { type AssembledAsset, assembleAsset } from './assemble';
import { type AssetGlassRecord, createAssetMaterialHook } from './glass';
import type { AssetProblem } from './plan';

/**
 * One area's glb in a game room (S-24, the workshop of the prologue): loaded the way asset-lab loads it (GLTFLoader +
 * meshopt + KTX2; marked glass becomes the library's glass), assembled from its names (layers, colliders, sockets), and
 * its opaque meshes cast shadows (clear glass casts no solid shadow).
 *
 * The room then assigns `assembled.layered` to its LayerField, adds `assembled.root` to its scene and the colliders to
 * Rapier (addAssetColliders). The loader is let go once the file is in (its KTX2 workers are not needed afterwards).
 */
export interface AreaAsset {
  asset: LoadedAsset;
  assembled: AssembledAsset;
  /** Glass made by the library from the marks. */
  glass: AssetGlassRecord[];
  /** Naming and glass problems (both should be none for a committed glb). */
  problems: AssetProblem[];
  dispose(): void;
}

export async function loadAreaAsset(
  renderer: THREE.WebGPURenderer,
  quality: QualityPreset,
  url: string,
  options: { haze?: HazeSpec } = {},
): Promise<AreaAsset> {
  const loader = createGltfLoader(renderer);
  try {
    const materials = createAssetMaterialHook(quality, options);
    const asset = await loader.load(url, { material: materials.hook });
    const assembled = assembleAsset(asset.scene);
    // Opaque pieces cast the sun's shadow on the floor. They do not receive it: thin brass (pipes, rails) under a low
    // sun self-shadows into stripes (shadow acne), and the room's own brass does not receive either. Static light and
    // shadow on the pieces come with the bake (設計書 光と時間帯: 静止した光と影は焼き込み; S-26).
    asset.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.castShadow = !mats.some(readsBackdrop);
      mesh.receiveShadow = false;
    });
    return {
      asset,
      assembled,
      glass: materials.glass,
      problems: [...assembled.problems, ...materials.problems],
      dispose: () => asset.dispose(),
    };
  } finally {
    loader.dispose();
  }
}
