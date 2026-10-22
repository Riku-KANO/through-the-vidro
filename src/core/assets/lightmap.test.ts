import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { color, float } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  applyLightmaps,
  BakedLightingModel,
  BakedStandardNodeMaterial,
  bakesMaterial,
  lightmapIntensity,
  lightmapOf,
  loadLightmaps,
  toBakedMaterial,
} from './lightmap';

/**
 * The baked light of loaded assets (S-26): the extras the Blender pipeline writes on each baked object (`lightmap`: the name
 * of the texture in the glb, `lightmap_scale`: what the bake was divided by) become the lightMap of its opaque materials,
 * drawn with a lighting model in which the realtime lights give no diffuse light (the bake holds it).
 */
describe('lightmapOf', () => {
  it('reads the name of the lightmap and its scale from the extras', () => {
    expect(lightmapOf({ lightmap: 'A0_lightmap', lightmap_scale: 2.9 })).toEqual({
      name: 'A0_lightmap',
      scale: 2.9,
    });
  });
  it('is null without a name or a positive scale', () => {
    expect(lightmapOf({})).toBeNull();
    expect(lightmapOf({ lightmap: 'A0_lightmap' })).toBeNull();
    expect(lightmapOf({ lightmap: 'A0_lightmap', lightmap_scale: 0 })).toBeNull();
    expect(lightmapOf({ lightmap: '', lightmap_scale: 1 })).toBeNull();
    expect(lightmapOf({ lightmap: 3, lightmap_scale: 1 })).toBeNull();
  });
});

describe('lightmapIntensity', () => {
  it('is π × the scale: the bake is the radiance of white, three adds a light map as irradiance (Lambert ÷ π)', () => {
    expect(lightmapIntensity(1)).toBeCloseTo(Math.PI);
    expect(lightmapIntensity(2.5)).toBeCloseTo(2.5 * Math.PI);
    expect(lightmapIntensity(2, 0.5)).toBeCloseTo(Math.PI);
  });
});

describe('bakesMaterial (the pipeline’s bakeable_material)', () => {
  it('bakes the opaque standard materials', () => {
    expect(bakesMaterial(new THREE.MeshStandardNodeMaterial({ metalness: 1 }))).toBe(true);
    expect(bakesMaterial(new THREE.MeshStandardNodeMaterial())).toBe(true);
  });
  it('leaves out the game’s glass, what the extras keep out (fire, embers, air) and the transparent', () => {
    const glass = new THREE.MeshPhysicalNodeMaterial({ transmission: 1 });
    expect(bakesMaterial(glass)).toBe(false);
    const marked = new THREE.MeshStandardNodeMaterial();
    marked.userData.mark = 'glass_milky';
    expect(bakesMaterial(marked)).toBe(false);
    const fire = new THREE.MeshStandardNodeMaterial();
    fire.userData.bake = false;
    expect(bakesMaterial(fire)).toBe(false);
    expect(bakesMaterial(new THREE.MeshStandardNodeMaterial({ transparent: true }))).toBe(false);
    expect(bakesMaterial(new THREE.MeshBasicNodeMaterial())).toBe(false);
  });
});

describe('toBakedMaterial', () => {
  it('keeps the values, textures and nodes, puts the lightmap on it with its strength', () => {
    const map = new THREE.Texture();
    const lightMap = new THREE.Texture();
    lightMap.channel = 1;
    const src = new THREE.MeshStandardNodeMaterial({ name: 'A0_frost', roughness: 0.5, metalness: 0, map });
    src.colorNode = color(0x445566);
    src.roughnessNode = float(0.3);
    src.userData.bake = true;
    const out = toBakedMaterial(src, lightMap, 2);
    expect(out).toBeInstanceOf(BakedStandardNodeMaterial);
    expect(out).toBeInstanceOf(THREE.MeshStandardNodeMaterial);
    expect(out).not.toBe(src);
    expect(out.name).toBe('A0_frost');
    expect(out.map).toBe(map);
    expect(out.roughness).toBe(0.5);
    expect(out.colorNode).toBe(src.colorNode);
    expect(out.roughnessNode).toBe(src.roughnessNode);
    expect(out.userData.bake).toBe(true);
    expect(out.lightMap).toBe(lightMap);
    expect(out.lightMapIntensity).toBeCloseTo(2 * Math.PI);
    expect(out.uuid).not.toBe(src.uuid);
  });
  it('is a type of its own (three compiles it apart from the same material lit in real time)', () => {
    const out = toBakedMaterial(new THREE.MeshStandardNodeMaterial(), new THREE.Texture(), 1);
    expect(out.type).toBe('BakedStandardNodeMaterial');
    expect(out.type).not.toBe(new THREE.MeshStandardNodeMaterial().type);
    expect(out.setupLightingModel()).toBeInstanceOf(BakedLightingModel);
    expect(new THREE.MeshStandardNodeMaterial().setupLightingModel()).not.toBeInstanceOf(BakedLightingModel);
  });
});

