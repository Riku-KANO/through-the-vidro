import { describe, expect, it } from 'vitest';
import {
  actionsForPress,
  BUTTON_ACTIONS,
  DEFAULT_BINDINGS,
  isHeld,
  moveAxisFromKeys,
  nextPeekActive,
  parseBindings,
  rebind,
} from './bindings';

const idle = { peeking: false, canRing: true };
const peeking = { peeking: true, canRing: true };

describe('default bindings (操作とカメラ > 入力の割り当て)', () => {
  it('maps keyboard + mouse as in the design table', () => {
    const km = (code: string) => actionsForPress(DEFAULT_BINDINGS, 'keyboardMouse', code, idle);
    const held = (action: (typeof BUTTON_ACTIONS)[number], code: string) =>
      isHeld(DEFAULT_BINDINGS, 'keyboardMouse', action, new Set([code]));
    expect(held('moveForward', 'KeyW')).toBe(true);
    expect(held('moveLeft', 'KeyA')).toBe(true);
    expect(held('moveBack', 'KeyS')).toBe(true);
    expect(held('moveRight', 'KeyD')).toBe(true);
    expect(km('Mouse2')).toEqual(['peek']);
    expect(km('Mouse0')).toEqual(['interact']);
    expect(km('KeyE')).toEqual(['interact']);
    expect(km('WheelUp')).toEqual(['orbPrev']);
    expect(km('WheelDown')).toEqual(['orbNext']);
    expect([km('Digit1'), km('Digit2'), km('Digit3')]).toEqual([['orb1'], ['orb2'], ['orb3']]);
    expect(km('ShiftLeft')).toEqual(['sprint']);
    expect(km('Escape')).toEqual(['pause']);
  });

  it('maps the gamepad as in the design table', () => {
    const pad = (code: string, ctx = idle) => actionsForPress(DEFAULT_BINDINGS, 'gamepad', code, ctx);
    expect(DEFAULT_BINDINGS.sticks).toEqual({ move: 'left', look: 'right' });
    expect(pad('PadLT')).toEqual(['peek']);
    expect(pad('PadA')).toEqual(['interact']);
    expect(pad('PadLeft')).toEqual(['orbPrev']);
    expect(pad('PadRight')).toEqual(['orbNext']);
    expect(pad('PadL3')).toEqual(['sprint']);
    expect(pad('PadStart')).toEqual(['pause']);
    expect(pad('PadRT', peeking)).toEqual(['ring']);
  });

  it('every action has a binding on at least one device', () => {
    for (const action of BUTTON_ACTIONS) {
      const count = DEFAULT_BINDINGS.keyboardMouse[action].length + DEFAULT_BINDINGS.gamepad[action].length;
      expect(count, action).toBeGreaterThan(0);
    }
  });
});

describe('ring is a chord: 覗きながら左クリック / 覗きながらRT', () => {
  it('left click places/picks up normally and rings while peeking', () => {
    expect(actionsForPress(DEFAULT_BINDINGS, 'keyboardMouse', 'Mouse0', idle)).toEqual(['interact']);
    expect(actionsForPress(DEFAULT_BINDINGS, 'keyboardMouse', 'Mouse0', peeking)).toEqual(['ring']);
  });

  it('falls back to interact while peeking when ringing is not unlocked yet', () => {
    const ctx = { peeking: true, canRing: false };
    expect(actionsForPress(DEFAULT_BINDINGS, 'keyboardMouse', 'Mouse0', ctx)).toEqual(['interact']);
  });

  it('E stays interact while peeking, and RT does nothing unless peeking', () => {
    expect(actionsForPress(DEFAULT_BINDINGS, 'keyboardMouse', 'KeyE', peeking)).toEqual(['interact']);
    expect(actionsForPress(DEFAULT_BINDINGS, 'gamepad', 'PadRT', idle)).toEqual([]);
  });
});

