import { describe, expect, it } from 'vitest';
import { splitFooting, type Vec3 } from '../../layers/footing';
import { MAIN_ORB_RADIUS, MATERIALIZE_SECONDS } from '../../layers/materialize';
import type { SettleSweep } from '../../layers/settle';
import { cutSurfaceIds } from '../../layers/surface';
import {
  BRIDGE_SETTLE,
  bridgeFooting,
  DROP,
  PEDESTAL_ID,
  PEDESTAL_ORB,
  PROLOGUE_AREA,
} from '../prologue/layout';
import {
  DROP_FLIGHT_SECONDS,
  FINALE_SECONDS,
  type FinaleEvent,
  PrologueSession,
  SETTLE_SECONDS,
} from '../prologue/session';
import {
  type AreaDecl,
  checkAreas,
  DropTally,
  dropsOf,
  footingOf,
  pedestalsOf,
  surfaceOf,
  surfaceSegments,
} from '.';

/*
 * Two rooms side by side along +X, 20 m apart (each room's sphere of 4 m is far from the other's):
 *  - room A "bridge" (the prologue's kind): a pedestal, a back-layer bridge from x 0 to 3 that its sphere holds, the drop on
 *    the far end; its drop's light settles the bridge (S-34)
 *  - room B "wall" (エリア1 部屋1's kind): a pedestal, a surface-only wall across the way 1.5 m on, the drop behind it
 */
const DT = 1 / 60;
const A_ORB: Vec3 = [-1, 1.05, 0];
const B_ORB: Vec3 = [19, 1.05, 0];
const bridge = splitFooting('a-bridge', { min: [0, -0.14, -0.6], max: [3, 0, 0.6] }, 0.4);
const SETTLE: SettleSweep = { box: { min: [-0.05, -1, -1], max: [3.05, 2, 1] }, direction: [1, 0, 0] };
const WALL = { id: 'b-wall', box: { min: [20.2, 0, -1.2], max: [20.6, 2.2, 1.2] } as const };
const ROOM_A = {
  id: 'room-a',
  pedestals: [{ id: 'pa', base: [-1, 0, 0] as Vec3, orb: A_ORB }],
  drop: { id: 'drop-a', at: [2.8, 1.2, 0] as Vec3 },
  footing: [{ id: 'a-bridge', segments: bridge }],
  settle: SETTLE,
};
const ROOM_B = {
  id: 'room-b',
  pedestals: [{ id: 'pb', base: [19, 0, 0] as Vec3, orb: B_ORB }],
  drop: { id: 'drop-b', at: [21.8, 1.2, 0] as Vec3 },
  surface: [WALL],
};
const AREAS: readonly AreaDecl[] = [
  { id: 'one', rooms: [ROOM_A] },
  { id: 'two', rooms: [ROOM_B] },
];

/** Standing places: before A's bridge, on it, before B's wall, in it, behind it. */
const BEFORE_A: Vec3 = [-0.4, 0, 0];
const ON_A: Vec3 = [0.5, 0, 0];
const BEFORE_B: Vec3 = [19.6, 0, 0];
const IN_B: Vec3 = [20.4, 0, 0];
const BEHIND_B: Vec3 = [21.2, 0, 0];

function run(s: PrologueSession, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += DT) s.step(DT, { wantPeek: false });
}

function session(): PrologueSession {
  return new PrologueSession({ orbStart: 'hand', areas: AREAS });
}

