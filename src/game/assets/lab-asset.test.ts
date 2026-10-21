import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGlbJson } from '../../core/assets/glb';
import { parseAssetName, parseGlassMark } from './naming';
import { type AssetNode, planAsset } from './plan';

/**
 * The sample that `pnpm assets` exports from blender/scenes/asset-lab.blend (S-23), committed so that this check and
 * the asset-lab scene need neither Blender nor KTX-Software. It shows that what the pipeline wrote is what the game
 * expects: the glTF extensions of 設計書 Blenderアセットパイプライン > 書き出しと圧縮, one file per area plus a common one,
 * names and extras the game can assemble, and a second UV on the opaque meshes (焼き込み > 2つ目のUV).
 */
interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  extras?: Record<string, unknown>;
}
interface Gltf {
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  nodes?: GltfNode[];
  meshes?: { primitives: { attributes: Record<string, number>; material?: number }[] }[];
  materials?: { name?: string; extensions?: Record<string, unknown> }[];
  images?: { mimeType?: string }[];
}

const dir = join(process.cwd(), 'public/assets/lab');
const read = (file: string) => readGlbJson(readFileSync(join(dir, file))) as Gltf;
const files = { a0: read('a0.glb'), common: read('common.glb') };

const nodesOf = (g: Gltf): AssetNode[] => {
  const nodes = g.nodes ?? [];
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => {
    for (const c of n.children ?? []) parent.set(c, i);
  });
  return nodes.map((n, i) => ({
    name: n.name ?? '',
    parent: parent.get(i) ?? null,
    renderable: n.mesh !== undefined,
    extras: n.extras ?? {},
    position: [n.translation?.[0] ?? 0, n.translation?.[1] ?? 0, n.translation?.[2] ?? 0],
  }));
};
const named = (g: Gltf) =>
  (g.nodes ?? []).flatMap((n) => {
    const r = parseAssetName(n.name ?? '');
    return r.ok ? [{ node: n, name: r.value }] : [];
  });

describe('the exported sample (public/assets/lab)', () => {
  for (const [group, g] of Object.entries(files)) {
    it(`${group}.glb is compressed with meshopt and quantized, which the game must decode`, () => {
      expect(g.extensionsUsed).toEqual(
        expect.arrayContaining(['EXT_meshopt_compression', 'KHR_mesh_quantization']),
      );
      expect(g.extensionsRequired).toEqual(expect.arrayContaining(['EXT_meshopt_compression']));
    });

    it(`${group}.glb holds only objects of its own group`, () => {
      const groups = new Set(named(g).map((n) => n.name.group));
      expect([...groups]).toEqual([group]);
    });

    it(`${group}.glb assembles without problems`, () => {
      expect(planAsset(nodesOf(g)).problems).toEqual([]);
    });

    it(`${group}.glb: a texture is KTX2 only with KHR_texture_basisu`, () => {
      const ktx2 = (g.images ?? []).some((i) => i.mimeType === 'image/ktx2');
      expect((g.extensionsUsed ?? []).includes('KHR_texture_basisu')).toBe(ktx2);
    });
  }

  it('keeps the glass extensions: transmission, ior, volume (absorption), specular', () => {
    expect(files.a0.extensionsUsed).toEqual(
      expect.arrayContaining([
        'KHR_materials_transmission',
        'KHR_materials_ior',
        'KHR_materials_volume',
        'KHR_materials_specular',
      ]),
    );
  });

  it('has the pieces of the sample: floor, brass frame, socket, glass on both layers, colliders', () => {
    const kinds = named(files.a0).map((n) => `${n.name.kind}:${n.name.role ?? '-'}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['flr:-', 'frm:-', 'sock:-', 'flr:col', 'sock:col', 'brg:back', 'brg:col']),
    );
    expect(kinds.some((k) => k.endsWith(':front'))).toBe(true);
    const marks = (files.a0.materials ?? []).map((m) => parseGlassMark(m.name ?? ''));
    expect(marks.filter((m) => m?.ok).length).toBeGreaterThanOrEqual(2);
    expect(marks.every((m) => m === null || m.ok)).toBe(true);
  });

  it('gives the socket its materialize radius and the origin the orb sits at', () => {
    const plan = planAsset(nodesOf(files.a0));
    expect(plan.sockets.length).toBe(1);
    const socket = files.a0.nodes?.[plan.sockets[0]?.node ?? -1];
    expect(socket?.extras?.materialize_radius).toBeGreaterThan(0);
    expect(socket?.extras?.origin).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
  });

  it('keeps a level-of-detail chain in the common file', () => {
    const plan = planAsset(nodesOf(files.common));
    expect(plan.lods.map((l) => l.levels.map((v) => v.lod))).toContainEqual([0, 1]);
  });

  it('gives every opaque drawn mesh a second UV, and leaves glass and colliders alone', () => {
    for (const g of Object.values(files)) {
      const plan = planAsset(nodesOf(g));
      const colliders = new Set(plan.colliders.map((c) => c.node));
      const transmissive = (m: number | undefined) =>
        m !== undefined && g.materials?.[m]?.extensions?.KHR_materials_transmission !== undefined;
      let opaque = 0;
      (g.nodes ?? []).forEach((node, i) => {
        const owner = plan.owners[i];
        if (node.mesh === undefined || owner === null || owner === undefined || colliders.has(owner)) return;
        for (const p of g.meshes?.[node.mesh]?.primitives ?? []) {
          if (transmissive(p.material)) continue;
          opaque++;
          expect(Object.keys(p.attributes), g.nodes?.[owner]?.name).toContain('TEXCOORD_1');
        }
      });
      expect(opaque).toBeGreaterThanOrEqual(2);
    }
  });
});
