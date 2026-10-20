import * as THREE from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

export interface RendererOptions {
  forceWebGL: boolean;
  renderScale: number;
}

export interface RendererHandle {
  renderer: THREE.WebGPURenderer;
  backend: Backend;
  /** Device pixel ratio before the quality scale (capped at 2). */
  baseDpr: number;
  /** True when the backend can measure GPU time per frame (timestamp queries). */
  gpuTiming: boolean;
}

/**
 * Creates the single WebGPURenderer for the app (falls back to WebGL2 automatically).
 * Color pipeline follows アートディレクション > 画面の仕上げ: AgX tone mapping, sRGB output.
 * Timestamp queries are requested so quality selection and dynamic resolution can see GPU cost.
 */
export async function createRenderer(container: HTMLElement, opts: RendererOptions): Promise<RendererHandle> {
  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    forceWebGL: opts.forceWebGL,
    trackTimestamp: true,
  });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const baseDpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(baseDpr * opts.renderScale);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();
  const backendInfo = renderer.backend as {
    isWebGPUBackend?: boolean;
    hasTimestamp?: boolean;
    trackTimestamp?: boolean;
  };
  const backend: Backend = backendInfo.isWebGPUBackend ? 'webgpu' : 'webgl2';
  // Public getter (WebGPU: always; WebGL2: EXT_disjoint_timer_query_webgl2) + the option we passed.
  const gpuTiming = backendInfo.hasTimestamp === true && backendInfo.trackTimestamp === true;
  return { renderer, backend, baseDpr, gpuTiming };
}
