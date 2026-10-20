/**
 * Numbers and a plain-JS copy of the screen-space displacement that `lens.ts` builds in TSL, so the
 * shape of the distortion can be tested without a GPU (the picture must never fold over itself).
 * Keep the two in step: lens.ts imports every constant from here.
 */
export const GLASS_IOR = 1.5;

/**
 * How far refraction displaces what is seen through the glass (screen units per unit of bend).
 * A thin shell barely moves the image except near its rim. M0 tuning value.
 */
export const REFRACTION_REACH = 0.032;
export const MAX_SHIFT = 0.3;
/**
 * The rim band bends outwards (what lies just beyond the rim is squeezed into it, as in a glass ball).
 * An outward shift that grows towards the rim never folds the picture. M0 tuning value (screen units).
 */
export const RIM_REACH = 0.05;
/**
 * Passing through the surface: a barrel warp over the whole screen and a ripple ring running outwards.
 * The barrel's radius is measured against the screen corner, so its pull is the same on 4:3 and 21:9.
 * Strengths are kept so that the displacement never folds the picture (lens-math.test.ts).
 */
export const WARP_STRENGTH = 0.12;
export const RIPPLE_FREQ = 12;
export const RIPPLE_AMP = 0.012;
export const RIPPLE_WIDTH2 = 0.035;

type V3 = [number, number, number];

const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** GLSL refract(). */
function refract(i: V3, n: V3, eta: number): V3 {
  const d = dot3(n, i);
  const k = 1 - eta * eta * (1 - d * d);
  if (k < 0) return [0, 0, 0];
  const s = eta * d + Math.sqrt(k);
  return [eta * i[0] - s * n[0], eta * i[1] - s * n[1], eta * i[2] - s * n[2]];
}
const onScreen = (d: V3): [number, number] => {
  const z = Math.max(-d[2], 0.04);
  return [d[0] / z, d[1] / z];
};

export interface LensState {
  aspect: number;
  fovDeg: number;
  /** Outer camera distance from the orb centre, in orb radii (the orb is on the view axis). */
  cameraDistance: number;
  refraction: number;
  warp: number;
  ripple: number;
  ringRadius: number;
}

/** Barrel warp and ripple of the membrane at a screen point, in uv units (x right, y down). */
export function membraneShiftUV(u: number, v: number, s: LensState): [number, number] {
  const nx = u * 2 - 1;
  const ny = 1 - v * 2;
  const qx = nx * s.aspect;
  const r2 = qx * qx + ny * ny;
  const pull = (-WARP_STRENGTH / 2) * s.warp * (r2 / (s.aspect * s.aspect + 1));
  const r = Math.sqrt(r2);
  const k = r - s.ringRadius;
  const ring = Math.exp((-k * k) / RIPPLE_WIDTH2) * s.ripple;
  const wave = Math.sin(k * RIPPLE_FREQ) * ring * RIPPLE_AMP;
  const dx = qx / Math.max(r, 1e-3);
  const dy = ny / Math.max(r, 1e-3);
  return [nx * pull + dx * wave, -(ny * pull) - dy * wave];
}

/**
 * Where the full-screen image of the dive samples the game image for screen point (u, v):
 * refraction through the orb surface (reconstructed from the camera distance), the rim band,
 * the barrel warp and the ripple — the same sum `glassShade` makes on the GPU.
 */
export function divePickUV(u: number, v: number, s: LensState): [number, number] {
  const p11 = 1 / Math.tan((s.fovDeg * Math.PI) / 360);
  const p00 = p11 / s.aspect;
  const nx = u * 2 - 1;
  const ny = 1 - v * 2;
  const view = norm3([nx / p00, ny / p11, -1]);
  const d = Math.max(s.cameraDistance, 1.0001);
  const b = d * -view[2];
  const disc = Math.max(b * b - (d * d - 1), 0);
  const t = b - Math.sqrt(disc);
  const n = norm3([view[0] * t, view[1] * t, view[2] * t + d]);

  const bent = refract(view, n, 1 / GLASS_IOR);
  const [bx, by] = onScreen(bent);
  const [vx, vy] = onScreen(view);
  let sx = (bx - vx) * p00 * 0.5 * s.refraction * REFRACTION_REACH;
  let sy = (by - vy) * p11 * -0.5 * s.refraction * REFRACTION_REACH;
  const len = Math.hypot(sx, sy);
  const clampK = Math.min(1, MAX_SHIFT / Math.max(len, 1e-4));
  sx *= clampK;
  sy *= clampK;

  const rho = Math.hypot(n[0], n[1]);
  const rim = smoothstep(0.55, 1, rho) ** 2 * Math.min(s.refraction, 1.5) * RIM_REACH;
  const ox = (n[0] / Math.max(rho, 1e-4)) * rim;
  const oy = (-n[1] / Math.max(rho, 1e-4)) * rim;

  const [mx, my] = membraneShiftUV(u, v, s);
  return [u + sx + ox + mx, v + sy + oy + my];
}

/**
 * Smallest Jacobian determinant and smallest diagonal entry of the pick mapping over the screen.
 * Both must stay well above 0: at 0 the picture tears, below 0 it folds and shows things twice.
 */
export function foldMargin(s: LensState, steps = 48): { det: number; diag: number } {
  const h = 1e-3;
  let det = Number.POSITIVE_INFINITY;
  let diag = Number.POSITIVE_INFINITY;
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const u = 0.01 + (0.98 * i) / steps;
      const v = 0.01 + (0.98 * j) / steps;
      const [x0, y0] = divePickUV(u - h, v, s);
      const [x1, y1] = divePickUV(u + h, v, s);
      const [x2, y2] = divePickUV(u, v - h, s);
      const [x3, y3] = divePickUV(u, v + h, s);
      const a = (x1 - x0) / (2 * h);
      const b = (x3 - x2) / (2 * h);
      const c = (y1 - y0) / (2 * h);
      const d = (y3 - y2) / (2 * h);
      det = Math.min(det, a * d - b * c);
      diag = Math.min(diag, a, d);
    }
  }
  return { det, diag };
}
