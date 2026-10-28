import type { Vec3 } from '../../layers/footing';
import {
  AREA1_CHIMNEY,
  AREA1_PLAZA,
  AREA1_SLOPE,
  AREA1_STREET,
  eastOf,
  eastX,
  NEXT_LAMPS_BY_ROOM,
  ROOM1_ALLEY,
  ROOM1_DROP,
  ROOM1_PEDESTAL,
  ROOM1_WALL,
  ROOM2_BALCONY,
  ROOM2_DROP,
  ROOM2_PEDESTAL_B,
  ROOM2_STAIRS,
  ROOM2_STAIRS_FOOT_Z,
  ROOM3_BRIDGE_N,
  ROOM3_DROP,
  ROOM3_EDGE,
  ROOM3_LOOKOUT,
  ROOM3_PEDESTAL_N,
  ROOM3_RAILING,
  ROOM3_SHADE,
  SHORTCUT_STAIRS,
  SUMMIT_Y,
  TOWN,
} from '../area1/layout';
import type { PlayerIntent } from '../player/player';
import {
  BENCH_ORB,
  COMPASS,
  DROP,
  EDGE_Z,
  FAR,
  GATE,
  LIGHTHOUSE,
  PEDESTAL_ORB,
  PLAZA,
  PLAZA_GATE,
  PLAZA_Y,
  plazaGateAt,
  SLOPE,
} from './layout';
import type { DropState, OrbPlace } from './session';

/**
 * ?autoplay=1: plays the prologue the way a player would, through the same intents (move, look, peek,
 * 置く・拾う・調べる): take the vidro → the one way → the dead end → peek → place → cross → touch the drop
 * → (S-34) watch the light settle the bridge → back over it → pick the vidro up on it → through the open gate
 * → (S-35) the view from the slope's brow → down the slope → across the plaza to its open east gate
 * → (S-36) along the road into the morning → エリア1's entrance plaza, up at the chimney → down the street to 部屋1: peek at the
 * crumbled wall (the drop behind it), place the vidro, through the wall, the drop, back out, the vidro picked up, a look
 * toward the next room (its lamps lighting) → (S-40) 部屋2, 部屋3, the shortcut home to the entrance plaza (area1Script).
 * Presentation timing only (seconds below are not design values).
 */
export interface PilotState {
  feet: Vec3;
  yaw: number;
  pitch: number;
  speed: number;
  target: 'bench' | 'pedestal' | 'drop' | null;
  orb: OrbPlace;
  sphereRadius: number;
  drop: DropState;
  /** S-36: drops taken, all areas together. */
  taken: number;
}

export interface PilotOrder {
  intent: PlayerIntent;
  peek: boolean;
  interact: boolean;
}

type Step =
  | { kind: 'look'; name: string; at: Vec3; seconds: number }
  | { kind: 'walk'; name: string; to: [number, number]; within: number; sprint?: boolean }
  | { kind: 'push'; name: string }
  | { kind: 'peek'; name: string; at: Vec3; seconds: number }
  | { kind: 'use'; name: string; at: Vec3; until: (s: PilotState) => boolean; linger: number };

/** Turning speed of the scripted look, rad/s. */
const TURN = 2.2;
const EYE = 1.6;

