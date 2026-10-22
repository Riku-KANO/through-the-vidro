import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../../core/quality';
import { LayerField } from '../../layers/field';
import { viewMask } from '../../layers/layers';
import { buildFinale, gateAngle, settleGlow } from './finale';
import { GATE, GATE_OPEN_DEG, LOOKOUT, ROAD } from './layout';

const OPEN = (GATE_OPEN_DEG * Math.PI) / 180;

describe('S-34: how the gate opens (トランジション設計 > 遷移のルール5: ゆっくり始まって粘りながら止まる)', () => {
  it('swings from shut to open along the game’s one curve: slow to start, sticky to stop, never back', () => {
    expect(gateAngle(0)).toBe(0);
    expect(gateAngle(1)).toBeCloseTo(OPEN, 9);
    expect(gateAngle(2)).toBeCloseTo(OPEN, 9);
    expect(gateAngle(0.1)).toBeLessThan(OPEN * 0.05);
    expect(gateAngle(0.9)).toBeGreaterThan(OPEN * 0.95);
    let last = 0;
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const a = gateAngle(u);
      expect(a).toBeGreaterThanOrEqual(last - 1e-12);
      last = a;
    }
  });
});

describe('S-34: the light across the bridge (定着の見た目)', () => {
  it('comes up as it leaves the vidro, is full while it crosses and is gone when it reaches the far shore', () => {
    expect(settleGlow(0)).toBe(0);
    expect(settleGlow(1)).toBe(0);
    expect(settleGlow(0.5)).toBe(1);
    for (let u = 0.2; u <= 0.7; u += 0.05) expect(settleGlow(u)).toBeGreaterThan(0.99);
    for (let u = 0; u <= 1; u += 0.01) {
      expect(settleGlow(u)).toBeGreaterThanOrEqual(0);
      expect(settleGlow(u)).toBeLessThanOrEqual(1);
    }
  });
});

describe('S-34: the gate and the lookout as drawn (finale.ts buildFinale)', () => {
  const build = () => {
    const field = new LayerField({ settle: true });
    const scene = new THREE.Scene();
    const art = buildFinale(QUALITY_PRESETS.mid, field, scene);
    return { field, scene, art };
  };
  const box = (o: THREE.Object3D): THREE.Box3 => {
    o.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(o);
  };

  it('shut, its two leaves fill the arch between the posts, meeting in the middle', () => {
    const { art } = build();
    art.setGate(0);
    const right = box(art.leaves.right);
    const left = box(art.leaves.left);
    expect(right.min.x).toBeGreaterThan(-0.05);
    expect(right.max.x).toBeLessThan(GATE.halfWidth + 0.05);
    expect(left.max.x).toBeLessThan(0.05);
    expect(left.min.x).toBeGreaterThan(-GATE.halfWidth - 0.05);
    for (const b of [left, right]) {
      expect(Math.abs((b.min.z + b.max.z) / 2 - GATE.z)).toBeLessThan(0.1);
      expect(b.max.y).toBeGreaterThan(1.8);
      expect(b.min.y).toBeLessThan(0.15);
    }
    art.dispose();
  });

  it('open, each leaf has swung about its post away from the far shore, out over the road’s edge', () => {
    const { art } = build();
    art.setGate(OPEN);
    const right = box(art.leaves.right);
    const left = box(art.leaves.left);
    expect(right.min.x).toBeGreaterThan(ROAD.maxX - 0.1);
    expect(left.max.x).toBeLessThan(ROAD.minX + 0.1);
    for (const b of [left, right]) {
      expect(b.max.z).toBeLessThan(GATE.z + 0.1);
      expect(b.min.z).toBeLessThan(GATE.z - GATE.halfWidth + 0.15);
      expect(b.min.z).toBeGreaterThan(LOOKOUT.z);
    }
    art.dispose();
  });

  it('everything of the close is on the shared layer (drawn in the main view), and the swinging leaves cast no shadow', () => {
    const { art, scene } = build();
    let meshes = 0;
    scene.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      meshes++;
      expect(o.layers.mask & viewMask('main')).not.toBe(0);
    });
    expect(meshes).toBeGreaterThan(3);
    for (const leaf of [art.leaves.left, art.leaves.right])
      leaf.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) expect(o.castShadow).toBe(false);
      });
    art.dispose();
  });
});
