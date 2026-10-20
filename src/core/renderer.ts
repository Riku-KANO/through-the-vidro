import * as THREE from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl2';

export interface RendererOptions {
  forceWebGL: boolean;
  renderScale: number;
}

export interface RendererHandle {
  renderer: THREE.WebGPURenderer;
  backend: Backend;
}

/**
 * Creates the single WebGPURenderer for the app (falls back to WebGL2 automatically).
 * Color pipeline follows アートディレクション > 画面の仕上げ: AgX tone mapping, sRGB output.
 */
export async function createRenderer(container: HTMLElement, opts: RendererOptions): Promise<RendererHandle> {
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: opts.forceWebGL });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * opts.renderScale);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();
  const backend: Backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'webgpu'
    : 'webgl2';
  return { renderer, backend };
}
