import { describe, expect, it } from 'vitest';
import { assignBinding, DEFAULT_BINDINGS } from './bindings';
import { controlWords, keyLabel, promptKey } from './key-labels';

describe('S-45 keyLabel: how a key or a button reads (日本語・English)', () => {
  it('letters, digits and the common keys', () => {
    expect(keyLabel('KeyE', 'ja')).toBe('E');
    expect(keyLabel('KeyE', 'en')).toBe('E');
    expect(keyLabel('Digit1', 'ja')).toBe('1');
    expect(keyLabel('Space', 'ja')).toBe('スペース');
    expect(keyLabel('Space', 'en')).toBe('Space');
    expect(keyLabel('ShiftLeft', 'ja')).toBe('左Shift');
    expect(keyLabel('ShiftRight', 'en')).toBe('Right Shift');
    expect(keyLabel('ArrowUp', 'ja')).toBe('↑');
    expect(keyLabel('Semicolon', 'en')).toBe(';');
    expect(keyLabel('Numpad5', 'en')).toBe('Num 5');
    expect(keyLabel('Escape', 'ja')).toBe('Esc');
  });

  it('the mouse and its wheel', () => {
    expect(keyLabel('Mouse0', 'ja')).toBe('左クリック');
    expect(keyLabel('Mouse2', 'ja')).toBe('右クリック');
    expect(keyLabel('Mouse2', 'en')).toBe('Right click');
    expect(keyLabel('Mouse1', 'en')).toBe('Middle click');
    expect(keyLabel('Mouse3', 'ja')).toBe('マウス4');
    expect(keyLabel('WheelUp', 'ja')).toBe('ホイール上');
    expect(keyLabel('WheelDown', 'en')).toBe('Wheel down');
  });

  it('the pad’s buttons (standard mapping)', () => {
    expect(keyLabel('PadA', 'ja')).toBe('A');
    expect(keyLabel('PadLT', 'en')).toBe('LT');
    expect(keyLabel('PadL3', 'ja')).toBe('L3');
    expect(keyLabel('PadLeft', 'ja')).toBe('十字←');
    expect(keyLabel('PadRight', 'en')).toBe('D-pad →');
  });

  it('an unknown code reads as itself (never blank)', () => {
    expect(keyLabel('IntlYen', 'ja')).toBe('IntlYen');
  });
});

describe('S-45 controlWords: ゲーム中の操作表示 shows the keys bound', () => {
  it('with the default bindings, the words are as they were (S-06, S-43)', () => {
    expect(controlWords('ja', DEFAULT_BINDINGS, 'keyboardMouse')).toEqual({
      lock: 'クリックで視点を固定 ・ WASD 歩く ・ 右クリック 覗く ・ E 置く／拾う／調べる ・ Esc 解除',
      take: 'E　手に取る',
      place: 'E　置く',
      pickup: 'E　拾う',
      touch: 'E　触れる',
    });
    expect(controlWords('en', DEFAULT_BINDINGS, 'keyboardMouse')).toEqual({
      lock: 'Click to look around · WASD walk · Right click peek · E place / pick up / touch · Esc release',
      take: 'E  Take',
      place: 'E  Place',
      pickup: 'E  Pick up',
      touch: 'E  Touch',
    });
  });

  it('a rebound key shows in the prompt and the hint', () => {
    let b = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'interact', 1, 'KeyF').bindings;
    b = assignBinding(b, 'keyboardMouse', 'moveForward', 0, 'KeyI').bindings;
    b = assignBinding(b, 'keyboardMouse', 'peek', 0, 'KeyP').bindings;
    const w = controlWords('ja', b, 'keyboardMouse');
    expect(w.take).toBe('F　手に取る');
    expect(w.lock).toBe('クリックで視点を固定 ・ IASD 歩く ・ P 覗く ・ F 置く／拾う／調べる ・ Esc 解除');
  });

  it('keys that are not single letters are spaced apart', () => {
    const b = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'moveForward', 0, 'ArrowUp').bindings;
    expect(controlWords('en', b, 'keyboardMouse').lock).toContain('↑ A S D walk');
  });

  it('the prompt names a key rather than a mouse button when both are bound (E, not 左クリック)', () => {
    expect(promptKey(DEFAULT_BINDINGS, 'keyboardMouse', 'interact')).toBe('KeyE');
    const mouseOnly = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'peek', 0, 'KeyE').bindings;
    // E went to 覗く; 置く keeps the left click and gets 右クリック in E's place
    expect(promptKey(mouseOnly, 'keyboardMouse', 'interact')).toBe('Mouse0');
  });

  it('on the pad, the prompt shows the pad’s button (A　置く); the mouse hint stays the keyboard’s', () => {
    const w = controlWords('ja', DEFAULT_BINDINGS, 'gamepad');
    expect(w.place).toBe('A　置く');
    expect(w.lock).toBe(controlWords('ja', DEFAULT_BINDINGS, 'keyboardMouse').lock);
    const x = assignBinding(DEFAULT_BINDINGS, 'gamepad', 'interact', 0, 'PadX').bindings;
    expect(controlWords('en', x, 'gamepad').touch).toBe('X  Touch');
  });

  it('an action with nothing bound reads as a dash, not as blank', () => {
    const b = assignBinding(DEFAULT_BINDINGS, 'gamepad', 'peek', 0, 'PadA').bindings;
    // 置く took LT from 覗く; nothing is left without a button. Clear 置く on the pad by hand:
    b.gamepad.interact = [];
    expect(controlWords('ja', b, 'gamepad').place).toBe('—　置く');
  });
});
