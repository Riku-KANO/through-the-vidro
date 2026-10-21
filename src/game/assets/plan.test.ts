import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AssetNode, planAsset } from './plan';

/**
 * Assembling a loaded asset from its names and extras (設計書 Blenderアセットパイプライン > 命名規則とゲーム情報:
 * カスタムプロパティはglTFのextrasとして書き出し、ゲーム側で読み取ってギミックを自動で組み立てます).
 */
interface Cases {
  extras: { name: string; extras: Record<string, unknown>; problems: string[] }[];
  sets: {
    about: string;
    objects: { name: string; extras?: Record<string, unknown> }[];
    problems: { object: string; code: string }[];
  }[];
}
const cases = JSON.parse(
  readFileSync(join(process.cwd(), 'blender/scripts/vidro/naming_cases.json'), 'utf8'),
) as Cases;

const node = (name: string, extra: Partial<AssetNode> = {}): AssetNode => ({
  name,
  parent: null,
  renderable: true,
  extras: {},
  position: [0, 0, 0],
  ...extra,
});

const codes = (nodes: AssetNode[]) =>
  planAsset(nodes).problems.map((p) => ({ object: p.object, code: p.code }));

describe('planAsset: extras of one object (shared cases)', () => {
  for (const c of cases.extras) {
    it(`${c.name} ${JSON.stringify(c.extras)} → [${c.problems.join(', ')}]`, () => {
      const plan = planAsset([node(c.name, { extras: c.extras })]);
      expect(plan.problems.map((p) => p.code)).toEqual(c.problems);
      for (const p of plan.problems) expect(p.object).toBe(c.name);
    });
  }
});

describe('planAsset: rules over several objects (shared cases)', () => {
  for (const c of cases.sets) {
    it(c.about, () => {
      const nodes = c.objects.map((o) => node(o.name, { extras: o.extras ?? {} }));
      expect(codes(nodes)).toEqual(c.problems);
    });
  }
});

describe('planAsset: layers', () => {
  it('draws _front on the surface layer, _back on the back layer, the rest on both', () => {
    const plan = planAsset([
      node('A1_bld_dome03_front'),
      node('A1_brg_bridge02_back'),
      node('A1_flr_floor01'),
    ]);
    expect(plan.visuals.map((v) => [v.node, v.layer])).toEqual([
      [0, 'surface'],
      [1, 'back'],
      [2, 'shared'],
    ]);
    expect(plan.problems).toEqual([]);
  });

  it('reads the glass placement from the extras, near by default', () => {
    const plan = planAsset([
      node('A1_bld_dome03_front', { extras: { placement: 'behind-glass' } }),
      node('A1_bld_dome04_front'),
    ]);
    expect(plan.visuals.map((v) => v.placement)).toEqual(['behind-glass', 'near']);
  });

  it('lets parts without a name of their own belong to the nearest named ancestor', () => {
    // GLTFLoader turns a mesh with two materials into a group of two meshes, and gltf-transform's quantization
    // can move a mesh into an unnamed child node.
    const plan = planAsset([
      node('A1_bld_dome03_front', { renderable: false }),
      node('', { parent: 0 }),
      node('A1_bld_dome03_front_1', { parent: 0 }),
      node('Cube.004', { parent: 2 }),
    ]);
    expect(plan.owners).toEqual([0, 0, 0, 0]);
    expect(plan.visuals.map((v) => v.node)).toEqual([0]);
    expect(plan.problems).toEqual([]);
  });

  it('keeps a named object inside another named object as an object of its own', () => {
    const plan = planAsset([node('A1_bld_dome03_front'), node('A1_bld_door01_back', { parent: 0 })]);
    expect(plan.owners).toEqual([0, 1]);
    expect(plan.visuals.map((v) => [v.node, v.layer])).toEqual([
      [0, 'surface'],
      [1, 'back'],
    ]);
  });

  it('reports a drawn object that has no valid name of its own or of an ancestor, and leaves it out', () => {
    const plan = planAsset([
      node('Scene', { renderable: false }),
      node('Cube.001', { parent: 0 }),
      node('Cube'),
    ]);
    expect(plan.problems.map((p) => [p.object, p.code])).toEqual([
      ['Cube.001', 'blender-duplicate'],
      ['Cube', 'format'],
    ]);
    expect(plan.visuals).toEqual([]);
  });

  it('ignores groups without geometry and without a valid name', () => {
    expect(planAsset([node('Scene', { renderable: false })]).problems).toEqual([]);
  });

  it('reports the same name twice', () => {
    expect(
      codes([node('A1_sock_02', { extras: { materialize_radius: 2 } }), node('A1_sock_02')]),
    ).toContainEqual({
      object: 'A1_sock_02',
      code: 'duplicate-name',
    });
  });
});

