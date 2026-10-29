import { PAUSE_SOURCES, playPauseCue, tickRate } from '../../audio/pause';
import { loadBank } from '../../core/audio/bank';
import { midiToHz } from '../../core/audio/scale';
import type { QualityPort } from '../../core/quality';
import type { DiveWorld } from '../../game/dive-world';
import { assignBinding, cloneBindings, DEFAULT_BINDINGS } from '../../game/input/bindings';
import { readFirstPad } from '../../game/input/gamepad';
import type { AudioGate } from '../audio-gate';
import type { Lang, StringKey } from '../lang';
import { type FlashGate, fadeSecondsFor } from './fade';
import {
  type Capture,
  captureKey,
  captureMouse,
  capturePad,
  captureWheel,
  KEYS_START,
  type KeysFocus,
  type KeysStep,
  type KeysWaiting,
  keysNotice,
  pickKeys,
  stepKeys,
} from './keys-logic';
import {
  CONTROLS,
  keyCommand,
  PANEL_START,
  type PanelCommand,
  type PanelFocus,
  type PanelPhase,
  type PanelStep,
  PanelTimeline,
  padCommands,
  pickOption,
  pickTab,
  placeOf,
  rowAt,
  rowValue,
  SETTINGS_TABS,
  type SettingsRow,
  type SettingsTab,
  setSlider,
  sliderFraction,
  stepPanel,
} from './settings-logic';
import { type Settings, TEXT_SCALE, worldSettingsOf } from './settings-model';
import { type PanelTarget, SettingsPanel } from './settings-panel';
import type { SettingsStore } from './settings-store';

/**
 * 設定 (S-43), opened from the home's 「設定」 and the pause's 「設定」 (トランジション設計: 設定パネルはホーム画面とポーズの
 * 両方から開き、どちらでも背後の景色が見えたまま操作できます). It owns the panel (settings-panel.ts), plays its rules
 * (settings-logic.ts), keeps the settings (settings-store.ts) and applies every change at once:
 *  - 画質: the shell's quality port (main.ts: the render scale at once, the scene kept — 品質を変えてもゲームの状態を失わない);
 *    視野角 and 操作: the world's applySettings; the picture held by the pause is drawn again (`onPicture`)
 *  - 音: the page's AudioGate (the player's sliders; the pause's turn-down is a duck of its own, core/audio)
 *  - 表示とアクセシビリティ: the language (the host swaps every screen's words: `onLang`), the text size and the contrast on
 *    the UI's root
 * Its sounds ring on the gate's UI bus, counted as the UI's (S-18).
 */

export type SettingsFrom = 'home' | 'pause';

/** window.__vidro.sceneProbe.settings (tests/e2e/S-43-*.spec.ts). */
export interface SettingsProbe {
  phase: PanelPhase;
  /** How far the pane has spread (0..1). */
  open: number;
  from: SettingsFrom | null;
  tab: SettingsTab;
  /** The focused row, null on the tab strip. */
  row: SettingsRow | null;
  /** The settings as shown and in effect (the quality as the shell has it). */
  values: Settings;
  /** False once the browser refused to keep them. */
  persistent: boolean;
  /** How many times 「この環境では保存できません」 was shown (once at most). */
  notices: number;
  opened: number;
  closed: number;
  /** Saves that the browser kept / refused. */
  saves: { kept: number; refused: number };
  requestedAt: number | null;
  respondedAt: number | null;
  /** The cues asked for (the latest 40): when, and whether a voice started. */
  sounds: { cue: string; at: number; rang: boolean }[];
  /** The longest frame (ms) while opening, open, and closing. */
  frameMs: { opening: number; open: number; closing: number };
  /** Dev hold (screenshots): stands the opening at this many seconds in; null lets it go on. The only field a test writes. */
  hold: number | null;
  /** S-45: the key page (キーの割り当て): open, its focus, the cell waiting for a key, the line under it, binds and resets. */
  keys: {
    open: boolean;
    focus: KeysFocus;
    waiting: KeysWaiting | null;
    notice: string | null;
    bound: number;
    resets: number;
  };
  /** S-45 簡易トランジション: how white the panel's fade makes the screen now (0 under the glass's own). */
  white: number;
}

