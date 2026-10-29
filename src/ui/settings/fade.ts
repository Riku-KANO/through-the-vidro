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
  const from = atMiddle(u) ? 0.5 : u;
  const next = from + du;
  if ((from < 0.5 && next > 0.5) || (from > 0.5 && next < 0.5)) return 0.5;
  return Math.min(1, Math.max(0, next));
}

/** On the middle (within rounding: a time kept in seconds and divided back). */
const atMiddle = (u: number): boolean => Math.abs(u - 0.5) < 1e-9;

/**
 * Whether the screen shows where the fade goes (true, from its middle on) or where it came from. At the middle itself (the full
 * white) it is the side the fade is heading to (`forward`: toward 1), so the cut is under the full white both ways.
 */
export function fadeArrived(u: number, forward = true): boolean {
  return forward ? u >= 0.5 : u > 0.5;
}

/**
 * How many times faster than its own time a transition of `seconds` runs to last the fade of `fade` seconds (the host feeds the
 * screens' state machine its time that much faster: its Esc and its hold for the next scene keep working on its own clock).
 */
export function simpleSpeed(seconds: number, fade: number = SIMPLE_FADE_SECONDS): number {
  return seconds > 0 && fade > 0 ? seconds / fade : 1;
}

/**
 * 発案者の判断 (2026-10-29, S-45 判断待ち 3): with 点滅を抑える on as well, the white fade is longer and the white tops (its full
 * white, and where a fade played back while it whitened turns: Esc pressed during it) come at most every MIN_PEAK_GAP, so that
 * however the keys are pressed (Esc mashed) the screen cannot flash white more than 3 times a second (光の点滅や強い閃光を
 * 抑えるモード: 1 秒に 3 回を超える明滅をなくす). The cut stays under the full white; the sounds and Esc are as ever.
 */
export const CALM_FADE_SECONDS = 0.5;
/** The least time between two white tops (s): 1/3 s would be 3 a second; a little more. */
export const MIN_PEAK_GAP = 0.4;
/** A white this full is the full white (a flash's top). */
export const FULL_WHITE = 0.999;
/** How far short of its middle a fade waits for the gate (in its time 0..1): the screen near white (0.9), not yet cut. */
export const PEAK_HOLD = 0.05;

/** The fade's length: 0.3 s, or 0.5 s with 点滅を抑える on as well. */
export function fadeSecondsFor(calm: boolean): number {
  return calm ? CALM_FADE_SECONDS : SIMPLE_FADE_SECONDS;
}

/**
 * The gate every simple fade on the screen passes its white tops through (one for the page: the screens', the pause's and the
 * panel's fades together). While `enabled` (簡易トランジション with 点滅を抑える), a top is let through only MIN_PEAK_GAP after
 * the last one, or in the same frame as it (two fades meeting at their middles: タイトルへ's pause and dive); otherwise always.
 * Its clock is the frames' (`tick`).
 */
export class FlashGate {
  enabled = false;
  private now = 0;
  private last = Number.NEGATIVE_INFINITY;

  tick(dt: number): void {
    if (dt > 0 && Number.isFinite(dt)) this.now += dt;
  }

  get allows(): boolean {
    if (!this.enabled) return true;
    const since = this.now - this.last;
    return since === 0 || since >= MIN_PEAK_GAP;
  }

  /** A fade's white tops now (its full white, or it turns back). */
  peak(): void {
    this.last = this.now;
  }
}

/**
 * What a fade's white did on its last step: rose (toward the middle) or not. Kept by each fade to see it turn back while its
 * white rose — a top below the full white, which flashes as one does.
 */
export class FadeCourse {
  rising = false;
}

/** The white rises on a step of `du` from `u` (toward the middle). */
const whitens = (u: number, du: number): boolean => !atMiddle(u) && (u < 0.5 ? du > 0 : du < 0);

/**
 * `fadeStep` through the gate: a fade that would come to its middle (its full white, where the cut is) when the gate does not
 * let it waits PEAK_HOLD short of it, on its side (the screen near white), until the gate lets it; one that does tells the gate.
 * With its `course`, a fade played back while its white rose (a top below the full white) likewise stands where it is until the
 * gate lets it turn.
 */
export function gatedStep(u: number, du: number, gate: FlashGate | null, course?: FadeCourse): number {
  if (course?.rising && du !== 0 && !whitens(u, du) && fadeWhite(u) > 0) {
    if (gate && !gate.allows) return u;
    gate?.peak();
    course.rising = false;
  }
  const next = fadeStep(u, du);
  // (coming to the middle: onto it, or so near it that the screen is all white)
  const arriving = !atMiddle(u) && (next === 0.5 || fadeWhite(next) >= FULL_WHITE);
  let to = next;
  if (arriving) {
    if (!gate || gate.allows) {
      gate?.peak();
      to = 0.5;
    } else to = u < 0.5 ? Math.max(u, 0.5 - PEAK_HOLD) : Math.min(u, 0.5 + PEAK_HOLD);
  }
  // (standing still — held, or at an end — it keeps what it was doing; on the middle its top is passed)
  if (course && to !== u) course.rising = whitens(u, du) && !atMiddle(to);
  return to;
}
