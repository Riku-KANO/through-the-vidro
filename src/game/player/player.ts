import RAPIER from '@dimforge/rapier3d-compat';
import {
  BODY_HEIGHT,
  BODY_RADIUS,
  EYE_HEIGHT,
  FOV_DEFAULT,
  GRAVITY,
  GROUND_PROBE_RADIUS,
  MAX_FALL_SPEED,
  MAX_SLOPE_DEG,
  SKIN,
  SLIDE_SLOPE_DEG,
  SNAP_TO_GROUND,
  SPRINT_SPEED,
  STEP_HEIGHT,
  STEP_MIN_WIDTH,
  WALK_SPEED,
} from './constants';
import { findLedges, type GroundProbe, LEDGE_DEFAULTS, type Ledge, limitVelocityAtLedges } from './ledge';
import {
  approachVelocity,
  clampFov,
  clampPitch,
  combineModifiers,
  followEye,
  footfallsBy,
  headBobOffset,
  type MovementModifier,
  type PlanarVelocity,
  type Vec2,
  wishVelocity,
} from './motion';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What the input layer asks of the body this frame. Look values are deltas in radians. */
export interface PlayerIntent {
  /** y = forward, x = right, length ≤ 1. */
  move: Vec2;
  sprint: boolean;
  lookYaw: number;
  lookPitch: number;
}

/** Player-facing settings (操作とカメラ > カメラ, 3D酔い対策). */
export interface PlayerSettings {
  /** Vertical field of view, clamped to 60..100. */
  fovDeg: number;
  /** Walking bob strength: 0 = off, 1 = the default (already very weak). */
  headBob: number;
}

export const DEFAULT_PLAYER_SETTINGS: Readonly<PlayerSettings> = Object.freeze({
  fovDeg: FOV_DEFAULT,
  headBob: 1,
});

export interface PlayerOptions {
  /** Where the feet stand. */
  feet: Vec3;
  yaw?: number;
  pitch?: number;
  settings?: Partial<PlayerSettings>;
  /**
   * Extra say over what the body collides with and stands on. S-02 uses this to ignore back-layer
   * colliders outside the materialised spheres. Sensors are always ignored.
   */
  filter?: (collider: RAPIER.Collider) => boolean;
  /**
   * Extra say over where ground counts as ground, per point (S-06: back-layer footing only inside a
   * materialized sphere, the invisible fence at its boundary). Refused ground reads as no ground: the
   * body eases to a stop before it like at any edge and never steps onto it.
   */
  allowGround?: (x: number, y: number, z: number, collider: RAPIER.Collider) => boolean;
}

/** The subset of a three.js PerspectiveCamera the player drives (keeps this module free of three). */
export interface CameraLike {
  position: { set(x: number, y: number, z: number): unknown };
  rotation: { set(x: number, y: number, z: number, order?: 'YXZ'): unknown };
  fov: number;
  updateProjectionMatrix(): void;
}

const MAX_SUBSTEP = 1 / 60;
const HALF_HEIGHT = BODY_HEIGHT / 2;
const FILTER = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
const LEDGES = Object.freeze({ ...LEDGE_DEFAULTS, probeRadius: GROUND_PROBE_RADIUS });
/** How far the feet may dip below the probed ground before they are put back on it (inside the skin). */
const SINK_TOLERANCE = 0.01;

/**
 * First-person body on Rapier's kinematic character controller.
 * Walks at 1.4 m/s (Shift 2.2 m/s) with short inertia, climbs steps, slides along round walls,
 * and eases to a stop at ledges instead of falling (落下死はない).
 *
 * Integration port for S-02: `modifiers.set('peek', { ...PEEK_MODIFIER, weight })` slows the body and
 * narrows the view; delete the key when done.
 */
export class PlayerController {
  /** Named temporary changes to speed and field of view, e.g. 'peek' (S-02). */
  readonly modifiers = new Map<string, MovementModifier>();
  /** Radians; 0 looks down -Z, positive turns left. */
  yaw: number;
  /** Radians; positive looks up. */
  pitch: number;

