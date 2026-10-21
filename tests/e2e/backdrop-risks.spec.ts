import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BackdropRisk } from '../../src/main';

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
 * their world later (prologue-proto and home-dive behind their loading screen).
 * Limits (process/slices/S-14.md): it sees the scene graph at those two moments only, with each scene's default
 * switches and preset (mid); not a material swapped in only during a pass, created later in play, or given its
 * node after it was first drawn; not a root drawn by other means than renderer.render() or compileAsync().
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

for (const scene of scenes) {
  for (const backend of backends) {
    test(`${scene}: every transmissive material follows a render size change [${backend}]`, async ({
      page,
    }) => {
      const webgl = backend === 'webgl2' ? '&webgl=1' : '';
      await page.goto(`/?scene=${scene}&debug=1${webgl}`);
      await page.waitForFunction(() => ['running', 'error'].includes(window.__vidro?.status), undefined, {
        timeout: 60_000,
      });
      const started = Date.now();
      expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
      const found: Record<string, BackdropRisk[] | string> = {};
      for (const at of CHECK_AT) {
        await page.waitForTimeout(Math.max(0, at * 1000 - (Date.now() - started)));
        // A scene that failed would have nothing to report, so its silence must not count as green.
        expect(await page.evaluate(() => window.__vidro.status), `status at ${at} s`).toBe('running');
        found[`${at} s`] = await page.evaluate(
          () => window.__vidroDebug?.backdropRisks() ?? '__vidroDebug.backdropRisks() missing',
        );
      }
      expect(await page.evaluate(() => window.__vidro.errors), 'probe errors').toEqual([]);
      expect(
        found,
        'transmissive materials without a node (pass them through followBackdropResize(), S-12)',
      ).toEqual(Object.fromEntries(CHECK_AT.map((at) => [`${at} s`, []])));
    });
  }
}
