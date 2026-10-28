import type { Bindings } from '../../game/input/bindings';
import { keyLabel, NO_KEY } from '../../game/input/key-labels';
import type { Lang, StringKey } from '../lang';
import {
  ACTION_KEY,
  cellOf,
  FOOT_ROW,
  fixedCell,
  KEY_COLS,
  KEY_ROWS,
  type KeysFocus,
  type KeysWaiting,
} from './keys-logic';

/**
 * キーの割り当て (S-45): the DOM of the key page the settings open from 操作 — on the same frosted pane, in place of the tab's
 * rows: its title and a line of how to use it, a list of the actions (a frosted tag per key: キー, キー（副）, パッド; the pad's
 * moves are its left stick), the fixed keys, the line telling what was swapped, and 初期に戻す / 戻る. The cell that waits reads
 * 「キーを押してください」 and breathes (slower than once a second: no blinking). Keys and the pad are the host's (settings-host.ts);
 * a click on a cell or a button of the foot is told through `onPick`. The look is in src/ui/styles.ts (.vd-keys).
 */

export interface KeysView {
  focus: KeysFocus;
  waiting: KeysWaiting | null;
  bindings: Bindings;
  /** The line under the list (what was swapped, or that the defaults are back), or null. */
  notice: string | null;
  lang: Lang;
  /** It takes commands (the pane is all there). */
  interactive: boolean;
}

export interface KeysPageEvents {
  /** A cell or a button of the foot was clicked. */
  onPick(at: KeysFocus): void;
  /** The pointer reached one (it swells and rings). */
  onHover(at: KeysFocus): void;
}

interface Cell {
  at: KeysFocus;
  el: HTMLElement;
}

/** What a cell that waits shows (the words are over the list: 「…のキーを押してください」), breathing. */
const WAITING = '…';

export class KeysPage {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly heads: { el: HTMLElement; key: StringKey }[] = [];
  private readonly actions: { el: HTMLElement; key: StringKey }[] = [];
  private readonly cells: Cell[] = [];
  private readonly list: HTMLElement;
  private readonly fixed: HTMLElement;
  private readonly fixedPad: HTMLElement;
  private readonly fixedNote: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly reset: HTMLButtonElement;
  private readonly back: HTMLButtonElement;
  private t: (k: StringKey) => string;
  private drawn: { view: KeysView; focusEl: HTMLElement | null } | null = null;
  private shown = false;
  private enabled = false;

  constructor(t: (k: StringKey) => string, events: KeysPageEvents) {
    this.t = t;
    this.el = document.createElement('div');
    this.el.className = 'vd-settings__page vd-keys';
    this.el.dataset.page = 'keys';
    this.el.setAttribute('role', 'group');
    this.el.hidden = true;
    this.title = document.createElement('p');
    this.title.className = 'vd-keys__title';
    this.title.dataset.part = 'keys-title';
    this.hint = document.createElement('p');
    this.hint.className = 'vd-keys__hint';
    this.hint.dataset.part = 'keys-prompt';
    this.hint.setAttribute('role', 'status');

    const head = document.createElement('div');
    head.className = 'vd-keys__row vd-keys__head';
    head.appendChild(document.createElement('span'));
    for (const key of ['keysColKey', 'keysColKey2', 'keysColPad'] as const) {
      const h = document.createElement('span');
      h.className = 'vd-keys__colhead';
      head.appendChild(h);
      this.heads.push({ el: h, key });
    }

    this.list = document.createElement('div');
    this.list.className = 'vd-keys__list';
    KEY_ROWS.forEach((action, row) => {
      const line = document.createElement('div');
      line.className = 'vd-keys__row';
      const name = document.createElement('span');
      name.className = 'vd-keys__action';
      name.dataset.part = 'keys-action';
      line.appendChild(name);
      this.actions.push({ el: name, key: ACTION_KEY[action] });
      KEY_COLS.forEach((_, col) => {
        const fixedOne = fixedCell(row, col);
        const c = document.createElement(fixedOne ? 'span' : 'button');
        c.className = fixedOne ? 'vd-keys__cell vd-keys__cell--fixed' : 'vd-keys__cell vd-settings__chip';
        c.dataset.keyCell = `${row}:${col}`;
        if (c instanceof HTMLButtonElement) {
          c.type = 'button';
          c.tabIndex = -1;
          c.addEventListener('click', () => {
            if (this.enabled) events.onPick({ row, col });
          });
          this.hoverable(c, { row, col }, events);
          this.cells.push({ at: { row, col }, el: c });
        }
        line.appendChild(c);
      });
      this.list.appendChild(line);
    });

    // the fixed ones last, as a row of their own that cannot be chosen: ポーズ・戻る — Esc / Start・B
    const fixedLine = document.createElement('div');
    fixedLine.className = 'vd-keys__row vd-keys__row--fixed';
    this.fixed = document.createElement('span');
    this.fixed.className = 'vd-keys__action';
    const esc = document.createElement('span');
    esc.className = 'vd-keys__cell vd-keys__cell--fixed';
    esc.dataset.keyFixed = '';
    esc.textContent = 'Esc';
    this.fixedPad = document.createElement('span');
    this.fixedPad.className = 'vd-keys__cell vd-keys__cell--fixed';
    this.fixedPad.dataset.keyFixed = '';
    this.fixedNote = document.createElement('span');
    this.fixedNote.className = 'vd-keys__cell vd-keys__cell--fixed';
    fixedLine.append(this.fixed, esc, this.fixedNote, this.fixedPad);
    this.list.appendChild(fixedLine);
    this.notice = document.createElement('p');
    this.notice.className = 'vd-keys__notice';
    this.notice.dataset.part = 'keys-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.hidden = true;

    const foot = document.createElement('div');
    foot.className = 'vd-keys__foot';
    const footButton = (col: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vd-settings__chip vd-keys__button';
      b.tabIndex = -1;
      b.addEventListener('click', () => {
        if (this.enabled) events.onPick({ row: FOOT_ROW, col });
      });
      this.hoverable(b, { row: FOOT_ROW, col }, events);
      this.cells.push({ at: { row: FOOT_ROW, col }, el: b });
      return b;
    };
    this.reset = footButton(0);
    this.reset.dataset.keysReset = '';
    this.back = footButton(1);
    this.back.dataset.keysBack = '';
    foot.append(this.reset, this.back);

    this.el.append(this.title, this.hint, head, this.list, this.notice, foot);
    this.relabel(t);
  }

