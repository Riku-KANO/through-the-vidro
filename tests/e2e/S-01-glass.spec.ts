import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * S-01 sensor for the glass gallery (src/scenes/glass-gallery.scene.ts).
 *  - every glass kind is on show
 *  - quality presets decide far-glass transmission, dispersion and thin-film (read from sceneProbe)
 *  - along the whole camera path no transmissive glass hides behind other transmissive glass
 *    (standard transmission cannot show it: 技術設計 > ガラスの描画 > 最大の制約)
 * Skipped when SCENES is set and does not include glass-gallery.
 */
const SCENE = 'glass-gallery';
const only = process.env.SCENES?.split(',').filter(Boolean);
const root = process.cwd();

interface GlassEntry {
  id: string;
  kind: string;
  placement: 'near' | 'far';
  role: 'scenery' | 'orb' | 'drop' | 'showcase';
  path: 'transmission' | 'cheap' | 'opaque';
  dispersion: boolean;
  thinFilm: 'film' | 'cheap' | 'none';
}

interface GalleryProbe {
  frames: number;
  glass: GlassEntry[];
  nearTransmissive: number;
  sightlines: { samples: number; period: number; overlaps: { t: number; front: string; back: string }[] };
}

/** Collects page errors once per page and opens the gallery with the given query. */
function gallery(page: Page): (query: string) => Promise<{ probe: GalleryProbe; errors: string[] }> {
  let errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/GPU stall|powerPreference/i.test(m.text())) errors.push(m.text());
  });
  return async (query) => {
    errors = [];
    await page.goto(`/?scene=${SCENE}&${query}`);
    await page.waitForFunction(
      () =>
        window.__vidro?.status === 'error' ||
        ((window.__vidro?.sceneProbe as { frames?: number } | undefined)?.frames ?? 0) >= 3,
      undefined,
      { timeout: 60_000 },
    );
    const vidro = await page.evaluate(() => window.__vidro);
    return { probe: vidro.sceneProbe as unknown as GalleryProbe, errors: [...errors, ...vidro.errors] };
  };
}

test.describe('S-01 glass gallery', () => {
  test.skip(!!only && !only.includes(SCENE), 'SCENES excludes glass-gallery');

  for (const backend of ['webgpu', 'webgl2'] as const) {
    const webgl = backend === 'webgl2' ? '&webgl=1' : '';

    test(`quality presets switch far glass, dispersion and thin-film [${backend}]`, async ({ page }) => {
      const openGallery = gallery(page);
      for (const quality of ['low', 'mid', 'high'] as const) {
        const { probe, errors } = await openGallery(`quality=${quality}&at=0${webgl}`);
        expect(errors, `${quality}: errors`).toEqual([]);

        const kinds = new Set(probe.glass.map((g) => g.kind));
        for (const kind of ['clear', 'frosted', 'amber', 'lapis', 'jade', 'bubble', 'iridescent', 'milky']) {
          expect(kinds.has(kind), `${quality}: shows ${kind} glass`).toBe(true);
        }

        const far = probe.glass.filter((g) => g.placement === 'far' && g.kind !== 'milky');
        expect(far.length, 'gallery has far glass').toBeGreaterThan(0);
        for (const g of far) {
          expect(g.path, `${quality}: far ${g.id}`).toBe(quality === 'high' ? 'transmission' : 'cheap');
        }

        const dispersed = probe.glass.filter((g) => g.dispersion).map((g) => g.role);
        const filmed = probe.glass.filter((g) => g.thinFilm === 'film').map((g) => g.role);
        if (quality === 'low') {
          expect(dispersed).toEqual([]);
          expect(filmed).toEqual([]);
        } else if (quality === 'mid') {
          expect(dispersed).toEqual(['orb']);
          expect(filmed).toEqual([]);
        } else {
          expect(dispersed).toContain('orb');
          expect(dispersed).toContain('drop');
          expect(filmed).toContain('drop');
          for (const role of [...dispersed, ...filmed]) expect(['orb', 'drop', 'showcase']).toContain(role);
        }
        for (const g of probe.glass.filter((x) => x.kind === 'iridescent')) {
          expect(g.thinFilm, `${quality}: ${g.id} keeps a rainbow`).not.toBe('none');
        }

        // 技術設計 > 性能の目標と予算: 透過ガラスの同時表示は近景で20個程度まで
        expect(probe.nearTransmissive).toBeLessThanOrEqual(20);
      }
    });
  }

  test('no transmissive glass stacks behind another along the camera path', async ({ page }) => {
    const openGallery = gallery(page);
    // high turns far glass transmissive (farGlassTransmission), so it must stay clear of the rest too
    for (const quality of ['mid', 'high'] as const) {
      const { probe, errors } = await openGallery(`quality=${quality}&at=0`);
      expect(errors).toEqual([]);
      expect(probe.sightlines.samples).toBeGreaterThanOrEqual(40);
      expect(probe.sightlines.overlaps, quality).toEqual([]);
    }
  });

  test('screens at several moments of the camera path', async ({ page }) => {
    mkdirSync(join(root, 'artifacts/screens'), { recursive: true });
    const openGallery = gallery(page);
    for (const at of [0, 10, 20, 30]) {
      const { errors } = await openGallery(`quality=mid&at=${at}`);
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(root, `artifacts/screens/${SCENE}-at${at}.png`) });
    }
    const high = await openGallery('quality=high&at=0');
    expect(high.errors).toEqual([]);
    await page.screenshot({ path: join(root, `artifacts/screens/${SCENE}-high.png`) });
  });
});
