/**
 * エリアの仕組み (S-36): rooms declared as data (pedestals, a light drop, surface-only walls, back-layer footing, a sweep of
 * settling light) and the drops taken, counted by area. game/prologue/session.ts plays them; the room draws and collides
 * them from the same declarations.
 */
export {
  type AreaDecl,
  type AreaGateDecl,
  checkAreas,
  type DropDecl,
  dropsOf,
  type FootingDecl,
  footingOf,
  type PedestalDecl,
  type PlacedDrop,
  pedestalList,
  pedestalsOf,
  type RoomDecl,
  roomOfDrop,
  type ShortcutDecl,
  type SurfaceDecl,
  surfaceOf,
  surfaceSegments,
  surfaceWallsOf,
} from './area';
export { type AreaCount, type DropState, DropTally } from './drops';
export { gateInto, nextRoom, roomOpen } from './order';
