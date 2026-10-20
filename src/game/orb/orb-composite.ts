import {
  clamp,
  dot,
  Fn,
  float,
  If,
  length,
  max,
  mix,
  normalize,
  pmremTexture,
  pow,
  reflect,
  refract,
  screenUV,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../layers/footing';

type TexNode = ReturnType<typeof texture>;
type V3 = THREE.Node<'vec3'>;
type V2 = THREE.Node<'vec2'>;
type F1 = THREE.Node<'float'>;
type V4 = THREE.Node<'vec4'>;

/** Typed sampling helper: the texture node typings do not carry the vec4 result type. */
const read = (tex: TexNode, uv: V2): V4 => tex.sample(uv) as unknown as V4;

/** 屈折率1.5 (アートディレクション > ガラスの種類). */
const IOR = 1.5;
/**
 * How much of the physical refraction is applied. A real 15 cm ball this close to the eye shows the
 * world upside down; at this strength the back layer stays upright and lines up with the world
 * (a 1.3× magnifier with a strongly bent rim). See process/slices/S-02.md 判断待ち.
 */
const REFRACT_REST = 0.1;
const REFRACT_PEEK = 0.14;
/** 色収差は玉越しにだけ強くかける: channel spread of the refraction while peeking. */
const ABERRATION = 0.035;
/** 被写界深度は覗いている間だけ、玉の外側を少しぼかす: blur radius in render pixels at full peek. */
const OUTSIDE_BLUR_PX = 3;
/** 裏は光があった頃の街の名残: a warmer, slightly brighter grade for the back image. */
const BACK_GRADE = new THREE.Color(1.1, 1.02, 0.88);
/** 透明ガラス: 断面の縁がわずかに緑. */
const EDGE_TINT = new THREE.Color(0.82, 0.96, 0.9);
/** 気泡入りガラス (手の玉): a few small bubbles inside, in orb-local units (radius = 1). */
const BUBBLES: readonly [number, number, number, number][] = [
  [0.32, 0.18, 0.12, 0.05],
  [-0.4, -0.22, 0.3, 0.035],
  [0.05, -0.48, -0.1, 0.04],
  [-0.18, 0.42, -0.25, 0.03],
  [0.5, -0.12, -0.35, 0.025],
];

export interface OrbCompositeInputs {
  /** The normal frame (surface + shared + materialized back), linear HDR. */
  surface: TexNode;
  /** The back-layer image drawn while peeking. */
  back: THREE.Texture;
  /** PMREM environment for the orb's reflections. */
  environment: THREE.Texture | null;
}

export interface OrbFrame {
  /** View-space centre and radius of the hand orb. */
  center: Vec3;
  radius: number;
  /** Eased peek amount 0..1. */
  peek: number;
  /** 0 = hand empty (orb not drawn). */
  visible: boolean;
  camera: THREE.PerspectiveCamera;
  /** Render target size in pixels. */
  width: number;
  height: number;
  /** World-space direction toward the sun, for the highlight. */
  sunDirection: THREE.Vector3;
}

/**
 * 1フレームの描画の流れ 5〜6: draws the hand orb as an analytic glass sphere in a full-screen pass.
 * Inside the orb the surface image and the back image are read along the refracted ray and blended
 * by the peek amount; the reveal opens from the centre (玉越しの円が広がる). Chromatic aberration is
 * applied only through the orb, and the outside is slightly blurred only while peeking.
 */
export class OrbComposite {
  readonly node: ReturnType<typeof vec4>;

  private readonly uPeek = uniform(0);
  private readonly uCenter = uniform(new THREE.Vector3(0, -1, -0.4));
  private readonly uRadius = uniform(0.075);
  private readonly uVisible = uniform(1);
  private readonly uTanHalf = uniform(new THREE.Vector2(1, 1));
  private readonly uViewport = uniform(new THREE.Vector2(1, 1));
  private readonly uCamRot = uniform(new THREE.Matrix3());
  private readonly uSunView = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uBackTexel = uniform(new THREE.Vector2(1, 1));
  private readonly sunView = new THREE.Vector3();
  private readonly backTexture: THREE.Texture;
  private readonly viewRot = new THREE.Matrix3();

  constructor(inputs: OrbCompositeInputs) {
    const { surface } = inputs;
    const back = texture(inputs.back);
    this.backTexture = inputs.back;
    const env = inputs.environment;
    const { uPeek, uCenter, uRadius, uVisible, uTanHalf, uViewport, uCamRot, uSunView } = this;

    const toUV = (dir: V3): V2 => {
      const p = dir.xy.div(dir.z.negate().max(1e-4)).div(uTanHalf);
      return vec2(p.x.mul(0.5).add(0.5), float(0.5).sub(p.y.mul(0.5)));
    };
    const refracted = (d: V3, t: V3, s: F1): V2 => toUV(normalize(mix(d, t, s)));
    // The back image is low resolution (peekScale); four bilinear taps at half-texel offsets
    // smooth the stair steps of thin brass lines without visibly blurring the image.
    const soft = (tex: TexNode, uv: V2): V4 => {
      const o = this.uBackTexel.mul(0.5);
      return read(tex, uv.add(vec2(o.x, o.y)))
        .add(read(tex, uv.add(vec2(o.x.negate(), o.y))))
        .add(read(tex, uv.add(vec2(o.x, o.y.negate()))))
        .add(read(tex, uv.sub(o)))
        .mul(0.25);
    };

    this.node = Fn(() => {
      const uv = screenUV;
      const ndc = vec2(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)));
      const D = normalize(vec3(ndc.mul(uTanHalf), -1));
      const C = uCenter;
      const b = dot(D, C);
      const cc = dot(C, C);
      const perp = sqrt(max(cc.sub(b.mul(b)), 0));
      // pixel footprint at the orb's distance, for an anti-aliased silhouette
      const pixel = sqrt(cc).mul(uTanHalf.y.mul(2)).div(uViewport.y);
      const cover = clamp(uRadius.sub(perp).div(pixel).add(0.5), 0, 1).mul(uVisible);

      const color = vec3(0).toVar();

      // Outside the orb: the frame, slightly blurred while peeking, with a soft vignette.
      If(cover.lessThan(1), () => {
        const base = read(surface, uv).rgb.toVar();
        If(uPeek.greaterThan(0.001), () => {
          const step = vec2(1).div(uViewport).mul(uPeek.mul(OUTSIDE_BLUR_PX));
          const acc = base.toVar();
          // eight taps on a ring around the pixel
          const taps = Array.from({ length: 8 }, (_, i) => [
            Math.cos((i * Math.PI) / 4),
            Math.sin((i * Math.PI) / 4),
          ]);
          for (const [x = 0, y = 0] of taps) acc.addAssign(read(surface, uv.add(step.mul(vec2(x, y)))).rgb);
          base.assign(acc.div(taps.length + 1));
          const vignette = smoothstep(0.45, 1.25, length(ndc.mul(vec2(uTanHalf.x.div(uTanHalf.y), 1))));
          base.mulAssign(float(1).sub(vignette.mul(uPeek.mul(0.22))));
        });
        color.assign(base);
      });

      // Inside the orb: refract, read surface and back images, shade as clear glass.
      If(cover.greaterThan(0), () => {
        const t = b.sub(sqrt(max(uRadius.mul(uRadius).sub(perp.mul(perp)), 0)));
        const P = D.mul(t);
        const N = normalize(P.sub(C));
        const cosI = clamp(dot(N, D.negate()), 0, 1);
        const T = refract(D, N, 1 / IOR);
        const s = mix(float(REFRACT_REST), float(REFRACT_PEEK), uPeek);
        const spread = s.mul(uPeek.mul(ABERRATION));
        const uvR = refracted(D, T, s.sub(spread));
        const uvG = refracted(D, T, s);
        const uvB = refracted(D, T, s.add(spread));
        const surf = vec3(read(surface, uvR).r, read(surface, uvG).g, read(surface, uvB).b).toVar();
        const rim = perp.div(uRadius);

        If(uPeek.greaterThan(0.001), () => {
          const backCol = vec3(soft(back, uvR).r, soft(back, uvG).g, soft(back, uvB).b).mul(
            vec3(BACK_GRADE.r, BACK_GRADE.g, BACK_GRADE.b),
          );
          // The circle of the back layer opens from the centre as the orb rises.
          const open = uPeek.mul(1.15);
          const reveal = float(1).sub(smoothstep(open.sub(0.15), open, rim));
          surf.assign(mix(surf, backCol, reveal.mul(uPeek)));
        });

        // Bubbles: the inner (physically refracted) ray grazing a bubble lights its rim.
        const inner = T;
        const bubbles = float(0).toVar();
        for (const [bx, by, bz, br] of BUBBLES) {
          const bc = C.add(vec3(bx, by, bz).mul(uRadius));
          const rb = uRadius.mul(br);
          const oc = bc.sub(P);
          const along = dot(oc, inner);
          const miss = sqrt(max(dot(oc, oc).sub(along.mul(along)), 0)).div(rb);
          const hit = float(1)
            .sub(smoothstep(0.92, 1.0, miss))
            .mul(along.greaterThan(0).select(1, 0));
          bubbles.addAssign(hit.mul(smoothstep(0.55, 0.98, miss)));
        }

        const fresnel = float(0.04).add(pow(float(1).sub(cosI), 5).mul(0.96));
        const R = reflect(D, N);
        const rWorld = uCamRot.mul(R);
        const envCol = env ? pmremTexture(env, rWorld, float(0.04)).rgb : vec3(0.75, 0.8, 0.88);
        const spec = pow(max(dot(R, uSunView), 0), 380).mul(9);
        const edge = mix(vec3(1), vec3(EDGE_TINT.r, EDGE_TINT.g, EDGE_TINT.b), pow(rim, 3));
        const glass = surf
          .mul(edge)
          .mul(float(1).sub(fresnel))
          .add(envCol.mul(fresnel))
          .add(vec3(1, 0.96, 0.9).mul(bubbles.mul(0.35)))
          .add(vec3(1, 0.97, 0.92).mul(spec));
        color.assign(mix(color, glass, cover));
      });

      return vec4(color, 1);
    })();
  }

  update(frame: OrbFrame): void {
    const cam = frame.camera;
    const tanY = Math.tan((cam.fov * Math.PI) / 360);
    this.uTanHalf.value.set(tanY * cam.aspect, tanY);
    this.uViewport.value.set(frame.width, frame.height);
    const img = this.backTexture.image as { width?: number; height?: number } | undefined;
    this.uBackTexel.value.set(1 / Math.max(1, img?.width ?? 1), 1 / Math.max(1, img?.height ?? 1));
    this.uCenter.value.set(frame.center[0], frame.center[1], frame.center[2]);
    this.uRadius.value = frame.radius;
    this.uPeek.value = frame.peek;
    this.uVisible.value = frame.visible ? 1 : 0;
    this.viewRot.setFromMatrix4(cam.matrixWorld);
    this.uCamRot.value.copy(this.viewRot);
    // world → view for the sun: the inverse of a rotation is its transpose
    this.sunView.copy(frame.sunDirection).applyMatrix3(this.viewRot.transpose()).normalize();
    this.uSunView.value.copy(this.sunView);
  }
}
