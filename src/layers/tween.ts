/**
 * Progress values that move toward a target at a fixed duration, and the easing that turns
 * progress into motion. Pure functions; used by peek (0.25 s) and materialization (0.8 s).
 *
 * The curve follows トランジション設計 > 遷移のルール 5 (ゆっくり始まって粘りながら止まる).
 * S-04 owns the shared curve in src/core/transition; switch to it at integration (S-06).
 */
export interface Tween {
  /** 0..1, linear in time. */
  progress: number;
  /** Where progress is heading. Flipping the target plays the same path backwards. */
  target: 0 | 1;
}

/** Moves progress toward its target so that 0→1 takes exactly `seconds`. */
export function stepTween(t: Tween, dt: number, seconds: number): Tween {
  if (t.progress === t.target) return t;
  const step = seconds > 0 ? dt / seconds : 1;
  // Snap within float noise so a duration made of many small dt steps lands exactly on the target.
  if (Math.abs(t.target - t.progress) <= step + 1e-9) return { progress: t.target, target: t.target };
  const progress = t.target === 1 ? t.progress + step : t.progress - step;
  return { progress, target: t.target };
}

// cubic-bezier(0.42, 0, 0.12, 1): slow start, long viscous settle.
const X1 = 0.42;
const X2 = 0.12;
const Y1 = 0;
const Y2 = 1;

const bezier = (t: number, a: number, b: number): number => {
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
};

const bezierSlope = (t: number, a: number, b: number): number => {
  const u = 1 - t;
  return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b);
};

/** Glass-like easing: 0→1, monotonic, slow at both ends with a sticky stop. */
export function glassEase(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Solve bezier_x(t) = x with Newton, falling back to bisection.
  let t = x;
  for (let i = 0; i < 6; i++) {
    const err = bezier(t, X1, X2) - x;
    const slope = bezierSlope(t, X1, X2);
    if (Math.abs(err) < 1e-7) break;
    if (Math.abs(slope) < 1e-6) {
      t = -1;
      break;
    }
    t -= err / slope;
  }
  if (!(t >= 0 && t <= 1)) {
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      if (bezier(t, X1, X2) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return Math.min(1, Math.max(0, bezier(t, Y1, Y2)));
}
