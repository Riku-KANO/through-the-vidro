import {
  actionsForPress,
  type Bindings,
  cloneBindings,
  DEFAULT_BINDINGS,
  type Device,
  isHeld,
  moveAxisFromKeys,
  nextPeekActive,
  type PeekMode,
  type Stick,
  type Vec2,
} from './bindings';
import { mouseLookDelta, nextSprintLatch, padCodesPressed, radialDeadzone, stickLookDelta } from './gamepad';

/**
 * DOM side of input (操作とカメラ > 入力の割り当て): keyboard, mouse with Pointer Lock, wheel and the
 * first standard gamepad. Each frame the owner calls update(dt), reads `move` and `sprint`, and takes the
 * accumulated look with consumeLook(). One-shot actions arrive as events through on().
 *
 * Pointer Lock: the first left click locks the mouse (and does nothing else); the browser releases it on Esc,
 * which is reported as a pause. Without a lock (headless tests, or when the browser refuses), dragging with the
 * left button turns the view instead.
 */
export interface InputSettings {
  peekMode: PeekMode;
  /** Radians per pixel of mouse movement. */
  mouseSensitivity: number;
  /** Radians per second at full stick tilt. */
  padLookSpeed: number;
  invertY: boolean;
  padDeadzone: number;
}

/** 調整値 except peekMode, whose default (長押し) is the first option in the design table. */
export const DEFAULT_INPUT_SETTINGS: Readonly<InputSettings> = Object.freeze({
  peekMode: 'hold',
  mouseSensitivity: 0.0022,
  padLookSpeed: 2.6,
  invertY: false,
  padDeadzone: 0.15,
});

export type InputEvent =
  | { type: 'peekStart' | 'peekEnd' | 'interact' | 'ring' | 'pause'; device: Device }
  | { type: 'orbStep'; delta: -1 | 1; device: Device }
  | { type: 'orbSelect'; index: 0 | 1 | 2; device: Device };

export interface InputSystemOptions {
  bindings?: Bindings;
  settings?: Partial<InputSettings>;
}

/** Mouse deltas larger than this in one event are browser glitches (seen right after locking). */
const MAX_MOUSE_DELTA = 400;
/** Wheel: pixels of scroll per orb step, and the shortest time between steps (trackpads fire many events). */
const WHEEL_STEP = 50;
const WHEEL_COOLDOWN_MS = 120;

export class InputSystem {
  bindings: Bindings;
  settings: InputSettings;
  /** S-02: return false while the orb is placed (玉を置いているときは覗けない). A running peek is then ended. */
  canPeek: () => boolean = () => true;
  /** 鳴らす becomes available with the 鳴る property (ガラス玉の性質の成長). */
  canRing = false;

  /** Movement this frame: y = forward, x = right, length ≤ 1. */
  move: Vec2 = { x: 0, y: 0 };
  sprint = false;
  lastDevice: Device = 'keyboardMouse';
  /** How many times a Pointer Lock was requested (for probes). */
  lockRequests = 0;

