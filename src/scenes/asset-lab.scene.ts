import { color, dot, max, mix, normalWorldGeometry, positionLocal, pow, smoothstep, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { createGltfLoader, type LoadedAsset } from '../core/assets';
import { createGlass, readsBackdrop } from '../core/glass';
import type { SceneFactory } from '../core/scene';
import {
  type AssembledAsset,
  addAssetColliders,
  assembleAsset,
  createAssetMaterialHook,
} from '../game/assets';
import { createWorld, initPhysics } from '../game/player/physics';
import { boundaryGlow, type FieldSphere, LayerField, viewMask } from '../layers';

export const title =
  'S-23 asset lab: the Blender pipeline sample (glb + meshopt + KTX2): layers, colliders and the socket from the names';

/**
 * Shows what `pnpm assets` exported from blender/scenes/asset-lab.blend (S-23): the area file and the common file of
 * public/assets/lab, loaded with GLTFLoader + meshopt + KTX2 and assembled from the names and extras (src/game/assets).
 * The socket's sphere (its materialize radius from the extras) is placed, so the back-layer glass bridge shows inside it
 * and the front-layer dome is cut by it. The colliders are Rapier colliders; sceneProbe reports what was built.
 * The camera is fixed, so screenshots are reproducible.
 */

const FILES = ['assets/lab/a0.glb', 'assets/lab/common.glb'];
/** 操作とカメラ > カメラ: 視野角70度. The same view as the preview camera of blender/scripts/make_sample.py. */
const FOV = 70;
const CAMERA = { position: new THREE.Vector3(0.45, 1.4, 2.9), target: new THREE.Vector3(0.35, 0.55, -1.0) };
/** Where the environment (sky and the opaque objects, for the glass to reflect) is captured. */
const ENV_AT = new THREE.Vector3(0.3, 1.1, 0.6);
/** A spot of floor away from everything, for the collider check. */
const FLOOR_PROBE = { x: -2.0, z: 1.2 };
/** Radius of the orb resting on the socket (the sample's cradle is made for it). */
const ORB_RADIUS = 0.11;

/** アートディレクション: 朝の光 (仮 colours, as in glass-gallery). */
const SKY = { zenith: 0x4a74a8, horizon: 0xeee6da, ground: 0xb9c3c9, sun: 0xffe6c4 };
/** Morning sun, front-left and above the frame, so the glass catches it (as in glass-gallery). */
const SUN_DIR = new THREE.Vector3(-0.5, 0.6, -0.62).normalize();
/** 空間の可読性と導線 > 8 奥ほど霞ませる (仮 distances). The same haze for the fog and far glass. */
const HAZE = { color: SKY.horizon, near: 12, far: 60 };

function skyNode(dir: THREE.Node<'vec3'>) {
  const y = dir.y;
  const up = mix(color(SKY.horizon), color(SKY.zenith), pow(smoothstep(0, 1, y), 0.45));
  const down = mix(color(SKY.horizon), color(SKY.ground), smoothstep(0, 0.25, y.negate()));
  const base = mix(down, up, smoothstep(-0.02, 0.02, y));
  const s = max(dot(dir, vec3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z)), 0);
  return base.add(color(SKY.sun).mul(pow(s, 40).mul(0.5).add(pow(s, 6).mul(0.2))));
}

const isNodeMaterial = (m: THREE.Material) => (m as { isNodeMaterial?: boolean }).isNodeMaterial === true;

