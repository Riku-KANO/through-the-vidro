import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { float, luminance, materialLightMap, max, metalness, mix, texture, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';

/**
 * Baked light of loaded assets (S-26; 設計書 アートディレクション > 光と時間帯: 静止した光と影はBlenderで焼き込み、動く物だけを
 * 実時間で照らす; Blenderアセットパイプライン > 焼き込み). The Blender pipeline bakes the diffuse light of the opaque pieces into one
 * lightmap per area (common/bake.py: the radiance of a white diffuse surface, divided by `lightmap_scale` and written as an
 * 8-bit sRGB image on the second UV) and puts it in the glb as a texture no material uses, named by the extras of each
 * baked object:
 *   extras.lightmap        the name of that texture in the glb
 *   extras.lightmap_scale  what the image was divided by
 *
 * The baked pieces draw with BakedStandardNodeMaterial: the lightmap is their diffuse light (material.lightMap on the
 * second UV, strength π × lightmap_scale: three adds a light map as irradiance and its Lambert divides by π), and the
 * realtime lights add only what a diffuse bake cannot hold: their highlights. So the dawn and the fire are not counted
 * twice (BakedLightingModel). Whatever moves or is made in code (the hand's orb, the drop) keeps the realtime lights.
 *
 * What is baked follows the pipeline's rule (blender/scripts/pipeline.py bakeable_material): opaque, not the game's glass
 * (a material the hook made glass is marked in userData.mark), and not `bake: false` in the material's extras (the fire,
 * the embers, the air in the glass). Pure three, no GPU: the unit tests run in Node.
 *
 * Lights baked apart (S-37: layers). A light whose strength changes while the game runs (a fire that breathes) is baked into
 * a lightmap of its own, on the same second UV, and named by the extras too:
 *   extras.lightmap_layers  { <layer>: { lightmap: <texture name>, lightmap_scale: <what it was divided by> } }
 * The baked material adds each layer's light to the lightmap's, times a strength (a float node: a uniform the game changes
 * every frame; 1 = as baked), in the same draw (no pass of its own).
 */

export const LIGHTMAP = 'lightmap';
export const LIGHTMAP_SCALE = 'lightmap_scale';
export const LIGHTMAP_LAYERS = 'lightmap_layers';

export interface LightmapRef {
  /** The name of the lightmap's texture in the glb. */
  name: string;
  /** What the baked radiance was divided by (lightmap_scale). */
  scale: number;
}

/** A light baked apart into a lightmap of its own (S-37). */
export interface LightmapLayerRef extends LightmapRef {
  /** The layer's name in the bake (e.g. `fire`). */
  layer: string;
}

/** The lightmap an object's extras (GLTFLoader's userData) point at, or null. */
export function lightmapOf(extras: Readonly<Record<string, unknown>>): LightmapRef | null {
  const name = extras[LIGHTMAP];
  const scale = Number(extras[LIGHTMAP_SCALE]);
  if (typeof name !== 'string' || name === '' || !Number.isFinite(scale) || scale <= 0) return null;
  return { name, scale };
}

/** The lights an object's extras say were baked apart (`lightmap_layers`), by layer name; none if malformed. */
export function lightmapLayersOf(extras: Readonly<Record<string, unknown>>): LightmapLayerRef[] {
  const layers = extras[LIGHTMAP_LAYERS];
  if (!layers || typeof layers !== 'object' || Array.isArray(layers)) return [];
  const out: LightmapLayerRef[] = [];
  for (const [layer, value] of Object.entries(layers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const ref = lightmapOf(value as Record<string, unknown>);
    if (ref) out.push({ layer, ...ref });
  }
  return out.sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : 0));
}

/** A float the shader reads: a number (fixed), or a node (a uniform the game changes). */
export type LightmapGain = number | THREE.Node;

/** A light baked apart, as a baked material draws it (S-37). */
export interface BakedLightLayer {
  /** The layer's name in the bake (e.g. `fire`). */
  readonly layer: string;
  /** Its lightmap: the same second UV as the material's lightMap, sRGB. */
  readonly map: THREE.Texture;
  /** π × its lightmap_scale (lightmapIntensity), as the lightMap's. */
  readonly intensity: number;
  /** Its strength now: 1 = as baked. A node (a uniform) can change every frame without rebuilding the material. */
  readonly gain: LightmapGain;
}

/** material.lightMapIntensity for a bake divided by `scale`: π × scale (× gain, the game's own adjustment). */
export function lightmapIntensity(scale: number, gain = 1): number {
  return Math.PI * scale * gain;
}

