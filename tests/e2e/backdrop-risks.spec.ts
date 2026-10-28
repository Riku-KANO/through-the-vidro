import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type * as THREE from 'three/webgpu';
import type { BackdropReport } from '../../src/dev/backdrop-risks';

/**
 * S-14 sensor: no scene draws a transmissive material without any node property.
 *
 * three r186 does not refresh the objects of such a material while nothing about them changed, so one that was off
 * screen while the render size went A → B → A (dynamic resolution does this during play) comes back drawing the
 * destroyed transmission backdrop: WebGPU drops the whole submit every frame ("Destroyed texture … used in a
 * submit"), WebGL2 warns "attempt to use a deleted object" (S-12, src/core/glass/backdrop.ts). Waiting for the camera
 * to bring such an object back takes tens of seconds and depends on the scene, so this sensor reads the cause
 * instead: ?debug=1's backdropRisks() runs core's missesBackdropResize() over the scene graph, sandbox.scene plus
 * every root the scene drew or compiled (the dive world drawn into the home orb's image, a pass's scene).
 *
 * It asks about 1 s after the scene starts running and again at about 5 s, because some scenes build or first draw
 * their world later (prologue-proto and home-dive behind their loading screen). For the scenes whose world is drawn
 * outside sandbox.scene it also checks, with their default switches, that a scene besides sandbox.scene holds materials
 * that read the backdrop: the world's glass (S-15). A last case checks that a risky material put into such a world is
 * reported (positive control).
 * Limits (process/slices/S-14.md, S-15.md): it sees the scene graph at those two moments only, with each scene's
 * default switches and preset (mid); not a material swapped in only during a pass, created later in play, made
 * transmissive later, or given its node after it was first drawn (that one counts as safe); not a root drawn by other
 * means than renderer.render() or compileAsync(). The world check takes any other scene with transmissive glass for
 * the world, and fails falsely once the world has no transmissive glass.
 *
 * WebGPU only by default: the check reads materials, the same on both paths. BACKENDS=webgpu,webgl2 adds WebGL2.
 * SCENES=a,b limits the run.
 */
const root = process.cwd();
const all = readdirSync(join(root, 'src/scenes'))
  .filter((f) => f.endsWith('.scene.ts'))
  .map((f) => f.replace(/\.scene\.ts$/, ''))
  .sort();
const only = process.env.SCENES?.split(',').filter(Boolean);
const scenes = only ? all.filter((s) => only.includes(s)) : all;
const backends = (process.env.BACKENDS ?? 'webgpu').split(',');

/** Seconds after the scene starts running. */
const CHECK_AT = [1, 5];
/**
 * Scenes whose world is drawn outside sandbox.scene (the home screen's orb shows it, S-04/S-06). Counting roots does
 * not show that the world was seen: PMREM's helper scenes and the groups passed to compileAsync are roots too (review
 * round 2 of S-14). So these scenes must have, besides sandbox.scene (the first root), a scene root with at least one
 * material that reads the backdrop (core's readsBackdrop, safe ones included): their world is a scene of its own with
 * transmissive glass, while PMREM's scenes have none (S-15). Groups are left out, so a home-side group compiled on its
 * own (compileWith(null, late, …) in dive-host.ts) cannot stand in for the world should it ever get such glass.
 */
const WORLD_OUTSIDE_SCENE = ['home-dive', 'prologue-proto'];

const describeRoots = (r: BackdropReport | null): string =>
  (r?.roots ?? []).map((root) => `${root.label}: ${root.backdropReaders}`).join(', ');

const report = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__vidroDebug?.backdropRisks() ?? null);

async function startScene(page: import('@playwright/test').Page, query: string, backend: string) {
  await page.goto(`/?${query}&quality=mid&debug=1${backend === 'webgl2' ? '&webgl=1' : ''}`);
  await page.waitForFunction(() => ['running', 'error'].includes(window.__vidro?.status), undefined, {
    timeout: 60_000,
  });
  expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
}