  /** Swaps the words (設定 > 言語). The cells are written again at the next render. */
  relabel(t: (k: StringKey) => string): void {
    this.t = t;
    this.title.textContent = t('keysTitle');
    this.hint.textContent = t('keysHint');
    for (const h of this.heads) h.el.textContent = t(h.key);
    for (const a of this.actions) a.el.textContent = t(a.key);
    this.fixed.textContent = t('keysFixed');
    this.fixedPad.textContent = t('keysFixedPad');
    this.fixedNote.textContent = t('keysFixedNote');
    this.reset.textContent = t('keysReset');
    this.back.textContent = t('setBack');
    this.el.setAttribute('aria-label', t('keysTitle'));
    this.drawn = null;
  }

  /** The page shown (`view`) or not (null). Writes the cells only when what they show changed. */
  render(view: KeysView | null): void {
    const show = view !== null;
    if (show !== this.shown) {
      this.shown = show;
      this.el.hidden = !show;
      this.drawn = null;
    }
    this.setEnabled(show && (view?.interactive ?? false));
    if (!view) return;
    const d = this.drawn;
    const focusEl = view.interactive ? this.elementOf(view.focus) : null;
    if (
      d &&
      d.focusEl === focusEl &&
      d.view.bindings === view.bindings &&
      d.view.waiting === view.waiting &&
      d.view.notice === view.notice &&
      d.view.lang === view.lang
    )
      return;
    this.drawn = { view, focusEl };
    // every cell: the key bound, or 「キーを押してください」 while it waits; the pad's moves are the left stick
    for (const el of this.list.querySelectorAll<HTMLElement>('[data-key-cell]')) {
      const [r, c] = (el.dataset.keyCell ?? '0:0').split(':').map(Number) as [number, number];
      let text: string;
      let waiting = false;
      if (fixedCell(r, c)) text = this.t('keysStick');
      else {
        const cell = cellOf(r, c);
        const w = view.waiting;
        waiting =
          cell !== null &&
          w !== null &&
          w.action === cell.action &&
          w.device === cell.device &&
          w.slot === cell.slot;
        if (waiting) text = WAITING;
        else {
          const code = cell ? view.bindings[cell.device][cell.action][cell.slot] : undefined;
          text = code ? keyLabel(code, view.lang) : NO_KEY;
        }
      }
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('is-waiting', waiting);
    }
    for (const cell of this.cells) cell.el.classList.toggle('is-focus', cell.el === focusEl);
    // 「キーを押してください」 over the list while a cell waits, naming the action, and how to give it up
    const w = view.waiting;
    const hint = w
      ? `${this.t(w.device === 'gamepad' ? 'keysWaitPad' : 'keysWaitKey').replace('{action}', this.t(ACTION_KEY[w.action]))}　${this.t('keysWaitNote')}`
      : this.t('keysHint');
    if (this.hint.textContent !== hint) this.hint.textContent = hint;
    this.hint.classList.toggle('is-waiting', w !== null);
    this.notice.hidden = view.notice === null;
    if (view.notice !== null && this.notice.textContent !== view.notice)
      this.notice.textContent = view.notice;
    if (focusEl) focusEl.scrollIntoView({ block: 'nearest' });
  }

  /** Moves the browser's focus onto the focused cell (screen readers and Tab follow). */
  focus(focus: KeysFocus): void {
    this.elementOf(focus)?.focus({ preventScroll: true });
  }

  /** The element of a cell or a button of the foot. */
  elementOf(at: KeysFocus): HTMLElement | null {
    return this.cells.find((c) => c.at.row === at.row && c.at.col === at.col)?.el ?? null;
  }

  /** ホバーすると膨らんで鳴る: the tag swells while the pointer is on it, and rings once the page takes commands. */
  private hoverable(el: HTMLElement, at: KeysFocus, events: KeysPageEvents): void {
    el.addEventListener('pointerenter', () => {
      el.classList.add('is-hover');
      if (this.enabled) events.onHover(at);
    });
    el.addEventListener('pointerleave', () => el.classList.remove('is-hover'));
  }

  private setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const c of this.cells) c.el.tabIndex = on ? 0 : -1;
  }
}
