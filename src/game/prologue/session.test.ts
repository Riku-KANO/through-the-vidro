import { describe, expect, it } from 'vitest';
import { splitFooting, type Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS, MATERIALIZE_SECONDS } from '../../layers/materialize';
import type { SettleSweep } from '../../layers/settle';
import { SURFACE_SEGMENT, splitSurface } from '../../layers/surface';
import { PEEK_FOV_DELTA_DEG, PEEK_SECONDS, peekFovOffset, peekMoveSpeedMultiplier } from '../orb/peek';
import { combineModifiers } from '../player/motion';
import type { PrologueEvent } from './events';
import {
  CALL_FALL_SECONDS,
  CALL_RISE_SECONDS,
  DROP_FLIGHT_SECONDS,
  FILM_SECONDS,
  FINALE_SECONDS,
  type FinaleEvent,
  GATE_OPEN_SECONDS,
  GATE_OPENS_AT_SECONDS,
  type HintEvent,
  membraneHolds,
  PrologueSession,
  peekModifier,
  SETTLE_SECONDS,
  type SessionOptions,
  SHAKE_SECONDS,
  vidroCalls,
  WHISPER_GAP_SECONDS,
  WHISPER_RESET_SECONDS,
  whisperDue,
  whisperGap,
} from './session';

const PEDESTAL = 'p';
const ORB_AT: Vec3 = [-1, 1.05, 0];
/** A bridge from x = 0 to 3 along +X, deck top at 0 (inside a 4 m sphere around ORB_AT). */
const footing = splitFooting('bridge', { min: [0, -0.14, -0.6], max: [3, 0, 0.6] }, 0.4);
const options: SessionOptions = {
  orbStart: 'bench',
  pedestals: { [PEDESTAL]: ORB_AT },
  footing,
  drop: [2.8, 1.2, 0],
};
const NEAR_LEDGE: Vec3 = [-0.4, 0, 0];
const ON_BRIDGE: Vec3 = [0.5, 0, 0];
const DT = 1 / 60;

function run(s: PrologueSession, seconds: number, wantPeek = false): void {
  for (let t = 0; t < seconds - 1e-9; t += DT) s.step(DT, { wantPeek });
}

function record(s: PrologueSession): PrologueEvent[] {
  const out: PrologueEvent[] = [];
  s.events.on((e) => out.push(e));
  return out;
}

function inHand(): PrologueSession {
  return new PrologueSession({ ...options, orbStart: 'hand' });
}

function placed(): PrologueSession {
  const s = inHand();
  s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE);
  run(s, MATERIALIZE_SECONDS + 0.1);
  return s;
}

describe('the orb on the workbench (世界観 > 主人公: 作業台のビードロを手にする)', () => {
  it('starts on the bench: nothing to peek through yet', () => {
    const s = new PrologueSession(options);
    const events = record(s);
    expect(s.orbPlace).toBe('bench');
    expect(s.canPeek).toBe(false);
    run(s, 0.5, true);
    s.refusePeek();
    expect(s.peekAmount).toBe(0);
    expect(s.shake).toBe(0);
    expect(events).toEqual([]);
  });

  it('taking it from the bench brings it into the hand in 0.25 s', () => {
    const s = new PrologueSession(options);
    const events = record(s);
    expect(s.interact({ kind: 'bench' }, [0, 0, 0])).toBe('take');
    expect(s.orbPlace).toBe('hand');
    expect(events).toEqual([{ type: 'pickup', from: 'bench' }]);
    run(s, PEEK_SECONDS + 0.02);
    expect(s.handPresence).toBeCloseTo(1, 5);
    expect(s.canPeek).toBe(true);
    expect(s.interact({ kind: 'bench' }, [0, 0, 0])).toBe('nothing');
  });
});

