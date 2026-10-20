import { describe, expect, it } from 'vitest';
import { BUSES, VOLUME_CHANNELS } from '../core/audio/mix';
import { VIDRO_REVERB_SEND, VIDRO_VOLUMES } from './levels';

describe('Vidro mixer defaults', () => {
  it('sets a starting volume for all four channels (全体 / 音楽 / 効果音 / 環境音)', () => {
    for (const ch of VOLUME_CHANNELS) {
      expect(VIDRO_VOLUMES[ch]).toBeGreaterThan(0);
      expect(VIDRO_VOLUMES[ch]).toBeLessThanOrEqual(1);
    }
  });

  it('sends every bus to the room reverb at a sane level', () => {
    for (const bus of BUSES) {
      expect(VIDRO_REVERB_SEND[bus]).toBeGreaterThanOrEqual(0);
      expect(VIDRO_REVERB_SEND[bus]).toBeLessThanOrEqual(1);
    }
  });
});
