import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { VIDRO_VOLUMES } from '../../src/audio/levels';

/**
 * S-18: one AudioContext. The loading screen's 「はじめる」 starts one AudioEngine (src/ui/audio-gate.ts), and the
 * home's drops and the prologue room's sounds play through it; in direct mode the room makes its own (S-16).
 * window.AudioContext is wrapped before the page loads, so every context made is recorded: whether the page had
 * user activation at that moment and which event handler made it (AGENTS.md: made inside the first gesture), its
 * state, how many AudioEngines were built on it (each engine makes one limiter, a DynamicsCompressorNode;
 * src/core/audio/engine.ts), and how many connections reach its speakers (only the engine's limiter should: then
 * every sound went through the engine's buses and master, i.e. follows its four volumes).
 *  - home → room: none before 「はじめる」 (a stray click makes none either), then one, made inside that press, with
 *    one engine; the engine counted the drops' pings and the room's cues; the cues follow the room's events (S-16)
 *  - direct: none before the first gesture, then one, made by the room's own sound (S-16)
 *  - home-dive (S-04's placeholder world): one, from 「はじめる」 pressed with Enter, still one after Esc and a second press
 *  - leaving: the home path's one context is closed with the scene, and the next instance waits for its own press
 * Both render paths. Numbers → artifacts/S-18/<what>-<backend>.json.
 */
test.use({ locale: 'ja-JP' });

interface ContextRecord {
  state: string;
  /** navigator.userActivation.isActive when it was made (null: no such API). */
  activation: boolean | null;
  /** The event being handled when it was made (window.event): it was made synchronously inside that handler. */
  event: string | null;
  trusted: boolean | null;
  /** AudioEngines built on it (one limiter each). */
  engines: number;
  /** Connections made into its speakers (destination): the engine's limiter is the only way out. */
  speakers: number;
}
interface RoomProbe {
  ready: boolean;
  playing: boolean;
  locked: boolean;
  orb: 'bench' | 'hand' | 'pedestal';
  handPresence: number;
  peekAmount: number;
  target: string | null;
  events: string[];
}
interface PlayedCue {
  event: string;
  cue: string;
  source: string;
  distance: number;
}
interface SoundProbe {
  state: string;
  unlocked: boolean;
  shared: boolean;
  room: string;
  voicesStarted: number;
  played: PlayedCue[];
  playedCount: number;
  refusedCount: number;
  emitters: number;
  disposed: boolean;
}
interface GateProbe {
  state: string;
  contexts: number;
  uiVoices: number;
  voicesStarted: number;
  voicesDropped: number;
  room: string | null;
  volumes: Record<string, number> | null;
}

/** The S-16 acceptance table (サウンドデザイン > ガラスの音; peekEnd is silent). */
const CUES: Record<string, string | null> = {
  peekStart: 'popen:peek',
  peekEnd: null,
  place: 'popen:place',
  'pickup:bench': 'popen:pickup',
  'pickup:pedestal': 'popen:pickup',
  'shake:peek': 'popen:tremble',
  'shake:pickup': 'popen:tremble',
  dropTouched: 'glass:touch',
  dropTaken: 'glass:tap',
};
function expectedCues(events: string[]): { event: string; cue: string }[] {
  const out: { event: string; cue: string }[] = [];
  for (const event of events) {
    if (!(event in CUES)) throw new Error(`no sound decided for the event ${event}`);
    const cue = CUES[event];
    if (cue) out.push({ event, cue });
  }
  return out;
}

const root = process.cwd();
const backends = (process.env.BACKENDS ?? 'webgpu,webgl2').split(',');
const GPU_VALIDATION = /Destroyed texture|GPUValidationError|\[Invalid |used in a submit/i;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (/GPU stall|powerPreference/i.test(text)) return;
    // warnings count too (an AudioContext autoplay notice would be one)
    if (m.type() === 'error' || m.type() === 'warning' || GPU_VALIDATION.test(text)) errors.push(text);
  });
  return errors;
}

/**
 * Wraps window.AudioContext (and AudioNode.connect, to see what reaches the speakers) before any page script runs;
 * window.__s18Contexts() lists what was made.
 */
