import { describe, expect, it, vi } from 'vitest';
import { correlation, decayT60, estimatePitch, peak, rms } from '../core/audio/analysis';
import { Biquad } from '../core/audio/dsp';
import { mulberry32 } from '../core/audio/rng';
import { isInScale, midiToHz } from '../core/audio/scale';
import {
  AMBIENCE,
  type AmbienceBanks,
  type AmbiencePlace,
  AmbiencePlayer,
  CHIME_NOTES,
  CHIME_SOURCES,
  DOOR_CHIME_NOTE,
  DOOR_CHIME_SIZE,
  DOOR_CHIME_SOURCES,
  DOOR_CHIME_STRIKES,
  DROP_NOTES,
  DROP_SOURCES,
  FURNACE_HUM_NOTES,
  FURNACE_LOOP_SECONDS,
  FURNACE_SOURCE,
  nextGap,
  planChimeRing,
  planDraught,
  planDrip,
  renderChime,
  renderDoorChime,
  renderDrop,
  renderFurnace,
  renderWind,
  WIND_LOOP_SECONDS,
  WIND_SOURCE,
} from './ambience';
import { glassPitch, VIDRO_SCALE } from './tuning';

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
    expect(WIND_SOURCE.id).toBe('wind-loop');
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

/** Level of `x` in a narrow band around `hz` (Goertzel, from `start` for `length` samples). */
function bandLevel(x: Float32Array, sr: number, hz: number, start: number, length: number): number {
  const w = (2 * Math.PI * hz) / sr;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = start; i < start + length; i++) {
    // a Hann window keeps a strong neighbour from leaking in
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - start)) / (length - 1));
    const s0 = (x[i] as number) * win + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / length;
}

describe('炉の燃える音 (S-25: 低く、持続して)', () => {
  const fire = renderFurnace(SR);
  const seconds = (x: Float32Array): number => x.length / SR;

  it('is a loop of a few seconds, the same every time it is made, a different length from the wind’s', () => {
    expect(fire.length).toBe(Math.round(FURNACE_LOOP_SECONDS * SR));
    expect(FURNACE_LOOP_SECONDS).not.toBe(WIND_LOOP_SECONDS);
    expect(Array.from(renderFurnace(SR).subarray(0, 64))).toEqual(Array.from(fire.subarray(0, 64)));
    expect(FURNACE_SOURCE.id).toBe('furnace-loop');
  });

  it('loops without a seam', () => {
    const steps: number[] = [];
    for (let i = 1; i < fire.length; i++) steps.push(Math.abs((fire[i] as number) - (fire[i - 1] as number)));
    steps.sort((a, b) => a - b);
    const p999 = steps[Math.floor(steps.length * 0.999)] as number;
    expect(Math.abs((fire[0] as number) - (fire[fire.length - 1] as number))).toBeLessThanOrEqual(p999);
  });

  it('burns on without a break: it flickers, but every half second is about as loud as the rest', () => {
    const levels: number[] = [];
    for (let t = 0; t + 0.5 <= seconds(fire); t += 0.5) levels.push(rms(fire, at(t), at(t + 0.5)));
    const max = Math.max(...levels);
    expect(max).toBeGreaterThan(0.05);
    expect(Math.min(...levels) / max).toBeGreaterThan(0.5);
    expect(peak(fire)).toBeLessThanOrEqual(1);
  });

  it('is low: nearly all of its power lies below 500 Hz, almost nothing above 1 kHz', () => {
    const lows = [0, 1].map(() => new Biquad(SR).lowpass(500, 0.7));
    const low = fire.map((v) => lows.reduce((acc, f) => f.process(acc), v));
    expect(rms(low) / rms(fire)).toBeGreaterThan(0.9);
    const highs = [0, 1].map(() => new Biquad(SR).highpass(1000, 0.7));
    const bright = fire.map((v) => highs.reduce((acc, f) => f.process(acc), v));
    expect(rms(bright) / rms(fire)).toBeLessThan(0.03);
  });

  it('its chamber hums on the scale (D and A, the root and the fifth), above the notes off the scale around them', () => {
    for (const m of FURNACE_HUM_NOTES) expect(isInScale(m, VIDRO_SCALE)).toBe(true);
    const n = at(4);
    // power over ±1 % of a note (a noise's single bin is too chancy to stand for it)
    const level = (midi: number): number => {
      let p = 0;
      for (let k = -5; k <= 5; k++) p += bandLevel(fire, SR, midiToHz(midi) * (1 + k * 0.002), 0, n) ** 2;
      return Math.sqrt(p / 11);
    };
    for (const m of FURNACE_HUM_NOTES) {
      // a semitone either side is off D major pentatonic for D (C#, D#) and for A (G#, A#)
      const off = (level(m - 1) + level(m + 1)) / 2;
      expect(level(m) / off, `hum ${m}`).toBeGreaterThan(1.8);
    }
  });
});

