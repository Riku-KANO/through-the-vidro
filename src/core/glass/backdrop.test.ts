import { float, materialThickness, viewportOpaqueMipTexture } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, type QualityLevel } from '../quality';
import {
  followBackdropResize,
  missesBackdropResize,
  ownBackdropImage,
  readsBackdrop,
  sharesBackdropImage,
} from './backdrop';
import { GLASS_KINDS } from './kinds';
import { createGlass } from './materials';
import type { GlassPlacement, GlassRole } from './policy';

const { FULL, SHARED } = THREE.RenderObjectRefreshType;

/** The part of three r186's NodeMaterialObserver this test drives (needsRefresh is not in @types/three). */
interface Observer {
  needsRefresh(renderObject: unknown, nodeFrame: unknown): number;
}

/**
 * How three refreshes one object of this material over three frames in which nothing about it changes, decided by
 * three's own NodeMaterialObserver (the class Renderer._renderObjectDirect asks; exported from three/webgpu).
 * FULL updates the object's nodes and bindings; SHARED only the shared uniforms, so its bindings keep whatever
 * backdrop texture they point at. The render object and node frame are minimal stand-ins with only the fields
 * r186 reads; if three changes their shape this throws or returns something else and the tests fail, which is the
 * point: then the workaround has to be checked again with the minimal repro in process/slices/S-12.md.
 */
function refreshOverStillFrames(material: THREE.Material): number[] {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), material);
  const builder = { material, object: mesh, context: {} } as unknown as THREE.NodeBuilder;
  const observer = new THREE.NodeMaterialObserver(builder) as unknown as Observer;
  const renderObject = {
    object: mesh,
    material,
    geometry: mesh.geometry,
    context: { width: 100, height: 100 },
    scene: new THREE.Scene(),
    bundle: null,
    lightsNode: { getBuiltinLights: () => [] },
  };
  const frame = (renderId: number) =>
    observer.needsRefresh(renderObject, { renderer: { getMRT: () => null }, renderId });
  const types = [frame(1), frame(2), frame(3)];
  mesh.geometry.dispose();
  return types;
}

const handMadeGlass = () =>
  new THREE.MeshPhysicalNodeMaterial({ roughness: 0.02, transmission: 1, ior: 1.5, thickness: 0.5 });

describe('transmission across render size changes (three r186, S-12)', () => {
  it('hand-made transmissive glass: three stops refreshing its bindings once nothing changes', () => {
    const glass = handMadeGlass();
    expect(readsBackdrop(glass)).toBe(true);
    expect(missesBackdropResize(glass)).toBe(true);
    // This is the precondition of the bug: after the first frame its bindings are never rebuilt, so a backdrop
    // recreated meanwhile is not picked up.
    expect(refreshOverStillFrames(glass)).toEqual([FULL, SHARED, SHARED]);
  });

  it('followBackdropResize makes three refresh it fully on every frame, without changing what it draws', () => {
    const glass = followBackdropResize(handMadeGlass());
    expect(refreshOverStillFrames(glass)).toEqual([FULL, FULL, FULL]);
    expect(missesBackdropResize(glass)).toBe(false);
    // three reads materialThickness when thicknessNode is null: the same value, so the same look.
    expect(glass.thicknessNode).toBe(materialThickness);
    expect(glass.transmissionNode).toBeNull();
    expect(glass.transmission).toBe(1);
    expect(glass.thickness).toBe(0.5);
  });

  it('leaves materials alone that do not read the backdrop or already have a node', () => {
    const solid = followBackdropResize(new THREE.MeshPhysicalNodeMaterial({ roughness: 0.4 }));
    expect(readsBackdrop(solid)).toBe(false);
    expect(solid.thicknessNode).toBeNull();

    const shaped = new THREE.MeshPhysicalNodeMaterial({ transmission: 1 });
    const own = float(0.2);
    shaped.thicknessNode = own;
    expect(missesBackdropResize(shaped)).toBe(false);
    expect(followBackdropResize(shaped).thicknessNode).toBe(own);

    // transmission by a node alone still reads the backdrop, and that node already keeps it refreshed
    const byNode = new THREE.MeshPhysicalNodeMaterial();
    byNode.transmissionNode = float(1);
    expect(readsBackdrop(byNode)).toBe(true);
    expect(missesBackdropResize(byNode)).toBe(false);
    expect(refreshOverStillFrames(byNode)).toEqual([FULL, FULL, FULL]);

    expect(readsBackdrop(new THREE.MeshStandardNodeMaterial())).toBe(false);
  });

  it('every glass from createGlass is refreshed fully on every frame where it reads the backdrop', () => {
    const placements: GlassPlacement[] = ['near', 'far', 'behind-glass'];
    const roles: GlassRole[] = ['scenery', 'orb', 'drop', 'showcase'];
    for (const level of Object.keys(QUALITY_PRESETS) as QualityLevel[]) {
      for (const kind of GLASS_KINDS) {
        for (const placement of placements) {
          for (const role of roles) {
            const { material } = createGlass(kind, QUALITY_PRESETS[level], { placement, role });
            const where = `${kind} ${placement} ${role} on ${level}`;
            expect(missesBackdropResize(material), where).toBe(false);
            if (readsBackdrop(material))
              expect(refreshOverStillFrames(material), where).toEqual([FULL, FULL, FULL]);
            material.dispose();
          }
        }
      }
    }
  });
});