/**
 * The lighting of a baked surface. Its diffuse light is the lightmap alone: the realtime lights give it no diffuse light
 * (direct), nor do the scene's other irradiance (a hemisphere light) and the environment's (the image the glass mirrors):
 * the bake already holds the sun, the sky and the lamps that shine on it, with their shadows and what bounces between the
 * pieces. What it keeps from real time is the specular: the highlights of the realtime lights and the environment's
 * reflection, the latter darkened on non-metals where the bake is darker than the open sky (under a bench, the frosted
 * shelf does not mirror the open sky). Metal has no diffuse light, so a diffuse bake does not change how it looks: its
 * reflection stays the environment's (darkening it by the bake turned thin brass black in patches; process/slices/S-26.md).
 *
 * `baked` is the baked irradiance: the lightmap's (materialLightMap), and with lights baked apart, theirs added
 * (BakedStandardNodeMaterial.bakedIrradiance). It must be the node the material's IrradianceNode adds (the scene's other
 * irradiance is told apart by taking it away).
 */
export class BakedLightingModel extends THREE.PhysicalLightingModel {
  readonly baked: THREE.Node<'vec3'>;

  constructor(baked: THREE.Node<'vec3'> = materialLightMap as unknown as THREE.Node<'vec3'>) {
    super();
    this.baked = baked;
  }

  override direct(
    input: Parameters<THREE.PhysicalLightingModel['direct']>[0],
    builder: THREE.NodeBuilder,
  ): void {
    const { reflectedLight } = input as unknown as { reflectedLight: Record<string, THREE.Node> };
    super.direct(
      { ...input, reflectedLight: { ...reflectedLight, directDiffuse: vec3().toVar() } } as never,
      builder,
    );
  }

  override directRectArea(
    input: Parameters<THREE.PhysicalLightingModel['directRectArea']>[0],
    builder: THREE.NodeBuilder,
  ): void {
    const { reflectedLight } = input as unknown as { reflectedLight: Record<string, THREE.Node> };
    super.directRectArea(
      { ...input, reflectedLight: { ...reflectedLight, directDiffuse: vec3().toVar() } } as never,
      builder,
    );
  }

  override indirect(builder: THREE.NodeBuilder): void {
    const context = builder.context as unknown as {
      irradiance: THREE.Node<'vec3'>;
      iblIrradiance: THREE.Node<'vec3'>;
      radiance: THREE.Node<'vec3'>;
      reflectedLight: Record<string, THREE.Node>;
    };
    // the lightmap's irradiance (texel × lightMapIntensity, and the lights baked apart); the context's irradiance also holds a
    // hemisphere light's
    const baked = this.baked;
    // the open sky as the realtime room sees it: the environment's irradiance and the other irradiance of the scene
    const open = context.iblIrradiance.add(context.irradiance.sub(baked));
    // not on metal: its look is all reflection, and where a thin piece (a tube of a few texels) got too few texels in the
    // bake, the reflection went black in patches (S-26: the dome's ribs, the blowpipes)
    const reach = mix(
      luminance(baked)
        .div(max(luminance(open), 1e-4))
        .clamp(0, 1),
      float(1),
      metalness.clamp(0, 1),
    );
    const at = (c: object) => ({ context: { ...context, ...c } }) as unknown as THREE.NodeBuilder;
    // (the environment's irradiance zeroed too: a later three that read it here would add it a second time)
    this.indirectDiffuse(at({ irradiance: baked, iblIrradiance: vec3(0) }));
    // the environment's specular only (its diffuse share goes into a sink)
    this.indirectSpecular(
      at({
        radiance: context.radiance.mul(reach),
        iblIrradiance: context.iblIrradiance.mul(reach),
        reflectedLight: { ...context.reflectedLight, indirectDiffuse: vec3().toVar() },
      }),
    );
    this.ambientOcclusion(builder);
  }
}

/**
 * A MeshStandardNodeMaterial lit by its lightmap (BakedLightingModel). Its own type, so three compiles it apart.
 * `lightMapLayers` (S-37): lights baked apart, added to the lightmap's light in the same draw, each × its gain (set them
 * before the material is first drawn: changing the list later needs `needsUpdate`; a gain node's value can change any time).
 */
export class BakedStandardNodeMaterial extends THREE.MeshStandardNodeMaterial {
  static override get type(): string {
    return 'BakedStandardNodeMaterial';
  }

  readonly isBakedStandardNodeMaterial = true;

  lightMapLayers: BakedLightLayer[] = [];

  /** The baked irradiance node of the current build: setupLightMap makes it, setupLightingModel (later) reads it. */
  #baked: THREE.Node<'vec3'> | null = null;

