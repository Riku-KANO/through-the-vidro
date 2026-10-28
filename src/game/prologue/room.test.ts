import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { glassEase } from '../../core/transition';
import { createDivePath } from './dive-path';
import { lookDirection, WORKSHOP, WORKSHOP_TOP } from './layout';
import { type Pose, towardEye } from './room';

/**
 * S-42: the dive's way bent toward where play stands (the pause's タイトルへ goes back from there, and the dive in again
 * comes down there). The dive is 2.0 s (トランジション設計 > 遷移の一覧), its u the eased value of its time; one frame at
 * 60 fps is 1/120 of it.
 */
const dive = createDivePath();
const landing: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
dive.pose(1, landing.pos, landing.target);
const FRAMES = 120;

function eyeAt(x: number, y: number, z: number, yaw: number, pitch = 0): Pose {
  const d = lookDirection(yaw, pitch);
  return { pos: new THREE.Vector3(x, y, z), target: new THREE.Vector3(x + d[0], y + d[1], z + d[2]) };
}

/** The bent pose at each frame of the dive (in its time): place and unit view direction. */
function frames(eye: Pose): { pos: THREE.Vector3; dir: THREE.Vector3; placed: number }[] {
  const out: { pos: THREE.Vector3; dir: THREE.Vector3; placed: number }[] = [];
  for (let i = 0; i <= FRAMES; i++) {
    const u = glassEase(i / FRAMES);
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    dive.pose(u, pos, target);
    const placed = towardEye(u, landing, eye, pos, target);
    out.push({ pos, dir: target.clone().sub(pos).normalize(), placed });
  }
  return out;
}

const landingEye = (): Pose => ({ pos: landing.pos.clone(), target: landing.target.clone() });

/** The fastest a sequence of frames moves across (m a frame) and turns its view (degrees a frame). */
function fastest(f: { pos: THREE.Vector3; dir: THREE.Vector3 }[]): { step: number; turn: number } {
  let step = 0;
  let turn = 0;
  for (let i = 1; i < f.length; i++) {
    const a = f[i - 1];
    const b = f[i];
    if (!a || !b) continue;
    step = Math.max(step, Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z));
    turn = Math.max(turn, (a.dir.angleTo(b.dir) * 180) / Math.PI);
  }
  return { step, turn };
}
/** The dive's own way (the first dive): about 2.2 m and 4 degrees a frame at its fastest, in its middle. */
const own = fastest(frames(landingEye()));

describe('towardEye: the first dive (the eye is the landing pose) is the dive as it was', () => {
  it('bends neither the place nor the view at any moment', () => {
    for (let i = 0; i <= FRAMES; i++) {
      const u = glassEase(i / FRAMES);
      const pos = new THREE.Vector3();
      const target = new THREE.Vector3();
      dive.pose(u, pos, target);
      const want = { pos: pos.clone(), dir: target.clone().sub(pos).normalize() };
      towardEye(u, landing, landingEye(), pos, target);
      expect(pos.distanceTo(want.pos)).toBeLessThan(1e-9);
      expect(target.clone().sub(pos).normalize().angleTo(want.dir)).toBeLessThan(1e-6);
    }
  });
});

describe('towardEye: back from (and down into) the workshop, the eye moved and turned round', () => {
  const eye = eyeAt(landing.pos.x + 1.2, landing.pos.y, landing.pos.z + 0.8, Math.PI, 0);
  const f = frames(eye);

  it('ends exactly at the eye, looking where it looks', () => {
    const end = f[FRAMES];
    expect(end?.pos.distanceTo(eye.pos)).toBeLessThan(1e-6);
    expect(end?.dir.angleTo(eye.target.clone().sub(eye.pos))).toBeLessThan(1e-6);
  });

  it('turns round over the end of the dive, hardly faster than the dive turns by itself, without ducking', () => {
    expect(fastest(f).turn).toBeLessThan(own.turn + 1);
    let lowest = 0;
    for (let i = Math.ceil(FRAMES * 0.6); i <= FRAMES; i++) {
      const b = f[i];
      if (b) lowest = Math.min(lowest, (Math.asin(b.dir.y) * 180) / Math.PI);
    }
    // the dive itself looks down onto the bench at the end (S-06 spawn pitch -0.3 rad = -17 degrees); no deeper dip
    expect(lowest).toBeGreaterThan(-45);
  });

  it('stays under the dome once through the skylight', () => {
    for (const p of f) {
      if (p.pos.y > WORKSHOP_TOP) continue;
      expect(Math.hypot(p.pos.x, p.pos.z)).toBeLessThan(WORKSHOP.radius);
    }
  });
});

describe('towardEye: back from (and down into) the town, far from the workshop (仮: the arc over it)', () => {
  // where the S-42 e2e's script ends: before the plaza's east gate, about 127 m out and 12 m down
  const eye = eyeAt(21.9, -10.4, -125.5, 0, 0);
  const turned = eyeAt(21.9, -10.4, -125.5, Math.PI, 0.1);
  const f = frames(eye);

  it('ends exactly at the eye, looking where it looks', () => {
    const end = f[FRAMES];
    expect(end?.pos.distanceTo(eye.pos)).toBeLessThan(1e-6);
    expect(end?.dir.angleTo(eye.target.clone().sub(eye.pos))).toBeLessThan(1e-6);
  });

  it('spreads the way over the dive: at most twice as fast across as the dive’s own way, also from エリア1’s summit', () => {
    expect(fastest(f).step).toBeLessThan(2 * own.step);
    // 部屋3, the summit: about 200 m out (area1/layout.ts)
    expect(fastest(frames(eyeAt(118, 13.6, -163, 1.2))).step).toBeLessThan(2 * own.step);
  });

  it('goes over the dome and high over the town, coming down onto the eye only once over it', () => {
    for (const p of f) {
      if (p.placed <= 0) continue;
      // over the workshop: above its dome
      if (Math.hypot(p.pos.x, p.pos.z) < WORKSHOP.radius + 1)
        expect(p.pos.y).toBeGreaterThan(WORKSHOP_TOP + 1);
      // out over the town and more than 10 m from the eye: well above it
      const fromEye = Math.hypot(p.pos.x - eye.pos.x, p.pos.z - eye.pos.z);
      if (fromEye > 10 && Math.hypot(p.pos.x, p.pos.z) > WORKSHOP.radius + 1)
        expect(p.pos.y - eye.pos.y).toBeGreaterThan(6);
    }
  });

  it('turns its view no faster than the dive turns by itself, also for an eye looking back the other way', () => {
    for (const g of [f, frames(turned)]) expect(fastest(g).turn).toBeLessThan(own.turn + 1);
  });
});
