import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ANNEALER,
  FURNACE,
  FURNACE_FACING,
  FURNACE_MOUTH,
  WORKSHOP_ASSET,
  WORKSHOP_OBJECTS,
} from '../prologue/layout';
import { FIRE_LIGHT } from '../prologue/room-art';
import { type AssembledAsset, assembleAsset } from './assemble';
import { loadGlbInNode } from './node-glb.test-helper';

/**
 * S-31: the furnace's shape, read from the committed glb the way the game reads it. The designer (2026-10-22): whatever its
 * colour, the furnace of S-27/S-30 read as a kettle because of its shape — the bubble on top a lid, the band at its neck a
 * neck, the tube of its mouth a spout, the bent flue a handle. The annealer at the back (a low, wide dome with a red fire
 * in its mouth) reads as a kiln, so the furnace is made again in its words: a low, wide bubble dome, bigger than the
 * annealer; the mouth an opening in the dome's front with a brass ring for its rim, not a tube; the chimney straight up
 * (アートディレクション > 形のルール: 角を作らない、建物は泡の集合、直線は真鍮の枠だけ).
 * Whether it no longer reads as a kettle, a diving helmet or a pot is the designer's to judge (process/slices/S-31.md);
 * these are the parts of that judgement a measure can hold.
 */
const file = join(process.cwd(), 'public', WORKSHOP_ASSET);
let built: AssembledAsset;
beforeAll(async () => {
  built = assembleAsset((await loadGlbInNode(file)).scene);
});

/** World positions of the furnace's vertices, of its meshes whose material is `only` (all of them without). */
function furnaceVertices(only?: string): THREE.Vector3[] {
  const o = built.layered.find((l) => l.object.userData.name === WORKSHOP_OBJECTS.furnace.name)?.object;
  if (!o) throw new Error(`no ${WORKSHOP_OBJECTS.furnace.name}`);
  o.updateWorldMatrix(true, true);
  const out: THREE.Vector3[] = [];
  o.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    const names = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((x) => x.name);
    if (only !== undefined && !names.includes(only)) return;
    const p = mesh.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++)
      out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld));
  });
  return out;
}

/** The furnace's body: its glass drawn opaque (S-30's A0_kiln; not the brass, the fire, the embers or the milky rings). */
const body = (): THREE.Vector3[] => furnaceVertices('A0_kiln');

/** The body's own upright axis (x, z): the middle of its footprint (its vertices within 15 cm of the floor). */
function axisOf(points: THREE.Vector3[]): [number, number] {
  const foot = points.filter((p) => p.y < 0.15);
  const box = new THREE.Box2();
  for (const p of foot) box.expandByPoint(new THREE.Vector2(p.x, p.z));
  const c = box.getCenter(new THREE.Vector2());
  return [c.x, c.y];
}

/** The furnace's meshes of the body (A0_kiln), with their world matrices up to date. */
function bodyMeshes(): THREE.Mesh[] {
  const o = built.layered.find((l) => l.object.userData.name === WORKSHOP_OBJECTS.furnace.name)?.object;
  if (!o) throw new Error(`no ${WORKSHOP_OBJECTS.furnace.name}`);
  o.updateWorldMatrix(true, true);
  const out: THREE.Mesh[] = [];
  o.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((x) => x.name === 'A0_kiln'))
      out.push(mesh);
  });
  return out;
}

/**
 * Which of 12 sectors round the mouth's axis (level through the fire, FURNACE_MOUTH, along the facing) hold something of the
 * furnace standing out in front of the dome's own surface by more than `beyond` metres, 10–40 cm off the axis (the foot ring
 * is further off). The surface is found along the same line parallel to the axis (review round 1 of S-31: measuring from the
 * dome's furthest point let a collar on the opening slip through); a line through the opening meets the opening's rim in
 * the same direction instead (review round 2: a tube thinner than the opening slipped through). `extra`: world points added
 * to the furnace's own (to check that a tube is caught).
 */