describe('peeking (覗く: 0.25秒, 移動速度50%, 視野角-6度)', () => {
  it('rises in 0.25 s and announces the start and the end once each', () => {
    const s = inHand();
    const events = record(s);
    run(s, PEEK_SECONDS + 0.02, true);
    expect(s.peeking).toBe(true);
    expect(s.peekAmount).toBeCloseTo(1, 5);
    run(s, 0.3, true);
    run(s, PEEK_SECONDS + 0.02, false);
    expect(s.peekAmount).toBe(0);
    expect(events).toEqual([{ type: 'peekStart' }, { type: 'peekEnd' }]);
  });

  it('blends speed ×0.5 and FOV −6° into the player by the peek amount, like S-02 defines them', () => {
    for (const a of [0, 0.25, 0.5, 1]) {
      const m = combineModifiers([peekModifier(a)]);
      expect(m.speedMultiplier).toBeCloseTo(peekMoveSpeedMultiplier(a), 9);
      expect(m.fovOffsetDeg).toBeCloseTo(peekFovOffset(a), 9);
    }
    expect(combineModifiers([peekModifier(1)]).fovOffsetDeg).toBe(PEEK_FOV_DELTA_DEG);
  });
});

describe('placing (置く: 半径0→4m を0.8秒)', () => {
  it('sets the orb on the pedestal, empties the hand and grows the sphere to 4 m in 0.8 s', () => {
    const s = inHand();
    run(s, PEEK_SECONDS);
    const events = record(s);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE)).toBe('place');
    expect(events).toEqual([{ type: 'place', pedestal: PEDESTAL }]);
    expect(s.orbPlace).toBe('pedestal');
    expect(s.pedestal).toBe(PEDESTAL);
    run(s, MATERIALIZE_SECONDS / 2);
    const mid = s.spheres()[0]?.radius ?? 0;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(MAIN_ORB_RADIUS);
    run(s, MATERIALIZE_SECONDS / 2 + 0.02);
    expect(s.spheres()[0]?.radius).toBeCloseTo(MAIN_ORB_RADIUS, 6);
    expect(s.spheres()[0]?.center).toEqual(ORB_AT);
    expect(s.handPresence).toBeCloseTo(0, 5);
  });

  it('placing while peeking ends the peek', () => {
    const s = inHand();
    run(s, PEEK_SECONDS + 0.02, true);
    const events = record(s);
    s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE);
    run(s, PEEK_SECONDS + 0.02, true);
    expect(s.peekAmount).toBe(0);
    expect(events).toEqual([{ type: 'place', pedestal: PEDESTAL }, { type: 'peekEnd' }]);
  });

  it('while the orb is placed you cannot peek: the placed orb trembles instead', () => {
    const s = placed();
    const events = record(s);
    expect(s.canPeek).toBe(false);
    run(s, 0.3, true);
    expect(s.peekAmount).toBe(0);
    s.refusePeek();
    expect(s.shake).toBeGreaterThan(0.9);
    expect(events).toEqual([{ type: 'shake', reason: 'peek' }]);
    run(s, SHAKE_SECONDS + 0.02);
    expect(s.shake).toBe(0);
  });
});

describe('picking up (拾う: 実体化した足場の上では回収できない)', () => {
  it('refuses while the player stands on bridge footing only this orb holds, and the orb trembles', () => {
    const s = placed();
    const events = record(s);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, ON_BRIDGE)).toBe('pickup-denied');
    expect(s.orbPlace).toBe('pedestal');
    expect(s.spheres()[0]?.radius).toBeCloseTo(MAIN_ORB_RADIUS, 6);
    expect(s.shake).toBeGreaterThan(0.9);
    expect(events).toEqual([{ type: 'shake', reason: 'pickup' }]);
  });

  it('refuses while the player stands in a surface-only wall only this orb cut (S-28), and the orb trembles', () => {
    // 表にしかない壁 across the way before the bridge, wholly inside the sphere: picking the orb up there would bring the
    // wall back around the body
    const wall = splitSurface('wall', { min: [-0.3, 0, -0.6], max: [-0.18, 1, 0.6] }, SURFACE_SEGMENT);
    const s = new PrologueSession({ ...options, orbStart: 'hand', surface: wall });
    s.interact({ kind: 'pedestal', id: PEDESTAL }, [-1.6, 0, 0]);
    run(s, MATERIALIZE_SECONDS + 0.1);
    const events = record(s);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, [-0.24, 0, 0.1])).toBe('pickup-denied');
    expect(s.orbPlace).toBe('pedestal');
    expect(s.spheres()[0]?.radius).toBeCloseTo(MAIN_ORB_RADIUS, 6);
    expect(s.shake).toBeGreaterThan(0.9);
    expect(events).toEqual([{ type: 'shake', reason: 'pickup' }]);
    // a step back, clear of the wall, it comes
    run(s, 0.5);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, [-0.7, 0, 0.1])).toBe('pickup');
    expect(events.at(-1)).toEqual({ type: 'pickup', from: 'pedestal' });
  });

  it('takes the orb back from solid ground and plays the sphere back to 0 in 0.8 s', () => {
    const s = placed();
    const events = record(s);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE)).toBe('pickup');
    expect(events).toEqual([{ type: 'pickup', from: 'pedestal' }]);
    expect(s.orbPlace).toBe('hand');
    run(s, MATERIALIZE_SECONDS + 0.02);
    expect(s.spheres()).toEqual([]);
    expect(s.handPresence).toBeCloseTo(1, 5);
    expect(s.canPeek).toBe(true);
  });

  it('the orb on the bench cannot be set on a pedestal before it is taken', () => {
    const s = new PrologueSession(options);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE)).toBe('nothing');
    expect(s.orbPlace).toBe('bench');
  });
});

