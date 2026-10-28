import type { StringKey } from '../lang';
import {
  CONTROLS,
  type PanelFocus,
  type RowValue,
  rowValue,
  SETTINGS_ROWS,
  SETTINGS_TABS,
  type SettingsRow,
  type SettingsTab,
  sliderFraction,
} from './settings-logic';
import type { Settings } from './settings-model';

/**
 * 設定 (UI/UX設計 > 画面ごとの設計): the DOM of the settings panel — a pane of frosted glass that spreads sideways (0.3 s),
 * the tabs 画質 / 操作 / 音 / 表示とアクセシビリティ on it, each setting a row: a choice of small frosted tags, a slider (a
 * groove of clear glass with a drop riding it), or an オフ | オン pair. All glass (UIの原則 2), the text on frost (原則 5).
 * The look is in src/ui/styles.ts (.vd-settings); this sets what changes per frame. Keys and the pad are the host's.
 *
 * No ancestor of the frosted pane has opacity, a filter, a mask or a clip-path (they would cut its frost off from the
 * picture behind); the body over it is revealed with a clip-path of its own and holds no backdrop filter.
 */

/** What the pointer is on: a tab, an option of a row, a row (its slider), or the back button. */
export type PanelTarget =
  | { kind: 'tab'; tab: number }
  | { kind: 'option'; row: SettingsRow; value: RowValue }
  | { kind: 'row'; row: SettingsRow }
  | { kind: 'back' };

export interface PanelEvents {
  /** The pointer reached something that answers (ホバーすると膨らんで鳴る). */
  onHover(target: PanelTarget): void;
  /** A tab or an option was clicked. */
  onPick(target: PanelTarget): void;
  /** A slider is pressed or dragged: where along it (0..1). `done` once the pointer is let go. */
  onSlide(row: SettingsRow, fraction: number, done: boolean): void;
  /** The browser moved the focus (Tab) onto a tab or a row. */
  onFocus(focus: PanelFocus): void;
}

export interface PanelView {
  /** 0..1: how far the pane has spread. */
  open: number;
  /** It takes commands (all there). */
  interactive: boolean;
  focus: PanelFocus;
  values: Settings;
  /** The line telling that nothing can be kept: 0..1 shown. */
  notice: number;
  /** The preset in use is not the one the scene was made with: part of it waits for the next time (S-43). */
  qualityLater: boolean;
}

interface RowParts {
  row: SettingsRow;
  el: HTMLElement;
  label: HTMLElement;
  labelKey: StringKey;
  options: { el: HTMLButtonElement; value: RowValue; key: StringKey }[];
  track: HTMLElement | null;
  value: HTMLElement | null;
}

const TAB_KEY: Readonly<Record<SettingsTab, StringKey>> = {
  graphics: 'setTabGraphics',
  controls: 'setTabControls',
  sound: 'setTabSound',
  display: 'setTabDisplay',
};

const ROW_KEY: Readonly<Record<SettingsRow, StringKey>> = {
  quality: 'setQuality',
  fov: 'setFov',
  peekMode: 'setPeek',
  sensitivity: 'setSensitivity',
  invertY: 'setInvertY',
  master: 'setMaster',
  sfx: 'setSfx',
  ambience: 'setAmbience',
  ui: 'setUi',
  lang: 'setLang',
  textSize: 'setTextSize',
  contrast: 'setContrast',
};

/** The words of each option of the choices. */
const OPTION_KEY: Readonly<Record<string, StringKey>> = {
  'quality:auto': 'setQualityAuto',
  'quality:low': 'setQualityLow',
  'quality:mid': 'setQualityMid',
  'quality:high': 'setQualityHigh',
  'peekMode:hold': 'setPeekHold',
  'peekMode:toggle': 'setPeekToggle',
  'lang:ja': 'setLangJa',
  'lang:en': 'setLangEn',
  'textSize:normal': 'setTextNormal',
  'textSize:large': 'setTextLarge',
  'textSize:larger': 'setTextLarger',
};

/** Time a chosen option stays sunk (細部の振る舞い: 選ぶと弾けずに沈み込む). */
const PRESS_SECONDS = 0.38;

/** How a slider's value reads. */
function formatValue(row: SettingsRow, s: Settings): string {
  const v = rowValue(s, row) as number;
  if (row === 'fov') return `${Math.round(v)}°`;
  if (row === 'sensitivity') return `×${v.toFixed(2).replace(/0$/, '')}`;
  return String(Math.round(v * 100));
}

