/**
 * The town's compass in the game's frame (S-35; S-39, 発案者 2026-10-25, 設計書 rev 49): the workshop stands due north of the
 * central plaza (+Z), so the way down runs south (−Z), and east — エリア1, 朝 — is on its right (+X): the side where the dawn
 * is about to rise in the workshop's sky and where the sun baked into the workshop shines from (prologue/room-art.ts DAWN).
 * West (エリア3's greenhouse, 夕方) is on the left, south (エリア2's canal) straight on past the plaza. The map's figure has east
 * on the other hand: the town here is its mirror image (left and right swapped), the price of keeping the workshop's sky and
 * bake (process/slices/S-35.md 判断待ち1, S-39).
 *
 * Whatever lies east or west is placed along these (x = centre + COMPASS.east[0] · metres), never with the sign of x
 * written out, so turning the compass turns the town with it (AGENTS.md, S-39). Here (S-36) so that the areas' layouts
 * (area1/layout.ts) and the prologue's (prologue/layout.ts re-exports it) share it without importing each other.
 */
export const COMPASS = {
  north: [0, 1] as const,
  east: [1, 0] as const,
  south: [0, -1] as const,
  west: [-1, 0] as const,
};
