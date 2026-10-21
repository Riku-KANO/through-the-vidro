import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLASS_KINDS, type GlassPlacement, type GlassRole } from '../../core/glass';
import { layerOfRole, parseAssetName, parseGlassMark, unmarkedGlassLevel } from './naming';

/**
 * The naming rules (設計書 Blenderアセットパイプライン > 命名規則とゲーム情報). The cases are shared with the lint that
 * runs in Blender (blender/scripts/tests/test_vidro_naming.py), so the game reads names the way the lint passed them.
 */
interface Cases {
  glassKinds: string[];
  glassRoles: string[];
  names: { name: string; expect?: Record<string, unknown>; error?: string }[];
  glass: { name: string; expect?: Record<string, unknown> | null; error?: string }[];
  unmarked: { material: string; transmissive: boolean; placement: GlassPlacement; level: string | null }[];
}
const cases = JSON.parse(
  readFileSync(join(process.cwd(), 'blender/scripts/vidro/naming_cases.json'), 'utf8'),
) as Cases;

describe('parseAssetName (shared cases)', () => {
  for (const c of cases.names) {
    it(`${JSON.stringify(c.name)} → ${c.error ?? 'ok'}`, () => {
      const r = parseAssetName(c.name);
      if (c.error) {
        expect(r).toEqual({ ok: false, error: c.error });
      } else {
        expect(r).toEqual({ ok: true, value: c.expect });
      }
    });
  }
});

describe('parseGlassMark (shared cases)', () => {
  for (const c of cases.glass) {
    it(`${JSON.stringify(c.name)} → ${c.error ?? (c.expect ? 'mark' : 'not a mark')}`, () => {
      const r = parseGlassMark(c.name);
      if (c.error) expect(r).toEqual({ ok: false, error: c.error });
      else if (c.expect === null) expect(r).toBeNull();
      else expect(r).toEqual({ ok: true, value: c.expect });
    });
  }
});

describe('unmarkedGlassLevel (shared cases)', () => {
  for (const c of cases.unmarked) {
    it(`${c.material} transmissive=${c.transmissive} ${c.placement} → ${c.level}`, () => {
      expect(unmarkedGlassLevel(c.material, c.transmissive, c.placement)).toBe(c.level);
    });
  }
});

describe('glass marks', () => {
  it("know the library's glass kinds and roles, as the lint in Blender does", () => {
    expect(cases.glassKinds).toEqual([...GLASS_KINDS]);
    expect(cases.glassRoles).toEqual(['scenery', 'orb', 'drop', 'showcase'] satisfies GlassRole[]);
  });
});

describe('layerOfRole', () => {
  it('puts _front on the surface layer, _back on the back layer, and the rest on both', () => {
    expect(layerOfRole('front')).toBe('surface');
    expect(layerOfRole('back')).toBe('back');
    expect(layerOfRole(null)).toBe('shared');
  });
  it('gives a collider no drawn layer', () => {
    expect(layerOfRole('col')).toBeNull();
  });
});
