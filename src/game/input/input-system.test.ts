import { describe, expect, it } from 'vitest';
import { type InputEvent, InputSystem } from './input-system';

/**
 * The DOM side of input, driven through Node's EventTarget (no browser): what a refused peek reports.
 * 玉を置いているときは覗けない (S-06: the placed orb trembles), so the press has to be told apart from nothing.
 */
function setup(peekMode: 'hold' | 'toggle', canPeek: boolean) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    defaultView: win,
    pointerLockElement: null,
    exitPointerLock() {},
  });
  const target = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    requestPointerLock: () => Promise.resolve(),
  });
  const input = new InputSystem(target as unknown as HTMLElement, { settings: { peekMode } });
  input.canPeek = () => canPeek;
  const events: InputEvent['type'][] = [];
  input.on((e) => events.push(e.type));
  const mouse = (on: EventTarget, type: string, button: number) =>
    on.dispatchEvent(Object.assign(new Event(type), { button, clientX: 0, clientY: 0 }));
  return {
    input,
    events,
    press: () => mouse(target, 'mousedown', 2),
    release: () => mouse(win, 'mouseup', 2),
  };
}

describe('a refused peek (peekDenied)', () => {
  it('hold: pressing while peeking is not possible reports peekDenied once, never peekStart', () => {
    const t = setup('hold', false);
    t.press();
    expect(t.events).toEqual(['peekDenied']);
    expect(t.input.peeking).toBe(false);
    t.release();
    expect(t.events).toEqual(['peekDenied']);
    t.input.dispose();
  });

  it('toggle: the same, and the next press is refused again rather than turning a peek off', () => {
    const t = setup('toggle', false);
    t.press();
    t.release();
    t.press();
    t.release();
    expect(t.events).toEqual(['peekDenied', 'peekDenied']);
    expect(t.input.peeking).toBe(false);
    t.input.dispose();
  });

  it('when peeking is possible a press starts the peek and nothing is refused', () => {
    const t = setup('hold', true);
    t.press();
    t.release();
    expect(t.events).toEqual(['peekStart', 'peekEnd']);
    t.input.dispose();
  });
});
