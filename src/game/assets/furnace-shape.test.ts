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
    // the mouth's axis: level through the fire (FURNACE_MOUTH), along the facing; the dome's front about it
    const at = (p: THREE.Vector3) => {
      const q = mouthFrame(p);
      return { a: q.a, side: q.s, up: q.y - FURNACE_MOUTH[1] };
    };
    const front = Math.max(
      ...body()
        .map(at)
        .filter((q) => Math.hypot(q.side, q.up) < 0.5)
        .map((q) => q.a),
    );
    // from 8 cm in front of the dome (the brass ring on its rim is thinner) to half a metre: which of 12 sectors round the
    // axis hold anything 10–45 cm off it. A tube or a spout fills them all (S-30's collar: 12); the blowpipe left in the
    // mouth and its yoke (thin, rising a little toward the room) only the ones above (S-31: none). It counts vertices: a
    // straight tube with both ends outside that half metre would slip through
    const sectors = new Set<number>();
    for (const q of furnaceVertices().map(at)) {
      if (q.a < front + 0.08 || q.a > front + 0.5) continue;
      const off = Math.hypot(q.side, q.up);
      if (off < 0.1 || off > 0.45) continue;
      sectors.add(Math.floor(((Math.atan2(q.up, q.side) + Math.PI) / (2 * Math.PI)) * 12) % 12);
    }
    expect(
      sectors.size,
      `sectors round the mouth in front of the dome (front at ${front.toFixed(2)} m)`,
    ).toBeLessThanOrEqual(3);
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
