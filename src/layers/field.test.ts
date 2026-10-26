import { float } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LayerField } from './field';
import { drawnIn, viewMask } from './layers';

type Patched = THREE.NodeMaterial & { emissiveNode: THREE.Node | null };

/** True if `node` is `target` or has it somewhere below. */
function contains(node: THREE.Node | null | undefined, target: THREE.Node | null | undefined): boolean {
  if (!node || !target) return false;
  const seen = new Set<THREE.Node>();
  const stack: THREE.Node[] = [node];
  while (stack.length > 0) {
    const n = stack.pop() as THREE.Node;
    if (n === target) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const child of n.getChildren()) stack.push(child as THREE.Node);
  }
  return false;
}

const visibleTo = (o: THREE.Object3D, view: 'main' | 'peek'): boolean =>
  (o.layers.mask & viewMask(view)) !== 0;

describe('LayerField.assign (表・裏・共通の割り当て)', () => {
  it('puts objects on the layer that decides which views draw them', () => {
    const field = new LayerField();
    const back = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    const surface = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    field.assign(back, 'back');
    field.assign(surface, 'surface');
    expect(visibleTo(back, 'main')).toBe(drawnIn('back', 'main'));
    expect(visibleTo(back, 'peek')).toBe(true);
    expect(visibleTo(surface, 'peek')).toBe(false);
  });

  it('a material shared by a surface object and a back object is cut separately for each', () => {
    const field = new LayerField();
    const brass = new THREE.MeshStandardNodeMaterial();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(), brass);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(), brass);
    field.assign(wall, 'surface');
    field.assign(rail, 'back');
    const surfaceMat = wall.material as Patched;
    const backMat = rail.material as Patched;
    expect(backMat).not.toBe(surfaceMat);
    expect(surfaceMat.maskNode).toBeTruthy();
    expect(backMat.maskNode).toBeTruthy();
    // the back version must not carry the surface cut (that would hide it everywhere) …
    expect(contains(backMat.maskNode, surfaceMat.maskNode)).toBe(false);
    // … nor add the seam light a second time on top of the surface version
    expect(contains(backMat.emissiveNode, surfaceMat.emissiveNode)).toBe(false);
  });

  it('assigning the same material to the same kind again reuses one version', () => {
    const field = new LayerField();
    const m = new THREE.MeshStandardNodeMaterial();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), m);
    const b = new THREE.Mesh(new THREE.BoxGeometry(), m);
    field.assign(a, 'shared');
    field.assign(b, 'shared');
    expect(b.material).toBe(a.material);
  });

  it('a transmissive back object is drawn by the normal view, and by a stand-in in the peek image', () => {
    const field = new LayerField();
    const glass = new THREE.MeshPhysicalNodeMaterial({ transmission: 1, ior: 1.5, roughness: 0 });
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(), glass);
    field.assign(bridge, 'back');
    expect(visibleTo(bridge, 'main')).toBe(true);
    expect(visibleTo(bridge, 'peek')).toBe(false);
    const standIn = bridge.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh | undefined;
    expect(standIn).toBeDefined();
    expect(visibleTo(standIn as THREE.Mesh, 'peek')).toBe(true);
    expect(visibleTo(standIn as THREE.Mesh, 'main')).toBe(false);
    expect(((standIn as THREE.Mesh).material as THREE.MeshPhysicalNodeMaterial).transmission).toBe(0);
  });

  it('inPeek: false keeps an object out of the peek image without a stand-in', () => {
    const field = new LayerField();
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(),
      new THREE.MeshPhysicalNodeMaterial({ transmission: 1 }),
    );
    field.assign(orb, 'shared', { inPeek: false });
    expect(visibleTo(orb, 'main')).toBe(true);
    expect(visibleTo(orb, 'peek')).toBe(false);
    expect(orb.children).toHaveLength(0);
  });

  it('pins shadow cameras to the normal view', () => {
    const field = new LayerField();
    const sun = new THREE.DirectionalLight();
    field.assign(sun, 'shared');
    expect(sun.shadow.camera.layers.mask).toBe(viewMask('main'));
  });

  it('glass made transmissive by a node is treated like transmission > 0', () => {
    const field = new LayerField();
    const glass = new THREE.MeshPhysicalNodeMaterial();
    glass.transmissionNode = float(1);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(), glass);
    field.assign(bridge, 'back');
    expect(visibleTo(bridge, 'peek')).toBe(false);
    const standIn = bridge.children[0] as THREE.Mesh | undefined;
    expect(standIn).toBeDefined();
    const m = (standIn as THREE.Mesh).material as THREE.MeshPhysicalNodeMaterial;
    expect(m.useTransmission).toBe(false);
  });

  it('assigning a transmissive object again keeps one stand-in, still only in the peek image', () => {
    const field = new LayerField();
    const glass = new THREE.MeshPhysicalNodeMaterial({ transmission: 1 });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(), glass);
    field.assign(dome, 'back');
    const first = dome.children[0] as THREE.Mesh;
    const backStandInMat = first.material;
    field.assign(dome, 'back');
    field.assign(dome, 'shared');
    expect(dome.children).toHaveLength(1);
    expect(dome.children[0]).toBe(first);
    expect(visibleTo(first, 'main')).toBe(false);
    expect(visibleTo(first, 'peek')).toBe(true);
    // re-cut for the new kind, not patched on top of the old stand-in material
    expect(first.material).not.toBe(backStandInMat);
    expect(contains((first.material as Patched).emissiveNode, (backStandInMat as Patched).emissiveNode)).toBe(
      false,
    );
  });
});

