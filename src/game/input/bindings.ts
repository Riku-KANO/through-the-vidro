/**
 * Actions and their default bindings, from 操作とカメラ > 入力の割り当て.
 * Bindings are plain JSON (codes are KeyboardEvent.code, 'Mouse<n>', 'WheelUp'/'WheelDown', 'Pad<name>'),
 * so a settings screen can rebind them and the save can store them. Everything here is pure.
 */
export const BUTTON_ACTIONS = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'peek',
  'interact',
  'ring',
  'orbPrev',
  'orbNext',
  'orb1',
  'orb2',
  'orb3',
  'sprint',
  'pause',
] as const;

export type ButtonAction = (typeof BUTTON_ACTIONS)[number];
export type Device = 'keyboardMouse' | 'gamepad';
export type Stick = 'left' | 'right';
export type ActionCodes = Record<ButtonAction, string[]>;

export interface Bindings {
  keyboardMouse: ActionCodes;
  gamepad: ActionCodes;
  /** Gamepad sticks: 移動 = 左スティック, 視点 = 右スティック by default. */
  sticks: { move: Stick; look: Stick };
}

/** 覗く操作は「長押し」と「押すたびに切り替え」を設定で選べる. */
export type PeekMode = 'hold' | 'toggle';

/**
 * Chord actions only fire while peeking and then win over the other actions on the same input
 * (鳴らす = 覗きながら左クリック / 覗きながらRT).
 */
export const WHILE_PEEKING: ReadonlySet<ButtonAction> = new Set<ButtonAction>(['ring']);

export interface PressContext {
  peeking: boolean;
  /** 鳴らす is unlocked by the 鳴る property (ガラス玉の性質の成長). */
  canRing: boolean;
}

export interface Vec2 {
  x: number;
  y: number;
}

export const DEFAULT_BINDINGS: Readonly<Bindings> = Object.freeze<Bindings>({
  keyboardMouse: {
    moveForward: ['KeyW'],
    moveBack: ['KeyS'],
    moveLeft: ['KeyA'],
    moveRight: ['KeyD'],
    peek: ['Mouse2'],
    interact: ['Mouse0', 'KeyE'],
    ring: ['Mouse0'],
    orbPrev: ['WheelUp'],
    orbNext: ['WheelDown'],
    orb1: ['Digit1'],
    orb2: ['Digit2'],
    orb3: ['Digit3'],
    sprint: ['ShiftLeft', 'ShiftRight'],
    pause: ['Escape'],
  },
  gamepad: {
    moveForward: [],
    moveBack: [],
    moveLeft: [],
    moveRight: [],
    peek: ['PadLT'],
    interact: ['PadA'],
    ring: ['PadRT'],
    orbPrev: ['PadLeft'],
    orbNext: ['PadRight'],
    orb1: [],
    orb2: [],
    orb3: [],
    sprint: ['PadL3'],
    pause: ['PadStart'],
  },
  sticks: { move: 'left', look: 'right' },
});

/** Actions triggered by pressing `code`. Chord actions take over the input while peeking. */
export function actionsForPress(
  bindings: Bindings,
  device: Device,
  code: string,
  ctx: PressContext,
): ButtonAction[] {
  const bound = BUTTON_ACTIONS.filter((a) => bindings[device][a].includes(code));
  const chords = bound.filter((a) => WHILE_PEEKING.has(a) && ctx.peeking && (a !== 'ring' || ctx.canRing));
  if (chords.length > 0) return chords;
  return bound.filter((a) => !WHILE_PEEKING.has(a));
}

export function isHeld(
  bindings: Bindings,
  device: Device,
  action: ButtonAction,
  pressed: ReadonlySet<string>,
): boolean {
  return bindings[device][action].some((code) => pressed.has(code));
}

/** Movement from keys: y = forward, x = right. Diagonals are normalised. */
export function moveAxisFromKeys(bindings: Bindings, pressed: ReadonlySet<string>): Vec2 {
  const held = (a: ButtonAction) => (isHeld(bindings, 'keyboardMouse', a, pressed) ? 1 : 0);
  const x = held('moveRight') - held('moveLeft');
  const y = held('moveForward') - held('moveBack');
  const len = Math.hypot(x, y);
  return len > 1 ? { x: x / len, y: y / len } : { x, y };
}

export function nextPeekActive(mode: PeekMode, active: boolean, edge: 'press' | 'release'): boolean {
  if (mode === 'hold') return edge === 'press';
  return edge === 'press' ? !active : active;
}

export interface RebindResult {
  bindings: Bindings;
  /** Bindings that were removed because the code now belongs to `action`. */
  displaced: { action: ButtonAction; code: string }[];
}

/**
 * Binds `code` to `action` at `slot` (appends if the slot does not exist yet).
 * The code is taken away from other actions on the same device, except that a chord action
 * (覗きながら) may share its input with a normal action.
 */
export function rebind(
  bindings: Bindings,
  device: Device,
  action: ButtonAction,
  code: string,
  slot = 0,
): RebindResult {
  const next = cloneBindings(bindings);
  const codes = next[device];
  const displaced: RebindResult['displaced'] = [];
  for (const other of BUTTON_ACTIONS) {
    if (other === action || WHILE_PEEKING.has(other) !== WHILE_PEEKING.has(action)) continue;
    if (codes[other].includes(code)) {
      codes[other] = codes[other].filter((c) => c !== code);
      displaced.push({ action: other, code });
    }
  }
  const own = codes[action].filter((c, i) => c !== code || i === slot);
  if (slot < own.length) own[slot] = code;
  else own.push(code);
  codes[action] = own;
  return { bindings: next, displaced };
}

export function cloneBindings(bindings: Bindings): Bindings {
  const copy = (codes: ActionCodes) =>
    Object.fromEntries(BUTTON_ACTIONS.map((a) => [a, [...codes[a]]])) as ActionCodes;
  return {
    keyboardMouse: copy(bindings.keyboardMouse),
    gamepad: copy(bindings.gamepad),
    sticks: { ...bindings.sticks },
  };
}

/** Reads saved bindings. Anything missing or malformed falls back to the defaults. */
export function parseBindings(value: unknown): Bindings {
  const out = cloneBindings(DEFAULT_BINDINGS);
  if (!isRecord(value)) return out;
  for (const device of ['keyboardMouse', 'gamepad'] as const) {
    const saved = value[device];
    if (!isRecord(saved)) continue;
    for (const action of BUTTON_ACTIONS) {
      const codes = saved[action];
      if (Array.isArray(codes) && codes.every((c) => typeof c === 'string')) out[device][action] = [...codes];
    }
  }
  const sticks = value.sticks;
  if (isRecord(sticks) && isStick(sticks.move) && isStick(sticks.look)) {
    out.sticks = { move: sticks.move, look: sticks.look };
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStick(value: unknown): value is Stick {
  return value === 'left' || value === 'right';
}