async function countContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Base = window.AudioContext;
    if (!Base) return;
    type Made = {
      context: BaseAudioContext;
      activation: boolean | null;
      event: string | null;
      trusted: boolean | null;
      engines: number;
      speakers: number;
    };
    const made: Made[] = [];
    const recordOf = (context: BaseAudioContext): Made | undefined => made.find((m) => m.context === context);
    class CountedAudioContext extends Base {
      constructor(options?: AudioContextOptions) {
        super(options);
        const activation = navigator.userActivation ? navigator.userActivation.isActive : null;
        const event = window.event;
        made.push({
          context: this,
          activation,
          event: event ? event.type : null,
          trusted: event ? event.isTrusted : null,
          engines: 0,
          speakers: 0,
        });
      }
      override createDynamicsCompressor(): DynamicsCompressorNode {
        const m = recordOf(this);
        if (m) m.engines++;
        return super.createDynamicsCompressor();
      }
    }
    window.AudioContext = CountedAudioContext;
    const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      const m = args[0] instanceof AudioDestinationNode ? recordOf(this.context) : undefined;
      if (m) m.speakers++;
      return connect.apply(this, args);
    } as AudioNode['connect'];
    (window as unknown as { __s18Contexts: () => unknown }).__s18Contexts = () =>
      made.map(({ context, ...rest }) => ({ state: context.state, ...rest }));
  });
}

const contexts = (page: Page): Promise<ContextRecord[]> =>
  page.evaluate(() => (window as unknown as { __s18Contexts: () => ContextRecord[] }).__s18Contexts());
const room = (page: Page): Promise<RoomProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { room: RoomProbe }).room);
const sound = (page: Page): Promise<SoundProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { sound: SoundProbe }).sound);
const gate = (page: Page): Promise<GateProbe> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { audioGate: GateProbe }).audioGate);
/** The UI's and the room's audio read in the same moment (no ping can fall between the two reads). */
const both = (page: Page): Promise<{ gate: GateProbe; sound: SoundProbe }> =>
  page.evaluate(() => {
    const p = window.__vidro.sceneProbe as { audioGate: GateProbe; sound: SoundProbe };
    return { gate: { ...p.audioGate }, sound: { ...p.sound } };
  });
const homeAudio = (page: Page): Promise<string> =>
  page.evaluate(() => (window.__vidro.sceneProbe as { audio: string }).audio);

