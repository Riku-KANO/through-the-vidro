import { describe, expect, it } from 'vitest';
import { bakedLightGain, FIRE_LIGHT_LAYER } from './baked-light';

/**
 * S-37: the strength of a light baked apart is one value per layer, which the room that owns the light changes (the fire
 * breathes: room-art.ts) and every baked material with that layer reads.
 */
describe('bakedLightGain', () => {
  it('is one uniform per layer, the same for whoever asks', () => {
    const a = bakedLightGain(FIRE_LIGHT_LAYER);
    expect(bakedLightGain(FIRE_LIGHT_LAYER)).toBe(a);
    expect(bakedLightGain('lamp')).not.toBe(a);
  });
  it('starts as baked (1), and what one sets the others read', () => {
    const lamp = bakedLightGain('lamp-test');
    expect(lamp.value).toBe(1);
    lamp.value = 0.93;
    expect(bakedLightGain('lamp-test').value).toBe(0.93);
  });
});