for (const scene of scenes) {
  for (const backend of backends) {
    test(`${scene}: every transmissive material follows a render size change [${backend}]`, async ({
      page,
    }) => {
      await startScene(page, `scene=${scene}`, backend);
      const started = Date.now();
      const found: Record<string, BackdropReport['risks']> = {};
      let last: BackdropReport | null = null;
      for (const at of CHECK_AT) {
        await page.waitForTimeout(Math.max(0, at * 1000 - (Date.now() - started)));
        // A scene that failed would have nothing to report, so its silence must not count as green.
        expect(await page.evaluate(() => window.__vidro.status), `status at ${at} s`).toBe('running');
        last = await report(page);
        expect(last, '__vidroDebug.backdropRisks()').not.toBeNull();
        expect(last?.roots.length ?? 0, `roots looked at, at ${at} s`).toBeGreaterThanOrEqual(1);
        found[`${at} s`] = last?.risks ?? [];
      }
      if (WORLD_OUTSIDE_SCENE.includes(scene)) {
        const otherScenes = last?.roots.slice(1).filter((r) => r.label.startsWith('Scene#')) ?? [];
        expect(
          Math.max(0, ...otherScenes.map((r) => r.backdropReaders)),
          `backdrop readers in a scene besides sandbox.scene (roots: ${describeRoots(last)})`,
        ).toBeGreaterThanOrEqual(1);
      }
      expect(await page.evaluate(() => window.__vidro.errors), 'probe errors').toEqual([]);
      expect(
        found,
        'transmissive materials without a node (pass them through followBackdropResize(), S-12)',
      ).toEqual(Object.fromEntries(CHECK_AT.map((at) => [`${at} s`, []])));
    });
  }
}

test('positive control: a risky material in a world drawn outside sandbox.scene is reported [webgpu]', async ({
  page,
}) => {
  // home-dive plays itself to the home screen and dives in; from the home screen on, its world (a scene of its own,
  // not sandbox.scene) is drawn on every frame: into the orb's image, then to the screen.
  await startScene(page, 'scene=home-dive&autoplay=1', 'webgpu');
  await page.waitForFunction(
    () => ['home', 'game'].includes((window.__vidro.sceneProbe as { screen?: string }).screen ?? ''),
    undefined,
    { timeout: 30_000 },
  );
  const result = await page.evaluate(async () => {
    const debug = window.__vidroDebug;
    if (!debug) return { error: '__vidroDebug missing' };
    const own = debug.backdropRisks().roots[0]?.label;
    // The scenes drawn over a few frames, caught by a wrapper of this test's own (not the sensor's record).
    const renderer = debug.renderer;
    const sensorRender = renderer.render;
    const drawn = new Set<THREE.Object3D>();
    renderer.render = (...args: Parameters<THREE.WebGPURenderer['render']>) => {
      drawn.add(args[0]);
      return sensorRender.apply(renderer, args);
    };
    await new Promise<void>((resolve) => {
      let left = 10;
      const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    renderer.render = sensorRender;
    const world = [...drawn].find((o) => (o as THREE.Scene).isScene && `${o.type}#${o.id}` !== own);
    if (!world) return { error: `no scene drawn besides ${own}` };
    // three is bundled, so take the classes from the world itself.
    const found: { glass?: THREE.Material; mesh?: THREE.Mesh } = {};
    world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || found.glass) return;
      const m = mesh.material as THREE.Material;
      // Take the mesh class from the same mesh as the material (not an InstancedMesh or another kind found first).
      if (m.type === 'MeshPhysicalNodeMaterial') {
        found.glass = m;
        found.mesh = mesh;
      }
    });
    if (!found.glass || !found.mesh) return { error: 'no MeshPhysicalNodeMaterial in the world' };
    type Make<T, A extends unknown[]> = new (...args: A) => T;
    const Physical = found.glass.constructor as Make<THREE.Material, [object]>;
    const MeshClass = found.mesh.constructor as Make<THREE.Mesh, [THREE.BufferGeometry, THREE.Material]>;
    const material = new Physical({ transmission: 1 });
    const probe = new MeshClass(found.mesh.geometry, material);
    probe.name = 'S-14 positive control';
    probe.visible = false; // never drawn: the sensor reads the scene graph
    world.add(probe);
    const after = debug.backdropRisks();
    world.remove(probe);
    material.dispose();
    return {
      own,
      world: `${world.type}#${world.id}`,
      looked: after.roots.some((r) => r.label === `${world.type}#${world.id}`),
      reported: after.risks.filter((r) => r.objectNames.includes('S-14 positive control')).length,
    };
  });
  expect(result).toMatchObject({ looked: true, reported: 1 });
});
