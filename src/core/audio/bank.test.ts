import { describe, expect, it } from 'vitest';
import { loadBank, recording, type SoundSource, scheduleBuffer, startLoop, synth } from './bank';

/** Just enough of an AudioContext to see what the bank and the players make. */
class FakeBuffer {
  readonly channels: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  copyToChannel(data: Float32Array, channel: number): void {
    (this.channels[channel] as Float32Array).set(data);
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel] as Float32Array;
  }
}

class FakeParam {
  value = 1;
  readonly calls: [string, ...number[]][] = [];
  setValueAtTime(v: number, t: number): this {
    this.calls.push(['set', v, t]);
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number): this {
    this.calls.push(['target', v, t, tau]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.calls.push(['ramp', v, t]);
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.calls.push(['cancel', t]);
    return this;
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = 0;
  connect(to: FakeNode): FakeNode {
    this.outputs.push(to);
    return to;
  }
  disconnect(): void {
    this.disconnected++;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam();
  started: [number, number?] | null = null;
  stopped: number | null = null;
  onended: (() => void) | null = null;
  start(when: number, offset?: number): void {
    this.started = offset === undefined ? [when] : [when, offset];
  }
  stop(when: number): void {
    this.stopped = when;
  }
}

class FakeCtx {
  readonly sampleRate = 44100;
  currentTime = 0;
  readonly sources: FakeSource[] = [];
  readonly decoded: number[] = [];
  /** Byte lengths that fail to decode (a format the browser cannot read). */
  readonly undecodable = new Set<number>();
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }
  decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    this.decoded.push(bytes.byteLength);
    if (this.undecodable.has(bytes.byteLength)) return Promise.reject(new Error('EncodingError'));
    return Promise.resolve(new FakeBuffer(2, bytes.byteLength * 10, 48000));
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
}

const asCtx = (c: FakeCtx): BaseAudioContext => c as unknown as BaseAudioContext;
const asBuffer = (b: FakeBuffer): AudioBuffer => b as unknown as AudioBuffer;
const asNode = (n: FakeNode): AudioNode => n as unknown as AudioNode;

describe('a sound bank: synthesized and recorded sources through one port (S-22)', () => {
  it('renders a synthesized source at the context’s sample rate into a mono buffer of exactly its samples', async () => {
    const ctx = new FakeCtx();
    const rates: number[] = [];
    const bank = await loadBank(asCtx(ctx), [
      synth('beep', (sr) => {
        rates.push(sr);
        return Float32Array.from([0, 0.5, -0.25]);
      }),
    ]);
    expect(rates).toEqual([44100]);
    const b = bank[0] as unknown as FakeBuffer;
    expect(b.numberOfChannels).toBe(1);
    expect(b.sampleRate).toBe(44100);
    expect(Array.from(b.getChannelData(0))).toEqual([0, 0.5, -0.25]);
  });

  it('renders a source that asks for its own sample rate at that rate (the context resamples it)', async () => {
    const ctx = new FakeCtx();
    const bank = await loadBank(asCtx(ctx), [
      synth('bed', (sr) => new Float32Array(sr / 100), { sampleRate: 24000 }),
    ]);
    const b = bank[0] as unknown as FakeBuffer;
    expect(b.sampleRate).toBe(24000);
    expect(b.length).toBe(240);
  });

  it('decodes a recording from the first of its files the browser can read (two formats, 制作方法)', async () => {
    const ctx = new FakeCtx();
    // the .ogg (3 bytes) cannot be decoded here; the .m4a (5 bytes) can
    ctx.undecodable.add(3);
    const fetched: string[] = [];
    const bank = await loadBank(asCtx(ctx), [recording('step', 'a/step.ogg', 'a/step.m4a')], {
      fetchBytes: async (url) => {
        fetched.push(url);
        return new ArrayBuffer(url.endsWith('.ogg') ? 3 : 5);
      },
    });
    expect(fetched).toEqual(['a/step.ogg', 'a/step.m4a']);
    expect((bank[0] as unknown as FakeBuffer).length).toBe(50);
  });

  it('keeps going past a source that cannot be had: it is null and reported, the others load', async () => {
    const ctx = new FakeCtx();
    ctx.undecodable.add(3);
    const errors: string[] = [];
    const sources: SoundSource[] = [
      recording('lost', 'x.ogg'),
      synth('broken', () => {
        throw new Error('no');
      }),
      synth('fine', () => new Float32Array(4)),
    ];
    const bank = await loadBank(asCtx(ctx), sources, {
      fetchBytes: async () => new ArrayBuffer(3),
      onError: (id) => errors.push(id),
    });
    expect(bank[0]).toBeNull();
    expect(bank[1]).toBeNull();
    expect(bank[2]).not.toBeNull();
    expect(errors).toEqual(['lost', 'broken']);
  });

  it('lets the main thread breathe between sources', async () => {
    const ctx = new FakeCtx();
    let pauses = 0;
    await loadBank(
      asCtx(ctx),
      [
        synth('a', () => new Float32Array(1)),
        synth('b', () => new Float32Array(1)),
        synth('c', () => new Float32Array(1)),
      ],
      {
        pause: async () => {
          pauses++;
        },
      },
    );
    expect(pauses).toBe(3);
  });
});

describe('stopping a load', () => {
  it('leaves the sources not yet begun when it is aborted, and says nothing about them', async () => {
    const ctx = new FakeCtx();
    const stop = new AbortController();
    const made: string[] = [];
    const errors: string[] = [];
    const source = (id: string) =>
      synth(id, () => {
        made.push(id);
        if (id === 'b') stop.abort();
        return new Float32Array(2);
      });
    const bank = await loadBank(asCtx(ctx), [source('a'), source('b'), source('c')], {
      signal: stop.signal,
      onError: (id) => errors.push(id),
    });
    expect(made).toEqual(['a', 'b']);
    expect(bank.map((b) => b !== null)).toEqual([true, true, false]);
    expect(errors).toEqual([]);
  });
});

describe('playing a buffer (one-shot and loop)', () => {
  it('a one-shot starts at its time, at its rate and gain, and ends when the buffer has played', () => {
    const ctx = new FakeCtx();
    const dest = new FakeGain();
    const buffer = new FakeBuffer(1, 4410, 44100);
    const voice = scheduleBuffer(asCtx(ctx), asNode(dest), asBuffer(buffer), 2, { rate: 1.25, gain: 0.5 });
    const src = ctx.sources[0] as FakeSource;
    expect(src.buffer).toBe(buffer);
    expect(src.started).toEqual([2]);
    expect(src.playbackRate.value).toBe(1.25);
    expect(voice.end).toBeCloseTo(2 + 0.1 / 1.25, 9);
    // source → its gain → the destination
    const gain = src.outputs[0] as FakeGain;
    expect(gain.gain.value).toBe(0.5);
    expect(gain.outputs).toEqual([dest]);
    // cut short: it glides to silence and stops a little later
    voice.fadeOut(2.03);
    expect(gain.gain.calls.some(([k, v]) => k === 'target' && v === 0)).toBe(true);
    expect(src.stopped).toBeGreaterThan(2.03);
    // once it has ended it lets go of the destination
    src.onended?.();
    expect(gain.disconnected).toBe(1);
  });

  it('a loop starts where it is asked, fades in, and fades out and stops when told', () => {
    const ctx = new FakeCtx();
    const dest = new FakeGain();
    const buffer = new FakeBuffer(1, 44100 * 8, 44100);
    const loop = startLoop(asCtx(ctx), asNode(dest), asBuffer(buffer), 1, {
      offset: 11,
      gain: 0.3,
      fadeIn: 2,
    });
    const src = ctx.sources[0] as FakeSource;
    const gain = loop.gain as unknown as FakeGain;
    expect(src.loop).toBe(true);
    // an offset past the end wraps into the loop
    expect(src.started).toEqual([1, 3]);
    expect(gain.gain.calls[0]).toEqual(['set', 0, 1]);
    expect(gain.gain.calls.some(([k, v]) => k === 'target' && v === 0.3)).toBe(true);
    loop.stop(5, 0.5);
    expect(gain.gain.calls.some(([k, v, t]) => k === 'target' && v === 0 && t === 5)).toBe(true);
    expect(src.stopped).toBeGreaterThan(5.5);
    src.onended?.();
    expect(gain.disconnected).toBe(1);
  });
});
