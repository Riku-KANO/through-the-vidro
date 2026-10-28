import { QUALITY_PRESETS, type QualityLevel, type QualityPort, waitsForRebuild } from '../../core/quality';
import type { StringKey } from '../lang';

/**
 * S-48: what the 品質 row shows of the shell's quality, pure (the panel draws it, settings-panel.ts):
 *  - under 自動, its tag carries the preset it uses now (設定の「自動」の札に、いま選ばれているプリセットを添える): 自動（高）
 *  - the line under the row, only while part of the preset in use waits for the game to be made again — the shadows and the
 *    glass (core/quality.ts waitsForRebuild; the render scale, the peek image and the anti-aliasing change at once). 自動's
 *    pick too: it is kept and the next visit is built from it.
 */
export interface QualityRowView {
  /** 自動 is chosen: the preset it uses now (its pick, once it has measured); else null. */
  autoLevel: QualityLevel | null;
  /** 「影とガラスの描き方は次回から変わります」 under the row. */
  later: boolean;
}

export function qualityRowView(
  q: Pick<QualityPort, 'choice' | 'level' | 'sceneLevel'> | null,
): QualityRowView {
  if (!q) return { autoLevel: null, later: false };
  return {
    autoLevel: q.choice === 'auto' ? q.level : null,
    later: waitsForRebuild(QUALITY_PRESETS[q.sceneLevel], QUALITY_PRESETS[q.level]),
  };
}

/** The words of each preset (the panel's tags of 低・中・高 use the same keys, settings-panel.ts OPTION_KEY). */
const LEVEL_KEY: Readonly<Record<QualityLevel, StringKey>> = {
  low: 'setQualityLow',
  mid: 'setQualityMid',
  high: 'setQualityHigh',
};

/** The words on the 自動 tag: with the preset it uses when it is chosen (自動（高）, Auto (High)), else 自動. */
export function autoTagWords(t: (k: StringKey) => string, autoLevel: QualityLevel | null): string {
  return autoLevel
    ? t('setQualityAutoPick').replace('{level}', t(LEVEL_KEY[autoLevel]))
    : t('setQualityAuto');
}
