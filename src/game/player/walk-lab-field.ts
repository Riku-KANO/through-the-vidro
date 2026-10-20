import type RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from './player';

/**
 * The walk-lab test field as plain data (S-03). The scene draws it and Rapier collides with it from the same
 * numbers, so what you see is exactly what you walk on (空間の可読性 4: 当たり判定は見た目に正直に):
 * rounded box ↔ round cuboid, cylinder ↔ cylinder, curved wall ↔ a triangle mesh of the drawn vertices.
 * Unit tests walk the same field in Node.
 */
export type Surface = 'walk' | 'wall';

export type FieldPart =
  | { kind: 'box'; centre: Vec3; size: Vec3; radius: number; rotZ?: number; surface: Surface }
  | { kind: 'cylinder'; centre: Vec3; radius: number; height: number; surface: Surface }
  | {
      kind: 'arcWall';
      /** Centre of the arc at floor level. */
      centre: Vec3;
      inner: number;
      outer: number;
      height: number;
      /** Angles (radians) in the XZ plane, measured from +X toward +Z. */
      from: number;
      to: number;
      surface: Surface;
    };

export interface Spawn {
  feet: Vec3;
  yaw: number;
  pitch?: number;
}

/** The raised platform (高台): top at 1.2 m. */
export const HIGH = Object.freeze({ minX: -10, maxX: -4, minZ: -9, maxZ: -3, top: 1.2 });

/** The 1 m wide bridge off the platform's north edge, and the round lookout it leads to. */
export const BRIDGE = Object.freeze({ x: -7, width: 1, fromZ: HIGH.minZ, toZ: -12 });
export const LOOKOUT = Object.freeze({ x: -7, z: -13.3, radius: 1.3 });

export const RAMP_DEG = 15;

export const SPAWNS: Readonly<Record<string, Spawn>> = Object.freeze({
  /** Default view for the sensor screenshot: the field from its south-east. */
  overview: { feet: { x: 7.5, y: 0, z: 8.5 }, yaw: 0.68, pitch: -0.2 },
  /** Clear runway toward -Z. */
  start: { feet: { x: 0, y: 0, z: 8 }, yaw: 0 },
  /** On the platform, 3 m from its west edge (a 1.2 m drop), facing it and looking down at it. */
  edge: { feet: { x: -7, y: HIGH.top, z: -6 }, yaw: Math.PI / 2, pitch: -0.8 },
  /** In front of six 0.2 m steps that lead up to the platform. */
  steps: { feet: { x: -7, y: 0, z: 1.5 }, yaw: 0 },
  /** At the foot of the 15 degree ramp up to the platform. */
  slope: { feet: { x: 1.5, y: 0, z: -6 }, yaw: Math.PI / 2 },
  /** Facing the round pillar 30 degrees off its centre. */
  pillar: { feet: { x: 3.75, y: 0, z: 1 }, yaw: 0 },
  /** Facing the inside of the curved wall at an angle. */
  curve: { feet: { x: 4.2, y: 0, z: -8 }, yaw: 0 },
  /** On the platform in front of the bridge. */
  bridge: { feet: { x: -7, y: HIGH.top, z: -7.5 }, yaw: 0, pitch: -0.25 },
});

