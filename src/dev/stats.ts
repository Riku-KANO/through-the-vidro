import type { RenderCounters } from '../core/bench';

export interface StatsExtras {
  /** GPU time of the latest resolved frame, null when unavailable. */
  gpuMs: number | null;
  /** False when the governor found the timestamps implausible (shown, but marked). */
  gpuReliable: boolean;
  /** renderer.info.memory.texturesSize (render targets included). */
  texturesBytes: number;
  /** Vertex + index buffers (renderer.info.memory.attributesSize + indexAttributesSize). */
  buffersBytes: number;
  renderScale: number;
  quality: string;
}

const MB = 1048576;

/** Small perf overlay (開発用ツール > 性能表示). Toggle with ?stats=1 or the ` key. */
export class StatsOverlay {
  private readonly el: HTMLDivElement;
  private frames = 0;
  private elapsed = 0;

  constructor(
    parent: HTMLElement,
    private readonly backend: string,
  ) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;top:8px;left:8px;padding:6px 8px;font:12px/1.4 ui-monospace,monospace;' +
      'color:#e8eef2;background:rgba(10,14,20,.6);border-radius:6px;pointer-events:none;z-index:10;white-space:pre';
    parent.appendChild(this.el);
  }

  set visible(v: boolean) {
    this.el.style.display = v ? 'block' : 'none';
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  /** Cheap per frame; formats text only twice a second. */
  tick(dt: number, counters: RenderCounters, extras?: StatsExtras): void {
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < 0.5) return;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    if (!this.visible) return;
    const gpu =
      extras?.gpuMs == null
        ? 'gpu n/a'
        : `gpu ${extras.gpuMs.toFixed(1)} ms${extras.gpuReliable ? '' : ' (ts unreliable)'}`;
    const mem = extras
      ? `tex ${(extras.texturesBytes / MB).toFixed(0)} MB  geo ${(extras.buffersBytes / MB).toFixed(0)} MB`
      : '';
    const scale = extras ? `${extras.quality} ×${extras.renderScale.toFixed(2)}` : '';
    this.el.textContent =
      `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(1)} ms  ${gpu}\n` +
      `draws ${counters.drawCalls}  tris ${(counters.triangles / 1000).toFixed(0)}k\n` +
      `${mem}\n${this.backend}  ${scale}`;
  }

  dispose(): void {
    this.el.remove();
  }
}
