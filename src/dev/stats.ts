import type { RenderCounters } from '../core/bench';

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

  tick(dt: number, counters: RenderCounters): void {
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < 0.5) return;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    this.el.textContent =
      `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(1)} ms\n` +
      `draws ${counters.drawCalls}  tris ${(counters.triangles / 1000).toFixed(0)}k\n` +
      `${this.backend}`;
  }

  dispose(): void {
    this.el.remove();
  }
}
