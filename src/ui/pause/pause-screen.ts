import { segment } from '../../core/transition';
import type { StringKey } from '../lang';
import { CONFIRM_ITEMS, lineWriting, PAUSE_ITEMS, type PauseChoice, type PausePage } from './pause-logic';

/**
 * ポーズ (UI/UX設計 > 画面ごとの設計): the DOM of the pause, over the stopped picture. All glass (UIの原則 2): a breath of
 * frost spreading from the middle of the screen, the items written on frosted tags with a finger (a light at the finger
 * runs left to right), the question of the title as two answers on the frost, and a small frosted line about the mouse.
 * The look is in src/ui/styles.ts (.vd-pause); this sets what changes per frame. Keys and the pad are the host's.
 */

/**
 * 仮: the breath's soft edge (× the half diagonal of the screen), and how far its solid middle reaches when it is all there
 * (a little past the corners: its middle is a little low, and it is then shown unmasked).
 */
const FROST_SOFT = 0.5;
const FROST_CORE = 1.04;
/** 仮: the blur of the breath grows as it spreads (px at 1080p, scaled with the screen's height). */
const BLUR_FROM = 2;
const BLUR_TO = 12;
/** Time a chosen item stays sunk (as the home drops: 細部の振る舞い 選ぶと弾けずに沈み込む). */
const PRESS_SECONDS = 0.38;

export interface PauseView {
  /** The pause is on the screen (also while it clears). */
  up: boolean;
  frost: number;
  writing: number;
  page: PausePage;
  focused: PauseChoice | null;
  interactive: boolean;
  /** The settings are open over the pause (S-43): the items step aside, the frost thins so the picture shows. */
  yielded: boolean;
}

export interface PauseScreenEvents {
  /** The pointer reached an item (画面ごとの設計: ホバーすると膨らんで鳴る). */
  onHover(item: PauseChoice): void;
  /** An item was clicked (or pressed with the browser's own keys on a focused button). */
  onPick(item: PauseChoice): void;
  /** The browser moved the focus to an item (Tab). */
  onFocus(item: PauseChoice): void;
}

interface Line {
  /** The frosted tag the line is written on. */
  tag: HTMLElement;
  line: HTMLElement;
  /** The words, and which they are (the language can change: S-43). */
  ink: HTMLElement;
  key: StringKey;
}

interface Item extends Line {
  id: PauseChoice;
  button: HTMLButtonElement;
  pressTimer: number;
}

const STRING_OF: Readonly<Record<PauseChoice, StringKey>> = {
  resume: 'pauseResume',
  settings: 'pauseSettings',
  title: 'pauseTitle',
  yes: 'pauseYes',
  no: 'pauseNo',
};

function writtenLine(t: (k: StringKey) => string, key: StringKey): Line {
  const tag = document.createElement('span');
  tag.className = 'vd-pause__tag vd-frost';
  tag.dataset.part = 'tag';
  const line = document.createElement('span');
  line.className = 'vd-pause__line';
  const ink = document.createElement('span');
  ink.className = 'vd-pause__ink';
  ink.dataset.part = 'ink';
  ink.textContent = t(key);
  const tip = document.createElement('span');
  tip.className = 'vd-pause__tip';
  tip.setAttribute('aria-hidden', 'true');
  line.append(ink, tip);
  tag.appendChild(line);
  return { tag, line, ink, key };
}

export class PauseScreen {
  readonly el: HTMLElement;
  private readonly breath: HTMLElement;
  private readonly pages: Record<PausePage, HTMLElement>;
  private readonly lines: Record<PausePage, Line[]>;
  private readonly items: Item[] = [];
  private readonly note: HTMLElement;
  private hoverItem: PauseChoice | null = null;
  private shownPage: PausePage | null = null;
  private wasUp = false;
  private halfDiagonal = 734;
  private blurScale = 1;
  private enabled = false;
  /** Where the pointer last moved to (a layout change under it sends a move to the same place). */
  private pointerX = Number.NaN;
  private pointerY = Number.NaN;
  /** Last values written to the DOM, by element and property. */
  private readonly last = new Map<HTMLElement, Map<string, number>>();
  /** The pointer moved since the page shown now came up (clicks on a page shown later wait for it). */
  private pageMoved = true;
  /** How far the page shown is written (0..1). */
  private writing = 0;
  private readonly noteText: HTMLElement;

