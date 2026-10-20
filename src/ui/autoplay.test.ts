import { describe, expect, it } from 'vitest';
import { parsePauseSpec } from './autoplay';

describe('parsePauseSpec (?pause= for mid-transition screenshots)', () => {
  it('reads checkpoints per transition, sorted', () => {
    const spec = parsePauseSpec('home-game:1,0,0.5/loading-home:0.75');
    expect(spec.get('home-game')).toEqual([0, 0.5, 1]);
    expect(spec.get('loading-home')).toEqual([0.75]);
  });

  it('ignores malformed parts', () => {
    const spec = parsePauseSpec('home-game:a,1/bad/:2/x:');
    expect(spec.get('home-game')).toEqual([1]);
    expect(spec.size).toBe(1);
  });

  it('returns an empty map for no spec', () => {
    expect(parsePauseSpec(null).size).toBe(0);
  });
});
