import type { AreaDecl, AreaGateDecl } from './area';

/**
 * S-41 部屋は順に開く (発案者 2026-10-27: 前の部屋の雫で次の部屋への道が開く; 灯りと光の粒はいつもまだ雫を取っていない次の部屋へ向く):
 * the order an area's rooms are played in, as pure functions of which drops are taken. The session asks them for its gates;
 * the room for its lamps and its motes (the way on always leads to the room these name).
 */

/**
 * The room of the area to play next: the first, in order, whose drop is not taken (a room without a drop gives none to wait
 * for). Past the last (rooms.length) once every drop is taken. A later room's drop taken before (a dev hold) skips nothing.
 */
export function nextRoom(area: AreaDecl, taken: (dropId: string) => boolean): number {
  for (let i = 0; i < area.rooms.length; i++) {
    const drop = area.rooms[i]?.drop;
    if (drop && !taken(drop.id)) return i;
  }
  return area.rooms.length;
}

/**
 * Is the way into the room at `index` open? The first room's always; each later room's once the room before it has given its
 * drop (its gate is then opening: the session swings it open once the drop's light has come to it).
 */
export function roomOpen(area: AreaDecl, index: number, taken: (dropId: string) => boolean): boolean {
  if (index < 0 || index >= area.rooms.length) return false;
  if (index === 0) return true;
  const before = area.rooms[index - 1]?.drop;
  return !before || taken(before.id);
}

/** The gate on the way into the room at `index` (the one the room before it opens), or null (the first room, no gates). */
export function gateInto(area: AreaDecl, index: number): AreaGateDecl | null {
  const before = area.rooms[index - 1];
  if (!before) return null;
  return area.gates?.find((g) => g.after === before.id) ?? null;
}
