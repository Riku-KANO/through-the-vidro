import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { glassPitch, VIDRO_SCALE } from '../../audio/tuning';
import type { AudioEngine, Emitter } from '../../core/audio/engine';
import { isInScale } from '../../core/audio/scale';
import type { Vec3 } from '../../layers/footing';
import { sweepSpan } from '../../layers/settle';
import { EventBus, eventName, type PrologueEvent } from './events';
import {
  BENCH_ORB,
  BRIDGE_SETTLE,
  DROP,
  EDGE_Z,
  FURNACE_MOUTH,
  floorAt,
  GATE,
  PEDESTAL_ORB,
  SPAWNS,
  TUB_DRIP,
  WIND_CHIME,
  WORKSHOP,
  WORKSHOP_FLOOR_RADIUS,
} from './layout';
import type { FinaleEvent } from './session';
import {
  answer,
  CueLog,
  type CuePlayer,
  createPrologueSound,
  cueFor,
  cueName,
  PROLOGUE_AMBIENCE,
  type SoundBanks,
  type SoundCue,
  type SoundOptions,
  type SoundRoom,
  sourcePoint,
} from './sound';

const ALL_EVENTS: PrologueEvent[] = [
  { type: 'peekStart' },
  { type: 'peekEnd' },
  { type: 'place', pedestal: 'dead-end' },
  { type: 'pickup', from: 'bench' },
  { type: 'pickup', from: 'pedestal' },
  { type: 'shake', reason: 'peek' },
  { type: 'shake', reason: 'pickup' },
  { type: 'dropTouched' },
  { type: 'dropTaken' },
];

const names = (events: PrologueEvent[]): (string | null)[] =>
  events.map((e) => {
    const cue = cueFor(e);
    return cue ? cueName(cue) : null;
  });

describe('what the prologue’s events sound like', () => {
  it('answers 覗く・置く・拾う・震える with the vidro’s four po-pens (アセットリスト > 音)', () => {
    expect(
      names([
        { type: 'peekStart' },
        { type: 'place', pedestal: 'dead-end' },
        { type: 'pickup', from: 'bench' },
        { type: 'pickup', from: 'pedestal' },
        { type: 'shake', reason: 'peek' },
        { type: 'shake', reason: 'pickup' },
      ]),
    ).toEqual([
      'popen:peek',
      'popen:place',
      'popen:pickup',
      'popen:pickup',
      'popen:tremble',
      'popen:tremble',
    ]);
  });

  it('rings glass for the light drop: a touch when it is touched, a tap when it reaches the vidro', () => {
    expect(names([{ type: 'dropTouched' }, { type: 'dropTaken' }])).toEqual(['glass:touch', 'glass:tap']);
  });

  it('keeps the end of a peek silent (the design names four po-pens: 覗く・置く・拾う・震える)', () => {
    expect(cueFor({ type: 'peekEnd' })).toBeNull();
  });

  it('rings the drop and the vidro at different notes of the scale', () => {
    const touched = cueFor({ type: 'dropTouched' });
    const taken = cueFor({ type: 'dropTaken' });
    if (touched?.kind !== 'glass' || taken?.kind !== 'glass') throw new Error('expected glass cues');
    const a = glassPitch(touched.size);
    const b = glassPitch(taken.size);
    expect(isInScale(a.midi, VIDRO_SCALE) && isInScale(b.midi, VIDRO_SCALE)).toBe(true);
    expect(a.midi).not.toBe(b.midi);
  });
});

describe('where the sounds come from (HRTF)', () => {
  it('plays the vidro’s po-pens from the hand while it is held, a refusal from where the vidro stands', () => {
    const from = (e: PrologueEvent): string | undefined => cueFor(e)?.source;
    expect(from({ type: 'peekStart' })).toBe('hand');
    expect(from({ type: 'place', pedestal: 'dead-end' })).toBe('hand');
    expect(from({ type: 'pickup', from: 'bench' })).toBe('hand');
    expect(from({ type: 'pickup', from: 'pedestal' })).toBe('hand');
    // 玉が小さく震えて知らせる: the placed vidro trembles on its pedestal; the hand is empty
    expect(from({ type: 'shake', reason: 'peek' })).toBe('orb');
    expect(from({ type: 'shake', reason: 'pickup' })).toBe('orb');
    expect(from({ type: 'dropTouched' })).toBe('drop');
    expect(from({ type: 'dropTaken' })).toBe('orb');
  });

  it('finds the vidro where it is: in the hand, on the bench or on the pedestal', () => {
    const hand: Vec3 = [0.1, 1.3, -0.4];
    expect(sourcePoint('hand', 'pedestal', hand)).toEqual(hand);
    expect(sourcePoint('orb', 'pedestal', hand)).toEqual(PEDESTAL_ORB);
    expect(sourcePoint('orb', 'bench', hand)).toEqual(BENCH_ORB);
    expect(sourcePoint('orb', 'hand', hand)).toEqual(hand);
    expect(sourcePoint('drop', 'hand', hand)).toEqual(DROP);
  });
});

describe('the event names on the probes (events.ts: one naming for the room’s log and the sound’s)', () => {
  it('name an event by its type, with where a pickup came from and why a shake refused (pickup:<from>, shake:<reason>)', () => {
    expect(ALL_EVENTS.map(eventName)).toEqual([
      'peekStart',
      'peekEnd',
      'place',
      'pickup:bench',
      'pickup:pedestal',
      'shake:peek',
      'shake:pickup',
      'dropTouched',
      'dropTaken',
    ]);
  });
});

