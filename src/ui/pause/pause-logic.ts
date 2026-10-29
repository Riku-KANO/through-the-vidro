import { glassEase, segment } from '../../core/transition';
import {
  FadeCourse,
  type FlashGate,
  fadeArrived,
  fadeWhite,
  gatedStep,
  SIMPLE_FADE_SECONDS,
} from '../settings/fade';

/**
 * The pause screen's rules (S-42), pure: no DOM, no GPU, no sound. src/ui/pause/pause-host.ts plays them.
 *
 * トランジション設計 > 遷移の一覧:
 *   ゲーム → ポーズ: 時間がゆっくり止まり、曇りが中心から広がり、文字が書かれる — 0.4秒＋文字0.3秒
 *   ポーズ → ゲーム: 曇りが外側から晴れ、時間が動き出す — 0.3秒（上の逆）
 * Both on the one glass curve (遷移のルール 5): the time's speed is 1 − glassEase(t / 0.4) while it stops, and the
 * frost's spread is glassEase(t / 0.4); the clearing plays the same curve backwards in 0.3 s (戻るときは、来たときの動きを
 * 逆再生する — UI/UX設計 > 細部の振る舞い).
 */
export const PAUSE_SECONDS = {
  /** 時間が0.4秒かけてゆっくり止まり、息を吹きかけたような曇りが中心から広がる */
  stop: 0.4,
  /** 項目は曇りの上に指でなぞった文字として書かれる（文字0.3秒） */
  write: 0.3,
  /** 曇りが外側から晴れ、時間が動き出す */
  clear: 0.3,
} as const;

/** 仮: the written text is gone by this share of the clearing (the frost clears behind it). */
const TEXT_GONE_AT = 0.5;
/** 仮: each written line starts this share of a line's time after the one before (they overlap, top to bottom). */
const LINE_STAGGER = 0.35;
/**
 * After the mouse lock drops on Esc, some browsers also deliver the Esc key (src/game/input/input-system.ts ESC_ECHO_MS):
 * that is the press that opened the pause, not one that closes it.
 */
export const ESC_ECHO_MS = 300;
/** Seconds of rounding left over from many small steps. */
const EPSILON = 1e-9;

export type PausePhase = 'closed' | 'opening' | 'open' | 'closing' | 'leaving';

/**
 * Where the pause stands in time. `frost` (0..1) is how far the breath on the glass has spread from the middle of the
 * screen; the game's time runs at 1 − frost; `writing` (0..1) is how far the items are written, once the frost is all
 * there.
 */
export class PauseTimeline {
  private phaseValue: PausePhase = 'closed';
  /** Seconds along the opening's curve, 0..stop: frost = glassEase(frostTime / stop). */
  private frostTime = 0;
  private writeValue = 0;
  /**
   * S-45 簡易トランジション (src/ui/settings/fade.ts): the pause opens and closes as a white fade of 0.3 s instead — the game runs
   * until the white is full, then the pause is all there (frost and words), and the other way round. `fadeU` is the time
   * along it (0..1).
   */
  private simpleValue = false;
  private fadeU = 0;
  /**
   * S-45 (発案者の判断 2026-10-29): the simple fade's length (0.5 s with 点滅を抑える as well) and the page's gate of full whites
   * (settings/fade.ts FlashGate).
   */
  fadeSeconds = SIMPLE_FADE_SECONDS;
  gate: FlashGate | null = null;
  /** (Esc during the fade turns it back: a top of its white, through the gate as well.) */
  private readonly course = new FadeCourse();

  get phase(): PausePhase {
    return this.phaseValue;
  }

  /** S-45: the simple fade in place of the glass's own (it may change while the pause is open: the settings over it). */
  get simple(): boolean {
    return this.simpleValue;
  }

  set simple(on: boolean) {
    if (on === this.simpleValue) return;
    // carried over at the nearest end (the setting only changes while the pause stands open)
    if (on) this.fadeU = this.frost >= 0.5 ? 1 : 0;
    else {
      const arrived = fadeArrived(this.fadeU) && this.fadeU > 0;
      this.frostTime = arrived ? PAUSE_SECONDS.stop : 0;
      this.writeValue = arrived ? 1 : 0;
    }
    this.simpleValue = on;
  }

  get frost(): number {
    if (this.simpleValue) {
      // (at the full white itself, the side it heads to: the cut is under the white both ways)
      const opening = this.phaseValue === 'opening' || this.phaseValue === 'open';
      return fadeArrived(this.fadeU, opening) && this.fadeU > 0 ? 1 : 0;
    }
    return glassEase(this.frostTime / PAUSE_SECONDS.stop);
  }

  /** The game's time speed: 1 → 0 as the frost spreads (体・玉・光の掃き・環境の動きがゆっくり止まる). */
  get timeScale(): number {
    return 1 - this.frost;
  }

  get writing(): number {
    return this.simpleValue ? this.frost : this.writeValue;
  }

  /** S-45: how white the screen is under the simple fade (0 under the glass's own). */
  get white(): number {
    return this.simpleValue ? fadeWhite(this.fadeU) : 0;
  }

