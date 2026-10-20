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
});
