import { describe, expect, it } from 'vitest';
import { decayT60, estimatePitch, peak, rms } from '../core/audio/analysis';
import { mulberry32 } from '../core/audio/rng';
import { isInScale, midiToHz } from '../core/audio/scale';
import {
  AMBIENCE,
  type AmbienceBanks,
  type AmbiencePlace,
  AmbiencePlayer,
  CHIME_NOTES,
  CHIME_SOURCES,
  DROP_NOTES,
  DROP_SOURCES,
  nextGap,
  planChimeRing,
  planDrip,
  renderChime,
  renderDrop,
  renderWind,
  WIND_LOOP_SECONDS,
  WIND_SOURCE,
} from './ambience';
import { VIDRO_SCALE } from './tuning';

const SR = 44100;
const at = (s: number): number => Math.round(s * SR);

describe('遠くの風鈴 (サウンドデザイン > 環境音, 音階の統一)', () => {
  it('hangs five glass bells, one on each note of D major pentatonic', () => {
    expect(CHIME_NOTES).toHaveLength(5);
    expect(new Set(CHIME_NOTES.map((m) => m % 12))).toEqual(new Set([2, 4, 6, 9, 11]));
    for (const m of CHIME_NOTES) expect(isInScale(m, VIDRO_SCALE)).toBe(true);
    expect(CHIME_SOURCES).toHaveLength(5);
  });

  it('each bell rings on its note (fundamental within ±3 %) and keeps ringing like a furin', () => {
    for (const midi of CHIME_NOTES) {
      const x = renderChime(midi, SR);
      const hz = estimatePitch(x, SR, { start: 0.05, duration: 0.6 });
      expect(Math.abs((hz as number) / midiToHz(midi) - 1), `chime ${midi}`).toBeLessThan(0.03);
      expect(peak(x)).toBeLessThanOrEqual(1);
      expect(decayT60(x, SR) as number, `chime ${midi}`).toBeGreaterThan(1.2);
      expect(rms(x, x.length - at(0.01))).toBeLessThan(2e-3);
    }
  });

  it('a gust rings one to four strikes, the first at once, each a little softer, on the bells there are', () => {
    const rng = mulberry32(3);
    const counts = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const ring = planChimeRing(rng, 10);
      counts.add(ring.length);
      expect(ring.length).toBeGreaterThanOrEqual(AMBIENCE.chimes.strikes[0]);
      expect(ring.length).toBeLessThanOrEqual(AMBIENCE.chimes.strikes[1]);
      expect(ring[0]?.at).toBe(10);
      for (let k = 1; k < ring.length; k++) {
        const gap = (ring[k]?.at as number) - (ring[k - 1]?.at as number);
        expect(gap).toBeGreaterThanOrEqual(AMBIENCE.chimes.spacing[0]);
        expect(gap).toBeLessThanOrEqual(AMBIENCE.chimes.spacing[1]);
        expect(ring[k]?.gain).toBeLessThanOrEqual(ring[k - 1]?.gain as number);
      }
      for (const h of ring) {
        expect(h.index).toBeGreaterThanOrEqual(0);
        expect(h.index).toBeLessThan(CHIME_NOTES.length);
        expect(h.gain).toBeGreaterThan(0);
        expect(h.gain).toBeLessThanOrEqual(1);
      }
    }
    expect(counts.size).toBeGreaterThan(2);
  });
});

describe('水滴 (数か所から間欠に)', () => {
  it('has eight drops on the scale, each a short plink that settles on its note', () => {
    expect(DROP_NOTES).toHaveLength(8);
    expect(DROP_SOURCES).toHaveLength(8);
    DROP_NOTES.forEach((midi, v) => {
      expect(isInScale(midi, VIDRO_SCALE)).toBe(true);
      const x = renderDrop(midi, v, SR);
      expect(x.length / SR).toBeLessThanOrEqual(0.4);
      expect(peak(x)).toBeLessThanOrEqual(1);
      expect(rms(x, 0, at(0.08))).toBeGreaterThan(0.03);
      const hz = estimatePitch(x, SR, { start: 0.03, duration: 0.08, minHz: 300 });
      expect(Math.abs((hz as number) / midiToHz(midi) - 1), `drop ${midi}`).toBeLessThan(0.03);
      expect(rms(x, x.length - at(0.005))).toBeLessThan(2e-3);
    });
  });

  it('drips once or twice, only on the notes of its place', () => {
    const rng = mulberry32(5);
    const notes = [1, 2, 3];
    const sizes = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const drip = planDrip(rng, 4, notes);
      sizes.add(drip.length);
      expect(drip[0]?.at).toBe(4);
      for (const h of drip) expect(notes).toContain(h.index);
    }
    expect(sizes).toEqual(new Set([1, 2]));
  });

  it('waits a while between gusts and drips, within its range', () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 500; i++) {
      const g = nextGap(rng, AMBIENCE.drops.gap);
      expect(g).toBeGreaterThanOrEqual(AMBIENCE.drops.gap[0]);
      expect(g).toBeLessThanOrEqual(AMBIENCE.drops.gap[1]);
    }
  });
});

