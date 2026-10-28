import { QUALITY_CHOICES } from '../../core/quality';
import { glassEase } from '../../core/transition';
import { MOUSE_SENSITIVITY_RANGE } from '../../game/input/gamepad';
import { FOV_MAX, FOV_MIN } from '../../game/player/constants';
import { fadeArrived, fadeStep, fadeWhite } from './fade';
import { type Settings, TEXT_SIZES } from './settings-model';

/**
 * The settings panel's rules (S-43), pure: no DOM, no GPU, no sound. src/ui/settings/settings-host.ts plays them.
 *  - 画面ごとの設計: 設定 — 曇りガラスのパネルが横に広がる。タブは画質 / 操作 / 音 / 表示とアクセシビリティ。変更は即時反映
 *  - トランジション設計: 設定パネル — 曇りガラスが横に広がり、閉じると縮んで消える (0.3秒)
 *  - 細部の振る舞い: マウスなしでもすべての画面を操作できる; Esc / B で一つ前に戻る (来たときの動きを逆再生する)
 */

export const SETTINGS_TABS = ['graphics', 'controls', 'sound', 'display'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export type SettingsRow =
  | 'quality'
  | 'fov'
  | 'peekMode'
  | 'sensitivity'
  | 'invertY'
  | 'master'
  | 'sfx'
  | 'ambience'
  | 'ui'
  | 'lang'
  | 'textSize'
  | 'contrast'
  // S-45
  | 'keys'
  | 'headBob'
  | 'reticle'
  | 'distortion'
  | 'reduceFlashes'
  | 'simpleTransitions';

/**
 * What each tab holds. S-45: キーの割り当て last under 操作 (a page of its own), and the rest of accessibility (3D酔い対策:
 * 歩行の揺れ, 視点の基準の点, 覗いたときの歪み; 点滅を抑える; 簡易トランジション) after コントラスト強化.
 */
export const SETTINGS_ROWS: Readonly<Record<SettingsTab, readonly SettingsRow[]>> = {
  graphics: ['quality', 'fov'],
  controls: ['peekMode', 'sensitivity', 'invertY', 'keys'],
  sound: ['master', 'sfx', 'ambience', 'ui'],
  display: [
    'lang',
    'textSize',
    'contrast',
    'headBob',
    'reticle',
    'distortion',
    'reduceFlashes',
    'simpleTransitions',
  ],
};

export type Control =
  | { kind: 'choice'; options: readonly string[] }
  /** `step`: a key or the pad's press; `fine`: the pointer's resolution. */
  | { kind: 'slider'; min: number; max: number; step: number; fine: number }
  | { kind: 'toggle' }
  /** S-45: a row that opens a page of its own (キーの割り当て) on Enter / A or a click. */
  | { kind: 'page' };

/** 仮 (S-43): the steps of the sliders. */
const VOLUME_SLIDER: Control = { kind: 'slider', min: 0, max: 1, step: 0.05, fine: 0.01 };
/** 仮 (S-45): 歩行の揺れ and 覗いたときの歪み, 0..100 % of what they were, a quarter a step. */
const SHARE_SLIDER: Control = { kind: 'slider', min: 0, max: 1, step: 0.25, fine: 0.05 };

export const CONTROLS: Readonly<Record<SettingsRow, Control>> = {
  quality: { kind: 'choice', options: QUALITY_CHOICES },
  // 操作とカメラ > カメラ: 視野角70度(設定で60〜100度)
  fov: { kind: 'slider', min: FOV_MIN, max: FOV_MAX, step: 5, fine: 1 },
  peekMode: { kind: 'choice', options: ['hold', 'toggle'] },
  sensitivity: {
    kind: 'slider',
    min: MOUSE_SENSITIVITY_RANGE.min,
    max: MOUSE_SENSITIVITY_RANGE.max,
    step: 0.25,
    fine: 0.05,
  },
  invertY: { kind: 'toggle' },
  master: VOLUME_SLIDER,
  sfx: VOLUME_SLIDER,
  ambience: VOLUME_SLIDER,
  ui: VOLUME_SLIDER,
  lang: { kind: 'choice', options: ['ja', 'en'] },
  textSize: { kind: 'choice', options: TEXT_SIZES },
  contrast: { kind: 'toggle' },
  keys: { kind: 'page' },
  headBob: SHARE_SLIDER,
  reticle: { kind: 'toggle' },
  distortion: SHARE_SLIDER,
  reduceFlashes: { kind: 'toggle' },
  simpleTransitions: { kind: 'toggle' },
};

export type RowValue = string | number | boolean;

/** What a row shows. (A quality not chosen yet reads as mid: the host fills in the shell's choice before asking.) */
export function rowValue(s: Settings, row: SettingsRow): RowValue {
  switch (row) {
    case 'quality':
      return s.quality ?? 'mid';
    case 'fov':
      return s.fov;
    case 'peekMode':
      return s.peekMode;
    case 'sensitivity':
      return s.mouseSensitivity;
    case 'invertY':
      return s.invertY;
    case 'master':
    case 'sfx':
    case 'ambience':
    case 'ui':
      return s.volumes[row];
    case 'lang':
      return s.lang;
    case 'textSize':
      return s.textSize;
    case 'contrast':
      return s.contrast;
    case 'keys':
      // (a page, not a value: it never changes by a step)
      return 'keys';
    case 'headBob':
      return s.headBob;
    case 'reticle':
      return s.reticle;
    case 'distortion':
      return s.distortion;
    case 'reduceFlashes':
      return s.reduceFlashes;
    case 'simpleTransitions':
      return s.simpleTransitions;
  }
}

/** The settings with one row set (the value is assumed valid for the row: checked by the callers below). */
function withValue(s: Settings, row: SettingsRow, value: RowValue): Settings {
  switch (row) {
    case 'quality':
      return { ...s, quality: value as Settings['quality'] };
    case 'fov':
      return { ...s, fov: value as number };
    case 'peekMode':
      return { ...s, peekMode: value as Settings['peekMode'] };
    case 'sensitivity':
      return { ...s, mouseSensitivity: value as number };
    case 'invertY':
      return { ...s, invertY: value as boolean };
    case 'master':
    case 'sfx':
    case 'ambience':
    case 'ui':
      return { ...s, volumes: { ...s.volumes, [row]: value as number } };
    case 'lang':
      return { ...s, lang: value as Settings['lang'] };
    case 'textSize':
      return { ...s, textSize: value as Settings['textSize'] };
    case 'contrast':
      return { ...s, contrast: value as boolean };
    case 'keys':
      return s;
    case 'headBob':
      return { ...s, headBob: value as number };
    case 'reticle':
      return { ...s, reticle: value as boolean };
    case 'distortion':
      return { ...s, distortion: value as number };
    case 'reduceFlashes':
      return { ...s, reduceFlashes: value as boolean };
    case 'simpleTransitions':
      return { ...s, simpleTransitions: value as boolean };
  }
}

/** A slider's value snapped to `step` from its min, within its range (no float dust: 0.35, not 0.35000000000000003). */
function snap(control: Extract<Control, { kind: 'slider' }>, value: number, step: number): number {
  const n = Math.round((value - control.min) / step);
  const v = control.min + n * step;
  const clamped = Math.min(control.max, Math.max(control.min, v));
  return Math.round(clamped * 1e6) / 1e6;
}

/** Focus: a tab, and a row of it (-1 = on the tab strip). */
export interface PanelFocus {
  tab: number;
  row: number;
}

/** Where the panel opens: on the first tab's name. */
export const PANEL_START: PanelFocus = { tab: 0, row: -1 };

export type PanelCommand = 'up' | 'down' | 'left' | 'right' | 'choose' | 'back' | 'prevTab' | 'nextTab';

export interface PanelStep {
  focus: PanelFocus;
  settings: Settings;
  /** The row whose value changed (it takes effect at once, is kept, and rings), if any. */
  changed: SettingsRow | null;
  /** The focus moved (it lights and rings). */
  moved: boolean;
  /** Another tab is shown. */
  tabChanged: boolean;
  /** One step back: the panel closes (Esc / B). */
  close: boolean;
  /** S-45: the row's own page opens (キーの割り当て). */
  page?: 'keys';
}

export function rowAt(focus: PanelFocus): SettingsRow | null {
  const tab = SETTINGS_TABS[focus.tab];
  if (!tab || focus.row < 0) return null;
  return SETTINGS_ROWS[tab][focus.row] ?? null;
}

function rowsOf(tab: number): readonly SettingsRow[] {
  const t = SETTINGS_TABS[tab];
  return t ? SETTINGS_ROWS[t] : [];
}

const step = (focus: PanelFocus, settings: Settings, extra: Partial<PanelStep> = {}): PanelStep => ({
  focus,
  settings,
  changed: null,
  moved: false,
  tabChanged: false,
  close: false,
  ...extra,
});

/** A row's value moved one step: a choice to its neighbour (no wrap), a slider by its step, a toggle to on / off. */
function nudge(s: Settings, row: SettingsRow, dir: -1 | 1): RowValue {
  const c = CONTROLS[row];
  const now = rowValue(s, row);
  switch (c.kind) {
    case 'choice': {
      const i = c.options.indexOf(String(now));
      const next = Math.min(c.options.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir));
      return c.options[next] ?? String(now);
    }
    case 'slider':
      return snap(c, (now as number) + dir * c.step, c.step === c.fine ? c.step : c.fine);
    case 'toggle':
      return dir > 0;
    case 'page':
      return now;
  }
}

