import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../layers/footing';
import type { PrologueEvent } from './events';
import { BENCH_ORB, DROP, PEDESTAL_ORB } from './layout';
import {
  answer,
  CueLog,
  type CuePlayer,
  cueFor,
  cueName,
  eventName,
  type SoundCue,
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

  it('gives the drop and the vidro a size, so their glass rings at different notes', () => {
    const touched = cueFor({ type: 'dropTouched' });
    const taken = cueFor({ type: 'dropTaken' });
    if (touched?.kind !== 'glass' || taken?.kind !== 'glass') throw new Error('expected glass cues');
    expect(touched.size).toBeGreaterThan(0.05);
    expect(taken.size).toBeGreaterThan(0.05);
    expect(touched.size).not.toBe(taken.size);
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
