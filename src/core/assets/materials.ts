import * as THREE from 'three/webgpu';
import { followBackdropResize } from '../glass/backdrop';

/**
 * Materials of loaded assets (S-23). GLTFLoader makes classic materials; the app draws with node materials (src/layers
 * patches node materials only, and a transmissive material needs a node before it is first drawn: AGENTS.md, S-12).
 * Pure three, no GPU: the unit tests run in Node.
 */

type NodeMaterialClass = new () => THREE.NodeMaterial;

/** The node material of each classic material GLTFLoader (and KHR_materials_unlit) can make. */
const NODE_CLASS: Readonly<Record<string, NodeMaterialClass>> = {
  MeshStandardMaterial: THREE.MeshStandardNodeMaterial,
  MeshPhysicalMaterial: THREE.MeshPhysicalNodeMaterial,
  MeshBasicMaterial: THREE.MeshBasicNodeMaterial,
  LineBasicMaterial: THREE.LineBasicNodeMaterial,
  PointsMaterial: THREE.PointsNodeMaterial,
};

/** Fields that belong to the material object itself, not to its look. */
const OWN_FIELDS = new Set(['uuid', 'id', 'type', 'version', '_listeners']);

const isNodeMaterial = (m: THREE.Material): m is THREE.NodeMaterial =>
  (m as { isNodeMaterial?: boolean }).isNodeMaterial === true;

/**
 * The node material with the same values and textures (the textures are shared, not copied). A node material is
 * returned as it is. Copies every enumerable field like three's NodeLibrary.fromMaterial (which WebGPURenderer uses
 * for classic materials), so transmission, ior, volume, specular, sheen, clearcoat… all come along; physical
 * materials then go through followBackdropResize (S-12).
 */
export function toNodeMaterial(material: THREE.Material): THREE.Material {
  if (isNodeMaterial(material)) return material;
  const NodeClass = NODE_CLASS[material.type];
  if (!NodeClass) throw new Error(`toNodeMaterial: no node material for ${material.type}`);
  const out = new NodeClass();
  const src = material as unknown as Record<string, unknown>;
  const dst = out as unknown as Record<string, unknown>;
  for (const key in src) {
    if (OWN_FIELDS.has(key) || key.startsWith('is')) continue;
    dst[key] = src[key];
  }
  if (out instanceof THREE.MeshPhysicalNodeMaterial) followBackdropResize(out);
  return out;
}

/**
 * Chooses the material of one mesh (e.g. the game's glass for a marked material). Return null to keep the default
 * (toNodeMaterial). Called once per mesh and material slot.
 */
export type MaterialHook = (material: THREE.Material, mesh: THREE.Mesh) => THREE.Material | null | undefined;

type Drawable = THREE.Object3D & { material: THREE.Material | THREE.Material[] };

const drawable = (o: THREE.Object3D): o is Drawable =>
  (o as { material?: unknown }).material !== undefined &&
  ((o as { isMesh?: boolean }).isMesh === true ||
    (o as { isLine?: boolean }).isLine === true ||
    (o as { isPoints?: boolean }).isPoints === true);

/**
 * Gives every drawable under `root` a node material: the hook's choice for meshes, otherwise toNodeMaterial (once per
 * source material, so objects that shared a material still share one). Transmissive physical node materials from the
 * hook also go through followBackdropResize. Returns the classic materials no object uses any more (dispose them; their
 * textures live on in the node materials).
 */
export function convertMaterials(root: THREE.Object3D, hook?: MaterialHook): { replaced: THREE.Material[] } {
  const converted = new Map<THREE.Material, THREE.Material>();
  const replaced = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!drawable(o)) return;
    const one = (m: THREE.Material): THREE.Material => {
      const chosen = (o as THREE.Mesh).isMesh ? hook?.(m, o as THREE.Mesh) : null;
      if (chosen) {
        if (chosen !== m) replaced.add(m);
        if (chosen instanceof THREE.MeshPhysicalNodeMaterial) followBackdropResize(chosen);
        return chosen;
      }
      let c = converted.get(m);
      if (!c) {
        c = toNodeMaterial(m);
        converted.set(m, c);
        if (c !== m) replaced.add(m);
      }
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
  });
  // a source can be replaced for one mesh and kept (already a node material) for another
  for (const c of converted.values()) replaced.delete(c);
  return { replaced: [...replaced] };
}

/** The textures a material holds in its fields (map, normalMap, thicknessMap…). Not those only inside its nodes. */
export const texturesOf = (m: THREE.Material): THREE.Texture[] => {
  const out: THREE.Texture[] = [];
  const fields = m as unknown as Record<string, unknown>;
  for (const key in fields) {
    const v = fields[key] as { isTexture?: boolean } | null;
    if (v?.isTexture === true) out.push(v as THREE.Texture);
  }
  return out;
};

/**
 * Releases the geometries, materials and textures under `root` (each once), and `alsoTextures`: textures that live only
 * inside nodes (a node material made from a texture keeps it in a texture node, not in a field).
 */
export function disposeObject(root: THREE.Object3D, alsoTextures: Iterable<THREE.Texture> = []): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((o) => {
    const g = (o as { geometry?: THREE.BufferGeometry }).geometry;
    if (g?.isBufferGeometry) geometries.add(g);
    const m = (o as { material?: THREE.Material | THREE.Material[] }).material;
    for (const mm of Array.isArray(m) ? m : m ? [m] : []) materials.add(mm);
  });
  for (const m of materials) for (const t of texturesOf(m)) textures.add(t);
  for (const t of alsoTextures) textures.add(t);
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) t.dispose();
}