describe('the light drop (光の雫: 覗いて見つけ、置いて実体化させてから触れて回収する)', () => {
  it('cannot be touched until it is materialized', () => {
    const s = inHand();
    expect(s.dropMaterialized()).toBe(false);
    expect(s.interact({ kind: 'drop' }, [2.4, 0, 0])).toBe('nothing');
    expect(s.dropState).toBe('waiting');
  });

  it('touched inside the sphere, it flies into the orb and is taken once', () => {
    const s = placed();
    expect(s.dropMaterialized()).toBe(true);
    const events = record(s);
    expect(s.interact({ kind: 'drop' }, [2.4, 0, 0])).toBe('touch-drop');
    expect(s.dropState).toBe('flying');
    run(s, DROP_FLIGHT_SECONDS / 2);
    expect(s.dropProgress).toBeGreaterThan(0.3);
    expect(s.dropProgress).toBeLessThan(0.7);
    run(s, DROP_FLIGHT_SECONDS / 2 + 0.02);
    expect(s.dropState).toBe('taken');
    expect(s.interact({ kind: 'drop' }, [2.4, 0, 0])).toBe('nothing');
    expect(events).toEqual([{ type: 'dropTouched' }, { type: 'dropTaken' }]);
  });

  it('nothing to do with no target', () => {
    expect(placed().interact(null, NEAR_LEDGE)).toBe('nothing');
  });
});

/* ---------- S-34: the close of the prologue — the drop's light settles the bridge, the gate opens ---------- */

/** The light runs from the pedestal's side of the test bridge (x = 0) to its far end (x = 3). */
const SETTLE: SettleSweep = { box: { min: [-0.3, -0.6, -0.8], max: [3.2, 2.2, 0.8] }, direction: [1, 0, 0] };
const ON_FAR_PART: Vec3 = [2.6, 0, 0];

/** The orb placed, the sphere grown, the drop touched and flown into it: the moment it is taken. */
function dropJustTaken(extra: Partial<SessionOptions> = {}): {
  s: PrologueSession;
  events: PrologueEvent[];
  finale: FinaleEvent[];
} {
  const s = new PrologueSession({ ...options, orbStart: 'hand', settle: SETTLE, ...extra });
  s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE);
  run(s, MATERIALIZE_SECONDS + 0.1);
  expect(s.interact({ kind: 'drop' }, [2.4, 0, 0])).toBe('touch-drop');
  const events = record(s);
  const finale: FinaleEvent[] = [];
  s.finaleEvents.on((e) => finale.push(e));
  for (let i = 0; i < 1000 && s.dropState !== 'taken'; i++) s.step(DT, { wantPeek: false });
  return { s, events, finale };
}

