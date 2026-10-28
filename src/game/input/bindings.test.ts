import { describe, expect, it } from 'vitest';
import {
  actionsForPress,
  assignBinding,
  BUTTON_ACTIONS,
  bindableCode,
  cloneBindings,
  DEFAULT_BINDINGS,
  isHeld,
  moveAxisFromKeys,
  nextPeekActive,
  parseBindings,
  REBINDABLE,
  rebind,
  sanitizeBindings,
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

describe('S-45 assignBinding: the settings’ key page (すべてのキーは設定で割り当て直せる)', () => {
  it('the actions a player may bind: moving, peeking, placing, the small orbs and walking faster — not the pause', () => {
    expect(REBINDABLE).toEqual([
      'moveForward',
      'moveBack',
      'moveLeft',
      'moveRight',
      'peek',
      'interact',
      'orbPrev',
      'orbNext',
      'orb1',
      'orb2',
      'orb3',
      'sprint',
    ]);
    expect(REBINDABLE).not.toContain('pause');
  });

  it('binds a free key in place of the old one', () => {
    const { bindings, swaps } = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'moveForward', 0, 'KeyI');
    expect(bindings.keyboardMouse.moveForward).toEqual(['KeyI']);
    expect(swaps).toEqual([]);
    expect(moveAxisFromKeys(bindings, new Set(['KeyI']))).toEqual({ x: 0, y: 1 });
    expect(moveAxisFromKeys(bindings, new Set(['KeyW']))).toEqual({ x: 0, y: 0 });
  });

  it('a second key goes into the second slot, the first stays', () => {
    const { bindings } = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'peek', 1, 'KeyP');
    expect(bindings.keyboardMouse.peek).toEqual(['Mouse2', 'KeyP']);
  });

  it('a key another action holds is swapped: that action takes the key this slot had (重なったら前の持ち主と入れ替え)', () => {
    // 置く・拾う・調べる's second key (E) becomes W: 前へ進む, which had W, gets E
    const { bindings, swaps } = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'interact', 1, 'KeyW');
    expect(bindings.keyboardMouse.interact).toEqual(['Mouse0', 'KeyW']);
    expect(bindings.keyboardMouse.moveForward).toEqual(['KeyE']);
    expect(swaps).toEqual([{ action: 'moveForward', code: 'KeyW', gave: 'KeyE' }]);
    expect(actionsForPress(bindings, 'keyboardMouse', 'KeyW', idle)).toEqual(['interact']);
    expect(isHeld(bindings, 'keyboardMouse', 'moveForward', new Set(['KeyE']))).toBe(true);
  });

  it('a slot that was empty has nothing to give: the other action loses the key', () => {
    const { bindings, swaps } = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'moveForward', 1, 'KeyS');
    expect(bindings.keyboardMouse.moveForward).toEqual(['KeyW', 'KeyS']);
    expect(bindings.keyboardMouse.moveBack).toEqual([]);
    expect(swaps).toEqual([{ action: 'moveBack', code: 'KeyS', gave: null }]);
  });

  it('a key the action has in its other slot changes places within it', () => {
    const { bindings, swaps } = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'interact', 0, 'KeyE');
    expect(bindings.keyboardMouse.interact).toEqual(['KeyE', 'Mouse0']);
    expect(swaps).toEqual([]);
  });

  it('the pad’s buttons swap the same way, on their own device', () => {
    const { bindings, swaps } = assignBinding(DEFAULT_BINDINGS, 'gamepad', 'peek', 0, 'PadA');
    expect(bindings.gamepad.peek).toEqual(['PadA']);
    expect(bindings.gamepad.interact).toEqual(['PadLT']);
    expect(swaps).toEqual([{ action: 'interact', code: 'PadA', gave: 'PadLT' }]);
    expect(bindings.keyboardMouse).toEqual(DEFAULT_BINDINGS.keyboardMouse);
  });

  it('Esc and the pad’s Start and B are fixed (ポーズと戻る): nothing changes', () => {
    for (const [device, code] of [
      ['keyboardMouse', 'Escape'],
      ['gamepad', 'PadStart'],
      ['gamepad', 'PadB'],
    ] as const) {
      const r = assignBinding(DEFAULT_BINDINGS, device, 'interact', 0, code);
      expect(r.bindings).toEqual(DEFAULT_BINDINGS);
      expect(r.swaps).toEqual([]);
    }
    // nor can the pause itself be bound
    expect(assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'pause', 0, 'KeyP').bindings).toEqual(
      DEFAULT_BINDINGS,
    );
  });

  it('does not change the bindings it was given', () => {
    const before = JSON.stringify(DEFAULT_BINDINGS);
    assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'interact', 1, 'KeyW');
    expect(JSON.stringify(DEFAULT_BINDINGS)).toBe(before);
  });

  it('bindableCode: keys, mouse buttons and the wheel for the keyboard and mouse; the pad’s buttons for the pad', () => {
    for (const code of [
      'KeyI',
      'Digit4',
      'Space',
      'ShiftLeft',
      'ArrowUp',
      'Mouse0',
      'Mouse2',
      'Mouse3',
      'WheelUp',
    ])
      expect(bindableCode('keyboardMouse', code), code).toBe(true);
    // Esc is the pause and the way back; the modifiers are the browser's shortcuts (the input ignores them)
    for (const code of ['Escape', 'ControlLeft', 'AltRight', 'MetaLeft', 'PadA', '', 'Unidentified'])
      expect(bindableCode('keyboardMouse', code), code).toBe(false);
    for (const code of ['PadA', 'PadX', 'PadY', 'PadLB', 'PadRT', 'PadL3', 'PadUp', 'PadBack'])
      expect(bindableCode('gamepad', code), code).toBe(true);
    for (const code of ['PadB', 'PadStart', 'PadHome', 'KeyA', 'Mouse0', 'PadZ'])
      expect(bindableCode('gamepad', code), code).toBe(false);
  });
});

