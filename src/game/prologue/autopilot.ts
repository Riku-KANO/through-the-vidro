import type { Vec3 } from '../../layers/footing';
import type { PlayerIntent } from '../player/player';
import { BENCH_ORB, DROP, EDGE_Z, FAR, GATE, LIGHTHOUSE, PEDESTAL_ORB } from './layout';
import type { DropState, OrbPlace } from './session';

/**
 * ?autoplay=1: plays the prologue the way a player would, through the same intents (move, look, peek,
 * 置く・拾う・調べる): take the vidro → the one way → the dead end → peek → place → cross → touch the drop
 * → (S-34) watch the light settle the bridge → back over it → pick the vidro up on it → through the open gate.
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
}

export interface PilotOrder {
  intent: PlayerIntent;
  peek: boolean;
  interact: boolean;
}

type Step =
  | { kind: 'look'; name: string; at: Vec3; seconds: number }
  | { kind: 'walk'; name: string; to: [number, number]; within: number }
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
  { kind: 'look', name: 'look-town', at: [LIGHTHOUSE[0], 14, LIGHTHOUSE[2]], seconds: 1.5 },
];

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class Autopilot {
  private index = 0;
  private elapsed = 0;
  private stillFor = 0;
  private reached = false;
  private pressed = false;

  get current(): string {
    return SCRIPT[this.index]?.name ?? 'done';
  }

  get done(): boolean {
    return this.index >= SCRIPT.length;
  }

  step(dt: number, s: PilotState): PilotOrder {
    const order: PilotOrder = {
      intent: { move: { x: 0, y: 0 }, sprint: false, lookYaw: 0, lookPitch: 0 },
      peek: false,
      interact: false,
    };
    const step = SCRIPT[this.index];
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
        const off = turnTo([x, EYE - 0.3, z]);
        const d = Math.hypot(x - s.feet[0], z - s.feet[2]);
        if (d < step.within) {
          this.next();
          break;
        }
        order.intent.move = { x: 0, y: off < 0.35 ? 1 : 0 };
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
