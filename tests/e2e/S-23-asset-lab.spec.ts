import { expect, type Page, test } from '@playwright/test';

/**
 * S-23: the game reads what the Blender pipeline exported (public/assets/lab, committed), on both routes.
 *  - GLTFLoader + MeshoptDecoder + KTX2Loader load the area file and the common file (meshopt-compressed, quantized)
 *  - the names and extras build the layers (_front / _back / both), the colliders (_col) and the socket
 *    (materialize radius, the seat the orb sits at); the socket's sphere is placed, so the back-layer bridge shows
 *  - glass marked in Blender becomes the library's glass; every loaded material is a node material
 *  - the colliders are Rapier colliders: the floor is walkable at y = 0, the bridge's footing is on inside the sphere
 *  - no console error or warning
 * The Basis transcoder is started on both routes; KTX2 textures are checked only when the sample was exported with
 * KTX-Software (otherwise its textures are PNG).
 */
const BENIGN = /GPU stall due to ReadPixels|powerPreference option is currently ignored/;

interface Probe {
  ready: boolean;
  error?: string;
  files: {
    url: string;
    extensionsUsed: string[];
    textures: number;
    ktx2Images: number;
    ktx2Textures: number;
  }[];
  layers: { surface: number; back: number; shared: number };
  colliders: { name: string; layer: string }[];
  sockets: { name: string; radius: number; seat: [number, number, number] }[];
  sphere: { center: [number, number, number]; radius: number } | null;
  lods: number;
  glass: { object: string; material: string; kind: string; role: string; path: string }[];
  genericTransmissive: number;
  nonNodeMaterials: string[];
  problems: { object: string; code: string; message: string }[];
  physics: { floorHitY: number | null; footingActive: number; footingTotal: number };
  transcoder: string;
  hiddenFromCamera: string[];
}

async function open(page: Page, backend: 'webgpu' | 'webgl2'): Promise<{ probe: Probe; console: string[] }> {
  const seen: string[] = [];
  page.on('pageerror', (e) => seen.push(`[exception] ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !BENIGN.test(m.text()))
      seen.push(`[${m.type()}] ${m.text()}`);
  });
  await page.goto(`/?scene=asset-lab${backend === 'webgl2' ? '&webgl=1' : ''}`);
  await page.waitForFunction(() => ['running', 'error'].includes(window.__vidro?.status), undefined, {
    timeout: 60_000,
  });
  expect(await page.evaluate(() => window.__vidro.status)).toBe('running');
  expect(await page.evaluate(() => window.__vidro.backend)).toBe(backend);
  await page.waitForFunction(
    () => (window.__vidro.sceneProbe as { ready?: boolean }).ready === true,
    undefined,
    {
      timeout: 30_000,
    },
  );
  // a few frames, so the glass and the layers have been drawn
  await page.waitForTimeout(1500);
  return { probe: (await page.evaluate(() => window.__vidro.sceneProbe)) as unknown as Probe, console: seen };
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test.describe(`asset-lab [${backend}]`, () => {
    test('loads the area file and the common file through the meshopt decoder', async ({ page }) => {
      const { probe, console } = await open(page, backend);
      expect(probe.error).toBeUndefined();
      expect(probe.files.map((f) => f.url.replace(/^.*\/assets\//, 'assets/'))).toEqual([
        'assets/lab/a0.glb',
        'assets/lab/common.glb',
      ]);
      for (const f of probe.files) expect(f.extensionsUsed).toContain('EXT_meshopt_compression');
      expect(probe.problems).toEqual([]);
      expect(console).toEqual([]);
    });

    test('builds the layers, the colliders and the socket from the names and extras', async ({ page }) => {
      const { probe } = await open(page, backend);
      expect(probe.layers.surface).toBeGreaterThanOrEqual(1);
      expect(probe.layers.back).toBeGreaterThanOrEqual(1);
      expect(probe.layers.shared).toBeGreaterThanOrEqual(3);
      // every object put on a layer is drawn by the normal view (camera layers = viewMask('main'))
      expect(probe.hiddenFromCamera).toEqual([]);
      expect(probe.lods).toBeGreaterThanOrEqual(1);
      const colliders = Object.fromEntries(probe.colliders.map((c) => [c.name, c.layer]));
      expect(colliders).toMatchObject({
        A0_flr_floor01_col: 'shared',
        A0_sock_01_col: 'shared',
        A0_brg_bridge01_col: 'back',
      });
      // the sample's socket holds a small orb: コアメカニクス > ガラス玉の性質の成長: 小玉(実体化半径2m)
      expect(probe.sockets).toEqual([expect.objectContaining({ name: 'A0_sock_01', radius: 2 })]);
      const [socket] = probe.sockets;
      expect(probe.sphere?.radius).toBe(socket?.radius);
      expect(probe.sphere?.center).toEqual(socket?.seat);
    });

    test('turns marked glass into the library glass and every material into a node material', async ({
      page,
    }) => {
      const { probe } = await open(page, backend);
      expect(probe.nonNodeMaterials).toEqual([]);
      const kinds = new Set(probe.glass.map((g) => g.kind));
      for (const k of ['clear', 'iridescent', 'milky']) expect(kinds).toContain(k);
      // an unmarked transmissive material keeps the values from the glTF (and follows a render size change)
      expect(probe.genericTransmissive).toBeGreaterThanOrEqual(1);
    });

    test('makes Rapier colliders: the floor at y = 0, the bridge footing inside the sphere', async ({
      page,
    }) => {
      const { probe } = await open(page, backend);
      expect(probe.physics.floorHitY).not.toBeNull();
      expect(Math.abs(probe.physics.floorHitY ?? 1)).toBeLessThan(0.03);
      expect(probe.physics.footingTotal).toBeGreaterThanOrEqual(1);
      expect(probe.physics.footingActive).toBeGreaterThanOrEqual(1);
    });

    test('starts the Basis transcoder, and decodes KTX2 textures when the sample has them', async ({
      page,
    }) => {
      const { probe } = await open(page, backend);
      // three's transcoder, served by the build (KTX2Loader fetches it and starts its workers)
      expect(probe.transcoder).toBe('ready');
      const ktx2 = probe.files.reduce((n, f) => n + f.ktx2Images, 0);
      test.info().annotations.push({
        type: 'ktx2',
        description:
          ktx2 > 0 ? `${ktx2} KTX2 images` : 'the sample has no KTX2 images (exported without KTX-Software)',
      });
      // every KTX2 image of the glTF became a texture with transcoded data (compressed where the GPU allows)
      for (const f of probe.files) expect(f.ktx2Textures, f.url).toBe(f.ktx2Images);
    });
  });
}