export interface SettingsHostOptions {
  /** The UI root (src/ui/styles.ts createUiRoot): its text size and contrast are the settings'. */
  root: HTMLElement;
  /** The words in the language in use now. */
  t: (k: StringKey) => string;
  gate: AudioGate;
  world: DiveWorld;
  /** The shell's quality (main.ts), when it gave one. */
  quality: QualityPort | null;
  store: SettingsStore;
  /** The language changed: swap every screen's words. */
  onLang(lang: Lang): void;
  /** The text size changed (layouts measured from it must measure again). */
  onLayout(): void;
  /** Something in the picture changed (the pause holds a picture: it must be drawn again). */
  onPicture(): void;
  /**
   * The panel has closed (shrunk away) — back to where it came from. `back`: Esc / B was pressed again while it shrank, one
   * more step back there (from the pause: back to the game).
   */
  onClosed(from: SettingsFrom, back: boolean): void;
  /** S-45 (発案者の判断 2026-10-29): the page's gate of full whites (src/ui/settings/fade.ts), shared with the other fades. */
  flashGate?: FlashGate;
}

const MAX_SOUNDS = 40;
const NO_BUTTONS: ReadonlySet<string> = new Set();
/** 仮: how long 「この環境では保存できません」 stays (s), fading in and out over FADE. */
const NOTICE_SECONDS = 6;
const NOTICE_FADE = 0.4;
/** 仮: a dragged slider rings at most this often (s). */
const SLIDE_RING_GAP = 0.06;
/** 仮 (S-45): a waiting cell answers a key it does not take at most this often (s). */
const REFUSE_GAP = 0.15;
/** The stand-in ping before the panel's sound is made: the tick's D5. */
const TICK_HZ = midiToHz(74);
/** 仮 (トランジションの音): the pane opening rings A5 then D6 (rising), closing D6 then A5; this far apart (ms). */
const PANE_NOTES = { low: 3, high: 5, gapMs: 70 } as const;

type Cue = 'open' | 'close' | 'tick';

export class SettingsHost {
  readonly probe: SettingsProbe;
  private readonly timeline = new PanelTimeline();
  private readonly panel: SettingsPanel;
  private readonly opts: SettingsHostOptions;
  private focus: PanelFocus = PANEL_START;
  private values: Settings;
  private from: SettingsFrom | null = null;
  private padHeld: ReadonlySet<string> = NO_BUTTONS;
  private focusPending = false;
  private noticeLeft = 0;
  private lastSlideRing = -Infinity;
  private lastNow = performance.now();
  private elapsed = 0;
  private tick: AudioBuffer | null = null;
  private readonly abort = new AbortController();
  private readonly offReady: () => void;
  private readonly timers = new Set<number>();
  /** A change in effect but not kept yet (a slider being dragged). */
  private unsaved = false;
  /** Esc / B pressed again while the panel shrinks: one more step back, once it has closed. */
  private pendingBack = false;
  /** S-45: the key page (in place of 操作's rows), its focus, the cell waiting for a key, the line telling what changed. */
  private keysOpen = false;
  private keysFocus: KeysFocus = KEYS_START;
  private waiting: KeysWaiting | null = null;
  private keysLine: string | null = null;
  /** The click that follows a mouse button taken by a waiting cell is not a click on the page. */
  private swallowClick = false;

