import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type * as THREE from 'three/webgpu';
import { CHIME_NOTES, DOOR_CHIME_NOTE, DOOR_CHIME_STRIKES } from '../../src/audio/ambience';
import { VIDRO_SCALE } from '../../src/audio/tuning';
import { estimatePitch, peak, rms } from '../../src/core/audio/analysis';
import { Biquad } from '../../src/core/audio/dsp';
import { isInScale, midiToHz } from '../../src/core/audio/scale';
import { WORKSHOP_OBJECTS } from '../../src/game/prologue/layout';

/**
 * S-25: the workshop's own sounds where S-24 drew them, on both render paths.
 *  (a) OfflineAudioContext, in the page, through the game's engine: the furnace's loop never falls silent and is low;
 *      heard alone it is louder the nearer you stand, and from the bench it comes from its side (HRTF); each way the
 *      clapper meets the door chime's rim rings within ±3 % of its note on the scale, none of the far chimes' notes;
 *      at the door the chime rings only in the door's draughts, which swell the door's wind. WAVs → artifacts/S-25/wav/
 *  (b) live: the fire, the tub's drop and the door chime play from the PannerNodes of the audio graph, and those stand
 *      in what the room drew from the workshop's glb (the fire in the furnace's mouth, the water of the tub, the clear
 *      glass bell above the door); the chime rings and the tub drips
 * No console error or warning anywhere. Numbers → artifacts/S-25/<what>-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

type Kind = 'wind' | 'fire' | 'chimes' | 'drops';
interface Hit {
  at: number;
  id: string;
  kind: Kind;
  index: number;
}
interface Draught {
  id: string;
  at: number;
  held: number;
  until: number;
}
interface AmbienceProbe {
  ready: boolean;
  playing: boolean;
  sources: { id: string; kind: Kind; plays: number; active: number }[];
  levels: Record<Kind, number>;
  places: { id: string; kind: Kind; position: [number, number, number]; panning: string }[];
  hits: Hit[];
  draughts: Draught[];
}
interface SoundProbe {
  state: string;
  ambience: AmbienceProbe;
}
type At = 'bench' | 'furnace' | 'door' | 'path' | 'far';
type LabSpec =
  | { kind: 'sound'; bank: 'fire' | 'door-chime'; index: number; seconds: number }
  | { kind: 'ambience'; seconds: number; seed: number; at: At; only?: string[] };
interface LabResult {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  hits?: Hit[];
  draughts?: Draught[];
}
interface Box {
  min: [number, number, number];
  max: [number, number, number];
  meshes: number;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;
/** S-09's bar for "audible": -40 dBFS RMS. */
const AUDIBLE = 0.01;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (/GPU stall|powerPreference/i.test(text)) return;
    if (m.type() === 'error' || m.type() === 'warning' || GPU_VALIDATION.test(text)) errors.push(text);
  });
  return errors;
}

const sound = (page: Page): Promise<SoundProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { sound: SoundProbe }).sound);