/** Enter / A on a row: a choice goes round, a toggle flips; a slider stays. */
function press(s: Settings, row: SettingsRow): RowValue {
  const c = CONTROLS[row];
  const now = rowValue(s, row);
  switch (c.kind) {
    case 'choice': {
      const i = c.options.indexOf(String(now));
      return c.options[(i + 1) % c.options.length] ?? String(now);
    }
    case 'slider':
    case 'page':
      return now;
    case 'toggle':
      return !now;
  }
}

function set(focus: PanelFocus, s: Settings, row: SettingsRow, value: RowValue): PanelStep {
  if (value === rowValue(s, row)) return step(focus, s);
  return step(focus, withValue(s, row, value), { changed: row });
}

function toTab(focus: PanelFocus, s: Settings, tab: number): PanelStep {
  const n = SETTINGS_TABS.length;
  const t = ((tab % n) + n) % n;
  const rows = rowsOf(t).length;
  const row = focus.row < 0 ? -1 : Math.min(rows - 1, focus.row);
  return step({ tab: t, row }, s, { moved: true, tabChanged: t !== focus.tab });
}

/**
 * One command on the panel (キーボード・パッド操作). On the tab strip, left / right go through the tabs and down (or
 * Enter) goes into the rows; on a row, up / down move between the rows (up from the first is the tab strip) and left /
 * right change its value; Enter goes round a choice or flips a toggle; Q / E (LB / RB) change the tab from anywhere;
 * Esc / B closes the panel.
 */