  private peekActive = false;
  private readonly keys = new Set<string>();
  private padHeld = new Set<string>();
  private padSprint = false;
  private look = { yaw: 0, pitch: 0 };
  private lockedValue = false;
  private exitingLock = false;
  private drag: { x: number; y: number } | null = null;
  private wheelAccum = 0;
  private lastWheelStep = 0;
  private readonly listeners = new Set<(e: InputEvent) => void>();
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly target: HTMLElement,
    opts: InputSystemOptions = {},
  ) {
    this.bindings = cloneBindings(opts.bindings ?? DEFAULT_BINDINGS);
    this.settings = { ...DEFAULT_INPUT_SETTINGS, ...opts.settings };

    const doc = target.ownerDocument;
    const win = doc.defaultView ?? window;
    this.listen(win, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    this.listen(win, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e.code));
    this.listen(target, 'mousedown', (e: MouseEvent) => this.onMouseDown(e));
    this.listen(win, 'mouseup', (e: MouseEvent) => this.onMouseUp(e));
    this.listen(win, 'mousemove', (e: MouseEvent) => this.onMouseMove(e));
    this.listen(target, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: true });
    this.listen(target, 'contextmenu', (e: Event) => e.preventDefault());
    this.listen(doc, 'pointerlockchange', () => this.onLockChange());
    this.listen(win, 'blur', () => this.releaseAll());
  }

  get peeking(): boolean {
    return this.peekActive;
  }

  get locked(): boolean {
    return this.lockedValue;
  }

  on(listener: (e: InputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Look change since the last call, in radians (yaw positive = left, pitch positive = up). */
  consumeLook(): { yaw: number; pitch: number } {
    const out = this.look;
    this.look = { yaw: 0, pitch: 0 };
    return out;
  }

  /** Ends a peek from outside, e.g. when the orb is placed. */
  cancelPeek(): void {
    this.setPeek(false, this.lastDevice);
  }

  requestLock(): void {
    this.lockRequests++;
    // Raw mouse input feels steadier where supported; other browsers reject the option, so retry plainly.
    // Every rejection is caught: the browser refuses re-locking for a moment after Esc.
    const plain = () => {
      try {
        Promise.resolve(this.target.requestPointerLock()).catch(() => {});
      } catch {
        // Older browsers throw instead of rejecting.
      }
    };
    try {
      Promise.resolve(this.target.requestPointerLock({ unadjustedMovement: true })).catch(plain);
    } catch {
      plain();
    }
  }

  exitLock(): void {
    if (!this.lockedValue) return;
    this.exitingLock = true;
    this.target.ownerDocument.exitPointerLock();
  }

  update(dt: number): void {
    const padMove = this.pollGamepad(dt);
    const keyMove = moveAxisFromKeys(this.bindings, this.keys);
    const x = keyMove.x + padMove.x;
    const y = keyMove.y + padMove.y;
    const len = Math.hypot(x, y);
    this.move = len > 1 ? { x: x / len, y: y / len } : { x, y };
    this.sprint = isHeld(this.bindings, 'keyboardMouse', 'sprint', this.keys) || this.padSprint;
    if (this.peekActive && !this.canPeek()) this.setPeek(false, this.lastDevice);
  }

  dispose(): void {
    this.exitLock();
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
    this.listeners.clear();
  }

  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    handler: (e: E) => void,
    options?: AddEventListenerOptions,
  ): void {
    const fn = handler as EventListener;
    target.addEventListener(type, fn, options);
    this.cleanup.push(() => target.removeEventListener(type, fn, options));
  }

  private emit(e: InputEvent): void {
    for (const listener of this.listeners) listener(e);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
    if (this.keys.has(e.code) || e.repeat) return;
    this.keys.add(e.code);
    if (this.press('keyboardMouse', e.code)) e.preventDefault();
  }

  private onKeyUp(code: string): void {
    if (!this.keys.delete(code)) return;
    this.release('keyboardMouse', code);
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button === 0 && !this.lockedValue) {
      // The click that takes the mouse does nothing else; until the lock arrives (or if it never does)
      // dragging turns the view.
      this.drag = { x: e.clientX, y: e.clientY };
      this.requestLock();
      return;
    }
    const code = `Mouse${e.button}`;
    if (this.keys.has(code)) return;
    this.keys.add(code);
    this.press('keyboardMouse', code);
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.drag = null;
    this.onKeyUp(`Mouse${e.button}`);
  }

  private onMouseMove(e: MouseEvent): void {
    let dx: number;
    let dy: number;
    if (this.lockedValue) {
      dx = e.movementX;
      dy = e.movementY;
    } else if (this.drag) {
      dx = e.clientX - this.drag.x;
      dy = e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
    } else {
      return;
    }
    if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
    const d = mouseLookDelta(dx, dy, this.settings.mouseSensitivity, this.settings.invertY);
    this.look.yaw += d.yaw;
    this.look.pitch += d.pitch;
    this.lastDevice = 'keyboardMouse';
  }

  private onWheel(e: WheelEvent): void {
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    this.wheelAccum += e.deltaY * scale;
    const now = performance.now();
    if (Math.abs(this.wheelAccum) < WHEEL_STEP || now - this.lastWheelStep < WHEEL_COOLDOWN_MS) return;
    const code = this.wheelAccum < 0 ? 'WheelUp' : 'WheelDown';
    this.wheelAccum = 0;
    this.lastWheelStep = now;
    this.press('keyboardMouse', code);
  }

  private onLockChange(): void {
    const locked = this.target.ownerDocument.pointerLockElement === this.target;
    const lost = this.lockedValue && !locked;
    this.lockedValue = locked;
    if (locked) this.drag = null;
    // Esc while locked never reaches the page as a key: the browser just drops the lock. ポーズ = Esc.
    if (lost && !this.exitingLock) this.emit({ type: 'pause', device: 'keyboardMouse' });
    this.exitingLock = false;
  }

  /** Runs the actions bound to a pressed input. Returns whether anything was bound to it. */
  private press(device: Device, code: string): boolean {
    this.lastDevice = device;
    const actions = actionsForPress(this.bindings, device, code, {
      peeking: this.peekActive,
      canRing: this.canRing,
    });
    for (const action of actions) {
      switch (action) {
        case 'peek':
          this.setPeek(nextPeekActive(this.settings.peekMode, this.peekActive, 'press'), device);
          break;
        case 'interact':
        case 'ring':
          this.emit({ type: action, device });
          break;
        case 'pause':
          // Browsers normally swallow Esc while locked and drop the lock themselves (see onLockChange);
          // when the key does reach the page, release the mouse here so Esc always frees it.
          this.exitLock();
          this.emit({ type: action, device });
          break;
        case 'orbPrev':
        case 'orbNext':
          this.emit({ type: 'orbStep', delta: action === 'orbPrev' ? -1 : 1, device });
          break;
        case 'orb1':
        case 'orb2':
        case 'orb3':
          this.emit({ type: 'orbSelect', index: action === 'orb1' ? 0 : action === 'orb2' ? 1 : 2, device });
          break;
        case 'sprint':
          if (device === 'gamepad') this.padSprint = true;
          break;
        default:
          // Movement keys are read as held state in update().
          break;
      }
    }
    return actions.length > 0 || this.bindings[device].peek.includes(code);
  }

  private release(device: Device, code: string): void {
    const peekCodes = this.bindings[device].peek;
    if (!peekCodes.includes(code)) return;
    const held = device === 'gamepad' ? this.padHeld : this.keys;
    if (peekCodes.some((c) => held.has(c))) return;
    this.setPeek(nextPeekActive(this.settings.peekMode, this.peekActive, 'release'), device);
  }

  private setPeek(active: boolean, device: Device): void {
    if (active && !this.canPeek()) return;
    if (active === this.peekActive) return;
    this.peekActive = active;
    this.emit({ type: active ? 'peekStart' : 'peekEnd', device });
  }

  private releaseAll(): void {
    for (const code of [...this.keys]) this.onKeyUp(code);
    this.drag = null;
  }

  /** Reads the first connected gamepad: button edges become presses, sticks become move and look. */
  private pollGamepad(dt: number): Vec2 {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p): p is Gamepad => p?.connected === true);
    if (!pad) {
      if (this.padHeld.size > 0) {
        const held = this.padHeld;
        this.padHeld = new Set();
        for (const code of held) this.release('gamepad', code);
      }
      this.padSprint = false;
      return { x: 0, y: 0 };
    }
    const held = padCodesPressed(pad.buttons, this.padHeld);
    const previous = this.padHeld;
    this.padHeld = held;
    for (const code of held) if (!previous.has(code)) this.press('gamepad', code);
    for (const code of previous) if (!held.has(code)) this.release('gamepad', code);

    const stick = (s: Stick) =>
      radialDeadzone(
        pad.axes[s === 'left' ? 0 : 2] ?? 0,
        pad.axes[s === 'left' ? 1 : 3] ?? 0,
        this.settings.padDeadzone,
      );
    const move = stick(this.bindings.sticks.move);
    const look = stick(this.bindings.sticks.look);
    const d = stickLookDelta(look.x, look.y, dt, this.settings.padLookSpeed, this.settings.invertY);
    this.look.yaw += d.yaw;
    this.look.pitch += d.pitch;
    this.padSprint = nextSprintLatch(this.padSprint, false, Math.hypot(move.x, move.y));
    if (move.x !== 0 || move.y !== 0 || d.yaw !== 0 || d.pitch !== 0) this.lastDevice = 'gamepad';
    // The Gamepad API has y down; movement uses y forward.
    return { x: move.x, y: -move.y };
  }
}
