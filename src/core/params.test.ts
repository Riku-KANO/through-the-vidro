import { describe, expect, it } from 'vitest';
import { parseParams } from './params';

describe('parseParams', () => {
  it('defaults to the scene list, mid quality, WebGPU', () => {
    const p = parseParams('');
    expect(p.scene).toBeNull();
    expect(p.benchSeconds).toBeNull();
    expect(p.quality).toBe('mid');
    expect(p.forceWebGL).toBe(false);
    expect(p.warmupSeconds).toBe(1);
  });

  it('reads scene, bench, quality and backend switches', () => {
    const p = parseParams('?scene=glass-gallery&bench=5&quality=high&webgl=1&stats=1&warmup=0');
    expect(p.scene).toBe('glass-gallery');
    expect(p.benchSeconds).toBe(5);
    expect(p.quality).toBe('high');
    expect(p.forceWebGL).toBe(true);
    expect(p.stats).toBe(true);
    expect(p.warmupSeconds).toBe(0);
  });

  it('rejects scene names that could escape the scenes folder', () => {
    expect(parseParams('?scene=../main').scene).toBeNull();
    expect(parseParams('?scene=Hello').scene).toBeNull();
  });

  it('clamps bench length and ignores bad quality', () => {
    expect(parseParams('?bench=9999').benchSeconds).toBe(120);
    expect(parseParams('?bench=-3').benchSeconds).toBeNull();
    expect(parseParams('?quality=ultra').quality).toBe('mid');
  });
});