  constructor(opts: SettingsHostOptions) {
    this.opts = opts;
    this.values = this.shown(opts.store.settings);
    this.panel = new SettingsPanel(opts.root, opts.t, {
      onHover: (target) => {
        this.ring('tick', { rate: this.rateOf(target), gain: 0.8 });
      },
      onPick: (target) => this.pick(target),
      onSlide: (row, fraction, done) => this.slide(row, fraction, done),
      onFocus: (focus) => {
        if (this.keysOpen) return;
        if (focus.tab === this.focus.tab && focus.row === this.focus.row) return;
        this.focus = focus;
        this.ring('tick', { rate: this.rateOfFocus(focus) });
      },
      onKeysPick: (at) => {
        if (!this.timeline.interactive || !this.keysOpen || this.waiting) return;
        this.panel.pressKeys(at);
        this.takeKeys(pickKeys(at));
      },
      onKeysHover: (at) => {
        if (this.keysOpen && !this.waiting) this.ring('tick', { rate: tickRate(at.row % 8), gain: 0.8 });
      },
      onKeysFocus: (at) => {
        // the browser moved the focus (Tab) onto a cell: the lit one follows, with its sound
        if (
          !this.keysOpen ||
          this.waiting ||
          (at.row === this.keysFocus.row && at.col === this.keysFocus.col)
        )
          return;
        this.keysFocus = at;
        this.syncKeysProbe();
        this.ring('tick', { rate: tickRate(at.row % 8) });
      },
    });
    const v = this.values;
    this.probe = {
      phase: 'closed',
      open: 0,
      from: null,
      tab: SETTINGS_TABS[0],
      row: null,
      values: v,
      persistent: opts.store.persistent,
      notices: 0,
      opened: 0,
      closed: 0,
      saves: { kept: 0, refused: 0 },
      requestedAt: null,
      respondedAt: null,
      sounds: [],
      frameMs: { opening: 0, open: 0, closing: 0 },
      hold: null,
      keys: { open: false, focus: KEYS_START, waiting: null, notice: null, bound: 0, resets: 0 },
      white: 0,
    };
    // the kept settings take effect from the start (the language was read by the host before any screen was made)
    for (const ch of ['master', 'sfx', 'ambience', 'ui'] as const) opts.gate.setVolume(ch, v.volumes[ch]);
    opts.world.applySettings?.(worldSettingsOf(v));
    this.applyDisplay();
    this.offReady = opts.gate.whenReady((engine) => {
      loadBank(engine.ctx, [PAUSE_SOURCES.tick], { signal: this.abort.signal }).then(
        ([buffer]) => {
          this.tick = buffer ?? null;
        },
        () => undefined,
      );
    });
    window.addEventListener('keydown', this.onKey);
    // S-45: a mouse button taken by a cell of the key page that waits (before anything under the pointer); the wheel is
    // listened to only while a cell waits (a listener that may stop it would hold every scroll on the main thread)
    window.addEventListener('pointerdown', this.onPointer, { capture: true });
    window.addEventListener('click', this.onClick, { capture: true });
    window.addEventListener('contextmenu', this.onContextMenu, { capture: true });
  }

  /** S-45: the settings in effect (the host reads 視点の基準の点 and 簡易トランジション from them). */
  get current(): Settings {
    return this.values;
  }

  /** S-45 簡易トランジション: how white the panel's fade makes the screen now. */
  get white(): number {
    return this.timeline.white;
  }

  /** The panel is on the screen (also while it spreads or shrinks): it has the keys and the pad. */
  get isUp(): boolean {
    return this.timeline.phase !== 'closed';
  }

  /** The panel stands over the screen behind (spreading or open; not while it shrinks away). */
  get covering(): boolean {
    const p = this.timeline.phase;
    return p === 'opening' || p === 'open';
  }

  /** Opens the panel over the home or the pause. */
  open(from: SettingsFrom): void {
    if (!this.timeline.open()) return;
    this.from = from;
    this.focus = PANEL_START;
    this.values = this.shown(this.opts.store.settings);
    this.focusPending = true;
    // the button held now (A on 設定) is not a new press for the panel
    this.padHeld = this.readPad(this.padHeld);
    this.probe.opened++;
    this.probe.requestedAt = performance.now();
    this.probe.respondedAt = null;
    this.ringPane('open');
  }

