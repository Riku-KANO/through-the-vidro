import { acceptsEscape, glassEaseInverse, Transition, type TransitionSpec } from '../core/transition';
import type { HomeItem } from './home/menu-logic';

export type Screen = 'loading' | 'home' | 'game';

/** トランジション設計 > 遷移の一覧 */
export const TRANSITIONS = {
  /** 器が光で満ちて溢れ、霧が晴れ、奥からガラス玉が浮かび上がる */
  loadingToHome: { id: 'loading-home', seconds: 1.5 },
  /** カメラが玉へ近づき、表面を通り抜け、そのまま工房の中に立っている */
  homeToGame: { id: 'home-game', seconds: 2.0 },
} as const satisfies Record<string, TransitionSpec>;

/**
 * 遷移のルール 2: if the game is not ready the dive waits at this pose on the curve — the orb is large
 * and the game camera looks straight down onto the workshop dome, well before the hand-over to the
 * full screen and the crossing. (The scene must keep drawing the orb's image while it waits.)
 */
export const DIVE_HOLD_POSE = 0.5;
const DIVE_HOLD_AT = glassEaseInverse(DIVE_HOLD_POSE);

interface Route {
  from: Screen;
  to: Screen;
}

/**
 * Screen state machine for loading → home → game. Pure logic, no DOM or GPU.
 * While a transition plays, only Esc gets through (遷移のルール 4), and Esc plays it back.
 */
export class ScreenFlow {
  private current: Screen = 'loading';
  private active: Transition | null = null;
  private route: Route | null = null;
  private loaded = false;
  private gameReady = true;

  get screen(): Screen {
    return this.current;
  }

  get transition(): Transition | null {
    return this.active;
  }

  /** Where the active transition goes when played forward. */
  get target(): Screen | null {
    return this.route?.to ?? null;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  markLoaded(): void {
    this.loaded = true;
  }

  setGameReady(ready: boolean): void {
    this.gameReady = ready;
  }

  /** The loading screen's 「はじめる」. */
  start(): boolean {
    if (this.active || this.current !== 'loading' || !this.loaded) return false;
    this.begin(new Transition(TRANSITIONS.loadingToHome), { from: 'loading', to: 'home' });
    return true;
  }

  /** A drop chosen on the home screen. Only 「はじめる」 leads anywhere in M0. */
  select(item: HomeItem): boolean {
    if (this.active || this.current !== 'home' || item !== 'start') return false;
    const dive = new Transition(TRANSITIONS.homeToGame, {
      holdAt: DIVE_HOLD_AT,
      isReady: () => this.gameReady,
    });
    this.begin(dive, { from: 'home', to: 'game' });
    return true;
  }

  /**
   * Esc: plays the active transition back to where it came from. Pressing it again (or holding it)
   * keeps going back; it never turns forward again. No-op without a transition.
   */
  escape(): boolean {
    if (!this.active || !acceptsEscape(this.active.spec) || this.active.direction === -1) return false;
    this.active.reverse();
    return true;
  }

  /**
   * Sandbox only: play the dive backwards from inside the game to home.
   * In the real game Esc in play opens the pause screen instead.
   */
  rewindFromGame(): boolean {
    if (this.active || this.current !== 'game') return false;
    this.begin(new Transition(TRANSITIONS.homeToGame, { startAtEnd: true }), { from: 'home', to: 'game' });
    return true;
  }

  update(dt: number): void {
    const t = this.active;
    const route = this.route;
    if (!t || !route) return;
    t.update(dt);
    const done = t.finished;
    if (done === 'forward') this.end(route.to);
    else if (done === 'reversed') this.end(route.from);
  }

  private begin(t: Transition, route: Route): void {
    this.active = t;
    this.route = route;
  }

  private end(screen: Screen): void {
    this.current = screen;
    this.active = null;
    this.route = null;
  }
}
