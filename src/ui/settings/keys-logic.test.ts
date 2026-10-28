import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../game/input/bindings';
import {
  captureKey,
  captureMouse,
  capturePad,
  captureWheel,
  cellOf,
  FOOT_ROW,
  fixedCell,
  KEY_COLS,
  KEY_ROWS,
  KEYS_START,
  type KeysWaiting,
  keysNotice,
  pickKeys,
  stepKeys,
} from './keys-logic';

const km: KeysWaiting = { action: 'peek', device: 'keyboardMouse', slot: 0 };
const pad: KeysWaiting = { action: 'peek', device: 'gamepad', slot: 0 };

describe('S-45 the key page: a list of the actions, two keys and a pad button each', () => {
  it('lists 移動・覗く・置く/拾う/調べる・小玉の切り替え・早歩き in the columns キー / キー（副）/ パッド', () => {
    expect(KEY_ROWS[0]).toBe('moveForward');
    expect(KEY_ROWS).toContain('peek');
    expect(KEY_ROWS).toContain('interact');
    expect(KEY_ROWS).toContain('orbPrev');
    expect(KEY_ROWS).toContain('sprint');
    expect(KEY_ROWS).not.toContain('pause');
    expect(KEY_COLS).toEqual(['key1', 'key2', 'pad']);
    expect(FOOT_ROW).toBe(KEY_ROWS.length);
  });

  it('a cell is an action, a device and a slot; the pad’s cells of the moves are the left stick (fixed)', () => {
    expect(cellOf(0, 0)).toEqual({ action: 'moveForward', device: 'keyboardMouse', slot: 0 });
    expect(cellOf(0, 1)).toEqual({ action: 'moveForward', device: 'keyboardMouse', slot: 1 });
    const peekRow = KEY_ROWS.indexOf('peek');
    expect(cellOf(peekRow, 2)).toEqual({ action: 'peek', device: 'gamepad', slot: 0 });
    expect(fixedCell(0, 2)).toBe(true);
    expect(cellOf(0, 2)).toBeNull();
    expect(fixedCell(peekRow, 2)).toBe(false);
    expect(cellOf(FOOT_ROW, 0)).toBeNull();
  });
});

describe('S-45 stepKeys: moving on the page (キーボード・パッドだけで操作)', () => {
  it('starts on the first cell; up / down through the rows into the foot (初期に戻す, 戻る)', () => {
    expect(KEYS_START).toEqual({ row: 0, col: 0 });
    expect(stepKeys(KEYS_START, 'up').moved).toBe(false);
    let f = stepKeys(KEYS_START, 'down').focus;
    expect(f).toEqual({ row: 1, col: 0 });
    for (let i = 0; i < 40; i++) f = stepKeys(f, 'down').focus;
    expect(f.row).toBe(FOOT_ROW);
    expect(stepKeys(f, 'up').focus.row).toBe(FOOT_ROW - 1);
  });

  it('left / right between the columns; the stick’s cell is passed over', () => {
    expect(stepKeys({ row: 0, col: 0 }, 'right').focus).toEqual({ row: 0, col: 1 });
    expect(stepKeys({ row: 0, col: 1 }, 'right').moved).toBe(false);
    const peekRow = KEY_ROWS.indexOf('peek');
    expect(stepKeys({ row: peekRow, col: 1 }, 'right').focus).toEqual({ row: peekRow, col: 2 });
    expect(stepKeys({ row: 0, col: 0 }, 'left').moved).toBe(false);
    // up from the pad's column of 覗く into a move row would land on the stick: it lands on the key beside it
    expect(stepKeys({ row: peekRow, col: 2 }, 'up').focus).toEqual({ row: peekRow - 1, col: 1 });
  });

  it('the foot has two buttons: 初期に戻す and 戻る', () => {
    expect(stepKeys({ row: FOOT_ROW, col: 0 }, 'right').focus).toEqual({ row: FOOT_ROW, col: 1 });
    expect(stepKeys({ row: FOOT_ROW, col: 1 }, 'right').moved).toBe(false);
    expect(stepKeys({ row: FOOT_ROW, col: 0 }, 'choose').reset).toBe(true);
    expect(stepKeys({ row: FOOT_ROW, col: 1 }, 'choose').leave).toBe(true);
  });

  it('Enter / A on a cell waits for a key (キーを押してください); Esc / B leaves the page (一つ前に戻る)', () => {
    const s = stepKeys({ row: 0, col: 1 }, 'choose');
    expect(s.waiting).toEqual({ action: 'moveForward', device: 'keyboardMouse', slot: 1 });
    const peekRow = KEY_ROWS.indexOf('peek');
    expect(stepKeys({ row: peekRow, col: 2 }, 'choose').waiting).toEqual(pad);
    expect(stepKeys({ row: 3, col: 0 }, 'back').leave).toBe(true);
    expect(stepKeys({ row: 3, col: 0 }, 'back').waiting).toBeNull();
    // the tabs do not change here
    expect(stepKeys({ row: 3, col: 0 }, 'nextTab').moved).toBe(false);
  });

  it('a click on a cell focuses it and waits; on the stick, nothing', () => {
    const s = pickKeys({ row: 2, col: 0 });
    expect(s.focus).toEqual({ row: 2, col: 0 });
    expect(s.waiting).toEqual({ action: 'moveLeft', device: 'keyboardMouse', slot: 0 });
    expect(pickKeys({ row: 0, col: 2 }).waiting).toBeNull();
    expect(pickKeys({ row: FOOT_ROW, col: 0 }).reset).toBe(true);
  });
});