  /** Esc / B / 戻る: the pane shrinks away (the opening played back). */
  close(): void {
    if (!this.timeline.close()) return;
    this.probe.closed++;
    this.pendingBack = false;
    // (the key page goes with the pane; it opens on 画質 again)
    this.keysOpen = false;
    this.setWaiting(null);
    this.keysLine = null;
    // a slider let go of while it closes (Esc during a drag) is kept as it took effect
    if (this.unsaved) this.keep(this.values, null);
    this.ringPane('close');
  }

  /** Swaps the panel's words (the language changed). */
  relabel(t: (k: StringKey) => string): void {
    this.panel.relabel(t);
  }

  /** Every frame. */
  update(dt: number): void {
    const now = performance.now();
    this.recordFrame(now);
    this.elapsed += dt;
    const was = this.timeline.phase;
    // S-45 簡易トランジション: the pane comes and goes as a white fade (the same 0.3 s)
    this.timeline.simple = this.values.simpleTransitions;
    // (0.5 s with 点滅を抑える as well, its full white through the page's gate: 発案者の判断 2026-10-29)
    this.timeline.fadeSeconds = fadeSecondsFor(this.values.reduceFlashes);
    this.timeline.gate = this.opts.flashGate ?? null;
    // the pad only while the panel is up (open() read which buttons were held already)
    if (this.isUp) this.pollPad();
    const hold = this.probe.hold;
    if (hold !== null && this.timeline.phase === 'opening') this.timeline.holdAt(hold);
    else this.timeline.update(dt);
    if (was !== 'closed' && this.timeline.phase === 'closed') {
      const from = this.from;
      const back = this.pendingBack;
      this.from = null;
      this.pendingBack = false;
      if (from) this.opts.onClosed(from, back);
    }
    this.noticeLeft = Math.max(0, this.noticeLeft - dt);
    const shown = NOTICE_SECONDS - this.noticeLeft;
    const notice = this.noticeLeft <= 0 ? 0 : Math.min(1, shown / NOTICE_FADE, this.noticeLeft / NOTICE_FADE);
    const q = this.opts.quality;
    this.panel.render(dt, {
      open: this.timeline.value,
      interactive: this.timeline.interactive,
      focus: this.focus,
      values: this.values,
      notice,
      // (not under 自動: it is made at mid each time and measures again, so nothing of it waits for a next time)
      qualityLater: q !== null && q.choice !== 'auto' && q.level !== q.sceneLevel,
      keys: this.keysOpen
        ? {
            focus: this.keysFocus,
            waiting: this.waiting,
            bindings: this.values.bindings,
            notice: this.keysLine,
            lang: this.values.lang,
            interactive: this.timeline.interactive,
          }
        : null,
    });
    if (this.focusPending && this.timeline.interactive) {
      this.focusPending = false;
      if (this.keysOpen) this.panel.focusKeys(this.keysFocus);
      else this.panel.focus(this.focus);
    }
    const p = this.probe;
    // (the simple fade answers with its white before the pane is there)
    if (
      p.requestedAt !== null &&
      p.respondedAt === null &&
      (this.timeline.value > 0 || this.timeline.white > 0)
    )
      p.respondedAt = now;
    p.phase = this.timeline.phase;
    p.open = this.timeline.value;
    p.from = this.from;
    p.tab = SETTINGS_TABS[this.focus.tab] ?? SETTINGS_TABS[0];
    p.row = rowAt(this.focus);
    p.values = this.values;
    p.persistent = this.opts.store.persistent;
    this.syncKeysProbe();
    p.white = this.timeline.white;
  }