export function walkLabParts(): FieldPart[] {
  const parts: FieldPart[] = [];
  const box = (centre: Vec3, size: Vec3, radius: number, surface: Surface, rotZ?: number) =>
    parts.push({ kind: 'box', centre, size, radius, surface, rotZ });

  // Main floor (30 × 30 m, top at y = 0). The scene draws a lower ground far below, so the rim is a ledge.
  box({ x: 0, y: -0.5, z: 0 }, { x: 30, y: 1, z: 30 }, 0.25, 'walk');

  // 高台, reached by stairs (south) and a ramp (east).
  box(
    { x: (HIGH.minX + HIGH.maxX) / 2, y: HIGH.top / 2, z: (HIGH.minZ + HIGH.maxZ) / 2 },
    { x: HIGH.maxX - HIGH.minX, y: HIGH.top, z: HIGH.maxZ - HIGH.minZ },
    0.08,
    'walk',
  );
  // 段差: six 0.2 m risers with 0.4 m treads.
  for (let i = 0; i < 6; i++) {
    const top = 0.2 * (i + 1);
    box({ x: -7, y: top / 2, z: HIGH.maxZ + 2.2 - 0.4 * i }, { x: 2, y: top, z: 0.4 }, 0.03, 'walk');
  }
  // 斜面: from the platform's east edge down to the floor.
  {
    const angle = (RAMP_DEG * Math.PI) / 180;
    const length = HIGH.top / Math.sin(angle);
    const run = HIGH.top / Math.tan(angle);
    const thickness = 0.2;
    box(
      {
        x: HIGH.maxX + run / 2 - (thickness / 2) * Math.sin(angle),
        y: HIGH.top / 2 - (thickness / 2) * Math.cos(angle),
        z: -6,
      },
      { x: length, y: thickness, z: 2 },
      0.03,
      'walk',
      -angle,
    );
  }
  // 縁: the bridge runs 0.2 m into the platform and 0.3 m into the lookout, so there is no crack at either end.
  {
    const from = BRIDGE.fromZ + 0.2;
    const to = BRIDGE.toZ - 0.3;
    box(
      { x: BRIDGE.x, y: HIGH.top - 0.15, z: (from + to) / 2 },
      { x: BRIDGE.width, y: 0.3, z: from - to },
      0.03,
      'walk',
    );
  }
  parts.push({
    kind: 'cylinder',
    centre: { x: LOOKOUT.x, y: HIGH.top / 2, z: LOOKOUT.z },
    radius: LOOKOUT.radius,
    height: HIGH.top,
    surface: 'walk',
  });

  // 丸い壁: a round pillar and the inside of a curved wall.
  parts.push({
    kind: 'cylinder',
    centre: { x: 4.5, y: 1.6, z: -2.5 },
    radius: 1.2,
    height: 3.2,
    surface: 'wall',
  });
  parts.push({
    kind: 'arcWall',
    centre: { x: 6, y: 0, z: -10 },
    inner: 3.5,
    outer: 3.8,
    height: 2.4,
    from: Math.PI,
    to: 2 * Math.PI,
    surface: 'wall',
  });

  // Step heights side by side: 0.15 and 0.3 m are climbed, 0.45 m is a wall.
  [0.15, 0.3, 0.45].forEach((h, i) => {
    box({ x: 8 + 2.2 * i, y: h / 2, z: 6.5 }, { x: 1.6, y: h, z: 2 }, 0.03, 'walk');
  });
  return parts;
}

/** Adds one collider per part, shaped exactly like the drawn part. */
export function addFieldColliders(
  R: typeof RAPIER,
  world: RAPIER.World,
  parts: readonly FieldPart[],
): RAPIER.Collider[] {
  return parts.map((part) => world.createCollider(colliderDesc(R, part)));
}

function colliderDesc(R: typeof RAPIER, part: FieldPart): RAPIER.ColliderDesc {
  switch (part.kind) {
    case 'box': {
      const { centre: c, size: s, radius: r } = part;
      const a = (part.rotZ ?? 0) / 2;
      return R.ColliderDesc.roundCuboid(s.x / 2 - r, s.y / 2 - r, s.z / 2 - r, r)
        .setTranslation(c.x, c.y, c.z)
        .setRotation({ x: 0, y: 0, z: Math.sin(a), w: Math.cos(a) });
    }
    // Round parts collide as the very triangles that are drawn. (Rapier's analytic cylinder is no good to
    // stand on: about 1 in 80 downward rays and 1 in 2000 sphere casts miss its flat top.)
    case 'cylinder':
    case 'arcWall': {
      const mesh = part.kind === 'cylinder' ? cylinderMesh(part) : arcWallMesh(part);
      const vertices = new Float32Array(mesh.positions.length);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        vertices[i] = (mesh.positions[i] ?? 0) + part.centre.x;
        vertices[i + 1] = (mesh.positions[i + 1] ?? 0) + part.centre.y;
        vertices[i + 2] = (mesh.positions[i + 2] ?? 0) + part.centre.z;
      }
      return R.ColliderDesc.trimesh(
        vertices,
        mesh.indices,
        R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES,
      );
    }
  }
}

