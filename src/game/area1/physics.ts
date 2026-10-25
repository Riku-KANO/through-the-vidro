import type RAPIER from '@dimforge/rapier3d-compat';
import { arcWallMesh, cylinderMesh } from '../player/walk-lab-field';
import { slab, trimesh, wall } from '../prologue/physics';
import { sweptSlab } from '../prologue/slope';
import {
  AREA1_GATE,
  AREA1_HOUSES,
  AREA1_PLAZA,
  AREA1_RIM,
  AREA1_SLOPE,
  AREA1_STREET,
  AREA1_Y,
  area1RimArcs,
  area1SlopeHeight,
  HOUSE_ROUND,
  ROOM1_ALLEY,
  STREET_NORTH_Z,
  STREET_SOUTH_Z,
} from './layout';

/**
 * エリア1's colliders (S-36), made from the same numbers and shapes art.ts draws (空間の可読性と導線 4: 当たり判定は見た目に正直に):
 * the entrance plaza's floor and the balustrade of its rim, the street and the alley, the slope's deck up to its shut gate,
 * the houses that bound them (the same rounded boxes), the gate's bars. 部屋1's crumbled wall is surface-only: the room
 * adds it apart (prologue/physics.ts SurfaceColliders), so a placed vidro's sphere can cut it (S-28).
 * Added to the world when エリア1 is built (behind the scenes, while the body is in the central plaza: never where the body
 * stands), taken out again with `dispose`.
 */

/** Height of a walkable slab under its top (as the prologue's). */
const SLAB = 1;
/** How far the floors run in under each other (no seam to catch on). */
const OVERLAP = 0.3;

export interface Area1Colliders {
  readonly colliders: readonly RAPIER.Collider[];
  dispose(): void;
}

/** The slope's deck as it collides: from a little into the street to a little past the gate, 1 m deep. */
export function area1SlopeDeckShape(depth = SLAB, lift = 0) {
  const { x, halfWidth, fromZ } = AREA1_SLOPE;
  const z0 = fromZ + OVERLAP;
  const z1 = AREA1_GATE.z - 1.2;
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

/** Every static collider of エリア1 (but the surface-only wall). */
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
  descs.push(slab(R, AREA1_STREET.fromX, AREA1_STREET.toX, STREET_SOUTH_Z, STREET_NORTH_Z, AREA1_Y));
  descs.push(
    slab(R, ROOM1_ALLEY.minX, ROOM1_ALLEY.maxX, ROOM1_ALLEY.minZ - OVERLAP, ROOM1_ALLEY.maxZ, AREA1_Y),
  );
  // the slope's deck, up to a little past its gate
  descs.push(trimesh(R, area1SlopeDeckShape(), [0, 0, 0]));
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
  // the slope's shut gate (仮の行き止まり): its bars stop you across the whole way (they are 0.2 m apart)
  descs.push(
    wall(
      R,
      [AREA1_SLOPE.x, AREA1_GATE.z],
      [1, 0],
      2 * AREA1_GATE.halfWidth,
      area1SlopeHeight(AREA1_GATE.z) - 0.2,
      2.6,
      0.08,
    ),
  );
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
