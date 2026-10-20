import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY } from './constants';

/**
 * Rapier (技術設計 > 技術スタック: 物理). The WebAssembly module loads once; await initPhysics()
 * before creating worlds. The world belongs to the scene (S-06 shares it with the back-layer colliders
 * of S-02), and the scene steps it once per frame before updating the player.
 */
let ready: Promise<typeof RAPIER> | null = null;

export function initPhysics(): Promise<typeof RAPIER> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

export function createWorld(): RAPIER.World {
  return new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
}
