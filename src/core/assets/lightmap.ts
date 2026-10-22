import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { float, luminance, materialLightMap, max, metalness, mix, vec3 } from 'three/tsl';
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
 */

export const LIGHTMAP = 'lightmap';
export const LIGHTMAP_SCALE = 'lightmap_scale';

export interface LightmapRef {
  /** The name of the lightmap's texture in the glb. */
  name: string;
  /** What the baked radiance was divided by (lightmap_scale). */
  scale: number;
}

/** The lightmap an object's extras (GLTFLoader's userData) point at, or null. */
export function lightmapOf(extras: Readonly<Record<string, unknown>>): LightmapRef | null {
  const name = extras[LIGHTMAP];
  const scale = Number(extras[LIGHTMAP_SCALE]);
  if (typeof name !== 'string' || name === '' || !Number.isFinite(scale) || scale <= 0) return null;
  return { name, scale };
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
 */
export class BakedLightingModel extends THREE.PhysicalLightingModel {
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
    // the lightmap's irradiance (texel × lightMapIntensity); the context's irradiance also holds a hemisphere light's
    const baked = materialLightMap as unknown as THREE.Node<'vec3'>;
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
    this.indirectDiffuse(at({ irradiance: baked }));
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

/** A MeshStandardNodeMaterial lit by its lightmap (BakedLightingModel). Its own type, so three compiles it apart. */
export class BakedStandardNodeMaterial extends THREE.MeshStandardNodeMaterial {
  static override get type(): string {
    return 'BakedStandardNodeMaterial';
  }

  readonly isBakedStandardNodeMaterial = true;

  override setupLightingModel(): THREE.PhysicalLightingModel {
    return new BakedLightingModel();
  }
}

/** Fields that belong to the material object itself, not to its look (as in materials.ts). */
const OWN_FIELDS = new Set(['uuid', 'id', 'type', 'version', '_listeners']);

/**
 * The baked material for `source`: the same values, nodes and textures (shared, not copied), with `lightMap` on the second
 * UV and its strength. Only a MeshStandardNodeMaterial (what the pipeline's opaque materials become) can be baked.
 */
export function toBakedMaterial(
  source: THREE.MeshStandardNodeMaterial,
  lightMap: THREE.Texture,
  scale: number,
): BakedStandardNodeMaterial {
  const out = new BakedStandardNodeMaterial();
  const src = source as unknown as Record<string, unknown>;
  const dst = out as unknown as Record<string, unknown>;
  for (const key in src) {
    if (OWN_FIELDS.has(key) || key.startsWith('is')) continue;
    dst[key] = src[key];
  }
  out.name = source.name;
  out.lightMap = lightMap;
  out.lightMapIntensity = lightmapIntensity(scale);
  return out;
}

/** Whether the pipeline bakes a material (blender/scripts/pipeline.py bakeable_material). */
export function bakesMaterial(m: THREE.Material): boolean {
  if (!(m instanceof THREE.MeshStandardNodeMaterial) || m instanceof THREE.MeshPhysicalNodeMaterial) {
    // a physical material here is the game's glass (or transmissive): never baked
    return false;
  }
  if (typeof m.userData.mark === 'string') return false;
  if (m.userData.bake === false) return false;
  return !m.transparent;
}

/**
 * The lightmaps of a loaded glb: the textures its baked objects name, by name (a texture of the glb no material uses).
 * Each is on the second UV, sRGB (the KTX2 says so itself; a PNG is marked here before it is first uploaded).
 */
export async function loadLightmaps(gltf: GLTF): Promise<Map<string, THREE.Texture>> {
  const names = new Set<string>();
  gltf.scene.traverse((o) => {
    const ref = lightmapOf(o.userData);
    if (ref) names.add(ref.name);
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
}

/**
 * Gives every mesh of an object with a lightmap (itself or its nearest ancestor with the extras: GLTFLoader splits a mesh
 * with several materials into children) the baked material for each of its bakeable materials. Others stay as they are.
 */
export function applyLightmaps(
  root: THREE.Object3D,
  lightmaps: ReadonlyMap<string, THREE.Texture>,
): LightmapReport {
  const made = new Map<string, BakedStandardNodeMaterial>();
  const used = new Set<THREE.Material>();
  const sources = new Set<THREE.Material>();
  const meshes: THREE.Mesh[] = [];
  const missing = new Set<string>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let ref: LightmapRef | null = null;
    let owner: THREE.Object3D | null = mesh;
    for (; owner && !ref; owner = owner.parent) ref = lightmapOf(owner.userData);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!ref) {
      for (const m of mats) used.add(m);
      return;
    }
    const texture = lightmaps.get(ref.name);
    if (!texture) {
      missing.add(String(mesh.userData.name ?? mesh.name));
      for (const m of mats) used.add(m);
      return;
    }
    const lightmapRef = ref;
    const one = (m: THREE.Material): THREE.Material => {
      if (!bakesMaterial(m)) {
        used.add(m);
        return m;
      }
      sources.add(m);
      const key = `${m.uuid}|${texture.uuid}|${lightmapRef.scale}`;
      let baked = made.get(key);
      if (!baked) {
        baked = toBakedMaterial(m as THREE.MeshStandardNodeMaterial, texture, lightmapRef.scale);
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
  };
}
