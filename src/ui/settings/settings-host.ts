import { PAUSE_SOURCES, playPauseCue, tickRate } from '../../audio/pause';
import { loadBank } from '../../core/audio/bank';
import { midiToHz } from '../../core/audio/scale';
import type { QualityPort } from '../../core/quality';
import type { DiveWorld } from '../../game/dive-world';
import { readFirstPad } from '../../game/input/gamepad';
import type { AudioGate } from '../audio-gate';
import type { Lang, StringKey } from '../lang';
import { type QualityRowView, qualityRowView } from './quality-row';
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
}

const MAX_SOUNDS = 40;
const NO_BUTTONS: ReadonlySet<string> = new Set();
/** 仮: how long 「この環境では保存できません」 stays (s), fading in and out over FADE. */
const NOTICE_SECONDS = 6;
const NOTICE_FADE = 0.4;
/** 仮: a dragged slider rings at most this often (s). */
const SLIDE_RING_GAP = 0.06;
/** The stand-in ping before the panel's sound is made: the tick's D5. */
const TICK_HZ = midiToHz(74);
/** 仮 (トランジションの音): the pane opening rings A5 then D6 (rising), closing D6 then A5; this far apart (ms). */
const PANE_NOTES = { low: 3, high: 5, gapMs: 70 } as const;

type Cue = 'open' | 'close' | 'tick';

/** S-48: the 品質 row while the panel is down (nothing of it is drawn). */
const QUALITY_ROW_HIDDEN: QualityRowView = { autoLevel: null, later: false };

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
        if (focus.tab === this.focus.tab && focus.row === this.focus.row) return;
        this.focus = focus;
        this.ring('tick', { rate: this.rateOfFocus(focus) });
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
    // S-48: 自動's tag carries the preset in use; the line under 品質 only while the shadows and the glass wait (自動 too:
    // its pick is kept, and the next visit is built from it)
    const quality = this.isUp ? qualityRowView(this.opts.quality) : QUALITY_ROW_HIDDEN;
    this.panel.render(dt, {
      open: this.timeline.value,
      interactive: this.timeline.interactive,
      focus: this.focus,
      values: this.values,
      notice,
      qualityLater: quality.later,
      autoLevel: quality.autoLevel,
    });
    if (this.focusPending && this.timeline.interactive) {
      this.focusPending = false;
      this.panel.focus(this.focus);
    }
    const p = this.probe;
    if (p.requestedAt !== null && p.respondedAt === null && this.timeline.value > 0) p.respondedAt = now;
    p.phase = this.timeline.phase;
    p.open = this.timeline.value;
    p.from = this.from;
    p.tab = SETTINGS_TABS[this.focus.tab] ?? SETTINGS_TABS[0];
    p.row = rowAt(this.focus);
    p.values = this.values;
    p.persistent = this.opts.store.persistent;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
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
    this.take(stepPanel(this.focus, this.values, command));
  }

  private take(step: Pick<PanelStep, 'focus' | 'moved' | 'tabChanged' | 'close'> & Partial<PanelStep>): void {
    if (step.close) {
      this.close();
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
      case 'row':
        return;
    }
  }

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
        // the world's own words too (the prompt's frosted label)
        o.world.applySettings?.(worldSettingsOf(next));
        o.onLayout();
        break;
    }
    if (persist) this.keep(next, row);
    else this.unsaved = true;
  }

  /** Keeps the settings in effect (`row`: the one just changed, if any). */
  private keep(next: Settings, row: SettingsRow | null): void {
    this.unsaved = false;
    const store = this.opts.store;
    // the quality is kept only once chosen here (until then the shell's: the URL's, or 自動 — S-48)
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
