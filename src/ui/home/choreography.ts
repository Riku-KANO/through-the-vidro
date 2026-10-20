import { segment } from '../../core/transition';

/**
 * The home picture: a large glass orb in the middle with the drops floating on its right.
 * 世界観とストーリー > 結末 4: the ending pulls back until the city sits inside a vidro and stops
 * in exactly this composition, so these numbers are shared with the ending later.
 */
export const HOME_COMPOSITION = {
  orbRadius: 1,
  /** Outer (home) camera field of view. Narrow so the orb stays round. */
  fovDeg: 35,
  /** Camera distance from the orb centre: the orb is a little over half the screen height. */
  cameraDistance: 5.6,
  /** The orb sits this fraction of the screen width left of centre to balance the drops on its right. */
  lensShiftX: 0.06,
  /** Mouse tilt, at most this many radians each way (画面ごとの設計: わずかに傾く). M0 tuning value. */
  tiltMax: 0.07,
  /** Fog left over on the home screen after the opening (0 = clear, 1 = white-out). */
  homeFog: 0.12,
} as const;

const R = HOME_COMPOSITION.orbRadius;

/** True when the orb's silhouette covers every pixel (all four screen corners are inside it). */
export function orbCoversScreen(distance: number, radius: number, fovDeg: number, aspect: number): boolean {
  if (distance <= radius) return true;
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const corner = Math.atan(Math.hypot(tanV, tanV * aspect));
  return Math.asin(radius / distance) > corner;
}

export interface OpeningPose {
  /** The vessel brims and spills its light (0..1). */
  overflow: number;
  /** Fog density (1 = white-out, homeFog at the end). */
  fog: number;
  /** Orb rising from the depth into its home place (0..1). */
  orbRise: number;
  /** Home drops condensing into view (0..1). */
  menu: number;
}

const smooth = (x: number): number => x * x * (3 - 2 * x);

/**
 * 読み込み → ホーム (1.5 s): 器が光で満ちて溢れ、霧が晴れ、奥からガラス玉が浮かび上がる.
 * `p` is the eased transition value. The parts overlap but keep this order.
 */
export function openingChoreography(p: number): OpeningPose {
  const clear = smooth(segment(p, 0.12, 0.8));
  return {
    overflow: segment(p, 0, 0.35),
    fog: 1 - (1 - HOME_COMPOSITION.homeFog) * clear,
    orbRise: smooth(segment(p, 0.3, 1)),
    menu: segment(p, 0.72, 1),
  };
}

/** Dive staging. All in eased progress of the 2.0 s transition. */
export const DIVE = {
  /** The camera passes through the orb's surface here. */
  crossAt: 0.62,
  /** Hand-over from "orb on screen" to "game image on the whole screen" starts here (orb already fills it). */
  blendFrom: 0.55,
  /** Camera distance at the crossing and at the very end (inside the orb), in orb radii. */
  crossDistance: 1.06,
  insideDistance: 0.9,
  /** Refraction strength of the orb on the home screen, and the extra spread at the crossing. */
  homeRefraction: 1,
  peakExtraRefraction: 9,
} as const;

// d(p) = D0 - (D0 - Din) * (1 - (1 - p)^k), with k chosen so that d(crossAt) = crossDistance.
const D0 = HOME_COMPOSITION.cameraDistance;
const DIN = DIVE.insideDistance * R;
const APPROACH_K = Math.log((DIVE.crossDistance * R - DIN) / (D0 - DIN)) / Math.log(1 - DIVE.crossAt);

export interface DivePose {
  /** Outer camera distance from the orb centre. */
  cameraDistance: number;
  /** 0 = render home (orb shows the game image), 1 = the game image on the whole screen. */
  fullscreen: number;
  /** Full-screen ripple of the glass membrane: 0 at both ends, peaks when passing through the surface. */
  distortion: number;
  /** Refraction strength used by both the orb and the full-screen image (home value at 0, none at 1). */
  refraction: number;
  /** Glass surface (tint, reflections) still in front of the camera: 1 until the crossing, 0 at the end. */
  surface: number;
  /** Barrel warp over the whole screen while passing through the surface (0..1). */
  warp: number;
  /** Ripple of the membrane we pass through, and how far its ring has run (screen heights). */
  ripple: number;
  ringRadius: number;
  /** Progress of the game camera along its path from the miniature view to standing in the workshop. */
  inner: number;
  /** Home drops fading away (1 = fully shown). */
  menu: number;
  /** Multiplier for the mouse tilt and the lens shift; both settle to 0 early in the dive. */
  homeLook: number;
}

/**
 * ホーム → ゲーム開始 (2.0 s): カメラが玉へ近づき、表面を通り抜ける瞬間に屈折の歪みが画面いっぱいに
 * 広がって、そのまま工房の中に立っている. `p` is the eased transition value.
 */
export function diveChoreography(p: number): DivePose {
  const x = Math.min(1, Math.max(0, p));
  const cameraDistance = D0 - (D0 - DIN) * (1 - (1 - x) ** APPROACH_K);
  const rise = smooth(segment(x, 0.3, DIVE.crossAt));
  const fall = 1 - smooth(segment(x, DIVE.crossAt, 0.96));
  const distortion = rise * fall;
  const settle = 1 - smooth(segment(x, DIVE.crossAt, 1));
  return {
    cameraDistance,
    fullscreen: smooth(segment(x, DIVE.blendFrom, DIVE.crossAt)),
    distortion,
    refraction: DIVE.homeRefraction * settle + DIVE.peakExtraRefraction * distortion,
    surface: 1 - smooth(segment(x, DIVE.crossAt, 0.92)),
    // both start once the orb covers the screen, so they are fully there at the moment of passing through
    warp: distortion * smooth(segment(x, DIVE.blendFrom - 0.05, DIVE.crossAt)),
    ripple: distortion * smooth(segment(x, DIVE.blendFrom - 0.02, DIVE.crossAt)),
    ringRadius: segment(x, DIVE.blendFrom - 0.03, 0.88) * 2.4,
    inner: x,
    menu: 1 - segment(x, 0, 0.18),
    homeLook: 1 - smooth(segment(x, 0, 0.4)),
  };
}
