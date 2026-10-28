import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { layerMask, peekStandInMask } from '../../layers/layers';
import { landmarkOf, markLandmark, peekFarVerdict } from './peek-pipeline';

/**
 * S-41, S-44 (発案者 2026-10-28: 覗く像の遠端は 150m、ただし目印は遠くても描く): what the peek image leaves out past its far end. The
 * eye at the origin looking down −Z; a thing is a sphere of radius `r` at depth `z` (and `x` to the side).
 */
const eye = new THREE.Vector3(0, 1.6, 0);
const forward = new THREE.Vector3(0, 0, -1);
const thing = (
  depth: number,
  opts: { r?: number; x?: number; kind?: 'shared' | 'back' | 'surface' } = {},
) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(opts.r ?? 1, 8, 4));
  m.geometry.computeBoundingSphere();
  m.position.set(opts.x ?? 0, 1.6, -depth);
  m.layers.mask = layerMask(opts.kind ?? 'shared');
  m.updateMatrixWorld(true);
  return m;
};

describe('S-41, S-44: the peek image’s far end (覗く像に遠い物を描かない)', () => {
  it('leaves out a thing wholly past it; draws whole one that reaches nearer (nothing is cut at a plane)', () => {
    expect(peekFarVerdict(thing(160), eye, forward, 150)).toBe('out');
    expect(peekFarVerdict(thing(150.5), eye, forward, 150)).toBe('near');
    expect(peekFarVerdict(thing(140), eye, forward, 150)).toBe('near');
    expect(peekFarVerdict(thing(170, { r: 25 }), eye, forward, 150)).toBe('near');
  });

  it('measures depth along the view, as the haze does: off to the side, far in distance but not in depth, it is drawn', () => {
    // 200 m away, 120 m deep
    expect(peekFarVerdict(thing(120, { x: 160 }), eye, forward, 150)).toBe('near');
  });

  it('never leaves out the back layer (玉越しの裏の層の見た目は変えない)', () => {
    expect(peekFarVerdict(thing(400, { kind: 'back' }), eye, forward, 150)).toBe('back');
  });

  it('S-44: draws a landmark however far (空間の可読性と導線 5: 常に見える目印), and the peek stand-ins of its glass with it', () => {
    const tower = thing(260);
    markLandmark(tower, 'lighthouse');
    expect(landmarkOf(tower)).toBe('lighthouse');
    expect(peekFarVerdict(tower, eye, forward, 150)).toBe('landmark');
    // a peek stand-in made for its glass before or after it was marked (LayerField: a child on the peek-only layer)
    const before = new THREE.Mesh(tower.geometry);
    before.layers.mask = peekStandInMask();
    tower.add(before);
    const chimney = thing(190);
    markLandmark(chimney, 'area1-chimney');
    const after = new THREE.Mesh(chimney.geometry);
    after.layers.mask = peekStandInMask();
    chimney.add(after);
    tower.updateMatrixWorld(true);
    chimney.updateMatrixWorld(true);
    expect(peekFarVerdict(before, eye, forward, 150)).toBe('landmark');
    expect(peekFarVerdict(after, eye, forward, 150)).toBe('landmark');
    // the mark is the landmark's alone: a thing beside it is left out
    expect(landmarkOf(thing(260))).toBeNull();
    expect(peekFarVerdict(thing(260), eye, forward, 150)).toBe('out');
  });

  it('never leaves out what three does not cull by its bounds, nor what is not a mesh, points or line', () => {
    const big = thing(400);
    big.frustumCulled = false;
    expect(peekFarVerdict(big, eye, forward, 150)).toBe('skip');
    const group = new THREE.Group();
    group.position.set(0, 0, -400);
    group.updateMatrixWorld(true);
    expect(peekFarVerdict(group, eye, forward, 150)).toBe('skip');
  });
});
