import { describe, expect, it } from 'vitest';
import { decayT60 } from '../core/audio/analysis';
import { synthesizeImpulseResponse } from '../core/audio/reverb';
import { mulberry32 } from '../core/audio/rng';
import { VIDRO_ROOMS } from './rooms';

describe('Vidro rooms (サウンドデザイン > 環境音: small workshop short, glass dome long)', () => {
  it('a workshop is short and a dome is much longer', () => {
    expect(VIDRO_ROOMS.workshop.t60).toBeLessThan(1);
    expect(VIDRO_ROOMS.dome.t60).toBeGreaterThan(VIDRO_ROOMS.workshop.t60 * 3);
  });

  it('their synthesized impulse responses decay at the room T60 (within 15 %)', () => {
    for (const room of Object.values(VIDRO_ROOMS)) {
      const [left] = synthesizeImpulseResponse(room, 44100, mulberry32(1));
      const t60 = decayT60(left as Float32Array, 44100) as number;
      expect(Math.abs(t60 / room.t60 - 1), `${room.id} ${t60}`).toBeLessThan(0.15);
    }
  });

  it('ids match their keys', () => {
    for (const [key, room] of Object.entries(VIDRO_ROOMS)) expect(room.id).toBe(key);
  });
});