  /** The key page's part of the probe (also at once after a key's event: a test reads it before the next frame). */
  private syncKeysProbe(): void {
    const k = this.probe.keys;
    k.open = this.keysOpen;
    k.focus = this.keysFocus;
    k.waiting = this.waiting;
    k.notice = this.keysLine;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerdown', this.onPointer, { capture: true });
    window.removeEventListener('click', this.onClick, { capture: true });
    window.removeEventListener('contextmenu', this.onContextMenu, { capture: true });
    // (a cell left waiting: its wheel and back-button listeners)
    this.setWaiting(null);
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.offReady();
    this.abort.abort();
    this.panel.dispose();
  }

  /** The kept settings with the quality as the shell has it now (what is in effect). */
  private shown(s: Settings): Settings {
    const q = this.opts.quality;
    return { ...s, quality: q ? q.choice : (s.quality ?? 'mid') };
  }

  private command(command: PanelCommand): void {
    if (!this.isUp) return;
    if (!this.timeline.interactive) {
      // Esc / B while it still spreads plays it back (遷移のルール 4, 戻る操作); a second one while it shrinks is the next
      // step back, handed to where it came from once it has closed (to the pause: back to the game)
      if (command === 'back') {
        if (this.timeline.phase === 'closing') this.pendingBack = true;
        else this.close();
      }
      return;
    }
    // S-45: the key page has the commands while it is open (Esc / B back to 操作)
    if (this.keysOpen) {
      if (!this.waiting) this.takeKeys(stepKeys(this.keysFocus, command));
      return;
    }
    this.take(stepPanel(this.focus, this.values, command));
  }

  private take(step: Pick<PanelStep, 'focus' | 'moved' | 'tabChanged' | 'close'> & Partial<PanelStep>): void {
    if (step.close) {
      this.close();
      return;
    }
    if (step.page === 'keys') {
      this.openKeys();
      return;
    }
    this.focus = step.focus;
    this.focusPending = true;
    if (step.changed && step.settings) {
      this.commit(step.settings, step.changed, true);
      this.ring('tick', { rate: this.rateOfValue(step.changed) });
    } else if (step.moved)
      this.ring('tick', { rate: this.rateOfFocus(step.focus), gain: step.tabChanged ? 1 : 0.85 });
  }

  private pick(target: PanelTarget): void {
    if (!this.timeline.interactive) return;
    switch (target.kind) {
      case 'back':
        this.panel.press(target);
        this.close();
        return;
      case 'tab':
        this.panel.press(target);
        this.take(pickTab(this.focus, target.tab));
        return;
      case 'option': {
        this.panel.press(target);
        this.take(pickOption(this.focus, this.values, target.row, target.value));
        return;
      }
      case 'page':
        this.panel.press(target);
        this.focus = placeOf(target.row);
        this.openKeys();
        return;
      case 'row':
        return;
    }
  }

  // ---- S-45 キーの割り当て: the key page ----

  private openKeys(): void {
    this.keysOpen = true;
    this.keysFocus = KEYS_START;
    this.setWaiting(null);
    this.keysLine = null;
    this.focusPending = true;
    this.syncKeysProbe();
    this.ring('tick', { rate: tickRate(5) });
  }

  /** 戻る: back to 操作, on the row of the page (一つ前に戻る). */
  private leaveKeys(): void {
    this.keysOpen = false;
    this.setWaiting(null);
    this.keysLine = null;
    this.focus = placeOf('keys');
    this.focusPending = true;
    this.syncKeysProbe();
    this.ring('tick', { rate: tickRate(2) });
  }

