import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../quality';
import { FROSTED_ROUGHNESS_RANGE, GLASS_IOR } from './kinds';
import { createFrostedFloorMaterial, createGlass } from './materials';

const mid = QUALITY_PRESETS.mid;

function physical(material: THREE.Material): THREE.MeshPhysicalNodeMaterial {
  expect(material).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
  return material as THREE.MeshPhysicalNodeMaterial;
}

describe('near glass materials', () => {
  it('refracts every transmissive kind at IOR 1.5 with full transmission', () => {
    for (const kind of ['clear', 'frosted', 'amber', 'lapis', 'jade', 'bubble', 'iridescent'] as const) {
      const m = physical(createGlass(kind, mid).material);
      expect(m.ior, kind).toBe(GLASS_IOR);
      expect(m.transmission, kind).toBe(1);
      expect(m.metalness, kind).toBe(0);
      m.dispose();
    }
  });

  it('makes clear glass perfectly smooth and frosted glass rough but still see-through', () => {
    expect(physical(createGlass('clear', mid).material).roughness).toBe(0);
    const frosted = physical(createGlass('frosted', mid).material);
    expect(frosted.roughness).toBeGreaterThanOrEqual(FROSTED_ROUGHNESS_RANGE[0]);
    expect(frosted.roughness).toBeLessThanOrEqual(FROSTED_ROUGHNESS_RANGE[1]);
    expect(frosted.transmission).toBeGreaterThan(0);
  });

  it('colours amber, lapis and jade by internal absorption, not by the surface', () => {
    const hue = (kind: 'amber' | 'lapis' | 'jade') => {
      const m = physical(createGlass(kind, mid).material);
      expect(m.color.getHex(), `${kind} surface`).toBe(0xffffff);
      expect(Number.isFinite(m.attenuationDistance), `${kind} absorbs`).toBe(true);
      return m.attenuationColor;
    };
    const amber = hue('amber');
    expect(amber.r).toBeGreaterThan(amber.b);
    const lapis = hue('lapis');
    expect(lapis.b).toBeGreaterThan(lapis.r);
    const jade = hue('jade');
    expect(jade.g).toBeGreaterThan(jade.r);
  });

  it('varies thickness across the surface so absorption shows thick and thin places', () => {
    for (const kind of ['clear', 'amber', 'bubble'] as const) {
      expect(physical(createGlass(kind, mid).material).thicknessNode, kind).not.toBeNull();
    }
  });

  it('turns dispersion and thin-film on only where the preset allows', () => {
    const orbLow = physical(createGlass('bubble', QUALITY_PRESETS.low, { role: 'orb' }).material);
    const orbMid = physical(createGlass('bubble', mid, { role: 'orb' }).material);
    expect(orbLow.dispersion).toBe(0);
    expect(orbMid.dispersion).toBeGreaterThan(0);
    const dropMid = physical(createGlass('iridescent', mid, { role: 'drop' }).material);
    const dropHigh = physical(createGlass('iridescent', QUALITY_PRESETS.high, { role: 'drop' }).material);
    expect(dropMid.iridescence).toBe(0);
    expect(dropMid.emissiveNode, 'cheap sheen stands in for thin-film').not.toBeNull();
    expect(dropHigh.iridescence).toBeGreaterThan(0);
  });

  it('lets light drops glow on every preset (アセットリスト: 光の雫 = 虹色ガラス＋発光)', () => {
    for (const preset of [QUALITY_PRESETS.low, mid, QUALITY_PRESETS.high]) {
      const drop = physical(createGlass('iridescent', preset, { role: 'drop' }).material);
      expect(drop.emissiveNode).not.toBeNull();
    }
  });

  it('keeps milky glass out of the transmission pass and lights it from inside', () => {
    const { material, features } = createGlass('milky', mid);
    const m = physical(material);
    expect(features.path).toBe('opaque');
    expect(m.transmission).toBe(0);
    expect(m.transparent).toBe(false);
    expect(m.emissiveNode).not.toBeNull();
  });
});

describe('far glass', () => {
  it('uses the cheap see-through path on mid: no transmission, blended, own distance haze', () => {
    const { material, features } = createGlass('clear', mid, { placement: 'far' });
    expect(features.path).toBe('cheap');
    expect((material as THREE.MeshPhysicalNodeMaterial).transmission ?? 0).toBe(0);
    expect(material.transparent).toBe(true);
    expect(material.fog, 'haze is built in, scene fog would double it').toBe(false);
    expect((material as THREE.MeshStandardNodeMaterial).outputNode).not.toBeNull();
  });

  it('switches back to real transmission on high', () => {
    const { material, features } = createGlass('clear', QUALITY_PRESETS.high, { placement: 'far' });
    expect(features.path).toBe('transmission');
    expect(physical(material).transmission).toBe(1);
  });
});

describe('frosted floor', () => {
  it('is drawn opaque so that glass standing on it can show it through transmission', () => {
    const floor = createFrostedFloorMaterial();
    expect(floor.transparent).toBe(false);
    expect((floor as THREE.MeshPhysicalNodeMaterial).transmission ?? 0).toBe(0);
  });
});
