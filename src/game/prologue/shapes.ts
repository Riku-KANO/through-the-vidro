import type { MeshData } from '../player/walk-lab-field';
import { BRIDGE, deckHeight, WORKSHOP, WORKSHOP_FLOOR_RADIUS } from './layout';

/**
 * Shapes of the prologue room as plain vertex data, so the drawn mesh and the Rapier triangle mesh are
 * the same triangles (空間の可読性と導線 4).
 */

/** Columns around the dome; the door is DOOR_COLUMNS of them centred on -Z (its width at the floor). */
const DOME_COLUMNS = 96;
const DOOR_COLUMNS = Math.max(
  2,
  2 * Math.round(Math.asin(WORKSHOP.door.halfWidth / WORKSHOP_FLOOR_RADIUS) / ((2 * Math.PI) / DOME_COLUMNS)),
);
const ROWS_ABOVE_DOOR = 12;
const ROWS_BESIDE_DOOR = 12;

export interface DomeShape extends MeshData {
  /** Polar angles (from the top) of the skylight rim, the door top and the floor. */
  theta: { oculus: number; doorTop: number; floor: number };
  /** Azimuths of the door's sides (radians, from +X toward +Z). */
  doorPhi: [number, number];
}

/**
 * The workshop dome's glass wall: a sphere band from the skylight rim down to the floor, minus a door
 * toward -Z. The door's sides follow meridians and its top a parallel, so the cut is clean and a brass
 * frame can trace it. Positions are in room space (the sphere centre is at y = WORKSHOP.sphereCenterY).
 */