export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly glass: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs: { tab: SettingsTab; el: HTMLButtonElement }[] = [];
  private readonly pages: { tab: SettingsTab; el: HTMLElement }[] = [];
  private readonly rows = new Map<SettingsRow, RowParts>();
  private readonly back: HTMLButtonElement;
  private readonly keys: HTMLElement;
  private readonly notice: HTMLElement;
  /** Under 品質: 「一部は次に開いたときから変わります」 (only while it is so). */
  private readonly qualityLater: HTMLElement;
  /** What the rows were last written for. */
  private drawnFocus: HTMLElement | null | undefined = undefined;
  private drawnValues: Settings | null = null;
  private shownTab = -1;
  private enabled = false;
  private hoverEl: HTMLElement | null = null;
  private pointerX = Number.NaN;
  private pointerY = Number.NaN;
  private sliding: { row: SettingsRow; track: HTMLElement; pointer: number } | null = null;
  private readonly pressed = new Map<HTMLElement, number>();
  /** Last values written to the DOM, by element and property. */
  private readonly last = new Map<HTMLElement, Map<string, string>>();

  constructor(
    root: HTMLElement,
    t: (k: StringKey) => string,
    private readonly events: PanelEvents,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'vd-settings';
    this.el.dataset.ui = 'settings';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', t('setLabel'));
    this.glass = document.createElement('div');
    this.glass.className = 'vd-settings__glass';
    this.glass.dataset.part = 'glass';
    this.body = document.createElement('div');
    this.body.className = 'vd-settings__body';
    this.qualityLater = document.createElement('p');
    this.qualityLater.className = 'vd-settings__hint';
    this.qualityLater.dataset.part = 'quality-later';
    this.qualityLater.textContent = t('setQualityLater');
    this.qualityLater.hidden = true;

    const strip = document.createElement('div');
    strip.className = 'vd-settings__tabs';
    strip.setAttribute('role', 'tablist');
    SETTINGS_TABS.forEach((tab, index) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vd-settings__tab';
      b.dataset.tab = tab;
      b.setAttribute('role', 'tab');
      b.textContent = t(TAB_KEY[tab]);
      b.addEventListener('click', () => {
        if (this.enabled) this.events.onPick({ kind: 'tab', tab: index });
      });
      b.addEventListener('focus', () => {
        if (this.enabled) this.events.onFocus({ tab: index, row: -1 });
      });
      strip.appendChild(b);
      this.tabs.push({ tab, el: b });
    });
    this.body.appendChild(strip);

    SETTINGS_TABS.forEach((tab, tabIndex) => {
      const page = document.createElement('div');
      page.className = 'vd-settings__page';
      page.dataset.page = tab;
      page.setAttribute('role', 'tabpanel');
      page.hidden = true;
      SETTINGS_ROWS[tab].forEach((row, rowIndex) => {
        page.appendChild(this.makeRow(t, row, { tab: tabIndex, row: rowIndex }));
        if (row === 'quality') page.appendChild(this.qualityLater);
      });
      this.body.appendChild(page);
      this.pages.push({ tab, el: page });
    });

    const foot = document.createElement('div');
    foot.className = 'vd-settings__foot';
    this.back = document.createElement('button');
    this.back.type = 'button';
    this.back.className = 'vd-settings__back vd-settings__chip';
    this.back.dataset.settingsBack = '';
    this.back.textContent = t('setBack');
    this.back.addEventListener('click', () => {
      if (this.enabled) this.events.onPick({ kind: 'back' });
    });
    this.keys = document.createElement('span');
    this.keys.className = 'vd-settings__keys';
    this.keys.textContent = t('setKeys');
    this.notice = document.createElement('p');
    this.notice.className = 'vd-settings__notice';
    this.notice.dataset.part = 'notice';
    this.notice.setAttribute('role', 'status');
    this.notice.textContent = t('setCannotSave');
    foot.append(this.back, this.keys);
    this.body.append(foot);
    // the notice hangs under the pane (outside the body's clip), on its own frost, only while it is shown
    this.notice.hidden = true;
    this.el.append(this.glass, this.body, this.notice);

    // hover follows the pointer's moves only (a panel shown under a resting pointer must not take the keys' focus)
    this.el.addEventListener('pointermove', (e) => {
      if (this.sliding && e.pointerId === this.sliding.pointer) {
        this.events.onSlide(this.sliding.row, this.fractionAt(this.sliding.track, e.clientX), false);
        return;
      }
      if (e.clientX === this.pointerX && e.clientY === this.pointerY) return;
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.setHover(e.target instanceof Element ? e.target : null);
    });
    this.el.addEventListener('pointerleave', () => this.setHover(null));
    const endSlide = (e: PointerEvent): void => {
      const s = this.sliding;
      if (!s || e.pointerId !== s.pointer) return;
      this.sliding = null;
      this.events.onSlide(s.row, this.fractionAt(s.track, e.clientX), true);
    };
    this.el.addEventListener('pointerup', endSlide);
    this.el.addEventListener('pointercancel', endSlide);
    root.appendChild(this.el);
    this.setEnabled(false);
  }

  /** Swaps the words (設定 > 言語: the panel's text changes at once). */
  relabel(t: (k: StringKey) => string): void {
    this.el.setAttribute('aria-label', t('setLabel'));
    for (const { tab, el } of this.tabs) el.textContent = t(TAB_KEY[tab]);
    for (const parts of this.rows.values()) {
      parts.label.textContent = t(parts.labelKey);
      for (const o of parts.options) o.el.textContent = t(o.key);
      parts.el.setAttribute('aria-label', t(parts.labelKey));
    }
    this.back.textContent = t('setBack');
    this.keys.textContent = t('setKeys');
    this.notice.textContent = t('setCannotSave');
    this.qualityLater.textContent = t('setQualityLater');
  }

  /** Moves the browser's focus onto the focused tab or row (screen readers and Tab follow). */
  focus(focus: PanelFocus): void {
    this.elementOf(focus)?.focus({ preventScroll: true });
  }

  /** The option (or the tab) chosen sinks for a moment. */
  press(target: PanelTarget): void {
    const el = this.elementOfTarget(target);
    if (!el) return;
    el.classList.add('is-pressed');
    this.pressed.set(el, PRESS_SECONDS);
  }

  render(dt: number, view: PanelView): void {
    const up = view.open > 0;
    this.el.classList.toggle('is-up', up);
    this.setEnabled(up && view.interactive);
    for (const [el, left] of this.pressed) {
      const next = left - dt;
      if (next <= 0) {
        el.classList.remove('is-pressed');
        this.pressed.delete(el);
      } else this.pressed.set(el, next);
    }
    if (!up) {
      if (this.sliding) this.sliding = null;
      this.setHover(null);
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.el.contains(active)) active.blur();
      return;
    }
    this.set(this.el, '--open', view.open.toFixed(3));
    this.notice.hidden = view.notice <= 0;
    this.set(this.notice, '--notice', view.notice.toFixed(3));

    if (view.focus.tab !== this.shownTab) {
      this.shownTab = view.focus.tab;
      this.pages.forEach((p, i) => {
        p.el.hidden = i !== view.focus.tab;
      });
      this.tabs.forEach((tb, i) => {
        tb.el.classList.toggle('is-shown', i === view.focus.tab);
        tb.el.setAttribute('aria-selected', String(i === view.focus.tab));
      });
    }
    this.qualityLater.hidden = !view.qualityLater;
    const focused = view.interactive ? this.elementOf(view.focus) : null;
    // the rows are written only when what they show changed (the values are replaced on every change, never edited)
    if (focused === this.drawnFocus && view.values === this.drawnValues) return;
    this.drawnFocus = focused;
    this.drawnValues = view.values;
    for (const tb of this.tabs) tb.el.classList.toggle('is-focus', tb.el === focused);
    for (const parts of this.rows.values()) {
      parts.el.classList.toggle('is-focus', parts.el === focused);
      const value = rowValue(view.values, parts.row);
      for (const o of parts.options) {
        const on = o.value === value;
        o.el.classList.toggle('is-chosen', on);
        o.el.setAttribute('aria-pressed', String(on));
      }
      if (parts.track) {
        this.set(parts.track, '--at', sliderFraction(view.values, parts.row).toFixed(4));
        const text = formatValue(parts.row, view.values);
        if (parts.value && parts.value.textContent !== text) parts.value.textContent = text;
        parts.el.setAttribute('aria-valuenow', String(value));
        parts.el.setAttribute('aria-valuetext', text);
      }
    }
  }

  dispose(): void {
    this.el.remove();
  }

  private makeRow(t: (k: StringKey) => string, row: SettingsRow, place: PanelFocus): HTMLElement {
    const el = document.createElement('div');
    el.className = 'vd-settings__row';
    el.dataset.row = row;
    el.setAttribute('aria-label', t(ROW_KEY[row]));
    const label = document.createElement('span');
    label.className = 'vd-settings__label';
    label.textContent = t(ROW_KEY[row]);
    const control = document.createElement('span');
    control.className = 'vd-settings__control';
    el.append(label, control);
    const parts: RowParts = {
      row,
      el,
      label,
      labelKey: ROW_KEY[row],
      options: [],
      track: null,
      value: null,
    };
    const c = CONTROLS[row];
    if (c.kind === 'slider') {
      el.setAttribute('role', 'slider');
      el.setAttribute('aria-valuemin', String(c.min));
      el.setAttribute('aria-valuemax', String(c.max));
      const track = document.createElement('span');
      track.className = 'vd-settings__track';
      track.dataset.track = row;
      track.innerHTML =
        '<span class="vd-settings__groove"></span><span class="vd-settings__fill"></span>' +
        '<span class="vd-settings__bead"></span>';
      track.addEventListener('pointerdown', (e) => {
        if (!this.enabled || e.button !== 0) return;
        e.preventDefault();
        this.sliding = { row, track, pointer: e.pointerId };
        try {
          this.el.setPointerCapture(e.pointerId);
        } catch {
          // a synthetic pointer cannot be captured: the moves still reach the panel
        }
        this.events.onSlide(row, this.fractionAt(track, e.clientX), false);
      });
      const value = document.createElement('span');
      value.className = 'vd-settings__value';
      control.append(track, value);
      parts.track = track;
      parts.value = value;
    } else {
      el.setAttribute('role', 'group');
      const options: { value: RowValue; key: StringKey }[] =
        c.kind === 'toggle'
          ? [
              { value: false, key: 'setOff' },
              { value: true, key: 'setOn' },
            ]
          : c.options.map((o) => ({ value: o, key: OPTION_KEY[`${row}:${o}`] ?? 'setOff' }));
      for (const o of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vd-settings__option vd-settings__chip';
        b.dataset.option = String(o.value);
        b.dataset.row = row;
        b.tabIndex = -1;
        b.textContent = t(o.key);
        b.addEventListener('click', () => {
          if (this.enabled) this.events.onPick({ kind: 'option', row, value: o.value });
        });
        control.appendChild(b);
        parts.options.push({ el: b, value: o.value, key: o.key });
      }
    }
    el.addEventListener('focus', () => {
      if (this.enabled) this.events.onFocus(place);
    });
    this.rows.set(row, parts);
    return el;
  }

  private fractionAt(track: HTMLElement, clientX: number): number {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? (clientX - r.left) / r.width : 0;
  }

  private elementOf(focus: PanelFocus): HTMLElement | null {
    if (focus.row < 0) return this.tabs[focus.tab]?.el ?? null;
    const tab = SETTINGS_TABS[focus.tab];
    const row = tab ? SETTINGS_ROWS[tab][focus.row] : undefined;
    return row ? (this.rows.get(row)?.el ?? null) : null;
  }

  private elementOfTarget(target: PanelTarget): HTMLElement | null {
    switch (target.kind) {
      case 'tab':
        return this.tabs[target.tab]?.el ?? null;
      case 'option':
        return this.rows.get(target.row)?.options.find((o) => o.value === target.value)?.el ?? null;
      case 'row':
        return this.rows.get(target.row)?.el ?? null;
      case 'back':
        return this.back;
    }
  }

  /** What answers under an element: a tab, an option, a slider's row, the back button. */
  private targetOf(el: Element | null): { el: HTMLElement; target: PanelTarget } | null {
    if (!el) return null;
    const tab = el.closest<HTMLElement>('[data-tab]');
    if (tab) {
      const i = this.tabs.findIndex((x) => x.el === tab);
      if (i >= 0) return { el: tab, target: { kind: 'tab', tab: i } };
    }
    const option = el.closest<HTMLButtonElement>('.vd-settings__option');
    if (option) {
      for (const parts of this.rows.values()) {
        const o = parts.options.find((x) => x.el === option);
        if (o) return { el: option, target: { kind: 'option', row: parts.row, value: o.value } };
      }
    }
    const track = el.closest<HTMLElement>('[data-track]');
    if (track) {
      for (const parts of this.rows.values())
        if (parts.track === track) return { el: track, target: { kind: 'row', row: parts.row } };
    }
    if (el.closest('[data-settings-back]')) return { el: this.back, target: { kind: 'back' } };
    return null;
  }

  /** The thing under the pointer swells (表面張力) and, once the panel takes commands, rings. */
  private setHover(el: Element | null): void {
    const hit = this.targetOf(el);
    const next = hit?.el ?? null;
    if (next === this.hoverEl) return;
    this.hoverEl?.classList.remove('is-hover');
    this.hoverEl = next;
    next?.classList.add('is-hover');
    if (hit && this.enabled) this.events.onHover(hit.target);
  }

  private setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.el.classList.toggle('is-interactive', on);
    for (const tb of this.tabs) tb.el.tabIndex = on ? 0 : -1;
    for (const parts of this.rows.values()) parts.el.tabIndex = on ? 0 : -1;
    this.back.tabIndex = on ? 0 : -1;
  }

  /** Sets a custom property only when it changed (most frames change nothing). */
  private set(el: HTMLElement, prop: string, value: string): void {
    let props = this.last.get(el);
    if (!props) {
      props = new Map();
      this.last.set(el, props);
    }
    if (props.get(prop) === value) return;
    props.set(prop, value);
    el.style.setProperty(prop, value);
  }
}
