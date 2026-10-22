import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { proceduralMaterial } from './procedural';

/**
 * S-26: a material whose extras say `procedural` is drawn in code. The workshop's floor moved into the glb to be baked and
 * keeps the frosted tiles of src/core/glass (its brass joints fade where a pixel covers more than a joint).
 */
describe('proceduralMaterial', () => {
  it('makes the frosted floor from the extras, keeping its name and extras', () => {
    const src = new THREE.MeshStandardMaterial({ name: 'A0_floor' });
    src.userData = { procedural: 'frosted_floor', tile_size: 0.9, frost_color: '#a7b1bc' };
    const made = proceduralMaterial(src) as THREE.MeshStandardNodeMaterial;
    expect(made).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(made.name).toBe('A0_floor');
    expect(made.userData.procedural).toBe('frosted_floor');
    // the tiles and joints are nodes (colour, metalness of the brass joints, roughness)
    expect(made.colorNode).not.toBeNull();
    expect(made.metalnessNode).not.toBeNull();
    expect(made.transparent).toBe(false);
  });

  it('leaves every other material to the default conversion', () => {
    expect(proceduralMaterial(new THREE.MeshStandardMaterial({ name: 'A0_frost' }))).toBeNull();
    const unknown = new THREE.MeshStandardMaterial();
    unknown.userData = { procedural: 'marble' };
    expect(proceduralMaterial(unknown)).toBeNull();
  });
});
