import { float, materialThickness } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, type QualityLevel } from '../quality';
import { followBackdropResize, missesBackdropResize, readsBackdrop } from './backdrop';
import { GLASS_KINDS } from './kinds';
import { createGlass } from './materials';
import type { GlassPlacement, GlassRole } from './policy';

/**
 * Whether three would refresh this material's objects on every frame. Asked from three's own observer (the
 * class that decides it at runtime), so a three update that changes the rule fails here, not silently in play.
 */
function threeRefreshesEveryFrame(material: THREE.Material): boolean {
  const builder = { material, object: new THREE.Mesh(), context: {} } as unknown as THREE.NodeBuilder;
  return new THREE.NodeMaterialObserver(builder).hasNode;
}

const handMadeGlass = () =>
  new THREE.MeshPhysicalNodeMaterial({ roughness: 0.02, transmission: 1, ior: 1.5, thickness: 0.5 });

describe('transmission across render size changes (three r186, S-12)', () => {
  it('flags hand-made transmissive glass: three skips refreshing it, so it can keep a destroyed backdrop', () => {
    const glass = handMadeGlass();
    expect(readsBackdrop(glass)).toBe(true);
    expect(missesBackdropResize(glass)).toBe(true);
    expect(threeRefreshesEveryFrame(glass)).toBe(false);
  });

  it('makes three refresh it every frame without changing what it draws', () => {
    const glass = followBackdropResize(handMadeGlass());
    expect(missesBackdropResize(glass)).toBe(false);
    expect(threeRefreshesEveryFrame(glass)).toBe(true);
    // three reads materialThickness when thicknessNode is null: the same value, so the same look.
    expect(glass.thicknessNode).toBe(materialThickness);
    expect(glass.transmissionNode).toBeNull();
    expect(glass.transmission).toBe(1);
    expect(glass.thickness).toBe(0.5);
  });

  it('leaves materials alone that do not read the backdrop or already have a node', () => {
    const solid = followBackdropResize(new THREE.MeshPhysicalNodeMaterial({ roughness: 0.4 }));
    expect(readsBackdrop(solid)).toBe(false);
    expect(solid.thicknessNode).toBeNull();

    const shaped = new THREE.MeshPhysicalNodeMaterial({ transmission: 1 });
    const own = float(0.2);
    shaped.thicknessNode = own;
    expect(missesBackdropResize(shaped)).toBe(false);
    expect(followBackdropResize(shaped).thicknessNode).toBe(own);

    // transmission by a node alone still reads the backdrop, and that node already keeps it refreshed
    const byNode = new THREE.MeshPhysicalNodeMaterial();
    byNode.transmissionNode = float(1);
    expect(readsBackdrop(byNode)).toBe(true);
    expect(missesBackdropResize(byNode)).toBe(false);
  });

  it('every glass from createGlass follows the backdrop, on every preset and placement', () => {
    const placements: GlassPlacement[] = ['near', 'far', 'behind-glass'];
    const roles: GlassRole[] = ['scenery', 'orb', 'drop', 'showcase'];
    for (const level of Object.keys(QUALITY_PRESETS) as QualityLevel[]) {
      for (const kind of GLASS_KINDS) {
        for (const placement of placements) {
          for (const role of roles) {
            const { material } = createGlass(kind, QUALITY_PRESETS[level], { placement, role });
            const where = `${kind} ${placement} ${role} on ${level}`;
            expect(missesBackdropResize(material), where).toBe(false);
            if (readsBackdrop(material)) expect(threeRefreshesEveryFrame(material), where).toBe(true);
            material.dispose();
          }
        }
      }
    }
  });
});
