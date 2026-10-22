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
  GATE_SPRINGS,
  LAMP_HEIGHT,
  LAMP_POST_RADIUS,
  LAMPS,
  LOOKOUT,
  PATH,
  PEDESTAL_BASE,
  PEDESTAL_RADIUS,
  ROAD,
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
/** The gate's posts, as drawn (finale.ts: 6–7 cm). */
const GATE_POST_RADIUS = 0.07;
/** S-34: a leaf of the gate as a thin box, a little taller than the body (BODY_HEIGHT 1.75 m), as thick as the drawn leaf. */
const LEAF_HALF_HEIGHT = 1.0;
const LEAF_HALF_DEPTH = 0.03;

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
  // the way, the far shore and (S-34) the road past the gate, one slab with the shore (no seam to catch on under the
  // gate), ending at the lookout's railing. The gate's posts here; its leaves swing open (GateLeaves).
  descs.push(slab(R, PATH.minX, PATH.maxX, PATH.minZ, PATH.maxZ));
  descs.push(slab(R, FAR.minX, FAR.maxX, ROAD.minZ, FAR.maxZ));
  for (const x of [-GATE.halfWidth, GATE.halfWidth])
    descs.push(
      R.ColliderDesc.capsule(GATE_SPRINGS / 2, GATE_POST_RADIUS).setTranslation(x, GATE_SPRINGS / 2, GATE.z),
    );
  descs.push(
    R.ColliderDesc.cuboid((ROAD.maxX - ROAD.minX) / 2, LOOKOUT.height / 2, LOOKOUT.depth / 2).setTranslation(
      (ROAD.minX + ROAD.maxX) / 2,
      LOOKOUT.height / 2,
      LOOKOUT.z,
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
 * S-34 (定着): segments the drop's light has fixed (`settle`) are on for good and ground anywhere.
 */
export class BackFooting {
  private readonly colliders = new Map<string, RAPIER.Collider>();
  private readonly handles = new Set<number>();
  private active: string[] = [];
  private spheres: readonly FootingSphere[] = [];
  private held: readonly FootingSphere[] = [];
  /** S-34: the segments the light has fixed, and their colliders. */
  private readonly settledIds = new Set<string>();
  private readonly settledHandles = new Set<number>();

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

  /** S-34: how many segments the light has fixed. */
  get settledCount(): number {
    return this.settledIds.size;
  }

  /** S-34: has the light fixed this segment? */
  isSettled(id: string): boolean {
    return this.settledIds.has(id);
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
    return this.apply();
  }

  /**
   * S-34 (定着): fixes these segments for good — on whatever the spheres do, and ground anywhere (the fence is a sphere's,
   * and the settled bridge needs none). Ids already settled are skipped; nothing is ever unsettled. Pass the same array
   * while nothing changed (session.settledFooting() does). Returns whether any collider changed.
   */
  settle(ids: readonly string[]): boolean {
    if (ids === this.lastSettle) return false;
    this.lastSettle = ids;
    let added = false;
    for (const id of ids) {
      const c = this.colliders.get(id);
      if (!c || this.settledIds.has(id)) continue;
      this.settledIds.add(id);
      this.settledHandles.add(c.handle);
      added = true;
    }
    return added ? this.apply() : false;
  }

  private lastSettle: readonly string[] | null = null;

  /** Enables what the spheres overlap and what the light has fixed, in segment order. */
  private apply(): boolean {
    const bySpheres = activeSegmentIds(this.segments, this.spheres);
    const next =
      this.settledIds.size === 0
        ? bySpheres
        : this.segments.filter((s) => this.settledIds.has(s.id) || bySpheres.includes(s.id)).map((s) => s.id);
    if (next.length === this.active.length && next.every((id, i) => id === this.active[i])) return false;
    const on = new Set(next);
    for (const [id, c] of this.colliders) c.setEnabled(on.has(id));
    this.active = next;
    return true;
  }

  isFooting(collider: RAPIER.Collider): boolean {
    return this.handles.has(collider.handle);
  }

  /**
   * PlayerController.allowGround: back footing is ground only inside the sphere of a placed orb — unless the drop's light
   * has fixed it (S-34): then it is ground like the shores.
   */
  readonly allowGround = (x: number, y: number, z: number, collider: RAPIER.Collider): boolean =>
    !this.handles.has(collider.handle) ||
    this.settledHandles.has(collider.handle) ||
    insideAnySphere(x, y, z, this.held);

  dispose(): void {
    for (const c of this.colliders.values()) this.world.removeCollider(c, false);
    this.colliders.clear();
    this.handles.clear();
    this.settledIds.clear();
    this.settledHandles.clear();
  }
}

/**
 * Surface-only colliders (S-28; コアメカニクス > 裏の層のルール: 表にしかない壁は消えて通れるようになる): one box per segment
 * (layers/surface splitSurface, SURFACE_SEGMENT), switched off while the segment lies wholly inside the sphere of a
 * placed orb (cutSurfaceIds) and on again the moment that orb is picked up (its sphere then shrinks: no longer held).
 * A segment the sphere's film crosses stays solid: part of it is still drawn (空間の可読性と導線 4: 当たり判定は見た目に正直に).
 * Picking the orb up while the body stands in a cut segment would shut it in; orb/rules canPickUp refuses that, given
 * these segments (session.ts SessionOptions.surface).
 * S-34 (定着): segments the drop's light has fixed (`settle`) stay cut for good: the back layer is there for good, and the
 * surface-only things in it are no longer drawn.
 */
export class SurfaceColliders {
  private readonly colliders = new Map<string, RAPIER.Collider>();
  private spheres: readonly FootingSphere[] = [];
  private cut: string[] = [];
  private readonly settledIds = new Set<string>();
  private lastSettle: readonly string[] | null = null;

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

  /**
   * Switches the colliders for the current spheres (the same array as BackFooting.sync gets: session.spheres(), the
   * same until the orbs change). Returns whether any collider changed.
   */
  sync(spheres: readonly FootingSphere[]): boolean {
    if (spheres === this.spheres) return false;
    this.spheres = spheres;
    return this.apply();
  }

  /**
   * S-34 (定着): these segments stay cut for good. Ids already settled are skipped. Pass the same array while nothing
   * changed (session.settledSurface() does). Returns whether any collider changed.
   */
  settle(ids: readonly string[]): boolean {
    if (ids === this.lastSettle) return false;
    this.lastSettle = ids;
    let added = false;
    for (const id of ids) {
      if (!this.colliders.has(id) || this.settledIds.has(id)) continue;
      this.settledIds.add(id);
      added = true;
    }
    return added ? this.apply() : false;
  }

  /** Cuts what the placed orbs' spheres hold wholly and what the light has fixed, in segment order. */
  private apply(): boolean {
    const bySpheres = cutSurfaceIds(this.segments, this.spheres);
    const next =
      this.settledIds.size === 0
        ? bySpheres
        : this.segments.filter((s) => this.settledIds.has(s.id) || bySpheres.includes(s.id)).map((s) => s.id);
    if (next.length === this.cut.length && next.every((id, i) => id === this.cut[i])) return false;
    const off = new Set(next);
    for (const [id, c] of this.colliders) c.setEnabled(!off.has(id));
    this.cut = next;
    return true;
  }

  dispose(): void {
    for (const c of this.colliders.values()) this.world.removeCollider(c, false);
    this.colliders.clear();
    this.settledIds.clear();
  }
}

/**
 * S-34: the gate's two leaves as they swing (光が向こう岸に届くと門が開く). Each is a thin box hinged at its post (layout.ts GATE),
 * turned with the drawn leaf (finale.ts, the same angle), so what stops you is what you see (空間の可読性と導線 4). Shut
 * (angle 0) they close the arch between the posts; open they stand along the road's edges, swung away from the far shore.
 * The leaves swing away from the far shore, where you stand, and push nobody (they are not bodies). Getting into a leaf's
 * way as it swings is possible in principle — through the gap in the middle before it is wide open, then sideways — but
 * hardly happens: the gate starts to open as the light reaches the far shore, and by the time anyone has walked to it,
 * it is nearly open (the S-34 review round 2).
 */
export class GateLeaves {
  private readonly leaves: [RAPIER.Collider, RAPIER.Collider];
  private angleValue = Number.NaN;

  constructor(
    R: typeof RAPIER,
    private readonly world: RAPIER.World,
  ) {
    const leaf = (): RAPIER.Collider =>
      world.createCollider(R.ColliderDesc.cuboid(GATE.halfWidth / 2, LEAF_HALF_HEIGHT, LEAF_HALF_DEPTH));
    this.leaves = [leaf(), leaf()];
    this.sync(0);
  }

  /** Radians the leaves have swung from shut. */
  get angle(): number {
    return this.angleValue;
  }

  /** Puts both leaves `angle` radians from shut. Returns whether they moved. */
  /** Reused for every move (the leaves swing every frame for 2.6 s: nothing is allocated). */
  private readonly at = { x: 0, y: LEAF_HALF_HEIGHT, z: 0 };
  private readonly turn = { x: 0, y: 0, z: 0, w: 1 };

  sync(angle: number): boolean {
    if (angle === this.angleValue) return false;
    this.angleValue = angle;
    const hw = GATE.halfWidth;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let i = 0; i < this.leaves.length; i++) {
      const c = this.leaves[i] as RAPIER.Collider;
      const side = i === 0 ? 1 : -1;
      // from its hinge each leaf runs toward the middle, swung by `angle` away from the far shore (toward -Z): the unit
      // (dx, dz) of layout.ts gateLeafDirection
      const dx = -side * cos;
      const dz = -sin;
      this.at.x = side * hw + (dx * hw) / 2;
      this.at.z = GATE.z + (dz * hw) / 2;
      c.setTranslation(this.at);
      // the turn about +Y that takes the box's +X onto (dx, 0, dz)
      const yaw = Math.atan2(-dz, dx);
      this.turn.y = Math.sin(yaw / 2);
      this.turn.w = Math.cos(yaw / 2);
      c.setRotation(this.turn);
    }
    return true;
  }

  dispose(): void {
    for (const c of this.leaves) this.world.removeCollider(c, false);
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
