import type { MeshData } from '../player/walk-lab-field';
import { WORKSHOP, WORKSHOP_FLOOR_RADIUS } from './layout';

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
