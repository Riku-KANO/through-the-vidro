import * as THREE from 'three/webgpu';
import { createFrostedFloorMaterial } from '../../core/glass';

/**
 * Materials of loaded assets that the game draws in code (S-26): a material whose extras say `procedural` is made again
 * here, as the glass marks are (glass.ts; 設計書 Blenderアセットパイプライン > 厚みと材質: Blenderから書き出せない設定は、
 * 印をつけ、読み込み時にコード側で設定する). The workshop's floor moved from room-art.ts into the glb to be baked; its
 * frosted tiles and brass joints stay the code's (src/core/glass createFrostedFloorMaterial: joints faded where a pixel
 * covers more floor than a joint is wide).
 *   procedural: 'frosted_floor', tile_size (m), frost_color ('#rrggbb', sRGB)
 * The extras stay on the new material (userData), so the bake's rules (src/core/assets/lightmap.ts) still read them.
 */
export const PROCEDURAL_KINDS = ['frosted_floor'] as const;
export type ProceduralKind = (typeof PROCEDURAL_KINDS)[number];

/** The material the game makes for `material`, or null when it is not procedural. */
export function proceduralMaterial(material: THREE.Material): THREE.Material | null {
  const extras = material.userData as Record<string, unknown>;
  if (extras.procedural !== 'frosted_floor') return null;
  const tile = Number(extras.tile_size);
  const frost = typeof extras.frost_color === 'string' ? extras.frost_color : undefined;
  const made = createFrostedFloorMaterial({
    tileSize: Number.isFinite(tile) && tile > 0 ? tile : undefined,
    frostColor: frost !== undefined ? new THREE.Color(frost) : undefined,
  });
  made.name = material.name;
  made.userData = { ...extras };
  return made;
}