  constructor(
    root: HTMLElement,
    t: (k: StringKey) => string,
    private readonly events: PauseScreenEvents,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'vd-pause';
    this.el.dataset.ui = 'pause';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', t('pauseLabel'));
    this.breath = document.createElement('div');
    this.breath.className = 'vd-pause__breath';
    this.breath.dataset.part = 'breath';

    const menu = document.createElement('nav');
    menu.className = 'vd-pause__page';
    menu.dataset.page = 'menu';
    const menuLines = PAUSE_ITEMS.map((id) => this.item(id, t, menu));

    const confirm = document.createElement('div');
    confirm.className = 'vd-pause__page';
    confirm.dataset.page = 'confirm';
    confirm.hidden = true;
    const ask = document.createElement('p');
    ask.className = 'vd-pause__ask';
    const asked = writtenLine(t, 'pauseAsk');
    ask.appendChild(asked.tag);
    const choices = document.createElement('div');
    choices.className = 'vd-pause__choices';
    confirm.append(ask, choices);
    const confirmLines = [asked, ...CONFIRM_ITEMS.map((id) => this.item(id, t, choices))];

    this.note = document.createElement('p');
    this.note.className = 'vd-pause__note';
    const noteText = document.createElement('span');
    noteText.className = 'vd-frost';
    noteText.dataset.part = 'relock';
    noteText.textContent = t('pauseRelock');
    this.note.appendChild(noteText);
    this.noteText = noteText;

    this.pages = { menu, confirm };
    this.lines = { menu: menuLines, confirm: confirmLines };
    this.el.append(this.breath, menu, confirm, this.note);
    // Hover follows the pointer's moves only: a page shown under a resting pointer (the items, back from the question)
    // must not take the focus the keys or the pad gave
    this.el.addEventListener('pointermove', (e) => {
      if (e.clientX === this.pointerX && e.clientY === this.pointerY) return;
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      this.pageMoved = true;
      const button = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-pause-item]') : null;
      this.setHover(this.items.find((i) => i.button === button)?.id ?? null);
    });
    this.el.addEventListener('pointerleave', () => this.setHover(null));
    root.appendChild(this.el);
    this.setEnabled(false);
  }

  get hovered(): PauseChoice | null {
    return this.hoverItem;
  }

  /** Swaps the words (設定 > 言語, S-43): the items, the question, the line about the mouse. */
  relabel(t: (k: StringKey) => string): void {
    this.el.setAttribute('aria-label', t('pauseLabel'));
    for (const lines of Object.values(this.lines)) for (const l of lines) l.ink.textContent = t(l.key);
    this.noteText.textContent = t('pauseRelock');
  }

  /** The screen's size in CSS pixels: the frost's reach and the blur follow it. */
  resize(width: number, height: number): void {
    this.halfDiagonal = Math.hypot(width, height) / 2;
    this.blurScale = Math.max(0.5, height / 1080);
  }

  /** Moves the browser's focus onto an item (keyboard, pad), so that the screen readers and Tab follow. */
  focus(item: PauseChoice): void {
    this.items.find((i) => i.id === item)?.button.focus({ preventScroll: true });
  }

  /** The chosen item sinks for a moment. */
  press(item: PauseChoice): void {
    const it = this.items.find((i) => i.id === item);
    if (!it) return;
    it.button.classList.add('is-pressed');
    it.pressTimer = PRESS_SECONDS;
  }

  render(dt: number, view: PauseView): void {
    if (view.up !== this.wasUp) {
      this.wasUp = view.up;
      this.el.classList.toggle('is-up', view.up);
      // a page that comes up with the pause takes clicks at once; one shown later, only after a move (see onClick)
      this.pageMoved = true;
      if (!view.up) {
        // the next opening's page comes up with the pause (closed on the question, it opens on the items)
        this.shownPage = null;
        this.setHover(null);
        const active = document.activeElement;
        if (active instanceof HTMLElement && this.el.contains(active)) active.blur();
      }
    }
    this.setEnabled(view.up && view.interactive && !view.yielded);
    this.el.classList.toggle('is-yielded', view.up && view.yielded);
    for (const i of this.items) {
      if (i.pressTimer > 0) {
        i.pressTimer -= dt;
        if (i.pressTimer <= 0) i.button.classList.remove('is-pressed');
      }
    }
    if (!view.up) return;
    this.writing = view.writing;

    // the breath: spreading from the middle; once it is all there it is not masked any more
    const full = view.frost >= 1;
    this.breath.classList.toggle('is-full', full);
    if (!full) {
      // the soft edge keeps its width; the solid middle grows out from nothing to past the corners
      const soft = FROST_SOFT * this.halfDiagonal;
      const r = view.frost * (FROST_CORE * this.halfDiagonal + soft);
      this.set(this.breath, '--r', r, 'px', 1);
      this.set(this.breath, '--core', Math.max(0, r - soft), 'px', 1);
    }
    this.set(
      this.breath,
      '--blur',
      (BLUR_FROM + (BLUR_TO - BLUR_FROM) * view.frost) * this.blurScale,
      'px',
      2,
    );

    if (view.page !== this.shownPage) {
      const first = this.shownPage === null;
      this.shownPage = view.page;
      this.pages.menu.hidden = view.page !== 'menu';
      this.pages.confirm.hidden = view.page !== 'confirm';
      // the item under the pointer went with its page; the new page's items wait for the pointer to move
      this.setHover(null);
      if (!first) this.pageMoved = false;
    }
    const lines = this.lines[view.page];
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k];
      if (!l) continue;
      const w = lineWriting(view.writing, k, lines.length);
      this.set(l.line, '--w', w, '', 3);
      this.set(l.line, '--tip', w > 0 && w < 1 ? Math.sin(Math.PI * w) ** 0.5 : 0, '', 3);
      this.set(l.tag, '--tag', segment(w, 0, 0.3), '', 3);
    }
    this.set(this.noteText, '--note', view.page === 'menu' ? view.writing : 0, '', 3);
    for (const i of this.items)
      i.button.classList.toggle('is-focus', view.interactive && i.id === view.focused);
  }

  dispose(): void {
    this.el.remove();
  }

  private item(id: PauseChoice, t: (k: StringKey) => string, parent: HTMLElement): Line {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vd-pause__item';
    button.dataset.pauseItem = id;
    const written = writtenLine(t, STRING_OF[id]);
    button.appendChild(written.tag);
    const item: Item = { id, button, ...written, pressTimer: 0 };
    button.addEventListener('focus', () => {
      if (this.enabled) this.events.onFocus(id);
    });
    button.addEventListener('click', () => {
      if (!this.enabled) return;
      // 確認ダイアログ: a page shown by a click takes no click until the pointer has moved and the page is written — the
      // second click of a double click on タイトルへ must not land on はい, unseen under it
      if (!this.pageMoved || this.writing < 1) return;
      this.events.onPick(id);
    });
    parent.appendChild(button);
    this.items.push(item);
    return item;
  }

  /** The item under the pointer swells (表面張力) and, once the items take commands, rings and takes the focus. */
  private setHover(item: PauseChoice | null): void {
    if (item === this.hoverItem) return;
    for (const i of this.items) i.button.classList.toggle('is-hover', i.id === item);
    this.hoverItem = item;
    if (item && this.enabled) this.events.onHover(item);
  }

  private setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const i of this.items) i.button.tabIndex = on ? 0 : -1;
  }

  /** Sets a custom property only when its value changed at the precision written (most frames change nothing). */
  private set(el: HTMLElement, prop: string, value: number, unit: string, digits: number): void {
    let props = this.last.get(el);
    if (!props) {
      props = new Map();
      this.last.set(el, props);
    }
    const step = 10 ** -digits;
    const was = props.get(prop);
    if (was !== undefined && Math.abs(was - value) < step / 2) return;
    props.set(prop, value);
    el.style.setProperty(prop, `${value.toFixed(digits)}${unit}`);
  }
}
