import { describe, expect, it } from 'vitest';
import { HOME_ITEMS, menuPitchHz, nextFocus, padMenuKey } from './menu-logic';

describe('padMenuKey (ゲームパッド on the home, S-43)', () => {
  it('moves with the 十字 as the arrows do, chooses with A, ignores the rest', () => {
    expect(padMenuKey('PadUp')).toBe('ArrowUp');
    expect(padMenuKey('PadLeft')).toBe('ArrowUp');
    expect(padMenuKey('PadDown')).toBe('ArrowDown');
    expect(padMenuKey('PadRight')).toBe('ArrowDown');
    expect(padMenuKey('PadA')).toBe('choose');
    expect(padMenuKey('PadB')).toBeNull();
    expect(padMenuKey('PadStart')).toBeNull();
  });
});

describe('HOME_ITEMS (UI/UX設計 > 画面ごとの設計: ホーム)', () => {
  it('lists the five drops in the design order', () => {
    expect(HOME_ITEMS).toEqual(['start', 'continue', 'echoes', 'settings', 'credits']);
  });
});

describe('nextFocus (キーボードだけでも選べる)', () => {
  it('moves down and up through the drops and wraps around', () => {
    expect(nextFocus(0, 'ArrowDown', 5)).toBe(1);
    expect(nextFocus(4, 'ArrowDown', 5)).toBe(0);
    expect(nextFocus(0, 'ArrowUp', 5)).toBe(4);
    expect(nextFocus(2, 'ArrowRight', 5)).toBe(3);
    expect(nextFocus(2, 'ArrowLeft', 5)).toBe(1);
  });

  it('jumps to the first and last drop', () => {
    expect(nextFocus(3, 'Home', 5)).toBe(0);
    expect(nextFocus(1, 'End', 5)).toBe(4);
  });

  it('starts from the first drop when nothing has focus', () => {
    expect(nextFocus(-1, 'ArrowDown', 5)).toBe(0);
  });

  it('ignores other keys', () => {
    expect(nextFocus(2, 'KeyW', 5)).toBe(2);
  });
});

describe('menuPitchHz (サウンドデザイン > 音階の統一)', () => {
  const dMajorPentatonic = [2, 4, 6, 9, 11]; // D E F# A B as semitones above C
  const pitchClass = (hz: number): number => (((Math.round(12 * Math.log2(hz / 440)) + 9) % 12) + 12) % 12;

  it('rises from the top drop to the bottom one', () => {
    for (let i = 1; i < HOME_ITEMS.length; i++) expect(menuPitchHz(i)).toBeGreaterThan(menuPitchHz(i - 1));
  });

  it('stays on the D major pentatonic scale', () => {
    for (let i = 0; i < 8; i++) expect(dMajorPentatonic).toContain(pitchClass(menuPitchHz(i)));
  });
});
