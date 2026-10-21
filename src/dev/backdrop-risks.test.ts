import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { followBackdropResize } from '../core/glass/backdrop';
import { backdropRisks } from './backdrop-risks';

const geometry = new THREE.BoxGeometry();
/** Hand-made transmissive glass without any node: what three r186 can draw with a destroyed backdrop (S-12). */
const riskyGlass = (name = 'risky') =>
  Object.assign(new THREE.MeshPhysicalNodeMaterial({ transmission: 1, thickness: 0.4 }), { name });
const mesh = (material: THREE.Material | THREE.Material[], name = '') =>
  Object.assign(new THREE.Mesh(geometry, material), { name });
const flagged = (roots: THREE.Object3D[]) =>
  backdropRisks(roots).risks.map((r) => ({ material: r.material, objects: r.objects, names: r.objectNames }));

describe('backdropRisks: which materials need followBackdropResize() (S-14)', () => {
  it('reports a transmissive material without a node, with its objects', () => {
    const scene = new THREE.Scene();
    const glass = riskyGlass();
    scene.add(mesh(glass, 'a'), mesh(glass, 'b'));
    const { risks } = backdropRisks([scene]);
    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      material: 'risky',
      materialType: expect.stringMatching(/^MeshPhysicalNodeMaterial#\d+$/),
      thickness: 0.4,
      objects: 2,
      objectNames: ['a', 'b'],
    });
  });

  it('does not report glass that has a node, nor materials without transmission', () => {
    const scene = new THREE.Scene();
    const followed = followBackdropResize(riskyGlass('followed'));
    const opaque = new THREE.MeshStandardNodeMaterial({ color: 0x808080 });
    const physicalOpaque = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.2 });
    scene.add(mesh(followed), mesh(opaque), mesh(physicalOpaque));
    expect(flagged([scene])).toEqual([]);
  });

  it('looks inside material arrays, and counts an object once when the array repeats a material', () => {
    const scene = new THREE.Scene();
    const glass = riskyGlass();
    const opaque = new THREE.MeshStandardNodeMaterial();
    scene.add(mesh([opaque, glass, glass], 'multi'));
    expect(flagged([scene])).toEqual([{ material: 'risky', objects: 1, names: ['multi'] }]);
  });

  it("looks at a scene's overrideMaterial", () => {
    const scene = new THREE.Scene();
    scene.name = 'overridden';
    scene.overrideMaterial = riskyGlass('override');
    scene.add(mesh(new THREE.MeshStandardNodeMaterial()));
    expect(flagged([scene])).toEqual([{ material: 'override', objects: 1, names: ['overridden'] }]);
  });

  it('counts an object once when roots overlap, and lists each root once', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const glass = riskyGlass();
    group.add(mesh(glass, 'inside'));
    scene.add(group);
    const report = backdropRisks([scene, group, scene]);
    expect(report.roots).toEqual([`Scene#${scene.id}`, `Group#${group.id}`]);
    expect(report.risks.map((r) => r.objects)).toEqual([1]);
  });

  it('looks at every root it is given, not only the first (a world drawn outside the scene)', () => {
    const home = new THREE.Scene();
    home.add(mesh(new THREE.MeshStandardNodeMaterial()));
    const world = new THREE.Scene();
    world.add(mesh(riskyGlass('vessel'), 'vessel'));
    expect(flagged([home])).toEqual([]);
    expect(flagged([home, world])).toEqual([{ material: 'vessel', objects: 1, names: ['vessel'] }]);
  });

  it('names objects by type and id when unnamed, and lists at most three', () => {
    const scene = new THREE.Scene();
    const glass = riskyGlass();
    const meshes = [0, 1, 2, 3].map(() => mesh(glass));
    scene.add(...meshes);
    const [risk] = backdropRisks([scene]).risks;
    expect(risk?.objects).toBe(4);
    expect(risk?.objectNames).toEqual(meshes.slice(0, 3).map((m) => `Mesh#${m.id}`));
  });
});