function sectorsStandingOut(beyond: number, extra: THREE.Vector3[] = []): number[] {
  const [fx, fz] = FURNACE_FACING;
  const facing = new THREE.Vector3(fx, 0, fz);
  const right = new THREE.Vector3(-fz, 0, fx);
  const meshes = bodyMeshes();
  const ray = new THREE.Raycaster();
  /** Where the dome's surface is (a) along the line parallel to the axis through (side, up) off it. */
  const surface = (side: number, up: number): number | undefined => {
    ray.set(
      new THREE.Vector3(FURNACE.center[0], FURNACE_MOUTH[1] + up, FURNACE.center[2])
        .addScaledVector(facing, 3)
        .addScaledVector(right, side),
      facing.clone().negate(),
    );
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? mouthFrame(hit.point).a : undefined;
  };
  // the opening's radius: the body comes no nearer the axis in front of the fire
  const hole = Math.min(
    ...body()
      .map(mouthFrame)
      .filter((q) => q.a > FURNACE_MOUTH_REACH)
      .map((q) => Math.hypot(q.s, q.y - FURNACE_MOUTH[1])),
  );
  const sectors = new Set<number>();
  for (const p of [...furnaceVertices(), ...extra]) {
    const q = mouthFrame(p);
    const up = q.y - FURNACE_MOUTH[1];
    const off = Math.hypot(q.s, up);
    if (off < 0.1 || off > 0.4 || q.a < 0.3) continue;
    const rim = (hole + 0.02) / off;
    const at = surface(q.s, up) ?? surface(q.s * rim, up * rim);
    if (at === undefined || q.a < at + beyond) continue;
    sectors.add(Math.floor(((Math.atan2(up, q.s) + Math.PI) / (2 * Math.PI)) * 12) % 12);
  }
  return [...sectors];
}

/** A ring of points round the mouth's axis, `radius` off it, `a` along the facing from the furnace's centre. */
function ringRound(a: number, radius: number): THREE.Vector3[] {
  const [fx, fz] = FURNACE_FACING;
  const out: THREE.Vector3[] = [];
  for (let k = 0; k < 24; k++) {
    const t = (2 * Math.PI * k) / 24;
    const s = radius * Math.cos(t);
    out.push(
      new THREE.Vector3(
        FURNACE.center[0] + fx * a - fz * s,
        FURNACE_MOUTH[1] + radius * Math.sin(t),
        FURNACE.center[2] + fz * a + fx * s,
      ),
    );
  }
  return out;
}

/** How far the fire (FURNACE_MOUTH) is from the furnace's centre along the facing. */
const FURNACE_MOUTH_REACH = Math.hypot(
  FURNACE_MOUTH[0] - FURNACE.center[0],
  FURNACE_MOUTH[2] - FURNACE.center[2],
);

/** Along the mouth's facing from the furnace's centre (a), across it (s, to the right), and up (y). */
function mouthFrame(p: THREE.Vector3): { a: number; s: number; y: number } {
  const [fx, fz] = FURNACE_FACING;
  const dx = p.x - FURNACE.center[0];
  const dz = p.z - FURNACE.center[2];
  return { a: dx * fx + dz * fz, s: -dx * fz + dz * fx, y: p.y };
}

