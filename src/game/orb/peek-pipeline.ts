import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { pass, renderOutput, rtt, uniform, uv, vec2, vec4 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { ownBackdropImage } from '../../core/glass';
import type { QualityPreset } from '../../core/quality';
import type { LayerField } from '../../layers/field';
import { LAYER_CHANNEL, viewMask } from '../../layers/layers';
import { OrbComposite, type OrbFrame } from './orb-composite';

/**
 * How much of the finishing runs (1フレームの描画の流れ 6). `full` is the game; the others take the chain apart so
 * a sensor can compare the same frame with and without a step: `aa` leaves out the bloom, `none` is AgX alone
 * (the frame before S-17).
 */
export type FinishMode = 'full' | 'aa' | 'none';

/** Dev switch `?finish=0|aa` (default: everything). */
export function finishModeFrom(params: URLSearchParams): FinishMode {
  const v = params.get('finish');
  return v === '0' ? 'none' : v === 'aa' ? 'aa' : 'full';
}

/**
 * 画面の仕上げ: ブルームは控えめにし、強い光源と光の雫だけが滲む. The values of the stress scene (S-05), whose
 * finishing this pipeline repeats: a quarter strength, a short radius, and a threshold on the linear luminance above
 * the lit surfaces and the dawn sky (≤ ≈ 0.7) and below the emissive glass (milky lamps, the vidro's rim light).
 * Only what is drawn brighter than the threshold bleeds, so the room's art decides which things are lights: the
 * prologue's light drop bleeds up close as the target, but from the dead end it is drawn about as bright as the dawn
 * sky and hardly does (S-17 判断待ち1).
 */
const BLOOM_STRENGTH = 0.25;
const BLOOM_RADIUS = 0.3;
const BLOOM_THRESHOLD = 0.9;
/**
 * Size of the bloom's bright pass and mips relative to the render size (three's default, and the stress scene, use
 * 0.5). At 0.5 the prologue's heaviest view at mid quality outweighed the stress scene at 1080p (1.15 vs 1.10 ms per
 * frame, vsync off); at 0.25 it stays at or under it (process/slices/S-17.md 計測値). The halos come out a little wider
 * and as smooth.
 */
const BLOOM_RESOLUTION = 0.25;
/** S-41: the layer channels of a thing on the back layer alone (no surface channel: not shared). */
const BACK_ONLY = 1 << LAYER_CHANNEL.back;
const SURFACE = 1 << LAYER_CHANNEL.surface;

export interface PeekPipelineOptions {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  field: LayerField;
  /** quality.peekScale: resolution of the back image relative to the render size. */
  peekScale: number;
  /** quality.antialias: FXAA (low) or SMAA (mid, high) at the end of the finishing. */
  antialias: QualityPreset['antialias'];
  environment: THREE.Texture | null;
  /** Default `full`; see FinishMode. */
  finish?: FinishMode;
  /**
   * S-41 (発案者 2026-10-27: 覗く像のパスで霧の向こうの物を描かない): how far the peek image reaches (metres of view depth), read each
   * frame while peeking. A thing that lies wholly beyond it is not drawn into the peek image (a thing reaching nearer is drawn
   * whole: nothing is cut at a plane). Without it, everything the main camera would draw.
   */
  peekFar?: () => number;
}

export type PeekFrame = Omit<OrbFrame, 'camera' | 'width' | 'height'>;

/**
 * The frame pipeline for a scene with layers and the hand orb (技術設計 > 1フレームの描画の流れ):
 *   1–3  the normal frame (surface + shared + materialized back) into the scene pass
 *   4    only while peeking: the back layer (back + shared, uncut) into a separate image at peekScale
 *   5    a full-screen composite draws the hand orb, refracting both images (linear HDR; its chromatic aberration
 *        through the orb is part of the composite)
 *   6    finishing, in the stress scene's order: restrained bloom on the linear composite → AgX (renderOutput) →
 *        the preset's FXAA or SMAA on the display image
 * Every target of the chain is a full-screen quad (the bloom's smaller mips included); no transmissive material is
 * drawn outside the scene pass, which has the canvas size (AGENTS.md).
 */
export class PeekPipeline {
  readonly backTarget: THREE.RenderTarget;
  /** Frames in which the back image was drawn (sensor). */
  backPassFrames = 0;

  private readonly pipeline: THREE.RenderPipeline;
  private readonly scenePass: ReturnType<typeof pass>;
  private readonly composite: OrbComposite;
  /** Finishing nodes that own render targets. */
  private readonly finishing: { dispose(): void }[] = [];
  /** One pixel of the drawing buffer in UV units, for the bloom's prefilter. */
  private readonly uTexel = uniform(new THREE.Vector2(1, 1));
  /** Layers the peek image draws; a dev switch can narrow it (e.g. hide the back layer). */
  peekMask = viewMask('peek');

  private readonly backCamera = new THREE.PerspectiveCamera();
  private readonly size = new THREE.Vector2();
  private readonly orbFrame: OrbFrame;
  private warm = true;

  constructor(private readonly opts: PeekPipelineOptions) {
    this.backTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    this.backTarget.texture.name = 'peek-back-layer';
    // matrices are copied from the main camera each frame; never recomputed from position/rotation
    this.backCamera.matrixAutoUpdate = false;
    this.backCamera.matrixWorldAutoUpdate = false;
    opts.camera.layers.mask = viewMask('main');
    this.scenePass = pass(opts.scene, opts.camera);
    // The room's glass is also drawn into the home's orb image before the dive: its own backdrop record keeps the
    // backdrop of this pass at this pass's size across render scale changes (three r186, S-29).
    ownBackdropImage(this.scenePass.renderTarget);
    this.composite = new OrbComposite({
      surface: this.scenePass.getTextureNode('output'),
      back: this.backTarget.texture,
      environment: opts.environment,
    });
    this.pipeline = new THREE.RenderPipeline(opts.renderer, this.finish(opts.finish ?? 'full'));
    // renderOutput applies AgX and the output colour space before the anti-aliasing; not again at the end
    this.pipeline.outputColorTransform = false;
    this.orbFrame = {
      center: [0, 0, 0],
      radius: 0,
      peek: 0,
      visible: false,
      camera: opts.camera,
      width: 1,
      height: 1,
      sunDirection: new THREE.Vector3(0, 1, 0),
    };
    this.resize();
  }

  /**
   * 6. 仕上げ behind the composite. The composite is stored once at the drawing-buffer size; the bloom reads that
   * image, so bright things glow where they are drawn, through the orb too (at this threshold the image inside the
   * orb keeps its contrast, tests/e2e/S-17-finishing.spec.ts). The bloom's bright pass runs at a quarter of the size,
   * so one of its pixels stands for a 4×4 block: it reads four bilinear taps at ±1 pixel, which cover the whole block.
   * Reading the block once (its middle 2×2) let small highlights drop in and out of the bloom as the view turned
   * (S-17 review: about 2.7× the frame-to-frame jitter of half size; with the four taps it is back at that level).
   */
  private finish(mode: FinishMode): THREE.Node {
    const linear = this.composite.node;
    let hdr = linear;
    if (mode === 'full') {
      const stored = rtt(linear);
      const at = (x: number, y: number) =>
        stored.sample(uv().add(this.uTexel.mul(vec2(x, y)))) as unknown as THREE.Node<'vec4'>;
      const block = at(-1, -1).add(at(1, -1)).add(at(-1, 1)).add(at(1, 1)).mul(0.25);
      const glow = bloom(block, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
      glow.setResolutionScale(BLOOM_RESOLUTION);
      this.finishing.push(stored, glow);
      hdr = vec4(stored.rgb.add(glow.rgb), 1);
    }
    const graded = renderOutput(hdr);
    if (mode === 'none') return graded;
    // the display image once at the drawing-buffer size, then the preset's anti-aliasing reads it
    const display = rtt(graded);
    const aa = this.opts.antialias === 'smaa' ? smaa(display) : fxaa(display);
    this.finishing.push(display, aa);
    return aa;
  }

  /** Render size in pixels (drawing buffer). */
  get renderSize(): Readonly<THREE.Vector2> {
    return this.size;
  }

  /**
   * Same view as the main camera, drawn with the peek layers. Only the matrices and lens values are
   * copied (Object3D.copy would also clone children and userData every frame).
   */
  private syncBackCamera(): void {
    const { camera } = this.opts;
    const bc = this.backCamera;
    bc.fov = camera.fov;
    bc.aspect = camera.aspect;
    bc.near = camera.near;
    bc.far = camera.far;
    bc.zoom = camera.zoom;
    bc.position.copy(camera.position);
    bc.quaternion.copy(camera.quaternion);
    bc.matrixWorld.copy(camera.matrixWorld);
    bc.matrixWorldInverse.copy(camera.matrixWorldInverse);
    bc.projectionMatrix.copy(camera.projectionMatrix);
    bc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    bc.layers.mask = this.peekMask;
  }

  /** S-41: the things hidden for the peek image (they lie wholly past its far end), to be shown again after it. */
  private readonly beyond: THREE.Object3D[] = [];
  private readonly sphere = new THREE.Sphere();
  private readonly forward = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  /**
   * Sensors: the things the last peek image left out past its far end, and of them those on the back layer alone (the 裏の層
   * itself: none should ever be so far).
   */
  farLeftOut = 0;
  farLeftOutBack = 0;

  /**
   * S-41: hides what the peek image does not reach — a thing three would cull by its bounds (frustumCulled), seen by the back
   * camera's layers, whose bounding sphere lies wholly deeper than `far` along the view. showBeyond() puts them back.
   */
  private hideBeyond(far: number): void {
    const bc = this.backCamera;
    const e = bc.matrixWorld.elements;
    this.eye.set(e[12] ?? 0, e[13] ?? 0, e[14] ?? 0);
    // the camera looks down its −Z
    this.forward.set(-(e[8] ?? 0), -(e[9] ?? 0), -(e[10] ?? 0)).normalize();
    const { eye, forward, sphere, beyond } = this;
    this.opts.scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) || !o.frustumCulled) return;
      if (!o.layers.test(bc.layers)) return;
      const bounds = (m as THREE.InstancedMesh).boundingSphere ?? m.geometry?.boundingSphere;
      if (!bounds) return;
      sphere.copy(bounds).applyMatrix4(o.matrixWorld);
      const depth = sphere.center.sub(eye).dot(forward);
      if (depth - sphere.radius > far) beyond.push(o);
    });
    let back = 0;
    for (const o of beyond) {
      o.visible = false;
      if ((o.layers.mask & BACK_ONLY) === BACK_ONLY && (o.layers.mask & SURFACE) === 0) back++;
    }
    this.farLeftOut = beyond.length;
    this.farLeftOutBack = back;
  }

  private showBeyond(): void {
    for (const o of this.beyond) o.visible = true;
    this.beyond.length = 0;
  }

  resize(): void {
    this.opts.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x * this.opts.peekScale));
    const h = Math.max(1, Math.floor(this.size.y * this.opts.peekScale));
    if (this.backTarget.width !== w || this.backTarget.height !== h) this.backTarget.setSize(w, h);
  }

  render(frame: PeekFrame): void {
    const { renderer, scene, field } = this.opts;
    this.resize();
    // The first frame also draws the back image once so its pipelines compile before the first peek.
    if (frame.peek > 0 || this.warm) {
      this.syncBackCamera();
      field.setPeekPass(true);
      // S-41: not past the peek image's far end — but on the warm-up (its pipelines made before the first peek), all of it
      const far = this.opts.peekFar?.() ?? Number.POSITIVE_INFINITY;
      if (frame.peek > 0 && !this.warm && far < this.opts.camera.far) this.hideBeyond(far);
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(this.backTarget);
      try {
        renderer.render(scene, this.backCamera);
      } finally {
        this.showBeyond();
      }
      renderer.setRenderTarget(previous);
      field.setPeekPass(false);
      if (frame.peek > 0) this.backPassFrames++;
      this.warm = false;
    }
    const f = this.orbFrame;
    f.center = frame.center;
    f.radius = frame.radius;
    f.peek = frame.peek;
    f.visible = frame.visible;
    f.sunDirection = frame.sunDirection;
    f.width = this.size.x;
    f.height = this.size.y;
    this.uTexel.value.set(1 / Math.max(1, this.size.x), 1 / Math.max(1, this.size.y));
    this.composite.update(f);
    this.pipeline.render();
  }

  dispose(): void {
    this.backTarget.dispose();
    this.scenePass.dispose();
    for (const n of this.finishing) n.dispose();
    this.pipeline.dispose();
  }
}
