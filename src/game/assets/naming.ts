import { GLASS_KINDS, type GlassKind, type GlassPlacement, type GlassRole } from '../../core/glass';
import type { LayerKind } from '../../layers';

/**
 * The naming rules of the Blender assets (設計書 Blenderアセットパイプライン > 命名規則とゲーム情報). Pure.
 *
 *     <area>_<kind>_<id>[_front|_back|_col][_LOD0|_LOD1|_LOD2]
 *     A1_bld_dome03_front (surface layer), A1_brg_bridge02_back (back layer), A1_bld_dome03_col (collider),
 *     A1_sock_02 (socket), A3_bell_D4 (resonator), CM_lmp_lamp01_LOD1 (a common object, level of detail 1)
 *
 * The same rules run in Blender before export (blender/scripts/vidro/naming.py); both read the cases in
 * blender/scripts/vidro/naming_cases.json, so a name the lint passed is read the same way here.
 */

/** _front: surface layer only. _back: back layer only. _col: a collider, not drawn. None: both layers. */
export type AssetRole = 'front' | 'back' | 'col';

export interface AssetName {
  /** A0–A9 or CM (common). A0 = 序章 and A4 = 終章 are 仮 (the doc's table only shows A1 and A3). */
  area: string;
  /** 2–8 lowercase letters: bld, brg, sock, bell, flr, frm, lmp… */
  kind: string;
  id: string;
  role: AssetRole | null;
  lod: number | null;
  /** `<area>_<kind>_<id>`: what visuals, colliders and levels of detail of one object share. */
  base: string;
  /** The file it is exported into: a1 (a1.glb) …, or common for CM (設計書: エリアごとに1ファイル＋共通アセット1ファイル). */
  group: string;
}

export type NameError =
  | 'blender-duplicate'
  | 'format'
  | 'area'
  | 'kind'
  | 'id'
  | 'suffix'
  | 'lod'
  | 'collider-lod';

export type Parsed<T, E> = { ok: true; value: T } | { ok: false; error: E };

const AREA = /^(A[0-9]|CM)$/;
const KIND = /^[a-z]{2,8}$/;
const IDENT = /^[A-Za-z0-9]+$/;
const LOD = /^LOD([0-9]+)$/;
/** What Blender appends to a name that is taken (Cube.001). */
const DUPLICATE = /\.[0-9]{3,}$/;
const ROLES: readonly string[] = ['front', 'back', 'col'];
const MAX_LOD = 2;
const COMMON_AREA = 'CM';

export function parseAssetName(name: string): Parsed<AssetName, NameError> {
  if (DUPLICATE.test(name)) return { ok: false, error: 'blender-duplicate' };
  const tokens = name.split('_');
  if (tokens.length < 3 || tokens.some((t) => t === '')) return { ok: false, error: 'format' };
  const [area = '', kind = '', id = '', ...rest] = tokens;
  if (!AREA.test(area)) return { ok: false, error: 'area' };
  if (!KIND.test(kind)) return { ok: false, error: 'kind' };
  if (!IDENT.test(id)) return { ok: false, error: 'id' };
  let role: AssetRole | null = null;
  let lod: number | null = null;
  let i = 0;
  const first = rest[i];
  if (first !== undefined && ROLES.includes(first)) {
    role = first as AssetRole;
    i++;
  }
  const m = rest[i] !== undefined ? LOD.exec(rest[i] as string) : null;
  if (m) {
    lod = Number(m[1]);
    if (lod > MAX_LOD) return { ok: false, error: 'lod' };
    i++;
  }
  if (i < rest.length) return { ok: false, error: 'suffix' };
  if (role === 'col' && lod !== null) return { ok: false, error: 'collider-lod' };
  return {
    ok: true,
    value: {
      area,
      kind,
      id,
      role,
      lod,
      base: `${area}_${kind}_${id}`,
      group: area === COMMON_AREA ? 'common' : area.toLowerCase(),
    },
  };
}

/** The layer a visual is drawn on (src/layers). A collider is not drawn: null. */
export function layerOfRole(role: AssetRole | null): LayerKind | null {
  if (role === 'col') return null;
  if (role === 'front') return 'surface';
  if (role === 'back') return 'back';
  return 'shared';
}

/**
 * A glass material marked in Blender: `glass_<kind>[_<role>]`. The game makes it with createGlass, which turns
 * dispersion and thin-film on by role and quality preset (技術設計 > ガラスの描画: 分散と薄膜干渉は手の玉・光の雫・見せ場に限って使う;
 * Blenderアセットパイプライン > 厚みと材質: Blenderから書き出せない設定は、命名規則で印をつけ、読み込み時にコード側で設定する).
 */
export interface GlassMark {
  kind: GlassKind;
  role: GlassRole;
}

export type GlassMarkError = 'blender-duplicate' | 'glass-kind' | 'glass-role' | 'glass-format';

const GLASS_ROLES: readonly GlassRole[] = ['scenery', 'orb', 'drop', 'showcase'];

/** null when the name is not a glass mark at all (its first word is not "glass"). */
export function parseGlassMark(name: string): Parsed<GlassMark, GlassMarkError> | null {
  const stripped = name.replace(DUPLICATE, '');
  const tokens = stripped.split('_');
  const head = tokens[0] ?? '';
  if (head.toLowerCase() !== 'glass') return null;
  if (stripped !== name) return { ok: false, error: 'blender-duplicate' };
  if (head !== 'glass' || tokens.length > 3) return { ok: false, error: 'glass-format' };
  const kind = tokens[1];
  if (kind === undefined || !(GLASS_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: 'glass-kind' };
  }
  const role = tokens[2] ?? 'scenery';
  if (!(GLASS_ROLES as readonly string[]).includes(role)) return { ok: false, error: 'glass-role' };
  return { ok: true, value: { kind: kind as GlassKind, role: role as GlassRole } };
}

/**
 * How serious transmissive glass without a glass_ mark is (the same rule as the lint in Blender, unmarked_glass_level;
 * cases in naming_cases.json): the game draws it with the glTF values, and only the library's glass turns into the
 * cheap far path with the preset (技術設計 > 品質プリセット > 遠景のガラス). So it is a problem away from near, a warning
 * near. A misspelt mark (glass_ruby) is reported as such, not here.
 */
export function unmarkedGlassLevel(
  materialName: string,
  transmissive: boolean,
  placement: GlassPlacement,
): 'warning' | 'problem' | null {
  if (!transmissive || parseGlassMark(materialName) !== null) return null;
  return placement === 'near' ? 'warning' : 'problem';
}
