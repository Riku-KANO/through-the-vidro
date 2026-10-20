import en from './lang/en.json';
import ja from './lang/ja.json';

/** 技術設計 > 読み込みとセーブ: 文言は日本語と英語のJSONファイルに分ける */
export type Lang = 'ja' | 'en';
export type StringKey = keyof typeof ja;

export const STRINGS: Readonly<Record<Lang, Readonly<Record<StringKey, string>>>> = { ja, en };

/** UI/UX設計 > 英語版: 言語の初期値はブラウザの言語設定で決める (the first preferred language wins). */
export function pickLang(languages: readonly string[]): Lang {
  const first = languages[0]?.toLowerCase() ?? '';
  return first === 'ja' || first.startsWith('ja-') ? 'ja' : 'en';
}

/** Font stacks (UI/UX設計 > 文字と色, 英語版). M0 uses local fallbacks; subsetting comes in M1. */
export const FONT_STACK: Readonly<Record<Lang, string>> = {
  ja: '"Shippori Mincho", "Zen Old Mincho", "Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif JP", serif',
  en: '"Cormorant Garamond", "EB Garamond", Garamond, "Hoefler Text", "Times New Roman", serif',
};
