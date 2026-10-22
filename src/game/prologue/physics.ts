import type RAPIER from '@dimforge/rapier3d-compat';
import {
  activeSegmentIds,
  type FootingSegment,
  type FootingSphere,
  holdsGround,
  type Sphere,
  type Vec3,
} from '../../layers/footing';
import { cutSurfaceIds } from '../../layers/surface';
import { cylinderMesh, type MeshData } from '../player/walk-lab-field';
import {
  FAR,
  GATE,
  LAMP_HEIGHT,
  LAMP_POST_RADIUS,
  LAMPS,
  PATH,
  PEDESTAL_BASE,
  PEDESTAL_RADIUS,
  WORKSHOP_FLOOR_RADIUS,
} from './layout';
import { deckMesh, domeWall } from './shapes';

/**
 * Rapier side of the prologue room (S-03's world, S-02's back-layer footing).
 * Static colliders are made from the same numbers and triangles the scene draws
 * (空間の可読性と導線 4: 当たり判定は見た目に正直に).
 */

/** Height of a walkable slab under the top (y = 0). */
const SLAB = 1;
const ROUND = 0.05;

/** True when (x, y, z) is inside (or on) one of the spheres. */
export function insideAnySphere(x: number, y: number, z: number, spheres: readonly Sphere[]): boolean {
  for (const s of spheres) {
    if (!(s.radius > 0)) continue;
    if (Math.hypot(x - s.center[0], y - s.center[1], z - s.center[2]) <= s.radius) return true;
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
  // The workshop's furniture (the bench, the furnace…) collides as the _col shapes of its glb (S-24, room.ts loads it
  // and src/game/assets adds them): the same artist-made shapes as what is drawn.
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
  private spheres: readonly FootingSphere[] = [];
  private held: readonly FootingSphere[] = [];

  /**
   * @param shape the collision shape of one segment: by default its box; the prologue's arched deck passes
   *   a piece swept from the same curve as the drawn deck (当たり判定は見た目に正直に)
   */
  constructor(
    R: typeof RAPIER,
    private readonly world: RAPIER.World,
    readonly segments: readonly FootingSegment[],
    shape?: (segment: FootingSegment) => MeshData,
  ) {
    for (const s of segments) {
      const desc = shape
        ? trimesh(R, shape(s), [0, 0, 0])
        : R.ColliderDesc.cuboid(
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

  /**
   * Switches the colliders for the current spheres (`activeSegmentIds`) and the fence for the spheres that
   * hold ground (`holdsGround`). A sphere shrinking after a pickup keeps its colliders until it is gone (nobody
   * stands on them: canPickUp refuses that), but is no longer ground to step onto (S-06 P1).
   * Pass the same array while nothing changed (session.spheres() does). Returns whether the colliders changed.
   */
  sync(spheres: readonly FootingSphere[]): boolean {
    if (spheres === this.spheres) return false;
    this.spheres = spheres;
    this.held = spheres.every(holdsGround) ? spheres : spheres.filter(holdsGround);
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

  /** PlayerController.allowGround: back footing is ground only inside the sphere of a placed orb. */
  readonly allowGround = (x: number, y: number, z: number, collider: RAPIER.Collider): boolean =>
    !this.handles.has(collider.handle) || insideAnySphere(x, y, z, this.held);

  dispose(): void {
    for (const c of this.colliders.values()) this.world.removeCollider(c, false);
    this.colliders.clear();
    this.handles.clear();
  }
}

/**
 * Surface-only colliders (S-28; コアメカニクス > 裏の層のルール: 表にしかない壁は消えて通れるようになる): one box per segment
 * (layers/surface splitSurface, SURFACE_SEGMENT), switched off while the segment lies wholly inside the sphere of a
 * placed orb (cutSurfaceIds) and on again the moment that orb is picked up (its sphere then shrinks: no longer held).
 * A segment the sphere's film crosses stays solid: part of it is still drawn (空間の可読性と導線 4: 当たり判定は見た目に正直に).
 * Picking the orb up while the body stands in a cut segment would shut it in; orb/rules canPickUp refuses that, given
 * these segments (session.ts SessionOptions.surface).
 */
export class SurfaceColliders {
  private readonly colliders = new Map<string, RAPIER.Collider>();
  private spheres: readonly FootingSphere[] = [];
  private cut: string[] = [];

  constructor(
    R: typeof RAPIER,
    private readonly world: RAPIER.World,
    readonly segments: readonly FootingSegment[],
  ) {
    for (const s of segments) {
      this.colliders.set(
        s.id,
        world.createCollider(
          R.ColliderDesc.cuboid(
            (s.max[0] - s.min[0]) / 2,
            (s.max[1] - s.min[1]) / 2,
            (s.max[2] - s.min[2]) / 2,
          ).setTranslation((s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2),
        ),
      );
    }
  }

  /** Segments whose collider is cut away now. */
  get cutCount(): number {
    return this.cut.length;
  }

  /** Cut segment ids, in segment order. */
  get cutIds(): readonly string[] {
    return this.cut;
  }

  /**
   * Switches the colliders for the current spheres (the same array as BackFooting.sync gets: session.spheres(), the
   * same until the orbs change). Returns whether any collider changed.
   */
  sync(spheres: readonly FootingSphere[]): boolean {
    if (spheres === this.spheres) return false;
    this.spheres = spheres;
    const next = cutSurfaceIds(this.segments, spheres);
    if (next.length === this.cut.length && next.every((id, i) => id === this.cut[i])) return false;
    const off = new Set(next);
    for (const [id, c] of this.colliders) c.setEnabled(!off.has(id));
    this.cut = next;
    return true;
  }

  dispose(): void {
    for (const c of this.colliders.values()) this.world.removeCollider(c, false);
    this.colliders.clear();
  }
}

/**
 * Last line of 落下死はない: if a body ever drops below the walkways (y < floorY), put it back where it last
 * stood on solid, shared ground (never on back footing, which can vanish).
 */
export class FallGuard {
  private safe: [number, number, number] | null = null;

  constructor(readonly floorY = -1) {}

  observe(feet: Vec3, grounded: boolean, onBackFooting: boolean): void {
    if (!grounded || onBackFooting) return;
    if (this.safe) {
      this.safe[0] = feet[0];
      this.safe[1] = feet[1];
      this.safe[2] = feet[2];
    } else this.safe = [feet[0], feet[1], feet[2]];
  }

  /** Where to put the body back, or null while it is above the floor of the guard (or nothing is known). */
  rescue(feet: Vec3): Vec3 | null {
    return feet[1] < this.floorY && this.safe ? [this.safe[0], this.safe[1], this.safe[2]] : null;
  }
}

/**
 * One footing segment of the arched deck, swept from the same curve as the drawn deck (4 steps per 0.4 m; the
 * drawn deck samples the curve at other points, so the two differ by about a millimetre between samples).
 */
export function deckSegmentShape(segment: FootingSegment): MeshData {
  return deckMesh(segment.max[2], segment.min[2], 4);
}