describe('扉の上の風鈴 (S-25: 扉から入る風でときどき鳴る。遠くの風鈴とは別の音、音階に揃える)', () => {
  it('rings the note the game’s glass rule gives the drawn bell, on the scale and none of the far chimes’ notes', () => {
    expect(DOOR_CHIME_NOTE).toBe(glassPitch(DOOR_CHIME_SIZE).midi);
    expect(isInScale(DOOR_CHIME_NOTE, VIDRO_SCALE)).toBe(true);
    expect(CHIME_NOTES).not.toContain(DOOR_CHIME_NOTE);
    // below every one of them: near, it never doubles a far bell
    expect(DOOR_CHIME_NOTE).toBeLessThan(Math.min(...CHIME_NOTES));
    expect(DOOR_CHIME_SOURCES).toHaveLength(DOOR_CHIME_STRIKES.length);
    expect(new Set(DOOR_CHIME_SOURCES.map((s) => s.id)).size).toBe(DOOR_CHIME_SOURCES.length);
  });

  it('each way the clapper meets the rim rings on that note (fundamental within ±3 %), and dies away', () => {
    const renders = DOOR_CHIME_STRIKES.map((_, v) => renderDoorChime(v, SR));
    for (const [v, x] of renders.entries()) {
      const hz = estimatePitch(x, SR, { start: 0.05, duration: 0.6 });
      expect(Math.abs((hz as number) / midiToHz(DOOR_CHIME_NOTE) - 1), `strike ${v}`).toBeLessThan(0.03);
      expect(peak(x)).toBeLessThanOrEqual(1);
      expect(rms(x, 0, at(0.3))).toBeGreaterThan(0.03);
      expect(decayT60(x, SR) as number, `strike ${v}`).toBeGreaterThan(0.5);
      expect(rms(x, x.length - at(0.01))).toBeLessThan(2e-3);
    }
    // the ways differ (a graze, taps, a full swing), not one sound copied
    for (let a = 0; a < renders.length; a++)
      for (let b = a + 1; b < renders.length; b++) {
        const n = at(0.3);
        const ra = (renders[a] as Float32Array).subarray(0, n);
        const rb = (renders[b] as Float32Array).subarray(0, n);
        expect(Math.abs(correlation(ra, rb)), `${a} vs ${b}`).toBeLessThan(0.98);
      }
  });

  it('a bell of its own: thicker than the far furin, it rings shorter, and its rim wavers (two close modes beating)', () => {
    const door = renderDoorChime(1, SR);
    const far = renderChime(CHIME_NOTES[0] as number, SR);
    expect(decayT60(door, SR) as number).toBeLessThan(decayT60(far, SR) as number);
    // the beating: the level of the ring rises and falls a few times a second, each fall a deep one
    const beats = (x: Float32Array): number => {
      const win = at(0.02);
      const env: number[] = [];
      for (let i = at(0.1); i + win <= at(1.1); i += win) env.push(rms(x, i, i + win));
      // falls of 30 % from a peak, each counted once the level has risen 25 % from the trough again (a plain decay
      // falls once and never rises)
      let n = 0;
      let peakV = env[0] as number;
      let troughV = peakV;
      let falling = false;
      for (const v of env) {
        if (!falling) {
          if (v > peakV) peakV = v;
          else if (v < peakV * 0.7) {
            falling = true;
            troughV = v;
          }
        } else if (v < troughV) troughV = v;
        else if (v > troughV * 1.25) {
          n++;
          falling = false;
          peakV = v;
        }
      }
      return n;
    };
    expect(beats(door)).toBeGreaterThanOrEqual(3);
    expect(beats(far)).toBeLessThan(beats(door));
  });

  it('a draught through the door comes in, holds while it rings the chime, and goes; the clapper swings and bounces', () => {
    const rng = mulberry32(17);
    const c = AMBIENCE.doorChime;
    const d0 = AMBIENCE.draught;
    const counts = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const d = planDraught(rng, 20);
      expect(d.at).toBe(20);
      expect(d.rise).toBeGreaterThan(0);
      expect(d.fall).toBeGreaterThan(0);
      expect(d.hold).toBeGreaterThanOrEqual(d0.hold[0]);
      expect(d.hits.length).toBeGreaterThan(0);
      expect(d.hits.length).toBeLessThanOrEqual(c.maxActive);
      counts.add(d.hits.length);
      const first = d.hits[0]?.at as number;
      // the air reaches the bell a moment after the draught starts
      expect(first - d.at).toBeGreaterThanOrEqual(c.delay[0]);
      expect(first - d.at).toBeLessThanOrEqual(c.delay[1]);
      for (const [k, h] of d.hits.entries()) {
        // every strike while the draught holds
        expect(h.at).toBeGreaterThanOrEqual(d.at);
        expect(h.at).toBeLessThanOrEqual(d.at + d.rise + d.hold);
        expect(h.index).toBeGreaterThanOrEqual(0);
        expect(h.index).toBeLessThan(DOOR_CHIME_STRIKES.length);
        expect(h.gain).toBeGreaterThan(0);
        expect(h.gain).toBeLessThanOrEqual(1);
        if (k > 0) expect(h.at).toBeGreaterThan(d.hits[k - 1]?.at as number);
      }
      // the clapper's bounce: a strike that follows another within the bounce gap is softer
      for (let k = 1; k < d.hits.length; k++) {
        const a = d.hits[k - 1] as { at: number; gain: number };
        const b = d.hits[k] as { at: number; gain: number };
        if (b.at - a.at <= c.bounceGap[1] + 1e-9) expect(b.gain).toBeLessThan(a.gain);
      }
    }
    expect(counts.size).toBeGreaterThan(2);
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

/** S-22's places (two wind gaps, the far chimes, a drip); `s25` adds the furnace and the chime by the second gap. */
function rigPlayer(banks?: Partial<AmbienceBanks>, s25 = false) {
  const ctx = new Ctx();
  const inputs = {
    wind1: new Node(),
    wind2: new Node(),
    chimes: new Node(),
    drops: new Node(),
    ...(s25 ? { fire: new Node(), door: new Node() } : {}),
  };
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
  if (s25)
    places.push(
      { id: 'fire', kind: 'fire', input: inputs.fire as unknown as AudioNode },
      {
        id: 'chimes:door',
        kind: 'chimes',
        bells: 'door',
        draught: 'wind:b',
        input: inputs.door as unknown as AudioNode,
      },
    );
  const full: AmbienceBanks = {
    wind: buf('wind', WIND_LOOP_SECONDS),
    fire: buf('fire', FURNACE_LOOP_SECONDS),
    chimes: CHIME_NOTES.map((m) => buf(`chime${m}`, 2.8)),
    doorChime: DOOR_CHIME_STRIKES.map((_, v) => buf(`door${v}`, 1.6)),
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

  it('stops: fades out, stops the loops, plans no more', () => {
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
  });

  it('disposed while sounding, it fades out quickly before it lets go (no cut tail, no click)', () => {
    vi.useFakeTimers();
    try {
      const r = rigPlayer();
      r.player.start(0);
      r.run(0, 5);
      r.player.dispose();
      const inputs: Node[] = Object.values(r.inputs);
      const faders = r.ctx.gains.filter((g) => g.outputs.some((o) => inputs.includes(o)));
      expect(faders).toHaveLength(4);
      for (const f of faders) {
        // heading for silence from now, quickly
        const last = f.gain.calls.at(-1);
        expect(last?.[0]).toBe('target');
        expect(last?.[1]).toBe(0);
        expect(f.disconnected).toBe(0);
      }
      for (const l of r.ctx.sources.filter((s) => s.loop)) expect(l.stopped).toBeLessThan(5.1);
      vi.advanceTimersByTime(200);
      // the emitters' inputs stay their owner's; its own faders are let go of once the fade has run
      for (const input of inputs) expect(input.disconnected).toBe(0);
      for (const f of faders) expect(f.disconnected).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells how loud each kind is sounding right now (the probe’s ears)', () => {
    const r = rigPlayer();
    r.player.start(0);
    // the ears are only put in when first asked (the game itself never asks)
    expect(r.ctx.analysers).toHaveLength(0);
    expect(r.player.levels()).toEqual({ wind: 0, fire: 0, chimes: 0, drops: 0 });
    const taps = r.ctx.analysers;
    expect(taps).toHaveLength(4);
    (taps[0] as Analyser).level = 0.1;
    const levels = r.player.levels();
    expect(Object.keys(levels).sort()).toEqual(['chimes', 'drops', 'fire', 'wind']);
    expect(Math.max(levels.wind, levels.fire, levels.chimes, levels.drops)).toBeCloseTo(0.1, 6);
  });
});

describe('the furnace and the chime above the door in the player (S-25)', () => {
  /** The gain a loop plays through (startLoop: source → its gain → the place's fader). */
  const loopGain = (src: Source | undefined): Gain => src?.outputs[0] as Gain;

  it('burns the furnace’s loop at its place and level from the start, beside the wind’s', () => {
    const r = rigPlayer(undefined, true);
    r.player.start(1);
    const loops = r.ctx.sources.filter((s) => s.loop);
    expect(loops.map((s) => s.buffer?.tag)).toEqual(['wind', 'wind', 'fire']);
    const fire = loopGain(loops[2]);
    expect(fire.gain.calls).toContainEqual(['set', AMBIENCE.fire.level, 1]);
    // through its own fader into the furnace's emitter
    expect((fire.outputs[0] as Node).outputs).toContain(r.inputs.fire);
    expect(r.player.sources.find((s) => s.id === 'fire')).toMatchObject({
      kind: 'fire',
      plays: 1,
      active: 1,
    });
  });

  it('rings the chime above the door only while a draught comes in, each draught swelling the door’s wind; the far chimes ring their own bells', () => {
    const r = rigPlayer(undefined, true);
    r.player.start(0);
    r.run(0, 120);
    const door = r.shots().filter(([tag]) => tag.startsWith('door'));
    const far = r.shots().filter(([tag]) => tag.startsWith('chime'));
    expect(door.length).toBeGreaterThan(3);
    expect(far.length).toBeGreaterThan(3);
    const draughts = r.player.draughts;
    expect(draughts.length).toBeGreaterThanOrEqual(Math.floor(120 / AMBIENCE.draught.gap[1]) - 1);
    // ときどき: a while between draughts
    for (let i = 1; i < draughts.length; i++)
      expect((draughts[i]?.at as number) - (draughts[i - 1]?.at as number)).toBeGreaterThanOrEqual(
        AMBIENCE.draught.gap[0] - 1e-9,
      );
    // the door chime rings while a draught holds, never between
    for (const [, t] of door) expect(draughts.some((d) => t >= d.at && t <= d.held)).toBe(true);
    // into the chime's own emitter, counted at its place
    expect(r.ctx.gains.some((g) => g.outputs.includes(r.inputs.door as Node))).toBe(true);
    expect(r.player.sources.find((s) => s.id === 'chimes:door')?.plays).toBe(door.length);
    // the door's wind swells as each draught comes in and settles back after; the other gap is left alone
    const loops = r.ctx.sources.filter((s) => s.loop);
    const swells = loopGain(loops[1]).gain.calls.filter((c) => c[0] === 'target');
    const w = AMBIENCE.wind.level;
    for (const d of draughts) {
      expect(swells).toContainEqual(['target', w * AMBIENCE.draught.swell, d.at]);
      expect(swells).toContainEqual(['target', w, d.held]);
    }
    expect(loopGain(loops[0]).gain.calls.filter((c) => c[0] === 'target')).toEqual([]);
  });

  it('logs its strikes in the order they sound, though a draught’s are planned seconds ahead of the others', () => {
    const r = rigPlayer(undefined, true);
    r.player.start(0);
    r.run(0, 30);
    const ats = r.player.hits.map((h) => h.at);
    expect(new Set(r.player.hits.map((h) => h.id))).toEqual(new Set(['chimes', 'drops', 'chimes:door']));
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  it('a draught whose wind is missing still rings the chime; a missing chime leaves the draught silent', () => {
    const noWind = rigPlayer({ wind: null }, true);
    noWind.player.start(0);
    noWind.run(0, 40);
    expect(noWind.shots().some(([tag]) => tag.startsWith('door'))).toBe(true);
    const noBell = rigPlayer({ doorChime: DOOR_CHIME_STRIKES.map(() => null) }, true);
    noBell.player.start(0);
    noBell.run(0, 40);
    expect(noBell.shots().some(([tag]) => tag.startsWith('door'))).toBe(false);
    expect(noBell.shots().some(([tag]) => tag.startsWith('chime'))).toBe(true);
  });
});
