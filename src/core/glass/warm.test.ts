import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../quality';
import { createGlass } from './materials';
import { drawsGlass, withGlassUnculled } from './warm';

const geometry = new THREE.SphereGeometry(1, 8, 6);
const glass = () => createGlass('clear', QUALITY_PRESETS.mid, { placement: 'near' }).material;
const opaque = () => new THREE.MeshStandardNodeMaterial({ color: 0x888888 });

/** A small room: glass in front and behind, an opaque piece, glass in a group, a glass piece already unculled. */
function room() {
  const scene = new THREE.Scene();
  const front = new THREE.Mesh(geometry, glass());
  const behind = new THREE.Mesh(geometry, glass());
  const wall = new THREE.Mesh(geometry, opaque());
  const shelf = new THREE.Group();
  const ware = new THREE.Mesh(geometry, [opaque(), glass()]);
  shelf.add(ware);
  const always = new THREE.Mesh(geometry, glass());
  always.frustumCulled = false;
  const hidden = new THREE.Mesh(geometry, glass());
  hidden.visible = false;
  scene.add(front, behind, wall, shelf, always, hidden);
  return { scene, front, behind, wall, shelf, ware, always, hidden };
}

describe('withGlassUnculled (S-38: the glass all around compiles in one warm-up draw)', () => {
  it('tells the glass from the rest: a material that reads the backdrop, also one of several', () => {
    const r = room();
    expect(drawsGlass(r.front)).toBe(true);
    expect(drawsGlass(r.ware)).toBe(true);
    expect(drawsGlass(r.wall)).toBe(false);
    expect(drawsGlass(r.shelf)).toBe(false);
    expect(drawsGlass(r.scene)).toBe(false);
  });

  it('during the draw no glass is culled by the view, wherever it stands; the rest is culled as before', () => {
    const r = room();
    const during = withGlassUnculled(r.scene, () => ({
      front: r.front.frustumCulled,
      behind: r.behind.frustumCulled,
      ware: r.ware.frustumCulled,
      wall: r.wall.frustumCulled,
      shelf: r.shelf.frustumCulled,
    }));
    expect(during).toEqual({ front: false, behind: false, ware: false, wall: true, shelf: true });
  });

  it('puts every flag back afterwards, also the glass that was never culled, and returns what the draw returned', () => {
    const r = room();
    expect(withGlassUnculled(r.scene, () => 42)).toBe(42);
    expect([r.front, r.behind, r.ware, r.wall, r.shelf].every((o) => o.frustumCulled)).toBe(true);
    expect(r.always.frustumCulled).toBe(false);
  });

  it('puts the flags back when the draw throws', () => {
    const r = room();
    expect(() =>
      withGlassUnculled(r.scene, () => {
        throw new Error('device lost');
      }),
    ).toThrow('device lost');
    expect([r.front, r.behind, r.ware].every((o) => o.frustumCulled)).toBe(true);
  });

  it('shows nothing that is hidden: glass under a hidden parent is unculled but stays hidden (three skips it)', () => {
    const r = room();
    const drawer = new THREE.Group();
    drawer.visible = false;
    const inDrawer = new THREE.Mesh(geometry, glass());
    drawer.add(inDrawer);
    r.scene.add(drawer);
    const during = withGlassUnculled(r.scene, () => ({
      culled: [inDrawer.frustumCulled, r.hidden.frustumCulled],
      visible: [drawer.visible, inDrawer.visible, r.hidden.visible],
    }));
    expect(during.culled).toEqual([false, false]);
    expect(during.visible).toEqual([false, true, false]);
    expect([drawer.visible, inDrawer.visible, r.hidden.visible]).toEqual([false, true, false]);
    expect([inDrawer.frustumCulled, r.hidden.frustumCulled]).toEqual([true, true]);
  });
});