describe('S-45 capturing the key pressed while waiting', () => {
  it('a key for a key’s cell; Esc gives up the waiting (待ちの間の Esc は割り当てをやめて一覧へ戻る)', () => {
    expect(captureKey(km, 'KeyP')).toEqual({ kind: 'bind', code: 'KeyP' });
    expect(captureKey(km, 'Escape')).toEqual({ kind: 'cancel' });
    // a modifier is the browser's (Ctrl+…): it waits on
    expect(captureKey(km, 'ControlLeft')).toEqual({ kind: 'ignore' });
  });

  it('the mouse’s buttons and wheel for a key’s cell too', () => {
    expect(captureMouse(km, 2)).toEqual({ kind: 'bind', code: 'Mouse2' });
    expect(captureMouse(km, 0)).toEqual({ kind: 'bind', code: 'Mouse0' });
    expect(captureWheel(km, -120)).toEqual({ kind: 'bind', code: 'WheelUp' });
    expect(captureWheel(km, 40)).toEqual({ kind: 'bind', code: 'WheelDown' });
    expect(captureWheel(km, 0)).toEqual({ kind: 'ignore' });
  });

  it('a pad button for a pad’s cell; B and Start give up (fixed), keys and the mouse are not taken', () => {
    expect(capturePad(pad, 'PadX')).toEqual({ kind: 'bind', code: 'PadX' });
    expect(capturePad(pad, 'PadB')).toEqual({ kind: 'cancel' });
    expect(capturePad(pad, 'PadStart')).toEqual({ kind: 'cancel' });
    expect(capturePad(pad, 'PadHome')).toEqual({ kind: 'ignore' });
    expect(captureKey(pad, 'KeyP')).toEqual({ kind: 'ignore' });
    expect(captureKey(pad, 'Escape')).toEqual({ kind: 'cancel' });
    expect(captureMouse(pad, 0)).toEqual({ kind: 'ignore' });
  });

  it('B on the pad gives up a key’s waiting too (パッドだけでも); other pad buttons do not bind a key', () => {
    expect(capturePad(km, 'PadB')).toEqual({ kind: 'cancel' });
    expect(capturePad(km, 'PadA')).toEqual({ kind: 'ignore' });
  });
});

describe('S-45 keysNotice: 何が入れ替わったかを書く', () => {
  it('says which action the key came from and what that action has now', () => {
    expect(keysNotice('ja', 'KeyW', [{ action: 'moveForward', code: 'KeyW', gave: 'KeyE' }])).toBe(
      'W を「前へ進む」から移し、「前へ進む」は E にしました',
    );
    expect(keysNotice('en', 'KeyW', [{ action: 'moveForward', code: 'KeyW', gave: 'KeyE' }])).toBe(
      'W moved from “Move forward”, which now uses E',
    );
    expect(keysNotice('ja', 'KeyS', [{ action: 'moveBack', code: 'KeyS', gave: null }])).toBe(
      'S を「後ろへ下がる」から外しました',
    );
    expect(keysNotice('ja', 'KeyP', [])).toBeNull();
  });

  it('uses the defaults as data, never changing them', () => {
    expect(DEFAULT_BINDINGS.keyboardMouse.moveForward).toEqual(['KeyW']);
  });
});
