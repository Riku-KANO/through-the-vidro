import type { GlassPlacement } from '../../core/glass';
import type { LayerKind, Vec3 } from '../../layers';
import { type AssetName, type GlassMarkError, layerOfRole, type NameError, parseAssetName } from './naming';

/**
 * What a loaded asset is made of, from its node names and extras (設計書 Blenderアセットパイプライン > 命名規則とゲーム情報:
 * カスタムプロパティはglTFのextrasとして書き出し、ゲーム側で読み取ってギミックを自動で組み立てます). Pure: assemble.ts applies
 * it to the three objects, and the tests feed it plain data (also the JSON of the committed glb files).
 *
 * Rules (the lint in Blender, blender/scripts/vidro/naming.py, checks the same before export):
 *  - a node whose name follows the rules is an object; a node without such a name belongs to its nearest named
 *    ancestor (GLTFLoader splits a mesh with several materials into children; quantization can move a mesh into an
 *    unnamed child). A drawn node with neither is reported and left out
 *  - _front → surface layer, _back → back layer, no role → both layers, _col → a collider (not drawn)
 *  - a collider is on the layer of the visuals with the same base name, both layers when there are none; extras.layer
 *    decides when the visuals are on more than one layer
 *  - sock: extras.materialize_radius (実体化半径, m); the orb sits at extras.origin, written by the pipeline (the node
 *    itself moves to the middle of its mesh when quantized), or at the node when there is none
 *  - bell: extras.pitch (音程)
 *  - _LOD0/1/2 of the same base and role form one level-of-detail chain; LOD0 is required
 *  - extras.placement (near | far | behind-glass) is where glass stands (技術設計 > ガラスの描画 > 対策1)
 */
export interface AssetNode {
  /** The node name as written in the glTF (GLTFLoader keeps it in userData.name); '' for objects three made. */
  name: string;
  parent: number | null;
  /** Has geometry of its own. */
  renderable: boolean;
  extras: Readonly<Record<string, unknown>>;
  /** Position of the node in the asset's own space (the glTF scene; extras.origin is in the same space). */
  position: Vec3;
}

export interface AssetProblem {
  /** The object (or the name of a level-of-detail chain) the problem is about. */
  object: string;
  /** The same codes as the lint in Blender (naming_cases.json). */
  code: NameError | ExtrasError | SetError | GlassMarkError | 'duplicate-name' | 'glass-unmarked';
  message: string;
}

type ExtrasError = 'socket-radius' | 'bell-pitch' | 'placement' | 'collider-layer' | 'origin';
type SetError = 'lod0-missing' | 'lod-mixed' | 'collider-layer';

export interface PlannedVisual {
  node: number;
  name: AssetName;
  layer: LayerKind;
  placement: GlassPlacement;
}

export interface PlannedCollider {
  node: number;
  name: AssetName;
  layer: LayerKind;
}

export interface PlannedSocket {
  node: number;
  name: AssetName;
  /** 実体化半径, metres. */
  radius: number;
  /** Where a placed orb's centre is: the centre of the materialized sphere. */
  seat: Vec3;
}

export interface PlannedBell {
  node: number;
  name: AssetName;
  pitch: string;
  origin: Vec3;
}

export interface PlannedLod {
  /** `<base>[_<role>]` */
  key: string;
  layer: LayerKind;
  /** Nearest first. */
  levels: { lod: number; node: number }[];
}

export interface AssetPlan {
  /** For each node, the named node it belongs to (itself when named), or null. */
  owners: (number | null)[];
  visuals: PlannedVisual[];
  colliders: PlannedCollider[];
  sockets: PlannedSocket[];
  bells: PlannedBell[];
  lods: PlannedLod[];
  problems: AssetProblem[];
}

const MESSAGES: Record<AssetProblem['code'], string> = {
  'blender-duplicate':
    'Blender added .001 to a taken name; put the number into the name (A1_bld_dome04_front)',
  format: 'not <area>_<kind>_<id>[_front|_back|_col][_LOD0-2]',
  area: 'the area is A0–A9 or CM (common)',
  kind: 'the kind is 2–8 lowercase letters (bld, brg, sock, bell…)',
  id: 'the id is letters and digits only (dome03, 02, D4)',
  suffix: 'only _front / _back / _col, then _LOD0–_LOD2, may follow the id',
  lod: 'the levels of detail are _LOD0, _LOD1 and _LOD2',
  'collider-lod': 'a collider (_col) has no level of detail',
  'socket-radius': 'a socket needs extras.materialize_radius (metres, > 0)',
  'bell-pitch': 'a resonator needs extras.pitch (D4, F#5…)',
  placement: 'extras.placement is near, far or behind-glass',
  'collider-layer':
    'extras.layer of a collider is surface, back or shared; give it when the visuals of the same name are on both layers',
  origin: 'extras.origin is three numbers (written by the pipeline)',
  'lod0-missing': 'there are _LOD1/_LOD2 but no _LOD0',
  'lod-mixed': 'the same object exists with and without _LODn',
  'duplicate-name': 'two nodes have this name',
  'glass-kind':
    'a glass mark is glass_<kind>[_<role>] with a kind of src/core/glass (clear, frosted, amber…)',
  'glass-role': 'the role of a glass mark is scenery, orb, drop or showcase',
  'glass-format': 'a glass mark is glass_<kind>[_<role>], in lowercase',
  'glass-unmarked':
    'transmissive glass placed far or behind glass needs a glass_<kind> mark: only the library glass turns into the cheap far path',
};

