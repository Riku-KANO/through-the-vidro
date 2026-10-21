import type * as THREE from 'three/webgpu';
import { missesBackdropResize, readsBackdrop } from '../core/glass/backdrop';

/**
 * A material that three r186 may draw with a destroyed transmission backdrop once the render size has changed
 * (src/core/glass/backdrop.ts, S-12). One entry per material.
 */
export interface BackdropRisk {
  /** material.name ('' when unnamed). */
  material: string;
  /** three's type and id, e.g. MeshPhysicalNodeMaterial#36. */
  materialType: string;
  thickness: number | null;
  /** How many objects use it, and the first few of them (name, or type#id). */
  objects: number;
  objectNames: string[];
}

/** A root looked at (S-15). */
export interface BackdropRoot {
  /** type#id, e.g. Scene#10. */
  label: string;
  /**
   * How many materials under this root read the transmission backdrop (core's readsBackdrop), safe ones included:
   * each material once, whatever the number of its objects. Counted per root, so a group that is also under another
   * root counts in both.
   */
  backdropReaders: number;
}

export interface BackdropReport {
  /** The roots looked at, in the order given, each once. */
  roots: BackdropRoot[];
  risks: BackdropRisk[];
}

const MAX_OBJECT_NAMES = 3;

const label = (o: THREE.Object3D): string => o.name || `${o.type}#${o.id}`;

/**
 * The materials under these roots that core's missesBackdropResize() flags (?debug=1's backdropRisks(), S-14), and per
 * root how many materials read the backdrop at all (S-15: shows which root holds the glass, e.g. the dive world).
 * Looks at each object's material (or material array) and a scene's overrideMaterial, counts an object once per
 * material even when roots overlap or an array repeats the material, and leaves the judgement to core.
 * Sees the scene graph as it is now: not a material swapped in only during a pass, and it takes a node added to a
 * material after it was first drawn at face value (three decided at that first draw; process/slices/S-14.md).
 */
export function backdropRisks(roots: Iterable<THREE.Object3D>): BackdropReport {
  const looked: BackdropRoot[] = [];
  const seen = new Set<THREE.Object3D>();
  // per material, a set: an object is counted once when roots overlap or an array repeats the material
  const users = new Map<THREE.Material, Set<THREE.Object3D>>();
  let readers = new Set<THREE.Material>(); // of the root being walked
  const check = (material: THREE.Material | null | undefined, object: THREE.Object3D): void => {
    if (!material?.isMaterial || !readsBackdrop(material)) return;
    readers.add(material);
    if (!missesBackdropResize(material)) return;
    let objects = users.get(material);
    if (!objects) {
      objects = new Set();
      users.set(material, objects);
    }
    objects.add(object);
  };
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    readers = new Set();
    root.traverse((object) => {
      const { material } = object as { material?: THREE.Material | THREE.Material[] };
      for (const m of Array.isArray(material) ? material : [material]) check(m, object);
      check((object as Partial<THREE.Scene>).overrideMaterial, object);
    });
    looked.push({ label: `${root.type}#${root.id}`, backdropReaders: readers.size });
  }
  const risks = [...users].map(([material, objects]): BackdropRisk => {
    // id: three numbers every material (Material.js); the typings leave it out
    const { thickness, id } = material as { thickness?: unknown; id?: number };
    return {
      material: material.name,
      materialType: `${material.type}#${id}`,
      thickness: typeof thickness === 'number' ? thickness : null,
      objects: objects.size,
      objectNames: [...objects].slice(0, MAX_OBJECT_NAMES).map(label),
    };
  });
  return { roots: looked, risks };
}