/** A stand-in for the audio engine: refuses every cue until `running` (before the first gesture). */
class FakePlayer implements CuePlayer {
  running = false;
  readonly asked: string[] = [];
  play(cue: SoundCue): { distance: number } | null {
    this.asked.push(cueName(cue));
    return this.running ? { distance: 0.5 } : null;
  }
}

describe('answering events (UI/UX設計 > 読み込み: no sound before the first gesture)', () => {
  it('logs cues refused before audio starts and never hands them to the player again', () => {
    const player = new FakePlayer();
    const log = new CueLog();
    answer({ type: 'pickup', from: 'bench' }, player, log);
    answer({ type: 'peekStart' }, player, log);
    expect(log.played).toEqual([]);
    expect(log.refused.map((r) => r.cue)).toEqual(['popen:pickup', 'popen:peek']);

    player.running = true;
    // nothing is replayed when audio starts: only what happens from now on sounds
    answer({ type: 'peekEnd' }, player, log);
    answer({ type: 'place', pedestal: 'dead-end' }, player, log);
    expect(log.played.map((p) => [p.event, p.cue])).toEqual([['place', 'popen:place']]);
    expect(player.asked).toEqual(['popen:pickup', 'popen:peek', 'popen:place']);
  });

  it('records where each played cue came from and how far from the listener', () => {
    const player = new FakePlayer();
    player.running = true;
    const log = new CueLog();
    answer({ type: 'shake', reason: 'pickup' }, player, log);
    expect(log.played).toEqual([
      { event: 'shake:pickup', cue: 'popen:tremble', source: 'orb', distance: 0.5 },
    ]);
  });

  it('keeps a bounded log but counts everything', () => {
    const player = new FakePlayer();
    player.running = true;
    const log = new CueLog(4);
    for (let i = 0; i < 10; i++) answer({ type: 'peekStart' }, player, log);
    expect(log.played).toHaveLength(4);
    expect(log.playedCount).toBe(10);
  });
});

