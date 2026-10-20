import type { Vec3 } from '../../layers/footing';
import {
  MAIN_ORB_RADIUS,
  MAX_SPHERES,
  type Materialization,
  materializedRadius,
  pickUpOrb,
  placeOrb,
  SMALL_ORB_RADIUS,
  stepMaterialization,
} from '../../layers/materialize';

/**
 * The orbs the player owns (コアメカニクス > ガラス玉の性質の成長): one main orb that can peek,
 * and up to two small orbs that can only be placed. Immutable updates; pure.
 */
export type OrbKind = 'main' | 'small';

export interface Orb {
  id: string;
  kind: OrbKind;
  /** Pedestal id, or null while the orb is in hand. */
  pedestal: string | null;
  /** Where the orb last stood; the sphere keeps shrinking there after a pickup. */
  lastPedestal: string | null;
  materialize: Materialization;
}

export const MAX_SMALL_ORBS = MAX_SPHERES - 1;

export function orbRadius(kind: OrbKind): number {
  return kind === 'main' ? MAIN_ORB_RADIUS : SMALL_ORB_RADIUS;
}

export function createOrbs(smallCount: number): Orb[] {
  const small = Math.max(0, Math.min(MAX_SMALL_ORBS, Math.floor(smallCount)));
  const rest = (id: string, kind: OrbKind): Orb => ({
    id,
    kind,
    pedestal: null,
    lastPedestal: null,
    materialize: { progress: 0, target: 0 },
  });
  return [rest('main', 'main'), ...Array.from({ length: small }, (_, i) => rest(`small-${i + 1}`, 'small'))];
}

export function orbById(orbs: readonly Orb[], id: string): Orb | undefined {
  return orbs.find((o) => o.id === id);
}

export function pedestalOccupied(orbs: readonly Orb[], pedestal: string): boolean {
  return orbs.some((o) => o.pedestal === pedestal);
}

/** Puts an orb on a pedestal and starts the materialization. No-op if not possible. */
export function placeOn(orbs: readonly Orb[], id: string, pedestal: string): Orb[] {
  const orb = orbById(orbs, id);
  if (!orb || orb.pedestal !== null || pedestalOccupied(orbs, pedestal)) return [...orbs];
  // Its sphere is still shrinking at another pedestal: it must finish there first (rules.canPlace).
  if (orb.lastPedestal !== null && orb.lastPedestal !== pedestal && orb.materialize.progress > 0)
    return [...orbs];
  // Back on the same pedestal mid-shrink: grow again from where it is.
  const progress = orb.lastPedestal === pedestal ? orb.materialize.progress : 0;
  return orbs.map((o) =>
    o.id === id
      ? { ...o, pedestal, lastPedestal: pedestal, materialize: placeOrb({ progress, target: 0 }) }
      : o,
  );
}

/** Takes an orb back into the hand; its sphere plays backwards. Safety is checked by rules.canPickUp. */
export function takeBack(orbs: readonly Orb[], id: string): Orb[] {
  return orbs.map((o) =>
    o.id === id && o.pedestal !== null ? { ...o, pedestal: null, materialize: pickUpOrb(o.materialize) } : o,
  );
}

/** Advances every materialization. Returns the same array when nothing moved (cheap identity checks). */
export function stepOrbs(orbs: readonly Orb[], dt: number): readonly Orb[] {
  let out: Orb[] | null = null;
  orbs.forEach((o, i) => {
    const materialize = stepMaterialization(o.materialize, dt);
    if (materialize === o.materialize) return;
    out ??= [...orbs];
    out[i] = { ...o, materialize };
  });
  return out ?? orbs;
}

/** Jumps every materialization to its end (for tests and loading a save). */
export function settle(orbs: readonly Orb[]): Orb[] {
  return orbs.map((o) => ({
    ...o,
    materialize: { progress: o.materialize.target, target: o.materialize.target },
  }));
}

export interface OrbSphere {
  orbId: string;
  kind: OrbKind;
  center: Vec3;
  radius: number;
  /** The materialization behind this sphere (for the boundary glow). */
  materialize: Materialization;
}

/** Spheres that currently materialize the back layer (radius > 0), main orb first. At most 3. */
export function orbSpheres(orbs: readonly Orb[], pedestals: Readonly<Record<string, Vec3>>): OrbSphere[] {
  const out: OrbSphere[] = [];
  for (const o of orbs) {
    const at = o.pedestal ?? o.lastPedestal;
    const center = at ? pedestals[at] : undefined;
    const radius = materializedRadius(o.materialize, orbRadius(o.kind));
    if (center && radius > 0)
      out.push({ orbId: o.id, kind: o.kind, center, radius, materialize: o.materialize });
  }
  return out.slice(0, MAX_SPHERES);
}
