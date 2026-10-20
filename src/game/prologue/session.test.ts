import { describe, expect, it } from 'vitest';
import { splitFooting, type Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS, MATERIALIZE_SECONDS } from '../../layers/materialize';
import { PEEK_FOV_DELTA_DEG, PEEK_SECONDS, peekFovOffset, peekMoveSpeedMultiplier } from '../orb/peek';
import { combineModifiers } from '../player/motion';
import type { PrologueEvent } from './events';
import {
  DROP_FLIGHT_SECONDS,
  PrologueSession,
  peekModifier,
  type SessionOptions,
  SHAKE_SECONDS,
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
