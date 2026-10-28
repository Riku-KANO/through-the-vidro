import type { DiveWorld } from '../../game/dive-world';

/**
 * What a game world offers the pause (S-42). The prologue room has it (src/game/prologue/room.ts); S-04's placeholder city
 * has not, and keeps its sandbox Esc (the dive played back). The world does not know the pause: it only says when its input
 * asked for it, and lets its time and input be held.
 */
export interface PausableWorld {
  /** The world's input asks for the pause (操作とカメラ > 入力の割り当て: Esc, the mouse let go, Start). Returns the unsubscribe. */
  onPauseRequest(listener: () => void): () => void;
  /** The game's time speed, 0..1: the body, the orb, the light's sweeps and the ambient motion run at it. */
  setTimeScale(scale: number): void;
  /** Holds the player's input back (and lets the mouse go) while the pause is up. */
  setHeld(held: boolean): void;
  /** Asks for the mouse lock again: call it inside the click or key handler that resumes. */
  relock(): void;
}

/** The pause's port of a world that has one, else null. */
export function pausableOf(world: DiveWorld): PausableWorld | null {
  const w = world as DiveWorld & Partial<PausableWorld>;
  return typeof w.onPauseRequest === 'function' &&
    typeof w.setTimeScale === 'function' &&
    typeof w.setHeld === 'function' &&
    typeof w.relock === 'function'
    ? (w as DiveWorld & PausableWorld)
    : null;
}
