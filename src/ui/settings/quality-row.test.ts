import { describe, expect, it } from 'vitest';
import type { QualityChoice, QualityLevel } from '../../core/quality';
import { STRINGS, type StringKey } from '../lang';
import { qualityOptionWords, qualityRowView } from './quality-row';

const port = (choice: QualityChoice, level: QualityLevel, sceneLevel: QualityLevel) => ({
  choice,
  level,
  sceneLevel,
});
const ja = (k: StringKey): string => STRINGS.ja[k];
const en = (k: StringKey): string => STRINGS.en[k];

describe('S-48: the 品質 row — 自動 shows the preset it uses (設定の「自動」の札に、いま選ばれているプリセットを添える)', () => {
  it('under 自動, its tag carries the preset in use; under a preset, nothing is added', () => {
    expect(qualityRowView(port('auto', 'high', 'mid')).autoLevel).toBe('high');
    expect(qualityRowView(port('auto', 'mid', 'mid')).autoLevel).toBe('mid');
    expect(qualityRowView(port('low', 'low', 'mid')).autoLevel).toBeNull();
    expect(qualityRowView(null).autoLevel).toBeNull();
  });

  it('the tag’s words, in each language', () => {
    expect(qualityOptionWords(ja, 'auto', 'high')).toBe('自動（高）');
    expect(qualityOptionWords(ja, 'auto', 'low')).toBe('自動（低）');
    expect(qualityOptionWords(en, 'auto', 'mid')).toBe('Auto (Medium)');
    expect(qualityOptionWords(ja, 'auto', null)).toBe('自動');
    expect(qualityOptionWords(ja, 'low', 'high')).toBe('低');
    expect(qualityOptionWords(en, 'high', null)).toBe('High');
  });
});

describe('S-48: the line under 品質 only while the shadows and the glass wait for the next time', () => {
  it('a preset other than the one the game was made with: they wait (自動’s pick too: it is kept and built from next time)', () => {
    expect(qualityRowView(port('low', 'low', 'mid')).later).toBe(true);
    expect(qualityRowView(port('auto', 'high', 'mid')).later).toBe(true);
  });

  it('the one it was made with: nothing waits', () => {
    expect(qualityRowView(port('mid', 'mid', 'mid')).later).toBe(false);
    expect(qualityRowView(port('auto', 'low', 'low')).later).toBe(false);
    expect(qualityRowView(null).later).toBe(false);
  });

  it('it names the shadows and the glass alone (the peek image and the anti-aliasing change at once)', () => {
    expect(STRINGS.ja.setQualityLater).toBe('影とガラスの描き方は次回から変わります');
    expect(STRINGS.en.setQualityLater).toBe('Shadows and glass change the next time the game opens');
  });
});
