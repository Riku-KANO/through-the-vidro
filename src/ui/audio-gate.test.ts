import { describe, expect, it } from 'vitest';
import { VIDRO_VOLUMES } from '../audio/levels';
import type { AudioEngine } from '../core/audio/engine';
import type { RoomPreset } from '../core/audio/reverb';
import { AudioGate, type AudioGateOptions } from './audio-gate';

/**
 * Stand-ins for the browser's AudioContext and S-09's AudioEngine: they count what is made, started and closed, and
 * record every connection a sound makes (to see where the drops' pings go).
 */
class FakeParam {
  value = 0;
  setValueAtTime(): this {
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
  setTargetAtTime(): this {
    return this;
  }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  onended: (() => void) | null = null;
  constructor(
    readonly kind: 'gain' | 'oscillator',
    private readonly links: [FakeNode, unknown][],
  ) {}
  connect<T>(destination: T): T {
    this.links.push([this, destination]);
    return destination;
  }
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}

class FakeContext {
  closes = 0;
  resumes = 0;
  readonly destination = { node: 'destination' };
  /** Every connect(): [from, to]. */
  readonly links: [FakeNode, unknown][] = [];
  private readonly listeners = new Set<() => void>();
  constructor(public state: AudioContextState = 'running') {}
  addEventListener(_type: string, f: () => void): void {
    this.listeners.add(f);
  }
  removeEventListener(_type: string, f: () => void): void {
    this.listeners.delete(f);
  }
  resume(): Promise<void> {
    this.resumes++;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closes++;
    this.state = 'closed';
    for (const f of this.listeners) f();
    return Promise.resolve();
  }
  createGain(): FakeNode {
    return new FakeNode('gain', this.links);
  }
  createOscillator(): FakeNode {
    return new FakeNode('oscillator', this.links);
  }
}

type Schedule = (ctx: FakeContext, destination: unknown, when: number) => { end: number };

class FakeEngine {
  readonly voices: { level: number; bus?: string }[] = [];
  /** The engine's buses (what a voice is built into); `ui` once the gate has added it. */
  readonly buses: Record<string, { bus: string }> = {
    music: { bus: 'music' },
    sfx: { bus: 'sfx' },
    ambience: { bus: 'ambience' },
  };
  /** The sliders (the four volumes, as the player set them), the extra buses' volumes, and the ducks. */
  readonly sliders: Record<string, number> = { ...VIDRO_VOLUMES };
  readonly extra: Record<string, number> = {};
  readonly ducks: Record<string, number> = {};
  accepting = true;
  dropped = 0;
  disposed = 0;
  unlocks = 0;
  boundTo: EventTarget | null = null;
  /** dispose() resolves only when this is called (null: at once). */
  finishDispose: (() => void) | null = null;
  holdDispose = false;
  constructor(
    readonly ctx: FakeContext,
    readonly roomId: string,
  ) {}
  startVoice(spec: { level: number; bus?: string; extraBus?: string }, schedule: Schedule): object | null {
    if (!this.accepting) {
      this.dropped++;
      return null;
    }
    const bus = spec.extraBus ?? spec.bus ?? 'sfx';
    this.voices.push({ level: spec.level, bus });
    return schedule(this.ctx, this.buses[bus], 0);
  }
  addBus(name: string, opts: { volume?: number } = {}): object {
    this.buses[name] ??= { bus: name };
    this.extra[name] ??= opts.volume ?? 1;
    return this.buses[name];
  }
  setBusVolume(name: string, v: number): void {
    this.extra[name] = v;
  }
  getBusVolume(name: string): number {
    return this.extra[name] ?? 0;
  }
  setVolume(channel: string, v: number): void {
    this.sliders[channel] = v;
  }
  setDuck(owner: string, channel: string, v: number): void {
    this.ducks[`${owner}:${channel}`] = v;
  }
  getDuck(owner: string, channel: string): number {
    return this.ducks[`${owner}:${channel}`] ?? 1;
  }
  mixVolume(channel: string): number {
    let v = this.sliders[channel] ?? 1;
    for (const [key, d] of Object.entries(this.ducks)) if (key.endsWith(`:${channel}`)) v *= d;
    return v;
  }
  bindUnlockGestures(target: EventTarget): void {
    this.boundTo = target;
  }
  unlock(): Promise<void> {
    this.unlocks++;
    return Promise.resolve();
  }
  getVolume(channel: string): number {
    return this.sliders[channel] ?? 1;
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
    if (!this.holdDispose) return Promise.resolve();
    return new Promise((resolve) => {
      this.finishDispose = resolve;
    });
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

  it('rings the drops on the engine’s UI bus (its own volume, S-43) from the press on; nothing before it is kept', async () => {
    const r = rig();
    r.gate.ping(440, 0.05, 0.8);
    // the press rings at once (startOpening): the engine is a moment away, the pings still sound
    r.gate.unlock();
    r.gate.ping(587, 0.05, 1.4);
    r.gate.ping(880, 0.03, 1.6);
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(engine.voices).toEqual([
      { level: 0.05, bus: 'ui' },
      { level: 0.03, bus: 'ui' },
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

  it('builds each ping into the bus the engine hands it, never straight to the speakers', async () => {
    const r = rig();
    r.gate.unlock();
    r.gate.ping(587, 0.05, 1.4);
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    const ctx = r.contexts[0] as FakeContext;
    const into = (to: unknown): FakeNode[] => ctx.links.filter(([, t]) => t === to).map(([from]) => from);
    expect(into(ctx.destination)).toEqual([]);
    expect(into(engine.buses.ui).length).toBeGreaterThan(0);
    // every source of the ping ends up in that bus (whatever lies between)
    const reaches = (node: unknown, seen = new Set<unknown>()): boolean => {
      if (node === engine.buses.ui) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      return ctx.links.some(([from, to]) => from === node && reaches(to, seen));
    };
    const sources = ctx.links.map(([from]) => from).filter((n) => n.kind === 'oscillator');
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => reaches(s))).toBe(true);
    r.gate.dispose();
  });

  it('asks a suspended context to start right inside the press, before the engine is there', () => {
    const r = rig({
      makeContext: () => {
        const c = new FakeContext('suspended');
        r.contexts.push(c);
        return c as unknown as AudioContext;
      },
    });
    r.gate.unlock();
    expect(r.contexts[0]?.resumes).toBe(1);
    expect(r.gate.state).toBe('suspended');
    r.gate.dispose();
  });

  it('a user that throws on the hand-over does not keep the engine from the others; the error is reported', async () => {
    const errors: unknown[] = [];
    const r = rig({ onError: (err) => errors.push(err) });
    const got: unknown[] = [];
    r.gate.whenReady(() => {
      throw new Error('broken listener');
    });
    r.gate.whenReady((e) => got.push(e));
    r.gate.unlock();
    r.gate.ping(440);
    await r.settle();
    expect(got).toEqual([r.engines[0]]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['broken listener']);
    expect(r.gate.probe.uiVoices).toBe(1);
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
    engine.holdDispose = true;
    r.gate.dispose();
    expect(engine.disposed).toBe(1);
    await r.settle();
    // the context stays open while the engine fades out
    expect(r.contexts[0]?.closes).toBe(0);
    engine.finishDispose?.();
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

describe('AudioGate: the player’s volumes (設定 > 音: 全体・効果音・環境音・UI, S-43)', () => {
  it('takes the volumes before the press and sets them on the engine once it is made', async () => {
    const r = rig();
    r.gate.setVolume('ambience', 0.3);
    r.gate.setVolume('ui', 0.5);
    expect(r.gate.probe.sliders).toEqual({ ...VIDRO_VOLUMES, ambience: 0.3, ui: 0.5 });
    r.gate.unlock();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(engine.sliders.ambience).toBe(0.3);
    expect(engine.extra.ui).toBe(0.5);
    // and at once once it is there
    r.gate.setVolume('master', 0.4);
    r.gate.setVolume('ui', 0.2);
    expect(engine.sliders.master).toBe(0.4);
    expect(engine.extra.ui).toBe(0.2);
    expect(r.gate.probe.uiBus).toBe(0.2);
    expect(r.gate.probe.sliders).toEqual({ ...VIDRO_VOLUMES, master: 0.4, ambience: 0.3, ui: 0.2 });
    r.gate.dispose();
  });

  it('reports the volumes as the mix plays them (a duck shows) and the sliders as the player set them', async () => {
    const r = rig();
    r.gate.unlock();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    engine.setDuck('pause', 'ambience', 0.4);
    expect(r.gate.probe.volumes?.ambience).toBeCloseTo(VIDRO_VOLUMES.ambience * 0.4, 9);
    expect(r.gate.probe.sliders.ambience).toBe(VIDRO_VOLUMES.ambience);
    r.gate.dispose();
  });

  it('the UI’s other sounds (the pause, the settings) go through the gate: on the UI bus, counted as the UI’s', async () => {
    const r = rig();
    r.gate.unlock();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    const ui = r.gate.ui;
    expect(ui).not.toBeNull();
    const voice = ui?.startVoice({ level: 0.07, bus: 'sfx' }, (_ctx, destination, when) => {
      expect(destination).toBe(engine.buses.ui);
      return { end: when + 1, fadeOut: () => undefined };
    });
    expect(voice).not.toBeNull();
    expect(engine.voices).toEqual([{ level: 0.07, bus: 'ui' }]);
    expect(r.gate.probe.uiVoices).toBe(1);
    r.gate.dispose();
  });

  it('has no UI voices to give before the press', () => {
    const r = rig();
    expect(r.gate.ui).toBeNull();
    r.gate.dispose();
  });
});
