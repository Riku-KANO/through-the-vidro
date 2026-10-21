import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSES } from '../core/audio/mix';
import type { ScheduledVoice } from '../core/audio/voices';
import { createVidroEngine } from './engine';
import { VIDRO_REVERB_SEND, VIDRO_VOLUMES } from './levels';
import { VIDRO_ROOMS } from './rooms';

/**
 * A stand-in for the browser's audio graph, enough for S-09's AudioEngine to build itself on: every node records
 * its connections, every param its last value.
 */
class FakeParam {
  value = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FakeNode {
  readonly gain = new FakeParam();
  // DynamicsCompressorNode
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  // PannerNode
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  // ConvolverNode
  normalize = true;
  buffer: unknown = null;
  constructor(
    readonly kind: string,
    private readonly graph: FakeContext,
  ) {}
  connect<T>(destination: T): T {
    this.graph.links.push([this, destination]);
    return destination;
  }
  disconnect(): void {
    this.graph.links = this.graph.links.filter(([from]) => from !== this);
  }
}

class FakeContext {
  readonly sampleRate = 8000;
  currentTime = 0;
  closes = 0;
  readonly destination = { node: 'destination' };
  /** Every live connect(): [from, to]. */
  links: [FakeNode, unknown][] = [];
  constructor(public state: AudioContextState = 'running') {}
  addEventListener(): void {}
  removeEventListener(): void {}
  createGain(): FakeNode {
    return new FakeNode('gain', this);
  }
  createDynamicsCompressor(): FakeNode {
    return new FakeNode('compressor', this);
  }
  createConvolver(): FakeNode {
    return new FakeNode('convolver', this);
  }
  createPanner(): FakeNode {
    return new FakeNode('panner', this);
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): object {
    return { numberOfChannels, length, sampleRate, copyToChannel: () => undefined };
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closes++;
    this.state = 'closed';
    return Promise.resolve();
  }
}

const asContext = (c: FakeContext): BaseAudioContext => c as unknown as BaseAudioContext;

/** A silent voice that rings for a second. */
const silent = (_ctx: BaseAudioContext, _destination: AudioNode, when: number): ScheduledVoice => ({
  end: when + 1,
  fadeOut: () => undefined,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the game’s audio engine (one recipe for the AudioGate, the prologue alone and the audio lab)', () => {
  it('builds on the context it is given and leaves that context to whoever made it', async () => {
    const ctx = new FakeContext();
    const engine = await createVidroEngine(asContext(ctx));
    expect(engine.ctx).toBe(ctx);
    await engine.dispose();
    expect(ctx.closes).toBe(0);
  });

  it('starts in the workshop (序章「工房」, short reverb) unless given another room', async () => {
    const workshop = await createVidroEngine(asContext(new FakeContext()));
    expect(workshop.snapshot().room).toBe(VIDRO_ROOMS.workshop.id);
    const dome = await createVidroEngine(asContext(new FakeContext()), VIDRO_ROOMS.dome);
    expect(dome.snapshot().room).toBe(VIDRO_ROOMS.dome.id);
  });

  it('starts the four volumes (全体 / 音楽 / 効果音 / 環境音) at the game’s defaults', async () => {
    const engine = await createVidroEngine(asContext(new FakeContext()));
    expect(engine.snapshot().volumes).toEqual(VIDRO_VOLUMES);
  });

  it('sends each bus to the room’s reverb at the game’s level (music drier)', async () => {
    const ctx = new FakeContext();
    const engine = await createVidroEngine(asContext(ctx));
    for (const name of BUSES) {
      const bus = engine.bus(name);
      // bus → send → reverb input
      const sends = ctx.links
        .filter(([from]) => from === (bus as unknown as FakeNode))
        .map(([, to]) => to)
        .filter((to): to is FakeNode =>
          ctx.links.some(([from, next]) => from === to && next === (engine.reverb.input as unknown)),
        );
      expect(sends.map((s) => s.gain.value)).toEqual([VIDRO_REVERB_SEND[name]]);
    }
  });

  it('passes a per-emitter voice cap through (the audio lab’s cut test)', async () => {
    const steals = async (maxVoicesPerEmitter?: number): Promise<number> => {
      const engine = await createVidroEngine(
        asContext(new FakeContext()),
        VIDRO_ROOMS.workshop,
        maxVoicesPerEmitter === undefined ? {} : { maxVoicesPerEmitter },
      );
      const emitter = engine.createEmitter('sfx');
      engine.startVoice({ level: 0.5, emitter }, silent);
      engine.startVoice({ level: 0.5, emitter }, silent);
      return engine.snapshot().voicesStolen;
    };
    expect(await steals(1)).toBe(1);
    expect(await steals()).toBe(0);
  });

  it('without a context (a scene opened alone before any gesture), makes its own, silent until a gesture, and closes it', async () => {
    const made: FakeContext[] = [];
    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        constructor() {
          super('running');
          made.push(this);
        }
      },
    );
    const engine = await createVidroEngine();
    expect(made).toHaveLength(1);
    expect(engine.ctx).toBe(made[0]);
    expect(engine.state).toBe('suspended');
    expect(engine.snapshot().volumes).toEqual(VIDRO_VOLUMES);
    await engine.dispose();
    expect(made[0]?.closes).toBe(1);
  });
});
