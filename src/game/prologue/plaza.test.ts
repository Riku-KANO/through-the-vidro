import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../core/quality';
import { LayerField } from '../../layers/field';
import { viewMask } from '../../layers/layers';
import { AREA1_CHIMNEY, AREA1_KEEP_OUT, AREA1_PLAZA, MOTES_TO_ROOM } from '../area1/layout';
import { BODY_RADIUS } from '../player/constants';
import {
  COMPASS,
  EAST_ROAD,
  EAST_ROAD_END_X,
  GATE,
  PLAZA,
  PLAZA_GATE,
  PLAZA_GATES,
  PLAZA_RIM,
  plazaGateAt,
  SLOPE,
} from './layout';
import {
  buildPlaza,
  FOG_TOWN,
  FOG_WAY,
  fogRangeAt,
  gateTangent,
  LIGHTHOUSE_RAIL,
  MOTE_PATH,
  motePathAt,
  plazaGatePosts,
  ROAD_MOTE_PATH,
  ROAD_MOTE_SPREAD,
  rimArcs,
  rimOpenings,
  streetChimneys,
  townBubbles,
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

  it('looking back into the workshop from its door, nothing of the plaza and its town is drawn (all left out of that view)', () => {
    const { scene, art } = build();
    // at the door, looking back into the dome (+Z): the plaza and the town are all behind
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 420);
    camera.position.set(0, 1.6, -3.75);
    camera.lookAt(0, 1.4, 5);
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    scene.updateMatrixWorld(true);
    const drawn: string[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.frustumCulled || frustum.intersectsObject(mesh)) drawn.push(mesh.name || mesh.type);
    });
    expect(drawn).toEqual([]);
    art.dispose();
  });
});

describe('S-35 光の粒の流れ (ルール7): the plaza’s motes lead from the slope’s foot on through the open east gate', () => {
  const [cx, , cz] = PLAZA.center;
  /** Metres along the east from the plaza's centre, and across it, of a point (x, z) — whichever way east points (S-39). */
  const east = ([x, z]: readonly [number, number]): number =>
    (x - cx) * COMPASS.east[0] + (z - cz) * COMPASS.east[1];
  const across = ([x, z]: readonly [number, number]): number =>
    (x - cx) * COMPASS.north[0] + (z - cz) * COMPASS.north[1];

  it('start at the slope’s foot, by where it comes in, and end past the east gate over its road', () => {
    const [start, , end] = MOTE_PATH;
    const north = plazaGateAt(COMPASS.north);
    expect(Math.hypot(start[0] - north[0], start[1] - north[1])).toBeLessThan(4);
    // through the gate and a little beyond it: out past the rim, on the road (S-39 review: the end had been turned round
    // with the compass to 3 m inside the rim, and the motes faded out before the gate)
    expect(east(end)).toBeGreaterThan(PLAZA.radius + 1);
    expect(east(end)).toBeLessThan(PLAZA.radius + EAST_ROAD.length);
    expect(Math.abs(across(end))).toBeLessThan(EAST_ROAD.halfWidth);
  });

  it('go round the lighthouse on its north side (the slope’s), never through its railing', () => {
    for (let u = 0; u <= 1; u += 0.02) {
      const p = motePathAt(u);
      expect(Math.hypot(p[0] - cx, p[1] - cz), `u ${u.toFixed(2)}`).toBeGreaterThan(
        LIGHTHOUSE_RAIL.radius + 1,
      );
    }
    expect(across(motePathAt(0.5))).toBeGreaterThan(0);
    // and on to the east: further along it the further along the curve
    expect(east(motePathAt(0.75))).toBeGreaterThan(east(motePathAt(0.25)));
  });

  it('S-36: and on down the east road’s 60 m to エリア1’s entrance plaza, where エリア1’s motes take the way on', () => {
    const [from, to] = ROAD_MOTE_PATH;
    // from just out of the gate (where the plaza's fade) to a few metres into the entrance plaza
    expect(east(from)).toBeGreaterThan(PLAZA.radius);
    expect(east(from)).toBeLessThan(east(MOTE_PATH[2]));
    const roadEnd = (EAST_ROAD_END_X - PLAZA.center[0]) * COMPASS.east[0];
    expect(east(to)).toBeGreaterThan(roadEnd);
    expect(east(to)).toBeLessThan(roadEnd + AREA1_PLAZA.radius);
    // along the road's middle, drifting within its railings
    expect(Math.abs(across(from))).toBeLessThan(0.01);
    expect(Math.abs(across(to))).toBeLessThan(0.01);
    expect(ROAD_MOTE_SPREAD).toBeGreaterThan(0);
    expect(ROAD_MOTE_SPREAD).toBeLessThan(EAST_ROAD.halfWidth - 0.2);
    // handed on: エリア1's motes start within a few metres of where these end
    const [a1x, a1z] = MOTES_TO_ROOM[0];
    expect(Math.hypot(a1x - to[0], a1z - to[1])).toBeLessThan(6);
  });
});

describe('S-36: the far town round エリア1 keeps out of its way (the road, the entrance plaza, the street, the slope)', () => {
  /** Does a circle (x, z, r) on the ground overlap a box on x and z? */
  const overlaps = (x: number, z: number, r: number, b: (typeof AREA1_KEEP_OUT)[number]): boolean => {
    const nx = Math.min(Math.max(x, b.minX), b.maxX);
    const nz = Math.min(Math.max(z, b.minZ), b.maxZ);
    return Math.hypot(x - nx, z - nz) < r;
  };

  it('no bubble of the town stands on エリア1’s way: every one keeps out of it with its whole width', () => {
    const bubbles = townBubbles();
    expect(bubbles.length).toBeGreaterThan(60);
    expect(bubbles.filter((b) => b.zone === 'hill').length).toBeGreaterThan(20);
    for (const b of bubbles)
      for (const box of AREA1_KEEP_OUT)
        expect(
          overlaps(b.x, b.z, b.r, box),
          `${b.zone} bubble at (${b.x.toFixed(1)}, ${b.z.toFixed(1)})`,
        ).toBe(false);
  });

  it('the street’s chimneys stand on the hill, out of the way; the landmark on the summit (AREA1_CHIMNEY)', () => {
    const chimneys = streetChimneys();
    expect(chimneys[0]?.x).toBeCloseTo(AREA1_CHIMNEY.foot[0], 9);
    expect(chimneys[0]?.z).toBeCloseTo(AREA1_CHIMNEY.foot[2], 9);
    expect(chimneys.length).toBeGreaterThan(3);
    for (const c of chimneys)
      for (const box of AREA1_KEEP_OUT)
        expect(overlaps(c.x, c.z, c.r * 1.4, box), `chimney at (${c.x}, ${c.z})`).toBe(false);
  });
});