describe('S-31 the furnace is a low, wide bubble dome like the annealer, not a kettle', () => {
  it('its body is a dome lower than it is wide, bigger than the annealer (徐冷炉より大きな炉)', () => {
    const pts = body();
    const [cx, cz] = axisOf(pts);
    const radius = Math.max(...pts.filter((p) => p.y < 0.15).map((p) => Math.hypot(p.x - cx, p.z - cz)));
    const height = Math.max(...pts.map((p) => p.y));
    // the annealer: 0.66 m round and 1.0 m high (height ÷ width 0.76); the furnace lower than that for its width
    expect(
      height / (2 * radius),
      `height ${height.toFixed(2)} m over width ${(2 * radius).toFixed(2)} m`,
    ).toBeLessThan(0.7);
    expect(radius).toBeGreaterThan(ANNEALER.radius * 1.25);
    expect(height).toBeGreaterThan(ANNEALER.height);
  });

  it('it is one dome: from its widest it only narrows as it rises (no lid on top, no neck between)', () => {
    const pts = body();
    const [cx, cz] = axisOf(pts);
    const band = 0.05;
    const widest = new Map<number, number>();
    for (const p of pts) {
      const k = Math.floor(p.y / band);
      widest.set(k, Math.max(widest.get(k) ?? 0, Math.hypot(p.x - cx, p.z - cz)));
    }
    const bands = [...widest.entries()].sort((a, b) => a[0] - b[0]);
    const top = bands.reduce((best, b) => (b[1] > best[1] ? b : best));
    const grows: string[] = [];
    let narrowest = top[1];
    for (const [k, r] of bands.filter((b) => b[0] > top[0])) {
      // 2 cm for the facets of the lathe
      if (r > narrowest + 0.02)
        grows.push(`${(k * band).toFixed(2)} m: ${r.toFixed(2)} m after ${narrowest.toFixed(2)} m`);
      narrowest = Math.min(narrowest, r);
    }
    expect(grows).toEqual([]);
  });

  it('its mouth is an opening in the dome, not a tube: in front of the dome nothing goes round the mouth (no spout)', () => {
    // A tube or a spout on the mouth stands out of the dome all round it (S-30's collar: 12 sectors of 12); the brass ring on
    // the opening's rim stands out about 5 cm; the blowpipe left in the mouth, thin and rising a little toward the room, only
    // above the axis (its far end). It counts vertices: a straight tube with no ring of vertices 10–40 cm off the axis in
    // front of the dome would slip through
    const beyond = 0.08;
    expect(
      sectorsStandingOut(beyond).length,
      'sectors round the mouth with something in front of the dome',
    ).toBeLessThanOrEqual(3);
    // and it would see one (the opening's middle is about 0.79 m out): a collar round the opening, just outside its rim,
    // reaching 0.2 m out; a tube in the opening (S-30's collar was 0.17–0.2 m round), reaching 0.25 m out
    expect(sectorsStandingOut(beyond, ringRound(0.99, 0.214)).length).toBeGreaterThanOrEqual(10);
    expect(
      sectorsStandingOut(beyond, [...ringRound(0.9, 0.18), ...ringRound(1.04, 0.18)]).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it('the fire’s light stands inside the dome (lighting none of its outer face) and clear of its brass', () => {
    // review rounds 1 and 2 of S-31: in front of the opening its cone lit the dome's foot to a salmon patch; 2 cm over the
    // blowpipe it blew the pipe and the ring out white beside the fire
    const pts = body();
    const [cx, cz] = axisOf(pts);
    const [lx, ly, lz] = FIRE_LIGHT;
    const radius = Math.max(
      ...pts.filter((p) => Math.abs(p.y - ly) < 0.05).map((p) => Math.hypot(p.x - cx, p.z - cz)),
    );
    expect(radius - Math.hypot(lx - cx, lz - cz), 'how far inside the dome').toBeGreaterThan(0.03);
    const o = built.layered.find((l) => l.object.userData.name === WORKSHOP_OBJECTS.furnace.name)?.object;
    const brass: THREE.Mesh[] = [];
    o?.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (
        mesh.isMesh &&
        (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((x) => x.name === 'A0_brass')
      )
        brass.push(mesh);
    });
    expect(brass.length).toBeGreaterThan(0);
    const ray = new THREE.Raycaster();
    const from = new THREE.Vector3(lx, ly, lz);
    let nearest = Number.POSITIVE_INFINITY;
    const n = 600;
    for (let i = 0; i < n; i++) {
      // directions spread evenly over the sphere (a Fibonacci lattice)
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const t = i * Math.PI * (3 - Math.sqrt(5));
      ray.set(from, new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r));
      const hit = ray.intersectObjects(brass, false)[0];
      if (hit) nearest = Math.min(nearest, hit.distance);
    }
    expect(nearest, 'the nearest brass to the light').toBeGreaterThan(0.07);
  });

  it('its chimney goes straight up from the dome through the workshop’s glass (not bent like a handle)', () => {
    const top = Math.max(...body().map((p) => p.y));
    const above = furnaceVertices().filter((p) => p.y > top + 0.1);
    expect(above.length).toBeGreaterThan(0);
    const mx = above.reduce((s, p) => s + p.x, 0) / above.length;
    const mz = above.reduce((s, p) => s + p.z, 0) / above.length;
    const spread = Math.max(...above.map((p) => Math.hypot(p.x - mx, p.z - mz)));
    expect(spread, 'how far the chimney strays from upright (its radius and flange)').toBeLessThan(0.15);
    // it reaches the dome of the workshop above it (at its distance from the centre the glass is about 2.8 m up)
    expect(Math.max(...above.map((p) => p.y))).toBeGreaterThan(2.6);
  });
});
