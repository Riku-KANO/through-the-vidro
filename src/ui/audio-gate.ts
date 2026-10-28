import { createVidroEngine } from '../audio/engine';
import { VIDRO_VOLUMES } from '../audio/levels';
import { VIDRO_ROOMS } from '../audio/rooms';
import type { AudioEngine } from '../core/audio/engine';
import { fadeAndStop, type PlannedSource } from '../core/audio/glass';
import { VOLUME_CHANNELS, type VolumeChannel } from '../core/audio/mix';
import type { RoomPreset } from '../core/audio/reverb';
import type { ScheduledVoice } from '../core/audio/voices';

/**
 * Browsers only allow sound after a user gesture (UI/UX設計 > 画面ごとの設計: 読み込み — ここで一度押してもらう).
 * The loading screen's 「はじめる」 calls `unlock()` inside its click/key handler: that press makes the page's one
 * AudioContext and the one AudioEngine on it (S-18). The UI rings through it, and the game shares it
 * (`whenReady`), so everything follows the same four volumes (サウンドデザイン > 制作方法: 全体 / 音楽 / 効果音 / 環境音).
 *   locked      no press yet
 *   running     unlocked and playing
 *   suspended   the browser kept it paused
 *   closed      the gate was disposed
 *   skipped     autoplay script (no gesture, so no context is created)
 *   unavailable no Web Audio
 */
export type AudioState = 'locked' | 'running' | 'suspended' | 'closed' | 'skipped' | 'unavailable';

export interface AudioGateOptions {
  /** The space the engine starts in. Default: the workshop (序章「工房」, where the dive lands). */
  room?: RoomPreset;
  /** Where later interruptions (a backgrounded tab) are resumed from on the next gesture. Default: window. */
  gestureTarget?: EventTarget;
  /** Makes the AudioContext inside the press. Default: `new AudioContext()` (unit tests pass a stand-in). */
  makeContext?: () => AudioContext;
  /** Builds the engine on that context. Default: the game's engine (src/audio/engine.ts). */
  makeEngine?: (context: AudioContext, room: RoomPreset) => Promise<AudioEngine>;
  /**
   * Where an error thrown by a `whenReady` user goes when the engine is handed over later (one handed it at once gets
   * its own error back directly). Default: the browser's reportError (it shows as a page error).
   */
  onError?: (err: unknown) => void;
}

/** window.__vidro.sceneProbe.audioGate (tests/e2e/S-18-*.spec.ts). Getters read the live state. */
export interface AudioGateProbe {
  readonly state: AudioState;
  /** AudioContexts this gate has made (0 before the press, then 1). */
  readonly contexts: number;
  /** Voices the UI started on the engine: the drops' pings, the pause's and the settings' sounds (S-43). */
  readonly uiVoices: number;
  /** Every voice the engine started: the UI's and the game's. */
  readonly voicesStarted: number;
  readonly voicesDropped: number;
  readonly room: string | null;
  /** The four volumes as the mix plays them: the player's slider times any turn-down (the pause's duck). */
  readonly volumes: Record<VolumeChannel, number> | null;
  /** The player's sliders (設定 > 音: 全体・効果音・環境音・UI), also before the engine is made (S-43). */
  readonly sliders: Record<UiVolumeChannel, number>;
}

/** The bus of the UI's own sounds, beside the effects (設定 > 音: UI の音量, S-43). */
export const UI_BUS = 'ui';
/** The player's volumes: the engine's four, and the UI's. */
export type UiVolumeChannel = VolumeChannel | typeof UI_BUS;

/** Starts a UI sound: the engine's `startVoice`, onto the UI bus, counted as the UI's (whatever bus it asks for). */
export interface UiVoices {
  startVoice: AudioEngine['startVoice'];
}

/** The stand-in pings' partials: a sine with an inharmonic partial (ratio, level). */
const PING_PARTIALS = [
  [1, 1],
  [2.76, 0.28],
] as const;

/**
 * M0 stand-in for the recorded glass sounds (サウンドデザイン; replaced in src/audio from M1), built into the
 * engine's `destination` at `t0`. Its nodes are held by the voice the engine keeps until it ends (S-09).
 */