async function waitRoom(page: Page, fn: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const r = window.__vidro?.sceneProbe?.room; return !!r && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}
async function waitSound(page: Page, fn: string, timeout = 15_000): Promise<SoundProbe> {
  await page.waitForFunction(
    `(() => { try { const s = window.__vidro?.sceneProbe?.sound; return !!s && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
  return sound(page);
}

async function lab(page: Page, spec: LabSpec): Promise<LabResult & { mono: Float32Array }> {
  const r = (await page.evaluate(
    (s) =>
      (window.__vidro.sceneProbe as { sound: { render(spec: unknown): Promise<unknown> } }).sound.render(s),
    spec,
  )) as LabResult;
  const left = Float32Array.from(r.left);
  const right = Float32Array.from(r.right);
  const mono = left.map((v, i) => (v + (right[i] as number)) / 2);
  return { ...r, left, right, mono };
}

const rmsAt = (x: Float32Array, sr: number, from: number, to: number): number =>
  rms(x, Math.round(from * sr), Math.round(to * sr));

/** A steep low-pass (four biquads): what lies under `hz`, with the bells above it gone. */
function below(x: Float32Array, sr: number, hz: number): Float32Array {
  const fs = [0, 1, 2, 3].map(() => new Biquad(sr).lowpass(hz, 0.7));
  return x.map((v) => fs.reduce((acc, f) => f.process(acc), v));
}

/**
 * How the right ear hears a sound against the left over [from, to] s: its level (right / left RMS) and how much earlier
 * (ms; the lag of the best cross-correlation within ±1.2 ms, positive when the right ear leads).
 */
function ears(
  left: Float32Array,
  right: Float32Array,
  sr: number,
  from: number,
  to: number,
): { level: number; leadMs: number } {
  const a = Math.round(from * sr);
  const b = Math.round(to * sr);
  const maxLag = Math.round(0.0012 * sr);
  let best = Number.NEGATIVE_INFINITY;
  let bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = a + maxLag; i < b - maxLag; i++) sum += (left[i] as number) * (right[i - lag] as number);
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return { level: rmsAt(right, sr, from, to) / rmsAt(left, sr, from, to), leadMs: (bestLag / sr) * 1000 };
}

function wav(path: string, sampleRate: number, channels: Float32Array[]): void {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const data = Buffer.alloc(44 + n * ch * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * ch * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(ch, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * ch * 2, 28);
  data.writeUInt16LE(ch * 2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, (channels[c] as Float32Array)[i] as number));
      data.writeInt16LE(Math.round(v * 32767), 44 + (i * ch + c) * 2);
    }
  writeFileSync(path, data);
}

const inside = (p: readonly number[], b: Box, margin: number): boolean =>
  [0, 1, 2].every(
    (i) =>
      (p[i] as number) >= (b.min[i] as number) - margin && (p[i] as number) <= (b.max[i] as number) + margin,
  );

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';
  const out = join(root, 'artifacts/S-25');

  test(`S-25 offline: the furnace burns low and nearer is louder; the door chime is its own bell on the scale, rung by the door's draught [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const wavDir = join(out, 'wav');
    mkdirSync(wavDir, { recursive: true });
    const write = backend === 'webgpu';
    await page.goto(`/?scene=prologue-proto&direct=1${webgl}`);
    await waitRoom(page, 'r.ready && r.playing', 60_000);
    const report: Record<string, unknown> = { backend };

    // 炉: the loop alone, round twice — it never falls silent, and it is low
    const fire = await lab(page, { kind: 'sound', bank: 'fire', index: 0, seconds: 15 });
    const sr = fire.sampleRate;
    for (let t = 0.5; t + 0.5 <= 14.5; t += 0.5)
      expect(rmsAt(fire.mono, sr, t, t + 0.5), `fire at ${t} s`).toBeGreaterThan(AUDIBLE);
    expect(peak(fire.mono)).toBeLessThan(1);
    // low: nearly all of it under 500 Hz (the room's reverb included)
    const lowShare = rms(below(fire.mono, sr, 500)) / rms(fire.mono);
    expect(lowShare).toBeGreaterThan(0.9);
    if (write) wav(join(wavDir, 'fire-loop-x2.wav'), sr, [fire.left, fire.right]);

    // 近づくと大きい: the furnace alone (HRTF, the workshop), heard from nearer to farther
    const where: At[] = ['furnace', 'bench', 'path', 'far'];
    const near: Record<string, number> = {};
    let side: { level: number; leadMs: number } | null = null;
    for (const at of where) {
      const r = await lab(page, { kind: 'ambience', seconds: 9, seed: 3, at, only: ['fire:furnace'] });
      near[at] = rmsAt(r.mono, sr, 3.5, 9);
      if (at === 'bench') side = ears(r.left, r.right, sr, 3.5, 9);
      if (write && at !== 'far') wav(join(wavDir, `fire-at-${at}.wav`), r.sampleRate, [r.left, r.right]);
    }
    expect(near.furnace).toBeGreaterThan((near.bench as number) * 1.2);
    expect(near.bench).toBeGreaterThan((near.path as number) * 1.2);
    expect(near.path).toBeGreaterThan(near.far as number);
    // in front of the furnace it is clearly there
    expect(near.furnace).toBeGreaterThan(AUDIBLE / 3);
    // waking at the bench, looking at the door (-Z), the furnace is on the right (HRTF): a low sound is told apart less
    // by level than by time — the right ear hears it a little louder and first (a head's width, up to ~0.7 ms)
    const s0 = side as unknown as { level: number; leadMs: number };
    expect(s0.level, 'the right ear hears the fire louder').toBeGreaterThan(1.1);
    expect(s0.leadMs, 'the right ear hears the fire first').toBeGreaterThan(0.2);
    expect(s0.leadMs).toBeLessThan(1);
    report.fire = { lowShare, rms: rmsAt(fire.mono, sr, 1, 14), byDistance: near, benchEars: side };

    // 扉の上の風鈴: each way the clapper meets the rim rings on the bell's note (±3 %), none of the far chimes' notes
    const target = midiToHz(DOOR_CHIME_NOTE);
    expect(isInScale(DOOR_CHIME_NOTE, VIDRO_SCALE)).toBe(true);
    const strikes: Record<string, unknown>[] = [];
    for (const [v, strength] of DOOR_CHIME_STRIKES.entries()) {
      const r = await lab(page, { kind: 'sound', bank: 'door-chime', index: v, seconds: 2.5 });
      const hz = estimatePitch(r.mono, r.sampleRate, { start: 0.05, duration: 0.6 });
      const error = hz === null ? Number.POSITIVE_INFINITY : Math.abs(hz / target - 1);
      strikes.push({ variant: v, strength, hz, target, error, rms: rmsAt(r.mono, r.sampleRate, 0, 0.3) });
      expect(error, `door chime ${v} (${strength}): ${hz} Hz for ${target.toFixed(1)} Hz`).toBeLessThan(0.03);
      expect(rmsAt(r.mono, r.sampleRate, 0, 0.3)).toBeGreaterThan(AUDIBLE);
      expect(peak(r.mono)).toBeLessThan(1);
      for (const m of CHIME_NOTES)
        expect(Math.abs((hz as number) / midiToHz(m) - 1), `not the far chime ${m}`).toBeGreaterThan(0.05);
      if (write) wav(join(wavDir, `door-chime-${v + 1}-${strength}.wav`), r.sampleRate, [r.left, r.right]);
    }
    report.doorChime = strikes;

    // 扉から入る風で: at the door, the door's wind and chime; against the same wind without the chime (no draughts)
    const seconds = 45;
    const rung = await lab(page, {
      kind: 'ambience',
      seconds,
      seed: 11,
      at: 'door',
      only: ['wind:door', 'chimes:door'],
    });
    const still = await lab(page, { kind: 'ambience', seconds, seed: 11, at: 'door', only: ['wind:door'] });
    const draughts = rung.draughts ?? [];
    const doorHits = (rung.hits ?? []).filter((h) => h.id === 'chimes:door');
    expect(draughts.length).toBeGreaterThan(1);
    expect(doorHits.length).toBeGreaterThan(1);
    expect(still.draughts ?? []).toEqual([]);
    for (const h of doorHits)
      expect(
        draughts.some((d) => h.at >= d.at && h.at <= d.held),
        `strike at ${h.at.toFixed(2)} s`,
      ).toBe(true);
    // the draught is heard: under the bell (400 Hz), the door's wind is louder while it holds than without it
    const lowRung = below(rung.mono, sr, 400);
    const lowStill = below(still.mono, sr, 400);
    const swells: number[] = [];
    for (const d of draughts) {
      const from = d.at + 0.6;
      if (d.held - from < 0.4 || d.held > seconds - 1) continue;
      swells.push(rmsAt(lowRung, sr, from, d.held) / rmsAt(lowStill, sr, from, d.held));
    }
    expect(swells.length).toBeGreaterThan(0);
    for (const s of swells) expect(s, 'the door’s wind swells in a draught').toBeGreaterThan(1.3);
    // between draughts it is the same wind (from the end of the fade-in to the first draught)
    const first = draughts[0] as Draught;
    let calm: number | null = null;
    if (first.at - 3 > 0.5) {
      calm = rmsAt(lowRung, sr, 3, first.at) / rmsAt(lowStill, sr, 3, first.at);
      expect(calm).toBeGreaterThan(0.95);
      expect(calm).toBeLessThan(1.05);
    }
    report.draughts = { draughts, doorHits: doorHits.length, swells, calm };
    if (write) wav(join(wavDir, 'door-draughts-45s.wav'), sr, [rung.left, rung.right]);

    // S-22's sounds as they were: at the bench, the whole ambience against S-22's spots alone (same seed). The door's
    // chime strikes on a stream of its own, so the far chimes and the drops fall at the same moments; and the fire and
    // the door's draughts hardly raise the bed above 1 kHz, where S-22 hears the far chimes over the wind
    const s22 = [
      'wind:skylight',
      'wind:door',
      'wind:edge',
      'chimes:town',
      'drops:skylight',
      'drops:tub',
      'drops:lamp',
    ];
    const benchSeconds = 40;
    const all = await lab(page, { kind: 'ambience', seconds: benchSeconds, seed: 7, at: 'bench' });
    const old = await lab(page, { kind: 'ambience', seconds: benchSeconds, seed: 7, at: 'bench', only: s22 });
    // every strike is in the player's log (it keeps the last 64)
    expect((all.hits ?? []).length).toBeLessThan(64);
    const strikesOf = (r: LabResult, id: string) =>
      (r.hits ?? []).filter((h) => h.id === id).map((h) => Math.round(h.at * 1000) / 1000);
    for (const id of ['chimes:town', 'drops:skylight', 'drops:tub', 'drops:lamp'])
      expect(strikesOf(all, id), `${id} as in S-22`).toEqual(strikesOf(old, id));
    const hp = (x: Float32Array) => {
      const f = new Biquad(sr).highpass(1000);
      return x.map((v) => f.process(v));
    };
    // the bed: the quietest fifth of 250 ms windows (strikes and the draughts' swells lie above it)
    const bed = (x: Float32Array): number => {
      const w: number[] = [];
      for (let t = 3; t + 0.25 <= benchSeconds; t += 0.25) w.push(rmsAt(x, sr, t, t + 0.25));
      w.sort((a, b) => a - b);
      return w[Math.floor(w.length * 0.2)] as number;
    };
    const bedRise = bed(hp(all.mono)) / bed(hp(old.mono));
    expect(bedRise, 'the bed above 1 kHz at the bench, S-25 against S-22').toBeLessThan(1.15);
    report.bench = { bedRiseAbove1k: bedRise, hits: (all.hits ?? []).length };

    // the whole ambience where you stand, for the ear (and its levels for the record: the bed is the quietest fifth of
    // 250 ms windows, the peak the loudest strike)
    if (write) {
      const mix: Record<string, unknown> = {};
      for (const at of ['furnace', 'door', 'bench'] as const) {
        const r = await lab(page, { kind: 'ambience', seconds: 30, seed: 7, at });
        const windows: number[] = [];
        for (let t = 3; t + 0.25 <= 30; t += 0.25) windows.push(rmsAt(r.mono, r.sampleRate, t, t + 0.25));
        windows.sort((a, b) => a - b);
        const dB = (v: number): number => Math.round(20 * Math.log10(v) * 10) / 10;
        mix[at] = {
          bedDb: dB(windows[Math.floor(windows.length * 0.2)] as number),
          peakDb: dB(peak(r.mono, Math.round(3 * r.sampleRate))),
        };
        wav(join(wavDir, `ambience-${at}-30s.wav`), r.sampleRate, [r.left, r.right]);
      }
      report.mix = mix;
    }

    writeFileSync(join(out, `offline-${backend}.json`), JSON.stringify(report, null, 2));
    // the offline renders made no live context and need no gesture
    expect((await sound(page)).state).toBe('locked');
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-25 the sounds stand where S-24 drew them, and play: the fire in the furnace's mouth, the drop on the tub's water, the chime in its bell [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    mkdirSync(out, { recursive: true });
    const errors = collectErrors(page);
    // debug=1: __vidroDebug.renderer, to find what the room draws
    await page.goto(`/?scene=prologue-proto&direct=1&debug=1${webgl}`);
    await waitRoom(page, 'r.ready && r.playing && r.workshop && r.workshop.loaded', 60_000);

    // what the room drew from the workshop's glb: world boxes of the fire, the water and the bell
    const drawn = (await page.evaluate(
      async ({ names }) => {
        const debug = window.__vidroDebug;
        if (!debug) return { error: '__vidroDebug missing' };
        const renderer = debug.renderer;
        const sensorRender = renderer.render;
        const roots = new Set<THREE.Object3D>();
        renderer.render = (...args: Parameters<THREE.WebGPURenderer['render']>) => {
          roots.add(args[0]);
          return sensorRender.apply(renderer, args);
        };
        await new Promise<void>((resolve) => {
          let left = 10;
          const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        });
        renderer.render = sensorRender;
        const find = (name: string): THREE.Object3D | null => {
          for (const r of roots) {
            let hit: THREE.Object3D | null = null;
            r.traverse((o) => {
              if (!hit && o.userData?.name === name) hit = o;
            });
            if (hit) return hit;
          }
          return null;
        };
        const materials = (m: THREE.Mesh): string =>
          (Array.isArray(m.material) ? m.material : [m.material])
            .map((x) => `${x.name}|${String(x.userData?.mark ?? '')}`)
            .join(',');
        const box = (name: string, part: string) => {
          const o = find(name);
          if (!o) return null;
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          let meshes = 0;
          o.updateWorldMatrix(true, true);
          o.traverse((m) => {
            const mesh = m as THREE.Mesh;
            if (!mesh.isMesh || !materials(mesh).includes(part)) return;
            meshes++;
            const p = mesh.geometry.getAttribute('position');
            // three is bundled: take its Vector3 from the scene itself
            const v = mesh.position.clone();
            for (let i = 0; i < p.count; i++) {
              v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
              const xyz = [v.x, v.y, v.z];
              for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k] as number, xyz[k] as number);
                max[k] = Math.max(max[k] as number, xyz[k] as number);
              }
            }
          });
          return { min, max, meshes };
        };
        return {
          fire: box(names.furnace, 'A0_fire'),
          water: box(names.tub, 'A0_water'),
          bell: box(names.chime, 'glass_clear'),
        };
      },
      {
        names: {
          furnace: WORKSHOP_OBJECTS.furnace.name,
          tub: WORKSHOP_OBJECTS.tub.name,
          chime: WORKSHOP_OBJECTS.chime.name,
        },
      },
    )) as { error?: string; fire: Box | null; water: Box | null; bell: Box | null };
    expect(drawn.error).toBeUndefined();
    for (const k of ['fire', 'water', 'bell'] as const) expect(drawn[k]?.meshes, k).toBeGreaterThan(0);
    const fire = drawn.fire as Box;
    const water = drawn.water as Box;
    const bell = drawn.bell as Box;

    // the first gesture starts the audio (AGENTS.md: S-16)
    expect((await sound(page)).ambience.places).toEqual([]);
    await page.mouse.click(640, 360);
    let s = await waitSound(page, "s.state === 'running' && s.ambience.ready && s.ambience.playing");
    const place = (id: string) => {
      const p = s.ambience.places.find((q) => q.id === id);
      if (!p) throw new Error(`no ambience place ${id}`);
      return p;
    };
    // where the audio graph has them: inside what was drawn
    const at = { fire: place('fire:furnace'), tub: place('drops:tub'), chime: place('chimes:door') };
    expect(inside(at.fire.position, fire, 0.03), `fire ${at.fire.position} in ${JSON.stringify(fire)}`).toBe(
      true,
    );
    const [wx, wy, wz] = at.tub.position;
    expect(
      wx >= water.min[0] && wx <= water.max[0] && wz >= water.min[2] && wz <= water.max[2],
      `drop (${wx}, ${wz}) on the water ${JSON.stringify(water)}`,
    ).toBe(true);
    expect(Math.abs(wy - water.max[1]), 'the drop falls on the water’s surface').toBeLessThan(0.02);
    expect(
      inside(at.chime.position, bell, 0.01),
      `chime ${at.chime.position} in ${JSON.stringify(bell)}`,
    ).toBe(true);
    for (const p of s.ambience.places) expect(p.panning, p.id).toBe('HRTF');

    // and they play: the fire is heard, the tub drips, the chime rings in the door's draught
    const plays = (id: string) => s.ambience.sources.find((q) => q.id === id)?.plays ?? 0;
    let fireHeard = 0;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      s = await sound(page);
      fireHeard = Math.max(fireHeard, s.ambience.levels.fire);
      if (plays('chimes:door') > 0 && plays('drops:tub') > 0 && fireHeard > 1e-4) break;
      await page.waitForTimeout(100);
    }
    writeFileSync(
      join(out, `live-${backend}.json`),
      JSON.stringify({ backend, drawn, ambience: s.ambience, fireHeard, errors }, null, 2),
    );
    expect(fireHeard, 'the furnace is heard').toBeGreaterThan(1e-4);
    expect(plays('fire:furnace')).toBe(1);
    expect(plays('drops:tub')).toBeGreaterThan(0);
    expect(plays('chimes:door')).toBeGreaterThan(0);
    const doorHits = s.ambience.hits.filter((h) => h.id === 'chimes:door');
    expect(doorHits.length).toBeGreaterThan(0);
    for (const h of doorHits)
      expect(s.ambience.draughts.some((d) => h.at >= d.at && h.at <= d.held)).toBe(true);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