describe('S-34: taking the drop settles the bridge and opens the gate (発案者 2026-10-22: 光が世界を戻す)', () => {
  it('before the drop is taken nothing is settled and the gate stays shut', () => {
    const s = new PrologueSession({ ...options, orbStart: 'hand', settle: SETTLE });
    s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE);
    run(s, 3);
    expect(s.settleProgress).toBe(0);
    expect(s.gateProgress).toBe(0);
    expect(s.settleFront).toBeNull();
    expect(s.settledFooting()).toEqual([]);
  });

  it('the light starts across the bridge the moment the drop is taken; the gate waits for it', () => {
    const { s, events, finale } = dropJustTaken();
    expect(events).toEqual([{ type: 'dropTaken' }]);
    expect(finale).toEqual([{ type: 'settle' }]);
    expect(s.settleProgress).toBeLessThan(0.05);
    expect(s.gateProgress).toBe(0);
    expect(s.settleFront).not.toBeNull();
  });

  it('the light is across in 1–2 s (定着の見た目は1〜2秒); the gate starts to open only then (発案者 2026-10-23: 原則4)', () => {
    expect(SETTLE_SECONDS).toBeGreaterThanOrEqual(1);
    expect(SETTLE_SECONDS).toBeLessThanOrEqual(2);
    expect(GATE_OPENS_AT_SECONDS).toBe(SETTLE_SECONDS);
    const { s, finale } = dropJustTaken();
    run(s, SETTLE_SECONDS / 2);
    expect(s.settleProgress).toBeGreaterThan(0.4);
    expect(s.settleProgress).toBeLessThan(0.6);
    // while the light crosses, the gate stays shut
    expect(s.gateProgress).toBe(0);
    expect(finale.map((e) => e.type)).toEqual(['settle']);
    run(s, SETTLE_SECONDS / 2 + 0.02);
    expect(s.settleProgress).toBe(1);
    // the light has reached the far shore: the gate starts to open with it
    expect(finale.map((e) => e.type)).toEqual(['settle', 'settled', 'gateOpen']);
    expect(s.gateProgress).toBeGreaterThan(0);
    expect(s.gateProgress).toBeLessThan(0.05);
    run(s, GATE_OPEN_SECONDS / 2);
    expect(s.gateProgress).toBeGreaterThan(0.45);
    expect(s.gateProgress).toBeLessThan(0.55);
    run(s, GATE_OPEN_SECONDS / 2);
    expect(s.gateProgress).toBe(1);
    expect(finale.map((e) => e.type)).toEqual(['settle', 'settled', 'gateOpen', 'gateOpened']);
    // once each, whatever happens afterwards
    run(s, 5);
    expect(finale).toHaveLength(4);
  });

  it('puts nothing new on the room’s event log: the close is its own (S-16’s table of sounds stays as it is)', () => {
    const { s, events } = dropJustTaken();
    run(s, FINALE_SECONDS + 1);
    expect(events).toEqual([{ type: 'dropTaken' }]);
  });

  it('fixes the bridge segment by segment as the light passes, from the pedestal’s side to the far side', () => {
    const { s } = dropJustTaken();
    let last: readonly string[] = [];
    let grew = 0;
    for (let t = 0; t < SETTLE_SECONDS + 0.1; t += DT) {
      s.step(DT, { wantPeek: false });
      const now = s.settledFooting();
      // never takes a segment back, and always the nearest ones first
      expect(now.slice(0, last.length)).toEqual(last);
      if (now.length > last.length) grew++;
      last = now;
    }
    expect(grew).toBeGreaterThan(3);
    expect(last).toEqual(footing.map((f) => f.id));
  });

  it('picked up after the light, the vidro’s sphere goes but the bridge stays settled', () => {
    const { s } = dropJustTaken();
    run(s, SETTLE_SECONDS + 0.1);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE)).toBe('pickup');
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.spheres()).toEqual([]);
    expect(s.settledFooting()).toEqual(footing.map((f) => f.id));
    // the gate goes on opening, it does not close again
    run(s, GATE_OPEN_SECONDS);
    expect(s.gateProgress).toBe(1);
  });
});

