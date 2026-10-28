import { PAD_BUTTON_CODES } from './gamepad';

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

/**
 * S-45 (操作とカメラ: すべてのキーは設定で割り当て直せます): the actions the settings' key page lists, in its order — 移動, 覗く,
 * 置く・拾う・調べる, 小玉の切り替え, 早歩き. The pause (Esc / Start) is fixed, and so is 鳴らす (覗きながら左クリック: a chord of 置く).
 */
export const REBINDABLE: readonly ButtonAction[] = [
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
];
/** How many keys an action may have on a device (the key page's キー and キー（副）; the pad's one button fits). */
export const MAX_SLOTS = 2;
/** Codes no action may take: Esc (ポーズと戻る), the pad's Start and B (the pause, the way back), the pad's Home (the system's). */
const FIXED_CODES: ReadonlySet<string> = new Set(['Escape', 'PadStart', 'PadB', 'PadHome']);
/** Keys the input never reads as presses (it leaves the browser's shortcuts alone: input-system.ts onKeyDown). */
const UNREAD_KEYS: ReadonlySet<string> = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'ContextMenu',
  'Unidentified',
]);
const PAD_CODES: ReadonlySet<string> = new Set(PAD_BUTTON_CODES);

/** Whether `code` can be bound on `device`: a key, a mouse button or the wheel; or a pad's button. Never a fixed one. */
export function bindableCode(device: Device, code: string): boolean {
  if (!code || FIXED_CODES.has(code)) return false;
  if (device === 'gamepad') return PAD_CODES.has(code);
  return !code.startsWith('Pad') && !UNREAD_KEYS.has(code);
}

/** An action that lost a code to another: it took `gave` in its place (入れ替え), or nothing (null). */
export interface Swap {
  action: ButtonAction;
  code: string;
  gave: string | null;
}

export interface AssignResult {
  bindings: Bindings;
  swaps: Swap[];
}

/**
 * S-45: binds `code` at `slot` of `action` on `device` (the key page). Whichever other action had the code takes the code this
 * slot had in exchange (重なったら前の持ち主と入れ替え), or loses it when the slot was empty; the code in the action's other
 * slot changes places within it. A fixed code, an action that is not rebindable, or a code not of the device: nothing changes.
 */
export function assignBinding(
  bindings: Bindings,
  device: Device,
  action: ButtonAction,
  slot: number,
  code: string,
): AssignResult {
  const next = cloneBindings(bindings);
  if (!REBINDABLE.includes(action) || !bindableCode(device, code) || slot < 0 || slot >= MAX_SLOTS)
    return { bindings: next, swaps: [] };
  const codes = next[device];
  const own = codes[action];
  const old = own[slot] ?? null;
  if (old === code) return { bindings: next, swaps: [] };
  const swaps: Swap[] = [];
  const j = own.indexOf(code);
  if (j >= 0) {
    // the action has it in its other slot: the two change places (or, with nothing here, it stays where it is)
    if (old === null) return { bindings: next, swaps: [] };
    own[j] = old;
  }
  for (const other of BUTTON_ACTIONS) {
    if (other === action || WHILE_PEEKING.has(other) !== WHILE_PEEKING.has(action)) continue;
    const list = codes[other];
    const k = list.indexOf(code);
    if (k < 0) continue;
    const gave = old !== null && !list.includes(old) ? old : null;
    if (gave !== null) list[k] = gave;
    else list.splice(k, 1);
    swaps.push({ action: other, code, gave });
  }
  if (slot < own.length) own[slot] = code;
  else own.push(code);
  return { bindings: next, swaps };
}

/**
 * S-45: bindings read from the kept settings (割り当ての読み書きの判定): what is missing or malformed is the default; the pause
 * and the chords keep theirs; a rebindable action keeps its bindable codes, each once, at most two; a code that two of them
 * hold on one device (a record that could not have been made) puts that device back to its defaults.
 */
export function sanitizeBindings(value: unknown): Bindings {
  const parsed = parseBindings(value);
  const out = cloneBindings(DEFAULT_BINDINGS);
  out.sticks = parsed.sticks;
  for (const device of ['keyboardMouse', 'gamepad'] as const) {
    const kept: Partial<ActionCodes> = {};
    const seen = new Set<string>();
    let broken = false;
    for (const action of REBINDABLE) {
      const codes: string[] = [];
      for (const c of parsed[device][action]) {
        if (codes.length >= MAX_SLOTS || !bindableCode(device, c) || codes.includes(c)) continue;
        if (seen.has(c)) broken = true;
        seen.add(c);
        codes.push(c);
      }
      kept[action] = codes;
    }
    if (broken) continue;
    for (const action of REBINDABLE) out[device][action] = kept[action] ?? [];
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStick(value: unknown): value is Stick {
  return value === 'left' || value === 'right';
}
