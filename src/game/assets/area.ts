import type * as THREE from 'three/webgpu';
import { createGltfLoader, type LoadedAsset } from '../../core/assets';
import { type HazeSpec, readsBackdrop } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import { type AssembledAsset, assembleAsset } from './assemble';
import { type AssetGlassRecord, createAssetMaterialHook } from './glass';
import { type AssetProblem, problemMessage } from './plan';
import { proceduralMaterial } from './procedural';

/**
 * One area's glb in a game room (S-24, the workshop of the prologue): loaded the way asset-lab loads it (GLTFLoader +
 * meshopt + KTX2; marked glass becomes the library's glass), assembled from its names (layers, colliders, sockets), and
 * its opaque meshes cast and receive shadows (clear glass casts no solid shadow). S-26: materials the game draws in code
 * (procedural.ts: the workshop's floor) are made here, and the baked pieces draw with their lightmap
 * (src/core/assets/lightmap.ts: the realtime lights add only their highlights to them).
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
    const asset = await loader.load(url, {
      material: (m, mesh) => proceduralMaterial(m) ?? materials.hook(m, mesh),
      lightmaps: true,
    });
    const assembled = assembleAsset(asset.scene);
    asset.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const glass = mats.some(readsBackdrop);
      mesh.castShadow = !glass;
      mesh.receiveShadow = !glass;
    });
    return {
      asset,
      assembled,
      glass: materials.glass,
      problems: [
        ...assembled.problems,
        ...materials.problems,
        ...(asset.lightmaps?.missing ?? []).map((object) => ({
          object,
          code: 'lightmap-missing' as const,
          message: problemMessage('lightmap-missing'),
        })),
      ],
      dispose: () => asset.dispose(),
    };
  } finally {
    loader.dispose();
  }
}
