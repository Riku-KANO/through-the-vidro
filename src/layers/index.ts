/**
 * 表と裏の層 (S-02). The surface every scene integrates with:
 *  - LayerField.assign(object, 'surface' | 'back' | 'shared') puts objects on a layer and makes their
 *    node materials obey the materialized spheres; add LayerField.membranes to the scene.
 *  - LayerField.setSpheres() each frame from game/orb's orbSpheres() (+ boundaryGlow()).
 *  - activeSegmentIds() tells the physics which back-layer footing colliders to enable; cutSurfaceIds() which
 *    surface-only colliders to disable (S-28), and segmentsAroundBody() whether a pickup would shut the body in.
 *  - 定着 (S-34): a sweep of light fixes part of the back layer onto the surface for good (settle.ts); the field draws it
 *    (new LayerField({ settle: true }), setSettled()) and settledSegmentIds() tells the colliders what it has fixed.
 */
export { type FieldSphere, LayerField, type SettledView } from './field';
export {
  activeSegmentIds,
  type Box,
  type FootingSegment,
  type FootingSphere,
  holdsGround,
  type Sphere,
  segmentsUnder,
  sphereOverlapsBox,
  splitFooting,
  type Vec3,
} from './footing';
export {
  clipFor,
  drawnIn,
  LAYER_CHANNEL,
  type LayerKind,
  type LayerView,
  layerMask,
  viewMask,
} from './layers';
export {
  boundaryGlow,
  MAIN_ORB_RADIUS,
  MATERIALIZE_SECONDS,
  MAX_SPHERES,
  type Materialization,
  materializedRadius,
  pickUpOrb,
  placeOrb,
  SMALL_ORB_RADIUS,
  stepMaterialization,
} from './materialize';
export {
  along,
  countSettled,
  type SettleSweep,
  segmentsCutByBox,
  settledAt,
  settledSegmentIds,
  sweepFront,
  sweepSpan,
} from './settle';
export {
  type BodyExtent,
  boxInsideSphere,
  cutSurfaceIds,
  SURFACE_SEGMENT,
  segmentsAroundBody,
  splitSurface,
} from './surface';
export { glassEase, stepTween, type Tween } from './tween';