/** Waits until `fn` holds for sceneProbe[key], which `fn` reads as `name`. */
async function waitFor(page: Page, key: 'room' | 'sound', name: string, fn: string, timeout: number) {
  await page.waitForFunction(
    `(() => { try { const ${name} = window.__vidro?.sceneProbe?.${key}; return !!${name} && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}
const waitRoom = (page: Page, fn: string, timeout = 20_000) => waitFor(page, 'room', 'r', fn, timeout);
const waitSound = (page: Page, fn: string, timeout = 10_000) => waitFor(page, 'sound', 's', fn, timeout);

async function waitHome(page: Page, fn: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    `(() => { try { const p = window.__vidro?.sceneProbe; return !!p && !!p.load && !!(${fn}); } catch { return false; } })()`,
    undefined,
    { timeout },
  );
}

/** In the workshop, facing the bench: take the mouse, take the vidro (拾う), peek (覗く) and lower it. */
async function takeAndPeek(page: Page): Promise<void> {
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.mouse.up();
  await waitRoom(page, 'r.locked === true');
  await waitRoom(page, "r.target === 'bench'", 5_000);
  await page.keyboard.press('KeyE');
  await waitRoom(page, "r.orb === 'hand' && r.handPresence > 0.99");
  await page.mouse.down({ button: 'right' });
  await waitRoom(page, 'r.peekAmount > 0.999');
  await page.mouse.up({ button: 'right' });
  await waitRoom(page, 'r.peekAmount === 0');
  await waitSound(page, 's.playedCount >= 2', 3_000);
}

for (const backend of backends) {
  const webgl = backend === 'webgl2' ? '&webgl=1' : '';

  test(`S-18 home → room: one AudioContext, made inside the press of 「はじめる」, shared by the drops and the room [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    mkdirSync(join(root, 'artifacts/S-18'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await page.goto(`/?scene=prologue-proto&quality=mid${webgl}`);
    await waitHome(page, 'p.load.ready === true', 90_000);
    expect(await contexts(page), 'nothing before any gesture').toEqual([]);
    // a click elsewhere on the loading screen is a gesture, but not the press: still nothing
    await page.mouse.click(60, 60);
    await page.waitForTimeout(300);
    expect(await contexts(page), 'a stray click makes no context').toEqual([]);
    const before = await sound(page);
    expect(before.state).toBe('locked');
    expect(before.shared, 'the room plays on the home’s engine').toBe(true);

    await page.locator('[data-ui="loading-start"]').click();
    await waitSound(page, "s.state === 'running'");
    let made = await contexts(page);
    expect(made, 'one context').toHaveLength(1);
    expect(made[0]?.activation, 'made inside the press').toBe(true);
    // synchronously in the press's own click handler (not on the activation a stray click left behind)
    expect(made[0]?.event).toBe('click');
    expect(made[0]?.trusted).toBe(true);
    expect(made[0]?.engines, 'one engine on it').toBe(1);
    expect(made[0]?.state).toBe('running');
    // the home probe copies the gate's state once per frame
    await expect.poll(() => homeAudio(page), { timeout: 2_000 }).toBe('running');

    // the home: the press rang, and a hovered drop rings, on that engine
    await waitHome(page, "p.screen === 'home' && p.transition === null");
    const ui0 = (await gate(page)).uiVoices;
    expect(ui0, 'the press rang').toBeGreaterThan(0);
    await page.locator('[data-item="continue"]').hover();
    await expect.poll(async () => (await gate(page)).uiVoices, { timeout: 3_000 }).toBeGreaterThan(ui0);

    // dive and play: 拾う, 覗く (its end is silent)
    await page.locator('[data-item="start"]').click();
    await waitHome(page, "p.screen === 'game' && p.transition === null", 60_000);
    await waitRoom(page, 'r.ready && r.playing');
    expect((await sound(page)).playedCount, 'the home and the dive make no room sounds').toBe(0);
    await takeAndPeek(page);
    await page.waitForTimeout(300);

    const events = (await room(page)).events;
    const now = await both(page);
    made = await contexts(page);
    writeFileSync(
      join(root, `artifacts/S-18/home-${backend}.json`),
      JSON.stringify({ backend, contexts: made, events, ...now, errors }, null, 2),
    );
    expect(made, 'still one context after the dive and the play').toHaveLength(1);
    expect(made[0]?.engines).toBe(1);
    expect(made[0]?.state).toBe('running');
    // the drops and the room rang, and only the engine's limiter reaches the speakers: both went through its
    // buses and its master, so both follow its four volumes
    expect(made[0]?.speakers, 'connections into the speakers').toBe(1);
    // the S-16 sounds, unchanged: one cue per event, in order, from the hand
    expect(events).toEqual(['pickup:bench', 'peekStart', 'peekEnd']);
    expect(now.sound.played.map(({ event, cue }) => ({ event, cue }))).toEqual(expectedCues(events));
    expect(now.sound.played.every((p) => p.source === 'hand')).toBe(true);
    expect(now.sound.refusedCount).toBe(0);
    expect(now.sound.voicesStarted).toBe(now.sound.playedCount);
    // one engine counted both: every voice it started is the UI's or the room's
    expect(now.gate.voicesStarted).toBe(now.gate.uiVoices + now.sound.voicesStarted);
    expect(now.gate.voicesDropped).toBe(0);
    // its four volumes are the game's (src/audio/levels.ts), its space the workshop (S-16)
    expect(now.gate.volumes).toEqual(VIDRO_VOLUMES);
    expect(now.gate.room).toBe('workshop');
    expect(now.sound.room).toBe('workshop');
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-18 direct: the room makes its own AudioContext, one, on the first gesture (S-16) [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    mkdirSync(join(root, 'artifacts/S-18'), { recursive: true });
    const errors = collectErrors(page);
    await countContexts(page);
    await page.goto(`/?scene=prologue-proto&direct=1${webgl}`);
    await waitRoom(page, 'r.ready && r.playing', 60_000);
    expect(await contexts(page), 'nothing before the first gesture').toEqual([]);
    const before = await sound(page);
    expect(before.state).toBe('locked');
    expect(before.shared).toBe(false);

    await takeAndPeek(page);
    await page.waitForTimeout(300);
    const events = (await room(page)).events;
    const s = await sound(page);
    const made = await contexts(page);
    writeFileSync(
      join(root, `artifacts/S-18/direct-${backend}.json`),
      JSON.stringify({ backend, contexts: made, events, sound: s, errors }, null, 2),
    );
    expect(made, 'one context').toHaveLength(1);
    expect(made[0]?.activation, 'made inside the first gesture').toBe(true);
    // in the room's own gesture listener, on the press of the mouse (S-16)
    expect(made[0]?.event).toBe('pointerdown');
    expect(made[0]?.trusted).toBe(true);
    expect(made[0]?.engines, 'one engine on it').toBe(1);
    expect(made[0]?.speakers, 'only the engine’s limiter reaches the speakers').toBe(1);
    expect(made[0]?.state).toBe('running');
    expect(s.state).toBe('running');
    expect(events).toEqual(['pickup:bench', 'peekStart', 'peekEnd']);
    expect(s.played.map(({ event, cue }) => ({ event, cue }))).toEqual(expectedCues(events));
    expect(s.refusedCount).toBe(0);
    expect(s.voicesStarted).toBe(s.playedCount);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-18 home-dive: one AudioContext from 「はじめる」 (Enter), the same after Esc and a second press [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await countContexts(page);
    await page.goto(`/?scene=home-dive&quality=mid${webgl}`);
    await waitHome(page, 'p.load.ready === true', 60_000);
    const startDrop = page.locator('[data-ui="loading-start"]');
    await expect(startDrop).toBeFocused({ timeout: 10_000 });
    expect(await contexts(page)).toEqual([]);
    expect(await homeAudio(page)).toBe('locked');

    // keyboard only: Enter on the focused 「はじめる」
    await page.keyboard.press('Enter');
    await expect.poll(() => homeAudio(page), { timeout: 5_000 }).toBe('running');
    let made = await contexts(page);
    expect(made).toHaveLength(1);
    expect(made[0]?.activation, 'made inside the key press').toBe(true);
    // Enter on a button clicks it: made in that click's handler
    expect(made[0]?.event).toBe('click');
    expect(made[0]?.trusted).toBe(true);
    expect(made[0]?.engines).toBe(1);

    // Esc plays the opening back to the loading screen; pressing again keeps the same context
    await waitHome(page, "p.transition && p.transition.id === 'loading-home' && p.transition.elapsed > 0.3");
    await page.keyboard.press('Escape');
    await waitHome(page, "p.screen === 'loading' && p.transition === null");
    await startDrop.click();
    await waitHome(page, "p.screen === 'home' && p.transition === null");
    const g0 = await gate(page);
    await page.locator('[data-item="continue"]').hover();
    await expect
      .poll(async () => (await gate(page)).uiVoices, { timeout: 3_000 })
      .toBeGreaterThan(g0.uiVoices);
    const g = await gate(page);
    made = await contexts(page);
    expect(made, 'still one').toHaveLength(1);
    expect(made[0]?.engines).toBe(1);
    expect(made[0]?.speakers, 'the pings go through the engine, not straight to the speakers').toBe(1);
    expect(made[0]?.state).toBe('running');
    expect(g.contexts).toBe(1);
    // only the UI rings in this world: the engine's voices are its pings
    expect(g.voicesStarted).toBe(g.uiVoices);
    expect(g.volumes).toEqual(VIDRO_VOLUMES);
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`S-18 leaving: the home path’s one context is closed with the scene [${backend}]`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    await countContexts(page);
    // ?quality=auto pinned to another preset recreates the scene after the window: the first instance is disposed
    await page.goto(
      `/?scene=prologue-proto&quality=auto&autoFrom=mid&autoForce=low&autoWindow=30&dynres=0${webgl}`,
    );
    await waitHome(page, 'p.load.ready === true', 60_000);
    // hold on to the first instance's probes (their getters keep reading that instance after it is gone)
    const instances = await page.evaluate(() => {
      const p = window.__vidro.sceneProbe as { audioGate: unknown; sound: unknown };
      (window as unknown as { __s18first: unknown }).__s18first = { gate: p.audioGate, sound: p.sound };
      return window.__vidro.sceneInstances;
    });
    expect(instances).toBe(1);
    await page.locator('[data-ui="loading-start"]').click();
    await waitSound(page, "s.state === 'running'");
    expect(await page.evaluate(() => window.__vidro.sceneInstances), 'pressed before the switch').toBe(1);
    expect(await contexts(page)).toHaveLength(1);

    await page.waitForFunction(() => window.__vidro.sceneInstances >= 2, undefined, { timeout: 60_000 });
    await expect.poll(async () => (await contexts(page))[0]?.state, { timeout: 5_000 }).toBe('closed');
    const first = await page.evaluate(
      () => (window as unknown as { __s18first: { gate: GateProbe; sound: SoundProbe } }).__s18first,
    );
    expect(first.gate.state).toBe('closed');
    expect(first.sound.disposed).toBe(true);
    expect(first.sound.emitters).toBe(0);
    // the next instance waits for its own press: no new context yet
    await waitHome(page, 'p.load.ready === true', 60_000);
    expect(await contexts(page)).toHaveLength(1);
    expect((await sound(page)).state).toBe('locked');
    expect(await homeAudio(page)).toBe('locked');
    expect((await page.evaluate(() => window.__vidro.errors)) ?? []).toEqual([]);
    expect(errors).toEqual([]);
  });
}