function schedulePing(
  ctx: BaseAudioContext,
  destination: AudioNode,
  hz: number,
  gain: number,
  seconds: number,
  t0: number,
): ScheduledVoice {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(gain, t0 + 0.006);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
  out.connect(destination);
  const sources: PlannedSource[] = [];
  for (const [ratio, level] of PING_PARTIALS) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = hz * ratio;
    g.gain.value = level;
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + seconds);
    sources.push({ node: osc, stop: t0 + seconds });
  }
  const last = sources[sources.length - 1];
  if (last) last.node.onended = () => out.disconnect();
  return { end: t0 + seconds, fadeOut: (at: number) => fadeAndStop(out, sources, at) };
}

export class AudioGate {
  private readonly opts: AudioGateOptions;
  private readonly room: RoomPreset;
  private ctx: AudioContext | null = null;
  private eng: AudioEngine | null = null;
  /** The engine being made inside the press (it is a microtask away); null once failed or left. */
  private making: Promise<AudioEngine | null> | null = null;
  private readonly waiting = new Set<(engine: AudioEngine) => void>();
  private current: AudioState = 'locked';
  private disposed = false;
  private pings = 0;
  /** The player's sliders: set on the engine when it is made, and at once after. */
  private readonly sliders: Record<UiVolumeChannel, number> = { ...VIDRO_VOLUMES, [UI_BUS]: 1 };
  private uiVoices: UiVoices | null = null;
  readonly probe: AudioGateProbe;

  constructor(opts: AudioGateOptions = {}) {
    this.opts = opts;
    this.room = opts.room ?? VIDRO_ROOMS.workshop;
    const gate = this;
    this.probe = {
      get state() {
        return gate.current;
      },
      get contexts() {
        return gate.ctx ? 1 : 0;
      },
      get uiVoices() {
        return gate.pings;
      },
      get sliders() {
        return { ...gate.sliders };
      },
      get voicesStarted() {
        return gate.eng?.snapshot().voicesStarted ?? 0;
      },
      get voicesDropped() {
        return gate.eng?.snapshot().voicesDropped ?? 0;
      },
      get room() {
        return gate.eng?.snapshot().room ?? null;
      },
      get volumes() {
        const e = gate.eng;
        if (!e) return null;
        const v = {} as Record<VolumeChannel, number>;
        for (const ch of VOLUME_CHANNELS) v[ch] = e.mixVolume(ch);
        return v;
      },
    };
  }

  get state(): AudioState {
    return this.current;
  }

  /** The engine, once the press has made it. */
  get engine(): AudioEngine | null {
    return this.eng;
  }

  /**
   * The UI's sounds other than the pings (the pause, the settings: S-43): `startVoice` as the engine's, but on the UI's
   * bus (its own volume) and counted in `uiVoices`, so that every voice is the UI's or the room's (S-18). Null before the
   * press made the engine.
   */
  get ui(): UiVoices | null {
    return this.uiVoices;
  }

  /**
   * The player's volume of a channel (設定 > 音), 0..1: on the engine now, or when the press makes it. The pause's
   * turn-down is a duck on its own stage (core/audio engine), so this never fights it.
   */
  setVolume(channel: UiVolumeChannel, value: number): void {
    const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.sliders[channel] = v;
    const e = this.eng;
    if (!e) return;
    if (channel === UI_BUS) e.setBusVolume(UI_BUS, v);
    else e.setVolume(channel, v);
  }

  getVolume(channel: UiVolumeChannel): number {
    return this.sliders[channel];
  }

  /**
   * Hands the engine to `ready` once the press has made it (at once if it has). Never called when the gate is
   * skipped, unavailable or disposed first. Returns a function that stops waiting.
   */
  whenReady(ready: (engine: AudioEngine) => void): () => void {
    if (this.eng) {
      ready(this.eng);
      return () => undefined;
    }
    if (this.disposed || this.current === 'skipped' || this.current === 'unavailable') return () => undefined;
    this.waiting.add(ready);
    return () => {
      this.waiting.delete(ready);
    };
  }

