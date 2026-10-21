import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { assembleAsset, LOD_DISTANCES } from './assemble';

/**
 * assembleAsset applies the plan (plan.ts) to the three objects GLTFLoader makes: the glTF node name is in
 * userData.name (object.name is made unique), node extras are merged into userData.
 */
const box = () => new THREE.BoxGeometry(1, 1, 1);
const mat = () => new THREE.MeshStandardNodeMaterial();

function node<T extends THREE.Object3D>(o: T, gltfName: string, extras: Record<string, unknown> = {}): T {
  o.name = `${gltfName}_unique`;
  Object.assign(o.userData, { name: gltfName, ...extras });
  return o;
}

function asset() {
  const root = new THREE.Group();
  const floor = node(new THREE.Mesh(box(), mat()), 'A0_flr_floor01');
  const col = node(new THREE.Mesh(box(), mat()), 'A0_flr_floor01_col');
  col.position.set(0, -0.5, 0);
  col.scale.set(8, 1, 8); // the world box is 8 × 1 × 8 with its top at y = 0
  const socket = node(new THREE.Object3D(), 'A0_sock_01', { materialize_radius: 2, origin: [1, 1, -1] });
  socket.position.set(1, 0.5, -1); // quantization moved the node to the middle of its mesh
  socket.add(new THREE.Mesh(box(), mat())); // the mesh in an unnamed child
  const lod0 = node(new THREE.Mesh(box(), mat()), 'CM_lmp_lamp01_LOD0');
  const lod1 = node(new THREE.Mesh(box(), mat()), 'CM_lmp_lamp01_LOD1');
  lod0.position.set(2, 1, -2);
  lod1.position.set(2, 1, -2);
  const back = node(new THREE.Mesh(box(), mat()), 'A0_brg_bridge01_back');
  const door = node(new THREE.Mesh(box(), mat()), 'A0_dor_door01_front');
  back.add(door);
  root.add(floor, col, socket, lod0, lod1, back);
  return { root, floor, col, socket, lod0, lod1, back, door };
}

describe('assembleAsset', () => {
  it('puts the socket seat in world space, like the colliders, when the asset is placed elsewhere', () => {
    const a = asset();
    a.root.position.set(10, 0, -5);
    const built = assembleAsset(a.root);
    expect(built.sockets[0]?.seat).toEqual([11, 1, -6]);
    expect(built.colliders[0]?.box.min.map((v) => Math.round(v * 100) / 100)).toEqual([6, -1, -9]);
  });

  it('releases only the geometry of a collider (its material may be drawn elsewhere)', () => {
    const a = asset();
    const shared = a.floor.material;
    a.col.material = shared;
    let disposed = 0;
    shared.addEventListener('dispose', () => disposed++);
    assembleAsset(a.root);
    expect(disposed).toBe(0);
  });

  it('takes the colliders out of the scene as world-space triangles on their layer', () => {
    const a = asset();
    const built = assembleAsset(a.root);
    expect(a.col.parent).toBeNull();
    expect(built.colliders).toHaveLength(1);
    const [c] = built.colliders;
    expect(c?.name).toBe('A0_flr_floor01_col');
    expect(c?.layer).toBe('shared');
    expect(c?.box.min.map((v) => Math.round(v * 100) / 100)).toEqual([-4, -1, -4]);
    expect(c?.box.max.map((v) => Math.round(v * 100) / 100)).toEqual([4, 0, 4]);
    expect(c?.indices.length).toBe(36); // the 12 triangles of the box
  });

  it('makes one THREE.LOD per chain where its nearest level is, switching levels with the distance', () => {
    const a = asset();
    const built = assembleAsset(a.root);
    expect(built.lods).toHaveLength(1);
    const [lod] = built.lods;
    if (!lod) throw new Error('no LOD');
    expect(lod.position.toArray()).toEqual([2, 1, -2]);
    expect(lod.levels.map((l) => l.object)).toEqual([a.lod0, a.lod1]);
    // the levels stay where they were in the world
    a.root.updateMatrixWorld(true);
    expect(a.lod1.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([2, 1, -2]);
    const camera = new THREE.PerspectiveCamera();
    const shown = (distance: number) => {
      camera.position.set(2, 1, -2 + distance);
      camera.updateMatrixWorld(true);
      lod.update(camera);
      return [a.lod0.visible, a.lod1.visible];
    };
    expect(shown(2)).toEqual([true, false]);
    expect(shown((LOD_DISTANCES[1] ?? 0) + 5)).toEqual([false, true]);
  });

  it('switches a level by its own number when a level in between is missing', () => {
    const root = new THREE.Group();
    const lod0 = node(new THREE.Mesh(box(), mat()), 'CM_lmp_lamp01_LOD0');
    const lod2 = node(new THREE.Mesh(box(), mat()), 'CM_lmp_lamp01_LOD2');
    root.add(lod0, lod2);
    const [lod] = assembleAsset(root).lods;
    expect(lod?.levels.map((l) => l.distance)).toEqual([LOD_DISTANCES[0], LOD_DISTANCES[2]]);
  });

  it('lists the objects to put on each layer, parents before their named children', () => {
    const a = asset();
    const built = assembleAsset(a.root);
    const order = built.layered.map((l) => [l.object.userData.name ?? l.object.name, l.layer]);
    expect(order).toEqual([
      ['A0_flr_floor01', 'shared'],
      ['A0_sock_01', 'shared'],
      ['A0_brg_bridge01_back', 'back'],
      ['A0_dor_door01_front', 'surface'],
      ['CM_lmp_lamp01', 'shared'],
    ]);
  });

  it('reads the socket from the glTF names and extras, seated at the origin the pipeline wrote', () => {
    const built = assembleAsset(asset().root);
    expect(built.sockets).toEqual([{ name: 'A0_sock_01', radius: 2, seat: [1, 1, -1] }]);
    expect(built.problems).toEqual([]);
  });
});