/** Stand-ins for the browser's AudioContext and S-09's AudioEngine: they count what is made, started and closed. */
class FakeContext {
  state = 'running';
  closes = 0;
  readonly sampleRate = 48000;
  close(): Promise<void> {
    this.closes++;
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** Just enough of a running AudioContext for the footsteps and the ambience to build their nodes on. */
class FakeNode {
  readonly outputs: unknown[] = [];
  disconnected = 0;
  connect(to: unknown): unknown {
    this.outputs.push(to);
    return to;
  }
  disconnect(): void {
    this.disconnected++;
  }
}
class FakeParam {
  value = 1;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(): this {
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
  linearRampToValueAtTime(): this {
    return this;
  }
}
class FakeSource extends FakeNode {
  buffer: { tag: string; duration: number } | null = null;
  loop = false;
  readonly playbackRate = new FakeParam();
  started: number[] | null = null;
  stopped: number | null = null;
  onended: (() => void) | null = null;
  start(when: number, offset?: number): void {
    this.started = offset === undefined ? [when] : [when, offset];
  }
  stop(when: number): void {
    this.stopped = when;
  }
}
class FakeAudioCtx {
  readonly sampleRate = 48000;
  state = 'running';
  currentTime = 0;
  readonly sources: FakeSource[] = [];
  createGain(): object {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createBufferSource(): FakeSource {
    const src = new FakeSource();
    this.sources.push(src);
    return src;
  }
  createAnalyser(): object {
    return Object.assign(new FakeNode(), {
      fftSize: 2048,
      getFloatTimeDomainData: (out: Float32Array) => out.fill(0),
    });
  }
  // what the po-pens and the glass build their voices from (src/core/audio/pop.ts, glass.ts)
  createOscillator(): object {
    return Object.assign(new FakeSource(), { frequency: new FakeParam() });
  }
  createBiquadFilter(): object {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() });
  }
  createBuffer(_channels: number, length: number): object {
    const data = new Float32Array(length);
    return { duration: length / this.sampleRate, getChannelData: () => data };
  }
}

interface FakeEmitter {
  bus: string;
  position: { x: number; y: number; z: number };
  disposed: boolean;
  input: object;
}

class FakeEngine {
  readonly ctx = new FakeAudioCtx();
  readonly started: number[] = [];
  readonly emitters: FakeEmitter[] = [];
  /** The emitter each started voice played on (null = a bus). */
  readonly voiceEmitters: (FakeEmitter | null)[] = [];
  listener: { x: number; y: number; z: number } | null = null;
  disposed = 0;
  unlocks = 0;
  bound = 0;
  roomId = 'workshop';
  get room(): { id: string } {
    return { id: this.roomId };
  }
  setRoom(preset: { id: string }): void {
    this.roomId = preset.id;
  }
  createEmitter(bus = 'sfx', position = { x: 0, y: 0, z: 0 }): Emitter {
    // a PannerNode's panning model and position, as the probe reads them back from the audio graph
    const input = {
      panningModel: 'HRTF',
      positionX: { value: position.x },
      positionY: { value: position.y },
      positionZ: { value: position.z },
    };
    const rec: FakeEmitter = { bus, position: { ...position }, disposed: false, input };
    this.emitters.push(rec);
    return {
      input: input as unknown as AudioNode,
      setPosition: (p) => {
        rec.position = { x: p.x, y: p.y, z: p.z };
        input.positionX.value = p.x;
        input.positionY.value = p.y;
        input.positionZ.value = p.z;
      },
      dispose: () => {
        rec.disposed = true;
      },
    };
  }
  setListener(p: { x: number; y: number; z: number }): void {
    this.listener = { x: p.x, y: p.y, z: p.z };
  }
  bindUnlockGestures(): void {
    this.bound++;
  }
  unlock(): Promise<void> {
    this.unlocks++;
    return Promise.resolve();
  }
  now(): number {
    return this.ctx.currentTime + 0.005;
  }
  /** Voices the engine starts per request (a stand-in for a cue that would start more than one). */
  perCall = 1;
  startVoice(
    spec?: { emitter?: Emitter },
    schedule?: (ctx: BaseAudioContext, destination: AudioNode, when: number) => object,
  ): object {
    for (let i = 0; i < this.perCall; i++) this.started.push(this.started.length);
    const rec = this.emitters.find((e) => e.input === (spec?.emitter?.input as unknown)) ?? null;
    this.voiceEmitters.push(rec);
    schedule?.(
      this.ctx as unknown as BaseAudioContext,
      (spec?.emitter?.input ?? {}) as AudioNode,
      this.now(),
    );
    return { end: 1, fadeOut: () => {} };
  }
  snapshot(): object {
    return { room: this.roomId, voicesStarted: this.started.length, voicesDropped: 0 };
  }
  dispose(): Promise<void> {
    this.disposed++;
    return Promise.resolve();
  }
}

/** A room with an event bus and a camera at the player's eye (1.6 m) looking down -z, the vidro in hand. */
type FakeRoomProbe = SoundRoom['probe'];

function fakeRoom(): SoundRoom & {
  events: EventBus<PrologueEvent>;
  finale: EventBus<FinaleEvent>;
  probe: FakeRoomProbe;
} {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  return {
    events: new EventBus<PrologueEvent>(),
    finale: new EventBus<FinaleEvent>(),
    camera,
    probe: {
      orb: 'hand',
      peekAmount: 0,
      handPresence: 1,
      time: 0,
      playing: true,
      position: { x: 0, y: 0, z: 0 },
      speed: 0,
      footfalls: 0,
    },
  };
}

/** Banks that never arrive: the S-16 / S-18 tests see only the cue emitters. */
const noBanks: SoundOptions['loadBanks'] = () => new Promise<SoundBanks>(() => {});

/** The wiring with stand-ins; `activation.isActive` plays the browser's user activation. */
function rig() {
  const contexts: FakeContext[] = [];
  const engines: FakeEngine[] = [];
  const activation = { isActive: true };
  vi.stubGlobal('navigator', { userActivation: activation });
  const target = new EventTarget();
  const room = fakeRoom();
  const sound = createPrologueSound(room, {
    target,
    loadBanks: noBanks,
    makeContext: () => {
      const c = new FakeContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    makeEngine: async () => {
      const e = new FakeEngine();
      engines.push(e);
      return e as unknown as AudioEngine;
    },
  });
  const gesture = (type = 'pointerdown'): void => {
    target.dispatchEvent(new Event(type));
  };
  /** Lets the engine promise settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return { contexts, engines, activation, room, sound, gesture, settle };
}

describe('the prologue sound’s life (createPrologueSound, with stand-ins for Web Audio)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes no AudioContext before a gesture, nor on input that is not an activation (Esc)', async () => {
    const r = rig();
    r.room.events.emit({ type: 'peekStart' });
    expect(r.contexts).toHaveLength(0);
    expect(r.sound.probe.state).toBe('locked');
    r.activation.isActive = false;
    r.gesture('keydown');
    expect(r.contexts).toHaveLength(0);
    r.activation.isActive = true;
    r.gesture('pointerdown');
    r.gesture('click');
    await r.settle();
    expect(r.contexts).toHaveLength(1);
    expect(r.engines).toHaveLength(1);
    expect(r.sound.probe.unlocked).toBe(true);
    expect(r.sound.probe.state).toBe('running');
    r.sound.dispose();
  });

  it('plays only what happens once the engine is ready; what came before stays refused', async () => {
    const r = rig();
    r.room.events.emit({ type: 'pickup', from: 'bench' });
    r.gesture();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(engine.started).toHaveLength(0);
    r.room.events.emit({ type: 'peekStart' });
    r.room.events.emit({ type: 'peekEnd' });
    expect(engine.started).toHaveLength(1);
    expect(r.sound.probe.refused.map((x) => x.cue)).toEqual(['popen:pickup']);
    expect(r.sound.probe.played.map((x) => [x.event, x.source])).toEqual([['peekStart', 'hand']]);
    // the hand is about half a metre from the eye; the listener is the camera
    expect(r.sound.probe.played[0]?.distance).toBeGreaterThan(0.3);
    expect(r.sound.probe.played[0]?.distance).toBeLessThan(0.8);
    expect(engine.listener).toEqual({ x: 0, y: 1.6, z: 0 });
    r.sound.dispose();
  });

  it('left before any gesture: stops listening, so a later gesture makes nothing', () => {
    const r = rig();
    r.sound.dispose();
    r.gesture();
    expect(r.contexts).toHaveLength(0);
    expect(r.sound.probe.state).toBe('closed');
    expect(r.sound.probe.subscribed).toBe(false);
  });

  it('left while the engine is being made: the engine is disposed and the context closed once', async () => {
    const r = rig();
    r.gesture();
    r.sound.dispose();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(engine.disposed).toBe(1);
    expect(engine.emitters).toHaveLength(0);
    expect(r.contexts[0]?.closes).toBe(1);
    expect(r.sound.probe.state).toBe('closed');
  });

  it('left while playing: unsubscribes, lets go of the emitters and the engine, closes the context', async () => {
    const r = rig();
    r.gesture();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(r.sound.probe.emitters).toBe(3);
    r.sound.dispose();
    await r.settle();
    r.room.events.emit({ type: 'peekStart' });
    expect(engine.started).toHaveLength(0);
    expect(engine.emitters.every((e) => e.disposed)).toBe(true);
    expect(engine.disposed).toBe(1);
    expect(r.contexts[0]?.closes).toBe(1);
    expect(r.sound.probe.emitters).toBe(0);
    expect(r.sound.probe.subscribed).toBe(false);
  });

  it('on its own engine (direct mode), it starts it and resumes it on later gestures itself', async () => {
    const r = rig();
    expect(r.sound.probe.shared).toBe(false);
    r.gesture();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    expect(engine.unlocks).toBe(1);
    expect(engine.bound).toBe(1);
    r.sound.dispose();
  });
});

/**
 * The room's sound on an engine someone else owns (S-18): in the home path the loading screen's 「はじめる」 starts
 * one AudioEngine (src/ui/audio-gate.ts) and the room plays through it. `start()` plays the owner handing it over.
 */
function sharedRig() {
  const contexts: FakeContext[] = [];
  const made: FakeEngine[] = [];
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  const target = new EventTarget();
  const room = fakeRoom();
  const engine = new FakeEngine();
  const waiting = new Set<(e: AudioEngine) => void>();
  const shared = {
    whenReady(ready: (e: AudioEngine) => void): () => void {
      waiting.add(ready);
      return () => waiting.delete(ready);
    },
  };
  const sound = createPrologueSound(room, {
    target,
    shared,
    loadBanks: noBanks,
    makeContext: () => {
      const c = new FakeContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    makeEngine: async () => {
      const e = new FakeEngine();
      made.push(e);
      return e as unknown as AudioEngine;
    },
  });
  const start = (): void => {
    for (const ready of [...waiting]) ready(engine as unknown as AudioEngine);
    waiting.clear();
  };
  const gesture = (type = 'pointerdown'): void => {
    target.dispatchEvent(new Event(type));
  };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return { contexts, made, engine, waiting, room, sound, start, gesture, settle };
}

describe('the prologue sound on a shared engine (ホーム経由, S-18: one AudioContext)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes no AudioContext or engine of its own, even on a gesture; plays through the shared one once it starts', async () => {
    const r = sharedRig();
    expect(r.sound.probe.shared).toBe(true);
    r.gesture('pointerdown');
    r.gesture('click');
    await r.settle();
    expect(r.contexts).toHaveLength(0);
    expect(r.made).toHaveLength(0);
    expect(r.sound.probe.state).toBe('locked');
    expect(r.sound.probe.unlocked).toBe(false);
    // before the owner started it: refused, never played later (溜めて後から鳴らさない)
    r.room.events.emit({ type: 'pickup', from: 'bench' });
    r.start();
    expect(r.sound.probe.unlocked).toBe(true);
    expect(r.sound.probe.state).toBe('running');
    expect(r.sound.probe.emitters).toBe(3);
    expect(r.engine.started).toHaveLength(0);
    r.room.events.emit({ type: 'peekStart' });
    expect(r.engine.started).toHaveLength(1);
    expect(r.sound.probe.refused.map((x) => x.cue)).toEqual(['popen:pickup']);
    expect(r.sound.probe.played.map((x) => [x.event, x.source])).toEqual([['peekStart', 'hand']]);
    expect(r.engine.listener).toEqual({ x: 0, y: 1.6, z: 0 });
    // starting and resuming it is its owner's (the press of 「はじめる」)
    expect(r.engine.unlocks).toBe(0);
    expect(r.engine.bound).toBe(0);
    r.sound.dispose();
  });

  it('counts the voices the engine started for its cues, not the UI’s on the same engine', () => {
    const r = sharedRig();
    r.start();
    r.engine.startVoice();
    r.engine.startVoice();
    r.room.events.emit({ type: 'peekStart' });
    expect(r.engine.started).toHaveLength(3);
    expect(r.sound.probe.voicesStarted).toBe(1);
    expect(r.sound.probe.playedCount).toBe(1);
    // the count is the engine's, not a copy of what was logged as played
    r.engine.perCall = 2;
    r.room.events.emit({ type: 'place', pedestal: 'dead-end' });
    expect(r.sound.probe.voicesStarted).toBe(3);
    expect(r.sound.probe.playedCount).toBe(2);
    r.sound.dispose();
  });

  it('on its own engine too, counts the voices for its cues; the engine’s whole count is engineVoices (S-22: the steps play there as well)', async () => {
    const r = rig();
    r.gesture();
    await r.settle();
    const engine = r.engines[0] as FakeEngine;
    engine.startVoice();
    r.room.events.emit({ type: 'peekStart' });
    expect(r.sound.probe.voicesStarted).toBe(1);
    expect(r.sound.probe.playedCount).toBe(1);
    expect(r.sound.probe.engineVoices).toBe(2);
    r.sound.dispose();
  });

  it('keeps the workshop’s reverb (src/audio/rooms.ts) on a shared engine set to another room', () => {
    const r = sharedRig();
    r.engine.roomId = 'dome';
    r.start();
    expect(r.engine.roomId).toBe('workshop');
    expect(r.sound.probe.room).toBe('workshop');
    r.sound.dispose();
  });

  it('left: lets go of its emitters and stops waiting, but leaves the shared engine and its context to their owner', async () => {
    const r = sharedRig();
    r.start();
    expect(r.engine.emitters).toHaveLength(3);
    r.sound.dispose();
    await r.settle();
    expect(r.engine.emitters.every((e) => e.disposed)).toBe(true);
    expect(r.engine.disposed).toBe(0);
    expect(r.sound.probe.emitters).toBe(0);
    expect(r.sound.probe.subscribed).toBe(false);
    r.room.events.emit({ type: 'peekStart' });
    expect(r.engine.started).toHaveLength(0);

    // left before the owner started it: no longer waiting, and a late hand-over makes nothing
    const early = sharedRig();
    expect(early.waiting.size).toBe(1);
    const late = [...early.waiting][0];
    early.sound.dispose();
    expect(early.waiting.size).toBe(0);
    late?.(early.engine as unknown as AudioEngine);
    expect(early.engine.emitters).toHaveLength(0);
    expect(early.sound.probe.state).toBe('closed');
  });
});

/* ---------- S-22: footsteps and the workshop's ambience ---------- */

const fakeBuffer = (tag: string, duration: number) => ({ tag, duration }) as unknown as AudioBuffer;
const fakeBanks = (): SoundBanks => ({
  footsteps: {
    stone: Array.from({ length: 8 }, (_, v) => fakeBuffer(`stone${v}`, 0.3)),
    frosted: Array.from({ length: 8 }, (_, v) => fakeBuffer(`frosted${v}`, 0.4)),
    brass: Array.from({ length: 8 }, (_, v) => fakeBuffer(`brass${v}`, 0.4)),
  },
  ambience: {
    wind: fakeBuffer('wind', 8),
    fire: fakeBuffer('fire', 7),
    chimes: Array.from({ length: 5 }, (_, v) => fakeBuffer(`chime${v}`, 2.8)),
    doorChime: Array.from({ length: 4 }, (_, v) => fakeBuffer(`door${v}`, 1.6)),
    drops: Array.from({ length: 8 }, (_, v) => fakeBuffer(`drop${v}`, 0.25)),
  },
});

/** The room's sound with banks that arrive at once; `shared` plays it on an engine handed over (S-18). */
function soundscapeRig(shared = false, banks: () => SoundBanks = fakeBanks) {
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  const target = new EventTarget();
  const room = fakeRoom();
  room.probe.position = { x: SPAWNS.bench.feet[0], y: 0, z: SPAWNS.bench.feet[2] };
  const engine = new FakeEngine();
  const waiting = new Set<(e: AudioEngine) => void>();
  const loads: (AbortSignal | undefined)[] = [];
  const sound = createPrologueSound(room, {
    target,
    loadBanks: async (_ctx, signal) => {
      loads.push(signal);
      return banks();
    },
    makeContext: () => new FakeContext() as unknown as AudioContext,
    makeEngine: async () => engine as unknown as AudioEngine,
    ...(shared
      ? {
          shared: {
            whenReady(ready: (e: AudioEngine) => void): () => void {
              waiting.add(ready);
              return () => waiting.delete(ready);
            },
          },
        }
      : {}),
  });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const begin = async (): Promise<void> => {
    if (shared) for (const ready of [...waiting]) ready(engine as unknown as AudioEngine);
    else target.dispatchEvent(new Event('pointerdown'));
    await settle();
    await settle();
  };
  /** One frame: the room moved the body (and counted its footfalls), then the sound follows. */
  const frame = (dt = 1 / 60): void => {
    room.probe.time += dt;
    engine.ctx.currentTime += dt;
    sound.update();
  };
  const stepTo = (x: number, z: number): void => {
    room.probe.position = { x, y: 0, z };
    room.probe.speed = 1.4;
    room.probe.footfalls++;
    frame();
  };
  return { room, engine, sound, begin, frame, stepTo, settle, loads };
}

const loops = (e: FakeEngine) => e.ctx.sources.filter((s) => s.loop);
const tagOf = (src: FakeSource | undefined): string => src?.buffer?.tag ?? '';

describe('footsteps in the room (S-22: 歩くと歩幅に合わせて足元から、床の材質ごとに)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a footfall plays one step, from the feet, chosen for the floor under them', async () => {
    const r = soundscapeRig();
    await r.begin();
    r.frame();
    expect(r.sound.probe.footsteps.count).toBe(0);
    const before = r.engine.started.length;

    // in the workshop: frosted glass
    r.stepTo(-1.4, -1.5);
    expect(r.engine.started.length).toBe(before + 1);
    const feet = r.engine.voiceEmitters.at(-1);
    expect(feet?.bus, 'footsteps are ambience (設計書: 環境音の節)').toBe('ambience');
    expect(feet?.position).toEqual({ x: -1.4, y: 0, z: -1.5 });
    expect(tagOf(r.engine.ctx.sources.at(-1)).startsWith('frosted')).toBe(true);
    // out on the way: stone
    r.stepTo(0, -8);
    expect(tagOf(r.engine.ctx.sources.at(-1)).startsWith('stone')).toBe(true);

    const log = r.sound.probe.footsteps.log;
    expect(log.map((e) => [e.material, e.zone])).toEqual([
      ['frosted', 'workshop'],
      ['stone', 'path'],
    ]);
    expect(log[0]?.x).toBe(-1.4);
    expect(log[0]?.z).toBe(-1.5);
    // the listener is the camera at 1.6 m, the feet below it
    expect(log[0]?.distance).toBeGreaterThan(1.5);
    expect(r.sound.probe.footsteps.count).toBe(2);
    r.sound.dispose();
  });

  it('never plays the same step twice running on one floor', async () => {
    const r = soundscapeRig();
    await r.begin();
    r.frame();
    for (let i = 0; i < 60; i++) r.stepTo(0, -6 - i * 0.05);
    const tags = r.engine.ctx.sources.filter((s) => !s.loop && tagOf(s).startsWith('stone')).map(tagOf);
    expect(tags).toHaveLength(60);
    for (let i = 1; i < tags.length; i++) expect(tags[i]).not.toBe(tags[i - 1]);
    expect(new Set(tags).size).toBe(8);
    r.sound.dispose();
  });

  it('footfalls from before the sound started are not played when it starts (溜めて後から鳴らさない)', async () => {
    const r = soundscapeRig();
    r.room.probe.footfalls = 5;
    r.frame();
    await r.begin();
    r.frame();
    r.frame();
    expect(r.sound.probe.footsteps.count).toBe(0);
    r.stepTo(-1.4, -1.5);
    expect(r.sound.probe.footsteps.count).toBe(1);
    r.sound.dispose();
  });

  it('a long frame that held two footfalls plays one step and counts the other as skipped', async () => {
    const r = soundscapeRig();
    await r.begin();
    r.frame();
    r.room.probe.footfalls += 2;
    r.room.probe.position = { x: 0, y: 0, z: -8 };
    r.frame();
    const f = r.sound.probe.footsteps;
    expect(f.count).toBe(1);
    expect(f.skipped).toBe(1);
    expect(f.count + f.refused + f.skipped + f.missing).toBe(r.room.probe.footfalls - (f.since ?? 0));
    r.sound.dispose();
  });

  it('a floor none of whose sounds could be loaded stays silent, counted as missing (not as refused by the engine)', async () => {
    const r = soundscapeRig(false, () => {
      const b = fakeBanks();
      return { ...b, footsteps: { ...b.footsteps, stone: b.footsteps.stone.map(() => null) } };
    });
    await r.begin();
    r.frame();
    const before = r.engine.started.length;
    r.stepTo(0, -8);
    expect(r.engine.started.length).toBe(before);
    expect(r.sound.probe.footsteps.missing).toBe(1);
    expect(r.sound.probe.footsteps.refused).toBe(0);
    // the glass floor still sounds
    r.stepTo(-1.4, -1.5);
    expect(r.sound.probe.footsteps.count).toBe(1);
    r.sound.dispose();
  });

  it('left while its sounds are still being made, it stops making them', async () => {
    const r = soundscapeRig();
    r.room.events.emit({ type: 'peekStart' });
    r.sound.dispose();
    expect(r.loads).toHaveLength(0);
    const s = soundscapeRig();
    await s.begin();
    expect(s.loads).toHaveLength(1);
    expect(s.loads[0]?.aborted).toBe(false);
    s.sound.dispose();
    expect(s.loads[0]?.aborted).toBe(true);
  });

  it('counts its steps on their own: the cue count stays the cues’ (S-16 / S-18 probes unchanged)', async () => {
    const r = soundscapeRig(true);
    await r.begin();
    r.frame();
    r.stepTo(-1.4, -1.5);
    r.stepTo(-1.4, -2.2);
    r.room.events.emit({ type: 'peekStart' });
    expect(r.sound.probe.voicesStarted).toBe(1);
    expect(r.sound.probe.playedCount).toBe(1);
    expect(r.sound.probe.footsteps.voicesStarted).toBe(2);
    expect(r.sound.probe.engineVoices).toBe(3);
    r.sound.dispose();
  });
});

describe('the workshop’s ambience (S-22: 風・遠くの風鈴・水滴を立体的に)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is placed in the room: wind at the dome’s gaps, the chimes far off beyond the gate, drops in a few places', () => {
    const kinds = PROLOGUE_AMBIENCE.map((p) => p.kind);
    expect(kinds.filter((k) => k === 'wind').length).toBeGreaterThanOrEqual(2);
    // the far chimes in the town (S-22) and, since S-25, the one above the door
    expect(kinds.filter((k) => k === 'chimes')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'drops').length).toBeGreaterThanOrEqual(3);
    const top = WORKSHOP.sphereCenterY + WORKSHOP.radius;
    const skylight = PROLOGUE_AMBIENCE.find((p) => p.id === 'wind:skylight');
    const door = PROLOGUE_AMBIENCE.find((p) => p.id === 'wind:door');
    expect(Math.hypot(skylight?.position[0] ?? 9, skylight?.position[2] ?? 9)).toBeLessThan(WORKSHOP.oculus);
    expect(skylight?.position[1]).toBeGreaterThan(top - 0.5);
    expect(Math.abs((door?.position[2] ?? 0) + WORKSHOP_FLOOR_RADIUS)).toBeLessThan(0.3);
    const chimes = PROLOGUE_AMBIENCE.find((p) => p.id === 'chimes:town');
    expect(chimes?.kind).toBe('chimes');
    expect(chimes?.position[2]).toBeLessThan(GATE.z - 3);
    // 遠く: from the bench where the dive lands, the chimes are far away
    const [bx, , bz] = SPAWNS.bench.feet;
    expect(Math.hypot((chimes?.position[0] ?? 0) - bx, (chimes?.position[2] ?? 0) - bz)).toBeGreaterThan(20);
    for (const p of PROLOGUE_AMBIENCE.filter((q) => q.kind === 'drops'))
      expect(p.notes?.length).toBeGreaterThan(0);
  });

  it('waits for the room to be played, then starts: the wind’s loops on the ambience bus, from where they are placed', async () => {
    const r = soundscapeRig(true);
    r.room.probe.playing = false;
    await r.begin();
    r.frame();
    // the home screen and the dive: the engine is there, the workshop is not yet
    expect(r.sound.probe.ambience.ready).toBe(true);
    expect(r.sound.probe.ambience.playing).toBe(false);
    expect(loops(r.engine)).toHaveLength(0);
    r.room.probe.playing = true;
    r.frame();
    expect(r.sound.probe.ambience.playing).toBe(true);
    // the wind's and (S-25) the furnace's
    expect(loops(r.engine)).toHaveLength(
      PROLOGUE_AMBIENCE.filter((p) => p.kind === 'wind' || p.kind === 'fire').length,
    );
    const ambient = r.engine.emitters.filter((e) => e.bus === 'ambience');
    for (const place of PROLOGUE_AMBIENCE) {
      const [x, y, z] = place.position;
      expect(
        ambient.some((e) => e.position.x === x && e.position.y === y && e.position.z === z),
        place.id,
      ).toBe(true);
    }
    // chimes and drops come in time; the cue probe does not count them
    for (let i = 0; i < 60 * 30; i++) r.frame();
    const plays = r.sound.probe.ambience.sources;
    expect(plays.find((s) => s.kind === 'chimes')?.plays).toBeGreaterThan(0);
    expect(plays.filter((s) => s.kind === 'drops').reduce((n, s) => n + s.plays, 0)).toBeGreaterThan(0);
    expect(r.sound.probe.voicesStarted).toBe(0);
    r.sound.dispose();
  });

  it('nothing at all before the first gesture: no engine, no banks, no ambience', () => {
    const r = soundscapeRig();
    r.frame();
    expect(r.sound.probe.ambience.ready).toBe(false);
    expect(r.sound.probe.ambience.playing).toBe(false);
    expect(r.engine.emitters).toHaveLength(0);
    r.sound.dispose();
  });

  it('leaving stops the loops and lets go of every emitter it placed', async () => {
    const r = soundscapeRig();
    await r.begin();
    r.frame();
    expect(r.sound.probe.ambience.playing).toBe(true);
    // the cue emitters (3), the feet (1) and the ambience's places
    expect(r.sound.probe.emitters).toBe(4 + PROLOGUE_AMBIENCE.length);
    r.sound.dispose();
    await r.settle();
    for (const l of loops(r.engine)) expect(l.stopped).not.toBeNull();
    expect(r.engine.emitters.every((e) => e.disposed)).toBe(true);
    expect(r.sound.probe.emitters).toBe(0);
    expect(r.sound.probe.ambience.playing).toBe(false);
  });
});