export function stepPanel(focus: PanelFocus, s: Settings, command: PanelCommand): PanelStep {
  const rows = rowsOf(focus.tab);
  const row = rowAt(focus);
  switch (command) {
    case 'back':
      return step(focus, s, { close: true });
    case 'prevTab':
      return toTab(focus, s, focus.tab - 1);
    case 'nextTab':
      return toTab(focus, s, focus.tab + 1);
    case 'up':
      if (focus.row < 0) return step(focus, s);
      return step({ tab: focus.tab, row: focus.row - 1 }, s, { moved: true });
    case 'down':
      if (focus.row >= rows.length - 1) return step(focus, s);
      return step({ tab: focus.tab, row: focus.row + 1 }, s, { moved: true });
    case 'left':
    case 'right': {
      const dir = command === 'left' ? -1 : 1;
      if (!row) return toTab(focus, s, focus.tab + dir);
      return set(focus, s, row, nudge(s, row, dir));
    }
    case 'choose':
      if (!row)
        return rows.length > 0 ? step({ tab: focus.tab, row: 0 }, s, { moved: true }) : step(focus, s);
      // S-45: a page's row opens its page
      if (CONTROLS[row].kind === 'page') return step(focus, s, { page: 'keys' });
      return set(focus, s, row, press(s, row));
  }
}

/** A tab clicked: it is shown, the focus on its name. */
export function pickTab(focus: PanelFocus, tab: number): Omit<PanelStep, 'settings' | 'changed'> {
  return {
    focus: { tab, row: -1 },
    moved: focus.tab !== tab || focus.row !== -1,
    tabChanged: focus.tab !== tab,
    close: false,
  };
}

/** The tab and row of a row. */
export function placeOf(row: SettingsRow): PanelFocus {
  for (let t = 0; t < SETTINGS_TABS.length; t++) {
    const tab = SETTINGS_TABS[t];
    const r = tab ? SETTINGS_ROWS[tab].indexOf(row) : -1;
    if (r >= 0) return { tab: t, row: r };
  }
  return PANEL_START;
}

/** An option of a choice or a toggle clicked: the row takes it, and the focus. An option that is not the row's is ignored. */
export function pickOption(focus: PanelFocus, s: Settings, row: SettingsRow, value: RowValue): PanelStep {
  const c = CONTROLS[row];
  const valid =
    (c.kind === 'choice' && typeof value === 'string' && c.options.includes(value)) ||
    (c.kind === 'toggle' && typeof value === 'boolean');
  if (!valid) return step(focus, s);
  const at = placeOf(row);
  const moved = at.tab !== focus.tab || at.row !== focus.row;
  return { ...set(at, s, row, value), moved, tabChanged: at.tab !== focus.tab };
}

/** A slider set from where the pointer is along it (0..1), on its fine step. */
export function setSlider(s: Settings, row: SettingsRow, fraction: number): Settings {
  const c = CONTROLS[row];
  if (c.kind !== 'slider') return s;
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return withValue(s, row, snap(c, c.min + f * (c.max - c.min), c.fine));
}

/** How far along its track a slider stands (0..1). */
export function sliderFraction(s: Settings, row: SettingsRow): number {
  const c = CONTROLS[row];
  if (c.kind !== 'slider') return 0;
  return ((rowValue(s, row) as number) - c.min) / (c.max - c.min);
}

