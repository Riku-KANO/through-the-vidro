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

const LEVEL_KEY: Readonly<Record<QualityLevel, StringKey>> = {
  low: 'setQualityLow',
  mid: 'setQualityMid',
  high: 'setQualityHigh',
};
const OPTION_KEY: Readonly<Record<string, StringKey>> = { auto: 'setQualityAuto', ...LEVEL_KEY };

/** The words on a 品質 tag: 自動 carries `autoLevel` when there is one (自動（高）, Auto (High)). */
export function qualityOptionWords(
  t: (k: StringKey) => string,
  option: string,
  autoLevel: QualityLevel | null,
): string {
  if (option === 'auto' && autoLevel)
    return t('setQualityAutoPick').replace('{level}', t(LEVEL_KEY[autoLevel]));
  const key = OPTION_KEY[option];
  return key ? t(key) : option;
}
