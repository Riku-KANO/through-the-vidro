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

/** Splits a footing box into segments of about `size` metres along its longer horizontal axis. */
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

/** Segments directly under a foot position (x/z inside the footprint, feet at deck height). */
export function segmentsUnder(feet: Vec3, segments: readonly FootingSegment[]): FootingSegment[] {
  const [x, y, z] = feet;
  return segments.filter(
    (s) =>
      x >= s.min[0] &&
      x < s.max[0] &&
      z >= s.min[2] &&
      z <= s.max[2] &&
      y >= s.max[1] - STAND_TOLERANCE &&
      y <= s.max[1] + STAND_TOLERANCE,
  );
}