describe('ガラスの隙間を抜ける風 (持続)', () => {
  const wind = renderWind(SR);

  it('is a loop of a few seconds, the same every time it is made', () => {
    expect(wind.length).toBe(Math.round(WIND_LOOP_SECONDS * SR));
    expect(WIND_SOURCE.kind).toBe('synth');
    expect(Array.from(renderWind(SR).subarray(0, 64))).toEqual(Array.from(wind.subarray(0, 64)));
  });

  it('loops without a seam: its end runs into its start like any two neighbouring samples', () => {
    const steps: number[] = [];
    for (let i = 1; i < wind.length; i++) steps.push(Math.abs((wind[i] as number) - (wind[i - 1] as number)));
    steps.sort((a, b) => a - b);
    const p999 = steps[Math.floor(steps.length * 0.999)] as number;
    expect(Math.abs((wind[0] as number) - (wind[wind.length - 1] as number))).toBeLessThanOrEqual(p999);
  });

  it('breathes in gusts but never stops (a sustained bed, not a series of whooshes)', () => {
    const levels: number[] = [];
    for (let t = 0; t + 0.5 <= WIND_LOOP_SECONDS; t += 0.5) levels.push(rms(wind, at(t), at(t + 0.5)));
    const max = Math.max(...levels);
    const min = Math.min(...levels);
    expect(max).toBeGreaterThan(0.05);
    expect(max / min).toBeGreaterThan(1.4);
    expect(min / max).toBeGreaterThan(0.25);
    expect(peak(wind)).toBeLessThanOrEqual(1);
  });
});

/* ---------- The player, on a stand-in AudioContext ---------- */

class Param {
  value = 1;
  readonly calls: [string, number, number][] = [];
  setValueAtTime(v: number, t: number): this {
    this.calls.push(['set', v, t]);
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number): this {
    this.calls.push(['target', v, t]);
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.calls.push(['cancel', 0, t]);
    return this;
  }
}

class Node {
  readonly outputs: Node[] = [];
  disconnected = 0;
  connect(to: Node): Node {
    this.outputs.push(to);
    return to;
  }
  disconnect(): void {
    this.disconnected++;
  }
}

class Gain extends Node {
  readonly gain = new Param();
}

