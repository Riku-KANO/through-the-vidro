import { describe, expect, it } from 'vitest';
import { CALM, calmedWave, FIRE_FLICKER_HZ_MAX, fireBreath, orbFlash, WORLD_ACCESS } from './access';

/** The fire's breath as S-37 wrote it (room-art.ts, before S-45). */
const asBefore = (t: number, flicker: number): number =>
  1 + flicker * (0.5 * Math.sin(t * 2.3) + 0.3 * Math.sin(t * 5.9 + 1.3) + 0.2 * Math.sin(t * 11.7 + 0.4));

/** Turns of a signal per second: half its local extremes. */
function cyclesPerSecond(f: (t: number) => number, seconds = 20, rate = 480): number {
  let extremes = 0;
  let prev = f(0);
  let dir = 0;
  for (let i = 1; i <= seconds * rate; i++) {
    const v = f(i / rate);
    const d = Math.sign(v - prev);
    if (d !== 0 && dir !== 0 && d !== dir) extremes++;
    if (d !== 0) dir = d;
    prev = v;
  }
  return extremes / 2 / seconds;
}

describe('S-45 光の点滅や強い閃光を抑えるモード (UI/UX設計 > アクセシビリティ)', () => {
  it('the world reads the settings from two uniforms, off until the settings say (コントラスト強化, 点滅を抑える)', () => {
    expect(WORLD_ACCESS.contrast.value).toBe(0);
    expect(WORLD_ACCESS.calm.value).toBe(0);
  });

  it('off, the fire breathes as it did', () => {
    for (const t of [0, 0.37, 1.9, 12.5])
      expect(fireBreath(t, 0.08, false)).toBeCloseTo(asBefore(t, 0.08), 12);
  });

  it('on, the fire breathes slower than 3 times a second and less deeply (1 秒に 3 回を超える明滅をなくす)', () => {
    const calm = (t: number) => fireBreath(t, 0.08, true);
    expect(cyclesPerSecond(calm)).toBeLessThanOrEqual(FIRE_FLICKER_HZ_MAX);
    expect(FIRE_FLICKER_HZ_MAX).toBeLessThanOrEqual(3);
    let maxCalm = 0;
    let maxBefore = 0;
    for (let i = 0; i < 4800; i++) {
      const t = i / 240;
      maxCalm = Math.max(maxCalm, Math.abs(calm(t) - 1));
      maxBefore = Math.max(maxBefore, Math.abs(asBefore(t, 0.08) - 1));
    }
    expect(maxCalm).toBeGreaterThan(0);
    expect(maxCalm).toBeLessThanOrEqual(maxBefore * CALM.fire + 1e-9);
  });

  it('the vidro’s flash (a refusal, the drop arriving) is as it was off, and fainter on — still there', () => {
    // off: as before S-45 (room.ts: a full tremble and the drop just arrived)
    for (const [shake, arrival, was] of [
      [0, 0, 0],
      [1, 0, 1.6],
      [0, 1, 1.4],
      [0.5, 1, 1.8],
    ] as const)
      expect(orbFlash(shake, arrival, false)).toBeCloseTo(was, 12);
    expect(orbFlash(0, 0, true)).toBe(0);
    for (const [shake, arrival] of [
      [1, 0],
      [0, 1],
      [0.5, 0.5],
    ] as const) {
      expect(orbFlash(shake, arrival, true)).toBeGreaterThan(0);
      expect(orbFlash(shake, arrival, true)).toBeLessThan(orbFlash(shake, arrival, false));
    }
  });

  it('the placing wave’s light is kept as a shape, dimmer (光で伝えていた手がかりは形で残る)', () => {
    expect(calmedWave(0.8, false)).toBe(0.8);
    expect(calmedWave(0.8, true)).toBeGreaterThan(0);
    expect(calmedWave(0.8, true)).toBeLessThan(0.8);
    expect(calmedWave(0, true)).toBe(0);
  });

  it('the bloom is turned down, not off', () => {
    expect(CALM.bloom).toBeGreaterThan(0);
    expect(CALM.bloom).toBeLessThan(1);
  });
});