  /** The items take commands once the frost is all there (while they are being written too). */
  get interactive(): boolean {
    const up = this.phaseValue === 'opening' || this.phaseValue === 'open';
    if (this.simpleValue) return up && this.frost === 1;
    return up && this.frostTime >= PAUSE_SECONDS.stop;
  }

  /** Esc / Start in play. From a clearing it spreads again from where it is. */
  open(): boolean {
    if (this.phaseValue !== 'closed' && this.phaseValue !== 'closing') return false;
    this.phaseValue = 'opening';
    return true;
  }

  /** つづける / Esc / B: the frost clears from the outside, the time runs again. */
  close(): boolean {
    if (this.phaseValue !== 'opening' && this.phaseValue !== 'open') return false;
    this.phaseValue = 'closing';
    return true;
  }

  /** タイトルへ → はい: clears as the close does, while the dive plays back to the home behind it. */
  leave(): boolean {
    if (this.phaseValue !== 'opening' && this.phaseValue !== 'open') return false;
    this.phaseValue = 'leaving';
    return true;
  }

  /** A new page (the confirmation, or back to the items) is written again from the start. */
  rewrite(): void {
    if (this.phaseValue === 'opening' || this.phaseValue === 'open') this.writeValue = 0;
  }

  update(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.simpleValue) {
      this.updateFade(dt);
      return;
    }
    const stop = PAUSE_SECONDS.stop;
    switch (this.phaseValue) {
      case 'opening':
      case 'open': {
        const before = this.frostTime;
        this.frostTime = Math.min(stop, this.frostTime + dt);
        // the writing starts once the frost has spread, with what is left of this step
        const left = before >= stop ? dt : Math.max(0, before + dt - stop);
        if (this.frostTime >= stop && left > 0) {
          this.writeValue = this.writeValue + left / PAUSE_SECONDS.write;
          if (this.writeValue >= 1 - EPSILON) this.writeValue = 1;
        }
        if (this.phaseValue === 'opening' && this.writeValue >= 1) this.phaseValue = 'open';
        break;
      }
      case 'closing':
      case 'leaving': {
        // the same curve backwards, at the clearing's pace
        this.frostTime = Math.max(0, this.frostTime - (dt * stop) / PAUSE_SECONDS.clear);
        this.writeValue = Math.max(0, this.writeValue - dt / (PAUSE_SECONDS.clear * TEXT_GONE_AT));
        if (this.frostTime <= EPSILON) {
          this.frostTime = 0;
          this.writeValue = 0;
          this.phaseValue = 'closed';
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * S-45: the simple fade's time, on and back (the same length both ways: a fade has no slow stop of its own); its full white
   * through the page's gate.
   */
  private updateFade(dt: number): void {
    const step = dt / this.fadeSeconds;
    switch (this.phaseValue) {
      case 'opening':
      case 'open':
        this.fadeU = gatedStep(this.fadeU, step, this.gate, this.course);
        if (this.phaseValue === 'opening' && this.fadeU >= 1 - EPSILON) {
          this.fadeU = 1;
          this.phaseValue = 'open';
        }
        break;
      case 'closing':
      case 'leaving':
        this.fadeU = gatedStep(this.fadeU, -step, this.gate, this.course);
        if (this.fadeU <= EPSILON) {
          this.fadeU = 0;
          this.frostTime = 0;
          this.writeValue = 0;
          this.phaseValue = 'closed';
        }
        break;
      default:
        break;
    }
  }

  /** Dev hold (screenshots): stands the opening at this many seconds in. */
  holdAt(seconds: number): void {
    if (this.phaseValue !== 'opening') return;
    if (this.simpleValue) {
      this.fadeU = Math.min(1, Math.max(0, seconds / this.fadeSeconds));
      return;
    }
    const s = Math.min(PAUSE_SECONDS.stop + PAUSE_SECONDS.write, Math.max(0, seconds));
    this.frostTime = Math.min(PAUSE_SECONDS.stop, s);
    this.writeValue = Math.max(0, s - PAUSE_SECONDS.stop) / PAUSE_SECONDS.write;
  }
}

/**
 * 指でなぞった文字 (UI/UX設計 > 英語版: 文の左から右へ光の筆跡が進む): how far line `k` of `n` is written (0..1) when the
 * page is `writing` (0..1) written. The lines follow one another, top to bottom, overlapping.
 */
export function lineWriting(writing: number, k: number, n: number): number {
  if (n <= 1) return Math.min(1, Math.max(0, writing));
  const span = 1 / (1 + (n - 1) * LINE_STAGGER);
  const from = k * LINE_STAGGER * span;
  return segment(writing, from, from + span);
}

/**
 * 画面ごとの設計 > ポーズ: つづける / ヒント / 地図の玉 / 設定 / タイトルへ — つづける and タイトルへ (S-42), 設定 (S-43); ヒント
 * and 地図の玉 come with the slices that make them, in this order.
 */
export const PAUSE_ITEMS = ['resume', 'settings', 'title'] as const;
/** 細部の振る舞い > 確認ダイアログ: 曇りガラスに2択の文字を書く. */
export const CONFIRM_ITEMS = ['yes', 'no'] as const;

export type PauseItem = (typeof PAUSE_ITEMS)[number];
export type ConfirmItem = (typeof CONFIRM_ITEMS)[number];
export type PauseChoice = PauseItem | ConfirmItem;
export type PausePage = 'menu' | 'confirm';

export interface PauseMenu {
  page: PausePage;
  focus: number;
}

/** `back` is one step back (Esc / B); `close` leaves the pause from any page (Start: it closes as it opened). */
export type PauseCommand = 'up' | 'down' | 'left' | 'right' | 'choose' | 'back' | 'close';

export interface PauseStep {
  menu: PauseMenu;
  /** What the pause does now: resume the game, open the settings, leave for the title, or nothing (a move, a page). */
  outcome: 'resume' | 'settings' | 'leave' | null;
  /** The item chosen by this step (it sinks and rings), if any. */
  chosen: PauseChoice | null;
  /** The focus moved to another item (it lights and rings). */
  moved: boolean;
}

export const MENU_START: PauseMenu = { page: 'menu', focus: 0 };

const TITLE_INDEX = PAUSE_ITEMS.indexOf('title');
/** The answer chosen when the question appears: the one that does no harm. */
const NO_INDEX = CONFIRM_ITEMS.indexOf('no');

export function itemsOf(page: PausePage): readonly PauseChoice[] {
  return page === 'menu' ? PAUSE_ITEMS : CONFIRM_ITEMS;
}

export function focusedItem(menu: PauseMenu): PauseChoice {
  const items = itemsOf(menu.page);
  return items[Math.min(items.length - 1, Math.max(0, menu.focus))] ?? items[0] ?? 'resume';
}

const stay = (menu: PauseMenu): PauseStep => ({ menu, outcome: null, chosen: null, moved: false });

function choose(menu: PauseMenu): PauseStep {
  const item = focusedItem(menu);
  switch (item) {
    case 'resume':
      return { menu, outcome: 'resume', chosen: item, moved: false };
    case 'settings':
      // the panel opens over the pause; closed, it comes back here, on 設定
      return { menu, outcome: 'settings', chosen: item, moved: false };
    case 'title':
      // 取り消せない操作だけ確認する
      return { menu: { page: 'confirm', focus: NO_INDEX }, outcome: null, chosen: item, moved: false };
    case 'yes':
      return { menu, outcome: 'leave', chosen: item, moved: false };
    case 'no':
      return { menu: { page: 'menu', focus: TITLE_INDEX }, outcome: null, chosen: item, moved: false };
  }
}

/**
 * One command on the pause (キーボード・パッド操作): up / down (and left / right between the two answers) move the focus,
 * choose takes the focused item, back is one step back (戻る操作: Esc / B) — from the items that is the game.
 */
export function stepMenu(menu: PauseMenu, command: PauseCommand): PauseStep {
  const n = itemsOf(menu.page).length;
  const move = (by: number): PauseStep => {
    const focus = (((menu.focus + by) % n) + n) % n;
    return { menu: { page: menu.page, focus }, outcome: null, chosen: null, moved: focus !== menu.focus };
  };
  switch (command) {
    case 'up':
      return move(-1);
    case 'down':
      return move(1);
    case 'left':
    case 'right':
      // the two answers stand side by side; the items are a column
      return menu.page === 'confirm' ? move(command === 'left' ? -1 : 1) : stay(menu);
    case 'choose':
      return choose(menu);
    case 'back':
      return menu.page === 'confirm'
        ? { menu: { page: 'menu', focus: TITLE_INDEX }, outcome: null, chosen: null, moved: false }
        : { menu, outcome: 'resume', chosen: null, moved: false };
    case 'close':
      return { menu, outcome: 'resume', chosen: null, moved: false };
  }
}

/** A click on an item of the page shown: it is focused and chosen. An item of the other page is ignored. */
export function pickItem(menu: PauseMenu, item: PauseChoice): PauseStep {
  const focus = itemsOf(menu.page).indexOf(item);
  if (focus < 0) return stay(menu);
  return choose({ page: menu.page, focus });
}

/** キーボード: arrows and WASD move, Enter and Space choose, Esc and Backspace go back. Tab is left to the browser. */
export function keyCommand(e: { key: string; code: string }): PauseCommand | null {
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
    default:
      return e.key === 'Escape' ? 'back' : e.key === 'Enter' ? 'choose' : null;
  }
}

/** ゲームパッド (src/game/input/gamepad.ts codes): 十字 move, A chooses, B goes back, Start closes as it opened. */
const PAD_COMMANDS: Readonly<Record<string, PauseCommand>> = {
  PadUp: 'up',
  PadDown: 'down',
  PadLeft: 'left',
  PadRight: 'right',
  PadA: 'choose',
  PadB: 'back',
  PadStart: 'close',
};

/** The commands of the buttons pressed since the last reading (a held button counts once). */
export function padCommands(previous: ReadonlySet<string>, held: ReadonlySet<string>): PauseCommand[] {
  const out: PauseCommand[] = [];
  for (const code of held) {
    const command = PAD_COMMANDS[code];
    if (command && !previous.has(code)) out.push(command);
  }
  return out;
}
