import { describe, expect, it } from 'vitest';
import { pickLang, STRINGS } from './lang';

describe('pickLang (UI/UX設計 > 英語版: 初期値はブラウザの言語設定)', () => {
  it('uses Japanese for Japanese browsers', () => {
    expect(pickLang(['ja-JP', 'en-US'])).toBe('ja');
    expect(pickLang(['ja'])).toBe('ja');
  });

  it('uses English otherwise', () => {
    expect(pickLang(['en-US'])).toBe('en');
    expect(pickLang(['fr-FR', 'ja-JP'])).toBe('en');
    expect(pickLang([])).toBe('en');
  });
});

describe('STRINGS', () => {
  it('has the same keys in Japanese and English', () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.ja).sort());
  });

  it('names the home drops as in the design', () => {
    expect([
      STRINGS.ja.start,
      STRINGS.ja.continue,
      STRINGS.ja.echoes,
      STRINGS.ja.settings,
      STRINGS.ja.credits,
    ]).toEqual(['はじめる', 'つづきから', '残響', '設定', 'クレジット']);
  });
});

describe('STRINGS: the pause (S-42)', () => {
  it('names its items as in the design (画面ごとの設計: ポーズ — つづける / タイトルへ in this slice)', () => {
    expect([STRINGS.ja.pauseResume, STRINGS.ja.pauseTitle]).toEqual(['つづける', 'タイトルへ']);
  });

  it('asks before leaving for the title, with two answers, in both languages', () => {
    for (const lang of ['ja', 'en'] as const) {
      const s = STRINGS[lang];
      for (const key of ['pauseAsk', 'pauseYes', 'pauseNo', 'pauseRelock', 'pauseLabel'] as const)
        expect(s[key].length, `${lang} ${key}`).toBeGreaterThan(0);
    }
  });
});