describe('S-34: picking up on the settled bridge (拾う前の確かめ: S-02 の「裏の足場の上では拾えない」の例外)', () => {
  it('on the settled bridge the vidro comes: picking it up cannot drop you any more', () => {
    const { s } = dropJustTaken();
    run(s, SETTLE_SECONDS + 0.1);
    const events = record(s);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, ON_BRIDGE)).toBe('pickup');
    expect(events).toEqual([{ type: 'pickup', from: 'pedestal' }]);
    expect(s.orbPlace).toBe('hand');
  });

  it('while the light has not reached where you stand, the pickup is still refused there (and the orb trembles)', () => {
    const { s } = dropJustTaken();
    run(s, SETTLE_SECONDS * 0.3);
    expect(s.settledFooting().length).toBeGreaterThan(0);
    expect(s.settledFooting().length).toBeLessThan(footing.length);
    const events = record(s);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, ON_FAR_PART)).toBe('pickup-denied');
    expect(events).toEqual([{ type: 'shake', reason: 'pickup' }]);
    // on a segment the light has already fixed, it comes
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, [0.1, 0, 0])).toBe('pickup');
  });

  it('a surface-only wall in the light’s way is fixed as cut: standing in it after the light, the pickup is allowed', () => {
    const wall = splitSurface('wall', { min: [-0.25, 0, -0.6], max: [-0.13, 1, 0.6] }, SURFACE_SEGMENT);
    const { s } = dropJustTaken({ surface: wall });
    run(s, SETTLE_SECONDS + 0.1);
    expect(s.settledSurface()).toEqual(wall.map((w) => w.id));
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, [-0.19, 0, 0.1])).toBe('pickup');
  });

  it('standing in a surface-only wall the light has not reached yet, the pickup is still refused (S-28), and allowed once it has', () => {
    // beside the far part of the bridge (off its footing), wholly inside the placed orb's sphere and the light's box
    const wall = splitSurface('wall', { min: [1.8, 0, 0.62], max: [2.2, 1, 0.74] }, SURFACE_SEGMENT);
    const { s } = dropJustTaken({ surface: wall });
    const inWall: Vec3 = [2.0, 0, 0.68];
    run(s, SETTLE_SECONDS * 0.3);
    expect(s.settledSurface()).toEqual([]);
    const events = record(s);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, inWall)).toBe('pickup-denied');
    expect(events).toEqual([{ type: 'shake', reason: 'pickup' }]);
    run(s, SETTLE_SECONDS);
    expect(s.settledSurface()).toEqual(wall.map((w) => w.id));
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, inWall)).toBe('pickup');
  });

  it('without a sweep (layers-lab, or a room with nothing to settle) taking the drop settles nothing', () => {
    const s = placed();
    s.interact({ kind: 'drop' }, [2.4, 0, 0]);
    run(s, DROP_FLIGHT_SECONDS + SETTLE_SECONDS + 0.2);
    expect(s.dropState).toBe('taken');
    expect(s.settledFooting()).toEqual([]);
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, ON_BRIDGE)).toBe('pickup-denied');
  });
});

/* ---------- S-35: the vidro left behind (発案者 2026-10-23: 玉を持たずに坂道へは出られない) ---------- */

/** A film across z = -5 (the slope's entrance), the far shore's side at z > -5. */
const FILM = { z: -5, callReach: 0.9 };
const AT_FILM: Vec3 = [0, 0, FILM.z + 0.3];
const SHORE: Vec3 = [0, 0, FILM.z + 4];
const PAST: Vec3 = [0, 0, FILM.z - 2];

