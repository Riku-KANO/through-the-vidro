import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { readGlbJson } from '../../core/assets/glb';
import {
  FURNACE_FACING,
  FURNACE_MOUTH,
  GRATE,
  GRATE_CENTER,
  WATER_TUB,
  WIND_CHIME,
  WORKSHOP_ASSET,
  WORKSHOP_OBJECTS,
} from '../prologue/layout';
import { type AssembledAsset, assembleAsset } from './assemble';
import { parseAssetName, parseGlassMark } from './naming';
import { loadGlbInNode } from './node-glb.test-helper';

/**
 * The workshop's interior as `pnpm assets` exported it from blender/scenes/workshop.blend (S-24), read the way the game
 * reads it. What it shows: the approved plan is all there (named by the design doc's rules), each piece stands where
 * src/game/prologue/layout.ts says (the sounds of S-25 and the floor of the grate rely on it), furniture has colliders,
 * the materials are the doc's glass kinds and brass, props keep to their triangle budget and share one atlas.
 */
interface GltfJson {
  extensionsUsed?: string[];
  nodes?: { name?: string; mesh?: number; children?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; material?: number; indices?: number }[] }[];
  materials?: {
    name?: string;
    emissiveFactor?: number[];
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
    emissiveTexture?: { index: number };
    extensions?: Record<string, { emissiveStrength?: number } | undefined>;
  }[];
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
  images?: { mimeType?: string }[];
  accessors?: { count: number }[];
}

const file = join(process.cwd(), 'public', WORKSHOP_ASSET);
let gltf: GLTF;
let built: AssembledAsset;
let json: GltfJson;
beforeAll(async () => {
  json = readGlbJson(readFileSync(file)) as GltfJson;
  gltf = await loadGlbInNode(file);
  built = assembleAsset(gltf.scene);
});

const PIECES = Object.values(WORKSHOP_OBJECTS);
const objectNamed = (name: string): THREE.Object3D => {
  const o = built.layered.find((l) => l.object.userData.name === name)?.object;
  if (!o) throw new Error(`no object ${name}`);
  return o;
};
/** World box of an object's meshes, or only of their vertices below `maxY`. */
function boxOf(o: THREE.Object3D, maxY = Number.POSITIVE_INFINITY): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  o.updateWorldMatrix(true, true);
  o.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    const p = mesh.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      if (v.y <= maxY) box.expandByPoint(v);
    }
  });
  return box;
}
const materialName = (m: THREE.Material | THREE.Material[]): string[] =>
  (Array.isArray(m) ? m : [m]).map((x) => x.name);

