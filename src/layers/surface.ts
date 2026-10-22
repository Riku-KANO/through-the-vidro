import {
  type Box,
  type FootingSegment,
  type FootingSphere,
  holdsGround,
  type Sphere,
  type Vec3,
} from './footing';

/**
 * Surface-only walls inside a placed orb's sphere (S-28). コアメカニクス > 裏の層のルール: 玉を置くと、その球の中では裏が表を
 * 置き換える…表にしかない壁は消えて通れるようになる. The drawing is cut by the sphere (field.ts); the collider follows in
 * segments, the mirror of the back footing (技術設計 > 裏の層の実装 > 当たり判定: 細かい区画):
 *  - a segment loses its collider while it lies wholly inside the sphere of a placed orb (cutSurfaceIds), and gets it
 *    back the moment that orb is picked up. A segment the sphere's film crosses stays solid: part of it is still drawn
 *  - picking the orb up while the body stands in a cut segment would shut the body in, so the pickup asks first
 *    (segmentsAroundBody; game/orb/rules canPickUp refuses it like standing on the back footing)
 * Pure geometry; the Rapier side is game/prologue/physics.ts SurfaceColliders.
 */

/**
 * 仮 (S-28, 発案者 2026-10-22: 区画の大きさは 0.4m から): the largest edge of a surface-only segment, the same as the back
 * footing's (S-02). Inside the sphere's film, a wall can stay solid up to one segment beyond what is drawn; tune it in
 * area 1's room of 表だけの壁.
 */
export const SURFACE_SEGMENT = 0.4;

/**
 * Splits a surface-only box into a grid of segments no longer than `size` on any axis (a wall is split along its
 * width and its height, so a wall taller than the sphere opens below and stays where it is still drawn above).
 * Ids are `<id>:<ix>.<iy>.<iz>`.
 */
export function splitSurface(id: string, box: Box, size: number): FootingSegment[] {
  const counts = [0, 1, 2].map((a) => {
    const len = (box.max[a] ?? 0) - (box.min[a] ?? 0);
    return Math.max(1, Math.ceil(len / size - 1e-9));
  }) as [number, number, number];
  const edge = (a: number, i: number): number => {
    const lo = box.min[a] ?? 0;
    const hi = box.max[a] ?? 0;
    const n = counts[a] ?? 1;
    return i >= n ? hi : lo + ((hi - lo) * i) / n;
  };
  const out: FootingSegment[] = [];
  for (let ix = 0; ix < counts[0]; ix++)
    for (let iy = 0; iy < counts[1]; iy++)
      for (let iz = 0; iz < counts[2]; iz++)
        out.push({
          id: `${id}:${ix}.${iy}.${iz}`,
          min: [edge(0, ix), edge(1, iy), edge(2, iz)],
          max: [edge(0, ix + 1), edge(1, iy + 1), edge(2, iz + 1)],
        });
  return out;
}

/** True when every corner of the box is inside (or on) the sphere. */
export function boxInsideSphere(b: Box, s: Sphere): boolean {
  if (!(s.radius > 0)) return false;
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]])
        if (Math.hypot(x - s.center[0], y - s.center[1], z - s.center[2]) > s.radius) return false;
  return true;
}

/**
 * Ids of the surface-only segments whose collider is cut now, in segment order: those wholly inside the sphere of a
 * placed orb (holdsGround). A sphere shrinking after a pickup cuts nothing, so the wall is solid again at once.
 */
export function cutSurfaceIds(
  segments: readonly FootingSegment[],
  spheres: readonly FootingSphere[],
): string[] {
  const held = spheres.filter(holdsGround);
  if (held.length === 0) return [];
  return segments.filter((seg) => held.some((s) => boxInsideSphere(seg, s))).map((seg) => seg.id);
}

/** A standing body around its feet: an upright cylinder (the capsule and the gap the controller keeps). */
export interface BodyExtent {
  radius: number;
  height: number;
}

/**
 * Segments a standing body is in: its round footprint overlaps the segment's (strictly, so a body touching a face is
 * not in it) and its height overlaps the segment's.
 */
export function segmentsAroundBody(
  feet: Vec3,
  body: BodyExtent,
  segments: readonly FootingSegment[],
): FootingSegment[] {
  const [x, y, z] = feet;
  const r2 = body.radius * body.radius;
  return segments.filter((s) => {
    if (!(y + body.height > s.min[1] && y < s.max[1])) return false;
    const dx = x < s.min[0] ? s.min[0] - x : x > s.max[0] ? x - s.max[0] : 0;
    const dz = z < s.min[2] ? s.min[2] - z : z > s.max[2] ? z - s.max[2] : 0;
    return dx * dx + dz * dz < r2;
  });
}
