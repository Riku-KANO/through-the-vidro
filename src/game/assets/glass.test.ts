import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { GLASS_SPECS } from '../../core/glass';
import { QUALITY_PRESETS } from '../../core/quality';
import { assetGlassOptions, withoutHeavyOptics } from './glass';

/**
 * Glass marked in Blender (`glass_<kind>[_<role>]`) becomes the library's glass (createGlass), so dispersion and
 * thin-film follow the role and the quality preset (技術設計 > ガラスの描画: 分散と薄膜干渉は手の玉・光の雫・見せ場に限って使う;
 * 設計書 Blenderアセットパイプライン > 厚みと材質: Blenderから書き出せない設定は、命名規則で印をつけ、読み込み時にコード側で設定する).
 *
 * gltf-transform's quantization stores each mesh in [-1, 1] and puts its size into the node's scale, dividing the glTF
 * thickness by that scale. three multiplies the thickness of transmissive glass by the model's scale; the cheap far
 * glass uses it as metres. Either way the glass must come out as thick as the artist made it.
 */
const mid = QUALITY_PRESETS.mid;
const high = QUALITY_PRESETS.high;

/** Metres the glass is drawn with: three scales the transmissive path's thickness by the model scale. */
const drawnMetres = (r: ReturnType<typeof assetGlassOptions>, scale: number) =>
  (r.options.thickness ?? Number.NaN) * (r.features.path === 'transmission' ? scale : 1);

describe('assetGlassOptions', () => {
  it('passes the kind, the role and the placement on', () => {
    const r = assetGlassOptions(
      {
        mark: { kind: 'iridescent', role: 'drop' },
        placement: 'near',
        thickness: 0,
        thicknessMap: null,
        worldScale: 1,
      },
      high,
    );
    expect(r.kind).toBe('iridescent');
    expect(r.options.role).toBe('drop');
    expect(r.options.placement).toBe('near');
    expect(r.features.thinFilm).toBe('film');
  });

  it('keeps the thickness the artist set, whatever scale quantization gave the mesh', () => {
    const metres = 0.06;
    for (const scale of [1, 0.4, 2.5]) {
      const r = assetGlassOptions(
        {
          mark: { kind: 'clear', role: 'scenery' },
          placement: 'near',
          thickness: metres / scale,
          thicknessMap: null,
          worldScale: scale,
        },
        mid,
      );
      expect(r.features.path).toBe('transmission');
      expect(drawnMetres(r, scale)).toBeCloseTo(metres, 9);
    }
  });

  it('uses the metres on the cheap far path, which three does not scale', () => {
    const metres = 0.06;
    const scale = 2.5;
    const r = assetGlassOptions(
      {
        mark: { kind: 'clear', role: 'scenery' },
        placement: 'far',
        thickness: metres / scale,
        thicknessMap: null,
        worldScale: scale,
      },
      mid,
    );
    expect(r.features.path).toBe('cheap');
    expect(drawnMetres(r, scale)).toBeCloseTo(metres, 9);
  });

  it("falls back to the kind's thickness when the glTF has none", () => {
    const scale = 2;
    const r = assetGlassOptions(
      {
        mark: { kind: 'amber', role: 'scenery' },
        placement: 'near',
        thickness: 0,
        thicknessMap: null,
        worldScale: scale,
      },
      mid,
    );
    expect(drawnMetres(r, scale)).toBeCloseTo(GLASS_SPECS.amber.thickness, 9);
  });

  it('keeps the size of the procedural thickness ripples in metres', () => {
    const at = (scale: number) =>
      assetGlassOptions(
        {
          mark: { kind: 'clear', role: 'scenery' },
          placement: 'near',
          thickness: 0,
          thicknessMap: null,
          worldScale: scale,
        },
        mid,
      ).options.thicknessScale ?? Number.NaN;
    expect(at(2) * 2).toBeCloseTo(at(1), 9);
  });

  it('uses the glTF thickness map when there is one', () => {
    const map = new THREE.Texture();
    const r = assetGlassOptions(
      {
        mark: { kind: 'clear', role: 'scenery' },
        placement: 'near',
        thickness: 0.1,
        thicknessMap: map,
        worldScale: 1,
      },
      mid,
    );
    expect(r.options.thicknessMap).toBe(map);
  });
});

describe('withoutHeavyOptics', () => {
  it('turns off dispersion and thin-film of glass that is not marked (they follow the role and the preset)', () => {
    const m = new THREE.MeshPhysicalMaterial({ transmission: 1, dispersion: 0.3, iridescence: 1 });
    expect(withoutHeavyOptics(m)).toBe(true);
    expect(m.dispersion).toBe(0);
    expect(m.iridescence).toBe(0);
    expect(m.transmission).toBe(1);
  });

  it('leaves other materials alone', () => {
    expect(withoutHeavyOptics(new THREE.MeshPhysicalMaterial({ transmission: 1 }))).toBe(false);
    expect(withoutHeavyOptics(new THREE.MeshStandardMaterial())).toBe(false);
  });
});

describe('assetGlassOptions: what Blender gives besides the mark', () => {
  const base = { placement: 'near' as const, thickness: 0, thicknessMap: null, worldScale: 1 };

  it('lets milky glass glow from inside with the glTF emission (乳白: 内側から発光)', () => {
    const r = assetGlassOptions(
      { ...base, mark: { kind: 'milky', role: 'scenery' }, emissive: new THREE.Color(0.6, 0.516, 0.396) },
      mid,
    );
    expect(r.options.glow?.intensity).toBeCloseTo(0.6, 6);
    expect(new THREE.Color(r.options.glow?.color).toArray().map((v) => Math.round(v * 100) / 100)).toEqual([
      1, 0.86, 0.66,
    ]);
  });

  it('gives no glow without emission, nor to other kinds', () => {
    expect(
      assetGlassOptions({ ...base, mark: { kind: 'milky', role: 'scenery' } }, mid).options.glow,
    ).toBeUndefined();
    expect(
      assetGlassOptions(
        { ...base, mark: { kind: 'clear', role: 'scenery' }, emissive: new THREE.Color(1, 1, 1) },
        mid,
      ).options.glow,
    ).toBeUndefined();
  });

  it("passes the scene's haze on, for far glass to fade into the same fog", () => {
    const haze = { color: 0xeee6da, near: 12, far: 60 };
    expect(
      assetGlassOptions({ ...base, mark: { kind: 'clear', role: 'scenery' }, placement: 'far', haze }, mid)
        .options.haze,
    ).toBe(haze);
  });
});
