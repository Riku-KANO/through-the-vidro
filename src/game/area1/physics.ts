import type RAPIER from '@dimforge/rapier3d-compat';
import { footingOf } from '../area';
import { COMPASS } from '../area/compass';
import { arcWallMesh, cylinderMesh } from '../player/walk-lab-field';
import { BackFooting, slab, trimesh, wall } from '../prologue/physics';
import { sweptSlab } from '../prologue/slope';
import {
  AREA1,
  AREA1_HOUSES,
  AREA1_PLAZA,
  AREA1_RIM,
  AREA1_SLOPE,
  AREA1_STREET,
  AREA1_Y,
  area1RimArcs,
  area1SlopeHeight,
  COURT_Y,
  HOUSE_ROUND,
  ROOM1_ALLEY,
  ROOM2_BALCONY,
  ROOM2_COURT,
  ROOM2_RAIL,
  ROOM2_STAIRS,
  ROOM3_ROOF_N,
  ROOM3_ROOF_S,
  ROOM3_TERRACE,
  STREET_NORTH_Z,
  STREET_SOUTH_Z,
  SUMMIT_Y,
} from './layout';

/**
 * エリア1's colliders (S-36, S-40), made from the same numbers and shapes art.ts draws (空間の可読性と導線 4: 当たり判定は見た目に
 * 正直に): the entrance plaza's floor and the balustrade of its rim, the street and the alley, the slope's deck up its two flights
 * to the summit, 部屋2's courtyard and its balcony (a solid block, its railing), the summit's terrace and the roofs across the
 * valley, the houses that bound them (the same rounded boxes). What a placed vidro's sphere changes is apart: the back layer's
 * footing (the courtyard's stair, the bridges, the shortcut's stairs: `area1Footing`) and the surface-only walls (部屋1's and
 * 部屋2's crumbled walls, the shortcut's gate: prologue/physics.ts SurfaceColliders over game/area surfaceOf).
 * Added to the world when エリア1 is built (behind the scenes, never where the body stands), taken out again with `dispose`.
 */

/** Height of a walkable slab under its top (as the prologue's). */
const SLAB = 1;
/** How far the floors run in under each other (no seam to catch on). */
const OVERLAP = 0.3;

export interface Area1Colliders {
  readonly colliders: readonly RAPIER.Collider[];
  dispose(): void;
}

/** The slope's deck as it collides: from a little into the street to a little into the summit's terrace, 1 m deep. */
export function area1SlopeDeckShape(depth = SLAB, lift = 0) {
  const { x, halfWidth, fromZ, toZ } = AREA1_SLOPE;
  const z0 = fromZ + OVERLAP;
  const z1 = toZ - OVERLAP;
  return sweptSlab(
    z0,
    z1,
    Math.max(2, Math.round((z0 - z1) * 2)),
    x - halfWidth,
    x + halfWidth,
    (z) => area1SlopeHeight(z) + lift,
    (z) => area1SlopeHeight(z) + lift - depth,
  );
}

/**
 * S-40: 部屋2's balcony railing (brass, shared) as thin walls: along the balcony's edge but where the stair arrives, and across
 * its west end over the slope. Each a centre, a direction along it and a length (art.ts draws the same lines).
 */
export function balconyRails(): { at: [number, number]; along: readonly [number, number]; length: number }[] {
  const z = ROOM2_BALCONY.minZ;
  const east = COMPASS.east;
  const span = (x0: number, x1: number) => ({
    at: [(x0 + x1) / 2, z] as [number, number],
    along: east,
    length: Math.abs(x1 - x0),
  });
  return [
    span(ROOM2_BALCONY.minX, ROOM2_STAIRS.minX),
    span(ROOM2_STAIRS.maxX, ROOM2_BALCONY.maxX),
    {
      at: [ROOM2_BALCONY.minX, (ROOM2_BALCONY.minZ + ROOM2_BALCONY.maxZ) / 2],
      along: COMPASS.north,
      length: ROOM2_BALCONY.maxZ - ROOM2_BALCONY.minZ,
    },
  ];
}

