import type * as THREE from 'three/webgpu';
import { readsBackdrop } from './backdrop';

/**
 * Warming the glass while loading (three r186, S-38).
 *
 * three builds an object's shader and render pipeline the first time it draws that object, inside that frame. Transmissive
 * glass is the costly kind: the workshop's five glass wares behind the landing pose, first seen when looking back from the
 * far shore, made frames of 36–52 ms on WebGPU and 53–64 ms on WebGL2 (an Apple M-series GPU, a fresh browser each time,
 * three runs; the other frames 18–20 ms; process/slices/S-38.md). A warm-up draw while loading compiles only what that pose
 * sees: three culls by the view frustum before it draws, and so does `compileAsync`.
 *
 * `withGlassUnculled` runs one draw with the frustum culling switched off for every object whose material reads the
 * backdrop and for everything under it (a game may hang a cheaper copy under its glass to draw it in another pass, as
 * the prologue's peek image does), so the glass all around gets its pipelines in that draw, whatever the pose. Make it
 * the game's own draw (the same render targets, backdrop and layer masks as in play): a pipeline belongs to its draw's
 * state, and in r186 the pipelines `compileAsync` made into another target of the same formats were made again by the
 * scene pass (S-38).
 *
 * Only the glass, not everything: switching the culling off for everything also draws every shadow caster into the
 * shadow maps and the whole back layer into the peek image in that frame (in the prologue 345 draw calls, over the
 * budget of 300), while the opaque pieces mostly share a few materials that are compiled by what is in view anyway. The
 * draw calls of that frame still grow with the number of glass objects.
 *
 * Not warmed: what is hidden at that moment (three skips it and its children): the levels of an LOD that are not shown
 * from the warm-up pose, glass under a hidden parent. Show them for the draw, or draw once per level. The flags are put
 * back when `draw` returns or throws.
 */
export function withGlassUnculled<T>(root: THREE.Object3D, draw: () => T): T {
  const unculled: THREE.Object3D[] = [];
  const uncull = (o: THREE.Object3D): void => {
    if (!o.frustumCulled) return;
    o.frustumCulled = false;
    unculled.push(o);
  };
  root.traverse((o) => {
    if (drawsGlass(o)) o.traverse(uncull);
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
