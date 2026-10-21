import * as THREE from 'three/webgpu';
import type { Box, LayerKind, Vec3 } from '../../layers';
import { type AssetNode, type AssetPlan, type AssetProblem, planAsset } from './plan';

/**
 * Builds a loaded asset into the game (S-23): the plan of plan.ts applied to the three objects of a glTF scene.
 *  - layered: the objects to put on each layer (LayerField.assign), parents before children so a named object inside
 *    another keeps its own layer; a level-of-detail chain is one THREE.LOD
 *  - colliders: the _col objects as world-space triangles (for Rapier, physics.ts), taken out of the scene
 *  - sockets and bells with their extras
 * Pure three (no GPU): the scene adds `root` and assigns the layers.
 */

/** 仮: distance (m) from which each level of detail is shown (the doc only says 距離で切り替える). */
export const LOD_DISTANCES: readonly number[] = [0, 15, 40];

export interface ColliderShape {
  name: string;
  layer: LayerKind;
  /** World space, xyz per vertex. */
  positions: Float32Array;
  indices: Uint32Array;
  box: Box;
}

export interface AssembledAsset {
  root: THREE.Object3D;
  /** In the order to assign them. */
  layered: { object: THREE.Object3D; layer: LayerKind }[];
  colliders: ColliderShape[];
  /** In world space, like the colliders. */
  sockets: { name: string; radius: number; seat: Vec3 }[];
  bells: { name: string; pitch: string; origin: Vec3 }[];
  lods: THREE.LOD[];
  problems: AssetProblem[];
  plan: AssetPlan;
}

/** The node name the glTF gave the object (GLTFLoader keeps it in userData.name; object.name is made unique). */
const gltfName = (o: THREE.Object3D): string => (typeof o.userData.name === 'string' ? o.userData.name : '');

/** Node extras (GLTFLoader merges them into userData). */
function extrasOf(o: THREE.Object3D): Record<string, unknown> {
  const { name: _name, gltfExtensions: _ext, ...extras } = o.userData as Record<string, unknown>;
  return extras;
}

const isDrawable = (o: THREE.Object3D): boolean =>
  (o as { isMesh?: boolean }).isMesh === true ||
  (o as { isLine?: boolean }).isLine === true ||
  (o as { isPoints?: boolean }).isPoints === true;

function colliderShape(name: string, layer: LayerKind, meshes: THREE.Mesh[]): ColliderShape {
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new THREE.Vector3();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    const base = positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
      for (let k = 0; k < 3; k++) {
        const c = v.getComponent(k);
        if (c < (min[k] as number)) min[k] = c;
        if (c > (max[k] as number)) max[k] = c;
      }
    }
    const index = mesh.geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) indices.push(base + i);
  }
  return {
    name,
    layer,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    box: { min, max },
  };
}

export function assembleAsset(
  root: THREE.Object3D,
  options: { lodDistances?: readonly number[] } = {},
): AssembledAsset {
  root.updateMatrixWorld(true);
  const objects: THREE.Object3D[] = [];
  const nodes: AssetNode[] = [];
  const index = new Map<THREE.Object3D, number>();
  root.traverse((o) => {
    if (o === root) return;
    // the plan works in the asset's own space (the glTF scene, where extras.origin is written); world below
    const p = root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    index.set(o, objects.length);
    objects.push(o);
    nodes.push({
      name: gltfName(o),
      parent: o.parent && o.parent !== root ? (index.get(o.parent) ?? null) : null,
      renderable: isDrawable(o),
      extras: extrasOf(o),
      position: [p.x, p.y, p.z],
    });
  });
  const plan = planAsset(nodes);
  const nameOf = (i: number) => nodes[i]?.name ?? '';
  const toWorld = (p: Vec3): Vec3 => {
    const v = new THREE.Vector3(...p).applyMatrix4(root.matrixWorld);
    return [v.x, v.y, v.z];
  };

  // colliders: their world triangles, then out of the scene. They are never drawn, so only their geometry is released
  // (a material may be shared with what is drawn: GLTFLoader's default material, or the visual's own)
  const colliders: ColliderShape[] = [];
  for (const c of plan.colliders) {
    const meshes = objects.filter(
      (o, i) => plan.owners[i] === c.node && (o as THREE.Mesh).isMesh === true,
    ) as THREE.Mesh[];
    colliders.push(colliderShape(nameOf(c.node), c.layer, meshes));
    const object = objects[c.node];
    if (object) {
      object.removeFromParent();
      object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
  }

  // levels of detail: one THREE.LOD per chain, at the root, keeping the levels where they are in the world
  const distances = options.lodDistances ?? LOD_DISTANCES;
  const inChain = new Set<number>();
  const lods: THREE.LOD[] = [];
  for (const chain of plan.lods) {
    const lod = new THREE.LOD();
    lod.name = chain.key;
    // THREE.LOD measures the distance to itself: put it where the nearest level is
    const first = objects[chain.levels[0]?.node ?? -1];
    if (first) root.worldToLocal(first.getWorldPosition(lod.position));
    root.add(lod);
    lod.updateMatrixWorld(true);
    for (const level of chain.levels) {
      const object = objects[level.node];
      if (!object) continue;
      inChain.add(level.node);
      lod.attach(object);
      // by the level's own number, so a chain without LOD1 still switches LOD2 at its distance
      lod.addLevel(object, distances[Math.min(level.lod, distances.length - 1)] ?? 0);
    }
    lods.push(lod);
  }

  const layered: AssembledAsset['layered'] = [];
  for (const v of plan.visuals) {
    const object = objects[v.node];
    if (object && !inChain.has(v.node)) layered.push({ object, layer: v.layer });
  }
  plan.lods.forEach((chain, k) => {
    const lod = lods[k];
    if (lod) layered.push({ object: lod, layer: chain.layer });
  });

  return {
    root,
    layered,
    colliders,
    sockets: plan.sockets.map((s) => ({ name: nameOf(s.node), radius: s.radius, seat: toWorld(s.seat) })),
    bells: plan.bells.map((b) => ({ name: nameOf(b.node), pitch: b.pitch, origin: toWorld(b.origin) })),
    lods,
    problems: plan.problems,
    plan,
  };
}
