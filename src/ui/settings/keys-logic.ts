import {
  type ButtonAction,
  bindableCode,
  type Device,
  REBINDABLE,
  type Swap,
} from '../../game/input/bindings';
import { keyLabel } from '../../game/input/key-labels';
import { type Lang, STRINGS, type StringKey } from '../lang';
import type { PanelCommand } from './settings-logic';

/**
 * キーの割り当て (S-45), pure: the page the settings open from 操作 (操作とカメラ: すべてのキーは設定で割り当て直せます; アクセシビリティ:
 * キーの割り当て変更). A list of the actions, each with two keys of the keyboard and mouse (キー, キー（副）) and a button of the pad;
 * under it 初期に戻す and 戻る. Enter / A on a cell waits for the key (「キーを押してください」), which takes the cell (the action
 * that had it swaps: game/input/bindings.ts assignBinding); Esc gives the waiting up (and B on the pad: Esc and the pad's Start
 * and B are fixed). Keyboard alone, a pad alone, or the mouse (細部の振る舞い: マウスなしでもすべての画面を操作できる).
 */

/** The rows: the actions a player may bind (bindings.ts REBINDABLE). */
export const KEY_ROWS: readonly ButtonAction[] = REBINDABLE;
export const KEY_COLS = ['key1', 'key2', 'pad'] as const;
export type KeyCol = (typeof KEY_COLS)[number];
/** The foot's row (after the actions): 初期に戻す (col 0) and 戻る (col 1). */
export const FOOT_ROW = KEY_ROWS.length;
const FOOT_COLS = 2;

export interface KeysFocus {
  row: number;
  col: number;
}
export const KEYS_START: KeysFocus = { row: 0, col: 0 };

/** The key a cell waits for: an action, a device, a slot of it. */
export interface KeysWaiting {
  action: ButtonAction;
  device: Device;
  slot: number;
}

const MOVES: ReadonlySet<ButtonAction> = new Set(['moveForward', 'moveBack', 'moveLeft', 'moveRight']);

/** The pad moves with its left stick (操作とカメラ > 入力の割り当て: 移動 左スティック): the pad's cells of the moves are fixed. */
export function fixedCell(row: number, col: number): boolean {
  const action = KEY_ROWS[row];
  return action !== undefined && col === 2 && MOVES.has(action);
}

/** The binding a cell stands for, or null (the foot, the stick, out of the page). */
export function cellOf(row: number, col: number): KeysWaiting | null {
  const action = KEY_ROWS[row];
  if (!action || col < 0 || col >= KEY_COLS.length || fixedCell(row, col)) return null;
  return col === 2 ? { action, device: 'gamepad', slot: 0 } : { action, device: 'keyboardMouse', slot: col };
}

export interface KeysStep {
  focus: KeysFocus;
  /** The focus moved (it lights and rings). */
  moved: boolean;
  /** A cell now waits for its key. */
  waiting: KeysWaiting | null;
  /** 初期に戻す chosen. */
  reset: boolean;
  /** 戻る: back to 操作 (one step back). */
  leave: boolean;
}

const stay = (focus: KeysFocus, extra: Partial<KeysStep> = {}): KeysStep => ({
  focus,
  moved: false,
  waiting: null,
  reset: false,
  leave: false,
  ...extra,
});

const colsOf = (row: number): number => (row === FOOT_ROW ? FOOT_COLS : KEY_COLS.length);

/** The column to land on in `row` coming from `col`: the same, or the nearest one that is not the stick. */
function landCol(row: number, col: number): number {
  let c = Math.min(colsOf(row) - 1, col);
  while (c > 0 && fixedCell(row, c)) c--;
  return c;
}

function choose(focus: KeysFocus): KeysStep {
  if (focus.row === FOOT_ROW) return stay(focus, focus.col === 0 ? { reset: true } : { leave: true });
  const cell = cellOf(focus.row, focus.col);
  return stay(focus, { waiting: cell });
}