describe('the workshop interior as exported (public/assets/workshop/a0.glb)', () => {
  it('holds every piece of the approved plan, named <area>_<kind>_<id> in area A0, and assembles without problems', () => {
    expect(built.problems).toEqual([]);
    for (const p of PIECES) {
      const parsed = parseAssetName(p.name);
      expect(parsed.ok && parsed.value.area).toBe('A0');
      expect(() => objectNamed(p.name)).not.toThrow();
    }
    // nothing on one layer only: the workshop is the same on both (the back layer has nothing of its own here)
    expect(new Set(built.layered.map((l) => l.layer))).toEqual(new Set(['shared']));
  });

  it('the plan names every object of the file, so the checks here and room.ts’s `missing` see them all (S-30)', () => {
    // S-27 added nine objects that only Blender's own tests saw (process/slices/S-27.md 提案8)
    const planned = new Set<string>(PIECES.map((p) => p.name));
    const inFile = built.layered.map((l) => String(l.object.userData.name));
    expect(inFile.filter((name) => !planned.has(name))).toEqual([]);
  });

  it('each piece stands where layout.ts puts it', () => {
    for (const p of PIECES) {
      const box = boxOf(objectNamed(p.name));
      const [x, z] = p.at;
      expect(x, p.name).toBeGreaterThan(box.min.x - 0.05);
      expect(x, p.name).toBeLessThan(box.max.x + 0.05);
      expect(z, p.name).toBeGreaterThan(box.min.z - 0.05);
      expect(z, p.name).toBeLessThan(box.max.z + 0.05);
    }
  });

  it('the sound sources of S-25 are where they are drawn: the tub, the chime, the fire in the furnace’s mouth', () => {
    const tub = boxOf(objectNamed(WORKSHOP_OBJECTS.tub.name)).getCenter(new THREE.Vector3());
    expect(Math.hypot(tub.x - WATER_TUB.center[0], tub.z - WATER_TUB.center[2])).toBeLessThan(0.05);
    const chime = objectNamed(WORKSHOP_OBJECTS.chime.name);
    let bell: THREE.Box3 | null = null;
    chime.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh && materialName(mesh.material).includes('glass_clear')) bell = boxOf(mesh);
    });
    if (!bell) throw new Error('the chime has no clear-glass bell');
    expect((bell as THREE.Box3).distanceToPoint(new THREE.Vector3(...WIND_CHIME))).toBeLessThan(0.03);
    // the fire: the furnace's part in A0_fire
    let fire: THREE.Box3 | null = null;
    objectNamed(WORKSHOP_OBJECTS.furnace.name).traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh && materialName(mesh.material).includes('A0_fire')) fire = boxOf(mesh);
    });
    if (!fire) throw new Error('the furnace has no fire');
    const c = (fire as THREE.Box3).getCenter(new THREE.Vector3());
    expect(c.distanceTo(new THREE.Vector3(...FURNACE_MOUTH))).toBeLessThan(0.08);
  });

  it('the brass grate covers the floor zone of brass footsteps, in front of the furnace', () => {
    const box = boxOf(objectNamed(WORKSHOP_OBJECTS.grate.name));
    // the zone's corners (a rectangle turned toward the centre) span this box
    const [fx, fz] = FURNACE_FACING;
    const corners = [-1, 1].flatMap((a) =>
      [-1, 1].map((b) => [
        GRATE_CENTER[0] + (a * fx * GRATE.depth) / 2 + (b * -fz * GRATE.width) / 2,
        GRATE_CENTER[1] + (a * fz * GRATE.depth) / 2 + (b * fx * GRATE.width) / 2,
      ]),
    );
    const xs = corners.map((q) => q[0] ?? 0);
    const zs = corners.map((q) => q[1] ?? 0);
    expect(box.min.x).toBeCloseTo(Math.min(...xs), 1);
    expect(box.max.x).toBeCloseTo(Math.max(...xs), 1);
    expect(box.min.z).toBeCloseTo(Math.min(...zs), 1);
    expect(box.max.z).toBeCloseTo(Math.max(...zs), 1);
    // it lies on the floor: no higher than a few centimetres (no step, no collider)
    expect(box.max.y).toBeLessThan(0.04);
    expect(box.min.y).toBeGreaterThan(-0.01);
  });

  it('furniture has a collider (_col) the size of what is drawn below head height; the floor grate, the chime and the pieces have none', () => {
    const cols = new Map(built.colliders.map((c) => [c.name, c]));
    for (const p of PIECES) {
      const col = cols.get(`${p.name}_col`);
      expect(!!col, p.name).toBe(p.col);
      if (!col) continue;
      expect(col.layer).toBe('shared');
      const seen = boxOf(objectNamed(p.name), 2.2);
      const [x0, y0, z0] = col.box.min;
      const [x1, y1, z1] = col.box.max;
      // 空間の可読性と導線 4: no bigger than what you see (a few cm), and covering it
      for (const [c, v] of [
        [x0, seen.min.x],
        [z0, seen.min.z],
      ] as const)
        expect(Math.abs(c - v), `${p.name} min`).toBeLessThan(0.08);
      for (const [c, v] of [
        [x1, seen.max.x],
        [z1, seen.max.z],
      ] as const)
        expect(Math.abs(c - v), `${p.name} max`).toBeLessThan(0.08);
      // from where it is drawn lowest: the floor for what stands on it, 0.29 m for the shelf's back board hung on the
      // leaning wall (S-27; S-24's check, y0 < 0.05, knew only furniture on the floor)
      expect(Math.abs(y0 - seen.min.y), `${p.name} bottom`).toBeLessThan(0.05);
      expect(y1, `${p.name} top`).toBeGreaterThan(Math.min(seen.max.y, 2.2) - 0.08);
    }
  });

  it('the glass is the design doc’s kinds (bubble, milky, clear, frosted), marked for the game; the rest is opaque', () => {
    const materials = json.materials ?? [];
    const marks = materials.map((m) => parseGlassMark(m.name ?? '')).filter((m) => m !== null);
    for (const m of marks) expect(m.ok).toBe(true);
    // 色の進行: 序章はほぼ無色 (no amber, lapis or jade yet)
    const kinds = new Set(marks.map((m) => (m.ok ? m.value.kind : '')));
    expect(kinds).toEqual(new Set(['clear', 'frosted', 'bubble', 'milky']));
    // anything not marked is opaque (brass, the frosted tops, water, fire): no glass the library does not make
    for (const m of materials.filter((x) => parseGlassMark(x.name ?? '') === null))
      expect(Object.keys(m.extensions ?? {}), m.name).not.toContain('KHR_materials_transmission');
  });

  it('only the furnace glows warm; the annealer only faintly (光と時間帯: 工房で唯一の暖かい光)', () => {
    const glowing = new Set<string>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const e = (m as THREE.MeshStandardMaterial).emissive;
        if (e && e.r + e.g + e.b > 0) {
          let owner: THREE.Object3D | null = mesh;
          while (owner && !parseAssetName(String(owner.userData.name ?? '')).ok) owner = owner.parent;
          glowing.add(String(owner?.userData.name));
        }
      }
    });
    expect(glowing).toEqual(new Set([WORKSHOP_OBJECTS.furnace.name, WORKSHOP_OBJECTS.annealer.name]));
    const strength = (name: string): number => {
      const m = (json.materials ?? []).find((x) => x.name === name);
      return m?.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
    };
    expect(strength('A0_ember')).toBeLessThan(strength('A0_fire') / 4);
  });

  it('props keep to 500–3000 triangles each (小物: アトラスで共有), the interior well inside an area', () => {
    let total = 0;
    for (const p of PIECES) {
      let triangles = 0;
      objectNamed(p.name).traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const index = mesh.geometry.getIndex();
        triangles += (index ? index.count : mesh.geometry.getAttribute('position').count) / 3;
      });
      expect(triangles, p.name).toBeGreaterThanOrEqual(500);
      expect(triangles, p.name).toBeLessThanOrEqual(3000);
      total += triangles;
    }
    expect(total).toBeLessThan(60_000);
  });

  it('the opaque props share one texture atlas (KTX2), the glass has none', () => {
    expect(json.images?.length).toBe(1);
    expect(json.images?.[0]?.mimeType).toBe('image/ktx2');
    expect(json.extensionsUsed).toEqual(
      expect.arrayContaining(['KHR_texture_basisu', 'EXT_meshopt_compression']),
    );
    const source = (t: { index: number } | undefined) => {
      if (!t) return undefined;
      const tex = json.textures?.[t.index];
      return tex?.extensions?.KHR_texture_basisu?.source ?? tex?.source;
    };
    for (const m of json.materials ?? []) {
      const name = m.name ?? '';
      const used = [source(m.pbrMetallicRoughness?.baseColorTexture), source(m.emissiveTexture)].filter(
        (s) => s !== undefined,
      );
      if (parseGlassMark(name) !== null || name === 'A0_air') expect(used, name).toEqual([]);
      else {
        expect(used.length, name).toBeGreaterThan(0);
        for (const s of used) expect(s, name).toBe(0);
      }
    }
  });

  it('opaque pieces carry the second UV for the light bake (S-26)', () => {
    const glassMaterials = new Set(
      (json.materials ?? []).flatMap((m, i) =>
        parseGlassMark(m.name ?? '') !== null && m.name !== 'glass_milky' ? [i] : [],
      ),
    );
    const nodes = json.nodes ?? [];
    const parent = new Map<number, number>();
    nodes.forEach((n, i) => {
      for (const c of n.children ?? []) parent.set(c, i);
    });
    /** The named object a node belongs to (quantization can move a mesh into an unnamed child). */
    const owner = (i: number): string => {
      for (let j: number | undefined = i; j !== undefined; j = parent.get(j)) {
        const name = nodes[j]?.name ?? '';
        if (parseAssetName(name).ok) return name;
      }
      return '';
    };
    nodes.forEach((n, i) => {
      if (n.mesh === undefined || owner(i).endsWith('_col')) return;
      const prims = json.meshes?.[n.mesh]?.primitives ?? [];
      const opaque = prims.some((p) => p.material === undefined || !glassMaterials.has(p.material));
      if (!opaque) return;
      for (const p of prims) expect(Object.keys(p.attributes), owner(i)).toContain('TEXCOORD_1');
    });
  });
});