describe('the workshop’s own sounds where S-24 drew them (S-25: 炉の燃える音、水桶の雫、扉の上の風鈴)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const spot = (id: string) => PROLOGUE_AMBIENCE.find((p) => p.id === id);

  it('the furnace burns in its mouth, a drop falls into the tub, the chime hangs above the door and the door’s draught rings it', () => {
    expect(spot('fire:furnace')).toMatchObject({ kind: 'fire', position: FURNACE_MOUTH });
    expect(spot('drops:tub')).toMatchObject({ kind: 'drops', position: TUB_DRIP });
    expect(spot('chimes:door')).toMatchObject({
      kind: 'chimes',
      bells: 'door',
      draught: 'wind:door',
      position: WIND_CHIME,
    });
    expect(spot('wind:door')?.kind).toBe('wind');
    // the far chimes ring their own bells (S-22)
    expect(spot('chimes:town')?.bells ?? 'town').toBe('town');
    // into water: the deeper drops (D5 … A5)
    expect(spot('drops:tub')?.notes).toEqual([0, 1, 2, 3]);
    // S-22's drop over the brass grate, where nothing was drawn to catch it, is gone
    for (const p of PROLOGUE_AMBIENCE.filter((q) => q.kind === 'drops'))
      expect(floorAt(p.position[0], p.position[2]).zone, p.id).not.toBe('grate');
    // one place each
    expect(new Set(PROLOGUE_AMBIENCE.map((p) => p.id)).size).toBe(PROLOGUE_AMBIENCE.length);
  });

  it('plays them on the ambience bus from there, the furnace as a loop; the probe reads each place back from its panner', async () => {
    const r = soundscapeRig();
    await r.begin();
    r.frame();
    expect(loops(r.engine).map(tagOf).sort()).toEqual(
      PROLOGUE_AMBIENCE.filter((p) => p.kind === 'wind' || p.kind === 'fire')
        .map((p) => (p.kind === 'fire' ? 'fire' : 'wind'))
        .sort(),
    );
    const places = r.sound.probe.ambience.places;
    expect(places.map((p) => p.id)).toEqual(PROLOGUE_AMBIENCE.map((p) => p.id));
    for (const s of PROLOGUE_AMBIENCE) {
      const p = places.find((q) => q.id === s.id);
      expect(p?.kind, s.id).toBe(s.kind);
      expect(p?.position, s.id).toEqual([...s.position]);
      expect(p?.panning, s.id).toBe('HRTF');
    }
    // the chime above the door rings in time, in a draught, from its own place
    for (let i = 0; i < 60 * 30; i++) r.frame();
    const a = r.sound.probe.ambience;
    expect(a.sources.find((s) => s.id === 'chimes:door')?.plays).toBeGreaterThan(0);
    expect(a.draughts.length).toBeGreaterThan(0);
    const door = a.hits.filter((h) => h.id === 'chimes:door');
    expect(door.length).toBeGreaterThan(0);
    for (const h of door) expect(a.draughts.some((d) => h.at >= d.at && h.at <= d.held)).toBe(true);
    expect(r.sound.probe.voicesStarted).toBe(0);
    r.sound.dispose();
  });

  it('before the sounds are loaded the probe has no places, no hits, no draughts', () => {
    const r = soundscapeRig();
    r.frame();
    const a = r.sound.probe.ambience;
    expect(a.places).toEqual([]);
    expect(a.hits).toEqual([]);
    expect(a.draughts).toEqual([]);
    r.sound.dispose();
  });
});

