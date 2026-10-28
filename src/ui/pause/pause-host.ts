import {
  loadPauseBank,
  type PauseBank,
  type PauseCue,
  PauseMix,
  playPauseCue,
  tickRate,
} from '../../audio/pause';
import { duckStage } from '../../core/audio/engine';
import { midiToHz } from '../../core/audio/scale';
import { readFirstPad } from '../../game/input/gamepad';
import type { AudioGate } from '../audio-gate';
import { TRANSITIONS } from '../flow';
import type { StringKey } from '../lang';
import {
  ESC_ECHO_MS,
  focusedItem,
  itemsOf,
  keyCommand,
  MENU_START,
  PAUSE_SECONDS,
  type PauseChoice,
  type PauseCommand,
  type PauseMenu,
  type PausePage,
  type PausePhase,
  type PauseStep,
  PauseTimeline,
  padCommands,
  pickItem,
  stepMenu,
} from './pause-logic';
import { PauseScreen, type PauseView } from './pause-screen';
import type { PausableWorld } from './port';

/**
 * ポーズ (S-42), played over a world that has the pause's port (port.ts) — the prologue room inside the home → dive host
 * (src/ui/home/dive-host.ts), which calls `update` every frame before the world's, asks `holdsFrame` before drawing the
 * world, and starts the dive back to the home when the pause leaves for the title.
 *  - opens when the world's input asks (Esc, the mouse let go, Start) in play: the game's time slows to a stop on the glass
 *    curve while the frost spreads, the input is held, the items are written (pause-logic.ts PauseTimeline)
 *  - the items by keyboard (its own keys: the world's input is held), mouse (the DOM, pause-screen.ts) and pad (polled
 *    here: 十字・A・B・Start)
 *  - its sounds on the page's one engine (AudioGate: S-18), and the game's ambience turned down (src/audio/pause.ts)
 *  - while the time stands and its picture is drawn, the world need not be drawn again (止まった画面を保ったまま描画を止める)
 */

/** window.__vidro.sceneProbe.pause (tests/e2e/S-42-*.spec.ts). `hold` and `ask` are the only things a test writes or calls. */
export interface PauseProbe {
  phase: PausePhase;
  page: PausePage;
  focused: PauseChoice | null;
  hovered: PauseChoice | null;
  frost: number;
  writing: number;
  timeScale: number;
  /** How many times it opened, closed (つづける / Esc / B / Start), left for the title. */
  opened: number;
  closed: number;
  left: number;
  /** performance.now() of the last request, and of the first frame that showed the frost answering it. */
  requestedAt: number | null;
  respondedAt: number | null;
  /** The cues asked for (the latest 40): when, and whether a voice started (no audio before 「はじめる」, or under autoplay). */
  sounds: { cue: string; at: number; rang: boolean }[];
  /** Frames the world was not drawn because the pause held its picture, and world draws while the time stood. */
  heldFrames: number;
  drawnWhileHeld: number;
  /** The longest frame (ms) while opening, open, and clearing (closing or leaving). */
  frameMs: { opening: number; open: number; closing: number };
  /** How far the game's sounds are turned down for the pause (0..1), and faded out for the home after タイトルへ (0..1). */
  ducked: number;
  away: number;
  /** Dev hold (screenshots): stands the opening at this many seconds in; null lets it go on. */
  hold: number | null;
  /** The settings are open over the pause (S-43): its keys and pad are the panel's. */
  yielded: boolean;
  /** Asks for the pause as the world's input would (tests: the autopilot holds the input). */
  ask(): void;
}

export interface PauseHostOptions {
  /** The UI root (src/ui/styles.ts createUiRoot): its font, colour and size. */
  root: HTMLElement;
  t: (k: StringKey) => string;
  gate: AudioGate;
  world: PausableWorld;
  /** タイトルへ → はい: start the dive back to the home. False if it cannot start now. */
  leave(): boolean;
  /**
   * 設定 (S-43): open the settings over the pause. The pause steps aside (its keys and pad are the panel's) until
   * `settingsClosed()`. Without it the item does nothing.
   */
  openSettings?(): void;
}

const MAX_SOUNDS = 40;
const NO_BUTTONS: ReadonlySet<string> = new Set();
/** The fallback ping (before the pause's sounds are made): the item tick's D5. */
const TICK_HZ = midiToHz(74);