const SCRIPT: Step[] = [
  { kind: 'look', name: 'look-bench', at: BENCH_ORB, seconds: 0.8 },
  { kind: 'use', name: 'take', at: BENCH_ORB, until: (s) => s.orb === 'hand', linger: 0.6 },
  { kind: 'walk', name: 'walk-door', to: [0.1, -3.6], within: 0.35 },
  { kind: 'walk', name: 'walk-way', to: [0, -11.4], within: 0.4 },
  { kind: 'push', name: 'dead-end' },
  { kind: 'look', name: 'look-across', at: [0, 1.0, FAR.maxZ - 0.6], seconds: 1.0 },
  { kind: 'peek', name: 'peek', at: [DROP[0], 1.0, DROP[2]], seconds: 2.4 },
  { kind: 'look', name: 'look-pedestal', at: PEDESTAL_ORB, seconds: 0.8 },
  { kind: 'use', name: 'place', at: PEDESTAL_ORB, until: (s) => s.sphereRadius > 3.99, linger: 0.8 },
  { kind: 'look', name: 'look-bridge', at: [0, 0.8, FAR.maxZ], seconds: 0.8 },
  { kind: 'walk', name: 'walk-bridge', to: [0, EDGE_Z - 1.4], within: 0.3 },
  { kind: 'walk', name: 'walk-far', to: [0.45, FAR.maxZ - 0.6], within: 0.3 },
  { kind: 'use', name: 'touch', at: DROP, until: (s) => s.drop === 'taken', linger: 1.0 },
  { kind: 'look', name: 'look-back', at: [PEDESTAL_ORB[0], 1.4, PEDESTAL_ORB[2] + 3], seconds: 2.5 },
  // S-34: the light has settled the bridge: back over it, the vidro picked up on it, through the open gate
  { kind: 'walk', name: 'walk-back', to: [0.1, EDGE_Z - 0.8], within: 0.3 },
  { kind: 'use', name: 'pick-up', at: PEDESTAL_ORB, until: (s) => s.orb === 'hand', linger: 0.8 },
  { kind: 'walk', name: 'walk-over', to: [0.2, FAR.maxZ - 0.8], within: 0.3 },
  { kind: 'walk', name: 'walk-gate', to: [0, GATE.z - 1.8], within: 0.35 },
  // S-35: from the slope's brow the plaza and the broken lighthouse below; down the slope (早歩き: an easy one way), across
  // the plaza round the lighthouse to the open east gate, and a look at it
  { kind: 'look', name: 'look-town', at: [LIGHTHOUSE[0], LIGHTHOUSE[1] + 22, LIGHTHOUSE[2]], seconds: 1.5 },
  { kind: 'walk', name: 'walk-slope', to: [0, SLOPE.toZ - 1.5], within: 0.5, sprint: true },
  { kind: 'walk', name: 'walk-plaza', to: plazaGateAt(COMPASS.east, PLAZA.radius - 3), within: 0.4 },
  {
    kind: 'look',
    name: 'look-east-gate',
    at: (() => {
      const [x, z] = plazaGateAt(COMPASS.east);
      return [x, PLAZA_Y + PLAZA_GATE.height * 0.55, z] as Vec3;
    })(),
    seconds: 1.2,
  },
];

/**
 * S-36: エリア1, from the central plaza's east gate to 部屋1's drop and back out of the alley. S-40: on up the slope — 部屋2 (peek
 * at the balcony, the vidro on B, up the stair, through the wall to the drop, down, the vidro back), up to the summit — 部屋3
 * (peek from the edge, the vidro on the north pedestal, over its bridge to the drop: the third, the shortcut's light runs),
 * back over the bridge for the vidro, over it again and along the ridge, down the shortcut into the entrance plaza.
 */
