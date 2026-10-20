import type { AudioState } from './audio-gate';
import type { Screen } from './flow';
import type { HomeItem } from './home/menu-logic';

/** Phases the home-dive scene measures separately (screens and the transitions between them). */
export type PhaseName = Screen | 'loading-home' | 'home-game';

export interface PhaseStats {
  frames: number;
  maxFrameMs: number;
  maxDrawCalls: number;
  maxTriangles: number;
}

/**
 * What the home-dive scene publishes on window.__vidro.sceneProbe (read by tests/e2e/S-04-*.spec.ts).
 * `release` is the only field a test writes: it lets an autoplay checkpoint pause continue.
 */
export interface HomeDiveProbe {
  screen: Screen;
  transition: {
    id: string;
    seconds: number;
    elapsed: number;
    progress: number;
    value: number;
    direction: 1 | -1;
    holding: boolean;
  } | null;
  load: {
    progress: number;
    fill: number;
    ready: boolean;
    seconds: number;
    /** Each loading step: how long it took and the longest frame while it ran (stalls show here). */
    steps: { name: string; seconds: number; maxFrameMs: number }[];
  };
  audio: AudioState;
  focused: HomeItem | null;
  hovered: HomeItem | null;
  selected: HomeItem | null;
  tilt: { x: number; y: number };
  tiltMax: number;
  dive: { cameraDistance: number; fullscreen: number; distortion: number; inner: number };
  paused: { id: string; at: number } | null;
  release: boolean;
  phases: Partial<Record<PhaseName, PhaseStats>>;
}