describe('S-40: several settled regions at once (定着の範囲を複数)', () => {
  const sweep = { box: { min: [0, 0, -4], max: [1, 2, 0] } as const, direction: [0, 0, -1] as const };

  it('takes as many as asked (S-34’s `settle: true` is one; none without the option)', () => {
    expect(new LayerField().settleSlotCount).toBe(0);
    expect(new LayerField({ settle: true }).settleSlotCount).toBe(1);
    expect(new LayerField({ settle: 3 }).settleSlotCount).toBe(3);
  });

  it('each part of the world reads only its own slots: the default is the first (S-34’s shader), a range reads those', () => {
    const field = new LayerField({ settle: 3 });
    const shared = new THREE.MeshStandardNodeMaterial();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    const c = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const d = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    field.assign(a, 'back');
    field.assign(b, 'back', { settleSlots: [1, 2] });
    const slots = (m: THREE.Mesh) => (m.material as THREE.Material).userData.settleSlots;
    expect(slots(a)).toEqual([0, 0]);
    expect(slots(b)).toEqual([1, 2]);
    // without the option, none
    const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    new LayerField().assign(plain, 'back');
    expect(slots(plain)).toBeNull();
    // a material already patched for a kind keeps its first range (a drop's glass shared with the prologue)
    field.assign(c, 'back');
    field.assign(d, 'back', { settleSlots: [1, 2] });
    expect(d.material).toBe(c.material);
  });

  it('a region in each slot is set and cleared on its own without throwing; a slot past the last is ignored', () => {
    const field = new LayerField({ settle: 2 });
    expect(() => field.setSettled({ sweep, front: -1, glow: 1 }, 0)).not.toThrow();
    expect(() => field.setSettled({ sweep, front: -2, glow: 0.5 }, 1)).not.toThrow();
    expect(() => field.setSettled(null, 1)).not.toThrow();
    expect(() => field.setSettled({ sweep, front: -2, glow: 0.5 }, 7)).not.toThrow();
    // the materials it patches carry the settled region's light (with one slot or many)
    const m = new THREE.MeshStandardNodeMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
    field.assign(mesh, 'back');
    expect((mesh.material as THREE.MeshStandardNodeMaterial).emissiveNode).not.toBeNull();
    expect((mesh.material as THREE.MeshStandardNodeMaterial).maskNode).not.toBeNull();
  });
});
