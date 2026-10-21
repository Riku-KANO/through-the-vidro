import { describe, expect, it } from 'vitest';
import { VIDRO_VOLUMES } from '../audio/levels';
import type { AudioEngine } from '../core/audio/engine';
import type { RoomPreset } from '../core/audio/reverb';
import { AudioGate, type AudioGateOptions } from './audio-gate';

/** Stand-ins for the browser's AudioContext and S-09's AudioEngine: they count what is made, started and closed. */
class FakeContext {
  state: AudioContextState = 'running';
  closes = 0;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: string, f: () => void): void {
    this.listeners.add(f);
  }
  removeEventListener(_type: string, f: () => void): void {
    this.listeners.delete(f);
  }
  close(): Promise<void> {
    this.closes++;
    this.state = 'closed';
    for (const f of this.listeners) f();
    return Promise.resolve();
  }
}

class FakeEngine {
  readonly voices: { level: number; bus?: string }[] = [];
  accepting = true;
  dropped = 0;
  disposed = 0;
  unlocks = 0;
  boundTo: EventTarget | null = null;
  constructor(
    readonly ctx: FakeContext,
    readonly roomId: string,
  ) {}
  startVoice(spec: { level: number; bus?: string }): object | null {
    if (!this.accepting) {
      this.dropped++;
      return null;
    }
    this.voices.push({ level: spec.level, bus: spec.bus });
    return { end: 1, fadeOut: () => {} };
  }
  bindUnlockGestures(target: EventTarget): void {
    this.boundTo = target;
  }
  unlock(): Promise<void> {
    this.unlocks++;
    return Promise.resolve();
  }
  getVolume(channel: keyof typeof VIDRO_VOLUMES): number {
    return VIDRO_VOLUMES[channel];
  }
  snapshot(): object {
    return {
      state: this.ctx.state,
      room: this.roomId,
      voicesStarted: this.voices.length,
      voicesDropped: this.dropped,
      volumes: { ...VIDRO_VOLUMES },
    };
  }
  dispose(): Promise<void> {
    this.disposed++;
    return Promise.resolve();
  }
}

