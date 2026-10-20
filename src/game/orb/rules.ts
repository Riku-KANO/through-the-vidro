import { activeSegmentIds, type FootingSegment, segmentsUnder, type Vec3 } from '../../layers/footing';
import { type Orb, orbById, orbSpheres, pedestalOccupied } from './orbs';

/**
 * Rules of the two core actions (コアメカニクス > 基本の動作, 技術設計 > 裏の層の実装 > 安全).
 * Pure functions over the orb state; the scene / player only asks.
 */

/** 玉を置いているときは覗けない: peeking needs the main orb in hand. Small orbs never peek. */
export function canPeek(orbs: readonly Orb[]): boolean {
  const main = orbs.find((o) => o.kind === 'main');
  return !!main && main.pedestal === null;
}

/**
 * 台座にしか置けない: an orb in hand goes onto a free pedestal. An orb whose sphere is still shrinking
 * at another pedestal (just picked up) has to finish first, so that sphere plays back to 0.
 * Peeking does not block placing: only the click while peeking means 鳴らす, and that is the input
 * layer's routing (操作とカメラ > 入力の割り当て), not a rule of the orb.
 */
export function canPlace(orbs: readonly Orb[], id: string, pedestal: string): boolean {
  const orb = orbById(orbs, id);
  if (!orb || orb.pedestal !== null || pedestalOccupied(orbs, pedestal)) return false;
  return orb.lastPedestal === pedestal || orb.lastPedestal === null || orb.materialize.progress === 0;
}

export interface PickUpContext {
  pedestals: Readonly<Record<string, Vec3>>;
  footing: readonly FootingSegment[];
  /** Player foot position. */
  feet: Vec3;
}

/**
 * 実体化した足場の上にいるときは回収できない: refuse when a back-layer segment under the feet
 * would lose its collider without this orb. Footing still held by another orb's sphere is safe,
 * which keeps 「道を小玉で保ったまま、主玉を持って先を覗く」 possible.
 */
export function canPickUp(orbs: readonly Orb[], id: string, ctx: PickUpContext): boolean {
  const orb = orbById(orbs, id);
  if (!orb || orb.pedestal === null) return false;
  const under = segmentsUnder(ctx.feet, ctx.footing);
  if (under.length === 0) return true;
  const now = new Set(activeSegmentIds(under, orbSpheres(orbs, ctx.pedestals)));
  // Only orbs that stay on their pedestals keep footing alive; a sphere already shrinking after its
  // own pickup will be gone in < 0.8 s.
  const without = orbSpheres(
    orbs.filter((o) => o.id !== id && o.pedestal !== null),
    ctx.pedestals,
  );
  const after = new Set(activeSegmentIds(under, without));
  for (const seg of under) if (now.has(seg.id) && !after.has(seg.id)) return false;
  return true;
}