export function domeWall(): DomeShape {
  const R = WORKSHOP.radius;
  const cy = WORKSHOP.sphereCenterY;
  const oculus = Math.asin(WORKSHOP.oculus / R);
  const floor = Math.acos(-cy / R);
  const doorTop = Math.acos((WORKSHOP.door.height - cy) / R);
  const thetas: number[] = [];
  for (let i = 0; i <= ROWS_ABOVE_DOOR; i++) thetas.push(oculus + ((doorTop - oculus) * i) / ROWS_ABOVE_DOOR);
  for (let i = 1; i <= ROWS_BESIDE_DOOR; i++)
    thetas.push(doorTop + ((floor - doorTop) * i) / ROWS_BESIDE_DOOR);
  const dPhi = (2 * Math.PI) / DOME_COLUMNS;
  // Column 0 starts at the door's left side (seen from inside): the door is columns [0, DOOR_COLUMNS).
  const phi0 = -Math.PI / 2 - (DOOR_COLUMNS / 2) * dPhi;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const cols = DOME_COLUMNS + 1;
  for (const theta of thetas) {
    for (let j = 0; j < cols; j++) {
      const phi = phi0 + j * dPhi;
      const nx = Math.sin(theta) * Math.cos(phi);
      const ny = Math.cos(theta);
      const nz = Math.sin(theta) * Math.sin(phi);
      positions.push(nx * R, cy + ny * R, nz * R);
      normals.push(nx, ny, nz);
    }
  }
  for (let i = 0; i < thetas.length - 1; i++) {
    const besideDoor = i >= ROWS_ABOVE_DOOR;
    for (let j = 0; j < DOME_COLUMNS; j++) {
      if (besideDoor && j < DOOR_COLUMNS) continue;
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Counter-clockwise seen from outside (front faces point away from the centre).
      indices.push(a, b, c, b, d, c);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    theta: { oculus, doorTop, floor },
    doorPhi: [phi0, phi0 + DOOR_COLUMNS * dPhi],
  };
}

/** A point on the dome's sphere at polar angle theta (from the top) and azimuth phi. */
export function domePoint(theta: number, phi: number, inset = 0): [number, number, number] {
  const r = WORKSHOP.radius - inset;
  return [
    r * Math.sin(theta) * Math.cos(phi),
    WORKSHOP.sphereCenterY + r * Math.cos(theta),
    r * Math.sin(theta) * Math.sin(phi),
  ];
}

/** Slope of the deck's top at z (central difference). */
function deckSlope(z: number): number {
  const e = 1e-3;
  return (deckHeight(z + e) - deckHeight(z - e)) / (2 * e);
}

/**
 * The arched deck from z0 to z1 (z0 > z1 or z0 < z1, either way): a box section of the bridge's width and
 * `thickness` swept along deckHeight(z), closed at both ends. The same triangles are drawn and collided with
 * (each footing segment is one such piece). `lift` moves it up or down (the drawn deck sits 3 mm under the
 * shores where it overlaps them).
 */
export function deckMesh(z0: number, z1: number, steps: number, thickness = 0.14, lift = 0): MeshData {
  const x0 = BRIDGE.min[0];
  const x1 = BRIDGE.max[0];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const zs = Array.from({ length: steps + 1 }, (_, i) => z0 + ((z1 - z0) * i) / steps);
  const vertex = (x: number, y: number, z: number, n: [number, number, number]): number => {
    positions.push(x, y, z);
    normals.push(...n);
    return positions.length / 3 - 1;
  };
  const top = (z: number) => deckHeight(z) + lift;
  // a strip along z between two edges; `flip` reverses the winding so the front faces along `normal`
  const strip = (
    a: (z: number) => [number, number, number],
    b: (z: number) => [number, number, number],
    normal: (z: number) => [number, number, number],
  ) => {
    const ia: number[] = [];
    const ib: number[] = [];
    for (const z of zs) {
      const n = normal(z);
      ia.push(vertex(...a(z), n));
      ib.push(vertex(...b(z), n));
    }
    for (let i = 0; i < steps; i++) {
      const [a0, a1, b0, b1] = [ia[i] ?? 0, ia[i + 1] ?? 0, ib[i] ?? 0, ib[i + 1] ?? 0];
      // decide the winding from the geometry, so the face points along its normal whichever way z runs
      const p = (k: number) => [positions[k * 3] ?? 0, positions[k * 3 + 1] ?? 0, positions[k * 3 + 2] ?? 0];
      const [pa, pb, pc] = [p(a0), p(b0), p(a1)];
      const u = [(pb[0] ?? 0) - (pa[0] ?? 0), (pb[1] ?? 0) - (pa[1] ?? 0), (pb[2] ?? 0) - (pa[2] ?? 0)];
      const v = [(pc[0] ?? 0) - (pa[0] ?? 0), (pc[1] ?? 0) - (pa[1] ?? 0), (pc[2] ?? 0) - (pa[2] ?? 0)];
      const cross = [
        (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
        (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
        (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
      ];
      const n = normals.slice(a0 * 3, a0 * 3 + 3);
      const front =
        (cross[0] ?? 0) * (n[0] ?? 0) + (cross[1] ?? 0) * (n[1] ?? 0) + (cross[2] ?? 0) * (n[2] ?? 0) > 0;
      if (front) indices.push(a0, b0, a1, b0, b1, a1);
      else indices.push(a0, a1, b0, b0, a1, b1);
    }
  };
  const up = (z: number): [number, number, number] => {
    const k = deckSlope(z);
    const l = Math.hypot(1, k);
    return [0, 1 / l, -k / l];
  };
  const down = (z: number): [number, number, number] => {
    const [x, y, w] = up(z);
    return [-x, -y, -w];
  };
  strip(
    (z) => [x0, top(z), z],
    (z) => [x1, top(z), z],
    up,
  );
  strip(
    (z) => [x1, top(z) - thickness, z],
    (z) => [x0, top(z) - thickness, z],
    down,
  );
  strip(
    (z) => [x0, top(z) - thickness, z],
    (z) => [x0, top(z), z],
    () => [-1, 0, 0],
  );
  strip(
    (z) => [x1, top(z), z],
    (z) => [x1, top(z) - thickness, z],
    () => [1, 0, 0],
  );
  // end caps (normals along z, facing away from the piece)
  for (const [z, sign] of [
    [z0, Math.sign(z0 - z1)],
    [z1, Math.sign(z1 - z0)],
  ] as const) {
    const n: [number, number, number] = [0, 0, sign];
    const a = vertex(x0, top(z), z, n);
    const b = vertex(x1, top(z), z, n);
    const c = vertex(x1, top(z) - thickness, z, n);
    const d = vertex(x0, top(z) - thickness, z, n);
    if (sign > 0) indices.push(a, d, b, b, d, c);
    else indices.push(a, b, d, b, c, d);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
