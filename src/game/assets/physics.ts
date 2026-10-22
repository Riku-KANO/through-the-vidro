import type RAPIER from '@dimforge/rapier3d-compat';
import type { FootingSegment } from '../../layers';
import { BackFooting } from '../prologue/physics';
import type { ColliderShape } from './assemble';

/**
 * The colliders of an assembled asset as Rapier colliders (S-23; 空間の可読性と導線 4: 当たり判定は見た目に正直に, here as the
 * _col shapes the artist made). Shared and surface colliders are fixed triangle meshes. Back-layer colliders are the
 * back footing of S-02 (技術設計 > 裏の層の実装 > 当たり判定): on only where a materialized sphere overlaps them, ground only
 * inside the sphere. Each back collider is one segment here; splitting long footing into finer segments is left to
 * the artist (several _col objects) for now.
 */
export interface AssetColliders {
  fixed: RAPIER.Collider[];
  /** The fixed (shared and surface) colliders by their object name (`<base>_col`). */
  byName: ReadonlyMap<string, RAPIER.Collider>;
  /** null when the asset has no back-layer collider. */
  footing: BackFooting | null;
  dispose(): void;
}

export function addAssetColliders(
  R: typeof RAPIER,
  world: RAPIER.World,
  shapes: readonly ColliderShape[],
): AssetColliders {
  const fixed: RAPIER.Collider[] = [];
  const byName = new Map<string, RAPIER.Collider>();
  const back: ColliderShape[] = [];
  for (const s of shapes) {
    if (s.layer === 'back') {
      back.push(s);
      continue;
    }
    const c = world.createCollider(
      R.ColliderDesc.trimesh(s.positions, s.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES),
    );
    fixed.push(c);
    byName.set(s.name, c);
  }
  const segments: FootingSegment[] = back.map((s) => ({ id: s.name, min: s.box.min, max: s.box.max }));
  const byId = new Map(back.map((s) => [s.name, s]));
  const footing =
    back.length > 0
      ? new BackFooting(R, world, segments, (seg) => {
          const s = byId.get(seg.id);
          return {
            positions: s?.positions ?? new Float32Array(),
            normals: new Float32Array(),
            indices: s?.indices ?? new Uint32Array(),
          };
        })
      : null;
  return {
    fixed,
    byName,
    footing,
    dispose() {
      for (const c of fixed) world.removeCollider(c, false);
      footing?.dispose();
    },
  };
}