  private takeKeys(step: KeysStep): void {
    if (step.leave) {
      this.leaveKeys();
      return;
    }
    this.keysFocus = step.focus;
    this.focusPending = true;
    if (step.reset) {
      this.commit({ ...this.values, bindings: cloneBindings(DEFAULT_BINDINGS) }, 'keys', true);
      this.keysLine = this.opts.t('keysResetDone');
      this.probe.keys.resets++;
      this.ring('tick', { rate: tickRate(0, true) });
    } else if (step.waiting) {
      // 「キーを押してください」: the next key, button or turn of the wheel is the cell's
      this.setWaiting(step.waiting);
      this.keysLine = null;
      this.ring('tick', { rate: tickRate(6) });
    } else if (step.moved) this.ring('tick', { rate: tickRate(step.focus.row % 8), gain: 0.85 });
    this.syncKeysProbe();
  }

  /** What a waiting cell does with a key, a button or the wheel. */
  private capture(c: Capture): boolean {
    const w = this.waiting;
    if (!w) return false;
    if (c.kind === 'ignore') {
      // a key it does not take: a low tick and a shake of the cell (入力から0.1秒以内に必ず音と動きで反応する)
      this.refuse();
      return false;
    }
    this.setWaiting(null);
    this.focusPending = true;
    if (c.kind === 'cancel') {
      // 待ちの間の Esc は割り当てをやめて一覧へ戻る
      this.syncKeysProbe();
      this.ring('tick', { rate: tickRate(1) });
      return true;
    }
    const r = assignBinding(this.values.bindings, w.device, w.action, w.slot, c.code);
    this.commit({ ...this.values, bindings: r.bindings }, 'keys', true);
    // 重なったら前の持ち主と入れ替え、何が入れ替わったかを書く
    this.keysLine = keysNotice(this.values.lang, c.code, r.swaps);
    // the key in the slot it took (キー（副） of an action with no first key is its first): the light follows it
    if (w.device === 'keyboardMouse') {
      const at = r.bindings.keyboardMouse[w.action].indexOf(c.code);
      if (at >= 0) this.keysFocus = { row: this.keysFocus.row, col: at };
    }
    this.probe.keys.bound++;
    this.syncKeysProbe();
    this.ring('tick', { rate: tickRate(7) });
    return true;
  }

  private lastRefusal = Number.NEGATIVE_INFINITY;

  private refuse(): void {
    if (this.elapsed - this.lastRefusal < REFUSE_GAP) return;
    this.lastRefusal = this.elapsed;
    this.panel.refuseKeys(this.keysFocus);
    this.ring('tick', { rate: tickRate(0, true), gain: 0.6 });
  }

  /**
   * A cell waits for its key (or none does). Meanwhile the wheel is listened to, and the mouse's back and forward buttons are
   * held from the browser (it might go back a page on them; they are not taken).
   */
  private setWaiting(w: KeysWaiting | null): void {
    if (w && !this.waiting) {
      window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
      window.addEventListener('mouseup', this.onBackButtons, { capture: true });
      window.addEventListener('auxclick', this.onBackButtons, { capture: true });
    }
    if (!w && this.waiting) {
      window.removeEventListener('wheel', this.onWheel, { capture: true });
      window.removeEventListener('mouseup', this.onBackButtons, { capture: true });
      window.removeEventListener('auxclick', this.onBackButtons, { capture: true });
    }
    this.waiting = w;
  }

  private readonly onBackButtons = (e: MouseEvent): void => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private readonly onPointer = (e: PointerEvent): void => {
    // (a click that was to be swallowed never came: the button was not the primary one)
    this.swallowClick = false;
    if (!this.waiting) return;
    this.onBackButtons(e);
    if (this.capture(captureMouse(this.waiting, e.button))) {
      e.preventDefault();
      e.stopPropagation();
      // only the primary button's press is followed by a click (the others: auxclick, contextmenu)
      this.swallowClick = e.button === 0;
    }
  };

