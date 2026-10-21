import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { missesBackdropResize, readsBackdrop } from '../glass/backdrop';
import { convertMaterials, disposeObject, toNodeMaterial } from './materials';

/**
 * GLTFLoader makes classic materials (MeshStandardMaterial, MeshPhysicalMaterial, MeshBasicMaterial). The layers patch
 * node materials only (src/layers/field.ts), and a transmissive material needs a node before it is first drawn
 * (AGENTS.md, S-12). So everything loaded becomes a node material with the same values.
 */
describe('toNodeMaterial', () => {
  it('turns a standard material into a standard node material with the same values and textures', () => {
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const src = new THREE.MeshStandardMaterial({
      name: 'A0_floor',
      color: 0x8a7f72,
      roughness: 0.62,
      metalness: 0.1,
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.8, -0.8),
      side: THREE.DoubleSide,
    });
    src.userData.gltfExtensions = { KHR_materials_specular: {} };
    const out = toNodeMaterial(src) as THREE.MeshStandardNodeMaterial;
    expect(out).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(out).not.toBe(src);
    expect(out.name).toBe('A0_floor');
    expect(out.color.getHex()).toBe(0x8a7f72);
    expect(out.roughness).toBe(0.62);
    expect(out.metalness).toBe(0.1);
    expect(out.map).toBe(map);
    expect(out.normalMap).toBe(normalMap);
    expect(out.normalScale.toArray()).toEqual([0.8, -0.8]);
    expect(out.side).toBe(THREE.DoubleSide);
    expect(out.userData.gltfExtensions).toEqual({ KHR_materials_specular: {} });
    expect(out.uuid).not.toBe(src.uuid);
  });

  it('keeps transmission, ior, volume and specular, and makes the glass follow a render size change', () => {
    const src = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      ior: 1.45,
      thickness: 0.2,
      attenuationColor: new THREE.Color(0.6, 0.86, 0.72),
      attenuationDistance: 0.3,
      specularIntensity: 0.7,
      specularColor: new THREE.Color(1, 0.9, 0.8),
      roughness: 0,
    });
    const out = toNodeMaterial(src) as THREE.MeshPhysicalNodeMaterial;
    expect(out).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
    expect(out.transmission).toBe(1);
    expect(out.ior).toBe(1.45);
    expect(out.thickness).toBe(0.2);
    expect(out.attenuationColor.toArray()).toEqual([0.6, 0.86, 0.72]);
    expect(out.attenuationDistance).toBe(0.3);
    expect(out.specularIntensity).toBe(0.7);
    expect(out.specularColor.toArray()).toEqual([1, 0.9, 0.8]);
    expect(readsBackdrop(out)).toBe(true);
    expect(missesBackdropResize(out)).toBe(false);
  });

  it('turns an unlit material into a basic node material', () => {
    const out = toNodeMaterial(new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    expect(out).toBeInstanceOf(THREE.MeshBasicNodeMaterial);
    expect((out as THREE.MeshBasicNodeMaterial).color.getHex()).toBe(0xff0000);
  });

  it('leaves a node material as it is', () => {
    const m = new THREE.MeshStandardNodeMaterial();
    expect(toNodeMaterial(m)).toBe(m);
  });

  it('refuses a material it cannot convert', () => {
    expect(() => toNodeMaterial(new THREE.ShaderMaterial())).toThrow(/ShaderMaterial/);
  });
});

describe('convertMaterials', () => {
  const box = new THREE.BoxGeometry();

  it('converts every mesh material once, so meshes that shared a material still share one', () => {
    const shared = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    const a = new THREE.Mesh(box, shared);
    const b = new THREE.Mesh(box, shared);
    const c = new THREE.Mesh(box, [shared, new THREE.MeshPhysicalMaterial({ transmission: 1 })]);
    root.add(a, b, c);
    convertMaterials(root);
    expect(a.material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(b.material).toBe(a.material);
    const [c0, c1] = c.material as THREE.Material[];
    expect(c0).toBe(a.material);
    expect(c1).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
    expect(missesBackdropResize(c1 as THREE.Material)).toBe(false);
  });

  it('lets a hook choose the material of a mesh, and converts the rest', () => {
    const glass = new THREE.MeshPhysicalMaterial({ name: 'glass_clear', transmission: 1 });
    const brass = new THREE.MeshStandardMaterial({ name: 'brass' });
    const root = new THREE.Group();
    const dome = new THREE.Mesh(box, glass);
    const frame = new THREE.Mesh(box, brass);
    root.add(dome, frame);
    const mine = new THREE.MeshPhysicalNodeMaterial();
    const seen: string[] = [];
    convertMaterials(root, (material, mesh) => {
      seen.push(`${mesh.uuid === dome.uuid ? 'dome' : 'frame'}:${material.name}`);
      return material.name === 'glass_clear' ? mine : null;
    });
    expect(seen.sort()).toEqual(['dome:glass_clear', 'frame:brass']);
    expect(dome.material).toBe(mine);
    expect(frame.material).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
  });

  it('makes a transmissive material from the hook follow a render size change too', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(box, new THREE.MeshStandardMaterial());
    root.add(mesh);
    const bare = new THREE.MeshPhysicalNodeMaterial({ transmission: 1 });
    expect(missesBackdropResize(bare)).toBe(true);
    convertMaterials(root, () => bare);
    expect(missesBackdropResize(mesh.material as THREE.Material)).toBe(false);
  });
});

describe('disposeObject', () => {
  it('releases the geometries, materials and textures under a root, each once', () => {
    const geometry = new THREE.BoxGeometry();
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const material = new THREE.MeshStandardNodeMaterial();
    material.map = map;
    material.normalMap = normalMap;
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, [material]));
    const disposed: string[] = [];
    for (const [name, d] of [
      ['geometry', geometry],
      ['material', material],
      ['map', map],
      ['normalMap', normalMap],
    ] as const) {
      d.addEventListener('dispose', () => disposed.push(name));
    }
    disposeObject(root);
    expect(disposed.sort()).toEqual(['geometry', 'map', 'material', 'normalMap']);
  });

  it('also releases textures that live only inside nodes, once', () => {
    const map = new THREE.Texture();
    const inNode = new THREE.Texture();
    const material = new THREE.MeshStandardNodeMaterial();
    material.map = map;
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const disposed: string[] = [];
    map.addEventListener('dispose', () => disposed.push('map'));
    inNode.addEventListener('dispose', () => disposed.push('inNode'));
    disposeObject(root, [inNode, map]);
    expect(disposed.sort()).toEqual(['inNode', 'map']);
  });
});
