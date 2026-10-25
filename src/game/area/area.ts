import type { Box, FootingSegment, Vec3 } from '../../layers/footing';
import type { SettleSweep } from '../../layers/settle';
import { SURFACE_SEGMENT, splitSurface } from '../../layers/surface';

/**
 * エリアの仕組み (S-36; 進行構造とエリア設計 > エリアの内部構造: 1エリア = 入口の広場＋3つの「雫の部屋」＋帰り道の近道).
 * A room is declared as data — its pedestals, its light drop, its surface-only walls and its back-layer footing (and, for
 * a room whose drop fixes something onto the surface, the sweep of light: S-34) — and an area is its rooms. The game's
 * session (game/prologue/session.ts) takes the areas and plays every room by the same rules (S-02's orb, S-28's walls, S-34's
 * settling); the room builds the drawing and the colliders from the same declarations. The prologue's workshop is the
 * first area (prologue/layout.ts PROLOGUE_AREA), エリア1 the second (area1/layout.ts AREA1).
 * Pure data and geometry: no three.js, no Rapier.
 */

/** 台座 (玉座, 置く位置の選択肢そのもの): `base` where it stands on the ground, `orb` where a placed vidro sits (its sphere's centre). */
export interface PedestalDecl {
  readonly id: string;
  readonly base: Vec3;
  readonly orb: Vec3;
}

/** 光の雫 (裏の層にしかない): where it hovers. Touchable only inside a materialized sphere. */
export interface DropDecl {
  readonly id: string;
  readonly at: Vec3;
}

/**
 * 表だけの壁 (S-28; 裏の層のルール: 表にだけあるもの: 崩れた壁、割れた破片の山、閉ざされた扉): a box on the surface layer. Its collider is
 * split into segments (layers/surface splitSurface) that a placed orb's sphere cuts while it holds them wholly.
 */
export interface SurfaceDecl {
  readonly id: string;
  readonly box: Box;
}

/** 裏の足場 (S-02; 裏にだけあるもの: 橋、階段): segments whose colliders a sphere switches on. */
export interface FootingDecl {
  readonly id: string;
  readonly segments: readonly FootingSegment[];
}

/** One 雫の部屋 (1部屋に1つのアイデア). */
export interface RoomDecl {
  readonly id: string;
  readonly pedestals: readonly PedestalDecl[];
  readonly drop: DropDecl;
  readonly surface?: readonly SurfaceDecl[];
  readonly footing?: readonly FootingDecl[];
  /**
   * 定着 (S-34): what the light of this room's drop fixes onto the surface once it is taken (the prologue's bridge). A
   * session takes at most one such room for now (S-40 makes the settled regions many: its shortcut).
   */
  readonly settle?: SettleSweep;
}

export interface AreaDecl {
  readonly id: string;
  readonly rooms: readonly RoomDecl[];
}

/** A drop with the area and room it belongs to. */
export interface PlacedDrop {
  readonly id: string;
  readonly area: string;
  readonly room: string;
  readonly at: Vec3;
}

/** Where each pedestal's placed orb sits (its sphere's centre), by pedestal id, over every room of every area. */
export function pedestalsOf(areas: readonly AreaDecl[]): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const a of areas) for (const r of a.rooms) for (const p of r.pedestals) out[p.id] = p.orb;
  return out;
}

/** Every pedestal with its room and area, in declaration order. */
export function pedestalList(
  areas: readonly AreaDecl[],
): { pedestal: PedestalDecl; room: string; area: string }[] {
  const out: { pedestal: PedestalDecl; room: string; area: string }[] = [];
  for (const a of areas)
    for (const r of a.rooms) for (const p of r.pedestals) out.push({ pedestal: p, room: r.id, area: a.id });
  return out;
}

/** Every back-layer footing segment, in declaration order. */
export function footingOf(areas: readonly AreaDecl[]): FootingSegment[] {
  const out: FootingSegment[] = [];
  for (const a of areas) for (const r of a.rooms) for (const f of r.footing ?? []) out.push(...f.segments);
  return out;
}

/** The segments of one surface-only wall, made once per declaration (the session and the colliders share them). */
const split = new WeakMap<SurfaceDecl, readonly FootingSegment[]>();
export function surfaceSegments(wall: SurfaceDecl): readonly FootingSegment[] {
  let s = split.get(wall);
  if (!s) {
    s = splitSurface(wall.id, wall.box, SURFACE_SEGMENT);
    split.set(wall, s);
  }
  return s;
}

/** Every surface-only segment, in declaration order (the same objects each call). */
export function surfaceOf(areas: readonly AreaDecl[]): FootingSegment[] {
  const out: FootingSegment[] = [];
  for (const a of areas)
    for (const r of a.rooms) for (const w of r.surface ?? []) out.push(...surfaceSegments(w));
  return out;
}

/** Every drop with its area and room, in declaration order. */
export function dropsOf(areas: readonly AreaDecl[]): PlacedDrop[] {
  const out: PlacedDrop[] = [];
  for (const a of areas)
    for (const r of a.rooms) out.push({ id: r.drop.id, area: a.id, room: r.id, at: r.drop.at });
  return out;
}

/** The room whose drop has this id (null for none). */
export function roomOfDrop(areas: readonly AreaDecl[], dropId: string): RoomDecl | null {
  for (const a of areas) for (const r of a.rooms) if (r.drop.id === dropId) return r;
  return null;
}

/**
 * What is wrong with a set of areas, as messages (none: all is well): ids that repeat (areas, rooms, pedestals, drops,
 * walls, footing), more than one settling room (S-40), a drop out of every pedestal's sphere of `reach` (it could never be
 * touched: 光の雫は覗いて見つけ、置いて実体化させてから触れて回収する).
 */
export function checkAreas(areas: readonly AreaDecl[], reach: number): string[] {
  const problems: string[] = [];
  const seen = new Map<string, Set<string>>();
  const once = (kind: string, id: string): void => {
    let s = seen.get(kind);
    if (!s) {
      s = new Set();
      seen.set(kind, s);
    }
    if (s.has(id)) problems.push(`${kind} "${id}" is declared twice`);
    s.add(id);
  };
  let settling = 0;
  for (const a of areas) {
    once('area', a.id);
    for (const r of a.rooms) {
      once('room', r.id);
      for (const p of r.pedestals) once('pedestal', p.id);
      once('drop', r.drop.id);
      for (const w of r.surface ?? []) once('surface', w.id);
      for (const f of r.footing ?? []) once('footing', f.id);
      if (r.settle) settling++;
      const [x, y, z] = r.drop.at;
      const inSome = r.pedestals.some(
        (p) => Math.hypot(x - p.orb[0], y - p.orb[1], z - p.orb[2]) <= reach + 1e-9,
      );
      if (!inSome) problems.push(`drop "${r.drop.id}" lies outside every sphere of room "${r.id}"`);
    }
  }
  if (settling > 1) problems.push(`${settling} rooms settle: one at most (S-40 makes them many)`);
  return problems;
}