export class PauseHost {
  readonly probe: PauseProbe;
  private readonly timeline = new PauseTimeline();
  private readonly screen: PauseScreen;
  private readonly gate: AudioGate;
  private readonly world: PausableWorld;
  private readonly leaveGame: () => boolean;
  private readonly openSettings: (() => void) | null;
  /** The settings are open over the pause. */
  private yielded = false;
  /** Closing straight from the settings (a second Esc / B): it stays stepped aside until it has cleared. */
  private stepAsideOut = false;
  private menu: PauseMenu = MENU_START;
  private playing = false;
  private asked = false;
  private held = false;
  private away = false;
  private awayAmount = 0;
  private frozen = false;
  private frozenDrawn = false;
  private needsFrame = false;
  private focusPending = false;
  private padHeld: ReadonlySet<string> = NO_BUTTONS;
  private readonly view: PauseView = {
    up: false,
    frost: 0,
    writing: 0,
    page: 'menu',
    focused: null,
    interactive: false,
    yielded: false,
  };
  private lastNow = performance.now();
  private mix: PauseMix | null = null;
  private bank: PauseBank = {};
  private readonly abort = new AbortController();
  private readonly offRequest: () => void;
  private readonly offReady: () => void;

  constructor(opts: PauseHostOptions) {
    this.gate = opts.gate;
    this.world = opts.world;
    this.leaveGame = opts.leave;
    this.openSettings = opts.openSettings ?? null;
    this.screen = new PauseScreen(opts.root, opts.t, {
      onHover: (item) => {
        this.ring('tick', { rate: tickRate(this.indexOf(item)), gain: 0.8 });
        if (focusedItem(this.menu) !== item) this.setFocus(item);
      },
      onPick: (item) => this.apply(pickItem(this.menu, item), true),
      onFocus: (item) => {
        // the browser moved the focus (Tab): follow it, with the item's sound
        if (focusedItem(this.menu) === item) return;
        this.setFocus(item);
        this.ring('tick', { rate: tickRate(this.indexOf(item)) });
      },
    });
    const host = this;
    this.probe = {
      phase: 'closed',
      page: 'menu',
      focused: null,
      hovered: null,
      frost: 0,
      writing: 0,
      timeScale: 1,
      opened: 0,
      closed: 0,
      left: 0,
      requestedAt: null,
      respondedAt: null,
      sounds: [],
      heldFrames: 0,
      drawnWhileHeld: 0,
      frameMs: { opening: 0, open: 0, closing: 0 },
      ducked: 0,
      away: 0,
      hold: null,
      yielded: false,
      ask() {
        host.request();
      },
    };
    this.offRequest = this.world.onPauseRequest(() => this.request());
    this.offReady = this.gate.whenReady((engine) => {
      // the turn-down on a duck stage of its own (core/audio): the settings may move the player's sliders meanwhile (S-43)
      this.mix = new PauseMix(duckStage(engine, 'pause'));
      loadPauseBank(engine.ctx, this.abort.signal).then(
        (bank) => {
          this.bank = bank;
        },
        () => undefined,
      );
    });
    window.addEventListener('keydown', this.onKey);
  }

  /**
   * Whether the world's picture can be left as it is this frame: the time stands, its picture was drawn, and nothing
   * (a new render scale) cleared it since.
   */
  get holdsFrame(): boolean {
    return this.frozen && this.frozenDrawn && !this.needsFrame;
  }

  /** The host drew the world this frame (true) or left the held picture (false). */
  frameDrawn(drawn: boolean): void {
    if (!drawn) {
      this.probe.heldFrames++;
      return;
    }
    if (!this.frozen) return;
    this.frozenDrawn = true;
    this.needsFrame = false;
    this.probe.drawnWhileHeld++;
  }

  /** The canvas changed size (a resize, the render scale): the held picture must be drawn once more. */
  resize(width: number, height: number): void {
    this.needsFrame = true;
    this.screen.resize(width, height);
  }

  /** Something in the picture changed (a setting: the field of view, the quality): the held picture is drawn once more. */
  redraw(): void {
    this.needsFrame = true;
  }

  /** The time stands under the pause (the shell gives no GPU time to its governor then: S-43). */
  get still(): boolean {
    return this.frozen;
  }

  /** The settings opened from the pause have closed: the items are written again, on 設定 (来たときの動きの逆再生). */
  settingsClosed(back = false): void {
    if (!this.yielded) return;
    this.yielded = false;
    // the button that closed them (B) is held now: not a new press for the pause
    this.padHeld = this.readPad(this.padHeld);
    if (back) {
      // Esc / B pressed again while the panel shrank: one more step back — the game. The pause stays stepped aside (its
      // thin frost, no items) while it clears, so it does not flash back up on the way out
      this.stepAsideOut = true;
      this.close();
      return;
    }
    this.timeline.rewrite();
    this.focusPending = true;
  }

