import { segment } from '../../core/transition';
import type { StringKey } from '../lang';
import { HOME_ITEMS, type HomeItem, nextFocus } from './menu-logic';

/** Drops sit on an arc around the orb's right side, from upper right (first item) to lower right. */
const ARC_FROM_DEG = 38;
const ARC_TO_DEG = 142;
const ARC_RADIUS = 1.3; // × orb radius on screen
/** Time a chosen drop stays sunk before it rises again (細部の振る舞い: 選ぶと弾けずに沈み込む). */
const PRESS_SECONDS = 0.38;

export interface MenuLayout {
  /** Orb centre and radius on screen, in CSS pixels. */
  cx: number;
  cy: number;
  r: number;
  /** 0..1: drops condensing into view (staggered from the first item). */
  appear: number;
  time: number;
}

export interface MenuEvents {
  onSelect(item: HomeItem): void;
  /** Focus moved to a drop (by keyboard or by hover): answer with light and sound. */
  onFocus(item: HomeItem, index: number): void;
  /** The pointer reached a drop (画面ごとの設計: 雫にホバーすると膨らんで鳴る), focused or not. */
  onHover(item: HomeItem, index: number): void;
}

interface Drop {
  id: HomeItem;
  el: HTMLButtonElement;
  bead: HTMLElement;
  label: HTMLElement;
  pressTimer: number;
}

/**
 * ホーム画面の項目 (UI/UX設計 > 画面ごとの設計, 細部の振る舞い): small drops floating around the orb.
 * Hover swells a drop (surface tension), focus lights it from inside, choosing makes it sink.
 * Fully keyboard operable: Tab / arrows / Home / End move, Enter / Space choose.
 */
export class HomeMenu {
  readonly el: HTMLElement;
  private readonly drops: Drop[];
  private focusIndex = -1;
  private hoverIndex = -1;
  private interactive = false;
  private beadHalf = 14;
  private rowHalf = 18;
  private measured = false;
  private shown = true;
  /** Focus moved by a hover, which already answered with its own sound. */
  private quietFocus = false;
  private veiled = false;