describe('moveAxisFromKeys', () => {
  const axis = (...codes: string[]) => moveAxisFromKeys(DEFAULT_BINDINGS, new Set(codes));

  it('W is forward, D is right', () => {
    expect(axis('KeyW')).toEqual({ x: 0, y: 1 });
    expect(axis('KeyD')).toEqual({ x: 1, y: 0 });
  });

  it('diagonals are not faster than straight lines', () => {
    const v = axis('KeyW', 'KeyD');
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 6);
  });

  it('opposite keys cancel', () => {
    const v = axis('KeyW', 'KeyS');
    expect(Math.hypot(v.x, v.y)).toBe(0);
  });
});

describe('peek: hold or toggle (操作とカメラ > 入力の割り当て)', () => {
  it('hold: active only while pressed', () => {
    let active = nextPeekActive('hold', false, 'press');
    expect(active).toBe(true);
    active = nextPeekActive('hold', active, 'release');
    expect(active).toBe(false);
  });

  it('toggle: each press flips, release does nothing', () => {
    let active = nextPeekActive('toggle', false, 'press');
    active = nextPeekActive('toggle', active, 'release');
    expect(active).toBe(true);
    active = nextPeekActive('toggle', active, 'press');
    active = nextPeekActive('toggle', active, 'release');
    expect(active).toBe(false);
  });
});

describe('rebind', () => {
  it('moves an action to a new key', () => {
    const { bindings } = rebind(DEFAULT_BINDINGS, 'keyboardMouse', 'moveForward', 'ArrowUp');
    expect(moveAxisFromKeys(bindings, new Set(['ArrowUp']))).toEqual({ x: 0, y: 1 });
    expect(moveAxisFromKeys(bindings, new Set(['KeyW']))).toEqual({ x: 0, y: 0 });
  });

  it('a key used by another action is taken away from it and reported', () => {
    const { bindings, displaced } = rebind(DEFAULT_BINDINGS, 'keyboardMouse', 'interact', 'KeyW', 1);
    expect(displaced).toEqual([{ action: 'moveForward', code: 'KeyW' }]);
    expect(actionsForPress(bindings, 'keyboardMouse', 'KeyW', idle)).toEqual(['interact']);
    expect(isHeld(bindings, 'keyboardMouse', 'moveForward', new Set(['KeyW']))).toBe(false);
  });

  it('a chord action may share its input with a normal action', () => {
    const { bindings, displaced } = rebind(DEFAULT_BINDINGS, 'gamepad', 'ring', 'PadA');
    expect(displaced).toEqual([]);
    expect(actionsForPress(bindings, 'gamepad', 'PadA', idle)).toEqual(['interact']);
    expect(actionsForPress(bindings, 'gamepad', 'PadA', peeking)).toEqual(['ring']);
  });

  it('does not change the bindings it was given', () => {
    const before = JSON.stringify(DEFAULT_BINDINGS);
    rebind(DEFAULT_BINDINGS, 'keyboardMouse', 'pause', 'KeyP');
    expect(JSON.stringify(DEFAULT_BINDINGS)).toBe(before);
  });
});

describe('parseBindings (saved settings)', () => {
  it('round-trips through JSON', () => {
    const { bindings } = rebind(DEFAULT_BINDINGS, 'keyboardMouse', 'sprint', 'KeyQ');
    expect(parseBindings(JSON.parse(JSON.stringify(bindings)))).toEqual(bindings);
  });

  it('falls back to the defaults for missing or broken parts', () => {
    expect(parseBindings(null)).toEqual(DEFAULT_BINDINGS);
    const parsed = parseBindings({
      keyboardMouse: { moveForward: ['ArrowUp'], peek: 'Mouse2', bogus: ['KeyZ'] },
      sticks: { move: 'right', look: 'left' },
    });
    expect(parsed.keyboardMouse.moveForward).toEqual(['ArrowUp']);
    expect(parsed.keyboardMouse.peek).toEqual(DEFAULT_BINDINGS.keyboardMouse.peek);
    expect(parsed.gamepad).toEqual(DEFAULT_BINDINGS.gamepad);
    expect(parsed.sticks).toEqual({ move: 'right', look: 'left' });
    expect(parseBindings({ sticks: { move: 'up' } }).sticks).toEqual(DEFAULT_BINDINGS.sticks);
  });
});