  /** Swaps the words (設定 > 言語, S-43). */
  relabel(t: (k: StringKey) => string): void {
    this.screen.relabel(t);
  }

  /** Every frame, before the world's update. `playing`: in the game, no transition. */
  update(dt: number, playing: boolean): void {
    const now = performance.now();
    this.recordFrame(now);
    this.playing = playing;
    if (this.asked) {
      this.asked = false;
      if (playing) this.open(now);
    }
    if (playing && this.away && this.timeline.phase === 'closed') this.away = false;
    // The world's input is held as the pause stood before this frame's buttons: a pad button that closes the pause now
    // reaches the world's input (later in this frame) as held, not as a new press — Start would open it again.
    const held = this.timeline.phase === 'opening' || this.timeline.phase === 'open';
    if (held !== this.held) {
      this.held = held;
      this.world.setHeld(held);
    }
    // the pad is read only while the pause is up (open() reads which buttons are held already), and not while the
    // settings have it
    if (held && !this.yielded) this.pollPad();

    const hold = this.probe.hold;
    if (hold !== null && this.timeline.phase === 'opening') this.timeline.holdAt(hold);
    else this.timeline.update(dt);
    const phase = this.timeline.phase;

    // the game's time
    this.world.setTimeScale(this.timeline.timeScale);
    this.frozen = (phase === 'opening' || phase === 'open') && this.timeline.timeScale === 0;
    if (!this.frozen) this.frozenDrawn = false;

    // the game's sounds: down with the frost; after leaving for the title the game's ambience fades out over the dive back
    // (the home has no room sounds, as when first seen) and comes back once play starts again
    const awayStep = dt / (this.away ? TRANSITIONS.homeToGame.seconds : PAUSE_SECONDS.clear);
    this.awayAmount = this.away
      ? Math.min(1, this.awayAmount + awayStep)
      : Math.max(0, this.awayAmount - awayStep);
    // (leaving, the pause's turn-down stays on as the frost clears, so the ambience fades from there: no swell between)
    this.mix?.set(this.away ? 1 : this.timeline.frost);
    this.mix?.setAway(this.awayAmount);

    const view = this.view;
    view.up = phase !== 'closed';
    view.frost = this.timeline.frost;
    view.writing = this.timeline.writing;
    view.page = this.menu.page;
    view.focused = phase === 'closed' ? null : focusedItem(this.menu);
    view.interactive = this.timeline.interactive;
    if (phase === 'closed' || phase === 'opening') this.stepAsideOut = false;
    view.yielded = this.yielded || this.stepAsideOut;
    this.screen.render(dt, view);
    if (this.focusPending && this.timeline.interactive && !this.yielded) {
      // after the render: the page's buttons are shown now
      this.focusPending = false;
      this.screen.focus(focusedItem(this.menu));
    }
    if (this.probe.requestedAt !== null && this.probe.respondedAt === null && this.timeline.frost > 0)
      this.probe.respondedAt = now;

    const p = this.probe;
    p.phase = phase;
    p.page = this.menu.page;
    p.focused = phase === 'closed' ? null : focusedItem(this.menu);
    p.hovered = this.screen.hovered;
    p.frost = this.timeline.frost;
    p.writing = this.timeline.writing;
    p.timeScale = this.timeline.timeScale;
    p.ducked = this.timeline.frost;
    p.away = this.awayAmount;
    p.yielded = this.yielded;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.offRequest();
    this.offReady();
    this.abort.abort();
    this.screen.dispose();
  }

  /** The world's input asked (or a test): opens at the next frame of play. */
  private request(): void {
    this.asked = true;
    // answer at once when in play (the request comes in the middle of the world's update)
    if (this.playing) {
      this.asked = false;
      this.open(performance.now());
    }
  }

  private open(now: number): void {
    const was = this.timeline.phase;
    if (!this.timeline.open()) return;
    this.probe.opened++;
    this.probe.requestedAt = now;
    this.probe.respondedAt = null;
    if (was === 'closed') this.menu = MENU_START;
    this.focusPending = true;
    // the buttons held now (the Start that asked for the pause) are not new presses for the pause
    this.padHeld = this.readPad(this.padHeld);
    this.ring('open');
  }

  private close(): void {
    if (!this.timeline.close()) return;
    this.probe.closed++;
    this.ring('close');
  }

  private leave(): void {
    const phase = this.timeline.phase;
    if (phase !== 'opening' && phase !== 'open') return;
    // the dive back first: if it cannot start now, the pause stays as it is
    if (!this.leaveGame()) return;
    this.timeline.leave();
    this.probe.left++;
    this.away = true;
    this.ring('leave');
  }