describe('rooms declared as data (S-36 エリアの仕組み)', () => {
  it('gives every pedestal, footing segment, surface-only segment and drop of every room, in order', () => {
    expect(pedestalsOf(AREAS)).toEqual({ pa: A_ORB, pb: B_ORB });
    expect(footingOf(AREAS).map((s) => s.id)).toEqual(bridge.map((s) => s.id));
    const wall = surfaceOf(AREAS);
    expect(wall.length).toBeGreaterThan(4);
    expect(wall.every((s) => s.id.startsWith('b-wall:'))).toBe(true);
    // the same segments each time (the session's and the colliders' are one set)
    expect(surfaceOf(AREAS)[0]).toBe(wall[0]);
    expect(surfaceSegments(WALL)).toBe(surfaceSegments(WALL));
    expect(dropsOf(AREAS)).toEqual([
      { id: 'drop-a', area: 'one', room: 'room-a', at: [2.8, 1.2, 0] },
      { id: 'drop-b', area: 'two', room: 'room-b', at: [21.8, 1.2, 0] },
    ]);
  });

  it('says what is wrong: ids twice, a drop no sphere reaches, two settling rooms', () => {
    expect(checkAreas(AREAS, MAIN_ORB_RADIUS)).toEqual([]);
    const twice: AreaDecl[] = [{ id: 'x', rooms: [ROOM_A, { ...ROOM_A, id: 'room-a2' }] }];
    const problems = checkAreas(twice, MAIN_ORB_RADIUS);
    expect(problems.some((p) => p.includes('pedestal "pa"'))).toBe(true);
    expect(problems.some((p) => p.includes('drop "drop-a"'))).toBe(true);
    expect(problems.some((p) => p.includes('2 rooms settle'))).toBe(true);
    const far: AreaDecl[] = [{ id: 'x', rooms: [{ ...ROOM_B, drop: { id: 'd', at: [26, 1.2, 0] } }] }];
    expect(checkAreas(far, MAIN_ORB_RADIUS)).toEqual(['drop "d" lies outside every sphere of room "room-b"']);
  });

  it('the prologue’s workshop is one of them: the same pedestal, bridge, drop and settling as the room had', () => {
    expect(PROLOGUE_AREA.rooms).toHaveLength(1);
    expect(pedestalsOf([PROLOGUE_AREA])).toEqual({ [PEDESTAL_ID]: PEDESTAL_ORB });
    expect(footingOf([PROLOGUE_AREA]).map((s) => [s.id, s.min, s.max])).toEqual(
      bridgeFooting().map((s) => [s.id, s.min, s.max]),
    );
    const [room] = PROLOGUE_AREA.rooms;
    expect(room?.drop.at).toEqual(DROP);
    expect(room?.settle).toBe(BRIDGE_SETTLE);
    expect(checkAreas([PROLOGUE_AREA], MAIN_ORB_RADIUS)).toEqual([]);
  });
});

describe('the drops counted by area (取った雫の数をエリアごとに数える)', () => {
  it('a drop waits, flies when touched, is taken after its flight; the counts follow by area', () => {
    const t = new DropTally(AREAS, DROP_FLIGHT_SECONDS);
    expect(t.counts()).toEqual({ one: { drops: 1, taken: 0 }, two: { drops: 1, taken: 0 } });
    expect(t.touch('drop-b')).toBe(true);
    expect(t.touch('drop-b')).toBe(false);
    expect(t.state('drop-b')).toBe('flying');
    expect(t.step(DROP_FLIGHT_SECONDS / 2)).toEqual([]);
    expect(t.progress('drop-b')).toBeCloseTo(0.5, 5);
    expect(t.step(DROP_FLIGHT_SECONDS / 2 + 0.01)).toEqual(['drop-b']);
    expect(t.state('drop-b')).toBe('taken');
    expect(t.state('drop-a')).toBe('waiting');
    expect(t.taken('two')).toBe(1);
    expect(t.taken('one')).toBe(0);
    // the probe's object is reused
    const out = t.counts();
    expect(t.counts(out)).toBe(out);
    expect(out).toEqual({ one: { drops: 1, taken: 0 }, two: { drops: 1, taken: 1 } });
  });
});