  /** Must be called synchronously inside a click or key handler: the context is made (and starts) there. */
  unlock(): void {
    if (this.disposed || this.current === 'skipped' || this.current === 'unavailable') return;
    if (this.ctx) {
      // pressed again (after Esc): the same engine; resume it if the browser paused it
      void this.eng?.unlock();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = this.opts.makeContext
        ? this.opts.makeContext()
        : new window.AudioContext({ latencyHint: 'interactive' });
    } catch {
      this.current = 'unavailable';
      this.waiting.clear();
      return;
    }
    this.ctx = ctx;
    ctx.addEventListener('statechange', this.syncState);
    this.syncState();
    // ask to start now, synchronously inside the press (browsers that only honour resume() there); the engine
    // asks again once it is made
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    const make = this.opts.makeEngine ?? createVidroEngine;
    this.making = make(ctx, this.room).then(
      (engine) => {
        if (this.disposed) {
          // left before it was ready: dispose() already let go of the context; close it after the engine
          const close = (): Promise<void> => ctx.close().catch(() => undefined);
          void engine.dispose().then(close, close);
          return null;
        }
        this.eng = engine;
        // the UI's own bus, and the player's volumes (set before the press, from the kept settings)
        engine.addBus(UI_BUS, { volume: this.sliders[UI_BUS] });
        for (const ch of VOLUME_CHANNELS) engine.setVolume(ch, this.sliders[ch]);
        this.uiVoices = {
          startVoice: (spec, schedule) => {
            const voice = engine.startVoice({ level: spec.level, extraBus: UI_BUS }, schedule);
            if (voice) this.pings++;
            return voice;
          },
        };
        // later interruptions (a backgrounded tab, a device change) resume on the next gesture
        engine.bindUnlockGestures(this.opts.gestureTarget ?? window);
        // still inside the press's activation: start it if the browser made it suspended
        void engine.unlock();
        const waiting = [...this.waiting];
        this.waiting.clear();
        for (const ready of waiting) {
          try {
            ready(engine);
          } catch (err) {
            // one failing user must not keep the engine from the others; the error still surfaces
            if (this.opts.onError) this.opts.onError(err);
            else if (typeof reportError === 'function') reportError(err);
            else
              queueMicrotask(() => {
                throw err;
              });
          }
        }
        return engine;
      },
      () => {
        // no audio here: the screens go on, silent
        this.current = 'unavailable';
        this.waiting.clear();
        ctx.removeEventListener('statechange', this.syncState);
        void ctx.close().catch(() => undefined);
        return null;
      },
    );
  }

  /** The autoplay script has no user gesture; stay silent instead of asking the browser. */
  skip(): void {
    if (this.current === 'locked') this.current = 'skipped';
    this.waiting.clear();
  }

  /**
   * A drop's sound (M0 stand-in), on the engine's effects bus: it follows the master and sfx volumes and sounds in
   * the engine's space. A short sine with an inharmonic partial, so hover and transitions answer within 0.1 s
   * (UIの原則 3). Nothing rings before the press, and nothing is kept for later.
   */
  ping(hz: number, gain = 0.05, seconds = 0.9): void {
    if (this.disposed) return;
    if (this.eng) {
      this.ring(this.eng, hz, gain, seconds);
      return;
    }
    // pressed a moment ago (the same handler): ring as soon as the engine is there
    void this.making?.then((engine) => {
      if (engine && !this.disposed) this.ring(engine, hz, gain, seconds);
    });
  }

  private ring(engine: AudioEngine, hz: number, gain: number, seconds: number): void {
    const voice = engine.startVoice({ level: gain, extraBus: UI_BUS }, (ctx, destination, when) =>
      schedulePing(ctx, destination, hz, gain, seconds, when),
    );
    if (voice) this.pings++;
  }

  /** The engine fades out and lets go of its graph, then the context is closed. Whoever shares it stops first. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.waiting.clear();
    const ctx = this.ctx;
    const engine = this.eng;
    this.eng = null;
    this.uiVoices = null;
    if (!ctx) return;
    ctx.removeEventListener('statechange', this.syncState);
    if (this.current !== 'unavailable') this.current = 'closed';
    // still being made: it is disposed and the context closed when it arrives; failed: already closed (unlock)
    if (!engine) return;
    const close = (): Promise<void> => ctx.close().catch(() => undefined);
    void engine.dispose().then(close, close);
  }

  private readonly syncState = (): void => {
    if (!this.ctx || this.disposed) return;
    const s = this.ctx.state;
    this.current = s === 'running' ? 'running' : s === 'closed' ? 'closed' : 'suspended';
  };
}