function area1Script(): Step[] {
  const x = (ROOM1_ALLEY.minX + ROOM1_ALLEY.maxX) / 2 - 0.4;
  const wall = ROOM1_WALL.box;
  const stairX = (ROOM2_STAIRS.minX + ROOM2_STAIRS.maxX) / 2;
  const bridgeZ = (ROOM3_BRIDGE_N.min[2] + ROOM3_BRIDGE_N.max[2]) / 2;
  const stairsX = (SHORTCUT_STAIRS.minX + SHORTCUT_STAIRS.maxX) / 2;
  // S-41: the shelter's east wall (the drop hovers in its lee), and a spot on the roof west of it, by the bridge; S-44: by the slot
  // between the shelter's walls the drop is in reach
  const [wallA, wallB] = ROOM3_SHADE as [(typeof ROOM3_SHADE)[0], (typeof ROOM3_SHADE)[0]];
  const behindWall = eastX(eastOf(wallA.minX) - 0.5);
  // S-44: the lookout's way in (east of its walls), and north of them, round them
  const lookoutWay = eastX(eastOf(ROOM3_LOOKOUT.floor.maxX) + 0.7);
  const northOfLookout = ROOM3_RAILING.box.max[2] + 0.6;
  return [
    {
      kind: 'walk',
      name: 'walk-road',
      // 4 m short of the entrance plaza's centre, along the east
      to: [eastX(eastOf(AREA1_PLAZA.center[0]) - 4), AREA1_PLAZA.center[2]],
      within: 0.6,
      sprint: true,
    },
    {
      kind: 'look',
      name: 'look-area1',
      at: [AREA1_CHIMNEY.foot[0], TOWN.center[1] + AREA1_CHIMNEY.top - 6, AREA1_CHIMNEY.foot[2]],
      seconds: 1.5,
    },
    { kind: 'walk', name: 'walk-street', to: [x, AREA1_STREET.z + 0.6], within: 0.4 },
    { kind: 'walk', name: 'walk-alley', to: [x, wall.min[2] - 0.9], within: 0.3 },
    { kind: 'peek', name: 'peek-wall', at: ROOM1_DROP.at, seconds: 2.0 },
    { kind: 'look', name: 'look-wall-pedestal', at: ROOM1_PEDESTAL.orb, seconds: 0.8 },
    {
      kind: 'use',
      name: 'place-wall',
      at: ROOM1_PEDESTAL.orb,
      until: (s) => s.sphereRadius > 3.99,
      linger: 0.6,
    },
    { kind: 'walk', name: 'walk-through', to: [ROOM1_DROP.at[0] + 0.2, wall.max[2] + 0.6], within: 0.3 },
    { kind: 'use', name: 'touch-drop1', at: ROOM1_DROP.at, until: (s) => s.taken >= 2, linger: 1.0 },
    { kind: 'walk', name: 'walk-out', to: [x, wall.min[2] - 1.0], within: 0.3 },
    {
      kind: 'use',
      name: 'pick-up-wall',
      at: ROOM1_PEDESTAL.orb,
      until: (s) => s.orb === 'hand',
      linger: 0.6,
    },
    { kind: 'walk', name: 'walk-next', to: [x + 0.4, ROOM1_ALLEY.minZ - 0.9], within: 0.3 },
    {
      kind: 'look',
      name: 'look-next',
      // S-40: the lamps up the first flight toward the courtyard
      at: NEXT_LAMPS_BY_ROOM.room1.at(-1) as Vec3,
      seconds: 1.5,
    },
    // S-40 部屋2「二つの台座の中庭」: up the first flight to the landing, into the courtyard
    { kind: 'walk', name: 'walk-corner', to: [AREA1_SLOPE.x, AREA1_STREET.z], within: 0.4 },
    { kind: 'walk', name: 'walk-flight1', to: [AREA1_SLOPE.x, -143.0], within: 0.4 },
    { kind: 'walk', name: 'walk-court', to: [eastX(127.6), -144.6], within: 0.3 },
    { kind: 'peek', name: 'peek-court', at: ROOM2_DROP.at, seconds: 2.0 },
    { kind: 'look', name: 'look-court-b', at: ROOM2_PEDESTAL_B.orb, seconds: 0.8 },
    {
      kind: 'use',
      name: 'place-court',
      at: ROOM2_PEDESTAL_B.orb,
      until: (s) => s.sphereRadius > 3.99,
      linger: 0.6,
    },
    { kind: 'walk', name: 'walk-stair-foot', to: [stairX, ROOM2_STAIRS_FOOT_Z - 0.8], within: 0.3 },
    { kind: 'walk', name: 'walk-stair', to: [stairX, ROOM2_BALCONY.minZ + 0.6], within: 0.3 },
    { kind: 'walk', name: 'walk-balcony', to: [ROOM2_DROP.at[0] + 0.5, ROOM2_DROP.at[2]], within: 0.3 },
    { kind: 'use', name: 'touch-drop2', at: ROOM2_DROP.at, until: (s) => s.taken >= 3, linger: 1.0 },
    { kind: 'walk', name: 'walk-balcony-back', to: [stairX, ROOM2_BALCONY.minZ + 0.6], within: 0.3 },
    { kind: 'walk', name: 'walk-stair-down', to: [stairX, ROOM2_STAIRS_FOOT_Z - 0.8], within: 0.3 },
    { kind: 'walk', name: 'walk-court-b', to: [ROOM2_PEDESTAL_B.base[0], -144.9], within: 0.3 },
    {
      kind: 'use',
      name: 'pick-up-court',
      at: ROOM2_PEDESTAL_B.orb,
      until: (s) => s.orb === 'hand',
      linger: 0.6,
    },
    // S-40 部屋3「煙突の見晴らし」: up the second flight to the summit, peek from the edge, the vidro on the north pedestal
    { kind: 'walk', name: 'walk-landing', to: [AREA1_SLOPE.x, -144.0], within: 0.4 },
    { kind: 'walk', name: 'walk-flight2', to: [AREA1_SLOPE.x, AREA1_SLOPE.toZ - 1.0], within: 0.4 },
    // S-44: into the lookout at the valley's front by its way in
    { kind: 'walk', name: 'walk-lookout', to: [lookoutWay, ROOM3_EDGE[2]], within: 0.3 },
    { kind: 'walk', name: 'walk-edge', to: [ROOM3_EDGE[0], ROOM3_EDGE[2]], within: 0.3 },
    // S-41, S-44: from the lookout, past its crumbled wall and through the shelter's slot, the drop in its lee (覗いたときだけ見通せる)
    { kind: 'peek', name: 'peek-valley', at: ROOM3_DROP.at, seconds: 2.4 },
    { kind: 'walk', name: 'walk-lookout-out', to: [lookoutWay, ROOM3_EDGE[2]], within: 0.3 },
    { kind: 'walk', name: 'walk-lookout-north', to: [lookoutWay, northOfLookout], within: 0.3 },
    { kind: 'walk', name: 'walk-pedestal-n', to: [eastX(114.6), bridgeZ], within: 0.3 },
    { kind: 'look', name: 'look-pedestal-n', at: ROOM3_PEDESTAL_N.orb, seconds: 0.8 },
    {
      kind: 'use',
      name: 'place-summit',
      at: ROOM3_PEDESTAL_N.orb,
      until: (s) => s.sphereRadius > 3.99,
      linger: 0.6,
    },
    { kind: 'walk', name: 'walk-bridge-n', to: [eastX(110.8), bridgeZ], within: 0.3 },
    // S-44: onto the roof where the bridge lands, by the slot between the shelter's walls (the drop in its lee within reach)
    { kind: 'walk', name: 'walk-lee', to: [eastX(eastOf(wallA.minX) - 0.15), wallB.minZ - 0.4], within: 0.2 },
    { kind: 'use', name: 'touch-drop3', at: ROOM3_DROP.at, until: (s) => s.taken >= 4, linger: 0.4 },
    // the third drop: its light runs over the bridge and along the ridge, then down the shortcut — watch it go
    {
      kind: 'look',
      name: 'look-shortcut',
      at: [stairsX, SUMMIT_Y - 1, SHORTCUT_STAIRS.topZ + 2],
      seconds: 3.2,
    },
    { kind: 'walk', name: 'walk-roof-back', to: [behindWall, bridgeZ - 0.1], within: 0.3 },
    { kind: 'walk', name: 'walk-bridge-back', to: [eastX(114.6), bridgeZ], within: 0.3 },
    {
      kind: 'use',
      name: 'pick-up-summit',
      at: ROOM3_PEDESTAL_N.orb,
      until: (s) => s.orb === 'hand',
      linger: 0.6,
    },
    // over the settled bridge again, along the ridge to the stairs' top, down into the entrance plaza (帰り道の近道)
    { kind: 'walk', name: 'walk-ridge', to: [stairsX, bridgeZ], within: 0.4, sprint: true },
    { kind: 'walk', name: 'walk-shortcut', to: [stairsX, AREA1_PLAZA.center[2] - 5.5], within: 0.5 },
    {
      kind: 'look',
      name: 'look-home',
      at: [stairsX, SUMMIT_Y + 2, (SHORTCUT_STAIRS.topZ + SHORTCUT_STAIRS.footZ) / 2],
      seconds: 1.2,
    },
  ];
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class Autopilot {
  private index = 0;
  /** The script played: the prologue to the central plaza's east gate, and (extendToArea1) on into エリア1. */
  private script: readonly Step[] = SCRIPT;

  /**
   * S-36: play on past the east gate, along the road into the morning to 部屋1's drop and back out of the alley (?autoplay=1
   * with &autoplayTo=area1; the room calls it before the first step); S-40: on through 部屋2 and 部屋3 and down the shortcut
   * into the entrance plaza. The script alone ends at the east gate as it did, so the sensors that time it (S-38) are as they
   * were.
   */
  extendToArea1(): void {
    if (this.index === 0 && this.script === SCRIPT) this.script = [...SCRIPT, ...area1Script()];
  }

  /**
   * S-40 (its unit test plays エリア1's part in a Rapier world): start at the named step instead of the first (unknown names
   * leave it where it is). Before the first step only.
   */
  startAt(step: string): void {
    const i = this.script.findIndex((s) => s.name === step);
    if (this.index === 0 && i >= 0) this.index = i;
  }
  private elapsed = 0;
  private stillFor = 0;
  private reached = false;
  private pressed = false;

  get current(): string {
    return this.script[this.index]?.name ?? 'done';
  }

  get done(): boolean {
    return this.index >= this.script.length;
  }

  step(dt: number, s: PilotState): PilotOrder {
    const order: PilotOrder = {
      intent: { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 },
      peek: false,
      interact: false,
    };
    const step = this.script[this.index];
    if (!step) return order;
    this.elapsed += dt;
    const eye: Vec3 = [s.feet[0], s.feet[1] + EYE, s.feet[2]];
    const turnTo = (at: Vec3): number => {
      const dx = at[0] - eye[0];
      const dy = at[1] - eye[1];
      const dz = at[2] - eye[2];
      const dYaw = wrap(Math.atan2(-dx, -dz) - s.yaw);
      const dPitch = Math.atan2(dy, Math.hypot(dx, dz)) - s.pitch;
      const max = TURN * dt;
      order.intent.lookYaw = Math.max(-max, Math.min(max, dYaw));
      order.intent.lookPitch = Math.max(-max, Math.min(max, dPitch));
      return Math.hypot(dYaw, dPitch);
    };
    switch (step.kind) {
      case 'look':
        turnTo(step.at);
        if (this.elapsed >= step.seconds) this.next();
        break;
      case 'peek':
        turnTo(step.at);
        order.peek = true;
        if (this.elapsed >= step.seconds) this.next();
        break;
      case 'walk': {
        const [x, z] = step.to;
        // a level look along the way, also down the slope (S-35)
        const off = turnTo([x, s.feet[1] + EYE - 0.3, z]);
        const d = Math.hypot(x - s.feet[0], z - s.feet[2]);
        if (d < step.within) {
          this.next();
          break;
        }
        order.intent.move = { x: 0, y: off < 0.35 ? 1 : 0 };
        order.intent.sprint = step.sprint ?? false;
        break;
      }
      case 'push':
        turnTo([s.feet[0], EYE - 0.2, s.feet[2] - 10]);
        order.intent.move = { x: 0, y: 1 };
        this.stillFor = s.speed < 0.03 && this.elapsed > 0.5 ? this.stillFor + dt : 0;
        if (this.stillFor > 0.4) this.next();
        break;
      case 'use': {
        const off = turnTo(step.at);
        if (!this.pressed && off < 0.05 && s.target !== null) {
          order.interact = true;
          this.pressed = true;
        }
        if (!this.reached && step.until(s)) {
          this.reached = true;
          this.elapsed = 0;
        }
        if (this.reached && this.elapsed >= step.linger) this.next();
        // pressed but nothing happened (refused or out of reach): try again
        if (this.pressed && !this.reached && this.elapsed > 1.5) {
          this.pressed = false;
          this.elapsed = 0;
        }
        break;
      }
    }
    return order;
  }

  private next(): void {
    this.index++;
    this.elapsed = 0;
    this.stillFor = 0;
    this.reached = false;
    this.pressed = false;
  }
}