const create: SceneFactory = async (ctx) => {
  const { renderer, quality } = ctx;
  const scene = new THREE.Scene();
  scene.backgroundNode = skyNode(normalWorldGeometry);
  scene.fog = new THREE.Fog(HAZE.color, HAZE.near, HAZE.far);
  const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.05, 200);
  camera.position.copy(CAMERA.position);
  camera.lookAt(CAMERA.target);
  // the normal view draws both layers (src/layers); a camera left on channel 0 only would miss everything that is not
  // on both layers, and all transmissive glass (PeekPipeline sets this for the scenes that use it)
  camera.layers.mask = viewMask('main');

  const probe = {
    ready: false,
    frames: 0,
    files: [] as {
      url: string;
      extensionsUsed: string[];
      textures: number;
      ktx2Images: number;
      ktx2Textures: number;
    }[],
    layers: { surface: 0, back: 0, shared: 0 },
    colliders: [] as { name: string; layer: string }[],
    sockets: [] as { name: string; radius: number; seat: [number, number, number] }[],
    sphere: null as { center: [number, number, number]; radius: number } | null,
    lods: 0,
    glass: [] as ReturnType<typeof createAssetMaterialHook>['glass'],
    genericTransmissive: 0,
    withoutHeavyOptics: [] as string[],
    nonNodeMaterials: [] as string[],
    problems: [] as AssembledAsset['problems'],
    physics: { floorHitY: null as number | null, footingActive: 0, footingTotal: 0 },
    /** What was put on each layer: name, layer, world box, its meshes. */
    objects: [] as unknown[],
    /** Objects put on a layer that the camera does not draw (none of their meshes is on a channel it sees). */
    hiddenFromCamera: [] as string[],
    /** The Basis transcoder fetched and started ('ready'), or why not. */
    transcoder: 'pending' as string,
  };
  Object.assign(window.__vidro.sceneProbe, probe);
  const sceneProbe = window.__vidro.sceneProbe as typeof probe;

  // light: the sun with a static shadow, the sky as the environment
  const previousShadowMap = { enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type };
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const sun = new THREE.DirectionalLight(SKY.sun, 2.2);
  sun.target.position.set(0.2, 0, -0.8);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 40 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.camera.layers.mask = viewMask('main'); // AGENTS.md: 影のカメラの layers を明示する
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun, sun.target);

  // the assets
  const loader = createGltfLoader(renderer);
  const materials = createAssetMaterialHook(quality, { haze: HAZE });
  const base = import.meta.env.BASE_URL;
  const loaded: LoadedAsset[] = await Promise.all(
    FILES.map((f) => loader.load(`${base}${f}`, { material: materials.hook })),
  );
  // the sample may have no KTX2 texture (exported without KTX-Software): start the transcoder anyway, to check it
  const transcoder = await loader.loadTranscoder().then(
    () => 'ready',
    (e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`,
  );
  const assembled = loaded.map((asset) => assembleAsset(asset.scene));
  const opaqueShared: THREE.Mesh[] = [];
  for (const a of assembled) {
    a.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const glass = mats.some(readsBackdrop);
      mesh.castShadow = !glass; // clear glass casts no solid shadow
      mesh.receiveShadow = !glass;
    });
    for (const { object, layer } of a.layered) {
      if (layer !== 'shared') continue;
      object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (mesh.isMesh && mats.every((m) => m && !readsBackdrop(m))) opaqueShared.push(mesh);
      });
    }
  }

  // the environment: the sky and the opaque objects on both layers, so the glass has something to reflect (光と時間帯:
  // ガラスに街そのものが映る). No transmissive glass in the capture: PMREM draws into targets of another size (AGENTS.md).
  const envScene = new THREE.Scene();
  const skyMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
  skyMaterial.colorNode = skyNode(positionLocal.normalize());
  const skyGeometry = new THREE.SphereGeometry(100, 48, 24);
  envScene.add(new THREE.Mesh(skyGeometry, skyMaterial));
  const envSun = sun.clone();
  envSun.castShadow = false;
  envScene.add(envSun, envSun.target, new THREE.HemisphereLight(SKY.zenith, SKY.ground, 1.0));
  for (const mesh of opaqueShared) {
    const copy = new THREE.Mesh(mesh.geometry, mesh.material); // shares both; dropped after the capture
    copy.matrixAutoUpdate = false;
    copy.matrix.copy(mesh.matrixWorld);
    envScene.add(copy);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(envScene, 0.02, 0.1, 200, { position: ENV_AT });
  pmrem.dispose();
  scene.environment = envTarget.texture;

  const field = new LayerField();
  for (const a of assembled) {
    for (const { object, layer } of a.layered) field.assign(object, layer);
    scene.add(a.root);
  }
  scene.add(...field.membranes);

  // the socket's sphere, fully grown, and the orb resting on it
  const sockets = assembled.flatMap((a) => a.sockets);
  const socket = sockets[0];
  const spheres: FieldSphere[] = socket
    ? [{ center: socket.seat, radius: socket.radius, glow: boundaryGlow({ progress: 1, target: 1 }) }]
    : [];
  field.setSpheres(spheres);
  const orbGeometry = new THREE.SphereGeometry(ORB_RADIUS, 64, 40);
  const orb = createGlass('bubble', quality, { role: 'orb' });
  const orbMesh = new THREE.Mesh(orbGeometry, orb.material);
  if (socket) orbMesh.position.set(...socket.seat);
  orbMesh.visible = socket !== undefined;
  field.assign(orbMesh, 'shared');
  scene.add(orbMesh);

  // the colliders
  const R = await initPhysics();
  const world = createWorld();
  const colliders = addAssetColliders(
    R,
    world,
    assembled.flatMap((a) => a.colliders),
  );
  colliders.footing?.sync(spheres.map((s) => ({ center: s.center, radius: s.radius })));
  world.step(); // queries see enabled colliders after a step
  const hit = world.castRay(
    new R.Ray({ x: FLOOR_PROBE.x, y: 2, z: FLOOR_PROBE.z }, { x: 0, y: -1, z: 0 }),
    5,
    true,
  );

  // what was built, for the sensor (tests/e2e/S-23-asset-lab.spec.ts)
  const all = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const mm of Array.isArray(m) ? m : m ? [m] : []) all.add(mm);
  });
  const marked = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const mm of Array.isArray(m) ? m : m ? [m] : []) if (mm.userData.mark) marked.add(mm);
  });
  Object.assign(sceneProbe, {
    files: loaded.map((asset) => {
      const textures = asset.textures;
      const images = ((asset.gltf.parser.json as { images?: { mimeType?: string }[] }).images ?? []).filter(
        (i) => i.mimeType === 'image/ktx2',
      ).length;
      // KTX2 images that became transcoded data (textures may share an image: count their sources)
      const ktx2 = new Set(
        textures
          .filter(
            (t) =>
              t.userData.mimeType === 'image/ktx2' &&
              ((t as { isCompressedTexture?: boolean }).isCompressedTexture === true ||
                (t as { isDataTexture?: boolean }).isDataTexture === true),
          )
          .map((t) => t.source),
      ).size;
      return {
        url: asset.url,
        extensionsUsed: asset.extensionsUsed,
        textures: textures.length,
        ktx2Images: images,
        ktx2Textures: ktx2,
      };
    }),
    layers: {
      surface: assembled.reduce((n, a) => n + a.layered.filter((l) => l.layer === 'surface').length, 0),
      back: assembled.reduce((n, a) => n + a.layered.filter((l) => l.layer === 'back').length, 0),
      shared: assembled.reduce((n, a) => n + a.layered.filter((l) => l.layer === 'shared').length, 0),
    },
    colliders: assembled.flatMap((a) => a.colliders.map((c) => ({ name: c.name, layer: c.layer }))),
    sockets: sockets.map((s) => ({ name: s.name, radius: s.radius, seat: [...s.seat] })),
    sphere: spheres[0] ? { center: [...spheres[0].center], radius: spheres[0].radius } : null,
    lods: assembled.reduce((n, a) => n + a.lods.length, 0),
    glass: materials.glass,
    genericTransmissive: [...all].filter((m) => readsBackdrop(m) && !marked.has(m) && m !== orb.material)
      .length,
    withoutHeavyOptics: materials.withoutHeavyOptics,
    nonNodeMaterials: [...all].filter((m) => !isNodeMaterial(m)).map((m) => `${m.type}:${m.name}`),
    problems: [...assembled.flatMap((a) => a.problems), ...materials.problems],
    physics: {
      floorHitY: hit ? 2 - hit.timeOfImpact : null,
      footingActive: colliders.footing?.activeCount ?? 0,
      footingTotal: colliders.footing?.segments.length ?? 0,
    },
    transcoder,
    hiddenFromCamera: assembled.flatMap((a) =>
      a.layered
        .filter(({ object }) => {
          let seen = false;
          object.traverse((o) => {
            if ((o as THREE.Mesh).isMesh && o.layers.test(camera.layers)) seen = true;
          });
          return !seen;
        })
        .map(({ object }) => (object.userData.name as string | undefined) ?? object.name),
    ),
    objects: assembled.flatMap((a) =>
      a.layered.map(({ object, layer }) => {
        const box = new THREE.Box3().setFromObject(object);
        const meshes: { material: string; type: string; visible: boolean; layers: number }[] = [];
        object.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats)
            meshes.push({ material: m.name, type: m.type, visible: mesh.visible, layers: mesh.layers.mask });
        });
        return {
          name: (object.userData.name as string | undefined) ?? object.name,
          layer,
          min: box.min.toArray().map((v) => Math.round(v * 100) / 100),
          max: box.max.toArray().map((v) => Math.round(v * 100) / 100),
          meshes,
        };
      }),
    ),
    ready: true,
  });

  return {
    scene,
    camera,
    update() {
      sceneProbe.frames++;
    },
    dispose() {
      for (const asset of loaded) asset.dispose();
      loader.dispose();
      field.dispose();
      colliders.dispose();
      world.free();
      orbGeometry.dispose();
      orb.material.dispose();
      skyGeometry.dispose();
      skyMaterial.dispose();
      envTarget.dispose();
      sun.shadow.dispose();
      renderer.shadowMap.enabled = previousShadowMap.enabled;
      renderer.shadowMap.type = previousShadowMap.type;
    },
  };
};

export default create;
