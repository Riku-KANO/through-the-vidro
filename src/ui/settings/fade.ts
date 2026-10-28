/**
 * 簡易トランジション (S-45). トランジション設計 > 遷移のルール 1: 黒い画面を使わない — ただし設定の「簡易トランジション」では、
 * 0.3秒の白いフェードに置き換えられる. With the setting on, every transition of the screens (読み込み → ホーム, ホーム → ゲーム
 * 開始 — the dive's flight with it: 演出の強いカメラ移動は短い版に置き換えられる —, ゲーム ⇄ ポーズ, the settings panel) is the same
 * fade: up to white over its first half, the screen swapped under the white at its middle, down from white over its second.
 * It never goes darker than where it started. Its sound is the transition's own (遷移のルール 6), and Esc plays it back from
 * where it is, as every transition (ルール 4). Pure.
 */
export const SIMPLE_FADE_SECONDS = 0.3;

/** How white the screen is (0..1) at `u` (0..1, linear time) along the fade: a tent, full at the middle. */
export function fadeWhite(u: number): number {
  if (!(u > 0) || !(u < 1)) return 0;
  return 1 - Math.abs(2 * u - 1);
}

/**
 * The fade's time `u` moved by `du` (either way), landing on its middle for one frame when it would step over it: the screen is
 * all white for at least that frame, and the swap happens under it (a frame of 60 Hz is a sixth of the fade's time).
 */
export function fadeStep(u: number, du: number): number {
  const next = u + du;
  if ((u < 0.5 && next > 0.5) || (u > 0.5 && next < 0.5)) return 0.5;
  return Math.min(1, Math.max(0, next));
}

/** Whether the screen shows where the fade goes (true, from its middle on) or where it came from. */
export function fadeArrived(u: number): boolean {
  return u >= 0.5;
}

/**
 * How many times faster than its own time a transition of `seconds` runs to last the fade (the host feeds the screens' state
 * machine its time that much faster: its Esc and its hold for the next scene keep working on its own clock).
 */
export function simpleSpeed(seconds: number): number {
  return seconds > 0 ? seconds / SIMPLE_FADE_SECONDS : 1;
}
