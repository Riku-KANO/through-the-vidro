import { materialThickness } from 'three/tsl';
import type * as THREE from 'three/webgpu';

/**
 * Transmission and changes of the render size (three r186, S-12).
 *
 * Transmission reads a copy of what is behind the glass (the backdrop, a FramebufferTexture). three recreates that
 * texture whenever the size of the render target changes (dynamic resolution, a window resize), and an object keeps
 * pointing at the old one until three refreshes that object's bindings. For a material without any node property,
 * three r186 skips that refresh while the object's transform, material and target size are the same as when it was
 * last drawn (NodeMaterialObserver). The backdrop is not part of that comparison. So an object that was off screen
 * while the size went A → B → A is drawn with the destroyed backdrop once it is back in view:
 *   - WebGPU: "Destroyed texture … used in a submit" every frame, and the whole submit is dropped
 *   - WebGL2: "bindTexture: attempt to use a deleted object"
 * three refreshes materials that have a node property on every frame, so every transmissive material gets one.
 * Glass from createGlass() already has one (its thicknessNode); hand-made transmissive materials go through
 * followBackdropResize().
 */

/** Uses transmission, i.e. reads the backdrop (the same test as three's MeshPhysicalNodeMaterial.useTransmission). */
export function readsBackdrop(material: THREE.Material): boolean {
  const m = material as { transmission?: number; transmissionNode?: unknown };
  return (m.transmission ?? 0) > 0 || (m.transmissionNode ?? null) !== null;
}

/** Has a property holding a node (the material half of three r186's NodeMaterialObserver.containsNode). */
export function hasNodeProperty(material: THREE.Material): boolean {
  const props = material as unknown as Record<string, unknown>;
  for (const key in props) {
    const value = props[key] as { isNode?: boolean } | null | undefined;
    if (value?.isNode === true) return true;
  }
  return false;
}

/** True when three r186 may draw this material's objects with a destroyed backdrop after the render size changed. */
export function missesBackdropResize(material: THREE.Material): boolean {
  return readsBackdrop(material) && !hasNodeProperty(material);
}

/**
 * Makes three refresh the objects of this transmissive material on every frame, so they follow the backdrop when a
 * size change recreates it (see the top of this file). Sets thicknessNode to materialThickness, which is what three
 * uses when thicknessNode is null, so the look does not change. Leaves materials alone that already have a node
 * property or do not use transmission. Call it before the material is first drawn.
 */
export function followBackdropResize<T extends THREE.MeshPhysicalNodeMaterial>(material: T): T {
  if (missesBackdropResize(material)) material.thicknessNode = materialThickness;
  return material;
}
