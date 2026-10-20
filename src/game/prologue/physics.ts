import type RAPIER from '@dimforge/rapier3d-compat';
import { activeSegmentIds, type FootingSegment, type Sphere, type Vec3 } from '../../layers/footing';
import { cylinderMesh, type MeshData } from '../player/walk-lab-field';
import {
  BENCH,
  FAR,
  FURNACE,
  GATE,
  LAMP_HEIGHT,
  LAMP_POST_RADIUS,
  LAMPS,
  PATH,
  PEDESTAL_BASE,
  PEDESTAL_RADIUS,
  WORKSHOP_FLOOR_RADIUS,
} from './layout';
import { domeWall } from './shapes';

/**
 * Rapier side of the prologue room (S-03's world, S-02's back-layer footing).
 * Static colliders are made from the same numbers and triangles the scene draws
 * (空間の可読性と導線 4: 当たり判定は見た目に正直に).
 */

/** Height of a walkable slab under the top (y = 0). */
const SLAB = 1;
const ROUND = 0.05;

/** True when `p` is inside (or on) one of the spheres. */
export function insideAnySphere(p: Vec3, spheres: readonly Sphere[]): boolean {
  for (const s of spheres) {
    if (!(s.radius > 0)) continue;
    if (Math.hypot(p[0] - s.center[0], p[1] - s.center[1], p[2] - s.center[2]) <= s.radius) return true;
  }
  return false;
}

function trimesh(R: typeof RAPIER, mesh: MeshData, at: Vec3): RAPIER.ColliderDesc {
  const v = new Float32Array(mesh.positions.length);
  for (let i = 0; i < v.length; i += 3) {
    v[i] = (mesh.positions[i] ?? 0) + at[0];
    v[i + 1] = (mesh.positions[i + 1] ?? 0) + at[1];
    v[i + 2] = (mesh.positions[i + 2] ?? 0) + at[2];
  }
  return R.ColliderDesc.trimesh(
    v,
    mesh.indices,
    R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES,
  );
}

/** A slab with its top at y = 0 over an x/z rectangle (rounded edges, like the drawn stone). */
function slab(R: typeof RAPIER, minX: number, maxX: number, minZ: number, maxZ: number): RAPIER.ColliderDesc {
  return R.ColliderDesc.roundCuboid(
    (maxX - minX) / 2 - ROUND,
    SLAB / 2 - ROUND,
    (maxZ - minZ) / 2 - ROUND,
    ROUND,
  ).setTranslation((minX + maxX) / 2, -SLAB / 2, (minZ + maxZ) / 2);
}

/** Every static collider of the room. Round parts collide as the triangles that are drawn. */
export function addRoomColliders(R: typeof RAPIER, world: RAPIER.World): RAPIER.Collider[] {
  const descs: RAPIER.ColliderDesc[] = [];
  // workshop floor (a disc) and its glass dome, open at the door
  const floor = cylinderMesh({
    kind: 'cylinder',
    centre: { x: 0, y: 0, z: 0 },
    radius: WORKSHOP_FLOOR_RADIUS + 0.05,
    height: SLAB,
    surface: 'walk',
  });
  descs.push(trimesh(R, floor, [0, -SLAB / 2, 0]));
  descs.push(trimesh(R, domeWall(), [0, 0, 0]));
  // the workbench and the furnace
  const [bx, , bz] = BENCH.center;
  const [sx, sy, sz] = BENCH.size;
  descs.push(
    R.ColliderDesc.roundCuboid(sx / 2 - 0.03, sy / 2 - 0.03, sz / 2 - 0.03, 0.03).setTranslation(
      bx,
      sy / 2,
      bz,
    ),
  );
  descs.push(R.ColliderDesc.ball(FURNACE.radius).setTranslation(FURNACE.center[0], 0, FURNACE.center[2]));
  // the way, the far shore and the gate that closes it
  descs.push(slab(R, PATH.minX, PATH.maxX, PATH.minZ, PATH.maxZ));
  descs.push(slab(R, FAR.minX, FAR.maxX, FAR.minZ, FAR.maxZ));
  descs.push(
    R.ColliderDesc.cuboid(GATE.halfWidth, GATE.height / 2, GATE.depth / 2).setTranslation(
      0,
      GATE.height / 2,
      GATE.z,
    ),
  );
  // the pedestal and the lamp posts
  const pedestal = cylinderMesh(
    { kind: 'cylinder', centre: { x: 0, y: 0, z: 0 }, radius: PEDESTAL_RADIUS, height: 1, surface: 'wall' },
    24,
  );
  descs.push(trimesh(R, pedestal, [PEDESTAL_BASE[0], 0.5, PEDESTAL_BASE[2]]));
  for (const l of LAMPS) {
    descs.push(
      R.ColliderDesc.capsule(LAMP_HEIGHT / 2, LAMP_POST_RADIUS).setTranslation(l.x, LAMP_HEIGHT / 2, l.z),
    );
  }
  return descs.map((d) => world.createCollider(d));
}

/**
 * S-02's back-layer footing as Rapier colliders (技術設計 > 裏の層の実装 > 当たり判定): one per segment,
 * enabled only while a materialized sphere overlaps it (activeSegmentIds). `allowGround` is the
 * invisible fence for the player (球の縁には見えない柵): a segment that pokes out of a sphere is ground
 * only inside it, so the body eases to a stop at the boundary film and never stands outside it.
 */
export class BackFooting {
  private readonly colliders = new Map<string, RAPIER.Collider>();
  private readonly handles = new Set<number>();
  private active: string[] = [];
  private spheres: readonly Sphere[] = [];

  constructor(
    R: typeof RAPIER,
    private readonly world: RAPIER.World,
    readonly segments: readonly FootingSegment[],
  ) {
    for (const s of segments) {
      const desc = R.ColliderDesc.cuboid(
        (s.max[0] - s.min[0]) / 2,
        (s.max[1] - s.min[1]) / 2,
        (s.max[2] - s.min[2]) / 2,
      ).setTranslation((s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2);
      const c = world.createCollider(desc);
      c.setEnabled(false);
      this.colliders.set(s.id, c);
      this.handles.add(c.handle);
    }
  }

  get activeCount(): number {
    return this.active.length;
  }

  /** Enabled segment ids, in segment order. */
  get activeIds(): readonly string[] {
    return this.active;
  }

  /** Switches the colliders for the current spheres. Returns whether anything changed. */
  sync(spheres: readonly Sphere[]): boolean {
    this.spheres = spheres;
    const next = activeSegmentIds(this.segments, spheres);
    if (next.length === this.active.length && next.every((id, i) => id === this.active[i])) return false;
    const on = new Set(next);
    for (const [id, c] of this.colliders) c.setEnabled(on.has(id));
    this.active = next;
    return true;
  }

  isFooting(collider: RAPIER.Collider): boolean {
    return this.handles.has(collider.handle);
  }

  /** PlayerController.allowGround: back footing is ground only inside a sphere. */
  readonly allowGround = (x: number, y: number, z: number, collider: RAPIER.Collider): boolean =>
    !this.handles.has(collider.handle) || insideAnySphere([x, y, z], this.spheres);

  dispose(): void {
    for (const c of this.colliders.values()) this.world.removeCollider(c, false);
    this.colliders.clear();
    this.handles.clear();
  }
}
