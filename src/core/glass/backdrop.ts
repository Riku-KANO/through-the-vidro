import { materialThickness, viewportOpaqueMipTexture } from 'three/tsl';
import * as THREE from 'three/webgpu';

/**
 * Transmission and changes of the render size (three r186, S-12).
 *
 * Transmission reads a copy of what is behind the glass (the backdrop, a FramebufferTexture shared by every
 * transmissive material). three recreates that texture when a transmissive object is drawn into a render target of
 * a new size (dynamic resolution, a window resize), and an object keeps pointing at the old one until three
 * refreshes that object's bindings. For a material without any node property, three r186 skips that refresh while
 * the object's transform, material and target size are the same as when it was last drawn (NodeMaterialObserver).
 * The backdrop is not part of that comparison. So an object that was off screen while the size went A → B → A (and
 * other glass in view recreated the backdrop) is drawn with the destroyed backdrop once it is back in view:
 *   - WebGPU: "Destroyed texture … used in a submit" every frame, and the whole submit is dropped
 *   - WebGL2: "bindTexture: attempt to use a deleted object"
 * three refreshes materials that have a node property on every frame, so every transmissive material gets one.
 * Glass from createGlass() already has one (its thicknessNode); hand-made transmissive materials go through
 * followBackdropResize().
 */

/**
 * Uses transmission, i.e. reads the backdrop: three's MeshPhysicalNodeMaterial.useTransmission where the material has
 * it, otherwise the same test on its fields (as isTransmissive in src/layers/field.ts).
 */
export function readsBackdrop(material: THREE.Material): boolean {
  const useTransmission = (material as { useTransmission?: unknown }).useTransmission;
  if (typeof useTransmission === 'boolean') return useTransmission;
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
 * property or do not use transmission.
 * Call it after transmission is set and before the material is first drawn: three decides whether a material has a
 * node when it builds the shader, so on a material that was already drawn also set `material.needsUpdate = true`.
 */
export function followBackdropResize<T extends THREE.MeshPhysicalNodeMaterial>(material: T): T {
  if (missesBackdropResize(material)) material.thicknessNode = materialThickness;
  return material;
}

/**
 * One backdrop per render target (three r186, S-29).
 *
 * three copies the backdrop per target it draws transmission into (ViewportTextureNode keeps one FramebufferTexture
 * per render target, cloned from one default; the canvas has its own too). In r186 Texture.copy shares the source,
 * so all those copies share one image record ({ width, height }). Before each copy three compares that shared record
 * with the target's size, and re-makes the copy's texture only when they differ. So when the render size changes and
 * two targets draw transmission at different moments (the orb's image on the home, then the room's scene pass after
 * the dive), the first one moves the shared record to the new size and is re-made; the second then finds the record
 * already at its size and keeps its texture at the old size:
 *   - smaller than its target: each copy is out of range. WebGPU: GPUValidationError "Texture copy range … touches
 *     outside of [Texture …]", and the whole submit is dropped, every frame (the black screen after the dive, S-27's
 *     trace); WebGL2: "GL_INVALID_VALUE: glCopyTexSubImage2D: Offset overflows texture dimensions"
 *   - larger: no message; the glass shows a shifted, partly stale background
 * three r187 gives each copy its own image (mrdoob/three.js#34636, FramebufferTexture.copy). ownBackdropImage() does
 * the same for one target, through public API only (ViewportTextureNode.getTextureForReference, Texture.source).
 *
 * Call it once for every render target that draws transmissive materials while another target (or the canvas) also
 * does at other moments, best before the first draw (called later, the backdrop is re-made at the next draw). A target
 * left sharing is safe only while it is the last one sharing. With a three that already separates them, it does nothing.
 *
 * Covers the front-side backdrop only. three draws a transmissive material with `side: BackSide`, or `DoubleSide`
 * without `forceSinglePass` (a separate back-side pass first, RenderList needsDoublePass), from another backdrop that
 * it keeps out of reach, so those still share in r186. Give such glass `forceSinglePass = true` (front side only, as
 * the prologue's panel glass in room-art.ts does). None in the game reads it today (S-29 review).
 */
export function ownBackdropImage(target: THREE.RenderTarget): void {
  const copies = viewportOpaqueMipTexture() as unknown as BackdropCopies;
  const own = copies.getTextureForReference(target);
  if (sharesBackdropImage(target)) {
    const image = own.image as { width?: number; height?: number };
    own.source = new THREE.TextureSource({ width: image.width, height: image.height });
    // if three already made it, the shared record may have moved on since: re-make it at the next draw
    own.needsUpdate = true;
  }
}

/** True while this target's backdrop shares its image record with the default the copies are cloned from (r186). */
export function sharesBackdropImage(target: THREE.RenderTarget): boolean {
  const copies = viewportOpaqueMipTexture() as unknown as BackdropCopies;
  return copies.getTextureForReference(target).source === copies.getTextureForReference(null).source;
}

/** The part of three's ViewportTextureNode used here (public API; viewportOpaqueMipTexture() is typed as Node). */
interface BackdropCopies {
  getTextureForReference(reference: THREE.RenderTarget | null): THREE.Texture;
}
