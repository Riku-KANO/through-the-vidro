import { pass } from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { LayerField } from '../../layers/field';
import { viewMask } from '../../layers/layers';
import { OrbComposite, type OrbFrame } from './orb-composite';

export interface PeekPipelineOptions {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  field: LayerField;
  /** quality.peekScale: resolution of the back image relative to the render size. */
  peekScale: number;
  environment: THREE.Texture | null;
}

export type PeekFrame = Omit<OrbFrame, 'camera' | 'width' | 'height'>;

/**
 * The frame pipeline for a scene with layers and the hand orb (技術設計 > 1フレームの描画の流れ):
 *   1–3  the normal frame (surface + shared + materialized back) into the scene pass
 *   4    only while peeking: the back layer (back + shared, uncut) into a separate image at peekScale
 *   5–6  a full-screen composite draws the hand orb, refracting both images, then AgX output
 */
export class PeekPipeline {
  readonly backTarget: THREE.RenderTarget;
  /** Frames in which the back image was drawn (sensor). */
  backPassFrames = 0;

  private readonly pipeline: THREE.RenderPipeline;
  private readonly scenePass: ReturnType<typeof pass>;
  private readonly composite: OrbComposite;
  private readonly backCamera = new THREE.PerspectiveCamera();
  private readonly size = new THREE.Vector2();
  private readonly orbFrame: OrbFrame;
  private warm = true;

  constructor(private readonly opts: PeekPipelineOptions) {
    this.backTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
    this.backTarget.texture.name = 'peek-back-layer';
    opts.camera.layers.mask = viewMask('main');
    this.scenePass = pass(opts.scene, opts.camera);
    this.composite = new OrbComposite({
      surface: this.scenePass.getTextureNode('output'),
      back: this.backTarget.texture,
      environment: opts.environment,
    });
    this.pipeline = new THREE.RenderPipeline(opts.renderer, this.composite.node);
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

  /** Render size in pixels (drawing buffer) and the back image size. */
  get renderSize(): { width: number; height: number } {
    return { width: this.size.x, height: this.size.y };
  }

  resize(): void {
    this.opts.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x * this.opts.peekScale));
    const h = Math.max(1, Math.floor(this.size.y * this.opts.peekScale));
    if (this.backTarget.width !== w || this.backTarget.height !== h) this.backTarget.setSize(w, h);
  }

  render(frame: PeekFrame): void {
    const { renderer, scene, camera, field } = this.opts;
    this.resize();
    // The first frame also draws the back image once so its pipelines compile before the first peek.
    if (frame.peek > 0 || this.warm) {
      this.backCamera.copy(camera);
      this.backCamera.layers.mask = viewMask('peek');
      this.backCamera.updateMatrixWorld();
      field.setPeekPass(true);
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(this.backTarget);
      renderer.render(scene, this.backCamera);
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
    this.composite.update(f);
    this.pipeline.render();
  }

  dispose(): void {
    this.backTarget.dispose();
    this.scenePass.dispose();
    this.pipeline.dispose();
  }
}
