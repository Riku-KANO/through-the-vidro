/**
 * 手の玉 (S-02). What the player (S-03) and the prologue room (S-06) plug into:
 *  - stepPeek() with the input layer's peek state and canPeek(); peekAmount() drives everything else.
 *  - peekMoveSpeedMultiplier(amount) → walking speed (0.5 at full peek), peekFovOffset(amount) → FOV (-6°).
 *  - placeOn / takeBack / stepOrbs with canPlace / canPickUp; orbSpheres() feeds LayerField.setSpheres().
 *  - PeekPipeline replaces renderer.render(): back image while peeking + the hand-orb composite.
 */
export { HAND_ORB_RADIUS, handOrbCenter, orbScreenCircle, type ScreenCircle } from './hand-pose';
export { OrbComposite, type OrbCompositeInputs, type OrbFrame } from './orb-composite';
export {
  createOrbs,
  MAX_SMALL_ORBS,
  type Orb,
  type OrbKind,
  type OrbSphere,
  orbById,
  orbRadius,
  orbSpheres,
  pedestalOccupied,
  placeOn,
  settle,
  stepOrbs,
  takeBack,
} from './orbs';
export {
  PEEK_FOV_DELTA_DEG,
  PEEK_MOVE_SPEED_FACTOR,
  PEEK_SECONDS,
  type PeekInput,
  type PeekState,
  peekAmount,
  peekFovOffset,
  peekMoveSpeedMultiplier,
  stepPeek,
} from './peek';
export { type PeekFrame, PeekPipeline, type PeekPipelineOptions } from './peek-pipeline';
export { canPeek, canPickUp, canPlace, type PickUpContext } from './rules';