function rig(overrides: Partial<AudioGateOptions> = {}) {
  const contexts: FakeContext[] = [];
  const engines: FakeEngine[] = [];
  const target = new EventTarget();
  const gate = new AudioGate({
    gestureTarget: target,
    makeContext: () => {
      const c = new FakeContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    makeEngine: async (context: AudioContext, room: RoomPreset) => {
      const e = new FakeEngine(context as unknown as FakeContext, room.id);
      engines.push(e);
      return e as unknown as AudioEngine;
    },
    ...overrides,
  });
  /** Lets the engine promise settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return { contexts, engines, gate, target, settle };
}

describe('AudioGate: one AudioContext, made by the press of 「はじめる」 (UI/UX設計 > 読み込み)', () => {
  it('makes nothing before the press; the press makes one context and one engine on it, in the workshop', async () => {
    const r = rig();
    expect(r.gate.state).toBe('locked');
    expect(r.gate.engine).toBeNull();
    r.gate.ping(440);
    await r.settle();
    expect(r.contexts).toHaveLength(0);

    r.gate.unlock();
    expect(r.contexts).toHaveLength(1);
    await r.settle();
    expect(r.engines).toHaveLength(1);
    const engine = r.engines[0] as FakeEngine;
    expect(r.gate.engine).toBe(engine);
    expect(engine.ctx).toBe(r.contexts[0]);
    expect(engine.roomId).toBe('workshop');
    expect(r.gate.state).toBe('running');
    // later interruptions (a backgrounded tab) resume on the next gesture; the press itself asks to start
    expect(engine.boundTo).toBe(r.target);
    expect(engine.unlocks).toBe(1);

    // Esc back to the loading screen and press again: still the same one
    r.gate.unlock();
    await r.settle();
    expect(r.contexts).toHaveLength(1);
    expect(r.engines).toHaveLength(1);
    expect(r.gate.probe.contexts).toBe(1);
    expect(r.gate.probe.room).toBe('workshop');
    expect(r.gate.probe.volumes).toEqual(VIDRO_VOLUMES);
    r.gate.dispose();
  });

  it('shares that engine: whoever waits for it is handed it once it is made, or at once if it already is', async () => {
    const r = rig();
    const got: unknown[] = [];
    const stopped: unknown[] = [];
    r.gate.whenReady((e) => got.push(e));
    const stop = r.gate.whenReady((e) => stopped.push(e));
    stop();
    r.gate.unlock();
    expect(got).toEqual([]);
    await r.settle();
    expect(got).toEqual([r.engines[0]]);
    expect(stopped).toEqual([]);
    const late: unknown[] = [];
    r.gate.whenReady((e) => late.push(e));
    expect(late).toEqual([r.engines[0]]);
    r.gate.unlock();
    await r.settle();
    expect(got).toHaveLength(1);
    r.gate.dispose();
  });

  it('rings the drops on the engine’s effects bus (the four volumes) from the press on; nothing before it is kept', async () => {
    const r = rig();
    r.gate.ping(440, 0.05, 0.8);
    // the press rings at once (startOpening): the engine is a moment away, the pings still sound
    r.gate.unlock();
    r.gate.ping(587, 0.05, 1.4);
    r.gate.ping(880, 0.03, 1.6);
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(engine.voices).toEqual([
      { level: 0.05, bus: 'sfx' },
      { level: 0.03, bus: 'sfx' },
    ]);
    expect(r.gate.probe.uiVoices).toBe(2);
    r.gate.ping(660, 0.035, 0.8);
    expect(engine.voices).toHaveLength(3);
    // what the engine refuses (not running) is not counted as rung
    engine.accepting = false;
    r.gate.ping(660, 0.035, 0.8);
    expect(r.gate.probe.uiVoices).toBe(3);
    expect(r.gate.probe.voicesStarted).toBe(3);
    expect(r.gate.probe.voicesDropped).toBe(1);
    r.gate.dispose();
  });

  it('autoplay (skip): makes no context, also when pressed later, and hands no engine to anyone', async () => {
    const r = rig();
    const got: unknown[] = [];
    r.gate.whenReady((e) => got.push(e));
    r.gate.skip();
    r.gate.unlock();
    r.gate.ping(440);
    await r.settle();
    expect(r.contexts).toHaveLength(0);
    expect(r.gate.state).toBe('skipped');
    expect(got).toEqual([]);
    r.gate.dispose();
  });

  it('left while playing: the engine first (it fades out), then the context, once', async () => {
    const r = rig();
    r.gate.unlock();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    r.gate.dispose();
    expect(engine.disposed).toBe(1);
    await r.settle();
    expect(r.contexts[0]?.closes).toBe(1);
    expect(r.gate.state).toBe('closed');
    expect(r.gate.engine).toBeNull();
    r.gate.unlock();
    r.gate.ping(440);
    r.gate.dispose();
    await r.settle();
    expect(r.contexts).toHaveLength(1);
    expect(engine.disposed).toBe(1);
    expect(r.contexts[0]?.closes).toBe(1);
  });

  it('left while the engine is being made: it is disposed when it arrives, the context closed once, nobody handed it', async () => {
    const r = rig();
    const got: unknown[] = [];
    r.gate.whenReady((e) => got.push(e));
    r.gate.unlock();
    r.gate.ping(440);
    r.gate.dispose();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(engine.disposed).toBe(1);
    expect(engine.voices).toEqual([]);
    expect(r.contexts[0]?.closes).toBe(1);
    expect(got).toEqual([]);
  });

  it('left before the press: nothing was made, and a later press makes nothing', async () => {
    const r = rig();
    r.gate.dispose();
    r.gate.unlock();
    await r.settle();
    expect(r.contexts).toHaveLength(0);
  });

  it('no Web Audio: unavailable, and nobody is handed an engine', async () => {
    const noContext = rig({
      makeContext: () => {
        throw new Error('no AudioContext here');
      },
    });
    const got: unknown[] = [];
    noContext.gate.whenReady((e) => got.push(e));
    noContext.gate.unlock();
    await noContext.settle();
    expect(noContext.gate.state).toBe('unavailable');

    const noEngine = rig({ makeEngine: () => Promise.reject(new Error('engine failed')) });
    noEngine.gate.whenReady((e) => got.push(e));
    noEngine.gate.unlock();
    noEngine.gate.ping(440);
    await noEngine.settle();
    expect(noEngine.gate.state).toBe('unavailable');
    expect(noEngine.contexts[0]?.closes).toBe(1);
    expect(got).toEqual([]);
  });
});
