/**
 * Sensor for 技術設計 > ガラスの描画 > 最大の制約: standard transmission only refracts the opaque scene,
 * so transmissive glass behind other transmissive glass vanishes. Level design avoids that on the main
 * sightlines (対策1). This finds such stacks for a view, from bounding spheres. Pure, no GPU.
 */
export interface GlassSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** One transmissive object, covered by one or more spheres (e.g. the bubbles of a fused building). */
export interface GlassSilhouette {
  id: string;
  spheres: readonly GlassSphere[];
}

export interface ViewSpec {
  /** World → view matrix, column-major (three's camera.matrixWorldInverse.elements). */
  viewMatrix: ArrayLike<number>;
  tanHalfFovY: number;
  aspect: number;
  near: number;
}

export interface TransmissionOverlap {
  front: string;
  back: string;
  /** How far the silhouettes overlap, in tangent-plane units (≈ radians for small angles). */
  amount: number;
}

interface Projected {
  u: number;
  v: number;
  rho: number;
  depth: number;
}

function project(s: GlassSphere, view: ViewSpec): Projected | null {
  const m = view.viewMatrix;
  const vx = (m[0] ?? 0) * s.x + (m[4] ?? 0) * s.y + (m[8] ?? 0) * s.z + (m[12] ?? 0);
  const vy = (m[1] ?? 0) * s.x + (m[5] ?? 0) * s.y + (m[9] ?? 0) * s.z + (m[13] ?? 0);
  const vz = (m[2] ?? 0) * s.x + (m[6] ?? 0) * s.y + (m[10] ?? 0) * s.z + (m[14] ?? 0);
  const depth = -vz;
  if (depth + s.r <= view.near) return null; // entirely behind the camera
  if (depth <= s.r) return { u: 0, v: 0, rho: Number.POSITIVE_INFINITY, depth }; // camera inside it
  const u = vx / depth;
  const v = vy / depth;
  const rho = s.r / Math.sqrt(depth * depth - s.r * s.r);
  const tanY = view.tanHalfFovY;
  const tanX = tanY * view.aspect;
  if (Math.abs(u) - rho > tanX || Math.abs(v) - rho > tanY) return null; // off screen
  return { u, v, rho, depth };
}

/**
 * Pairs of transmissive objects whose silhouettes overlap on screen. `margin` asks for an extra gap
 * between silhouettes (tangent-plane units) so small camera moves stay safe.
 */
export function findTransmissionOverlaps(
  objects: readonly GlassSilhouette[],
  view: ViewSpec,
  options: { margin?: number } = {},
): TransmissionOverlap[] {
  const margin = options.margin ?? 0;
  const projected = objects.map((o) =>
    o.spheres.map((s) => project(s, view)).filter((p): p is Projected => p !== null),
  );
  const out: TransmissionOverlap[] = [];
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      let best: { amount: number; iFront: boolean } | null = null;
      for (const a of projected[i] ?? []) {
        for (const b of projected[j] ?? []) {
          const amount = a.rho + b.rho + margin - Math.hypot(a.u - b.u, a.v - b.v);
          if (amount > 0 && (best === null || amount > best.amount)) {
            best = { amount, iFront: a.depth <= b.depth };
          }
        }
      }
      if (best) {
        const oi = objects[i]?.id ?? '';
        const oj = objects[j]?.id ?? '';
        out.push({ front: best.iFront ? oi : oj, back: best.iFront ? oj : oi, amount: best.amount });
      }
    }
  }
  return out;
}
