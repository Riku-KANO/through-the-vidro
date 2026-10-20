/**
 * Numbers for the first-person body and camera.
 * Values quoted from the design doc carry their section; the rest are tuning values
 * chosen in S-03 (marked 調整値) and listed in process/slices/S-03.md for review.
 */

/** 操作とカメラ > カメラ: 目の高さ1.6m. */
export const EYE_HEIGHT = 1.6;
/** 操作とカメラ > カメラ: 歩行速度は1.4m/s. */
export const WALK_SPEED = 1.4;
/** 操作とカメラ > カメラ: 早歩きは2.2m/s. */
export const SPRINT_SPEED = 2.2;
/** 操作とカメラ > カメラ: 視野角70度(設定で60〜100度). Vertical field of view, as three.js uses. */
export const FOV_DEFAULT = 70;
export const FOV_MIN = 60;
export const FOV_MAX = 100;

/**
 * The integration port for S-02 (覗く). コアメカニクス > 基本の動作: 覗いている間は移動速度50%.
 * 操作とカメラ > カメラ: 覗いている間は視野角をわずかに狭め(-6度).
 */
export const PEEK_MODIFIER = Object.freeze({ speedMultiplier: 0.5, fovOffsetDeg: -6 });

/** 調整値 — 短い慣性: time constants of the exponential approach to the wished velocity. */
export const ACCEL_TAU = 0.1;
export const DECEL_TAU = 0.14;

/** 調整値 — 歩行時の上下の揺れはごく弱く: amplitude (m) at walking speed, and one footstep (m; 2 steps/s at 1.4m/s). */
export const HEAD_BOB_AMPLITUDE = 0.01;
export const FOOTSTEP_LENGTH = 0.7;

/** 調整値 — how quickly the eye follows an automatic step, and how far it may trail behind. */
export const EYE_FOLLOW_TAU = 0.07;
export const EYE_MAX_LAG = 0.35;

/** 調整値 — look limits. */
export const PITCH_LIMIT = (85 * Math.PI) / 180;

/** 調整値 — body. Height 1.75 m leaves 15 cm of head above the eye. */
export const BODY_RADIUS = 0.3;
export const BODY_HEIGHT = 1.75;
/** Gap the Rapier character controller keeps from surfaces. */
export const SKIN = 0.02;

/** 調整値 — 段差は自動で上る: steps up to this height are climbed; higher is a wall. */
export const STEP_HEIGHT = 0.3;
export const STEP_MIN_WIDTH = 0.2;
/** 調整値 — descending steps and slopes keep the feet on the ground within this distance. */
export const SNAP_TO_GROUND = 0.35;
/** 調整値 — walkable slope. Steeper ground acts as a wall. */
export const MAX_SLOPE_DEG = 40;
export const SLIDE_SLOPE_DEG = 50;

export const GRAVITY = 9.81;
export const MAX_FALL_SPEED = 20;