  constructor(
    root: HTMLElement,
    t: (k: StringKey) => string,
    private readonly events: MenuEvents,
  ) {
    this.el = document.createElement('nav');
    this.el.className = 'vd-home';
    this.el.dataset.ui = 'home';
    this.el.setAttribute('aria-label', t('menuLabel'));
    this.drops = HOME_ITEMS.map((id, index) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'vd-drop';
      el.dataset.item = id;
      el.innerHTML =
        '<span class="vd-drop__bead" data-part="bead"><span class="vd-drop__light"></span></span>' +
        '<span class="vd-drop__label vd-frost"></span>';
      const label = el.querySelector<HTMLElement>('.vd-drop__label') ?? el;
      label.textContent = t(id);
      const bead = el.querySelector<HTMLElement>('[data-part="bead"]') ?? el;
      el.addEventListener('pointerenter', () => {
        if (!this.interactive) return;
        this.hoverIndex = index;
        el.classList.add('is-hover');
        this.events.onHover(id, index);
        if (this.focusIndex !== index) {
          this.quietFocus = true;
          el.focus({ preventScroll: true });
          this.quietFocus = false;
        }
      });
      el.addEventListener('pointerleave', () => {
        if (this.hoverIndex === index) this.hoverIndex = -1;
        el.classList.remove('is-hover');
      });
      el.addEventListener('focus', () => {
        this.focusIndex = index;
        el.classList.add('is-focus');
        if (this.interactive && !this.quietFocus) this.events.onFocus(id, index);
      });
      el.addEventListener('blur', () => el.classList.remove('is-focus'));
      el.addEventListener('click', () => {
        if (!this.interactive) return;
        this.press(id);
        this.events.onSelect(id);
      });
      this.el.appendChild(el);
      return { id, el, bead, label, pressTimer: 0 };
    });
    this.el.addEventListener('keydown', (e) => {
      if (!this.interactive) return;
      const next = nextFocus(this.focusIndex, e.key, this.drops.length);
      if (next !== this.focusIndex) {
        e.preventDefault();
        this.drops[next]?.el.focus({ preventScroll: true });
      }
    });
    root.appendChild(this.el);
    this.applyInteractive();
  }

  get focused(): HomeItem | null {
    return this.drops[this.focusIndex]?.id ?? null;
  }

  get hovered(): HomeItem | null {
    return this.drops[this.hoverIndex]?.id ?? null;
  }

  /** Only on the home screen with no transition playing. */
  setInteractive(on: boolean): void {
    if (on === this.interactive) return;
    this.interactive = on;
    this.applyInteractive();
  }

  private applyInteractive(): void {
    const on = this.interactive;
    this.el.style.pointerEvents = on ? 'auto' : 'none';
    for (const d of this.drops) {
      d.el.tabIndex = on ? 0 : -1;
      if (!on) d.el.classList.remove('is-hover');
    }
    if (!on) this.hoverIndex = -1;
  }

  focusItem(item: HomeItem): void {
    const d = this.drops.find((x) => x.id === item);
    d?.el.focus({ preventScroll: true });
  }

  /** Visual press (also used by the autoplay script). */
  press(item: HomeItem): void {
    const d = this.drops.find((x) => x.id === item);
    if (!d) return;
    d.el.classList.add('is-pressed');
    d.pressTimer = PRESS_SECONDS;
  }

  /** Re-measure after a resize (font size follows the viewport height, and the settings' text size). */
  invalidate(): void {
    this.measured = false;
  }

  /** Swaps the words (設定 > 言語, S-43). */
  relabel(t: (k: StringKey) => string): void {
    this.el.setAttribute('aria-label', t('menuLabel'));
    for (const d of this.drops) d.label.textContent = t(d.id);
    this.invalidate();
  }

  /**
   * The settings are open over the home (S-43): the drops step aside under the panel (they fade as they came), and come
   * back when it closes.
   */
  setVeiled(on: boolean): void {
    if (on === this.veiled) return;
    this.veiled = on;
    this.el.classList.toggle('is-veiled', on);
  }

  update(dt: number, layout: MenuLayout): void {
    if (!this.measured) {
      const first = this.drops[0];
      if (first) {
        this.beadHalf = first.bead.offsetWidth / 2 || this.beadHalf;
        this.rowHalf = first.el.offsetHeight / 2 || this.rowHalf;
      }
      this.measured = true;
    }
    const shown = layout.appear > 0;
    if (shown !== this.shown) {
      this.shown = shown;
      this.el.style.visibility = shown ? 'visible' : 'hidden';
    }
    if (!shown) return;
    const n = this.drops.length;
    const rr = layout.r * ARC_RADIUS;
    for (let i = 0; i < n; i++) {
      const d = this.drops[i];
      if (!d) continue;
      const a = ((ARC_FROM_DEG + ((ARC_TO_DEG - ARC_FROM_DEG) * i) / Math.max(1, n - 1)) * Math.PI) / 180;
      const bobY = Math.sin(layout.time * 0.9 + i * 1.7) * 3;
      const bobX = Math.cos(layout.time * 0.6 + i * 1.1) * 1.5;
      const appear = segment(layout.appear, i * 0.07, i * 0.07 + 0.72);
      const x = layout.cx + Math.sin(a) * rr - this.beadHalf + bobX;
      const y = layout.cy - Math.cos(a) * rr - this.rowHalf + bobY + (1 - appear) * 14;
      d.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      d.el.style.setProperty('--appear', appear.toFixed(3));
      if (d.pressTimer > 0) {
        d.pressTimer -= dt;
        if (d.pressTimer <= 0) d.el.classList.remove('is-pressed');
      }
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
