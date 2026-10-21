import * as THREE from 'three/webgpu';
import type { MaterialHook } from '../../core/assets';
import {
  createGlass,
  GLASS_SPECS,
  type GlassFeatures,
  type GlassKind,
  type GlassOptions,
  type GlassPlacement,
  type HazeSpec,
  readsBackdrop,
  resolveGlassFeatures,
} from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import { type GlassMark, parseAssetName, parseGlassMark, unmarkedGlassLevel } from './naming';
import { type AssetProblem, problemMessage } from './plan';

/**
 * Glass of loaded assets (S-23). A material marked in Blender (`glass_<kind>[_<role>]`, naming.ts) becomes the
 * library's glass (createGlass), so dispersion and thin-film follow the role and the quality preset (技術設計 > ガラスの描画:
 * 分散と薄膜干渉は手の玉・光の雫・見せ場に限って使う; 技術設計 > 品質プリセット). This is the hook the pipeline asks for
 * (設計書 Blenderアセットパイプライン > 厚みと材質: Blenderから書き出せない設定は、命名規則で印をつけ、読み込み時にコード側で設定する).
 * Blender 5.2 can in fact export dispersion and thin-film (KHR_materials_dispersion, KHR_materials_iridescence), but they
 * must switch with the preset, so the mark decides: a material without the mark loses them (withoutHeavyOptics).
 */

type Preset = Pick<QualityPreset, 'dispersion' | 'farGlassTransmission'>;

/** createGlass's size of the procedural thickness ripples when none is given (仮 0.45 m, src/core/glass/materials.ts). */
const THICKNESS_RIPPLE = 0.45;

export interface AssetGlassInput {
  mark: GlassMark;
  placement: GlassPlacement;
  /** KHR_materials_volume thicknessFactor as three read it (in the mesh's own units); 0 when the glTF has none. */
  thickness: number;
  thicknessMap: THREE.Texture | null;
  /** Scale of the mesh in the world: gltf-transform's quantization stores the mesh in [-1, 1] and puts its size here. */
  worldScale: number;
  /** The glTF emission (linear colour × strength). Milky glass glows from inside with it (乳白: 内側から発光). */
  emissive?: THREE.Color | null;
  /** The scene's haze, for glass on the cheap far path (it fades into the same fog as the rest). */
  haze?: HazeSpec;
}

/**
 * The createGlass options for a marked glass. Thickness stays what the artist set in metres: three multiplies the
 * thickness of transmissive glass by the model's scale, the cheap far path uses it as metres; the procedural ripples
 * are measured in the mesh's own units too.
 */
export function assetGlassOptions(
  input: AssetGlassInput,
  preset: Preset,
): { kind: GlassKind; options: GlassOptions; features: GlassFeatures } {
  const { kind, role } = input.mark;
  const features = resolveGlassFeatures(kind, { placement: input.placement, role }, preset);
  const scale = input.worldScale > 0 ? input.worldScale : 1;
  const metres = input.thickness > 0 ? input.thickness * scale : GLASS_SPECS[kind].thickness;
  const local = features.path === 'transmission' ? 1 / scale : 1;
  const options: GlassOptions = {
    placement: input.placement,
    role,
    thickness: metres * local,
    thicknessScale: THICKNESS_RIPPLE * local,
  };
  if (input.thicknessMap) options.thicknessMap = input.thicknessMap;
  if (input.haze) options.haze = input.haze;
  const e = input.emissive;
  const strength = e ? Math.max(e.r, e.g, e.b) : 0;
  if (kind === 'milky' && e && strength > 0) {
    options.glow = { color: e.clone().multiplyScalar(1 / strength), intensity: strength };
  }
  return { kind, options, features };
}

/** Turns off dispersion and thin-film of a material that is not marked. True when it had any. */
export function withoutHeavyOptics(material: THREE.Material): boolean {
  const m = material as { dispersion?: number; iridescence?: number };
  const had = (m.dispersion ?? 0) > 0 || (m.iridescence ?? 0) > 0;
  if ((m.dispersion ?? 0) > 0) m.dispersion = 0;
  if ((m.iridescence ?? 0) > 0) m.iridescence = 0;
  return had;
}

