import { abs, dot, float, mix, normalView, positionViewDirection, pow, uniform, vec3 } from 'three/tsl';
import type * as THREE from 'three/webgpu';

/**
 * S-45: what the player's accessibility settings change in the world's own light (UI/UX設計 > アクセシビリティ):
 *  - コントラスト強化 (ガラスの縁を太く明るく; 発案者の判断 2026-10-28: the world's glass too) — the rim of what can be acted on
 *    (調べられる物の縁の光: the vidro, the pedestals' cups, the light drops) is thicker and brighter
 *  - 光の点滅や強い閃光を抑えるモード — no flash that brightens the screen at once, nothing blinking more than 3 times a second:
 *    the placing wave, the vidro's flash, the sweep, the bloom and the fire are calmer; their shape and sound stay
 *    (色だけに頼らない: パズルに必要な情報は形と音でも伝える)
 *
 * Module-wide uniforms, like the baked lights' gains (src/game/assets/baked-light.ts): the setting is the player's, not a
 * material's, so every room built on the page (the home's orb, the prologue, エリア1) shares them, and the room that takes the
 * settings (room.ts applySettings) sets them. Changing them makes no shader (設定を変えてもシェーダを作り直さない).
 */
export const WORLD_ACCESS = {
  /** コントラスト強化: 0 off, 1 on. */
  contrast: uniform(0),
  /** 点滅を抑える: 0 off, 1 on. */
  calm: uniform(0),
};

/**
 * 仮 (S-45): how much of each light stays with 点滅を抑える on. The placing wave's boundary (玉を置く: 境目を光らせる) and the
 * sweep's band (settle.ts CALM_SWEEP) keep a dim line — their shape is the clue; the vidro's flash (a refusal, the drop
 * arriving) is a faint glow; the bloom is turned down so nothing bright bleeds over the screen; the fire breathes less.
 */
export const CALM = { wave: 0.35, flash: 0.2, bloom: 0.4, fire: 0.35 } as const;
/** The fire's breath with 点滅を抑える on keeps only its waves at or under this many turns a second (1 秒に 3 回まで). */
export const FIRE_FLICKER_HZ_MAX = 1;

/** The fire's waves (room-art.ts, S-37): weight, radians a second, phase. Its slowest is 0.37 Hz, its fastest 1.86 Hz. */
const FIRE_WAVES: readonly (readonly [number, number, number])[] = [
  [0.5, 2.3, 0],
  [0.3, 5.9, 1.3],
  [0.2, 11.7, 0.4],
];

/**
 * The fire's light (×, around 1) at time `t`: a few slow, unrelated waves of ± `flicker`. With `calm`, only the waves of at most
 * FIRE_FLICKER_HZ_MAX turns a second, at CALM.fire of their depth.
 */
export function fireBreath(t: number, flicker: number, calm: boolean): number {
  let wave = 0;
  for (const [w, rate, phase] of FIRE_WAVES) {
    if (calm && rate / (2 * Math.PI) > FIRE_FLICKER_HZ_MAX) continue;
    wave += w * Math.sin(t * rate + phase);
  }
  return 1 + flicker * (calm ? CALM.fire : 1) * wave;
}

/**
 * The vidro's warm flash (room.ts): a refusal's tremble (`shake` 0..1, its square) and the drop arriving (`arrival` 1 → 0 over its
 * glow). With `calm`, CALM.flash of it.
 */
export function orbFlash(shake: number, arrival: number, calm: boolean): number {
  const flash = shake * shake * 1.6 + arrival * 1.4;
  return calm ? flash * CALM.flash : flash;
}

/** The placing wave's light at its boundary (materialize.ts boundaryGlow), with `calm` dimmer. */
export function calmedWave(glow: number, calm: boolean): number {
  return calm ? glow * CALM.wave : glow;
}

/** 仮 (S-45): the rim's falloff (higher: thinner) and brightness, as before and with コントラスト強化. */
const RIM = { falloff: 2.5, falloffContrast: 1.2, boost: 1.9 } as const;

/**
 * 調べられる物に近づくと縁が淡く光る (UI/UX設計 > ゲーム中): a warm rim, strongest edge-on, `strength` 0..1 (the room eases it in
 * 0.2 s). With コントラスト強化 it reaches further in (太く) and is brighter (明るく). One node graph either way.
 */
export function focusRim(strength: THREE.Node<'float'>): THREE.Node<'vec3'> {
  const c = WORLD_ACCESS.contrast;
  const edge = float(1).sub(abs(dot(normalView, positionViewDirection)));
  const falloff = mix(float(RIM.falloff), float(RIM.falloffContrast), c);
  const boost = mix(float(1), float(RIM.boost), c);
  return vec3(1.0, 0.82, 0.58).mul(pow(edge, falloff).mul(strength).mul(boost));
}

/** How much brighter a focused light drop's core shines (×): +50 % as before, +100 % with コントラスト強化. */
export function focusCore(strength: THREE.Node<'float'>): THREE.Node<'float'> {
  return strength.mul(mix(float(0.5), float(1), WORLD_ACCESS.contrast)).add(1);
}
