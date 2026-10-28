import type { Vec2 } from './bindings';

/**
 * Gamepad and look math. Pure functions; the DOM side lives in input-system.ts.
 * Button names follow the W3C "standard" gamepad mapping.
 */
export const PAD_BUTTON_CODES = [
  'PadA',
  'PadB',
  'PadX',
  'PadY',
  'PadLB',
  'PadRB',
  'PadLT',
  'PadRT',
  'PadBack',
  'PadStart',
  'PadL3',
  'PadR3',
  'PadUp',
  'PadDown',
  'PadLeft',
  'PadRight',
  'PadHome',
] as const;

/** Analog buttons (the triggers) press above this value and release below RELEASE. */
const TRIGGER_PRESS = 0.5;
const TRIGGER_RELEASE = 0.3;

export interface PadButtonLike {
  pressed: boolean;
  value: number;
}

/** Codes of the buttons held now. `previous` gives the triggers some hysteresis. */
export function padCodesPressed(
  buttons: readonly PadButtonLike[],
  previous: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  buttons.forEach((b, i) => {
    const code = PAD_BUTTON_CODES[i];
    if (!code) return;
    const threshold = previous.has(code) ? TRIGGER_RELEASE : TRIGGER_PRESS;
    if (b.value > threshold || (b.pressed && b.value === 0)) out.add(code);
  });
  return out;
}

/** Radial dead zone that rescales the rest of the range, so motion starts from zero at the boundary. */
export function radialDeadzone(x: number, y: number, deadzone: number): Vec2 {
  const m = Math.hypot(x, y);
  if (m <= deadzone || m === 0) return { x: 0, y: 0 };
  const scaled = Math.min(1, (m - deadzone) / (1 - deadzone));
  return { x: (x / m) * scaled, y: (y / m) * scaled };
}

export interface LookDelta {
  /** Radians. Positive turns left (three.js rotation about +Y). */
  yaw: number;
  /** Radians. Positive looks up. */
  pitch: number;
}

const NO_BUTTONS: ReadonlySet<string> = new Set();

/**
 * The codes of the buttons held on the first connected pad (none without one): the screens that read the pad themselves
 * (the home, the pause, the settings) all read it this way. `previous` gives the triggers their hysteresis.
 */
export function readFirstPad(previous: ReadonlySet<string>): ReadonlySet<string> {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) if (p?.connected) return padCodesPressed(p.buttons, previous);
  return NO_BUTTONS;
}

/** 調整値 (S-03): radians per pixel of mouse movement — the settings' マウスの感度 ×1. */
export const MOUSE_RADIANS_PER_PIXEL = 0.0022;
/** 仮 (S-43, 設定 > 操作 > マウスの感度): how far the player may scale it. */
export const MOUSE_SENSITIVITY_RANGE = { min: 0.25, max: 3 } as const;

/** The mouse's radians per pixel for the settings' sensitivity (×, clamped to its range; ×1 if not a number). */
export function mouseSensitivityFor(scale: number): number {
  const s = Number.isFinite(scale)
    ? Math.min(MOUSE_SENSITIVITY_RANGE.max, Math.max(MOUSE_SENSITIVITY_RANGE.min, scale))
    : 1;
  return MOUSE_RADIANS_PER_PIXEL * s;
}

/** Mouse movement in pixels → look delta. Moving right turns right, moving down looks down. */
export function mouseLookDelta(dx: number, dy: number, sensitivity: number, invertY: boolean): LookDelta {
  return { yaw: -dx * sensitivity, pitch: (invertY ? dy : -dy) * sensitivity };
}

/**
 * Stick (already dead-zoned, y down positive as in the Gamepad API) → look delta over dt.
 * A squared response curve gives fine control near the centre and full speed at full tilt.
 */
export function stickLookDelta(x: number, y: number, dt: number, speed: number, invertY: boolean): LookDelta {
  const m = Math.hypot(x, y);
  if (m === 0) return { yaw: 0, pitch: 0 };
  const rate = (speed * Math.min(1, m) ** 2) / m;
  return { yaw: -x * rate * dt, pitch: (invertY ? y : -y) * rate * dt };
}

/** Below this stick magnitude a clicked-in sprint ends (早歩き: 左スティック押し込み). */
const SPRINT_RELEASE_MAGNITUDE = 0.2;

/** Clicking the stick latches sprint until the stick is let go, so it need not be held in. */
export function nextSprintLatch(latched: boolean, sprintPressed: boolean, stickMagnitude: number): boolean {
  if (sprintPressed) return true;
  return latched && stickMagnitude >= SPRINT_RELEASE_MAGNITUDE;
}