export interface AssetGlassRecord {
  object: string;
  material: string;
  kind: GlassKind;
  role: GlassMark['role'];
  path: GlassFeatures['path'];
}

const PLACEMENTS: readonly GlassPlacement[] = ['near', 'far', 'behind-glass'];
const scratch = new THREE.Vector3();

/** The named object (naming.ts) a mesh belongs to: itself or its nearest named ancestor. */
function ownerOf(o: THREE.Object3D): THREE.Object3D | null {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    const name = p.userData.name;
    if (typeof name === 'string' && parseAssetName(name).ok) return p;
  }
  return null;
}

/**
 * The material hook for createGltfLoader: marked glass → createGlass (one material per mesh, since quantization gives
 * every mesh its own scale), everything else → the default conversion, without dispersion and thin-film.
 * `glass` lists what was made. `problems`: marks that do not follow the rules (those keep the glTF material), and
 * unmarked transmissive glass placed away from near (only the library's glass switches far glass with the preset:
 * 技術設計 > 品質プリセット > 遠景のガラス). Pass the scene's haze for far glass.
 */
export function createAssetMaterialHook(
  preset: Preset,
  scene: { haze?: HazeSpec } = {},
): {
  hook: MaterialHook;
  glass: AssetGlassRecord[];
  problems: AssetProblem[];
  withoutHeavyOptics: string[];
} {
  const glass: AssetGlassRecord[] = [];
  const problems: AssetProblem[] = [];
  const stripped: string[] = [];
  const reported = new Set<string>();
  const hook: MaterialHook = (material, mesh) => {
    const owner = ownerOf(mesh);
    const objectName = (owner?.userData.name as string | undefined) ?? mesh.name;
    const mark = parseGlassMark(material.name);
    const p = owner?.userData.placement;
    const placement = PLACEMENTS.includes(p as GlassPlacement) ? (p as GlassPlacement) : 'near';
    if (mark === null) {
      if (withoutHeavyOptics(material)) stripped.push(material.name);
      // the same rule as the lint in Blender (unmarkedGlassLevel); the hook runs per mesh and material slot, so an
      // object and material are reported once
      const key = `${objectName}\u0000${material.name}`;
      if (
        unmarkedGlassLevel(material.name, readsBackdrop(material), placement) === 'problem' &&
        !reported.has(key)
      ) {
        reported.add(key);
        problems.push({
          object: objectName,
          code: 'glass-unmarked',
          message: problemMessage('glass-unmarked'),
        });
      }
      return null;
    }
    if (!mark.ok) {
      problems.push({ object: objectName, code: mark.error, message: problemMessage(mark.error) });
      return null;
    }
    mesh.getWorldScale(scratch);
    const source = material as {
      thickness?: number;
      thicknessMap?: THREE.Texture | null;
      emissive?: THREE.Color;
      emissiveIntensity?: number;
    };
    const r = assetGlassOptions(
      {
        mark: mark.value,
        placement,
        thickness: source.thickness ?? 0,
        thicknessMap: source.thicknessMap ?? null,
        worldScale: Math.cbrt(Math.abs(scratch.x * scratch.y * scratch.z)),
        emissive: source.emissive
          ? source.emissive.clone().multiplyScalar(source.emissiveIntensity ?? 1)
          : null,
        haze: scene.haze,
      },
      preset,
    );
    const made = createGlass(r.kind, preset, r.options);
    if (material.side === THREE.DoubleSide) made.material.side = THREE.DoubleSide;
    made.material.userData.mark = material.name;
    glass.push({
      object: objectName,
      material: material.name,
      kind: r.kind,
      role: mark.value.role,
      path: made.features.path,
    });
    return made.material;
  };
  return { hook, glass, problems, withoutHeavyOptics: stripped };
}