  private readonly onClick = (e: MouseEvent): void => {
    if (!this.swallowClick) return;
    this.swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onContextMenu = (e: Event): void => {
    // the right button taken by a waiting cell (or about to be) opens no menu over the page
    if (this.keysOpen) e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.waiting) return;
    if (this.capture(captureWheel(this.waiting, e.deltaY))) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private slide(row: SettingsRow, fraction: number, done: boolean): void {
    if (!this.timeline.interactive) return;
    const next = setSlider(this.values, row, fraction);
    const at = placeOf(row);
    if (at.tab !== this.focus.tab || at.row !== this.focus.row) {
      this.focus = at;
      this.focusPending = true;
    }
    const changed = next !== this.values && sliderFraction(next, row) !== sliderFraction(this.values, row);
    if (changed) {
      this.commit(next, row, done);
      if (this.elapsed - this.lastSlideRing >= SLIDE_RING_GAP) {
        this.lastSlideRing = this.elapsed;
        this.ring('tick', { rate: this.rateOfValue(row), gain: 0.7 });
      }
    } else if (done && this.unsaved) this.keep(this.values, row);
  }

  /** A change takes effect at once (変更は即時反映) and is kept (unless a slider is still being dragged). */
  private commit(next: Settings, row: SettingsRow, persist: boolean): void {
    const prev = this.values;
    this.values = next;
    // (the probe with it at once: a change made in a key's event reads as made before the next frame)
    this.probe.values = next;
    const o = this.opts;
    switch (row) {
      case 'quality':
        if (next.quality && next.quality !== prev.quality) o.quality?.request(next.quality);
        o.onPicture();
        break;
      case 'fov':
      case 'peekMode':
      case 'sensitivity':
      case 'invertY':
        o.world.applySettings?.(worldSettingsOf(next));
        if (row === 'fov') o.onPicture();
        break;
      case 'master':
      case 'sfx':
      case 'ambience':
      case 'ui':
        o.gate.setVolume(row, next.volumes[row]);
        break;
      case 'lang':
        o.world.applySettings?.(worldSettingsOf(next));
        o.onLang(next.lang);
        break;
      case 'textSize':
      case 'contrast':
        this.applyDisplay();
        // the world's own words too (the prompt's frosted label); S-45: and the world's glass rims (コントラスト強化)
        o.world.applySettings?.(worldSettingsOf(next));
        o.onLayout();
        if (row === 'contrast') o.onPicture();
        break;
      // S-45: the world takes these (the sway, the orb's distortion, the flashes, the keys bound)
      case 'headBob':
      case 'distortion':
      case 'reduceFlashes':
      case 'keys':
        o.world.applySettings?.(worldSettingsOf(next));
        if (row === 'distortion' || row === 'reduceFlashes') o.onPicture();
        break;
      // S-45: the host's (the dot, the fades): read from `current`
      case 'reticle':
      case 'simpleTransitions':
        break;
    }
    if (persist) this.keep(next, row);
    else this.unsaved = true;
  }

  /** Keeps the settings in effect (`row`: the one just changed, if any). */
  private keep(next: Settings, row: SettingsRow | null): void {
    this.unsaved = false;
    const store = this.opts.store;
    // the quality is kept only once chosen here (until then the shell's: the URL's, or mid)
    const quality = row === 'quality' ? next.quality : store.settings.quality;
    const r = store.save({ ...next, quality });
    if (r.saved) this.probe.saves.kept++;
    else this.probe.saves.refused++;
    if (r.notify) {
      this.noticeLeft = NOTICE_SECONDS;
      this.probe.notices++;
    }
  }

  private applyDisplay(): void {
    const root = this.opts.root;
    root.style.setProperty('--vd-text', String(TEXT_SCALE[this.values.textSize]));
    root.classList.toggle('vd-contrast', this.values.contrast);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.isUp || e.metaKey || e.ctrlKey || e.altKey) return;
    // S-45: a cell of the key page waits — the key pressed is its (Esc gives the waiting up)
    if (this.waiting) {
      e.preventDefault();
      if (!e.repeat) this.capture(captureKey(this.waiting, e.code));
      return;
    }
    let command = keyCommand(e);
    if (!command) return;
    // Enter / Space would also click the focused button, the arrows scroll
    e.preventDefault();
    if (e.repeat && (command === 'choose' || command === 'back')) return;
    // on the 戻る button (reached by Tab): Enter goes back, ↑ returns to the lit row; the other moves do nothing there
    if (document.activeElement?.closest('[data-settings-back]')) {
      if (command === 'choose') command = 'back';
      else if (command === 'up') {
        this.focusPending = true;
        return;
      } else if (command !== 'back' && command !== 'prevTab' && command !== 'nextTab') return;
    }
    this.command(command);
  };

