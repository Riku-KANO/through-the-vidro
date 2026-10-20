import {
  clamp,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  normalize,
  pow,
  reflect,
  refract,
  screenSize,
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
/**
 * The rim band bends outwards (what lies just beyond the rim is squeezed into it, as in a glass ball).
 * An outward shift that grows towards the rim never folds the picture. M0 tuning value (screen units).
 */
const RIM_REACH = 0.05;
/**
 * Passing through the surface: a barrel warp over the whole screen and a ripple ring running outwards.
 * Kept below the slope at which the picture would fold (amplitude × frequency × 2 × aspect < 0.7 up to 21:9).
 */
const WARP_STRENGTH = 0.06;
const RIPPLE_FREQ = 12;
const RIPPLE_AMP = 0.012;

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

export interface LensUniforms {
  /** Outer camera projection scale: (P[0][0], P[1][1]). */
  proj: THREE.UniformNode<'vec2', THREE.Vector2>;
  /** Refraction strength (1 on the home screen, peaks at the crossing, 0 at the end of the dive). */
  refraction: THREE.UniformNode<'float', number>;
  /** Barrel warp over the whole screen while passing through the surface (0..1). */
  warp: THREE.UniformNode<'float', number>;
  /** Ripple ring of the membrane: strength (0..1) and radius (screen heights from the middle). */
  ripple: THREE.UniformNode<'float', number>;
  ringRadius: THREE.UniformNode<'float', number>;
}

export function createLensUniforms(): LensUniforms {
  return {
    proj: uniform(new THREE.Vector2(1, 1)),
    refraction: uniform(1),
    warp: uniform(0),
    ripple: uniform(0),
    ringRadius: uniform(0),
  };
}

/**
 * Screen-space displacement of passing through the surface. Shared by the orb and the full-screen
 * image so both carry the same distortion while one hands over to the other.
 */
function membraneShift(lens: LensUniforms): { shift: THREE.Node<'vec2'>; ring: F } {
  const aspect = screenSize.x.div(screenSize.y);
  const ndc = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)));
  const q = ndc.mul(vec2(aspect, 1));
  const r2 = dot(q, q);
  const barrel = ndc
    .mul(r2)
    .mul(lens.warp)
    .mul(-WARP_STRENGTH / 2)
    .mul(vec2(1, -1));
  const r = r2.sqrt();
  const k = r.sub(lens.ringRadius);
  const ring = exp(k.mul(k).negate().div(0.035)).mul(lens.ripple);
  const wave = sin(k.mul(RIPPLE_FREQ)).mul(ring).mul(RIPPLE_AMP);
  const dir = q.div(max(r, float(1e-3))).mul(vec2(1, -1));
  return { shift: barrel.add(dir.mul(wave)), ring };
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
}

export function glassShade(input: ShadeInput): V3 {
  const { lens, viewDir: v, normal: n, local, surface } = input;
  const bent = refract(v, n, float(1 / GLASS_IOR));
  const delta = onScreen(bent).sub(onScreen(v)).mul(lens.proj).mul(vec2(0.5, -0.5));
  let shift = delta.mul(lens.refraction).mul(REFRACTION_REACH);
  shift = shift.mul(clamp(float(MAX_SHIFT).div(max(shift.length(), float(1e-4))), 0, 1));
  // rim band: n.xy points outwards from the orb's centre on screen, its length grows to 1 at the rim
  const rho = n.xy.length();
  const outward = n.xy.div(max(rho, float(1e-4))).mul(vec2(1, -1));
  const rimBend = pow(smoothstep(0.55, 1, rho), 2)
    .mul(min(lens.refraction, float(1.5)))
    .mul(RIM_REACH);
  const membrane = membraneShift(lens);
  const uv = screenUV.add(shift).add(outward.mul(rimBend)).add(membrane.shift);
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
  const ringLight = vec3(0.86, 1, 0.94).mul(membrane.ring.mul(0.1));
  return through.add(surfaceLight.mul(surface)).add(ringLight);
}
