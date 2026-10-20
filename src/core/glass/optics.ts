import type { Rgb } from './kinds';

/**
 * Small optics helpers shared by the materials (and their tests). Pure functions.
 * 空間の可読性と導線 > 形は縁で伝える: reflection grows towards grazing angles (Fresnel).
 */

/** Reflectance at normal incidence for a dielectric in air. IOR 1.5 → 0.04. */
export function fresnelF0(ior: number): number {
  const r = (ior - 1) / (ior + 1);
  return r * r;
}

/** Schlick's approximation of Fresnel reflectance. cosTheta = dot(normal, view), 1 = head-on. */
export function schlickFresnel(cosTheta: number, ior: number): number {
  const f0 = fresnelF0(ior);
  const c = Math.min(1, Math.max(0, cosTheta));
  return f0 + (1 - f0) * (1 - c) ** 5;
}

/**
 * Light left after `pathLength` metres in glass whose absorption leaves `color` after `distance` metres
 * (same law as three's attenuationColor / attenuationDistance). Longer paths are darker and more saturated.
 */
export function beerLambert(color: Rgb, distance: number, pathLength: number): [number, number, number] {
  if (pathLength <= 0 || !Number.isFinite(distance) || distance <= 0) return [1, 1, 1];
  const k = pathLength / distance;
  return [color[0] ** k, color[1] ** k, color[2] ** k];
}
