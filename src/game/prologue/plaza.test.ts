import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../core/quality';
import { LayerField } from '../../layers/field';
import { viewMask } from '../../layers/layers';
import { BODY_RADIUS } from '../player/constants';
import { COMPASS, GATE, PLAZA, PLAZA_GATE, PLAZA_GATES, PLAZA_RIM, plazaGateAt, SLOPE } from './layout';
import {
  buildPlaza,
  FOG_TOWN,
  FOG_WAY,
  fogRangeAt,
  gateTangent,
  plazaGatePosts,
  rimArcs,
  rimOpenings,
} from './plaza';

/** S-35: the plaza's rim, gates and haze as numbers (what the drawing and the colliders are made from). */
const angleOf = (x: number, z: number): number => {
  const a = Math.atan2(z - PLAZA.center[2], x - PLAZA.center[0]);
  return a < 0 ? a + 2 * Math.PI : a;
};
const onArc = (a: number, arc: { from: number; to: number }): boolean => {
  for (const k of [-1, 0, 1]) {
    const b = a + k * 2 * Math.PI;
    if (b >= arc.from && b <= arc.to) return true;
  }
  return false;
};

describe('S-35: the plaza’s rim (縁の手すり) leaves the slope and the three gates open, and nothing else', () => {
  it('has four openings — the slope (north) and the gates — and an arc of balustrade between each two', () => {
    expect(rimOpenings()).toHaveLength(1 + PLAZA_GATES.length);
    const arcs = rimArcs();
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) expect(arc.to).toBeGreaterThan(arc.from);
    // all round, the arcs and the openings
    const half = Math.asin(PLAZA_RIM.openingHalf / PLAZA.radius);
    const covered = arcs.reduce((n, a) => n + (a.to - a.from), 0);
    expect(covered + rimOpenings().length * 2 * half).toBeCloseTo(2 * Math.PI, 9);
  });

  it('no arc stands where the slope comes in or before a gate; every other point of the rim has one', () => {
    const arcs = rimArcs();
    const north = plazaGateAt(COMPASS.north);
    // the slope comes in across its width (and the body's), clear of the balustrade
    for (const dx of [-(SLOPE.maxX + BODY_RADIUS), 0, SLOPE.maxX + BODY_RADIUS]) {
      const a = angleOf(north[0] + dx, north[1]);
      expect(arcs.some((arc) => onArc(a, arc))).toBe(false);
    }
    for (const g of PLAZA_GATES) {
      const [x, z] = plazaGateAt(g.dir);
      expect(
        arcs.some((arc) => onArc(angleOf(x, z), arc)),
        g.name,
      ).toBe(false);
      // its posts stand in the opening too, inside the balustrade's ends
      for (const [px, pz] of plazaGatePosts(g.dir))
        expect(
          arcs.some((arc) => onArc(angleOf(px, pz), arc)),
          `${g.name} post`,
        ).toBe(false);
    }
    // half way between two openings, the rim is closed
    for (const deg of [45, 135, 225, 315])
      expect(arcs.some((arc) => onArc((deg * Math.PI) / 180, arc))).toBe(true);
  });

  it('a gate’s two posts stand on the rim, its width apart, across its direction', () => {
    for (const g of PLAZA_GATES) {
      const [a, b] = plazaGatePosts(g.dir);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(2 * PLAZA_GATE.halfWidth, 9);
      const [tx, tz] = gateTangent(g.dir);
      expect(tx * g.dir[0] + tz * g.dir[1]).toBeCloseTo(0, 9);
    }
  });
});

describe('S-35: the haze as you go down into the town (ルール5, 8)', () => {
  it('is the way’s up to the gate, clears through it, and is the town’s from the slope’s brow on', () => {
    expect(fogRangeAt(0)).toEqual({ near: FOG_WAY.near, far: FOG_WAY.far });
    expect(fogRangeAt(GATE.z + 3)).toEqual({ near: FOG_WAY.near, far: FOG_WAY.far });
    expect(fogRangeAt(SLOPE.fromZ)).toEqual({ near: FOG_TOWN.near, far: FOG_TOWN.far });
    expect(fogRangeAt(PLAZA.center[2])).toEqual({ near: FOG_TOWN.near, far: FOG_TOWN.far });
    let last = fogRangeAt(GATE.z + 2).far;
    for (let z = GATE.z + 2; z >= SLOPE.fromZ; z -= 0.1) {
      const f = fogRangeAt(z).far;
      expect(f).toBeGreaterThanOrEqual(last - 1e-9);
      last = f;
    }
    // the lighthouse (about 40 m tall) far across the town is still not lost in it (a town of about 300 m)
    expect(FOG_TOWN.far).toBeGreaterThan(250);
  });

  it('writes into the object it is given (the room asks every frame)', () => {
    const out = { near: 0, far: 0 };
    expect(fogRangeAt(SLOPE.toZ, out)).toBe(out);
    expect(out.far).toBe(FOG_TOWN.far);
  });
});

describe('S-35: the plaza as drawn (plaza.ts buildPlaza)', () => {
  const build = () => {
    const field = new LayerField({ settle: true });
    const scene = new THREE.Scene();
    const art = buildPlaza(QUALITY_PRESETS.mid, field, scene);
    return { scene, art };
  };

  it('everything is on the shared layer, drawn in the main view; no glass of it refracts (cheap far glass, milky lamps)', () => {
    const { scene, art } = build();
    let meshes = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      expect(o.layers.mask & viewMask('main'), o.name).not.toBe(0);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) expect((m as THREE.MeshPhysicalMaterial).transmission ?? 0, m.name).toBe(0);
    });
    expect(meshes).toBeGreaterThan(10);
    art.dispose();
  });

  it('the town is drawn in parts, each left out when out of view (no part spans the whole town)', () => {
    const { scene, art } = build();
    const parts = scene.children.filter((o) => o.name.startsWith('town-')) as THREE.InstancedMesh[];
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of parts) {
      expect(p.frustumCulled).toBe(true);
      p.computeBoundingSphere();
      expect(p.boundingSphere?.radius ?? 0, p.name).toBeLessThan(150);
    }
    art.dispose();
  });
});
