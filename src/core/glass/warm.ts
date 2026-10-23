import type * as THREE from 'three/webgpu';
import { readsBackdrop } from './backdrop';

/**
 * Warming the glass while loading (three r186, S-38).
 *
 * three builds an object's shader and render pipeline the first time it draws that object, inside that frame. Transmissive
 * glass is the costly kind: the workshop's five glass wares behind the landing pose, first seen when looking back from the
 * far shore, made frames of 36–56 ms on WebGPU and 47–64 ms on WebGL2 (an Apple M-series GPU; the other frames 18–20 ms;
 * S-34's trace, S-38). A warm-up draw while loading compiles only what that pose sees: three culls by the view frustum
 * before it draws, and so does `compileAsync`.
 *
 * `withGlassUnculled` runs one draw with the frustum culling of every object whose material reads the backdrop
 * switched off, so the glass all around gets its pipelines in that draw, whatever the pose. Make it the game's own draw
 * (the same render target, backdrop and layer masks as in play): a pipeline belongs to its draw's state, and in r186 the
 * pipelines `compileAsync` made into another target of the same formats were made again by the scene pass (S-38).
 *
 * Only the glass, not everything: switching the culling off for everything also draws every shadow caster into the
 * shadow maps and the whole back layer into the peek image in that frame (in the prologue 345 draw calls, over the
 * budget of 300), while the opaque pieces mostly share a few materials that are compiled by what is in view anyway.
 * Hidden objects stay hidden (three skips them and their children). The flags are put back when `draw` returns or
 * throws.
 */
export function withGlassUnculled<T>(root: THREE.Object3D, draw: () => T): T {
  const unculled: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (!o.frustumCulled || !drawsGlass(o)) return;
    o.frustumCulled = false;
    unculled.push(o);
  });
  try {
    return draw();
  } finally {
    for (const o of unculled) o.frustumCulled = true;
  }
}

/** Has a material that reads the backdrop (transmission), as three draws it. */
export function drawsGlass(o: THREE.Object3D): boolean {
  const m = (o as { material?: THREE.Material | THREE.Material[] }).material;
  if (!m) return false;
  return Array.isArray(m) ? m.some(readsBackdrop) : readsBackdrop(m);
}
