/**
 * Layer assignment rules (技術設計 > 裏の層の実装 > 層の分け方 / 実体化). Pure data so the
 * renderer side (field.ts) and tests agree on who is drawn where.
 *
 *  - surface: 表にだけあるもの (崩れた壁, 破片の山, 閉ざされた扉). Hidden inside placed-orb spheres.
 *  - back:    裏にだけあるもの (橋, 階段, 扉, 残響, 光の雫). Drawn only inside spheres, and in full
 *             in the peek image.
 *  - shared:  both layers (floor, pedestals, lights). Never cut.
 */
export type LayerKind = 'surface' | 'back' | 'shared';

/** main = the normal frame; peek = the back-layer image drawn only while peeking. */
export type LayerView = 'main' | 'peek';

export type LayerClip = 'none' | 'hide-inside' | 'hide-outside';

/** Three.js layer channels. Channel 0 stays the default for untagged helpers (main view only). */
export const LAYER_CHANNEL = { surface: 1, back: 2 } as const;

/** Object3D.layers mask for an object of this kind. */
export function layerMask(kind: LayerKind): number {
  const surface = 1 << LAYER_CHANNEL.surface;
  const back = 1 << LAYER_CHANNEL.back;
  if (kind === 'surface') return surface;
  if (kind === 'back') return back;
  return 1 | surface | back;
}

/** Camera layers mask for a view. */
export function viewMask(view: LayerView): number {
  return view === 'main'
    ? 1 | (1 << LAYER_CHANNEL.surface) | (1 << LAYER_CHANNEL.back)
    : 1 << LAYER_CHANNEL.back;
}

export function drawnIn(kind: LayerKind, view: LayerView): boolean {
  return (layerMask(kind) & viewMask(view)) !== 0;
}

export function clipFor(kind: LayerKind, view: LayerView): LayerClip {
  if (view === 'peek' || kind === 'shared') return 'none';
  return kind === 'surface' ? 'hide-inside' : 'hide-outside';
}