/** The fields of a backdrop copy (FramebufferTexture) that three r186's copy path reads. */
interface BackdropCopy {
  id: number;
  version: number;
  image: { width: number; height: number };
}

/**
 * Draws transmission into a target the way three r186 copies the backdrop before such a draw: three's own
 * ViewportTextureNode.updateBefore (the node every front-side transmissive material samples), with a stand-in renderer
 * that only answers which target is current and records the copies. Each draw returns whether its copy went into a
 * backdrop texture made at another size: three (re)makes a copy's texture at its image size only when the texture's
 * version changed since its last copy (Textures.updateTexture). If three changes how the node reads the renderer,
 * this throws or stops matching and the tests below fail: then check S-29's e2e and three's change log.
 */
function backdropDrawer(): (target: THREE.RenderTarget) => boolean {
  const node = viewportOpaqueMipTexture() as unknown as { updateBefore(frame: unknown): void };
  const made = new Map<number, { version: number; width: number; height: number }>();
  let current: THREE.RenderTarget | null = null;
  let stale = false;
  const renderer = {
    getRenderTarget: () => current,
    getCanvasTarget: () => null,
    copyFramebufferToTexture(copy: BackdropCopy) {
      const { width, height } = copy.image;
      const m = made.get(copy.id);
      stale = !!m && m.version === copy.version && (m.width !== width || m.height !== height);
      if (!m || m.version !== copy.version) made.set(copy.id, { version: copy.version, width, height });
    },
  };
  return (target) => {
    current = target;
    stale = false;
    node.updateBefore({ renderer });
    return stale;
  };
}

/**
 * S-29's shape: the room's scene pass draws once while loading (the warm-up), the home's orb image draws the room
 * until the dive, the render scale changes on the way (both targets follow the drawing buffer), then only the scene
 * pass draws (landed). Returns whether each of its two draws after landing copied into a backdrop of another size.
 */
function landAfterScaleChange(own: boolean, from: [number, number], to: [number, number]): boolean[] {
  const orb = new THREE.RenderTarget(...from);
  const scenePass = new THREE.RenderTarget(...from);
  if (own) {
    ownBackdropImage(orb);
    ownBackdropImage(scenePass);
  }
  const draw = backdropDrawer();
  const before = [draw(scenePass), draw(orb), draw(orb)];
  orb.setSize(...to);
  scenePass.setSize(...to);
  const home = [draw(orb), draw(orb)];
  const landed = [draw(scenePass), draw(scenePass)];
  expect([...before, ...home]).toEqual([false, false, false, false, false]);
  orb.dispose();
  scenePass.dispose();
  return landed;
}

describe('one backdrop per render target (three r186, S-29)', () => {
  it('three r186: the targets share one backdrop size record, so the target drawn second keeps its old size', () => {
    const target = new THREE.RenderTarget(16, 16);
    expect(sharesBackdropImage(target)).toBe(true);
    // The precondition of the black screen after the dive: when this fails, three gives each target its own record
    // (r187, mrdoob/three.js#34636) and ownBackdropImage() does nothing; it can then go (with this test).
    expect(landAfterScaleChange(false, [1024, 576], [1088, 612])).toEqual([true, true]);
    expect(landAfterScaleChange(false, [1088, 612], [1024, 576])).toEqual([true, true]);
    target.dispose();
  });

  it('ownBackdropImage keeps every target re-made at its own size, up and down', () => {
    expect(landAfterScaleChange(true, [1024, 576], [1088, 612])).toEqual([false, false]);
    expect(landAfterScaleChange(true, [1088, 612], [1024, 576])).toEqual([false, false]);
  });

  it('gives the target its own record once, at the size it had, and leaves the other targets sharing', () => {
    const a = new THREE.RenderTarget(32, 16);
    const b = new THREE.RenderTarget(32, 16);
    const copies = viewportOpaqueMipTexture() as unknown as {
      getTextureForReference(t: THREE.RenderTarget | null): THREE.Texture;
    };
    const before = { ...(copies.getTextureForReference(a).image as object) };
    ownBackdropImage(a);
    const own = copies.getTextureForReference(a).source;
    expect(sharesBackdropImage(a)).toBe(false);
    expect(copies.getTextureForReference(a).image).toEqual(before);
    ownBackdropImage(a);
    expect(copies.getTextureForReference(a).source).toBe(own);
    expect(sharesBackdropImage(b)).toBe(true);
    a.dispose();
    b.dispose();
  });
});
