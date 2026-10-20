import { SPRINT_SPEED, STEP_HEIGHT } from './constants';
import type { PlanarVelocity } from './motion';

/**
 * 足場の縁ではやわらかく止まる (コアメカニクス > 基本の動作: 落下死はない).
 *
 * The ground around the body is sampled on a ring of directions. Walking outward, a drop larger than a
 * step (or no ground at all) marks an edge. Each edge becomes a soft wall: the speed toward it is
 * limited in proportion to the remaining distance, so the body glides to rest a little inside the edge
 * and keeps any motion along it. Pure: the world is read only through `GroundProbe`.
 */

/**
 * Looks straight down from (x, fromY, z) for at most `depth`. Returns the height of the first surface,
 * `fromY` itself when the start point is inside something solid (a wall), or null when nothing is hit.
 * A probe may be fat (a small sphere cast): it then also finds ground up to `probeRadius` to the side,
 * which bridges seams between pieces of floor; findLedges corrects the edge distance for it.
 */
export type GroundProbe = (x: number, z: number, fromY: number, depth: number) => number | null;

export interface LedgeOptions {
  /** Edges are sensed this far from the body centre; slowing starts inside it. */
  senseRadius: number;
  /** Where the body comes to rest: distance from its centre to the edge. */
  margin: number;
  /** A drop between neighbouring samples larger than this is an edge (smaller ones are stepped down). */
  stepDown: number;
  /** Sideways reach of the probe (0 for a ray). */
  probeRadius: number;
  /** Samples start this high above the last ground, so climbable steps read as ground and not as walls. */
  probeUp: number;
  directions: number;
  marchSteps: number;
  refineSteps: number;
  /** The fastest the body moves. Far from edges this is the speed limit, so nothing changes. */
  maxSpeed: number;
  /** Inside the margin the body is eased back inward at most this fraction of maxSpeed. */
  pushBack: number;
}

export const LEDGE_DEFAULTS: Readonly<LedgeOptions> = Object.freeze({
  senseRadius: 0.6,
  margin: 0.3,
  // Only drops that can also be climbed back up count as steps (no pits you can walk into but not out of).
  stepDown: STEP_HEIGHT + 0.02,
  probeRadius: 0,
  probeUp: STEP_HEIGHT + 0.1,
  directions: 16,
  marchSteps: 4,
  refineSteps: 6,
  maxSpeed: SPRINT_SPEED,
  pushBack: 0.15,
});

/** An edge near the body: outward unit normal on the ground plane and distance from the body centre. */
export interface Ledge {
  nx: number;
  nz: number;
  distance: number;
}

export function findLedges(
  x: number,
  z: number,
  groundY: number,
  probe: GroundProbe,
  opts: Readonly<LedgeOptions> = LEDGE_DEFAULTS,
): Ledge[] {
  const { senseRadius, stepDown, probeUp, directions, marchSteps, refineSteps, probeRadius } = opts;
  // A fat probe still finds ground probeRadius past the real edge, so look that much further.
  const reach = senseRadius + probeRadius;
  const depth = probeUp + stepDown;
  // Already over the void (airborne past an edge): nothing to hold on to.
  if (probe(x, z, groundY + probeUp, depth) === null) return [];

  const edgeAt: (number | null)[] = [];
  for (let i = 0; i < directions; i++) {
    const a = (2 * Math.PI * i) / directions;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let prevD = 0;
    let prevH = groundY;
    let edge: number | null = null;
    for (let j = 1; j <= marchSteps; j++) {
      const d = (reach * j) / marchSteps;
      const from = prevH + probeUp;
      const h = probe(x + dx * d, z + dz * d, from, depth);
      if (h !== null && h >= from - 1e-6) break; // a wall: the character controller handles it
      if (h !== null) {
        prevD = d;
        prevH = h;
        continue;
      }
      let lo = prevD;
      let hi = d;
      for (let k = 0; k < refineSteps; k++) {
        const mid = (lo + hi) / 2;
        if (probe(x + dx * mid, z + dz * mid, from, depth) === null) hi = mid;
        else lo = mid;
      }
      edge = Math.max(0, (lo + hi) / 2 - probeRadius);
      break;
    }
    edgeAt.push(edge);
  }

  const ledges: Ledge[] = [];
  const n = directions;
  const at = (i: number) => edgeAt[((i % n) + n) % n] ?? null;
  for (let i = 0; i < n; i++) {
    const d = at(i);
    if (d === null) continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    // One soft wall per local minimum, so each side of a narrow walkway or corner gets its own.
    if (!(d <= (prev ?? Number.POSITIVE_INFINITY) && d < (next ?? Number.POSITIVE_INFINITY))) continue;
    ledges.push(edgeFromSamples(i, d, prev, next, n));
  }
  return ledges;
}

/** Edge line through the neighbouring edge points (exact for straight edges), else the sample direction. */
function edgeFromSamples(i: number, d: number, prev: number | null, next: number | null, n: number): Ledge {
  const dir = (k: number) => {
    const a = (2 * Math.PI * k) / n;
    return { x: Math.cos(a), z: Math.sin(a) };
  };
  const here = dir(i);
  if (prev === null || next === null) return { nx: here.x, nz: here.z, distance: d };
  const p = dir(i - 1);
  const q = dir(i + 1);
  const ax = p.x * prev;
  const az = p.z * prev;
  const tx = q.x * next - ax;
  const tz = q.z * next - az;
  const len = Math.hypot(tx, tz);
  if (len < 1e-9) return { nx: here.x, nz: here.z, distance: d };
  let nx = tz / len;
  let nz = -tx / len;
  if (nx * here.x + nz * here.z < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { nx, nz, distance: Math.min(d, ax * nx + az * nz) };
}

/**
 * Limits the velocity toward each edge: full speed at the sensing radius, zero at the margin,
 * a gentle push inward inside it. Motion along the edge is kept.
 */
export function limitVelocityAtLedges(
  v: PlanarVelocity,
  ledges: readonly Ledge[],
  opts: Readonly<LedgeOptions> = LEDGE_DEFAULTS,
): PlanarVelocity {
  if (ledges.length === 0) return v;
  const { margin, senseRadius, maxSpeed, pushBack } = opts;
  let { x, z } = v;
  // Two passes so corners (two edges) settle on a velocity that respects both.
  for (let pass = 0; pass < 2; pass++) {
    for (const l of ledges) {
      const t = Math.min(1, Math.max(-pushBack, (l.distance - margin) / (senseRadius - margin)));
      const allowed = maxSpeed * t;
      const outward = x * l.nx + z * l.nz;
      if (outward > allowed) {
        x -= (outward - allowed) * l.nx;
        z -= (outward - allowed) * l.nz;
      }
    }
  }
  return { x, z };
}
