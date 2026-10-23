import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { color, float, materialLightMap, uniform, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import {
  applyLightmaps,
  BakedLightingModel,
  BakedStandardNodeMaterial,
  bakesMaterial,
  lightmapIntensity,
  lightmapLayersOf,
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

describe('lightmapLayersOf (S-37: lights baked apart)', () => {
  it('reads each layer’s lightmap and scale, in the order of their names', () => {
    expect(
      lightmapLayersOf({
        lightmap: 'A0_lightmap',
        lightmap_scale: 1.1,
        lightmap_layers: {
          fire: { lightmap: 'A0_lightmap_fire', lightmap_scale: 5.1 },
          lamp: { lightmap: 'A0_lightmap_lamp', lightmap_scale: 0.4 },
        },
      }),
    ).toEqual([
      { layer: 'fire', name: 'A0_lightmap_fire', scale: 5.1 },
      { layer: 'lamp', name: 'A0_lightmap_lamp', scale: 0.4 },
    ]);
  });
  it('is empty without layers, and leaves out a layer without a name or a positive scale', () => {
    expect(lightmapLayersOf({ lightmap: 'A0_lightmap', lightmap_scale: 1 })).toEqual([]);
    expect(lightmapLayersOf({ lightmap_layers: 'fire' })).toEqual([]);
    expect(lightmapLayersOf({ lightmap_layers: [{ lightmap: 'x', lightmap_scale: 1 }] })).toEqual([]);
    expect(
      lightmapLayersOf({
        lightmap_layers: { fire: { lightmap: 'A0_lightmap_fire', lightmap_scale: 0 }, ash: null },
      }),
    ).toEqual([]);
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
  it('an opaque physical material is baked by the pipeline (the game reports it cannot draw it so: applyLightmaps)', () => {
    expect(bakesMaterial(new THREE.MeshPhysicalNodeMaterial({ clearcoat: 1 }))).toBe(true);
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
    // values copied, not shared with the source (changing one does not change the other)
    expect(out.color).not.toBe(src.color);
    expect(out.color.equals(src.color)).toBe(true);
    expect(out.userData).not.toBe(src.userData);
    expect(out.colorNode).toBe(src.colorNode);
    expect(out.roughnessNode).toBe(src.roughnessNode);
    expect(out.userData.bake).toBe(true);
    expect(out.lightMap).toBe(lightMap);
    expect(out.lightMapIntensity).toBeCloseTo(2 * Math.PI);
    expect(out.uuid).not.toBe(src.uuid);
  });
  it('is a type of its own (three compiles it apart from the same material lit in real time)', () => {
    const out = toBakedMaterial(new THREE.MeshStandardNodeMaterial(), new THREE.Texture(), 1);
    expect(out.type).not.toBe(new THREE.MeshStandardNodeMaterial().type);
    expect(out.setupLightingModel()).toBeInstanceOf(BakedLightingModel);
    expect(new THREE.MeshStandardNodeMaterial().setupLightingModel()).not.toBeInstanceOf(BakedLightingModel);
  });
  it('S-37: keeps the lights baked apart, also in a clone (LayerField clones a material for a second kind of layer)', () => {
    const fire = new THREE.Texture();
    const gain = uniform(1);
    const layers = [{ layer: 'fire', map: fire, intensity: 3, gain }];
    const out = toBakedMaterial(new THREE.MeshStandardNodeMaterial(), new THREE.Texture(), 1, layers);
    expect(out.lightMapLayers).toEqual(layers);
    expect(out.lightMapLayers).not.toBe(layers);
    const twin = out.clone();
    expect(twin).toBeInstanceOf(BakedStandardNodeMaterial);
    expect(twin.lightMapLayers).toEqual(layers);
    expect(twin.lightMapLayers[0]?.gain).toBe(gain);
  });
});

/**
 * The lighting of a baked surface, on three r186's own PhysicalLightingModel: what each part of the light is added to.
 * A watch for three upgrades too (src/core/CHANGELOG.md 0.11.0): BakedLightingModel relies on three's lighting model
 * reading `builder.context` and adding the environment's diffuse share in `indirectSpecular`. The nodes are built, not run:
 * the test follows which inputs each addition is made of.
 */
describe('BakedLightingModel (the realtime lights are not counted twice)', () => {
  /** Whether a node is made of `target` (follows the node's fields; nodes form a graph without cycles of fields). */
  const dependsOn = (node: unknown, target: unknown, seen = new Set<unknown>()): boolean => {
    if (node === target) return true;
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        if (v.some((x) => dependsOn(x, target, seen))) return true;
      } else if (v && typeof v === 'object' && (v as { isNode?: boolean }).isNode) {
        if (dependsOn(v, target, seen)) return true;
      }
    }
    return false;
  };
  /** A stand-in for the lighting context's sums: records what is added to each. */
  const sums = () => {
    const added: Record<string, unknown[]> = {};
    const sum = (name: string) => ({
      addAssign: (n: unknown) => {
        added[name] = [...(added[name] ?? []), n];
      },
      mulAssign: () => {},
    });
    return {
      added,
      reflectedLight: {
        directDiffuse: sum('directDiffuse'),
        directSpecular: sum('directSpecular'),
        indirectDiffuse: sum('indirectDiffuse'),
        indirectSpecular: sum('indirectSpecular'),
      },
    };
  };
  // three warns that the sink's assignment is outside a shader function: the test builds nodes outside one
  const quiet = <T>(f: () => T): T => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return f();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  };

  it('a realtime light adds its highlight, not its diffuse light', () => {
    const s = sums();
    const model = new BakedLightingModel();
    quiet(() =>
      model.direct(
        {
          lightDirection: vec3(0, 1, 0),
          lightColor: vec3(1, 1, 1),
          reflectedLight: s.reflectedLight,
        } as never,
        {} as never,
      ),
    );
    expect(Object.keys(s.added)).toEqual(['directSpecular']);
  });

  it('the diffuse light is the lightmap alone; the environment adds its reflection, its diffuse share goes nowhere', () => {
    const s = sums();
    const irradiance = uniform(new THREE.Vector3(1, 1, 1));
    const iblIrradiance = uniform(new THREE.Vector3(2, 2, 2));
    const radiance = uniform(new THREE.Vector3(3, 3, 3));
    const model = new BakedLightingModel() as BakedLightingModel & { dfg: unknown };
    model.dfg = vec2(0.9, 0.05); // what start() sets up from the view (DFG lookup)
    quiet(() =>
      model.indirect({
        context: {
          irradiance,
          iblIrradiance,
          radiance,
          ambientOcclusion: float(1),
          reflectedLight: s.reflectedLight,
        },
      } as never),
    );
    const diffuse = s.added.indirectDiffuse ?? [];
    expect(diffuse).toHaveLength(1);
    expect(dependsOn(diffuse[0], materialLightMap)).toBe(true);
    // neither the scene's other irradiance (a hemisphere light) nor the environment's
    expect(dependsOn(diffuse[0], irradiance)).toBe(false);
    expect(dependsOn(diffuse[0], iblIrradiance)).toBe(false);
    const specular = s.added.indirectSpecular ?? [];
    expect(specular).toHaveLength(1);
    expect(dependsOn(specular[0], radiance)).toBe(true);
  });

  /** Whether a node is made of a texture node sampling `map`. */
  const samples = (node: unknown, map: THREE.Texture, seen = new Set<unknown>()): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (
      (node as { isTextureNode?: boolean; value?: unknown }).isTextureNode &&
      (node as { value?: unknown }).value === map
    )
      return true;
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        if (v.some((x) => samples(x, map, seen))) return true;
      } else if (v && typeof v === 'object' && (v as { isNode?: boolean }).isNode) {
        if (samples(v, map, seen)) return true;
      }
    }
    return false;
  };

  it('S-37: a light baked apart is added to the lightmap’s, × its gain, and is the baked light the model reads', () => {
    const lightMap = new THREE.Texture();
    lightMap.channel = 1;
    const fireMap = new THREE.Texture();
    fireMap.channel = 1;
    const gain = uniform(1);
    const m = toBakedMaterial(new THREE.MeshStandardNodeMaterial(), lightMap, 1, [
      { layer: 'fire', map: fireMap, intensity: lightmapIntensity(5), gain },
    ]);
    const irradiance = quiet(() => m.setupLightMap({ material: m } as never)) as unknown as {
      isLightingNode?: boolean;
      node: unknown;
    };
    expect(irradiance.isLightingNode).toBe(true);
    expect(dependsOn(irradiance.node, materialLightMap)).toBe(true);
    expect(samples(irradiance.node, fireMap)).toBe(true);
    expect(dependsOn(irradiance.node, gain)).toBe(true);
    // the lighting model takes the same node as the baked light (the scene's other irradiance is told apart by it)
    const model = m.setupLightingModel() as BakedLightingModel;
    expect(model).toBeInstanceOf(BakedLightingModel);
    expect(model.baked).toBe(irradiance.node);
    // and its diffuse light is made of the fire's lightmap and its gain
    const s = sums();
    (model as BakedLightingModel & { dfg: unknown }).dfg = vec2(0.9, 0.05);
    quiet(() =>
      model.indirect({
        context: {
          irradiance: uniform(new THREE.Vector3(1, 1, 1)),
          iblIrradiance: uniform(new THREE.Vector3(2, 2, 2)),
          radiance: uniform(new THREE.Vector3(3, 3, 3)),
          ambientOcclusion: float(1),
          reflectedLight: s.reflectedLight,
        },
      } as never),
    );
    const diffuse = s.added.indirectDiffuse ?? [];
    expect(diffuse).toHaveLength(1);
    expect(samples(diffuse[0], fireMap)).toBe(true);
    expect(dependsOn(diffuse[0], gain)).toBe(true);
  });

  it('without lights baked apart, the lightmap alone (as S-26)', () => {
    const m = toBakedMaterial(new THREE.MeshStandardNodeMaterial(), new THREE.Texture(), 1);
    const irradiance = m.setupLightMap({ material: m } as never) as unknown as { node: unknown };
    expect(irradiance.node).toBe(materialLightMap);
    expect((m.setupLightingModel() as BakedLightingModel).baked).toBe(materialLightMap);
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
    expect(report.unsupported).toEqual([]);
  });

  it('a named object inside a baked one has its own bake, or none: it does not take its parent’s', () => {
    const s = build();
    const nested = new THREE.Mesh(new THREE.BoxGeometry(), s.brass);
    nested.userData = { name: 'A0_frn_furnace01_LOD1' };
    s.body.parent?.add(nested);
    applyLightmaps(s.root, new Map([['A0_lightmap', new THREE.Texture()]]));
    expect(nested.material).toBe(s.brass);
    expect(s.body.material).toBeInstanceOf(BakedStandardNodeMaterial);
  });

  it('leaves a baked physical material lit in real time and says so', () => {
    const s = build();
    const lacquer = new THREE.MeshPhysicalNodeMaterial({ name: 'A0_lacquer', clearcoat: 1 });
    s.body.material = lacquer;
    const report = applyLightmaps(s.root, new Map([['A0_lightmap', new THREE.Texture()]]));
    expect(s.body.material).toBe(lacquer);
    expect(report.unsupported).toEqual(['A0_frn_furnace01/A0_lacquer']);
  });

  it('S-37: adds the lights baked apart, each with its strength (one per layer, shared), and reports a layer not in the file', () => {
    const s = build();
    const furnace = s.body.parent as THREE.Object3D;
    furnace.userData.lightmap_layers = { fire: { lightmap: 'A0_lightmap_fire', lightmap_scale: 5 } };
    s.tub.userData.lightmap_layers = { fire: { lightmap: 'A0_lightmap_fire', lightmap_scale: 5 } };
    const lightmap = new THREE.Texture();
    const fire = new THREE.Texture();
    const breath = uniform(1);
    const asked: string[] = [];
    const report = applyLightmaps(
      s.root,
      new Map([
        ['A0_lightmap', lightmap],
        ['A0_lightmap_fire', fire],
      ]),
      {
        gain: (layer) => {
          asked.push(layer);
          return breath;
        },
      },
    );
    const baked = s.body.material as BakedStandardNodeMaterial;
    expect(baked.lightMap).toBe(lightmap);
    expect(baked.lightMapLayers).toHaveLength(1);
    const [layer] = baked.lightMapLayers;
    expect(layer?.layer).toBe('fire');
    expect(layer?.map).toBe(fire);
    expect(layer?.intensity).toBeCloseTo(5 * Math.PI);
    expect(layer?.gain).toBe(breath);
    // the same source, lightmap and layers: one baked material; the strength asked once for the layer
    expect((s.tub.material as THREE.Material[])[1]).toBe(baked);
    expect(asked).toEqual(['fire']);
    expect(report.missing).toEqual([]);

    // the layer's image not in the file: drawn with the lightmap alone, and said
    const t = build();
    t.tub.userData.lightmap_layers = { fire: { lightmap: 'A0_lightmap_fire', lightmap_scale: 5 } };
    const r = applyLightmaps(t.root, new Map([['A0_lightmap', lightmap]]));
    expect(((t.tub.material as THREE.Material[])[1] as BakedStandardNodeMaterial).lightMapLayers).toEqual([]);
    expect(r.missing).toEqual(['A0_tub_water01 (fire)']);
  });

  it('S-37: a layer’s strength is 1 (as baked) unless the game gives one', () => {
    const s = build();
    s.tub.userData.lightmap_layers = { fire: { lightmap: 'A0_lightmap_fire', lightmap_scale: 2 } };
    applyLightmaps(
      s.root,
      new Map([
        ['A0_lightmap', new THREE.Texture()],
        ['A0_lightmap_fire', new THREE.Texture()],
      ]),
    );
    const baked = (s.tub.material as THREE.Material[])[1] as BakedStandardNodeMaterial;
    expect(baked.lightMapLayers[0]?.gain).toBe(1);
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

  it('S-37: and those of the lights baked apart', async () => {
    const scene = new THREE.Group();
    const piece = new THREE.Object3D();
    piece.userData = {
      name: 'A0_frn_furnace01',
      lightmap: 'A0_lightmap',
      lightmap_scale: 1,
      lightmap_layers: { fire: { lightmap: 'A0_lightmap_fire', lightmap_scale: 5 } },
    };
    scene.add(piece);
    const gltf = {
      scene,
      parser: {
        json: {
          textures: [{ name: 'A0_lightmap' }, { name: 'A0_lightmap_fire' }],
          images: [],
        },
        getDependency: async () => new THREE.Texture(),
      },
    } as unknown as GLTF;
    const maps = await loadLightmaps(gltf);
    expect([...maps.keys()].sort()).toEqual(['A0_lightmap', 'A0_lightmap_fire']);
    expect(maps.get('A0_lightmap_fire')?.channel).toBe(1);
    expect(maps.get('A0_lightmap_fire')?.colorSpace).toBe(THREE.SRGBColorSpace);
  });
});