export function problemMessage(code: AssetProblem['code']): string {
  return MESSAGES[code];
}

const PLACEMENTS: readonly GlassPlacement[] = ['near', 'far', 'behind-glass'];
const LAYERS: readonly LayerKind[] = ['surface', 'back', 'shared'];
const PITCH = /^[A-G](#|b)?[0-8]$/;
const SOCKET = 'sock';
const BELL = 'bell';

const positiveNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const vec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

export function planAsset(nodes: readonly AssetNode[]): AssetPlan {
  const problems: AssetProblem[] = [];
  const report = (object: string, code: AssetProblem['code']) =>
    problems.push({ object, code, message: MESSAGES[code] });

  const parsed = nodes.map((n) => parseAssetName(n.name));
  const owners = nodes.map((_, i) => {
    for (let j: number | null = i, guard = 0; j !== null && guard <= nodes.length; guard++) {
      if (parsed[j]?.ok) return j;
      j = nodes[j]?.parent ?? null;
    }
    return null;
  });

  const plan: AssetPlan = { owners, visuals: [], colliders: [], sockets: [], bells: [], lods: [], problems };
  const named: { node: number; name: AssetName; extras: Readonly<Record<string, unknown>> }[] = [];
  nodes.forEach((n, i) => {
    const p = parsed[i];
    if (!p) return;
    if (!p.ok) {
      if (n.renderable && owners[i] === null) report(n.name, p.error);
      return;
    }
    const name = p.value;
    const e = n.extras;
    named.push({ node: i, name, extras: e });
    if (name.role !== 'col') {
      if (name.kind === SOCKET) {
        const radius = e.materialize_radius;
        if (positiveNumber(radius)) {
          plan.sockets.push({ node: i, name, radius, seat: vec3(e.origin) ? e.origin : n.position });
        } else report(n.name, 'socket-radius');
      }
      if (name.kind === BELL) {
        const pitch = e.pitch;
        if (typeof pitch === 'string' && PITCH.test(pitch)) {
          plan.bells.push({ node: i, name, pitch, origin: vec3(e.origin) ? e.origin : n.position });
        } else report(n.name, 'bell-pitch');
      }
    }
    let placement: GlassPlacement = 'near';
    if ('placement' in e) {
      if (PLACEMENTS.includes(e.placement as GlassPlacement)) placement = e.placement as GlassPlacement;
      else report(n.name, 'placement');
    }
    if (name.role === 'col' && 'layer' in e && !LAYERS.includes(e.layer as LayerKind)) {
      report(n.name, 'collider-layer');
    }
    if ('origin' in e && !vec3(e.origin)) report(n.name, 'origin');
    const layer = layerOfRole(name.role);
    if (layer) plan.visuals.push({ node: i, name, layer, placement });
  });

  const seen = new Set<string>();
  for (const { node } of named) {
    const n = nodes[node]?.name ?? '';
    if (seen.has(n)) report(n, 'duplicate-name');
    seen.add(n);
  }

  // levels of detail: one chain per <base>[_<role>]
  const chains = new Map<string, PlannedLod>();
  const plain = new Set<string>();
  for (const v of plan.visuals) {
    const key = v.name.base + (v.name.role ? `_${v.name.role}` : '');
    if (v.name.lod === null) {
      plain.add(key);
      continue;
    }
    let chain = chains.get(key);
    if (!chain) {
      chain = { key, layer: v.layer, levels: [] };
      chains.set(key, chain);
    }
    chain.levels.push({ lod: v.name.lod, node: v.node });
  }
  for (const chain of chains.values()) {
    chain.levels.sort((a, b) => a.lod - b.lod);
    if (chain.levels[0]?.lod !== 0) report(chain.key, 'lod0-missing');
    if (plain.has(chain.key)) report(chain.key, 'lod-mixed');
    plan.lods.push(chain);
  }

  // colliders: on the layer of the visuals of the same base
  const visualLayers = new Map<string, Set<LayerKind>>();
  for (const v of plan.visuals) {
    const set = visualLayers.get(v.name.base) ?? new Set<LayerKind>();
    set.add(v.layer);
    visualLayers.set(v.name.base, set);
  }
  for (const { node, name, extras } of named) {
    if (name.role !== 'col') continue;
    let layer: LayerKind = 'shared';
    if ('layer' in extras) {
      if (LAYERS.includes(extras.layer as LayerKind)) layer = extras.layer as LayerKind;
    } else {
      const layers = [...(visualLayers.get(name.base) ?? [])];
      if (layers.length === 1) layer = layers[0] as LayerKind;
      else if (layers.length > 1) report(nodes[node]?.name ?? name.base, 'collider-layer');
    }
    plan.colliders.push({ node, name, layer });
  }
  return plan;
}