describe('applyLightmaps', () => {
  const build = () => {
    const brass = new THREE.MeshStandardNodeMaterial({ name: 'A0_brass', metalness: 1 });
    const fire = new THREE.MeshStandardNodeMaterial({ name: 'A0_fire' });
    fire.userData.bake = false;
    const glass = new THREE.MeshPhysicalNodeMaterial({ name: 'glass_clear', transmission: 1 });
    glass.userData.mark = 'glass_clear';
    const box = new THREE.BoxGeometry();
    const root = new THREE.Group();
    // a baked piece whose mesh GLTFLoader split into children (one per material)
    const furnace = new THREE.Group();
    furnace.userData = { name: 'A0_frn_furnace01', lightmap: 'A0_lightmap', lightmap_scale: 3 };
    const body = new THREE.Mesh(box, brass);
    const mouth = new THREE.Mesh(box, [fire, brass]);
    furnace.add(body, mouth);
    // a baked piece with glass, and a piece that is all glass (not baked)
    const tub = new THREE.Mesh(box, [glass, brass]);
    tub.userData = { name: 'A0_tub_water01', lightmap: 'A0_lightmap', lightmap_scale: 3 };
    const ware = new THREE.Mesh(box, glass);
    ware.userData = { name: 'A0_ware_clear01' };
    // a piece lit in real time that shares the brass
    const outside = new THREE.Mesh(box, brass);
    outside.userData = { name: 'A0_gate_01' };
    root.add(furnace, tub, ware, outside);
    return { root, brass, fire, glass, body, mouth, tub, ware, outside };
  };

  it('gives the opaque materials of baked pieces the lightmap, one baked material per source, shared', () => {
    const s = build();
    const lightmap = new THREE.Texture();
    const report = applyLightmaps(s.root, new Map([['A0_lightmap', lightmap]]));
    const baked = s.body.material as BakedStandardNodeMaterial;
    expect(baked).toBeInstanceOf(BakedStandardNodeMaterial);
    expect(baked.lightMap).toBe(lightmap);
    expect(baked.lightMapIntensity).toBeCloseTo(3 * Math.PI);
    const [fire, brass] = s.mouth.material as THREE.Material[];
    expect(fire).toBe(s.fire);
    expect(brass).toBe(baked);
    const [glass, tubBrass] = s.tub.material as THREE.Material[];
    expect(glass).toBe(s.glass);
    expect(tubBrass).toBe(baked);
    expect(s.ware.material).toBe(s.glass);
    // what is not baked keeps its material and the realtime light
    expect(s.outside.material).toBe(s.brass);
    expect(report.materials).toEqual([baked]);
    expect(report.meshes).toEqual(expect.arrayContaining([s.body, s.mouth, s.tub]));
    expect(report.meshes).toHaveLength(3);
    // the brass is still used outside: nothing to dispose
    expect(report.replaced).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it('reports the source materials no mesh uses any more, and pieces whose lightmap is not in the file', () => {
    const s = build();
    s.outside.removeFromParent();
    const report = applyLightmaps(s.root, new Map());
    expect(report.missing.length).toBeGreaterThan(0);
    expect(s.body.material).toBe(s.brass);
    const again = applyLightmaps(s.root, new Map([['A0_lightmap', new THREE.Texture()]]));
    expect(again.replaced).toEqual([s.brass]);
  });
});

describe('loadLightmaps', () => {
  it('loads the textures the baked objects name, on the second UV, sRGB', async () => {
    const scene = new THREE.Group();
    const piece = new THREE.Object3D();
    piece.userData = { name: 'A0_bnch_work01', lightmap: 'A0_lightmap', lightmap_scale: 2 };
    scene.add(piece);
    const loaded: number[] = [];
    const gltf = {
      scene,
      parser: {
        json: {
          textures: [
            { sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } },
            { name: 'A0_lightmap', sampler: 1, extensions: { KHR_texture_basisu: { source: 1 } } },
          ],
          images: [{ name: 'A0_atlas' }, { name: 'A0_lightmap' }],
        },
        getDependency: async (_type: string, index: number) => {
          loaded.push(index);
          return new THREE.Texture();
        },
      },
    } as unknown as GLTF;
    const maps = await loadLightmaps(gltf);
    expect(loaded).toEqual([1]);
    const t = maps.get('A0_lightmap');
    expect(t?.channel).toBe(1);
    expect(t?.colorSpace).toBe(THREE.SRGBColorSpace);
  });
});
