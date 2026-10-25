import { uniform } from 'three/tsl';

/**
 * The strength of the lights baked apart (S-37; src/core/assets/lightmap.ts lightmap_layers): one uniform per layer, shared by
 * every baked material of every area that has that layer (1 = as baked). The area's loader gives them to the baked materials
 * (area.ts); the room that owns the light changes them every frame (room-art.ts animate: the fire breathes).
 *
 * Module-wide: the value is the light's, not the material's, so two rooms built one after the other (the home's orb, the
 * prologue) share it, and whoever animates the fire sets it for both.
 */
const makeGain = () => uniform(1);
export type BakedLightGain = ReturnType<typeof makeGain>;

/** The layer the furnace's fire and the annealer's embers are baked into (blender/scripts/make_workshop.py FIRE_LAYER). */
export const FIRE_LIGHT_LAYER = 'fire';

const gains = new Map<string, BakedLightGain>();

/** The strength of a layer's baked light: a float uniform, 1 until someone changes it. */
export function bakedLightGain(layer: string): BakedLightGain {
  let g = gains.get(layer);
  if (!g) {
    g = makeGain();
    gains.set(layer, g);
  }
  return g;
}