export interface MeshData {
  /** Relative to the part's centre. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Closed cylinder (a prism of `segments` sides) with smooth sides and flat caps, centred on the part. */
export function cylinderMesh(part: Extract<FieldPart, { kind: 'cylinder' }>, segments = 64): MeshData {
  const { radius: r, height } = part;
  const half = height / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    return positions.length / 3 - 1;
  };
  const top = vertex(0, half, 0, 0, 1, 0);
  const bottom = vertex(0, -half, 0, 0, -1, 0);
  const ring: { side0: number; side1: number; cap0: number; cap1: number }[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ring.push({
      side0: vertex(c * r, -half, s * r, c, 0, s),
      side1: vertex(c * r, half, s * r, c, 0, s),
      cap0: vertex(c * r, -half, s * r, 0, -1, 0),
      cap1: vertex(c * r, half, s * r, 0, 1, 0),
    });
  }
  for (let i = 0; i < segments; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % segments];
    if (!a || !b) continue;
    // Counter-clockwise seen from outside (angle grows from +X toward +Z, i.e. clockwise seen from above).
    indices.push(a.side0, a.side1, b.side0, b.side0, a.side1, b.side1);
    indices.push(top, b.cap1, a.cap1);
    indices.push(bottom, a.cap0, b.cap0);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

/** Curved wall with thickness (an annular sector), with hard edges between its faces. */
export function arcWallMesh(part: Extract<FieldPart, { kind: 'arcWall' }>, segments = 48): MeshData {
  const { inner, outer, height, from, to } = part;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  type V = [number, number, number];
  const at = (r: number, a: number, y: number): V => [Math.cos(a) * r, y, Math.sin(a) * r];
  const radial =
    (sign: number) =>
    (v: V): V => {
      const len = Math.hypot(v[0], v[2]);
      return [(v[0] / len) * sign, 0, (v[2] / len) * sign];
    };
  const quad = (a: V, b: V, c: V, d: V, normal: V | ((v: V) => V)) => {
    const base = positions.length / 3;
    const n = (v: V) => (typeof normal === 'function' ? normal(v) : normal);
    for (const v of [a, b, c, d]) {
      positions.push(...v);
      normals.push(...n(v));
    }
    // Wind the quad so its front faces along its normal.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      (ab[1] ?? 0) * (ac[2] ?? 0) - (ab[2] ?? 0) * (ac[1] ?? 0),
      (ab[2] ?? 0) * (ac[0] ?? 0) - (ab[0] ?? 0) * (ac[2] ?? 0),
      (ab[0] ?? 0) * (ac[1] ?? 0) - (ab[1] ?? 0) * (ac[0] ?? 0),
    ];
    const na = n(a);
    const front = (cross[0] ?? 0) * na[0] + (cross[1] ?? 0) * na[1] + (cross[2] ?? 0) * na[2] > 0;
    if (front) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  for (let i = 0; i < segments; i++) {
    const s = from + ((to - from) * i) / segments;
    const e = from + ((to - from) * (i + 1)) / segments;
    quad(at(inner, s, 0), at(inner, s, height), at(inner, e, height), at(inner, e, 0), radial(-1));
    quad(at(outer, e, 0), at(outer, e, height), at(outer, s, height), at(outer, s, 0), radial(1));
    quad(at(inner, s, height), at(outer, s, height), at(outer, e, height), at(inner, e, height), [0, 1, 0]);
  }
  // End caps face away from the arc.
  const cap = (a: number, sign: number) =>
    quad(at(inner, a, 0), at(outer, a, 0), at(outer, a, height), at(inner, a, height), [
      -Math.sin(a) * sign,
      0,
      Math.cos(a) * sign,
    ]);
  cap(from, -1);
  cap(to, 1);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