describe('planAsset: colliders', () => {
  it('turns _col into a collider that is not drawn', () => {
    const plan = planAsset([node('A1_flr_floor01'), node('A1_flr_floor01_col')]);
    expect(plan.visuals.map((v) => v.node)).toEqual([0]);
    expect(plan.colliders.map((c) => c.node)).toEqual([1]);
  });

  it('puts a collider on the layer of the visuals with the same name', () => {
    const plan = planAsset([
      node('A1_brg_bridge02_back'),
      node('A1_brg_bridge02_col'),
      node('A1_bld_dome03_front'),
      node('A1_bld_dome03_col'),
      node('A1_flr_floor01'),
      node('A1_flr_floor01_col'),
    ]);
    expect(plan.colliders.map((c) => [c.name.base, c.layer])).toEqual([
      ['A1_brg_bridge02', 'back'],
      ['A1_bld_dome03', 'surface'],
      ['A1_flr_floor01', 'shared'],
    ]);
  });

  it('puts a collider without visuals on both layers, unless `layer` says otherwise', () => {
    const plan = planAsset([
      node('A1_fen_edge01_col'),
      node('A1_fen_edge02_col', { extras: { layer: 'back' } }),
    ]);
    expect(plan.colliders.map((c) => c.layer)).toEqual(['shared', 'back']);
  });

  it('uses all the LOD levels of a visual to find the collider layer', () => {
    const plan = planAsset([
      node('A1_bld_dome03_front_LOD0'),
      node('A1_bld_dome03_front_LOD1'),
      node('A1_bld_dome03_col'),
    ]);
    expect(plan.colliders.map((c) => c.layer)).toEqual(['surface']);
    expect(plan.problems).toEqual([]);
  });
});

describe('planAsset: sockets and resonators', () => {
  it('reads the materialize radius of a socket from its extras', () => {
    const plan = planAsset([node('A1_sock_02', { extras: { materialize_radius: 4 } })]);
    expect(plan.sockets).toEqual([
      expect.objectContaining({ node: 0, radius: 4, name: expect.objectContaining({ base: 'A1_sock_02' }) }),
    ]);
  });

  it('seats the orb at the origin the pipeline wrote into the extras', () => {
    // gltf-transform's quantization moves the node to the middle of the mesh, so the node position is not the origin.
    const plan = planAsset([
      node('A1_sock_02', {
        extras: { materialize_radius: 2, origin: [1, 1.05, -3] },
        position: [1, 0.45, -3],
      }),
    ]);
    expect(plan.sockets[0]?.seat).toEqual([1, 1.05, -3]);
  });

  it('falls back to the node position when no origin was written', () => {
    const plan = planAsset([
      node('A1_sock_02', { extras: { materialize_radius: 2 }, position: [1, 0.9, -3] }),
    ]);
    expect(plan.sockets[0]?.seat).toEqual([1, 0.9, -3]);
  });

  it('draws a socket on both layers too', () => {
    const plan = planAsset([node('A1_sock_02', { extras: { materialize_radius: 2 } })]);
    expect(plan.visuals.map((v) => v.layer)).toEqual(['shared']);
  });

  it('leaves out a socket without a valid radius', () => {
    expect(planAsset([node('A1_sock_02')]).sockets).toEqual([]);
  });

  it('reads the pitch of a resonator', () => {
    const plan = planAsset([node('A3_bell_D4', { extras: { pitch: 'D4', origin: [0, 1, 0] } })]);
    expect(plan.bells).toEqual([expect.objectContaining({ node: 0, pitch: 'D4', origin: [0, 1, 0] })]);
  });
});

describe('planAsset: levels of detail', () => {
  it('groups _LOD0/1/2 of the same object, nearest first, whatever their order', () => {
    const plan = planAsset([
      node('CM_lmp_lamp01_LOD1'),
      node('A1_flr_floor01'),
      node('CM_lmp_lamp01_LOD0'),
      node('CM_lmp_lamp01_LOD2'),
    ]);
    expect(plan.lods).toEqual([
      {
        key: 'CM_lmp_lamp01',
        layer: 'shared',
        levels: [
          { lod: 0, node: 2 },
          { lod: 1, node: 0 },
          { lod: 2, node: 3 },
        ],
      },
    ]);
  });

  it('keeps front and back LOD chains of the same object apart', () => {
    const plan = planAsset([
      node('A1_bld_dome03_front_LOD0'),
      node('A1_bld_dome03_back_LOD0'),
      node('A1_bld_dome03_back_LOD1'),
    ]);
    expect(plan.lods.map((l) => [l.key, l.layer, l.levels.length])).toEqual([
      ['A1_bld_dome03_front', 'surface', 1],
      ['A1_bld_dome03_back', 'back', 2],
    ]);
  });
});
