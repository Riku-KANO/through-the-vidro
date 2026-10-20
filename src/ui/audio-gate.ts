/**
 * Browsers only allow sound after a user gesture (UI/UX設計 > 画面ごとの設計: 読み込み — ここで一度押してもらう).
 * The loading screen's 「はじめる」 calls `unlock()` inside its click/key handler; everything that plays
 * sound later takes the context from here.
 *   locked      no gesture yet
 *   running     unlocked and playing
 *   suspended   the browser kept it paused
 *   skipped     autoplay script (no gesture, so no context is created)
 *   unavailable no Web Audio
 */
export type AudioState = 'locked' | 'running' | 'suspended' | 'skipped' | 'unavailable';

export class AudioGate {
  private ctx: AudioContext | null = null;
  private current: AudioState = 'locked';

  get state(): AudioState {
    return this.current;
  }

  get context(): AudioContext | null {
    return this.current === 'running' ? this.ctx : null;
  }

  /** Must be called synchronously inside a click or key handler. */
  unlock(): void {
    if (this.current === 'skipped' || this.current === 'unavailable') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext;
      if (!Ctor) {
        this.current = 'unavailable';
        return;
      }
      this.ctx = new Ctor();
      this.ctx.onstatechange = () => this.syncState();
    }
    this.syncState();
    this.ctx.resume().then(
      () => this.syncState(),
      () => this.syncState(),
    );
  }

  /** The autoplay script has no user gesture; stay silent instead of asking the browser. */
  skip(): void {
    if (this.current === 'locked') this.current = 'skipped';
  }

  /**
   * M0 stand-in for the recorded glass sounds (サウンドデザイン; replaced in src/audio from M1).
   * A short sine with an inharmonic partial, so hover and transitions answer within 0.1 s (UIの原則 3).
   */
  ping(hz: number, gain = 0.05, seconds = 0.9): void {
    const ctx = this.context;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    out.connect(ctx.destination);
    for (const [ratio, level] of [
      [1, 1],
      [2.76, 0.28],
    ] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = hz * ratio;
      g.gain.value = level;
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + seconds);
    }
  }

  dispose(): void {
    if (this.ctx) {
      this.ctx.onstatechange = null;
      void this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
  }

  private syncState(): void {
    if (!this.ctx) return;
    this.current = this.ctx.state === 'running' ? 'running' : 'suspended';
  }
}