  /**
   * The baked irradiance: the lightmap's (texel × lightMapIntensity) and each layer's (its texel × its intensity × its gain),
   * sampled on the layer map's own channel (the second UV).
   */
  bakedIrradiance(): THREE.Node<'vec3'> {
    let sum = materialLightMap as unknown as THREE.Node<'vec3'>;
    for (const l of this.lightMapLayers) {
      const light = texture(l.map).rgb.mul(l.intensity);
      sum = sum.add(
        typeof l.gain === 'number' ? light.mul(l.gain) : light.mul(l.gain as THREE.Node<'float'>),
      );
    }
    return sum;
  }

  override setupLightMap(builder: THREE.NodeBuilder): THREE.Node {
    if (!this.lightMap || this.lightMapLayers.length === 0) {
      this.#baked = null;
      return super.setupLightMap(builder);
    }
    this.#baked = this.bakedIrradiance();
    return new THREE.IrradianceNode(this.#baked);
  }

  override setupLightingModel(): THREE.PhysicalLightingModel {
    return new BakedLightingModel(this.#baked ?? undefined);
  }

  /** A copy keeps the lights baked apart (LayerField clones a material it cuts for a second kind of layer). */
  override copy(source: THREE.MeshStandardNodeMaterial): this {
    super.copy(source);
    const layers = (source as Partial<BakedStandardNodeMaterial>).lightMapLayers;
    this.lightMapLayers = layers ? [...layers] : [];
    return this;
  }
}

/** Fields that belong to the material object itself, not to its look (as in materials.ts). */
const OWN_FIELDS = new Set(['uuid', 'id', 'type', 'version', '_listeners']);

/**
 * The baked material for `source`: the same values (colours and vectors copied, userData a shallow copy), nodes and
 * textures (shared), with `lightMap` on the second UV and its strength. Only a MeshStandardNodeMaterial (what the
 * pipeline's opaque materials become) can be baked. An aoMap would darken the baked light a second time (the bake holds the
 * occlusion): the pipeline's materials have none. `layers` (S-37): the lights baked apart, added to it.
 */
export function toBakedMaterial(
  source: THREE.MeshStandardNodeMaterial,
  lightMap: THREE.Texture,
  scale: number,
  layers: readonly BakedLightLayer[] = [],
): BakedStandardNodeMaterial {
  const out = new BakedStandardNodeMaterial();
  const src = source as unknown as Record<string, unknown>;
  const dst = out as unknown as Record<string, unknown>;
  for (const key in src) {
    if (OWN_FIELDS.has(key) || key.startsWith('is')) continue;
    const v = src[key] as {
      isColor?: boolean;
      isVector2?: boolean;
      isVector3?: boolean;
      clone?: () => unknown;
    } | null;
    dst[key] = v && (v.isColor || v.isVector2 || v.isVector3) && v.clone ? v.clone() : v;
  }
  out.userData = { ...source.userData };
  out.name = source.name;
  out.lightMap = lightMap;
  out.lightMapIntensity = lightmapIntensity(scale);
  out.lightMapLayers = [...layers];
  return out;
}

/**
 * Whether the pipeline baked a material: lit (standard or physical), opaque, not the game's glass (the hook marks it in
 * userData.mark), not see-through, and not `bake: false` in its extras — the pipeline writes that on every material of a
 * baked object it left out (blender/scripts/pipeline.py bakeable_material: the fire, the embers, the air in glass, the glass).
 */
export function bakesMaterial(m: THREE.Material): boolean {
  if (!(m instanceof THREE.MeshStandardNodeMaterial)) return false;
  if (typeof m.userData.mark === 'string' || m.userData.bake === false) return false;
  if (m instanceof THREE.MeshPhysicalNodeMaterial && m.transmission > 0) return false;
  return !m.transparent;
}

/** Whether a baked material can be drawn with its lightmap here (BakedStandardNodeMaterial is a standard material). */
const canBake = (m: THREE.Material): m is THREE.MeshStandardNodeMaterial =>
  m instanceof THREE.MeshStandardNodeMaterial && !(m instanceof THREE.MeshPhysicalNodeMaterial);

/**
 * The lightmaps of a loaded glb: the textures its baked objects name, by name (a texture of the glb no material uses).
 * Each is on the second UV, sRGB (the KTX2 says so itself; a PNG is marked here before it is first uploaded).
 */
export async function loadLightmaps(gltf: GLTF): Promise<Map<string, THREE.Texture>> {
  const names = new Set<string>();
  gltf.scene.traverse((o) => {
    const ref = lightmapOf(o.userData);
    if (ref) names.add(ref.name);
    for (const layer of lightmapLayersOf(o.userData)) names.add(layer.name);
  });
  const json = gltf.parser.json as {
    textures?: { name?: string; source?: number; extensions?: Record<string, { source?: number }> }[];
    images?: { name?: string }[];
  };
  const out = new Map<string, THREE.Texture>();
  const textures = json.textures ?? [];
  for (const name of names) {
    const index = textures.findIndex((t) => {
      const source = t.extensions?.KHR_texture_basisu?.source ?? t.source;
      return t.name === name || (source !== undefined && json.images?.[source]?.name === name);
    });
    if (index < 0) continue;
    const texture = (await gltf.parser.getDependency('texture', index)) as THREE.Texture;
    texture.channel = 1;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.name = name;
    out.set(name, texture);
  }
  return out;
}

export interface LightmapReport {
  /** Baked meshes (each drawn piece with a lightmap). */
  meshes: THREE.Mesh[];
  /** The baked materials made (one per source material, lightmap and scale). */
  materials: BakedStandardNodeMaterial[];
  /** The source materials no mesh uses any more (dispose them; their textures live on in the baked ones). */
  replaced: THREE.Material[];
  /** Objects whose lightmap is not in the file. */
  missing: string[];
  /**
   * Baked materials this cannot draw with their lightmap (a physical material: clearcoat, sheen, specular…), by object and
   * material. They stay lit in real time: say so (the game lists them as problems).
   */
  unsupported: string[];
}

export interface ApplyLightmapsOptions {
  /**
   * The strength of each light baked apart (S-37), by layer name: a number, or a node the game changes (a uniform: every
   * baked material with that layer shares it). Default 1 (as baked).
   */
  gain?: (layer: string) => LightmapGain;
}

/**
 * Gives every mesh of an object with a lightmap (itself or its nearest ancestor with the extras: GLTFLoader splits a mesh
 * with several materials into children) the baked material for each of its bakeable materials. Others stay as they are.
 * The lights the object's extras say were baked apart (lightmap_layers) are added to it (a layer whose image is not in the
 * file is left out and reported as missing: `<object> (<layer>)`).
 */
export function applyLightmaps(
  root: THREE.Object3D,
  lightmaps: ReadonlyMap<string, THREE.Texture>,
  options: ApplyLightmapsOptions = {},
): LightmapReport {
  const gains = new Map<string, LightmapGain>();
  const gainOf = (layer: string): LightmapGain => {
    let g = gains.get(layer);
    if (g === undefined) {
      g = options.gain?.(layer) ?? 1;
      gains.set(layer, g);
    }
    return g;
  };
  const made = new Map<string, BakedStandardNodeMaterial>();
  const used = new Set<THREE.Material>();
  const sources = new Set<THREE.Material>();
  const meshes: THREE.Mesh[] = [];
  const missing = new Set<string>();
  const unsupported = new Set<string>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let ref: LightmapRef | null = null;
    let piece: THREE.Object3D | null = null;
    // up to the nearest object with a glTF name: the parts GLTFLoader split a mesh into have none, and a named object inside
    // another (a level of detail under its parent…) has its own bake, or none
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
      ref = lightmapOf(p.userData);
      if (ref || typeof p.userData.name === 'string') {
        piece = p;
        break;
      }
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!ref) {
      for (const m of mats) used.add(m);
      return;
    }
    const name = String(piece?.userData.name ?? piece?.name ?? mesh.name);
    const texture = lightmaps.get(ref.name);
    if (!texture) {
      missing.add(name);
      for (const m of mats) used.add(m);
      return;
    }
    const lightmapRef = ref;
    const layers: BakedLightLayer[] = [];
    for (const l of lightmapLayersOf(piece?.userData ?? {})) {
      const map = lightmaps.get(l.name);
      if (!map) {
        missing.add(`${name} (${l.layer})`);
        continue;
      }
      layers.push({ layer: l.layer, map, intensity: lightmapIntensity(l.scale), gain: gainOf(l.layer) });
    }
    const layerKey = layers.map((l) => `${l.layer}:${l.map.uuid}:${l.intensity}`).join(',');
    const one = (m: THREE.Material): THREE.Material => {
      if (!bakesMaterial(m)) {
        used.add(m);
        return m;
      }
      if (!canBake(m)) {
        unsupported.add(`${name}/${m.name}`);
        used.add(m);
        return m;
      }
      sources.add(m);
      const key = `${m.uuid}|${texture.uuid}|${lightmapRef.scale}|${layerKey}`;
      let baked = made.get(key);
      if (!baked) {
        baked = toBakedMaterial(m, texture, lightmapRef.scale, layers);
        made.set(key, baked);
      }
      return baked;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
    meshes.push(mesh);
  });
  return {
    meshes,
    materials: [...made.values()],
    replaced: [...sources].filter((m) => !used.has(m)),
    missing: [...missing],
    unsupported: [...unsupported],
  };
}
