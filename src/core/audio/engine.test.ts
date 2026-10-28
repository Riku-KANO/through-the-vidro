import { describe, expect, it } from 'vitest';
import { AudioEngine, duckStage } from './engine';
import { volumeToGain } from './mix';
import type { RoomPreset } from './reverb';
import type { ScheduledVoice } from './voices';

/**
 * A stand-in for the browser's audio graph (as src/audio/engine.test.ts): every node records its connections, every
 * param its last value — enough to follow how much of a bus reaches the speakers.
 */
class FakeParam {
  value = 1;
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
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
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
  state: AudioContextState = 'running';
  readonly destination = { node: 'destination' };
  links: [FakeNode, unknown][] = [];
  readonly compressors: FakeNode[] = [];
  addEventListener(): void {}
  removeEventListener(): void {}
  createGain(): FakeNode {
    return new FakeNode('gain', this);
  }
  createDynamicsCompressor(): FakeNode {
    const n = new FakeNode('compressor', this);
    this.compressors.push(n);
    return n;
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
}

/** How much of `from` reaches `to`: the gain nodes' levels multiplied along each path, summed over the paths. */
function reach(
  links: readonly [FakeNode, unknown][],
  from: unknown,
  to: unknown,
  path = new Set<unknown>(),
): number {
  let sum = 0;
  for (const [a, b] of links) {
    if (a !== from || path.has(b)) continue;
    if (b === to) {
      sum += 1;
      continue;
    }
    const level = b instanceof FakeNode && b.kind === 'gain' ? b.gain.value : 1;
    path.add(b);
    sum += level * reach(links, b, to, path);
    path.delete(b);
  }
  return sum;
}

const ROOM: RoomPreset = {
  id: 'test',
  t60: 0.5,
  preDelay: 0.01,
  wet: 0.2,
  damping: 0.5,
  early: { count: 2, spread: 0.02, gain: 0.3 },
} as RoomPreset;

async function make(volumes: Partial<Record<'master' | 'music' | 'sfx' | 'ambience', number>> = {}) {
  const ctx = new FakeContext();
  const engine = await AudioEngine.create({
    room: ROOM,
    volumes,
    reverbSend: { music: 1, sfx: 1, ambience: 1 },
    context: ctx as unknown as BaseAudioContext,
  });
  const limiter = ctx.compressors[0];
  /** The dry level of a bus at the limiter (its own volume, its ducks, the master and the master's ducks). */
  const dry = (node: AudioNode): number => {
    // the reverb's path is left out: the dry path only (the reverb input is a separate branch)
    const wet = new Set<unknown>([engine.reverb.input]);
    const links = ctx.links.filter(([, to]) => !wet.has(to));
    // from the node's input: its own gain counts too
    const own = node instanceof FakeNode && node.kind === 'gain' ? node.gain.value : 1;
    return own * reach(links, node, limiter);
  };
  return { ctx, engine, limiter, dry };
}

const silent = (_ctx: BaseAudioContext, _destination: AudioNode, when: number): ScheduledVoice => ({
  end: when + 1,
  fadeOut: () => undefined,
});

describe('AudioEngine: ducks, a turn-down of its own beside the player’s volumes (S-43)', () => {
  it('a duck lowers a channel on top of its volume; the volume (the player’s slider) is not touched', async () => {
    const { engine, dry } = await make({ ambience: 0.8 });
    expect(dry(engine.bus('ambience'))).toBeCloseTo(volumeToGain(0.8) * volumeToGain(1), 9);
    engine.setDuck('pause', 'ambience', 0.4);
    expect(engine.getVolume('ambience')).toBe(0.8);
    expect(dry(engine.bus('ambience'))).toBeCloseTo(volumeToGain(0.8) * volumeToGain(0.4), 9);
    // the player moves the slider while it is ducked: both hold
    engine.setVolume('ambience', 0.5);
    expect(dry(engine.bus('ambience'))).toBeCloseTo(volumeToGain(0.5) * volumeToGain(0.4), 9);
    // the duck goes: the player's slider is all that is left
    engine.setDuck('pause', 'ambience', 1);
    expect(dry(engine.bus('ambience'))).toBeCloseTo(volumeToGain(0.5), 9);
  });

  it('ducks of different owners multiply; each owner moves only its own', async () => {
    const { engine } = await make();
    engine.setDuck('pause', 'ambience', 0.5);
    engine.setDuck('away', 'ambience', 0.5);
    expect(engine.mixVolume('ambience')).toBeCloseTo(0.25, 9);
    expect(engine.getDuck('pause', 'ambience')).toBe(0.5);
    engine.setDuck('away', 'ambience', 1);
    expect(engine.mixVolume('ambience')).toBeCloseTo(0.5, 9);
  });

  it('mixVolume is the slider as the mix plays it: the volume times its ducks', async () => {
    const { engine } = await make({ sfx: 0.6 });
    expect(engine.mixVolume('sfx')).toBeCloseTo(0.6, 9);
    engine.setDuck('pause', 'sfx', 0.5);
    expect(engine.mixVolume('sfx')).toBeCloseTo(0.3, 9);
  });

  it('a ducked bus also sends less to the room’s reverb (the turn-down is the whole bus’s)', async () => {
    const { engine, ctx } = await make();
    const before = reach(ctx.links, engine.bus('ambience'), engine.reverb.input);
    engine.setDuck('pause', 'ambience', 0.4);
    expect(reach(ctx.links, engine.bus('ambience'), engine.reverb.input)).toBeCloseTo(
      before * volumeToGain(0.4),
      9,
    );
  });

  it('the master can be ducked too', async () => {
    const { engine, dry } = await make({ master: 1, sfx: 1 });
    engine.setDuck('test', 'master', 0.5);
    expect(dry(engine.bus('sfx'))).toBeCloseTo(volumeToGain(0.5), 9);
  });

  it('duckStage looks like the four volumes (getVolume / setVolume), and writes the duck', async () => {
    const { engine } = await make({ ambience: 0.9 });
    const stage = duckStage(engine, 'pause');
    expect(stage.getVolume('ambience')).toBe(1);
    stage.setVolume('ambience', 0.4);
    expect(engine.getDuck('pause', 'ambience')).toBe(0.4);
    expect(engine.getVolume('ambience')).toBe(0.9);
    expect(stage.getVolume('ambience')).toBe(0.4);
  });

  it('leaves the snapshot’s four volumes as the sliders', async () => {
    const { engine } = await make({ ambience: 0.7 });
    engine.setDuck('pause', 'ambience', 0.2);
    expect(engine.snapshot().volumes.ambience).toBe(0.7);
  });
});

describe('AudioEngine: extra buses (the UI’s sounds have a volume of their own, S-43)', () => {
  it('an extra bus goes to the master on its own volume, beside the effects', async () => {
    const { engine, dry } = await make({ master: 1, sfx: 0.5 });
    const ui = engine.addBus('ui', { volume: 0.6 });
    expect(dry(ui)).toBeCloseTo(volumeToGain(0.6), 9);
    expect(engine.getBusVolume('ui')).toBe(0.6);
    engine.setBusVolume('ui', 0.3);
    expect(dry(ui)).toBeCloseTo(volumeToGain(0.3), 9);
    // the effects' volume does not touch it, the master does
    engine.setVolume('sfx', 0);
    expect(dry(ui)).toBeCloseTo(volumeToGain(0.3), 9);
    engine.setVolume('master', 0.5);
    expect(dry(ui)).toBeCloseTo(volumeToGain(0.3) * volumeToGain(0.5), 9);
  });

  it('feeds the room’s reverb as asked', async () => {
    const { engine, ctx } = await make();
    const ui = engine.addBus('ui', { volume: 1, reverbSend: 0.5 });
    expect(reach(ctx.links, ui, engine.reverb.input)).toBeCloseTo(0.5, 9);
  });

  it('asked again by name, it is the same bus', async () => {
    const { engine } = await make();
    expect(engine.addBus('ui')).toBe(engine.addBus('ui', { volume: 0.2 }));
  });

  it('a voice can be started into it, counted as any voice', async () => {
    const { engine } = await make();
    const ui = engine.addBus('ui');
    let into: unknown = null;
    engine.startVoice({ level: 0.1, extraBus: 'ui' }, (_c, destination, when) => {
      into = destination;
      return silent(_c, destination, when);
    });
    expect(into).toBe(ui);
    expect(engine.snapshot().voicesStarted).toBe(1);
  });

  it('a voice for a bus that was never added is an error (a sound must not go somewhere unheard)', async () => {
    const { engine } = await make();
    expect(() => engine.startVoice({ level: 0.1, extraBus: 'nowhere' }, silent)).toThrow(/nowhere/);
  });

  it('only the limiter reaches the speakers', async () => {
    const { engine, ctx } = await make();
    engine.addBus('ui');
    const into = ctx.links.filter(([, to]) => to === ctx.destination);
    expect(into).toHaveLength(1);
  });
});
