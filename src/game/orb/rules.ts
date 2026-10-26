import { activeSegmentIds, type FootingSegment, segmentsUnder, type Vec3 } from '../../layers/footing';
import { type BodyExtent, cutSurfaceIds, segmentsAroundBody } from '../../layers/surface';
import { BODY_HEIGHT, BODY_RADIUS, SKIN } from '../player/constants';
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

/**
 * The player's body as the pickup check sees it among surface-only walls (S-28): S-03's capsule and the gap its
 * controller keeps all round, so a wall coming back within that gap counts as around the body too.
 */
export const PICKUP_BODY: BodyExtent = { radius: BODY_RADIUS + SKIN, height: BODY_HEIGHT + 2 * SKIN };

export interface PickUpContext {
  pedestals: Readonly<Record<string, Vec3>>;
  footing: readonly FootingSegment[];
  /**
   * Surface-only walls (S-28; layers/surface) and the body that stands among them. A segment the placed orbs cut
   * away comes back when they are picked up, so it must not have the body in it then.
   */
  surface?: { segments: readonly FootingSegment[]; body: BodyExtent };
  /** Player foot position. */
  feet: Vec3;
  /**
   * 定着 (S-34; S-40 moved here from the session): ids of the footing and surface-only segments the light has fixed onto the
   * surface for good. They are no longer any orb's to hold: on settled footing the vidro comes (光で定着した足場の上では回収できる),
   * and a settled wall stays cut, so neither is asked about.
   */
  settled?: { footing?: readonly string[]; surface?: readonly string[] };
}

/**
 * 実体化した足場の上にいるときは回収できない: refuse when a back-layer segment under the feet
 * would lose its collider without this orb. Footing still held by another orb's sphere is safe,
 * which keeps 「道を小玉で保ったまま、主玉を持って先を覗く」 possible.
 * The same for a surface-only wall the body stands in (S-28): refuse when a segment around the body would get its
 * collider back without this orb (it would shut the body in).
 */
export function canPickUp(orbs: readonly Orb[], id: string, ctx: PickUpContext): boolean {
  const orb = orbById(orbs, id);
  if (!orb || orb.pedestal === null) return false;
  const asked = unsettled(ctx);
  return !shutsInSurface(orbs, id, asked) && keepsFooting(orbs, id, asked);
}

/** The context without what the light has fixed (S-34: not the orb's to hold any more). */
function unsettled(ctx: PickUpContext): PickUpContext {
  const footingIds = ctx.settled?.footing ?? [];
  const surfaceIds = ctx.settled?.surface ?? [];
  if (footingIds.length === 0 && surfaceIds.length === 0) return ctx;
  const footing = new Set(footingIds);
  const surface = new Set(surfaceIds);
  return {
    ...ctx,
    footing: footing.size > 0 ? ctx.footing.filter((s) => !footing.has(s.id)) : ctx.footing,
    surface:
      ctx.surface && surface.size > 0
        ? { ...ctx.surface, segments: ctx.surface.segments.filter((s) => !surface.has(s.id)) }
        : ctx.surface,
  };
}

/** Would picking this orb up bring a surface-only segment back around the body? */
function shutsInSurface(orbs: readonly Orb[], id: string, ctx: PickUpContext): boolean {
  if (!ctx.surface) return false;
  const around = segmentsAroundBody(ctx.feet, ctx.surface.body, ctx.surface.segments);
  if (around.length === 0) return false;
  // Only orbs on their pedestals cut a wall (a sphere shrinking after its pickup already gave its segments back).
  const placed = orbs.filter((o) => o.pedestal !== null);
  const now = new Set(cutSurfaceIds(around, orbSpheres(placed, ctx.pedestals)));
  const after = new Set(
    cutSurfaceIds(
      around,
      orbSpheres(
        placed.filter((o) => o.id !== id),
        ctx.pedestals,
      ),
    ),
  );
  return around.some((seg) => now.has(seg.id) && !after.has(seg.id));
}

/** Does the back footing under the feet stay without this orb? */
function keepsFooting(orbs: readonly Orb[], id: string, ctx: PickUpContext): boolean {
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
