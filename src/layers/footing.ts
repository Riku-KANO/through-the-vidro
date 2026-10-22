/**
 * Back-layer footing split into small segments (技術設計 > 裏の層の実装 > 当たり判定):
 * only the segments that overlap a materialized sphere get their collider enabled.
 * Pure geometry; the physics adapter (Rapier collider.setEnabled) is wired at integration.
 */
export type Vec3 = readonly [number, number, number];

export interface Sphere {
  center: Vec3;
  radius: number;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface FootingSegment extends Box {
  id: string;
}

/**
 * A sphere as the colliders see it. With `materialize` (S-02's orb spheres, orbSpheres()), only a sphere whose
 * orb stands on its pedestal (target 1: growing or grown) holds; one shrinking after a pickup (target 0) is on
 * its way out. A sphere without it is fixed (the dev holds draw one).
 */
export interface FootingSphere extends Sphere {
  materialize?: { target: 0 | 1 };
}

/**
 * Does this sphere hold now — ground to step onto (the fence, S-06) and surface-only walls cut away (S-28)?
 * Only the sphere of a placed orb does.
 */
export function holdsGround(sphere: FootingSphere): boolean {
  return sphere.materialize === undefined || sphere.materialize.target === 1;
}

/**
 * Splits a footing box into segments of about `size` metres along its longer horizontal axis
 * (a strip: bridges, stairs). A wide floor would need a grid of segments instead.
 */
export function splitFooting(id: string, box: Box, size: number): FootingSegment[] {
  const lenX = box.max[0] - box.min[0];
  const lenZ = box.max[2] - box.min[2];
  const alongX = lenX >= lenZ;
  const len = alongX ? lenX : lenZ;
  const count = Math.max(1, Math.round(len / size));
  const out: FootingSegment[] = [];
  for (let i = 0; i < count; i++) {
    const a = (alongX ? box.min[0] : box.min[2]) + (len * i) / count;
    const b = (alongX ? box.min[0] : box.min[2]) + (len * (i + 1)) / count;
    out.push({
      id: `${id}:${i}`,
      min: alongX ? [a, box.min[1], box.min[2]] : [box.min[0], box.min[1], a],
      max: alongX ? [b, box.max[1], box.max[2]] : [box.max[0], box.max[1], b],
    });
  }
  return out;
}

export function sphereOverlapsBox(s: Sphere, b: Box): boolean {
  if (!(s.radius > 0)) return false;
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const c = s.center[i] ?? 0;
    const lo = b.min[i] ?? 0;
    const hi = b.max[i] ?? 0;
    const d = c < lo ? lo - c : c > hi ? c - hi : 0;
    d2 += d * d;
  }
  return d2 <= s.radius * s.radius;
}

/** Ids of the segments whose collider should be enabled, in segment order. */
export function activeSegmentIds(segments: readonly FootingSegment[], spheres: readonly Sphere[]): string[] {
  return segments.filter((seg) => spheres.some((s) => sphereOverlapsBox(s, seg))).map((seg) => seg.id);
}

/** How far above a deck the feet may be and still count as standing on it. */
const STAND_TOLERANCE = 0.25;

/**
 * Segments directly under a foot position (x/z inside the footprint, feet at deck height).
 * The footprint is half-open on both horizontal axes, so feet on a shared border belong to exactly
 * one segment whichever axis the footing was split along.
 */
export function segmentsUnder(feet: Vec3, segments: readonly FootingSegment[]): FootingSegment[] {
  const [x, y, z] = feet;
  return segments.filter(
    (s) =>
      x >= s.min[0] &&
      x < s.max[0] &&
      z >= s.min[2] &&
      z < s.max[2] &&
      y >= s.max[1] - STAND_TOLERANCE &&
      y <= s.max[1] + STAND_TOLERANCE,
  );
}