/** The row a slider or an option belongs to (for the DOM's data attributes). */
export function isSettingsRow(value: unknown): value is SettingsRow {
  return typeof value === 'string' && value in CONTROLS;
}

/** キーボード: arrows and WASD, Enter and Space, Esc and Backspace; Q / E and PageUp / PageDown for the tabs. */
export function keyCommand(e: { key: string; code: string }): PanelCommand | null {
  switch (e.code) {
    case 'ArrowUp':
    case 'KeyW':
      return 'up';
    case 'ArrowDown':
    case 'KeyS':
      return 'down';
    case 'ArrowLeft':
    case 'KeyA':
      return 'left';
    case 'ArrowRight':
    case 'KeyD':
      return 'right';
    case 'Enter':
    case 'NumpadEnter':
    case 'Space':
      return 'choose';
    case 'Escape':
    case 'Backspace':
      return 'back';
    case 'KeyQ':
    case 'PageUp':
      return 'prevTab';
    case 'KeyE':
    case 'PageDown':
      return 'nextTab';
    default:
      return e.key === 'Escape' ? 'back' : e.key === 'Enter' ? 'choose' : null;
  }
}

/** ゲームパッド: 十字 move and change, A chooses, B (and Start) go back, LB / RB change the tab. */
const PAD_COMMANDS: Readonly<Record<string, PanelCommand>> = {
  PadUp: 'up',
  PadDown: 'down',
  PadLeft: 'left',
  PadRight: 'right',
  PadA: 'choose',
  PadB: 'back',
  PadStart: 'back',
  PadLB: 'prevTab',
  PadRB: 'nextTab',
};

/** The commands of the buttons pressed since the last reading (a held button counts once). */
export function padCommands(previous: ReadonlySet<string>, held: ReadonlySet<string>): PanelCommand[] {
  const out: PanelCommand[] = [];
  for (const code of held) {
    const command = PAD_COMMANDS[code];
    if (command && !previous.has(code)) out.push(command);
  }
  return out;
}

/** トランジション設計 > 遷移の一覧: 設定パネル — 曇りガラスが横に広がり、閉じると縮んで消える. */
export const PANEL_SECONDS = 0.3;

export type PanelPhase = 'closed' | 'opening' | 'open' | 'closing';

/**
 * Where the panel stands: `value` (0..1) is how far the frosted glass has spread sideways, on the glass curve
 * (遷移のルール 5). Closing plays the same curve back (戻るときは、来たときの動きを逆再生する); turned half way, it goes
 * on from where it is.
 */
export class PanelTimeline {
  private phaseValue: PanelPhase = 'closed';
  private t = 0;
  /**
   * S-45 簡易トランジション (fade.ts): the same 0.3 s as a white fade — the pane all there from the fade's middle, nothing
   * spreading. The time along it is the same either way, so the setting may change while the pane is open.
   */
  simple = false;

  get phase(): PanelPhase {
    return this.phaseValue;
  }

  get value(): number {
    const u = this.t / PANEL_SECONDS;
    if (this.simple) return fadeArrived(u) && this.t > 0 ? 1 : 0;
    return glassEase(u);
  }

  /** S-45: how white the screen is under the simple fade (0 under the glass's own). */
  get white(): number {
    return this.simple ? fadeWhite(this.t / PANEL_SECONDS) : 0;
  }

  /** It takes commands once it is all there. */
  get interactive(): boolean {
    return this.phaseValue === 'open';
  }

  open(): boolean {
    if (this.phaseValue === 'opening' || this.phaseValue === 'open') return false;
    this.phaseValue = 'opening';
    return true;
  }

  close(): boolean {
    if (this.phaseValue === 'closed' || this.phaseValue === 'closing') return false;
    this.phaseValue = 'closing';
    return true;
  }

  /** Dev hold (screenshots): stands the opening at this many seconds in. */
  holdAt(seconds: number): void {
    if (this.phaseValue !== 'opening') return;
    this.t = Math.min(PANEL_SECONDS, Math.max(0, seconds));
  }

  update(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    // S-45: the simple fade lands on its middle (all white) for a frame when it would step over it
    const move = (by: number): number =>
      this.simple ? fadeStep(this.t / PANEL_SECONDS, by / PANEL_SECONDS) * PANEL_SECONDS : this.t + by;
    if (this.phaseValue === 'opening') {
      this.t = Math.min(PANEL_SECONDS, move(dt));
      if (this.t >= PANEL_SECONDS - 1e-9) {
        this.t = PANEL_SECONDS;
        this.phaseValue = 'open';
      }
    } else if (this.phaseValue === 'closing') {
      this.t = Math.max(0, move(-dt));
      if (this.t <= 1e-9) {
        this.t = 0;
        this.phaseValue = 'closed';
      }
    }
  }
}
