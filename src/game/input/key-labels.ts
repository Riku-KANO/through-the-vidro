import type { Bindings, ButtonAction, Device } from './bindings';

/**
 * S-45: how a bound key or button reads on the screen — the settings' key page, and the game's own words (ゲーム中の操作表示:
 * 「E　置く」 shows the key bound now). Pure; the languages of 英語版 (UI/UX設計).
 */
export type LabelLang = 'ja' | 'en';

const NAMED: Readonly<Record<string, { ja: string; en: string }>> = {
  Space: { ja: 'スペース', en: 'Space' },
  Enter: { ja: 'Enter', en: 'Enter' },
  NumpadEnter: { ja: 'テンキーEnter', en: 'Num Enter' },
  Tab: { ja: 'Tab', en: 'Tab' },
  Backspace: { ja: 'Backspace', en: 'Backspace' },
  Escape: { ja: 'Esc', en: 'Esc' },
  CapsLock: { ja: 'CapsLock', en: 'Caps Lock' },
  ShiftLeft: { ja: '左Shift', en: 'Left Shift' },
  ShiftRight: { ja: '右Shift', en: 'Right Shift' },
  ArrowUp: { ja: '↑', en: '↑' },
  ArrowDown: { ja: '↓', en: '↓' },
  ArrowLeft: { ja: '←', en: '←' },
  ArrowRight: { ja: '→', en: '→' },
  Mouse0: { ja: '左クリック', en: 'Left click' },
  Mouse1: { ja: '中クリック', en: 'Middle click' },
  Mouse2: { ja: '右クリック', en: 'Right click' },
  Mouse3: { ja: 'マウス4', en: 'Mouse 4' },
  Mouse4: { ja: 'マウス5', en: 'Mouse 5' },
  WheelUp: { ja: 'ホイール上', en: 'Wheel up' },
  WheelDown: { ja: 'ホイール下', en: 'Wheel down' },
  PadUp: { ja: '十字↑', en: 'D-pad ↑' },
  PadDown: { ja: '十字↓', en: 'D-pad ↓' },
  PadLeft: { ja: '十字←', en: 'D-pad ←' },
  PadRight: { ja: '十字→', en: 'D-pad →' },
};

const SYMBOLS: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** The words for a code (KeyboardEvent.code, 'Mouse<n>', 'Wheel…', 'Pad…'); an unknown one reads as itself. */
export function keyLabel(code: string, lang: LabelLang): string {
  const named = NAMED[code];
  if (named) return named[lang];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `${lang === 'ja' ? 'テンキー' : 'Num '}${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  const symbol = SYMBOLS[code];
  if (symbol) return symbol;
  if (code.startsWith('Pad')) return code.slice(3);
  if (/^Mouse\d+$/.test(code)) return `${lang === 'ja' ? 'マウス' : 'Mouse '}${Number(code.slice(5)) + 1}`;
  return code;
}

/** What an action with nothing bound reads as. */
export const NO_KEY = '—';

/**
 * The code an action's prompt names on a device: on the keyboard and mouse a key rather than a mouse button when it has both
 * (置く: 左クリック または E — the prompt says E), else its first code; null with none.
 */
export function promptKey(bindings: Bindings, device: Device, action: ButtonAction): string | null {
  const codes = bindings[device][action];
  if (device === 'keyboardMouse') {
    const key = codes.find((c) => !c.startsWith('Mouse') && !c.startsWith('Wheel'));
    if (key) return key;
  }
  return codes[0] ?? null;
}

/** The game's own words (the prompt; the one-line hint while the mouse is free). */
export interface ControlWords {
  lock: string;
  take: string;
  place: string;
  pickup: string;
  touch: string;
}

const VERBS = {
  ja: { take: '手に取る', place: '置く', pickup: '拾う', touch: '触れる', gap: '　' },
  en: { take: 'Take', place: 'Place', pickup: 'Pick up', touch: 'Touch', gap: '  ' },
} as const;

/**
 * ゲーム中の操作表示 in `lang` for the keys bound on `device` (on the pad, the pad's buttons; the hint about the mouse is always
 * the keyboard's). With the design's table they read as before S-45 (「E　置く」, 「クリックで視点を固定 ・ WASD 歩く …」).
 */
export function controlWords(lang: LabelLang, bindings: Bindings, device: Device): ControlWords {
  const label = (d: Device, a: ButtonAction): string => {
    const code = promptKey(bindings, d, a);
    return code ? keyLabel(code, lang) : NO_KEY;
  };
  const moves = (['moveForward', 'moveLeft', 'moveBack', 'moveRight'] as const).map((a) =>
    label('keyboardMouse', a),
  );
  // WASD reads as one word; anything else (arrows, names) spaced apart
  const walk = moves.every((m) => /^[A-Z0-9]$/.test(m)) ? moves.join('') : moves.join(' ');
  const peek = label('keyboardMouse', 'peek');
  const use = label('keyboardMouse', 'interact');
  const lock =
    lang === 'ja'
      ? `クリックで視点を固定 ・ ${walk} 歩く ・ ${peek} 覗く ・ ${use} 置く／拾う／調べる ・ Esc 解除`
      : `Click to look around · ${walk} walk · ${peek} peek · ${use} place / pick up / touch · Esc release`;
  const v = VERBS[lang];
  const key = label(device, 'interact');
  return {
    lock,
    take: `${key}${v.gap}${v.take}`,
    place: `${key}${v.gap}${v.place}`,
    pickup: `${key}${v.gap}${v.pickup}`,
    touch: `${key}${v.gap}${v.touch}`,
  };
}
