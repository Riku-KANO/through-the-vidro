import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { glassPitch, VIDRO_SCALE } from '../../audio/tuning';
import type { AudioEngine, Emitter } from '../../core/audio/engine';
import { isInScale } from '../../core/audio/scale';
import type { Vec3 } from '../../layers/footing';
import { EventBus, type PrologueEvent } from './events';
import { BENCH_ORB, DROP, PEDESTAL_ORB } from './layout';
import {
  answer,
  CueLog,
  type CuePlayer,
  createPrologueSound,
  cueFor,
  cueName,
  eventName,
  type SoundCue,
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

describe('the event names on the probe', () => {
  it('match the room probe’s event log (pickup:<from>, shake:<reason>, else the type)', () => {
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

class FakeEngine {
  readonly ctx = { sampleRate: 48000 };
  readonly started: number[] = [];
  readonly emitters: { disposed: boolean }[] = [];
  listener: { x: number; y: number; z: number } | null = null;
  disposed = 0;
  createEmitter(): Emitter {
    const rec = { disposed: false };
    this.emitters.push(rec);
    return {
      input: { panningModel: 'HRTF' } as unknown as AudioNode,
      setPosition: () => {},
      dispose: () => {
        rec.disposed = true;
      },
    };
  }
  setListener(p: { x: number; y: number; z: number }): void {
    this.listener = { x: p.x, y: p.y, z: p.z };
  }
  bindUnlockGestures(): void {}
  unlock(): Promise<void> {
    return Promise.resolve();
  }
  startVoice(): object {
    this.started.push(this.started.length);
    return { end: 1, fadeOut: () => {} };
  }
  snapshot(): object {
    return { room: 'workshop', voicesStarted: this.started.length, voicesDropped: 0 };
  }
  dispose(): Promise<void> {
    this.disposed++;
    return Promise.resolve();
  }
}

/** A room with an event bus and a camera at the player's eye (1.6 m) looking down -z, the vidro in hand. */
function fakeRoom(): SoundRoom & { events: EventBus<PrologueEvent> } {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  return {
    events: new EventBus<PrologueEvent>(),
    camera,
    probe: { orb: 'hand', peekAmount: 0, handPresence: 1, time: 0 },
  };
}

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
});
