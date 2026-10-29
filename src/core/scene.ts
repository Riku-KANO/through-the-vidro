import type * as THREE from 'three/webgpu';
import type { QualityLevel, QualityPort, QualityPreset } from './quality';
import type { Backend } from './renderer';

/**
 * Everything a sandbox scene receives from the app shell.
 * Scenes must not create their own renderer or animation loop.
 */
export interface SceneContext {
  renderer: THREE.WebGPURenderer;
  backend: Backend;
  canvas: HTMLCanvasElement;
  /** DOM layer above the canvas for scene-specific UI. Cleared on dispose. */
  overlay: HTMLElement;
  quality: QualityPreset;
  qualityLevel: QualityLevel;
  /**
   * The shell's quality (S-43, made part of the contract in S-48): what is chosen and in use, the player's requests, and
   * the port a scene that takes another preset in place attaches to (`QualityPort.attach`). A scene that does not attach is
   * made again for another preset, with that preset on its context.
   */
  qualityPort: QualityPort;
  /** Raw URL params so a scene can read its own debug switches. */
  params: URLSearchParams;
}

export interface SandboxScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /**
   * Called once per frame before render. dt and t are in seconds.
   * CPU work only: do not submit GPU work here (renderer.compute(), render passes). The app times the GPU frame
   * around render() (perf/gpu-span.ts, S-08), so GPU work submitted in update() would escape the measurement.
   */
  update(dt: number, t: number): void;
  /**
   * Optional custom render (multi-pass, post-processing). Every GPU submit of the frame happens in here.
   * Default: renderer.render(scene, camera).
   */
  render?(): void;
  /** Called after the canvas size changes. Camera aspect is already updated. */
  resize?(width: number, height: number): void;
  dispose(): void;
}

export type SceneFactory = (ctx: SceneContext) => Promise<SandboxScene>;

export interface SceneModule {
  /** One line shown in the scene list. */
  title: string;
  default: SceneFactory;
}