/* ---------- S-34: the close — the bridge settling, the gate opening ---------- */

describe('the close of the prologue sounds (S-34: 橋が定着する音、門が開く音)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const withClose = (): SoundBanks => ({
    ...fakeBanks(),
    finale: { settle: fakeBuffer('settle', 3.4), gate: fakeBuffer('gate', 3.6) },
  });
  /** The voice the engine started last, and the buffer it plays. */
  const lastVoice = (r: ReturnType<typeof soundscapeRig>) => ({
    emitter: r.engine.voiceEmitters.at(-1),
    tag: tagOf(r.engine.ctx.sources.at(-1)),
  });

  it('the light settling the bridge sounds once, from the light, and follows it across', async () => {
    const r = soundscapeRig(false, withClose);
    await r.begin();
    r.frame();
    const before = r.engine.started.length;
    // as in the room: the light starts inside the session's step, before the room has drawn (and published) its front
    r.room.probe.finale = { frontZ: null };
    r.room.finale.emit({ type: 'settle' });
    expect(r.engine.started.length).toBe(before + 1);
    const v = lastVoice(r);
    expect(v.tag).toBe('settle');
    expect(v.emitter?.bus).toBe('sfx');
    // where the light starts: the dead end's side of what it settles
    const [start] = sweepSpan(BRIDGE_SETTLE);
    expect(v.emitter?.position.z).toBeCloseTo(start / BRIDGE_SETTLE.direction[2], 6);
    expect(v.emitter?.position.z).toBeGreaterThan(EDGE_Z - 0.1);
    expect(Math.abs(v.emitter?.position.x ?? 9)).toBeLessThan(0.5);
    // the sound goes with the light over the bridge
    r.room.probe.finale = { frontZ: -16 };
    r.frame();
    expect(v.emitter?.position.z).toBeCloseTo(-16, 6);
    const f = r.sound.probe.finale;
    expect(f.played.map((p) => p.event)).toEqual(['settle']);
    expect(f.voicesStarted).toBe(1);
    r.sound.dispose();
  });

  it('the gate opening sounds once, from the gate', async () => {
    const r = soundscapeRig(false, withClose);
    await r.begin();
    r.frame();
    r.room.finale.emit({ type: 'gateOpen' });
    const v = lastVoice(r);
    expect(v.tag).toBe('gate');
    expect(v.emitter?.position.z).toBeCloseTo(GATE.z, 6);
    expect(v.emitter?.position.y).toBeGreaterThan(0.5);
    expect(v.emitter?.position.y).toBeLessThan(GATE.height);
    expect(r.sound.probe.finale.played.map((p) => p.event)).toEqual(['gateOpen']);
    r.sound.dispose();
  });

  it('the light across and the gate open are silent (one sound each, when they start)', async () => {
    const r = soundscapeRig(false, withClose);
    await r.begin();
    r.frame();
    const before = r.engine.started.length;
    r.room.finale.emit({ type: 'settled' });
    r.room.finale.emit({ type: 'gateOpened' });
    expect(r.engine.started.length).toBe(before);
    expect(r.sound.probe.finale.played).toEqual([]);
    r.sound.dispose();
  });

  it('is counted on its own: the cues stay the S-16 table’s, the engine’s whole count takes it in', async () => {
    const r = soundscapeRig(false, withClose);
    await r.begin();
    r.frame();
    r.room.events.emit({ type: 'dropTaken' });
    r.room.finale.emit({ type: 'settle' });
    r.room.finale.emit({ type: 'gateOpen' });
    const p = r.sound.probe;
    expect(p.playedCount).toBe(1);
    expect(p.voicesStarted).toBe(1);
    expect(p.finale.voicesStarted).toBe(2);
    expect(p.engineVoices).toBe(p.voicesStarted + p.footsteps.voicesStarted + p.finale.voicesStarted);
    r.sound.dispose();
  });

  it('before the audio (or its sounds) are there, the close is refused, and never played later', async () => {
    const r = soundscapeRig(false, withClose);
    r.room.finale.emit({ type: 'settle' });
    expect(r.sound.probe.finale.refused).toEqual(['settle']);
    await r.begin();
    for (let i = 0; i < 30; i++) r.frame();
    expect(r.sound.probe.finale.played).toEqual([]);
    expect(r.sound.probe.finale.voicesStarted).toBe(0);
    r.sound.dispose();
  });

  it('with no close sounds loaded (an older bank, a failed render), it stays silent and says so', async () => {
    const r = soundscapeRig();
    await r.begin();
    r.frame();
    r.room.finale.emit({ type: 'gateOpen' });
    expect(r.sound.probe.finale.ready).toBe(false);
    expect(r.sound.probe.finale.refused).toEqual(['gateOpen']);
    r.sound.dispose();
  });
});