/** Every static collider of エリア1 (but the back-layer footing and the surface-only walls). */
export function area1ColliderDescs(R: typeof RAPIER): RAPIER.ColliderDesc[] {
  const descs: RAPIER.ColliderDesc[] = [];
  const [cx, , cz] = AREA1_PLAZA.center;
  // the entrance plaza's floor (a disc a little wider than its rim) and the balustrade between its openings
  descs.push(
    trimesh(
      R,
      cylinderMesh(
        {
          kind: 'cylinder',
          centre: { x: 0, y: 0, z: 0 },
          radius: AREA1_PLAZA.radius + OVERLAP,
          height: SLAB,
          surface: 'walk',
        },
        96,
      ),
      [cx, AREA1_Y - SLAB / 2, cz],
    ),
  );
  const half = AREA1_RIM.thickness / 2;
  for (const { from, to } of area1RimArcs())
    descs.push(
      trimesh(
        R,
        arcWallMesh(
          {
            kind: 'arcWall',
            centre: { x: 0, y: 0, z: 0 },
            inner: AREA1_PLAZA.radius - half,
            outer: AREA1_PLAZA.radius + half,
            height: AREA1_RIM.height,
            from,
            to,
            surface: 'wall',
          },
          Math.max(8, Math.round((to - from) * 30)),
        ),
        [cx, AREA1_Y, cz],
      ),
    );
  // the street (from under the plaza's rim to its east end) and the alley off its north side
  descs.push(slab(R, AREA1_STREET.minX, AREA1_STREET.maxX, STREET_SOUTH_Z, STREET_NORTH_Z, AREA1_Y));
  descs.push(
    slab(R, ROOM1_ALLEY.minX, ROOM1_ALLEY.maxX, ROOM1_ALLEY.minZ - OVERLAP, ROOM1_ALLEY.maxZ, AREA1_Y),
  );
  // the slope's deck, up its two flights to the summit
  descs.push(trimesh(R, area1SlopeDeckShape(), [0, 0, 0]));
  // S-40 部屋2: the courtyard's floor (in under the slope's edge), the balcony as a solid block from the floor up, its railing
  descs.push(
    slab(R, ROOM2_COURT.minX - OVERLAP, ROOM2_COURT.maxX, ROOM2_COURT.minZ, ROOM2_COURT.maxZ + OVERLAP, COURT_Y),
  );
  {
    const b = ROOM2_BALCONY;
    const h = b.y - COURT_Y + SLAB;
    descs.push(
      R.ColliderDesc.cuboid((b.maxX - b.minX) / 2, h / 2, (b.maxZ - b.minZ) / 2).setTranslation(
        (b.minX + b.maxX) / 2,
        b.y - h / 2,
        (b.minZ + b.maxZ) / 2,
      ),
    );
    for (const r of balconyRails())
      descs.push(wall(R, r.at, r.along, r.length, b.y - 0.05, ROOM2_RAIL.height + 0.05, ROOM2_RAIL.thickness));
  }
  // S-40 部屋3: the summit's terrace (in under the slope's top) and the two roofs across the valley
  descs.push(
    slab(R, ROOM3_TERRACE.minX, ROOM3_TERRACE.maxX, ROOM3_TERRACE.minZ, ROOM3_TERRACE.maxZ + OVERLAP, SUMMIT_Y),
  );
  for (const r of [ROOM3_ROOF_N, ROOM3_ROOF_S]) descs.push(slab(R, r.minX, r.maxX, r.minZ, r.maxZ, SUMMIT_Y));
  // the houses that bound them: the same rounded boxes as drawn, from under the floor to their eaves
  for (const h of AREA1_HOUSES) {
    if (!h.collide) continue;
    const bottom = AREA1_Y - 2;
    const top = AREA1_Y + h.height;
    const r = HOUSE_ROUND;
    descs.push(
      R.ColliderDesc.roundCuboid(
        (h.maxX - h.minX) / 2 - r,
        (top - bottom) / 2 - r,
        (h.maxZ - h.minZ) / 2 - r,
        r,
      ).setTranslation((h.minX + h.maxX) / 2, (top + bottom) / 2, (h.minZ + h.maxZ) / 2),
    );
  }
  return descs;
}

/** Adds エリア1's colliders to the world; `dispose` takes them out again. */
export function addArea1Colliders(R: typeof RAPIER, world: RAPIER.World): Area1Colliders {
  const colliders = area1ColliderDescs(R).map((d) => world.createCollider(d));
  return {
    colliders,
    dispose() {
      for (const c of colliders) world.removeCollider(c, false);
    },
  };
}

/**
 * S-40: エリア1's back-layer footing — the courtyard's stair, the two bridges over the valley, the shortcut's stairs — as S-02's
 * segments (boxes: a stair's treads, a bridge's deck, the shortcut's steps), switched by the placed vidro's sphere and fixed by
 * the light (BackFooting.settle). Its `allowGround` joins the prologue's (the room asks both).
 */
export function area1Footing(R: typeof RAPIER, world: RAPIER.World): BackFooting {
  return new BackFooting(R, world, footingOf([AREA1]));
}