  private settingsValue: PlayerSettings;
  private readonly collider: RAPIER.Collider;
  private readonly kcc: RAPIER.KinematicCharacterController;
  private readonly filter?: (collider: RAPIER.Collider) => boolean;
  private readonly allowGround?: PlayerOptions['allowGround'];
  private vel: PlanarVelocity = { x: 0, z: 0 };
  private vy = 0;
  /** What the body actually did last step (after collisions), for probes and the walking bob. */
  private moved: Vec3 = { x: 0, y: 0, z: 0 };
  private groundY: number;
  private groundedValue = false;
  private eyeBase: number;
  private distanceWalked = 0;
  private ledgesValue: Ledge[] = [];
  private readonly probe: GroundProbe;

  constructor(
    private readonly world: RAPIER.World,
    opts: PlayerOptions,
  ) {
    this.yaw = opts.yaw ?? 0;
    this.pitch = clampPitch(opts.pitch ?? 0);
    this.settingsValue = sanitize({ ...DEFAULT_PLAYER_SETTINGS, ...opts.settings });
    this.filter = opts.filter;
    this.allowGround = opts.allowGround;

    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(HALF_HEIGHT - BODY_RADIUS, BODY_RADIUS).setTranslation(
        opts.feet.x,
        opts.feet.y + SKIN + HALF_HEIGHT,
        opts.feet.z,
      ),
    );
    this.kcc = world.createCharacterController(SKIN);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setSlideEnabled(true);
    this.kcc.enableAutostep(STEP_HEIGHT, STEP_MIN_WIDTH, false);
    this.kcc.enableSnapToGround(SNAP_TO_GROUND);
    this.kcc.setMaxSlopeClimbAngle((MAX_SLOPE_DEG * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((SLIDE_SLOPE_DEG * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
    this.eyeBase = opts.feet.y + EYE_HEIGHT;
    this.groundY = opts.feet.y;

    // A ray first, a small sphere where the ray finds nothing (only when asked for a fat probe). Rays slip
    // through the seam between two floor pieces and, now and then, past the start of a rounded edge; sphere
    // casts miss rarely too, but never at the same spots (measured on round cuboids).
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const ball = new RAPIER.Ball(GROUND_PROBE_RADIUS);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    this.probe = (x, z, fromY, depth, fat) => {
      ray.origin.x = x;
      ray.origin.y = fromY;
      ray.origin.z = z;
      const w = this.world;
      const hit = w.castRayAndGetNormal(
        ray,
        depth,
        true,
        FILTER,
        undefined,
        this.collider,
        undefined,
        this.filter,
      );
      if (hit) {
        // Starting inside something (a wall) reads as ground at the start height.
        const y = hit.timeOfImpact <= 1e-6 ? fromY : fromY - hit.timeOfImpact;
        // Ground the owner refuses here (S-06: back footing outside the spheres) is no ground at all.
        if (this.allowGround && !this.allowGround(x, y, z, hit.collider)) return null;
        return { y, ny: hit.timeOfImpact <= 1e-6 ? 1 : Math.abs(hit.normal.y), fat: false };
      }
      if (!fat) return null;
      const cast = w.castShape(
        ray.origin,
        rotation,
        ray.dir,
        ball,
        0,
        depth - GROUND_PROBE_RADIUS,
        true,
        FILTER,
        undefined,
        this.collider,
        undefined,
        this.filter,
      );
      if (!cast) return null;
      const inside = cast.time_of_impact <= 1e-6;
      const y = inside ? fromY : fromY - cast.time_of_impact - GROUND_PROBE_RADIUS;
      if (this.allowGround && !this.allowGround(x, y, z, cast.collider)) return null;
      return { y, ny: inside ? 1 : Math.abs(cast.normal1.y), fat: true };
    };
  }

  get settings(): Readonly<PlayerSettings> {
    return this.settingsValue;
  }

  set settings(value: Partial<PlayerSettings>) {
    this.settingsValue = sanitize({ ...this.settingsValue, ...value });
  }

  /** Feet position (where the body touches the ground). */
  get feet(): Vec3 {
    const c = this.collider.translation();
    return { x: c.x, y: c.y - HALF_HEIGHT - SKIN, z: c.z };
  }

  /** Actual velocity after collisions (m/s). */
  get velocity(): Vec3 {
    return { ...this.moved };
  }

  get grounded(): boolean {
    return this.groundedValue;
  }

  /** Metres walked on the ground so far (horizontal, only while standing; falls and teleports do not count). */
  get walked(): number {
    return this.distanceWalked;
  }

  /** Footfalls so far (S-22): it goes up by one the moment a foot comes down (motion.ts footfallsBy). */
  get footfalls(): number {
    return footfallsBy(this.distanceWalked);
  }

  /** Edges currently slowing the body (for debugging and probes). */
  get ledges(): readonly Ledge[] {
    return this.ledgesValue;
  }

  get eye(): Vec3 {
    const f = this.feet;
    const speed = Math.hypot(this.moved.x, this.moved.z);
    const bob = this.groundedValue
      ? headBobOffset(this.distanceWalked, speed / WALK_SPEED, this.settingsValue.headBob)
      : 0;
    return { x: f.x, y: this.eyeBase + bob, z: f.z };
  }

  /** Effective vertical field of view: the setting plus modifiers (覗く -6度). */
  get fovDeg(): number {
    return this.settingsValue.fovDeg + combineModifiers(this.modifiers.values()).fovOffsetDeg;
  }

  teleport(feet: Vec3, yaw = this.yaw, pitch = this.pitch): void {
    this.collider.setTranslation({ x: feet.x, y: feet.y + SKIN + HALF_HEIGHT, z: feet.z });
    this.yaw = yaw;
    this.pitch = clampPitch(pitch);
    this.vel = { x: 0, z: 0 };
    this.vy = 0;
    this.moved = { x: 0, y: 0, z: 0 };
    // Wherever it lands, the body has to find its footing again (it may have been put in the air).
    this.groundedValue = false;
    this.ledgesValue = [];
    this.groundY = feet.y;
    this.eyeBase = feet.y + EYE_HEIGHT;
  }

  /** Advances the body. The owner steps the Rapier world once per frame before calling this. */
  update(dt: number, intent: PlayerIntent): void {
    this.yaw += intent.lookYaw;
    this.pitch = clampPitch(this.pitch + intent.lookPitch);
    if (dt <= 0) return;
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-6));
    for (let i = 0; i < steps; i++) this.step(dt / steps, intent);

    // Measured from the ground under the body rather than the capsule, which floats in the controller's
    // skin by a few millimetres.
    const target = this.groundY + EYE_HEIGHT;
    this.eyeBase = this.groundedValue ? followEye(this.eyeBase, target, dt) : target;
  }

  applyToCamera(camera: CameraLike): void {
    const eye = this.eye;
    camera.position.set(eye.x, eye.y, eye.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    const fov = this.fovDeg;
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.world.removeCharacterController(this.kcc);
    this.world.removeCollider(this.collider, false);
  }

  /** Ground height under a body centre (collider position), or null over a drop. */
  private groundUnder(centre: Vec3): { y: number; inside: boolean } | null {
    const { probeUp, stepDown } = LEDGES;
    const from = centre.y - HALF_HEIGHT - SKIN + probeUp;
    const s = this.probe(centre.x, centre.z, from, probeUp + stepDown, true);
    return s && { y: s.y, inside: s.y >= from - 1e-6 };
  }

  private step(h: number, intent: PlayerIntent): void {
    const { speedMultiplier } = combineModifiers(this.modifiers.values());
    const speed = (intent.sprint ? SPRINT_SPEED : WALK_SPEED) * speedMultiplier;
    let v = approachVelocity(this.vel, wishVelocity(intent.move, this.yaw, speed), h);

    const pos = this.collider.translation();
    // Ground under the body now; null means it is (or is about to be) in the air.
    const groundHere = this.groundUnder(pos);
    this.ledgesValue = [];
    if (this.groundedValue && groundHere !== null) {
      this.ledgesValue = findLedges(pos.x, pos.z, groundHere.y, this.probe, LEDGES);
      v = limitVelocityAtLedges(v, this.ledgesValue, LEDGES);
    }

    // No push down while grounded: snap-to-ground keeps the feet on the floor, and a push would sink the
    // capsule into its skin far enough to catch on the foot of walls (where a pillar meets the floor).
    this.vy = this.groundedValue ? 0 : Math.max(-MAX_FALL_SPEED, this.vy - GRAVITY * h);
    const desired = { x: v.x * h, y: this.vy * h, z: v.z * h };
    this.kcc.computeColliderMovement(this.collider, desired, FILTER, undefined, this.filter);
    const m = this.kcc.computedMovement();
    let next = { x: pos.x + m.x, y: pos.y + m.y, z: pos.z + m.z };
    let kccGrounded = this.kcc.computedGrounded();

    // Rapier's slide now and then stops a step short against a wall (a one-frame stutter while flowing
    // around a round pillar). Re-run once with what is missing along the walls; the part pointing into a
    // wall is dropped, so this never adds speed.
    const rest = { x: desired.x - m.x, z: desired.z - m.z };
    for (let i = 0; i < this.kcc.numComputedCollisions(); i++) {
      const n = this.kcc.computedCollision(i)?.normal1;
      const len = n ? Math.hypot(n.x, n.z) : 0;
      if (!n || len < 0.5) continue; // ground contact, not a wall
      const into = (rest.x * n.x + rest.z * n.z) / len;
      if (into < 0) {
        rest.x -= (into * n.x) / len;
        rest.z -= (into * n.z) / len;
      }
    }
    if (Math.hypot(rest.x, rest.z) > 0.1 * Math.hypot(desired.x, desired.z) + 1e-6) {
      this.collider.setTranslation(next);
      this.kcc.computeColliderMovement(
        this.collider,
        { x: rest.x, y: 0, z: rest.z },
        FILTER,
        undefined,
        this.filter,
      );
      const m2 = this.kcc.computedMovement();
      next = { x: next.x + m2.x, y: next.y + m2.y, z: next.z + m2.z };
      kccGrounded ||= this.kcc.computedGrounded();
    }

    // Safety net behind the soft edges: a body standing on ground never moves onto a spot with no ground
    // under it (e.g. a wall slide that leads over an edge). A body with no ground under it falls instead.
    let ground = this.groundUnder(next);
    let held = false;
    if (this.groundedValue && ground === null && groundHere !== null) {
      next = { x: pos.x, y: pos.y, z: pos.z };
      v = { x: 0, z: 0 };
      held = true;
      ground = this.groundUnder(next);
    }
    // Rapier's snap-to-ground now and then pushes a grounded body down into the floor (seen when crossing
    // the middle of a box collider). The feet never go below the ground under the body.
    // (Not when the probe starts inside something, e.g. footing that appeared around the body: that would
    // throw the view up; and never more than a snap distance.)
    const sunk = ground && !ground.inside ? ground.y - (next.y - HALF_HEIGHT - SKIN) : 0;
    if (this.groundedValue && ground && sunk > SINK_TOLERANCE && sunk <= SNAP_TO_GROUND) {
      next = { x: next.x, y: ground.y + SKIN + HALF_HEIGHT, z: next.z };
    }

    this.collider.setTranslation(next);
    const grounded = held || kccGrounded;
    if (grounded) this.vy = 0;
    if (this.groundedValue && grounded) this.distanceWalked += Math.hypot(next.x - pos.x, next.z - pos.z);
    this.groundedValue = grounded;
    // Inertia keeps the intended velocity, not the collided one: feeding collisions back makes the
    // capsule stall on every stair riser (it climbs the riser edge like a slope).
    this.vel = v;
    this.moved = { x: (next.x - pos.x) / h, y: (next.y - pos.y) / h, z: (next.z - pos.z) / h };
    this.groundY = grounded && ground && !ground.inside ? ground.y : next.y - HALF_HEIGHT - SKIN;
  }
}

function sanitize(s: PlayerSettings): PlayerSettings {
  return {
    fovDeg: clampFov(s.fovDeg),
    headBob: Number.isFinite(s.headBob) ? Math.min(1, Math.max(0, s.headBob)) : 1,
  };
}