describe('two pedestals in two rooms: 置く・拾う・拾う前の確かめ, each at its own pedestal (S-02, S-28, S-34)', () => {
  it('places on either pedestal; its sphere stands there; the other pedestal does nothing while the vidro is out', () => {
    const s = session();
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B)).toBe('place');
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.pedestal).toBe('pb');
    expect(s.spheres().map((sp) => sp.center)).toEqual([B_ORB]);
    // the vidro is on B: A can neither take it nor be given it
    expect(s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A)).toBe('nothing');
    expect(s.pedestal).toBe('pb');
  });

  it('A: standing on its back-layer bridge the vidro will not come (S-02); off it, it comes', () => {
    const s = session();
    s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.interact({ kind: 'pedestal', id: 'pa' }, ON_A)).toBe('pickup-denied');
    expect(s.shake).toBeGreaterThan(0);
    expect(s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A)).toBe('pickup');
    expect(s.orbPlace).toBe('hand');
  });

  it('B: standing in its cut surface-only wall the vidro will not come (S-28); before or behind the wall, it comes', () => {
    const s = session();
    s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B);
    run(s, MATERIALIZE_SECONDS + 0.1);
    // the whole wall is cut by B's sphere
    expect(cutSurfaceIds(surfaceOf(AREAS), s.spheres())).toHaveLength(surfaceOf(AREAS).length);
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, IN_B)).toBe('pickup-denied');
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B)).toBe('pickup');
    s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, BEHIND_B)).toBe('pickup');
  });

  it('A’s bridge does not hold the pickup at B, nor B’s wall the pickup at A (each pedestal asks of its own sphere)', () => {
    const s = session();
    // B placed: standing on A's bridge (no sphere holds it) does not stop B's pickup
    s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, ON_A)).toBe('pickup');
    run(s, MATERIALIZE_SECONDS + 0.1);
    // A placed: standing in B's wall (which A's sphere does not cut) does not stop A's pickup
    s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.interact({ kind: 'pedestal', id: 'pa' }, IN_B)).toBe('pickup');
  });

  it('the vidro goes to the other pedestal only once its last sphere has shrunk away (S-02 canPlace)', () => {
    const s = session();
    s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A);
    run(s, MATERIALIZE_SECONDS + 0.1);
    s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A);
    run(s, MATERIALIZE_SECONDS / 4);
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B)).toBe('place-denied');
    run(s, MATERIALIZE_SECONDS);
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B)).toBe('place');
  });

  it('S-34: once A’s drop has settled its bridge, the vidro comes on it; B’s wall still holds the pickup at B', () => {
    const s = session();
    const finale: FinaleEvent[] = [];
    s.finaleEvents.on((e) => finale.push(e));
    s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.interact({ kind: 'drop', id: 'drop-a' }, [2.4, 0, 0])).toBe('touch-drop');
    run(s, DROP_FLIGHT_SECONDS + FINALE_SECONDS + 0.1);
    expect(finale.map((e) => e.type)).toEqual(['settle', 'settled', 'gateOpen', 'gateOpened']);
    expect(s.settledFooting()).toHaveLength(bridge.length);
    expect(s.interact({ kind: 'pedestal', id: 'pa' }, ON_A)).toBe('pickup');
    run(s, MATERIALIZE_SECONDS + 0.1);
    s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.interact({ kind: 'pedestal', id: 'pb' }, IN_B)).toBe('pickup-denied');
  });
});

describe('the drops of two rooms, counted by area', () => {
  it('a drop is touched only inside a sphere of its own room’s pedestal; taking it counts in its area', () => {
    const s = session();
    // nothing placed: neither drop is real
    expect(s.dropMaterialized('drop-b')).toBe(false);
    expect(s.interact({ kind: 'drop', id: 'drop-b' }, BEHIND_B)).toBe('nothing');
    // A's sphere does not reach B's drop
    s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.dropMaterialized('drop-a')).toBe(true);
    expect(s.dropMaterialized('drop-b')).toBe(false);
    s.interact({ kind: 'pedestal', id: 'pa' }, BEFORE_A);
    run(s, MATERIALIZE_SECONDS + 0.1);
    s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B);
    run(s, MATERIALIZE_SECONDS + 0.1);
    expect(s.dropMaterialized('drop-b')).toBe(true);
    expect(s.interact({ kind: 'drop', id: 'drop-b' }, BEHIND_B)).toBe('touch-drop');
    expect(s.dropStateOf('drop-b')).toBe('flying');
    run(s, DROP_FLIGHT_SECONDS + 0.05);
    expect(s.dropStateOf('drop-b')).toBe('taken');
    expect(s.dropStateOf('drop-a')).toBe('waiting');
    expect(s.areaCounts()).toEqual({ one: { drops: 1, taken: 0 }, two: { drops: 1, taken: 1 } });
  });

  it('only the settling room’s drop starts the close (S-34); the other drop is just taken', () => {
    const s = session();
    const finale: FinaleEvent[] = [];
    s.finaleEvents.on((e) => finale.push(e));
    s.interact({ kind: 'pedestal', id: 'pb' }, BEFORE_B);
    run(s, MATERIALIZE_SECONDS + 0.1);
    s.interact({ kind: 'drop', id: 'drop-b' }, BEHIND_B);
    run(s, DROP_FLIGHT_SECONDS + SETTLE_SECONDS + 0.1);
    expect(s.dropStateOf('drop-b')).toBe('taken');
    expect(finale).toEqual([]);
    expect(s.finaleElapsed).toBeNull();
    expect(s.settledFooting()).toEqual([]);
  });
});
