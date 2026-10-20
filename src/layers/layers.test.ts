import { describe, expect, it } from 'vitest';
import { clipFor, drawnIn, type LayerKind } from './layers';

describe('surface / back / shared layers (技術設計 > 裏の層の実装 > 層の分け方)', () => {
  it('the normal view draws surface, back and shared objects', () => {
    for (const kind of ['surface', 'back', 'shared'] as LayerKind[]) expect(drawnIn(kind, 'main')).toBe(true);
  });

  it('the peek image draws only what the back layer sees: back and shared objects', () => {
    expect(drawnIn('back', 'peek')).toBe(true);
    expect(drawnIn('shared', 'peek')).toBe(true);
    expect(drawnIn('surface', 'peek')).toBe(false);
  });

  it('inside a placed orb sphere the back replaces the surface', () => {
    expect(clipFor('surface', 'main')).toBe('hide-inside');
    expect(clipFor('back', 'main')).toBe('hide-outside');
  });

  it('shared objects are never cut, and the peek image shows the whole back layer', () => {
    expect(clipFor('shared', 'main')).toBe('none');
    expect(clipFor('back', 'peek')).toBe('none');
    expect(clipFor('shared', 'peek')).toBe('none');
  });
});