describe('S-35: the film at the slope’s entrance holds whoever has left the vidro behind (判定は純粋関数)', () => {
  it('holds a body coming from the shore without the vidro in hand — on the pedestal or still on the bench', () => {
    expect(membraneHolds('pedestal', AT_FILM[2], FILM.z)).toBe(true);
    expect(membraneHolds('bench', SHORE[2], FILM.z)).toBe(true);
  });

  it('with the vidro in hand there is nothing to it', () => {
    expect(membraneHolds('hand', AT_FILM[2], FILM.z)).toBe(false);
    expect(membraneHolds('hand', SHORE[2], FILM.z)).toBe(false);
  });

  it('never holds someone already past it (they walk on, down or back)', () => {
    expect(membraneHolds('pedestal', PAST[2], FILM.z)).toBe(false);
    expect(membraneHolds('pedestal', FILM.z - 0.01, FILM.z)).toBe(false);
  });

  it('the vidro calls only while the film — there once the gate opens — holds someone right at it, pushing on', () => {
    expect(vidroCalls('pedestal', AT_FILM[2], FILM, true, true)).toBe(true);
    // standing by the film, not trying to go through: quiet — unless it was already calling (you let go and turn round)
    expect(vidroCalls('pedestal', AT_FILM[2], FILM, true, false)).toBe(false);
    expect(vidroCalls('pedestal', AT_FILM[2], FILM, true, false, true)).toBe(true);
    // once you step back from the film, or have the vidro in hand, it stops even so
    expect(vidroCalls('pedestal', FILM.z + FILM.callReach + 0.1, FILM, true, false, true)).toBe(false);
    expect(vidroCalls('hand', AT_FILM[2], FILM, true, false, true)).toBe(false);
    // the gate still shut: no film yet, so nothing to call about (the shut gate stops you on its own)
    expect(vidroCalls('pedestal', AT_FILM[2], FILM, false, true)).toBe(false);
    // further back on the shore, past the film, or with the vidro in hand: quiet
    expect(vidroCalls('pedestal', FILM.z + FILM.callReach + 0.1, FILM, true, true)).toBe(false);
    expect(vidroCalls('pedestal', PAST[2], FILM, true, true)).toBe(false);
    expect(vidroCalls('hand', AT_FILM[2], FILM, true, true)).toBe(false);
  });
});

describe('S-35: the session’s film and the vidro’s call (そのとき台座の玉がかすかに光って知らせる)', () => {
  /** The close played through to the gate open, the vidro on the pedestal, standing on the far shore. */
  function gateOpen(): PrologueSession {
    const { s } = dropJustTaken({ membrane: FILM });
    for (let t = 0; t < FINALE_SECONDS + 0.1; t += DT) s.step(DT, { wantPeek: false, feet: SHORE });
    return s;
  }

  it('the film comes up with the gate while the vidro is on its pedestal, and goes once it is back in hand', () => {
    const { s } = dropJustTaken({ membrane: FILM });
    expect(s.film).toBe(0);
    for (let t = 0; t < FINALE_SECONDS + 0.1; t += DT) s.step(DT, { wantPeek: false, feet: SHORE });
    expect(s.film).toBe(1);
    expect(s.holdsAtMembrane(AT_FILM[2])).toBe(true);
    // back over the (test) bridge and the vidro picked up: the film fades in FILM_SECONDS and holds no one
    expect(s.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE)).toBe('pickup');
    expect(s.holdsAtMembrane(AT_FILM[2])).toBe(false);
    run(s, FILM_SECONDS / 2);
    expect(s.film).toBeGreaterThan(0);
    expect(s.film).toBeLessThan(1);
    run(s, FILM_SECONDS / 2 + 0.02);
    expect(s.film).toBe(0);
  });

  it('the vidro calls once you push on at the film, still while you stand there and turn round, and falls quiet as you step back', () => {
    const s = gateOpen();
    expect(s.call).toBe(0);
    // standing at the film: nothing yet
    for (let t = 0; t < 1; t += DT) s.step(DT, { wantPeek: false, feet: AT_FILM });
    expect(s.call).toBe(0);
    for (let t = 0; t < CALL_RISE_SECONDS + 0.02; t += DT)
      s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    expect(s.call).toBe(1);
    // let go where you stand (and turn round to look for it): it keeps calling
    for (let t = 0; t < 3; t += DT) s.step(DT, { wantPeek: false, feet: AT_FILM });
    expect(s.call).toBe(1);
    // a step back: it fades slower than it came
    for (let t = 0; t < CALL_FALL_SECONDS / 2; t += DT)
      s.step(DT, { wantPeek: false, feet: SHORE, pushing: true });
    expect(s.call).toBeGreaterThan(0.1);
    expect(s.call).toBeLessThan(0.9);
    for (let t = 0; t < CALL_FALL_SECONDS / 2 + 0.02; t += DT) s.step(DT, { wantPeek: false, feet: SHORE });
    expect(s.call).toBe(0);
  });

  it('says nothing on the room’s event log (S-34: no new kinds there)', () => {
    const s = gateOpen();
    const events = record(s);
    for (let t = 0; t < 2; t += DT) s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    expect(events).toEqual([]);
  });

  it('without a membrane in the options (other rooms) there is no film, no call, no hold', () => {
    const { s } = dropJustTaken();
    for (let t = 0; t < FINALE_SECONDS + 0.1; t += DT)
      s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    expect(s.film).toBe(0);
    expect(s.call).toBe(0);
    expect(s.holdsAtMembrane(AT_FILM[2])).toBe(false);
  });
});

