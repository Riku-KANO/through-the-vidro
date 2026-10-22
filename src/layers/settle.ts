import type { Box, FootingSegment, Vec3 } from './footing';

/**
 * 定着 (S-34): part of the back layer fixed onto the surface by light, for good. 発案者の判断 (2026-10-22): 光の雫を取ると、
 * 裏の橋が表に定着して玉を拾っても消えない — the shape of 進行構造とエリア設計 > エリアの内部構造 (3つ目の雫を得ると、
 * 入口の広場への近道が実体化して戻れる) and of 世界観とストーリー > 結末 (裏の層の住人や橋が表に重なって見え始める).
 *
 * A sweep: light runs through a box along a direction, the way a placed orb's wavefront runs out from it (トランジション設計
 * > 玉を置く: 波面が通過した所から裏の層に置き換わる; here 波面が通過した所から表に定着する). Behind its front, what lies in the
 * box is settled: the back layer is there whether or not a sphere holds it, the surface-only things are gone, and the
 * colliders follow — a back footing segment is solid for good, a surface-only segment is cut for good.
 * For the colliders a segment counts once the front has passed all of it (and only if it lies wholly in the box), so a
 * segment is never fixed while its far end still waits for the light.
 * Pure geometry; the drawing is field.ts setSettled, the Rapier side game/prologue/physics.ts.
 */
export interface SettleSweep {
  /** What the light fixes. */
  box: Box;
  /** Unit direction the light travels through the box. */
  direction: Vec3;
}

/** How far along `direction` a point lies (its dot product with it): the coordinate the front is measured in. */
export function along(direction: Vec3, p: Vec3): number {
  return direction[0] * p[0] + direction[1] * p[1] + direction[2] * p[2];
}

/** The span of a sweep, worked out once per sweep (sweeps are fixed data: the room's is layout.ts BRIDGE_SETTLE). */
const spans = new WeakMap<SettleSweep, readonly [number, number]>();

/** The extremes of the box's corners along `direction` (no allocation). */
function boxExtent(box: Box, direction: Vec3, wantMax: boolean): number {
  let out = wantMax ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (let i = 0; i < 8; i++) {
    const s =
      direction[0] * (i & 1 ? box.max[0] : box.min[0]) +
      direction[1] * (i & 2 ? box.max[1] : box.min[1]) +
      direction[2] * (i & 4 ? box.max[2] : box.min[2]);
    out = wantMax ? Math.max(out, s) : Math.min(out, s);
  }
  return out + 0;
}

/** Where the light meets the box first and leaves it last, along its direction. */
export function sweepSpan(sweep: SettleSweep): readonly [number, number] {
  let span = spans.get(sweep);
  if (!span) {
    span = [boxExtent(sweep.box, sweep.direction, false), boxExtent(sweep.box, sweep.direction, true)];
    spans.set(sweep, span);
  }
  return span;
}

/**
 * Where the front stands (along the direction) at `progress`: at the first face at 0, past the last one at 1. No
 * allocation (it is asked every frame while a settled region is drawn).
 */
export function sweepFront(sweep: SettleSweep, progress: number): number {
  const [lo, hi] = sweepSpan(sweep);
  const u = Math.min(1, Math.max(0, progress));
  if (u === 0) return lo;
  if (u === 1) return hi;
  return lo + (hi - lo) * u;
}

/** A point is settled when it lies in the box and the front has passed it. */
export function settledAt(p: Vec3, sweep: SettleSweep, front: number): boolean {
  const { min, max } = sweep.box;
  return (
    p[0] >= min[0] &&
    p[0] <= max[0] &&
    p[1] >= min[1] &&
    p[1] <= max[1] &&
    p[2] >= min[2] &&
    p[2] <= max[2] &&
    along(sweep.direction, p) <= front + 1e-9
  );
}

/**
 * Ids of the segments the light has fixed, in segment order: wholly in the box and wholly behind the front (a segment
 * that pokes out of the box never settles).
 */
export function settledSegmentIds(
  segments: readonly FootingSegment[],
  sweep: SettleSweep,
  front: number,
): string[] {
  return segments.filter((seg) => segmentSettled(seg, sweep, front)).map((seg) => seg.id);
}

/**
 * How many segments the light has fixed (no allocation). The front only moves on, so a count that has not changed means
 * the same segments: callers make the list again only when it grows.
 */
export function countSettled(segments: readonly FootingSegment[], sweep: SettleSweep, front: number): number {
  let n = 0;
  for (const seg of segments) if (segmentSettled(seg, sweep, front)) n++;
  return n;
}

function segmentSettled(seg: FootingSegment, sweep: SettleSweep, front: number): boolean {
  const { min, max } = sweep.box;
  return (
    seg.min[0] >= min[0] &&
    seg.max[0] <= max[0] &&
    seg.min[1] >= min[1] &&
    seg.max[1] <= max[1] &&
    seg.min[2] >= min[2] &&
    seg.max[2] <= max[2] &&
    boxExtent(seg, sweep.direction, true) <= front + 1e-9
  );
}

/**
 * Segments the box cuts through (part in, part out). Their drawing is settled where it lies in the box but their
 * collider never is (only a segment wholly in the box settles), which would not be honest (空間の可読性と導線 4). A room
 * puts its box round whole segments; its tests check this is empty (S-34 review: before S-36 uses settling again).
 */
export function segmentsCutByBox(segments: readonly FootingSegment[], box: Box): string[] {
  return segments
    .filter((seg) => {
      const overlaps =
        seg.max[0] > box.min[0] &&
        seg.min[0] < box.max[0] &&
        seg.max[1] > box.min[1] &&
        seg.min[1] < box.max[1] &&
        seg.max[2] > box.min[2] &&
        seg.min[2] < box.max[2];
      const inside =
        seg.min[0] >= box.min[0] &&
        seg.max[0] <= box.max[0] &&
        seg.min[1] >= box.min[1] &&
        seg.max[1] <= box.max[1] &&
        seg.min[2] >= box.min[2] &&
        seg.max[2] <= box.max[2];
      return overlaps && !inside;
    })
    .map((seg) => seg.id);
}