  private pollPad(): void {
    const held = this.readPad(this.padHeld);
    if (this.waiting) {
      // S-45: a cell of the key page waits — the button newly pressed is its (B and Start give the waiting up)
      for (const code of held)
        if (!this.padHeld.has(code) && this.capture(capturePad(this.waiting, code))) break;
      this.padHeld = held;
      return;
    }
    const commands = padCommands(this.padHeld, held);
    this.padHeld = held;
    for (const c of commands) this.command(c);
  }

  private readPad(previous: ReadonlySet<string>): ReadonlySet<string> {
    return readFirstPad(previous);
  }

  /** The note of a focus: the tabs climb the scale from D5, the rows of a tab after them (as the home drops). */
  private rateOfFocus(focus: PanelFocus): number {
    return tickRate(focus.row < 0 ? focus.tab : SETTINGS_TABS.length + focus.row);
  }

  /** The note of a value: a slider's climbs with it, a choice's with its place. */
  private rateOfValue(row: SettingsRow): number {
    const c = CONTROLS[row];
    if (c.kind === 'slider') return tickRate(Math.round(sliderFraction(this.values, row) * 7));
    if (c.kind === 'toggle') return tickRate(rowValue(this.values, row) ? 3 : 2);
    if (c.kind === 'page') return tickRate(7);
    return tickRate(2 + Math.max(0, c.options.indexOf(String(rowValue(this.values, row)))));
  }

  private rateOf(target: PanelTarget): number {
    switch (target.kind) {
      case 'tab':
        return this.rateOfFocus({ tab: target.tab, row: -1 });
      case 'option': {
        const c = CONTROLS[target.row];
        const i = c.kind === 'choice' ? c.options.indexOf(String(target.value)) : target.value ? 1 : 0;
        return tickRate(2 + Math.max(0, i));
      }
      case 'row':
      case 'page':
        return this.rateOfFocus(placeOf(target.row));
      case 'back':
        return tickRate(0, true);
    }
  }

  /** The pane's two notes, rising as it opens, falling as it closes (遷移のルール 6: 遷移ごとに固有のガラスの音). */
  private ringPane(cue: 'open' | 'close'): void {
    const [first, second] =
      cue === 'open' ? [PANE_NOTES.low, PANE_NOTES.high] : [PANE_NOTES.high, PANE_NOTES.low];
    this.ring(cue, { rate: tickRate(first) });
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      this.ring(cue, { rate: tickRate(second), gain: 0.85, quiet: true });
    }, PANE_NOTES.gapMs);
    this.timers.add(id);
  }

  private ring(cue: Cue, opts: { rate?: number; gain?: number; quiet?: boolean } = {}): void {
    const gate = this.opts.gate;
    const ui = gate.ui;
    let rang = false;
    if (ui) {
      rang = this.tick ? playPauseCue(ui, { tick: this.tick }, 'tick', opts) : false;
      if (!rang && !this.tick) {
        // the panel's sound is still being made: a plain glass ping answers (UIの原則 3)
        gate.ping(TICK_HZ * (opts.rate ?? 1), 0.04 * (opts.gain ?? 1), 0.6);
        rang = true;
      }
    }
    if (opts.quiet) return;
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
        f.closing = Math.max(f.closing, ms);
        break;
      default:
        break;
    }
  }
}
