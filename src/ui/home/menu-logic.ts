/** UI/UX設計 > 画面ごとの設計（ホーム）: はじめる / つづきから / 残響 / 設定 / クレジット */
export const HOME_ITEMS = ['start', 'continue', 'echoes', 'settings', 'credits'] as const;

export type HomeItem = (typeof HOME_ITEMS)[number];

export function isHomeItem(value: unknown): value is HomeItem {
  return typeof value === 'string' && (HOME_ITEMS as readonly string[]).includes(value);
}

/** Keyboard focus movement between the drops (細部の振る舞い: マウスなしでもすべての画面を操作できる). */
export function nextFocus(index: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) {
    return ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(key)
      ? key === 'End'
        ? count - 1
        : 0
      : index;
  }
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowUp':
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return index;
  }
}

/**
 * サウンドデザイン > 音階の統一: D major pentatonic, and the menu drops rise from top to bottom.
 * Index 0 is D5; each step goes to the next note of the scale (D E F# A B, then D6 ...).
 */
const PENTATONIC_STEPS = [0, 2, 4, 7, 9]; // semitones above D
const D5_HZ = 587.33;

export function menuPitchHz(index: number): number {
  const i = Math.max(0, Math.floor(index));
  const octave = Math.floor(i / PENTATONIC_STEPS.length);
  const step = PENTATONIC_STEPS[i % PENTATONIC_STEPS.length] ?? 0;
  return D5_HZ * 2 ** (octave + step / 12);
}