  /** A command from the keyboard or the pad. `gesture`: it came in a user activation (the mouse lock may be asked). */
  private command(command: PauseCommand, gesture: boolean): void {
    const phase = this.timeline.phase;
    if (phase !== 'opening' && phase !== 'open') return;
    if (!this.timeline.interactive) {
      // Esc / B / Start while the frost still spreads plays it back (遷移のルール 4, 戻る操作)
      if (command === 'back' || command === 'close') this.close();
      return;
    }
    this.apply(stepMenu(this.menu, command), gesture);
  }

  private apply(step: PauseStep, gesture: boolean): void {
    if (!this.timeline.interactive || this.yielded) return;
    const page = this.menu.page;
    if (step.chosen) {
      this.screen.press(step.chosen);
      this.ring('tick', { rate: tickRate(this.indexOf(step.chosen), true) });
    }
    this.menu = step.menu;
    if (step.moved) this.ring('tick', { rate: tickRate(this.indexOf(focusedItem(this.menu))) });
    if (step.menu.page !== page) this.timeline.rewrite();
    this.focusPending = true;
    if (step.outcome === 'resume') {
      // inside a click or a key press the browser may give the mouse back at once (not after Esc: see the note)
      if (gesture) this.world.relock();
      this.close();
    } else if (step.outcome === 'leave') this.leave();
    else if (step.outcome === 'settings' && this.openSettings) {
      // the pause steps aside: the panel has the keys and the pad until it closes (settingsClosed)
      this.yielded = true;
      this.openSettings();
    }
  }

  private setFocus(item: PauseChoice): void {
    const focus = itemsOf(this.menu.page).indexOf(item);
    if (focus < 0) return;
    this.menu = { page: this.menu.page, focus };
    this.focusPending = true;
  }

  /** The item's note: its place in the column, the answers after the items (as the home drops climb the scale). */
  private indexOf(item: PauseChoice): number {
    const i = itemsOf('menu').indexOf(item);
    return i >= 0 ? i : itemsOf('menu').length + itemsOf('confirm').indexOf(item);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    // the settings over the pause have the keys (their own listener)
    if (e.metaKey || e.ctrlKey || e.altKey || this.yielded) return;
    const phase = this.timeline.phase;
    if (phase !== 'opening' && phase !== 'open') return;
    const command = keyCommand(e);
    if (!command) return;
    // Enter / Space would also click the focused button, the arrows scroll
    e.preventDefault();
    if (e.repeat && (command === 'choose' || command === 'back')) return;
    const at = this.probe.requestedAt;
    if (command === 'back' && e.key === 'Escape' && at !== null && performance.now() - at < ESC_ECHO_MS)
      return;
    // Esc is not a user activation: only Enter / Space may ask for the mouse again
    this.command(command, command === 'choose');
  };

  private pollPad(): void {
    const held = this.readPad(this.padHeld);
    const commands = padCommands(this.padHeld, held);
    this.padHeld = held;
    for (const c of commands) this.command(c, false);
  }

  /** The buttons held on the first connected pad (src/game/input/gamepad.ts codes). */
  private readPad(previous: ReadonlySet<string>): ReadonlySet<string> {
    return readFirstPad(previous);
  }

  private ring(cue: PauseCue, opts: { rate?: number; gain?: number } = {}): void {
    // on the gate's UI bus, counted as the UI's voices (S-43: 全部の声 = UI の声 + 部屋の声, S-18)
    const ui = this.gate.ui;
    let rang = false;
    if (ui) {
      rang = playPauseCue(ui, this.bank, cue, opts);
      if (!rang && !this.bank[cue]) {
        // the pause's sounds are still being made: a plain glass ping answers (UIの原則 3)
        this.gate.ping(TICK_HZ * (opts.rate ?? 1), 0.04, 0.6);
        rang = true;
      }
    }
    const s = this.probe.sounds;
    s.push({ cue, at: performance.now(), rang });
    if (s.length > MAX_SOUNDS) s.shift();
  }

  private recordFrame(now: number): void {
    const ms = now - this.lastNow;
    this.lastNow = now;
    const f = this.probe.frameMs;
    switch (this.timeline.phase) {
      case 'opening':
        f.opening = Math.max(f.opening, ms);
        break;
      case 'open':
        f.open = Math.max(f.open, ms);
        break;
      case 'closing':
      case 'leaving':
        f.closing = Math.max(f.closing, ms);
        break;
      default:
        break;
    }
  }
}