/** One command on the page (not while a cell waits: its key is taken by the capture functions below). */
export function stepKeys(focus: KeysFocus, command: PanelCommand): KeysStep {
  const move = (row: number, col: number): KeysStep => {
    const to = { row, col: landCol(row, col) };
    return to.row === focus.row && to.col === focus.col ? stay(focus) : { ...stay(to), moved: true };
  };
  switch (command) {
    case 'up':
      return focus.row > 0 ? move(focus.row - 1, focus.col) : stay(focus);
    case 'down':
      return focus.row < FOOT_ROW ? move(focus.row + 1, focus.col) : stay(focus);
    case 'left':
      return focus.col > 0 ? move(focus.row, focus.col - 1) : stay(focus);
    case 'right': {
      const c = focus.col + 1;
      if (c >= colsOf(focus.row) || fixedCell(focus.row, c)) return stay(focus);
      return move(focus.row, c);
    }
    case 'choose':
      return choose(focus);
    case 'back':
      return stay(focus, { leave: true });
    case 'prevTab':
    case 'nextTab':
      return stay(focus);
  }
}

/** A click on a cell or a button of the foot: it is focused and chosen (the stick: focused, nothing waits). */
export function pickKeys(at: KeysFocus): KeysStep {
  const focus = { row: at.row, col: Math.min(colsOf(at.row) - 1, Math.max(0, at.col)) };
  return { ...choose(focus), moved: true };
}

/** What a key, a button or the wheel does to a cell that waits: takes it, gives the waiting up, or nothing (it waits on). */
export type Capture = { kind: 'bind'; code: string } | { kind: 'cancel' } | { kind: 'ignore' };

const bind = (waiting: KeysWaiting, code: string): Capture =>
  bindableCode(waiting.device, code) ? { kind: 'bind', code } : { kind: 'ignore' };

/** A key (KeyboardEvent.code): Esc gives up (待ちの間の Esc は割り当てをやめて一覧へ戻る); a key's cell takes a key. */
export function captureKey(waiting: KeysWaiting, code: string): Capture {
  if (code === 'Escape') return { kind: 'cancel' };
  return waiting.device === 'keyboardMouse' ? bind(waiting, code) : { kind: 'ignore' };
}

/** A pad's button: B and Start give up (fixed); a pad's cell takes a button. */
export function capturePad(waiting: KeysWaiting, code: string): Capture {
  if (code === 'PadB' || code === 'PadStart') return { kind: 'cancel' };
  return waiting.device === 'gamepad' ? bind(waiting, code) : { kind: 'ignore' };
}

/** A mouse button (MouseEvent.button): a key's cell takes it. */
export function captureMouse(waiting: KeysWaiting, button: number): Capture {
  return waiting.device === 'keyboardMouse' ? bind(waiting, `Mouse${button}`) : { kind: 'ignore' };
}

/** The wheel (WheelEvent.deltaY): a key's cell takes its direction. */
export function captureWheel(waiting: KeysWaiting, deltaY: number): Capture {
  if (waiting.device !== 'keyboardMouse' || deltaY === 0) return { kind: 'ignore' };
  return bind(waiting, deltaY < 0 ? 'WheelUp' : 'WheelDown');
}

/** The name of each action on the page (the language files). */
export const ACTION_KEY: Readonly<Record<ButtonAction, StringKey>> = {
  moveForward: 'keyActMoveForward',
  moveBack: 'keyActMoveBack',
  moveLeft: 'keyActMoveLeft',
  moveRight: 'keyActMoveRight',
  peek: 'keyActPeek',
  interact: 'keyActInteract',
  ring: 'keyActInteract',
  orbPrev: 'keyActOrbPrev',
  orbNext: 'keyActOrbNext',
  orb1: 'keyActOrb1',
  orb2: 'keyActOrb2',
  orb3: 'keyActOrb3',
  sprint: 'keyActSprint',
  pause: 'keysFixed',
};

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');

/**
 * 何が入れ替わったかを書く: the line under the list after `code` was bound and took it from another action (`swaps`), or null
 * when nothing else changed.
 */
export function keysNotice(lang: Lang, code: string, swaps: readonly Swap[]): string | null {
  const s = swaps[0];
  if (!s) return null;
  const t = STRINGS[lang];
  const values = { key: keyLabel(code, lang), other: t[ACTION_KEY[s.action]] };
  return s.gave === null
    ? fill(t.keysRemoved, values)
    : fill(t.keysSwapped, { ...values, old: keyLabel(s.gave, lang) });
}