/* ---------- S-39: 玉のささやき (ヒント設計 2; 設計書 rev 49: 台座の玉がかすかに光り、小さく鳴って知らせる) ---------- */

describe('S-39: when it whispers (判定は純粋関数: the call and the time since the last whisper)', () => {
  it('whispers the moment the vidro starts calling, and while it calls, again once the gap has passed — never sooner', () => {
    expect(whisperDue(true, null)).toBe(true);
    expect(whisperDue(true, WHISPER_GAP_SECONDS - 0.01)).toBe(false);
    expect(whisperDue(true, WHISPER_GAP_SECONDS)).toBe(true);
    // not calling: never (standing at the film without pushing, the vidro in hand, away from the film)
    expect(whisperDue(false, null)).toBe(false);
    expect(whisperDue(false, WHISPER_GAP_SECONDS * 3)).toBe(false);
  });

  it('the gap is long enough not to nag and short enough to be heard again while you stand there (仮: 2–6 s)', () => {
    expect(WHISPER_GAP_SECONDS).toBeGreaterThanOrEqual(2);
    expect(WHISPER_GAP_SECONDS).toBeLessThanOrEqual(6);
    // longer than the call takes to fade (a step back and straight in again is not a new call to whisper about)
    expect(WHISPER_GAP_SECONDS).toBeGreaterThan(CALL_FALL_SECONDS);
  });

  it('the gaps widen while it calls on, so it does not nag (発案者の判断: だんだん間を広げる), and stop widening', () => {
    expect(whisperGap(1)).toBe(WHISPER_GAP_SECONDS);
    expect(whisperGap(2)).toBeGreaterThan(whisperGap(1));
    expect(whisperGap(3)).toBeGreaterThan(whisperGap(2));
    expect(whisperGap(10)).toBe(whisperGap(3));
    // before any whisper (a new call) the first gap holds
    expect(whisperGap(0)).toBe(WHISPER_GAP_SECONDS);
  });
});