describe('S-45 sanitizeBindings: reading what was kept (割り当ての読み書きの判定)', () => {
  it('a kept binding round-trips', () => {
    let b = assignBinding(DEFAULT_BINDINGS, 'keyboardMouse', 'interact', 1, 'KeyW').bindings;
    b = assignBinding(b, 'gamepad', 'sprint', 0, 'PadX').bindings;
    expect(sanitizeBindings(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });

  it('nothing kept, or not an object: the defaults', () => {
    expect(sanitizeBindings(undefined)).toEqual(DEFAULT_BINDINGS);
    expect(sanitizeBindings('KeyW')).toEqual(DEFAULT_BINDINGS);
  });

  it('the pause stays Esc / Start whatever was kept, and no action keeps a fixed key', () => {
    const kept = cloneBindings(DEFAULT_BINDINGS);
    kept.keyboardMouse.pause = ['KeyP'];
    kept.keyboardMouse.interact = ['Escape', 'KeyE'];
    kept.gamepad.interact = ['PadB'];
    const b = sanitizeBindings(JSON.parse(JSON.stringify(kept)));
    expect(b.keyboardMouse.pause).toEqual(['Escape']);
    expect(b.gamepad.pause).toEqual(['PadStart']);
    expect(b.keyboardMouse.interact).toEqual(['KeyE']);
    expect(b.gamepad.interact).toEqual([]);
  });

  it('a key two actions hold (a broken record) puts that device back to its defaults', () => {
    const kept = cloneBindings(DEFAULT_BINDINGS);
    kept.keyboardMouse.moveForward = ['KeyQ'];
    kept.keyboardMouse.sprint = ['KeyQ'];
    kept.gamepad.sprint = ['PadX'];
    const b = sanitizeBindings(JSON.parse(JSON.stringify(kept)));
    expect(b.keyboardMouse).toEqual(DEFAULT_BINDINGS.keyboardMouse);
    expect(b.gamepad.sprint).toEqual(['PadX']);
  });

  it('codes that are not bindable, repeated, or past two slots are dropped', () => {
    const kept = cloneBindings(DEFAULT_BINDINGS);
    kept.keyboardMouse.interact = ['KeyE', 'KeyE', 'PadA', 'KeyF', 'KeyG'];
    const b = sanitizeBindings(JSON.parse(JSON.stringify(kept)));
    expect(b.keyboardMouse.interact).toEqual(['KeyE', 'KeyF']);
  });

  it('every action the player cannot bind keeps its default (鳴らす is a chord of 置く)', () => {
    const kept = cloneBindings(DEFAULT_BINDINGS);
    kept.keyboardMouse.ring = ['KeyR'];
    expect(sanitizeBindings(JSON.parse(JSON.stringify(kept))).keyboardMouse.ring).toEqual(['Mouse0']);
    for (const a of BUTTON_ACTIONS.filter((x) => !REBINDABLE.includes(x)))
      expect(sanitizeBindings(kept).gamepad[a]).toEqual(DEFAULT_BINDINGS.gamepad[a]);
  });
});
