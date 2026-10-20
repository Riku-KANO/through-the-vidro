import {
  clamp,
  dot,
  float,
  max,
  mix,
  normalize,
  pow,
  reflect,
  refract,
  screenUV,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

/**
 * Shading shared by the home orb and the full-screen image of the dive, so that when the orb fills
 * the screen the hand-over to the full-screen image is the same picture (no seam).
 * The game scene is drawn into `inner` with the game camera; the glass looks it up at the screen
 * position bent by refraction through the orb's surface (アートディレクション > ガラスの種類: 屈折率1.5,
 * 断面の縁がわずかに緑).
 */
export const GLASS_IOR = 1.5;

/**
 * How far refraction displaces what is seen through the glass (screen units per unit of bend).
 * A thin shell barely moves the image except near its rim. M0 tuning value.
 */
const REFRACTION_REACH = 0.032;
const MAX_SHIFT = 0.3;

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

export interface LensUniforms {
  /** Outer camera projection scale: (P[0][0], P[1][1]). */
  proj: THREE.UniformNode<'vec2', THREE.Vector2>;
  /** Refraction strength (1 on the home screen, peaks at the crossing, 0 at the end of the dive). */
  refraction: THREE.UniformNode<'float', number>;
}

export function createLensUniforms(): LensUniforms {
  return { proj: uniform(new THREE.Vector2(1, 1)), refraction: uniform(1) };
}

/** Projects a view-space direction onto the screen plane (NDC units / 2). */
function onScreen(d: V3): THREE.Node<'vec2'> {
  return d.xy.div(max(d.z.negate(), float(0.04)));
}

export interface ShadeInput {
  inner: THREE.Texture;
  lens: LensUniforms;
  /** Normalised view-space direction from the camera to the shaded point. */
  viewDir: V3;
  /** View-space surface normal of the orb at that point (facing the camera). */
  normal: V3;
  /** Point on the orb in its own coordinates (unit sphere), for the light flowing inside. */
  local: V3;
  /** 1 = the full glass surface (tint, reflection, highlights); 0 = only the image behind it. */
  surface: F;
  /** Extra screen-space displacement (the ripple of the dive). */
  extraShift?: THREE.Node<'vec2'>;
}

export function glassShade(input: ShadeInput): V3 {
  const { lens, viewDir: v, normal: n, local, surface } = input;
  const bent = refract(v, n, float(1 / GLASS_IOR));
  const delta = onScreen(bent).sub(onScreen(v)).mul(lens.proj).mul(vec2(0.5, -0.5));
  let shift = delta.mul(lens.refraction).mul(REFRACTION_REACH);
  shift = shift.mul(clamp(float(MAX_SHIFT).div(max(shift.length(), float(1e-4))), 0, 1));
  const uv = screenUV.add(shift).add(input.extraShift ?? vec2(0, 0));
  const behind = texture(input.inner, uv).rgb;

  const cosI = clamp(dot(n, v.negate()), 0, 1);
  const grazing = float(1).sub(cosI);
  const fresnel = float(0.04).add(float(0.96).mul(pow(grazing, 5)));
  const edge = pow(grazing, 2.2);
  // thick glass at the silhouette: a little darker and slightly green
  const tint = mix(vec3(1, 1, 1), vec3(0.7, 0.88, 0.8), edge.mul(0.85)).mul(mix(float(1), float(0.8), edge));
  const through = behind.mul(mix(vec3(1, 1, 1), tint.mul(float(1).sub(fresnel)), surface));

  const r = reflect(v, n);
  const sky = mix(vec3(0.03, 0.045, 0.07), vec3(0.5, 0.58, 0.68), clamp(r.y.mul(0.5).add(0.5), 0, 1));
  const key = normalize(vec3(-0.5, 0.62, 0.6));
  const rimLight = normalize(vec3(0.75, -0.45, 0.3));
  const highlight = smoothstep(0.9968, 0.9998, dot(r, key))
    .mul(3.6)
    .add(smoothstep(0.86, 0.995, dot(r, key)).mul(0.07))
    // a crisp bright line just inside the silhouette, so the glass edge reads on any background
    .add(pow(grazing, 7).mul(0.55))
    .add(smoothstep(0.55, 0.95, dot(r, rimLight)).mul(pow(grazing, 3)).mul(0.5));
  // 中の光が流れる: a soft band of light drifting through the orb
  const band = sin(
    dot(local, vec3(0.62, 0.74, 0.26))
      .mul(3.6)
      .sub(time.mul(0.5)),
  )
    .mul(0.5)
    .add(0.5);
  const flow = vec3(1, 0.9, 0.74).mul(pow(band, 8).mul(0.07).mul(cosI));
  const surfaceLight = sky
    .mul(fresnel)
    .add(vec3(1, 0.98, 0.95).mul(highlight))
    .add(flow);
  return through.add(surfaceLight.mul(surface));
}