class Source extends Node {
  buffer: { duration: number; tag: string } | null = null;
  loop = false;
  readonly playbackRate = new Param();
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

class Analyser extends Node {
  fftSize = 2048;
  level = 0;
  getFloatTimeDomainData(out: Float32Array): void {
    out.fill(this.level);
  }
}

class Ctx {
  currentTime = 0;
  state = 'running';
  readonly sampleRate = 48000;
  readonly sources: Source[] = [];
  readonly analysers: Analyser[] = [];
  readonly gains: Gain[] = [];
  createGain(): Gain {
    const g = new Gain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): Source {
    const s = new Source();
    this.sources.push(s);
    return s;
  }
  createAnalyser(): Analyser {
    const a = new Analyser();
    this.analysers.push(a);
    return a;
  }
}

const buf = (tag: string, duration: number): AudioBuffer => ({ tag, duration }) as unknown as AudioBuffer;

function rigPlayer(banks?: Partial<AmbienceBanks>) {
  const ctx = new Ctx();
  const inputs = { wind1: new Node(), wind2: new Node(), chimes: new Node(), drops: new Node() };
  const places: AmbiencePlace[] = [
    { id: 'wind:a', kind: 'wind', input: inputs.wind1 as unknown as AudioNode, offset: 0 },
    {
      id: 'wind:b',
      kind: 'wind',
      input: inputs.wind2 as unknown as AudioNode,
      offset: WIND_LOOP_SECONDS / 2,
    },
    { id: 'chimes', kind: 'chimes', input: inputs.chimes as unknown as AudioNode },
    { id: 'drops', kind: 'drops', input: inputs.drops as unknown as AudioNode, notes: [2, 3] },
  ];
  const full: AmbienceBanks = {
    wind: buf('wind', WIND_LOOP_SECONDS),
    chimes: CHIME_NOTES.map((m) => buf(`chime${m}`, 2.8)),
    drops: DROP_NOTES.map((m) => buf(`drop${m}`, 0.25)),
    ...banks,
  };
  const player = new AmbiencePlayer(ctx as unknown as BaseAudioContext, full, places, mulberry32(21));
  /** Runs the scheduler frame by frame from `from` to `to` seconds. */
  const run = (from: number, to: number): void => {
    for (let t = from; t <= to; t += 1 / 60) {
      ctx.currentTime = t;
      player.update(t);
    }
  };
  /** The one-shots that were started, as [tag, start time]. */
  const shots = (): [string, number][] =>
    ctx.sources.filter((s) => !s.loop).map((s) => [s.buffer?.tag ?? '', s.started?.[0] ?? Number.NaN]);
  return { ctx, inputs, player, run, shots };
}

describe('the ambience player (src/audio/ambience.ts AmbiencePlayer)', () => {
  it('starts each wind gap’s loop from its own place in the loop, fading in from silence', () => {
    const r = rigPlayer();
    r.player.start(1);
    const loops = r.ctx.sources.filter((s) => s.loop);
    expect(loops).toHaveLength(2);
    expect(loops.map((s) => s.started)).toEqual([
      [1, 0],
      [1, WIND_LOOP_SECONDS / 2],
    ]);
    expect(r.player.playing).toBe(true);
    // no gust or drip is planned until the scheduler runs
    expect(r.shots()).toEqual([]);
  });

  it('plans chimes and drops a little ahead, never in the past, the first ones soon after it starts', () => {
    const r = rigPlayer();
    r.player.start(0);
    r.run(0, 60);
    const shots = r.shots();
    const chimes = shots.filter(([tag]) => tag.startsWith('chime'));
    const drops = shots.filter(([tag]) => tag.startsWith('drop'));
    expect(chimes.length).toBeGreaterThan(3);
    expect(drops.length).toBeGreaterThan(4);
    const first = (list: [string, number][]): number => Math.min(...list.map(([, t]) => t));
    expect(first(chimes)).toBeLessThanOrEqual(AMBIENCE.chimes.first[1]);
    expect(first(drops)).toBeLessThanOrEqual(AMBIENCE.drops.first[1]);
    // only the notes of its place drip there
    for (const [tag] of drops) expect([`drop${DROP_NOTES[2]}`, `drop${DROP_NOTES[3]}`]).toContain(tag);
    // every start was planned while it was still ahead of the clock
    for (const h of r.player.hits) expect(h.at).toBeGreaterThanOrEqual(h.planned);
    const states = r.player.sources;
    expect(states.find((s) => s.id === 'chimes')?.plays).toBe(chimes.length);
    expect(states.find((s) => s.id === 'drops')?.plays).toBe(drops.length);
  });

  it('after a stall (a hidden tab) it does not burst out everything it missed', () => {
    const r = rigPlayer();
    r.player.start(0);
    r.run(0, 2);
    const before = r.shots().length;
    r.ctx.currentTime = 40;
    r.player.update(40);
    const burst = r.shots().length - before;
    expect(burst).toBeLessThanOrEqual(AMBIENCE.chimes.strikes[1] + 2);
    for (const [, t] of r.shots().slice(before)) expect(t).toBeGreaterThanOrEqual(40);
  });

  it('plans nothing while the context is not running', () => {
    const r = rigPlayer();
    r.player.start(0);
    r.ctx.state = 'suspended';
    r.run(0, 30);
    expect(r.shots()).toEqual([]);
  });

  it('a place whose sound is missing stays silent; the others play', () => {
    const r = rigPlayer({ wind: null, chimes: CHIME_NOTES.map(() => null) });
    r.player.start(0);
    r.run(0, 30);
    expect(r.ctx.sources.filter((s) => s.loop)).toHaveLength(0);
    expect(r.shots().every(([tag]) => tag.startsWith('drop'))).toBe(true);
    expect(r.shots().length).toBeGreaterThan(0);
  });

  it('stops: fades out, stops the loops, plans no more; disposed, it lets go of where it played', () => {
    const r = rigPlayer();
    r.player.start(0);
    r.run(0, 5);
    r.player.stop(5);
    const loops = r.ctx.sources.filter((s) => s.loop);
    for (const l of loops) expect(l.stopped).toBeGreaterThan(5);
    const n = r.shots().length;
    r.run(5, 40);
    expect(r.shots().length).toBe(n);
    expect(r.player.playing).toBe(false);
    r.player.dispose();
    // the inputs are the emitters' (their owner's to let go of); its own faders into them are disconnected
    const inputs: Node[] = Object.values(r.inputs);
    for (const input of inputs) expect(input.disconnected).toBe(0);
    const faders = r.ctx.gains.filter((g) => g.outputs.some((o) => inputs.includes(o)));
    expect(faders).toHaveLength(4);
    for (const f of faders) expect(f.disconnected).toBeGreaterThan(0);
  });

  it('tells how loud each kind is sounding right now (the probe’s ears)', () => {
    const r = rigPlayer();
    r.player.start(0);
    const taps = r.ctx.analysers;
    expect(taps).toHaveLength(3);
    (taps[0] as Analyser).level = 0.1;
    const levels = r.player.levels();
    expect(Object.keys(levels).sort()).toEqual(['chimes', 'drops', 'wind']);
    expect(Math.max(levels.wind, levels.chimes, levels.drops)).toBeCloseTo(0.1, 6);
  });
});