describe('S-39: the session’s whisper, on its own bus (not the room’s event log: S-16’s table of sounds)', () => {
  /** The close played through to the gate open, the vidro on the pedestal, standing on the far shore; its hints recorded. */
  function gateOpen(): {
    s: PrologueSession;
    hints: HintEvent[];
    events: PrologueEvent[];
    finale: FinaleEvent[];
  } {
    const { s, finale } = dropJustTaken({ membrane: FILM });
    for (let t = 0; t < FINALE_SECONDS + 0.1; t += DT) s.step(DT, { wantPeek: false, feet: SHORE });
    const hints: HintEvent[] = [];
    s.hintEvents.on((e) => hints.push(e));
    finale.length = 0;
    return { s, hints, events: record(s), finale };
  }
  const stepFor = (s: PrologueSession, seconds: number, input: { feet: Vec3; pushing?: boolean }): void => {
    for (let t = 0; t < seconds - 1e-9; t += DT) s.step(DT, { wantPeek: false, ...input });
  };

  it('whispers once, in the very step the vidro starts calling (the call’s own hysteresis), not before', () => {
    const { s, hints } = gateOpen();
    // walking up to the film and standing there: quiet
    stepFor(s, 1, { feet: AT_FILM });
    expect(hints).toEqual([]);
    expect(s.call).toBe(0);
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    expect(s.call).toBeGreaterThan(0);
    expect(hints).toEqual([{ type: 'whisper' }]);
    // still pushing: no more until the gap
    stepFor(s, WHISPER_GAP_SECONDS - 0.1, { feet: AT_FILM, pushing: true });
    expect(hints).toHaveLength(1);
  });

  it('while it keeps calling (you let go and turn round to look for it) it whispers again, the gaps widening', () => {
    const { s, hints } = gateOpen();
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    stepFor(s, WHISPER_GAP_SECONDS + 0.05, { feet: AT_FILM });
    expect(hints).toHaveLength(2);
    // the next one a wider gap later, and wider again after it
    stepFor(s, whisperGap(2) - 0.1, { feet: AT_FILM });
    expect(hints).toHaveLength(2);
    stepFor(s, 0.1, { feet: AT_FILM });
    expect(hints).toHaveLength(3);
    stepFor(s, whisperGap(3) - 0.1, { feet: AT_FILM });
    expect(hints).toHaveLength(3);
    stepFor(s, 0.1, { feet: AT_FILM });
    expect(hints).toHaveLength(4);
  });

  it('stepping away from the film for a while, the gaps start again from the first', () => {
    const { s, hints } = gateOpen();
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    stepFor(s, WHISPER_GAP_SECONDS + whisperGap(2) + 0.1, { feet: AT_FILM });
    expect(hints).toHaveLength(3);
    // away a little longer than the reset (counted from the step it stops calling), then in again pushing: at once, then the
    // first gap again
    stepFor(s, WHISPER_RESET_SECONDS + 0.1, { feet: SHORE });
    expect(hints).toHaveLength(3);
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    expect(hints).toHaveLength(4);
    stepFor(s, WHISPER_GAP_SECONDS + 0.05, { feet: AT_FILM, pushing: true });
    expect(hints).toHaveLength(5);
  });

  it('away a little shorter than the reset, the widened gap holds (a step back and in again is not a new call)', () => {
    const { s, hints } = gateOpen();
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    stepFor(s, WHISPER_GAP_SECONDS + 0.05, { feet: AT_FILM });
    expect(hints).toHaveLength(2);
    // the next gap is the wider one; away a little shorter than the reset, and in again pushing
    stepFor(s, WHISPER_RESET_SECONDS - 0.3, { feet: SHORE });
    stepFor(s, 0.3, { feet: AT_FILM, pushing: true });
    expect(s.call).toBeGreaterThan(0);
    // past the first gap since the second whisper, and still quiet until the wider one has passed
    stepFor(s, whisperGap(2) - (0.05 + WHISPER_RESET_SECONDS) - 0.1, { feet: AT_FILM, pushing: true });
    expect(hints).toHaveLength(2);
    stepFor(s, 0.2, { feet: AT_FILM, pushing: true });
    expect(hints).toHaveLength(3);
  });

  it('a step back and straight in again does not shorten the gap', () => {
    const { s, hints } = gateOpen();
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    expect(hints).toHaveLength(1);
    // back off the film until the call has gone, and in again pushing
    stepFor(s, CALL_FALL_SECONDS + 0.1, { feet: SHORE });
    expect(s.call).toBe(0);
    stepFor(s, 0.3, { feet: AT_FILM, pushing: true });
    expect(s.call).toBeGreaterThan(0);
    expect(hints).toHaveLength(1);
    // once the gap since the last one has passed, it whispers (still calling)
    stepFor(s, WHISPER_GAP_SECONDS - (CALL_FALL_SECONDS + 0.1 + 0.3) + 0.05, {
      feet: AT_FILM,
      pushing: true,
    });
    expect(hints).toHaveLength(2);
  });

  it('stepping back from the film, it stops whispering; with the vidro in hand it never does', () => {
    const { s, hints } = gateOpen();
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    stepFor(s, 3 * WHISPER_GAP_SECONDS, { feet: SHORE });
    expect(hints).toHaveLength(1);
    const { s: carried, hints: none } = gateOpen();
    expect(carried.interact({ kind: 'pedestal', id: PEDESTAL }, NEAR_LEDGE)).toBe('pickup');
    stepFor(carried, 3 * WHISPER_GAP_SECONDS, { feet: AT_FILM, pushing: true });
    expect(none).toEqual([]);
  });

  it('puts nothing on the room’s event log nor on the close’s bus', () => {
    const { s, hints, events, finale } = gateOpen();
    s.step(DT, { wantPeek: false, feet: AT_FILM, pushing: true });
    stepFor(s, 2 * WHISPER_GAP_SECONDS, { feet: AT_FILM });
    expect(hints.length).toBeGreaterThan(1);
    expect(events).toEqual([]);
    expect(finale).toEqual([]);
  });
});
